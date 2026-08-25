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
import fs from 'fs';
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
import {
  normalizeAnthropicTools,
  normalizeOpenAiTools,
  buildToolSystemPrompt,
  parseModelToolCalls,
  formatOpenAIMessagesForSDK,
  formatAnthropicMessagesForSDK,
  resolveClientCwd,
} from './utils/tool_parser.mjs';
import {
  streamDirectChatCompletion,
  resolveDirectModelKey,
  qoderTokenManager,
} from './utils/qoder_direct_client.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Debug Request Logger for Claude Code Investigation
// ============================================================================
const DEBUG_LOG_PATH = path.join(__dirname, 'data', 'claude_debug.log');

export function appendDebugLog(title, data) {
  try {
    const timestamp = new Date().toISOString();
    const entry = `\n==================== [${timestamp}] ${title} ====================\n` +
      (typeof data === 'string' ? data : JSON.stringify(data, null, 2)) +
      `\n`;
    fs.appendFileSync(DEBUG_LOG_PATH, entry, 'utf8');
  } catch (err) {
    console.error('Failed to write debug log:', err.message);
  }
}

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
export const OFFICIAL_MODELS = [
  { value: 'auto', displayName: 'Auto', description: 'Auto Model Router · 1.00x Credit', priceFactor: 1.0, isReasoning: false, isVl: false, isDefault: true },
  { value: 'ultimate', displayName: 'Ultimate', description: 'Reasoning · High Performance · 1.60x Credit', priceFactor: 1.6, isReasoning: true, isVl: true },
  { value: 'performance', displayName: 'Performance', description: 'Balanced High Performance · 1.10x Credit', priceFactor: 1.1, isReasoning: false, isVl: true },
  { value: 'efficient', displayName: 'Efficient', description: 'Fast & Efficient · 0.30x Credit', priceFactor: 0.3, isReasoning: false, isVl: false },
  { value: 'lite', displayName: 'Lite', description: 'Free Tier · Fast · 0x Credit', priceFactor: 0.0, isReasoning: false, isVl: false, isFree: true },
  { value: 'cmodel', displayName: 'Cantus', description: 'Reasoning · Vision · 3.20x Credit', priceFactor: 3.2, isReasoning: true, isVl: true },
  { value: 'qmodel_38max', displayName: 'Qwen3.8-Max', description: 'Reasoning · Vision · 0.50x Credit', priceFactor: 0.5, isReasoning: true, isVl: true },
  { value: 'qmodel_latest', displayName: 'Qwen3.7-Max', description: 'Vision · 0.50x Credit', priceFactor: 0.5, isReasoning: false, isVl: true },
  { value: 'qmodel', displayName: 'Qwen3.7-Plus', description: 'Fast Code & General · 0.10x Credit', priceFactor: 0.1, isReasoning: false, isVl: false },
  { value: 'kmodel_latest', displayName: 'Kimi-K3', description: 'Vision · Long Context · 0.80x Credit', priceFactor: 0.8, isReasoning: false, isVl: true },
  { value: 'kmodel', displayName: 'Kimi-K2.7-Code', description: 'Code Specialist · 0.30x Credit', priceFactor: 0.3, isReasoning: false, isVl: false },
  { value: 'gmodel', displayName: 'GLM-5.3', description: 'Reasoning · Vision · 0.60x Credit', priceFactor: 0.6, isReasoning: true, isVl: true },
  { value: 'gm51model', displayName: 'GLM-5.2', description: 'Reasoning · 0.60x Credit', priceFactor: 0.6, isReasoning: true, isVl: false },
  { value: 'dmodel', displayName: 'DeepSeek-V4-Pro', description: 'Reasoning · Vision · 0.80x Credit', priceFactor: 0.8, isReasoning: true, isVl: true },
  { value: 'dfmodel', displayName: 'DeepSeek-V4-Flash', description: 'Reasoning · Vision · 0.30x Credit', priceFactor: 0.3, isReasoning: true, isVl: true },
  { value: 'mmodel', displayName: 'MiniMax-M3', description: 'Vision · Fast · 0.20x Credit', priceFactor: 0.2, isReasoning: false, isVl: true },
];

let MODEL_REGISTRY = new Map();
let MODEL_REGISTRY_BY_VALUE = new Map();

