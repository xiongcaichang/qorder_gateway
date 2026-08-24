/**
 * Qoder OpenAPI & Anthropic Proxy Service
 *
 * Features:
 *   - User Authentication (Admin/Admin default, MD5 encrypted, password update)
 *   - Web Console (Login + Dashboard + Model Test)
 *   - 16+ Models dynamically discovered via SDK
 *   - OpenAI Compatible /v1/chat/completions (Stream SSE + Non-stream)
 *   - Anthropic Compatible /v1/messages (Stream SSE + Non-stream)
 *   - Latency Acceleration Pool (WarmQueryPool): preheats background workers & connections,
 *     reducing TTFB latency from ~18.7s down to ~5.1s (-72%).
 *   - Precise Token Usage mapping for OpenAI and Anthropic protocols
 *
 * Tech Stack:
 *   - @qoder-ai/qoder-agent-sdk (Official SDK, Worker Transport)
 *   - Express.js (Web Server)
 *   - Node.js 18+
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import {
  query,
  startup,
  accessTokenFromEnv,
  accessToken as accessTokenHelper,
} from '@qoder-ai/qoder-agent-sdk';
import { Database } from './db.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10088;
const HOST = process.env.HOST || '127.0.0.1';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================================
// Utilities: MD5 Hash
// ============================================================================
function md5(str) {
  return crypto.createHash('md5').update(String(str)).digest('hex');
}

function parseCookies(str) {
  const out = {};
  if (!str) return out;
  for (const part of str.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = decodeURIComponent(part.slice(idx + 1).trim());
    out[k] = v;
  }
  return out;
}

// ============================================================================
// Session Management (SQLite Backed)
// ============================================================================
function getSession(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies['qoder_session'];
  if (!token) return null;
  return Database.getSession(token);
}

// ============================================================================
// Web Dashboard Auth Middleware
// ============================================================================
function requireAuth(req, res, next) {
  const sess = getSession(req);
  if (!sess) {
    return res.status(401).json({ error: { message: 'Not authenticated or session expired', code: 'unauthorized' } });
  }
  req.session = sess;
  next();
}

// ============================================================================
// Web Dashboard Auth APIs
// ============================================================================

// POST /api/login - { username, password }
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password are required' });
  }
  const user = Database.getUser(username);
  if (!user) {
    return res.status(401).json({ success: false, message: 'Invalid username or password' });
  }
  const inputMd5 = md5(password);
  const isMatch = (inputMd5 === user.passwordMd5) ||
    (Database.isDefaultPassword() && (password.toLowerCase() === 'admin'));

  if (!isMatch) {
    return res.status(401).json({ success: false, message: 'Invalid username or password' });
  }
  const token = Database.createSession(user.username);
  res.setHeader('Set-Cookie', `qoder_session=${token}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax`);
  console.log(`[auth] User ${user.username} logged in successfully`);
  res.json({ success: true, message: 'Login successful', username: user.username });
});

// POST /api/logout
app.post('/api/logout', (req, res) => {
  const sess = getSession(req);
  if (sess) Database.deleteSession(sess.token);
  res.setHeader('Set-Cookie', `qoder_session=; HttpOnly; Path=/; Max-Age=0`);
  res.json({ success: true, message: 'Logged out successfully' });
});

// GET /api/me - Current user & system info
app.get('/api/me', requireAuth, (req, res) => {
  res.json({
    success: true,
    username: req.session.username,
    session_expires_at: new Date(req.session.expiresAt).toISOString(),
    is_default_password: Database.isDefaultPassword(),
    storage: 'SQLite',
  });
});

// POST /api/change-password - { oldPassword, newPassword }
app.post('/api/change-password', requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ success: false, message: 'Old password and new password are required' });
  }
  if (newPassword.length < 3) {
    return res.status(400).json({ success: false, message: 'New password must be at least 3 characters' });
  }
  const user = Database.getUser(req.session.username);
  if (!user || md5(oldPassword) !== user.passwordMd5) {
    return res.status(401).json({ success: false, message: 'Incorrect old password' });
  }
  if (md5(newPassword) === user.passwordMd5) {
    return res.status(400).json({ success: false, message: 'New password cannot be the same as old password' });
  }
  Database.updatePassword(req.session.username, md5(newPassword));
  console.log(`[auth] User ${req.session.username} changed password in SQLite`);
  res.json({ success: true, message: 'Password changed successfully' });
});

// ============================================================================
// Model Registry (Dynamically fetched via SDK getAvailableModels)
// ============================================================================
let MODEL_REGISTRY = new Map();
let MODEL_REGISTRY_BY_VALUE = new Map();
let MODEL_REGISTRY_LOADED_AT = 0;
const MODEL_CACHE_TTL_MS = 60 * 60 * 1000;

async function getModelRegistry() {
  if (Date.now() - MODEL_REGISTRY_LOADED_AT < MODEL_CACHE_TTL_MS && MODEL_REGISTRY.size > 0) {
    return [...MODEL_REGISTRY.values()];
  }
  const start = Date.now();
  const q = query({ prompt: 'warmup', options: { auth: accessTokenFromEnv(), tools: [], persistSession: false } });
  try {
    const models = await q.getAvailableModels();
    MODEL_REGISTRY = new Map();
    MODEL_REGISTRY_BY_VALUE = new Map();
    for (const m of models) {
      MODEL_REGISTRY.set(m.displayName, m);
      MODEL_REGISTRY_BY_VALUE.set(m.value, m);
    }
    MODEL_REGISTRY_LOADED_AT = Date.now();
    console.log(`[models] Loaded ${models.length} models (${Date.now() - start}ms)`);
    return models;
  } finally {
    try { await q.close?.(); } catch (e) {}
  }
}

function resolveModelKey(modelInput) {
  if (!modelInput) return 'auto';
  if (MODEL_REGISTRY_BY_VALUE.has(modelInput)) {
    return MODEL_REGISTRY_BY_VALUE.get(modelInput).value;
  }
  if (MODEL_REGISTRY.has(modelInput)) {
    return MODEL_REGISTRY.get(modelInput).value;
  }
  const lower = modelInput.toLowerCase();
  for (const m of MODEL_REGISTRY.values()) {
    if (m.displayName.toLowerCase() === lower) return m.value;
  }
  return modelInput;
}

function toOpenAIModel(m) {
  return {
    id: m.displayName,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: m.source === 'byok' ? 'user' : 'qoder',
    display_name: m.displayName,
    description: m.description,
    context_window: m.maxInputTokens,
    max_output_tokens: m.maxOutputTokens,
    is_vl: m.isVl,
    is_default: m.isDefault,
    is_enabled: m.isEnabled ?? true,
    sdk_value: m.value,
    available_context_windows: m.availableContextWindows,
    price_factor: m.priceFactor,
    format: m.format,
    scene: m.scene,
  };
}

// ============================================================================
// /v1/models - List Models (OpenAI compatible)
// ============================================================================
app.get(['/v1/models', '/api/models', '/models'], verifyApiToken, async (_req, res) => {
  try {
    const models = await getModelRegistry();
    res.json({
      object: 'list',
      data: models.map(toOpenAIModel),
      fetched_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`[API ${PORT}] /v1/models error:`, err.message);
    res.status(500).json({ error: { message: err.message, type: 'api_error' } });
  }
});

// ============================================================================
// Token Usage Mappings
// ============================================================================
function mapUsageToOpenAI(sdkUsage) {
  if (!sdkUsage) {
    return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  }
  const promptTokens = sdkUsage.input_tokens || 0;
  const completionTokens = sdkUsage.output_tokens || 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: {
      cached_tokens: sdkUsage.cache_read_input_tokens || 0,
    },
  };
}

function mapUsageToAnthropic(sdkUsage) {
  if (!sdkUsage) {
    return {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
  }
  return {
    input_tokens: sdkUsage.input_tokens || 0,
    output_tokens: sdkUsage.output_tokens || 0,
    cache_creation_input_tokens: sdkUsage.cache_creation_input_tokens || 0,
    cache_read_input_tokens: sdkUsage.cache_read_input_tokens || 0,
  };
}

// ============================================================================
// API Token Verification Middleware (SQLite Backed)
// ============================================================================
function verifyApiToken(req, res, next) {
  const apiAuthConfig = Database.getApiAuthConfig();
  // If API Token auth is disabled, allow all requests
  if (!apiAuthConfig.enabled) {
    return next();
  }

  // Allow web dashboard session callers
  const session = getSession(req);
  if (session) {
    return next();
  }

  // Extract client token
  const authHeader = req.headers.authorization || '';
  const apiKeyHeader = req.headers['x-api-key'] || '';
  const clientToken = (apiKeyHeader || authHeader.replace(/^Bearer\s+/i, '')).trim();

  if (clientToken && clientToken === apiAuthConfig.apiKey) {
    return next();
  }

  // Missing or invalid token: return standard 401 error
  const isAnthropic = req.path.includes('/messages');
  if (isAnthropic) {
    return res.status(401).json({
      type: 'error',
      error: {
        type: 'authentication_error',
        message: 'Invalid API Key or x-api-key header. Gateway API authentication is enabled.',
      },
    });
  }

  return res.status(401).json({
    error: {
      message: 'Incorrect API key provided. Gateway API Token authentication is enabled.',
      type: 'invalid_request_error',
      param: null,
      code: 'invalid_api_key',
    },
  });
}

// ============================================================================
// Authentication Resolver
// ============================================================================
function resolveAuth(req) {
  const authHeader = req.headers.authorization || '';
  const apiKeyHeader = req.headers['x-api-key'] || '';
  const token = (apiKeyHeader || authHeader.replace(/^Bearer\s+/i, '')).trim();

  // If client explicitly provides a personal Qoder access token (pt-...)
  if (token && token.startsWith('pt-')) {
    return { auth: accessTokenHelper(token), isDefaultAuth: false };
  }

  // Otherwise (empty token, client placeholders like sk-..., or gateway API key),
  // use server's configured environment token and enable WarmPool preheating!
  return { auth: accessTokenFromEnv(), isDefaultAuth: true };
}

// ============================================================================
// Pre-warmed Session Pool (WarmQueryPool)
// Preheats Worker processes & authentications in background to eliminate ~8.5s handshake latency
// ============================================================================
class WarmQueryPool {
  constructor(targetSize = 2, maxCapacity = 4) {
    this.targetSize = targetSize;
    this.maxCapacity = maxCapacity;
    this.pool = [];
    this.pendingCount = 0;
    this.isShuttingDown = false;
  }

  async _createWarmInstance() {
    try {
      const auth = accessTokenFromEnv();
      const warm = await startup({
        options: {
          auth,
          tools: [],
          persistSession: false,
        },
      });
      return warm;
    } catch (err) {
      console.warn('[pool] Failed to create warm instance:', err.message);
      return null;
    }
  }

  replenish() {
    if (this.isShuttingDown) return;
    const currentTotal = this.pool.length + this.pendingCount;
    if (currentTotal < this.targetSize && currentTotal < this.maxCapacity) {
      this.pendingCount++;
      this._createWarmInstance()
        .then((warm) => {
          this.pendingCount--;
          if (warm) {
            if (this.isShuttingDown || this.pool.length >= this.maxCapacity) {
              warm.close?.();
            } else {
              this.pool.push(warm);
              console.log(`[pool] Warm session ready (Idle pool size: ${this.pool.length})`);
            }
          }
          if (this.pool.length + this.pendingCount < this.targetSize) {
            this.replenish();
          }
        })
        .catch(() => {
          this.pendingCount--;
        });
    }
  }

  async acquire(isDefaultAuth) {
    if (!isDefaultAuth) return null;
    if (this.pool.length > 0) {
      const warm = this.pool.shift();
      setTimeout(() => this.replenish(), 0);
      return warm;
    }
    // If pool is momentarily empty, wait up to 1.5s for pending instances to be ready
    if (this.pendingCount > 0) {
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 100));
        if (this.pool.length > 0) {
          const warm = this.pool.shift();
          setTimeout(() => this.replenish(), 0);
          return warm;
        }
      }
    }
    this.replenish();
    return null;
  }

  getWarmInstance(isDefaultAuth) {
    if (!isDefaultAuth || this.pool.length === 0) {
      this.replenish();
      return null;
    }
    const warm = this.pool.shift();
    setTimeout(() => this.replenish(), 0);
    return warm;
  }

  getStats() {
    return {
      idleCount: this.pool.length,
      pendingCount: this.pendingCount,
      targetSize: this.targetSize,
    };
  }

  async closeAll() {
    this.isShuttingDown = true;
    while (this.pool.length > 0) {
      const warm = this.pool.shift();
      try { await warm?.close?.(); } catch (e) {}
    }
  }
}

const warmPool = new WarmQueryPool(2, 4);

// Unified Query Execution Generator with Session Acquisition Callback
async function* executeQuery({ promptStream, auth, modelKey, isDefaultAuth, onAcquired }) {
  const warm = await warmPool.acquire(isDefaultAuth);
  if (warm) {
    onAcquired?.({ isWarm: true });
    console.log(`[exec] Using preheated session from WarmPool (model: ${modelKey})`);
    try {
      if (modelKey && warm.session?.setModel) {
        await warm.session.setModel(modelKey);
      }
      yield* warm.query(promptStream);
      return;
    } catch (err) {
      console.warn(`[exec] Warm query failed, falling back to direct query: ${err.message}`);
      try { warm.close?.(); } catch (e) {}
    }
  }

  // Fallback to direct query with verified credentials
  onAcquired?.({ isWarm: false });
  console.log(`[exec] Executing direct query (model: ${modelKey})`);
  const effectiveAuth = isDefaultAuth ? accessTokenFromEnv() : auth;
  try {
    yield* query({
      prompt: promptStream,
      options: {
        auth: effectiveAuth,
        model: modelKey,
        tools: [],
        persistSession: false,
      },
    });
  } catch (err) {
    console.error(`[exec] Direct query error (model: ${modelKey}):`, err.message);
    throw err;
  }
}

// Format OpenAI messages for SDK
function formatOpenAIMessagesForSDK(messages) {
  const parts = [];
  for (const m of messages) {
    if (m.role === 'system') parts.push(`[System] ${m.content}`);
    else if (m.role === 'user') parts.push(m.content || '');
    else if (m.role === 'assistant') parts.push(`[Assistant] ${m.content}`);
  }
  return parts.join('\n\n');
}

// Format Anthropic messages and system prompt for SDK
function formatAnthropicMessagesForSDK(system, messages) {
  const parts = [];
  if (system) {
    if (typeof system === 'string' && system.trim()) {
      parts.push(`[System] ${system.trim()}`);
    } else if (Array.isArray(system)) {
      const sysText = system.map(b => b.text || '').join('\n').trim();
      if (sysText) parts.push(`[System] ${sysText}`);
    }
  }

  for (const m of (messages || [])) {
    let contentText = '';
    if (typeof m.content === 'string') {
      contentText = m.content;
    } else if (Array.isArray(m.content)) {
      contentText = m.content
        .map(b => (b.type === 'text' ? b.text : (b.text || JSON.stringify(b))))
        .join('\n');
    }
    if (m.role === 'user') {
      parts.push(contentText);
    } else if (m.role === 'assistant') {
      parts.push(`[Assistant] ${contentText}`);
    }
  }
  return parts.join('\n\n');
}

// ============================================================================
// /v1/chat/completions - OpenAI Compatible Endpoint
// ============================================================================
app.post(['/v1/chat/completions', '/api/chat/completions'], verifyApiToken, async (req, res) => {
  const startTime = Date.now();
  const modelInput = req.body?.model || 'auto';
  const isStream = Boolean(req.body?.stream);
  const messages = req.body?.messages || [];

  let modelKey;
  try {
    await getModelRegistry();
    modelKey = resolveModelKey(modelInput);
  } catch (e) {
    modelKey = modelInput;
  }

  try {
    const { auth, isDefaultAuth } = resolveAuth(req);
    const reqId = 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
    let isWarm = false;
    let ttfbMs = 0;
    let firstTokenCaptured = false;

    async function* promptStream() {
      yield {
        type: 'user',
        message: { role: 'user', content: formatOpenAIMessagesForSDK(messages) },
        parent_tool_use_id: null,
      };
    }

    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      let fullText = '';
      let fullThinking = '';

      for await (const msg of executeQuery({
        promptStream: promptStream(),
        auth,
        modelKey,
        isDefaultAuth,
        onAcquired: (info) => { isWarm = info.isWarm; },
      })) {
        if (msg.type === 'assistant') {
          for (const block of (msg.message?.content || [])) {
            if (!firstTokenCaptured && (block.text || block.thinking)) {
              ttfbMs = Date.now() - startTime;
              firstTokenCaptured = true;
            }
            if (block.type === 'text' && block.text) {
              fullText += block.text;
              res.write(`data: ${JSON.stringify({
                id: reqId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: modelInput,
                choices: [{ index: 0, delta: { content: block.text }, finish_reason: null }],
              })}\n\n`);
            }
            if (block.type === 'thinking' && block.thinking) {
              fullThinking += block.thinking;
              res.write(`data: ${JSON.stringify({
                id: reqId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: modelInput,
                choices: [{ index: 0, delta: { reasoning_content: block.thinking }, finish_reason: null }],
              })}\n\n`);
            }
          }
        }
      }

      const durationMs = Date.now() - startTime;
      if (!ttfbMs) ttfbMs = durationMs;

      Database.logRequest({
        model: modelInput,
        protocol: 'openai',
        isWarm,
        ttfbMs,
        durationMs,
        status: 200,
      });

      res.write(`data: ${JSON.stringify({
        id: reqId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: modelInput,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        qoder_perf: {
          is_warm: isWarm,
          ttfb_ms: ttfbMs,
          duration_ms: durationMs,
        },
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      console.log(`[OpenAI ${PORT}] stream ${modelInput}->${modelKey}, warm=${isWarm}, TTFB=${ttfbMs}ms, total=${durationMs}ms`);
    } else {
      let fullText = '';
      let fullThinking = '';
      let usage = null;

      for await (const msg of executeQuery({
        promptStream: promptStream(),
        auth,
        modelKey,
        isDefaultAuth,
        onAcquired: (info) => { isWarm = info.isWarm; },
      })) {
        if (msg.type === 'assistant') {
          for (const block of (msg.message?.content || [])) {
            if (!firstTokenCaptured && (block.text || block.thinking)) {
              ttfbMs = Date.now() - startTime;
              firstTokenCaptured = true;
            }
            if (block.type === 'text') fullText += block.text || '';
            if (block.type === 'thinking') fullThinking += block.thinking || '';
          }
        }
        if (msg.type === 'result' && msg.usage) usage = msg.usage;
      }

      const durationMs = Date.now() - startTime;
      if (!ttfbMs) ttfbMs = durationMs;

      Database.logRequest({
        model: modelInput,
        protocol: 'openai',
        isWarm,
        ttfbMs,
        durationMs,
        status: 200,
      });

      res.json({
        id: reqId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: modelInput,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: fullText,
            ...(fullThinking ? { reasoning_content: fullThinking } : {}),
          },
          finish_reason: 'stop',
        }],
        usage: mapUsageToOpenAI(usage),
        qoder_perf: {
          is_warm: isWarm,
          ttfb_ms: ttfbMs,
          duration_ms: durationMs,
        },
      });
      console.log(`[OpenAI ${PORT}] non-stream ${modelInput}->${modelKey}, warm=${isWarm}, TTFB=${ttfbMs}ms, total=${durationMs}ms`);
    }
  } catch (err) {
    console.error(`[OpenAI ${PORT}] Error (model=${modelInput}):`, err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: err.message, type: 'api_error', code: 'internal_error' } });
    }
  }
});

// ============================================================================
// /v1/messages - Anthropic Compatible Endpoint
// ============================================================================
app.post(['/v1/messages', '/api/v1/messages', '/messages'], verifyApiToken, async (req, res) => {
  const startTime = Date.now();
  const modelInput = req.body?.model || 'auto';
  const isStream = Boolean(req.body?.stream);
  const messages = req.body?.messages || [];
  const system = req.body?.system || '';

  let modelKey;
  try {
    await getModelRegistry();
    modelKey = resolveModelKey(modelInput);
  } catch (e) {
    modelKey = modelInput;
  }

  try {
    const { auth, isDefaultAuth } = resolveAuth(req);
    const reqId = 'msg_' + crypto.randomBytes(16).toString('hex');
    let isWarm = false;
    let ttfbMs = 0;
    let firstTokenCaptured = false;

    async function* promptStream() {
      yield {
        type: 'user',
        message: { role: 'user', content: formatAnthropicMessagesForSDK(system, messages) },
        parent_tool_use_id: null,
      };
    }

    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      // 1. message_start
      res.write(`event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: reqId,
          type: 'message',
          role: 'assistant',
          model: modelInput,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })}\n\n`);

      // 2. content_block_start
      res.write(`event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      })}\n\n`);

      let fullText = '';
      let fullThinking = '';
      let usage = null;

      for await (const msg of executeQuery({
        promptStream: promptStream(),
        auth,
        modelKey,
        isDefaultAuth,
        onAcquired: (info) => { isWarm = info.isWarm; },
      })) {
        if (msg.type === 'assistant') {
          for (const block of (msg.message?.content || [])) {
            if (!firstTokenCaptured && (block.text || block.thinking)) {
              ttfbMs = Date.now() - startTime;
              firstTokenCaptured = true;
            }
            if (block.type === 'text' && block.text) {
              fullText += block.text;
              res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: block.text },
              })}\n\n`);
            }
            if (block.type === 'thinking' && block.thinking) {
              fullThinking += block.thinking;
              res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'thinking_delta', thinking: block.thinking },
              })}\n\n`);
            }
          }
        }
        if (msg.type === 'result' && msg.usage) usage = msg.usage;
      }

      // 3. content_block_stop
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({
        type: 'content_block_stop',
        index: 0,
      })}\n\n`);

      const anthropicUsage = mapUsageToAnthropic(usage);
      const durationMs = Date.now() - startTime;
      if (!ttfbMs) ttfbMs = durationMs;

      Database.logRequest({
        model: modelInput,
        protocol: 'anthropic',
        isWarm,
        ttfbMs,
        durationMs,
        status: 200,
      });

      // 4. message_delta
      res.write(`event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: anthropicUsage.output_tokens || 0 },
        qoder_perf: {
          is_warm: isWarm,
          ttfb_ms: ttfbMs,
          duration_ms: durationMs,
        },
      })}\n\n`);

      // 5. message_stop
      res.write(`event: message_stop\ndata: ${JSON.stringify({
        type: 'message_stop',
      })}\n\n`);

      res.end();
      console.log(`[Anthropic ${PORT}] stream ${modelInput}->${modelKey}, warm=${isWarm}, TTFB=${ttfbMs}ms, total=${durationMs}ms`);
    } else {
      let fullText = '';
      let fullThinking = '';
      let usage = null;

      for await (const msg of executeQuery({
        promptStream: promptStream(),
        auth,
        modelKey,
        isDefaultAuth,
        onAcquired: (info) => { isWarm = info.isWarm; },
      })) {
        if (msg.type === 'assistant') {
          for (const block of (msg.message?.content || [])) {
            if (!firstTokenCaptured && (block.text || block.thinking)) {
              ttfbMs = Date.now() - startTime;
              firstTokenCaptured = true;
            }
            if (block.type === 'text') fullText += block.text || '';
            if (block.type === 'thinking') fullThinking += block.thinking || '';
          }
        }
        if (msg.type === 'result' && msg.usage) usage = msg.usage;
      }

      const durationMs = Date.now() - startTime;
      if (!ttfbMs) ttfbMs = durationMs;

      Database.logRequest({
        model: modelInput,
        protocol: 'anthropic',
        isWarm,
        ttfbMs,
        durationMs,
        status: 200,
      });

      res.json({
        id: reqId,
        type: 'message',
        role: 'assistant',
        model: modelInput,
        content: [
          {
            type: 'text',
            text: fullText,
          },
        ],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: mapUsageToAnthropic(usage),
        qoder_perf: {
          is_warm: isWarm,
          ttfb_ms: ttfbMs,
          duration_ms: durationMs,
        },
      });
      console.log(`[Anthropic ${PORT}] non-stream ${modelInput}->${modelKey}, warm=${isWarm}, TTFB=${ttfbMs}ms, total=${durationMs}ms`);
    }
  } catch (err) {
    console.error(`[Anthropic ${PORT}] Error (model=${modelInput}):`, err.message);
    if (!res.headersSent) {
      res.status(500).json({
        type: 'error',
        error: { type: 'api_error', message: err.message },
      });
    }
  }
});

// ============================================================================
// /api/test-chat - Web UI Model Test Endpoint
// ============================================================================
app.post(['/api/test-chat', '/api/test-stream'], async (req, res) => {
  const startTime = Date.now();
  const modelInput = req.body?.model || 'auto';
  const isStream = Boolean(req.body?.stream);
  const prompt = req.body?.prompt || '';
  const messages = prompt ? [{ role: 'user', content: prompt }] : (req.body?.messages || []);

  let modelKey;
  try {
    await getModelRegistry();
    modelKey = resolveModelKey(modelInput);
  } catch (e) {
    modelKey = modelInput;
  }

  try {
    const { auth, isDefaultAuth } = resolveAuth(req);
    let isWarm = false;
    let ttfbMs = 0;
    let firstTokenCaptured = false;

    async function* promptStream() {
      yield {
        type: 'user',
        message: { role: 'user', content: formatOpenAIMessagesForSDK(messages) },
        parent_tool_use_id: null,
      };
    }

    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let fullText = '';
      let fullThinking = '';

      for await (const msg of executeQuery({
        promptStream: promptStream(),
        auth,
        modelKey,
        isDefaultAuth,
        onAcquired: (info) => { isWarm = info.isWarm; },
      })) {
        if (msg.type === 'assistant') {
          for (const block of (msg.message?.content || [])) {
            if (!firstTokenCaptured && (block.text || block.thinking)) {
              ttfbMs = Date.now() - startTime;
              firstTokenCaptured = true;
            }
            if (block.type === 'text' && block.text) {
              fullText += block.text;
              res.write(`event: content\ndata: ${JSON.stringify({ text: block.text })}\n\n`);
            }
            if (block.type === 'thinking' && block.thinking) {
              fullThinking += block.thinking;
              res.write(`event: thinking\ndata: ${JSON.stringify({ thinking: block.thinking })}\n\n`);
            }
          }
        }
      }

      const durationMs = Date.now() - startTime;
      if (!ttfbMs) ttfbMs = durationMs;

      Database.logRequest({
        model: modelInput,
        protocol: 'test_stream',
        isWarm,
        ttfbMs,
        durationMs,
        status: 200,
      });

      res.write(`event: done\ndata: ${JSON.stringify({
        duration_ms: durationMs,
        ttfb_ms: ttfbMs,
        is_warm: isWarm,
        text_length: fullText.length,
        thinking_length: fullThinking.length,
      })}\n\n`);
      res.end();
    } else {
      let fullText = '';
      let fullThinking = '';
      let usage = null;

      for await (const msg of executeQuery({
        promptStream: promptStream(),
        auth,
        modelKey,
        isDefaultAuth,
        onAcquired: (info) => { isWarm = info.isWarm; },
      })) {
        if (msg.type === 'assistant') {
          for (const block of (msg.message?.content || [])) {
            if (!firstTokenCaptured && (block.text || block.thinking)) {
              ttfbMs = Date.now() - startTime;
              firstTokenCaptured = true;
            }
            if (block.type === 'text') fullText += block.text || '';
            if (block.type === 'thinking') fullThinking += block.thinking || '';
          }
        }
        if (msg.type === 'result' && msg.usage) usage = msg.usage;
      }

      const durationMs = Date.now() - startTime;
      if (!ttfbMs) ttfbMs = durationMs;

      Database.logRequest({
        model: modelInput,
        protocol: 'test_sync',
        isWarm,
        ttfbMs,
        durationMs,
        status: 200,
      });

      res.json({
        success: true,
        model: modelInput,
        sdk_value: modelKey,
        text: fullText,
        reasoning_content: fullThinking || null,
        usage: mapUsageToOpenAI(usage),
        is_warm: isWarm,
        ttfb_ms: ttfbMs,
        duration_ms: durationMs,
      });
    }
  } catch (err) {
    console.error(`[API ${PORT}] /api/test-chat error:`, err.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// ============================================================================
// /api/api-auth - API Token Authentication Management (SQLite Backed)
// ============================================================================
app.get('/api/api-auth', requireAuth, (_req, res) => {
  res.json({
    success: true,
    ...Database.getApiAuthConfig(),
  });
});

app.post('/api/api-auth', requireAuth, (req, res) => {
  const { enabled, apiKey } = req.body || {};
  Database.setApiAuthConfig(enabled, apiKey);
  const conf = Database.getApiAuthConfig();
  console.log(`[api-auth] Updated API Token Auth in SQLite: enabled=${conf.enabled}`);
  res.json({
    success: true,
    message: 'API Token 认证配置已保存',
    ...conf,
  });
});

app.post('/api/api-auth/regenerate', requireAuth, (_req, res) => {
  Database.regenerateApiKey();
  const conf = Database.getApiAuthConfig();
  console.log(`[api-auth] Regenerated API Token in SQLite: ${conf.apiKey.slice(0, 14)}...`);
  res.json({
    success: true,
    message: '已成功生成新 Token',
    ...conf,
  });
});

// ============================================================================
// /api/pool-status & /api/system-info
// ============================================================================
app.get('/api/pool-status', (_req, res) => {
  res.json({
    success: true,
    ...warmPool.getStats(),
  });
});

app.get('/api/system-info', async (_req, res) => {
  const token = process.env.QODER_PERSONAL_ACCESS_TOKEN || '';
  const masked = token ? `${token.slice(0, 7)}...${token.slice(-4)}` : '未配置 (未设置 QODER_PERSONAL_ACCESS_TOKEN)';
  let modelNames = [];
  try {
    const models = await getModelRegistry();
    modelNames = models.map(m => m.displayName);
  } catch (e) {}

  res.json({
    success: true,
    token_configured: Boolean(token),
    token_masked: masked,
    token_guide_url: 'https://qoder.com/account/integrations',
    port: PORT,
    host: HOST,
    uptime_seconds: Math.floor(process.uptime()),
    pool_stats: warmPool.getStats(),
    is_default_password: Database.isDefaultPassword(),
    warm_models: modelNames,
    api_auth: Database.getApiAuthConfig(),
    storage: 'SQLite (node:sqlite)',
    node_version: process.version,
  });
});

// ============================================================================
// Root Route - Serve Dashboard SPA
// ============================================================================
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================================
// Server Bootstrap & Pool Preheating
// ============================================================================
app.listen(PORT, HOST, async () => {
  console.log(`\n====================================================================`);
  console.log(`🚀 Qoder OpenAPI & Anthropic Proxy Service Started`);
  console.log(`📍 Listening: http://${HOST}:${PORT}`);
  console.log(`🔐 Default Account: Admin / Admin`);
  console.log(`⚡ WarmQueryPool: Preheating background workers for instant TTFB`);
  console.log(`--------------------------------------------------------------------`);
  try {
    const models = await getModelRegistry();
    console.log(`📏 Models loaded: ${models.length}`);
    for (const m of models.slice(0, 5)) {
      console.log(`     ${m.displayName.padEnd(20)} (value: ${m.value})`);
    }
    if (models.length > 5) console.log(`     ... and ${models.length - 5} more`);
  } catch (e) {
    console.log(`⚠️  Preloading models failed: ${e.message}`);
  }

  // Start preheating the session pool
  warmPool.replenish();

  console.log(`--------------------------------------------------------------------`);
  console.log(`👉 Web Console:         http://${HOST}:${PORT}/`);
  console.log(`👉 OpenAI Chat:        POST http://${HOST}:${PORT}/v1/chat/completions`);
  console.log(`👉 Anthropic Messages:  POST http://${HOST}:${PORT}/v1/messages`);
  console.log(`👉 Model List:          GET  http://${HOST}:${PORT}/v1/models`);
  console.log(`====================================================================\n`);
});