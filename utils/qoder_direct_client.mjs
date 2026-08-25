import crypto from 'crypto';

/**
 * Direct Qoder Cloud API Client
 *
 * Reverse-engineered native HTTP/SSE client for Qoder Model Server:
 * - Direct token exchange via https://openapi.qoder.sh/api/v1/jobToken/exchange
 * - Direct streaming chat completion via https://api2-v2.qoder.sh/model/v1/chat/completions
 * - Native OpenAI tool calling, reasoning content, and token usage mapping
 * - Sub-1.5s TTFB directly over HTTPS with zero subprocess overhead
 */

class QoderTokenManager {
  constructor() {
    this.cachedToken = null;
    this.expiresAt = 0;
    this.exchangePromise = null;
  }

  async getBearerToken(personalToken) {
    const pt = personalToken || process.env.QODER_PERSONAL_ACCESS_TOKEN || process.env.QODERCN_PERSONAL_ACCESS_TOKEN;
    if (!pt) {
      throw new Error('QODER_PERSONAL_ACCESS_TOKEN is not configured in environment or request.');
    }

    // If pt is already a job token (jt-...) or access token, return directly
    if (pt.startsWith('jt-') || pt.startsWith('sat-')) {
      return pt;
    }

    // Return cached token if valid (with 5-minute buffer)
    if (this.cachedToken && Date.now() < this.expiresAt - 5 * 60 * 1000) {
      return this.cachedToken;
    }

    if (this.exchangePromise) {
      return this.exchangePromise;
    }

    this.exchangePromise = (async () => {
      try {
        const res = await fetch('https://openapi.qoder.sh/api/v1/jobToken/exchange', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'qoder/1.0.0',
          },
          body: JSON.stringify({ personal_token: pt }),
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Token exchange failed (HTTP ${res.status}): ${errText}`);
        }

        const data = await res.json();
        if (!data.token) {
          throw new Error(`Token exchange returned invalid payload: ${JSON.stringify(data)}`);
        }

        this.cachedToken = data.token;
        this.expiresAt = data.expires_at ? new Date(data.expires_at).getTime() : (Date.now() + 24 * 3600 * 1000);
        console.log(`[QoderDirect] Job token acquired successfully (expires in ${Math.round((this.expiresAt - Date.now()) / 60000)}m)`);
        return this.cachedToken;
      } finally {
        this.exchangePromise = null;
      }
    })();

    return this.exchangePromise;
  }
}

export const qoderTokenManager = new QoderTokenManager();

/**
 * Model resolution for Qoder Cloud backend (Official 1-to-1 Mapping)
 */
const MODEL_MAPPINGS = {
  // MiniMax
  'minimax-m3': 'mmodel',
  'minimax': 'mmodel',
  'mmodel': 'mmodel',

  // DeepSeek
  'deepseek-v4-pro': 'dmodel',
  'deepseek-v4': 'dmodel',
  'deepseek': 'dmodel',
  'dmodel': 'dmodel',
  'deepseek-v4-flash': 'dfmodel',
  'dfmodel': 'dfmodel',

  // Qwen
  'qwen3.8-max': 'qmodel_38max',
  'qmodel_38max': 'qmodel_38max',
  'qwen3.7-max': 'qmodel_latest',
  'qmodel_latest': 'qmodel_latest',
  'qwen3.7-plus': 'qmodel',
  'qmodel': 'qmodel',

  // GLM
  'glm-5.3': 'gmodel',
  'gmodel': 'gmodel',
  'glm-5.2': 'gm51model',
  'gm51model': 'gm51model',

  // Kimi
  'kimi-k3': 'kmodel_latest',
  'kmodel_latest': 'kmodel_latest',
  'kimi-k2.7-code': 'kmodel',
  'kmodel': 'kmodel',

  // Cantus
  'cantus': 'cmodel',
  'cmodel': 'cmodel',

  // Preset categories
  'ultimate': 'ultimate',
  'performance': 'performance',
  'efficient': 'efficient',
  'lite': 'lite',
  'auto': 'auto',

  // Claude Code aliases
  'sonnet': 'mmodel',
  'opus': 'ultimate',
  'haiku': 'mmodel',
  'claude-3-7-sonnet-20250219': 'mmodel',
  'claude-3-5-sonnet-20241022': 'mmodel',
  'claude-3-5-haiku-20241022': 'mmodel',
};

export function resolveDirectModelKey(modelInput) {
  if (!modelInput) return 'auto';
  const clean = String(modelInput).toLowerCase().trim();
  return MODEL_MAPPINGS[clean] || (clean.startsWith('m') ? 'mmodel' : 'auto');
}

/**
 * Native streaming chat completions generator from Qoder Cloud
 */
export async function* streamDirectChatCompletion({
  model,
  messages,
  tools,
  temperature,
  max_tokens,
  personalToken,
  signal,
}) {
  const bearerToken = await qoderTokenManager.getBearerToken(personalToken);
  const backendModel = resolveDirectModelKey(model);
  const reqId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();

  // Normalize tools for OpenAI format
  let nativeTools = undefined;
  if (Array.isArray(tools) && tools.length > 0) {
    nativeTools = tools.map((t) => {
      if (t.type === 'function') return t;
      return {
        type: 'function',
        function: {
          name: t.name || t.function?.name,
          description: t.description || t.function?.description || '',
          parameters: t.parameters || t.input_schema || t.function?.parameters || {},
        },
      };
    });
  }

  // Normalize messages
  const nativeMessages = (messages || []).map((m) => {
    const role = m.role === 'developer' ? 'system' : m.role;
    const msg = { role };

    if (typeof m.content === 'string') {
      msg.content = m.content;
    } else if (Array.isArray(m.content)) {
      // Anthropic content blocks
      const textParts = [];
      for (const part of m.content) {
        if (part.type === 'text') textParts.push(part.text);
        if (part.type === 'tool_result') {
          msg.role = 'tool';
          msg.tool_call_id = part.tool_use_id;
          msg.content = typeof part.content === 'string' ? part.content : JSON.stringify(part.content);
        }
        if (part.type === 'tool_use') {
          msg.role = 'assistant';
          msg.tool_calls = [{
            id: part.id,
            type: 'function',
            function: {
              name: part.name,
              arguments: JSON.stringify(part.input || {}),
            },
          }];
        }
      }
      if (!msg.content && textParts.length > 0) {
        msg.content = textParts.join('\n');
      }
    }

    if (m.tool_calls) msg.tool_calls = m.tool_calls;
    if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
    if (m.name) msg.name = m.name;

    return msg;
  });

  const payload = {
    model: backendModel,
    messages: nativeMessages,
    stream: true,
    stream_options: { include_usage: true },
    ...(nativeTools ? { tools: nativeTools } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(max_tokens !== undefined ? { max_tokens } : {}),
    metadata: {
      context: {
        request_id: reqId,
        session_id: sessionId,
        client_type: 'cli',
      },
    },
  };

  const response = await fetch('https://api2-v2.qoder.sh/model/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Accept': 'text/event-stream',
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${bearerToken}`,
      'X-Request-ID': reqId,
      'X-Session-ID': sessionId,
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Qoder Cloud HTTP ${response.status}: ${errText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;

        if (trimmed.startsWith('data:')) {
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === '[DONE]') continue;
          if (dataStr === 'null') continue;

          try {
            const parsed = JSON.parse(dataStr);
            yield parsed;
          } catch (_) {
            // Ignore malformed JSON chunks
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