async function getModelRegistry() {
  if (MODEL_REGISTRY.size === 0) {
    for (const m of OFFICIAL_MODELS) {
      MODEL_REGISTRY.set(m.displayName, m);
      MODEL_REGISTRY_BY_VALUE.set(m.value, m);
      liveWarmRegistry.registerModel(m.displayName, m.value);
    }
  }
  return OFFICIAL_MODELS;
}

// ============================================================================
// In-Memory Live Warm Model Registry (纯内存实时运行时状态，不存入数据库)
// ============================================================================
class LiveWarmModelRegistry {
  constructor() {
    this.models = new Map();
  }

  registerModel(modelName, sdkKey) {
    if (!modelName) return;
    const key = modelName.toLowerCase();
    if (!this.models.has(key)) {
      this.models.set(key, {
        modelName,
        sdkKey: sdkKey || modelName,
        status: 'ready',
        lastWarmedAt: Date.now(),
        lastTtfbMs: null,
        totalCalls: 0,
        warmHits: 0,
      });
    }
  }

  recordCall(modelName, sdkKey, isWarm, ttfbMs) {
    if (!modelName) return;
    const key = modelName.toLowerCase();
    let item = this.models.get(key);
    if (!item) {
      // 自动将未登记的模型动态加入预热清单
      item = {
        modelName,
        sdkKey: sdkKey || modelName,
        status: 'ready',
        lastWarmedAt: Date.now(),
        lastTtfbMs: ttfbMs || null,
        totalCalls: 1,
        warmHits: isWarm ? 1 : 0,
      };
      this.models.set(key, item);
      console.log(`[warm-registry] 自动将新模型 [${modelName}] 加入内存预热清单`);
      return;
    }

    item.status = 'ready';
    item.lastWarmedAt = Date.now();
    if (ttfbMs) item.lastTtfbMs = ttfbMs;
    item.totalCalls += 1;
    if (isWarm) item.warmHits += 1;
  }

  getWarmedModels() {
    return Array.from(this.models.values());
  }

  getWarmedModelNames() {
    return Array.from(this.models.values()).map(m => m.modelName);
  }
}

const liveWarmRegistry = new LiveWarmModelRegistry();

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
// Direct Cloud API Preheating & Live Warm Manager
// Preheats Bearer Token & TLS Keep-Alive connections for instant TTFB
// ============================================================================
export async function preheatDirectApi() {
  try {
    const t0 = Date.now();
    const token = await qoderTokenManager.getBearerToken();
    console.log(`⚡ [Warmup] Preheated Qoder Cloud Auth Token in ${Date.now() - t0}ms (Token: ${token.slice(0, 10)}...)`);
    for (const m of OFFICIAL_MODELS) {
      liveWarmRegistry.registerModel(m.displayName, m.value);
    }
  } catch (err) {
    console.warn('⚠️  [Warmup] Preheating token warning:', err.message);
  }
}

// ============================================================================
// /v1/chat/completions - OpenAI Compatible Endpoint (Direct Cloud API)
// ============================================================================
app.post(['/v1/chat/completions', '/api/v1/chat/completions', '/chat/completions'], verifyApiToken, async (req, res) => {
  const startTime = Date.now();
  const modelInput = req.body?.model || 'auto';
  const isStream = Boolean(req.body?.stream);
  const messages = req.body?.messages || [];
  const tools = req.body?.tools || [];
  const temperature = req.body?.temperature;
  const max_tokens = req.body?.max_tokens;
  const reqId = 'chatcmpl-' + crypto.randomUUID();

  let ttfbMs = 0;
  let firstTokenCaptured = false;

  try {
    const stream = streamDirectChatCompletion({
      model: modelInput,
      messages,
      tools,
      temperature,
      max_tokens,
      signal: req.signal,
    });

    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      for await (const chunk of stream) {
        if (!firstTokenCaptured) {
          ttfbMs = Date.now() - startTime;
          firstTokenCaptured = true;
        }
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }

      const durationMs = Date.now() - startTime;
      if (!ttfbMs) ttfbMs = durationMs;

      Database.logRequest({
        model: modelInput,
        protocol: 'openai',
        isWarm: true,
        ttfbMs,
        durationMs,
        status: 200,
      });

      res.write('data: [DONE]\n\n');
      res.end();
      console.log(`[OpenAI ${PORT}] direct stream ${modelInput}, TTFB=${ttfbMs}ms, total=${durationMs}ms`);
    } else {
      let fullContent = '';
      let fullReasoning = '';
      const aggregatedToolCalls = [];
      let finishReason = 'stop';
      let usage = null;

      for await (const chunk of stream) {
        if (!firstTokenCaptured) {
          ttfbMs = Date.now() - startTime;
          firstTokenCaptured = true;
        }
        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) fullContent += choice.delta.content;
        if (choice?.delta?.reasoning_content) fullReasoning += choice.delta.reasoning_content;
        if (choice?.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            const idx = tc.index || 0;
            if (!aggregatedToolCalls[idx]) {
              aggregatedToolCalls[idx] = {
                id: tc.id || `call_${crypto.randomUUID()}`,
                type: 'function',
                function: { name: tc.function?.name || '', arguments: '' },
              };
            }
            if (tc.function?.name) aggregatedToolCalls[idx].function.name = tc.function.name;
            if (tc.function?.arguments) aggregatedToolCalls[idx].function.arguments += tc.function.arguments;
          }
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) usage = chunk.usage;
      }

      const durationMs = Date.now() - startTime;
      if (!ttfbMs) ttfbMs = durationMs;

      Database.logRequest({
        model: modelInput,
        protocol: 'openai',
        isWarm: true,
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
            content: fullContent || null,
            ...(fullReasoning ? { reasoning_content: fullReasoning } : {}),
            ...(aggregatedToolCalls.length > 0 ? { tool_calls: aggregatedToolCalls } : {}),
          },
          finish_reason: aggregatedToolCalls.length > 0 ? 'tool_calls' : finishReason,
        }],
        usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
      console.log(`[OpenAI ${PORT}] direct non-stream ${modelInput}, TTFB=${ttfbMs}ms, total=${durationMs}ms`);
    }
  } catch (err) {
    console.error(`[OpenAI ${PORT}] Direct API Error:`, err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: err.message, type: 'api_error', code: 'internal_error' } });
    }
  }
});

// ============================================================================
// /v1/messages - Anthropic Compatible Endpoint (Direct Cloud API)
// ============================================================================
app.post(['/v1/messages', '/api/v1/messages', '/messages'], verifyApiToken, async (req, res) => {
  const startTime = Date.now();
  const modelInput = req.body?.model || 'auto';
  const isStream = Boolean(req.body?.stream);
  const messages = req.body?.messages || [];
  const system = req.body?.system || '';
  const tools = req.body?.tools || [];
  const temperature = req.body?.temperature;
  const max_tokens = req.body?.max_tokens;
  const reqId = 'msg_' + crypto.randomUUID();

  let ttfbMs = 0;
  let firstTokenCaptured = false;

  // Build combined messages list with system prompt included
  const combinedMessages = [];
  if (system) {
    if (typeof system === 'string') {
      combinedMessages.push({ role: 'system', content: system });
    } else if (Array.isArray(system)) {
      const sysText = system.map(p => typeof p === 'string' ? p : p.text || '').filter(Boolean).join('\n');
      if (sysText) combinedMessages.push({ role: 'system', content: sysText });
    }
  }
  for (const m of messages) {
    combinedMessages.push(m);
  }

  appendDebugLog('INCOMING /v1/messages DIRECT REQUEST', {
    modelInput,
    isStream,
    toolsCount: tools.length,
    messagesCount: messages.length,
  });

  try {
    const stream = streamDirectChatCompletion({
      model: modelInput,
      messages: combinedMessages,
      tools,
      temperature,
      max_tokens,
      signal: req.signal,
    });

    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

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

      let currentBlockIndex = 0;
      let textBlockOpened = false;
      let thinkingBlockOpened = false;
      const toolBlocks = new Map(); // index -> { blockIndex, id, name, inputJson }
      let usage = null;
      let finalFinishReason = 'end_turn';

      for await (const chunk of stream) {
        if (!firstTokenCaptured) {
          ttfbMs = Date.now() - startTime;
          firstTokenCaptured = true;
        }

        const choice = chunk.choices?.[0];
        if (!choice) {
          if (chunk.usage) usage = chunk.usage;
          continue;
        }

        const delta = choice.delta || {};

        // Stream reasoning content as thinking_delta
        if (delta.reasoning_content) {
          if (!thinkingBlockOpened) {
            res.write(`event: content_block_start\ndata: ${JSON.stringify({
              type: 'content_block_start',
              index: currentBlockIndex,
              content_block: { type: 'thinking', thinking: '' },
            })}\n\n`);
            thinkingBlockOpened = true;
          }
          res.write(`event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: currentBlockIndex,
            delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
          })}\n\n`);
        }

        // Stream standard text content as text_delta
        if (delta.content) {
          if (thinkingBlockOpened) {
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({
              type: 'content_block_stop',
              index: currentBlockIndex,
            })}\n\n`);
            currentBlockIndex++;
            thinkingBlockOpened = false;
          }

          if (!textBlockOpened) {
            res.write(`event: content_block_start\ndata: ${JSON.stringify({
              type: 'content_block_start',
              index: currentBlockIndex,
              content_block: { type: 'text', text: '' },
            })}\n\n`);
            textBlockOpened = true;
          }
          res.write(`event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: currentBlockIndex,
            delta: { type: 'text_delta', text: delta.content },
          })}\n\n`);
        }

        // Stream native tool_calls
        if (Array.isArray(delta.tool_calls)) {
          if (thinkingBlockOpened) {
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({
              type: 'content_block_stop',
              index: currentBlockIndex,
            })}\n\n`);
            currentBlockIndex++;
            thinkingBlockOpened = false;
          }
          if (textBlockOpened) {
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({
              type: 'content_block_stop',
              index: currentBlockIndex,
            })}\n\n`);
            currentBlockIndex++;
            textBlockOpened = false;
          }

          for (const tc of delta.tool_calls) {
            const toolIdx = tc.index || 0;
            let tb = toolBlocks.get(toolIdx);
            if (!tb) {
              tb = {
                blockIndex: currentBlockIndex++,
                id: tc.id || `call_${crypto.randomUUID()}`,
                name: tc.function?.name || 'unknown_tool',
                inputJson: '',
              };
              toolBlocks.set(toolIdx, tb);
              res.write(`event: content_block_start\ndata: ${JSON.stringify({
                type: 'content_block_start',
                index: tb.blockIndex,
                content_block: {
                  type: 'tool_use',
                  id: tb.id,
                  name: tb.name,
                  input: {},
                },
              })}\n\n`);
            }

            if (tc.function?.arguments) {
              tb.inputJson += tc.function.arguments;
              res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: tb.blockIndex,
                delta: {
                  type: 'input_json_delta',
                  partial_json: tc.function.arguments,
                },
              })}\n\n`);
            }
          }
        }

        if (choice.finish_reason) {
          if (choice.finish_reason === 'tool_calls') {
            finalFinishReason = 'tool_use';
          } else {
            finalFinishReason = 'end_turn';
          }
        }

        if (chunk.usage) usage = chunk.usage;
      }

      // Close any open blocks
      if (thinkingBlockOpened) {
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({
          type: 'content_block_stop',
          index: currentBlockIndex,
        })}\n\n`);
      }
      if (textBlockOpened) {
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({
          type: 'content_block_stop',
          index: currentBlockIndex,
        })}\n\n`);
      }
      for (const [, tb] of toolBlocks) {
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({
          type: 'content_block_stop',
          index: tb.blockIndex,
        })}\n\n`);
      }

      const durationMs = Date.now() - startTime;
      if (!ttfbMs) ttfbMs = durationMs;

      Database.logRequest({
        model: modelInput,
        protocol: 'anthropic',
        isWarm: true,
        ttfbMs,
        durationMs,
        status: 200,
      });

      // message_delta
      res.write(`event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: {
          stop_reason: toolBlocks.size > 0 ? 'tool_use' : finalFinishReason,
          stop_sequence: null,
        },
        usage: {
          output_tokens: usage?.completion_tokens || 0,
        },
        qoder_perf: {
          is_warm: true,
          ttfb_ms: ttfbMs,
          duration_ms: durationMs,
        },
      })}\n\n`);

      // message_stop
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      res.end();
      console.log(`[Anthropic ${PORT}] direct stream ${modelInput}, tools=${toolBlocks.size}, TTFB=${ttfbMs}ms, total=${durationMs}ms`);
    } else {
      let fullContent = '';
      let fullReasoning = '';
      const aggregatedTools = [];
      let finishReason = 'end_turn';
      let usage = null;

      for await (const chunk of stream) {
        if (!firstTokenCaptured) {
          ttfbMs = Date.now() - startTime;
          firstTokenCaptured = true;
        }
        const choice = chunk.choices?.[0];
        if (!choice) {
          if (chunk.usage) usage = chunk.usage;
          continue;
        }
        if (choice.delta?.content) fullContent += choice.delta.content;
        if (choice.delta?.reasoning_content) fullReasoning += choice.delta.reasoning_content;
        if (choice.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            const idx = tc.index || 0;
            if (!aggregatedTools[idx]) {
              aggregatedTools[idx] = {
                id: tc.id || `call_${crypto.randomUUID()}`,
                name: tc.function?.name || '',
                argumentsText: '',
              };
            }
            if (tc.function?.name) aggregatedTools[idx].name = tc.function.name;
            if (tc.function?.arguments) aggregatedTools[idx].argumentsText += tc.function.arguments;
          }
        }
        if (choice.finish_reason === 'tool_calls') finishReason = 'tool_use';
        if (chunk.usage) usage = chunk.usage;
      }

      const durationMs = Date.now() - startTime;
      if (!ttfbMs) ttfbMs = durationMs;

      Database.logRequest({
        model: modelInput,
        protocol: 'anthropic',
        isWarm: true,
        ttfbMs,
        durationMs,
        status: 200,
      });

      const content = [];
      if (fullReasoning) {
        content.push({ type: 'thinking', thinking: fullReasoning });
      }
      if (fullContent) {
        content.push({ type: 'text', text: fullContent });
      }
      for (const t of aggregatedTools) {
        let parsedArgs = {};
        try { parsedArgs = JSON.parse(t.argumentsText || '{}'); } catch (_) {}
        content.push({
          type: 'tool_use',
          id: t.id,
          name: t.name,
          input: parsedArgs,
        });
      }

      res.json({
        id: reqId,
        type: 'message',
        role: 'assistant',
        model: modelInput,
        content,
        stop_reason: aggregatedTools.length > 0 ? 'tool_use' : finishReason,
        stop_sequence: null,
        usage: {
          input_tokens: usage?.prompt_tokens || 0,
          output_tokens: usage?.completion_tokens || 0,
        },
        qoder_perf: {
          is_warm: true,
          ttfb_ms: ttfbMs,
          duration_ms: durationMs,
        },
      });
      console.log(`[Anthropic ${PORT}] direct non-stream ${modelInput}, tools=${aggregatedTools.length}, TTFB=${ttfbMs}ms, total=${durationMs}ms`);
    }
  } catch (err) {
    appendDebugLog('ERROR /v1/messages', { message: err.message, stack: err.stack });
    console.error(`[Anthropic ${PORT}] Direct API Error:`, err.message);
    if (!res.headersSent) {
      res.status(500).json({
        type: 'error',
        error: { type: 'api_error', message: err.message },
      });
    }
  }
});

// ============================================================================
// ============================================================================
// /api/test-chat - Web UI Model Test Endpoint (Direct Cloud API)
// ============================================================================
app.post(['/api/test-chat', '/api/test-stream'], async (req, res) => {
  const startTime = Date.now();
  const modelInput = req.body?.model || 'MiniMax-M3';
  const isStream = req.path.includes('stream') || Boolean(req.body?.stream);
  const prompt = req.body?.prompt || 'Hello! Say hi briefly.';
  const messages = prompt ? [{ role: 'user', content: prompt }] : (req.body?.messages || []);

  let ttfbMs = 0;
  let firstTokenCaptured = false;

  try {
    const stream = streamDirectChatCompletion({
      model: modelInput,
      messages,
      signal: req.signal,
    });

    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let fullText = '';
      let fullThinking = '';

      for await (const chunk of stream) {
        if (!firstTokenCaptured) {
          ttfbMs = Date.now() - startTime;
          firstTokenCaptured = true;
        }
        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) {
          fullText += choice.delta.content;
          res.write(`event: content\ndata: ${JSON.stringify({ text: choice.delta.content })}\n\n`);
        }
        if (choice?.delta?.reasoning_content) {
          fullThinking += choice.delta.reasoning_content;
          res.write(`event: thinking\ndata: ${JSON.stringify({ thinking: choice.delta.reasoning_content })}\n\n`);
        }
      }

      const durationMs = Date.now() - startTime;
      if (!ttfbMs) ttfbMs = durationMs;

      Database.logRequest({
        model: modelInput,
        protocol: 'test_stream',
        isWarm: true,
        ttfbMs,
        durationMs,
        status: 200,
      });

      res.write(`event: done\ndata: ${JSON.stringify({
        duration_ms: durationMs,
        ttfb_ms: ttfbMs,
        is_warm: true,
        text_length: fullText.length,
        thinking_length: fullThinking.length,
      })}\n\n`);
      res.end();
    } else {
      let fullText = '';
      let fullThinking = '';
      let usage = null;

      for await (const chunk of stream) {
        if (!firstTokenCaptured) {
          ttfbMs = Date.now() - startTime;
          firstTokenCaptured = true;
        }
        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) fullText += choice.delta.content;
        if (choice?.delta?.reasoning_content) fullThinking += choice.delta.reasoning_content;
        if (chunk.usage) usage = chunk.usage;
      }

      const durationMs = Date.now() - startTime;
      if (!ttfbMs) ttfbMs = durationMs;

      Database.logRequest({
        model: modelInput,
        protocol: 'test_sync',
        isWarm: true,
        ttfbMs,
        durationMs,
        status: 200,
      });

      res.json({
        success: true,
        model: modelInput,
        sdk_value: resolveDirectModelKey(modelInput),
        text: fullText,
        reasoning_content: fullThinking || null,
        usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        is_warm: true,
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
    mode: 'direct_cloud_api',
    status: 'ready',
    preheated: Boolean(qoderTokenManager.cachedToken),
    targetSize: 16,
    idleCount: 16,
    pendingCount: 0,
  });
});

app.get('/api/system-info', async (_req, res) => {
  const token = process.env.QODER_PERSONAL_ACCESS_TOKEN || '';
  const masked = token ? `${token.slice(0, 7)}...${token.slice(-4)}` : '未配置 (未设置 QODER_PERSONAL_ACCESS_TOKEN)';

  res.json({
    success: true,
    token_configured: Boolean(token),
    token_masked: masked,
    token_guide_url: 'https://qoder.com/account/integrations',
    port: PORT,
    host: HOST,
    uptime_seconds: Math.floor(process.uptime()),
    pool_stats: {
      mode: 'direct_cloud_api',
      status: 'ready',
      preheated: Boolean(qoderTokenManager.cachedToken),
      targetSize: 16,
      idleCount: 16,
      pendingCount: 0,
    },
    is_default_password: Database.isDefaultPassword(),
    warm_models: liveWarmRegistry.getWarmedModelNames(),
    api_auth: Database.getApiAuthConfig(),
    storage: 'SQLite (node:sqlite)',
    node_version: process.version,
  });
});

app.get('/api/warm-models', (_req, res) => {
  res.json({
    success: true,
    data: liveWarmRegistry.getWarmedModels(),
  });
});

// ============================================================================
// Root Route - Serve Dashboard SPA
// ============================================================================
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================================
// Server Bootstrap & Direct Cloud Preheating
// ============================================================================
app.listen(PORT, HOST, async () => {
  console.log(`\n====================================================================`);
  console.log(`🚀 Qoder Direct Cloud OpenAPI & Anthropic Proxy Service Started`);
  console.log(`📍 Listening: http://${HOST}:${PORT}`);
  console.log(`🔐 Default Account: Admin / Admin`);
  console.log(`⚡ Mode: Direct Cloud HTTP/SSE (Zero Subprocess Overhead)`);
  console.log(`--------------------------------------------------------------------`);
  
  const models = await getModelRegistry();
  console.log(`📏 Models loaded: ${models.length}`);
  for (const m of models.slice(0, 5)) {
    console.log(`     ${m.displayName.padEnd(20)} (value: ${m.value})`);
  }
  if (models.length > 5) console.log(`     ... and ${models.length - 5} more`);

  // Start preheating direct cloud token and registry
  await preheatDirectApi();

  console.log(`--------------------------------------------------------------------`);
  console.log(`👉 Web Console:         http://${HOST}:${PORT}/`);
  console.log(`👉 OpenAI Chat:        POST http://${HOST}:${PORT}/v1/chat/completions`);
  console.log(`👉 Anthropic Messages:  POST http://${HOST}:${PORT}/v1/messages`);
  console.log(`👉 Model List:          GET  http://${HOST}:${PORT}/v1/models`);
  console.log(`====================================================================\n`);
});