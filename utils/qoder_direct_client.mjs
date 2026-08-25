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
 * Model resolution for Qoder Cloud backend (Direct API Verified Keys)
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
  'deepseek-v4-flash': 'deepseek-v4-flash',
  'dfmodel': 'deepseek-v4-flash',

  // Qwen
  'qwen3.8-max': 'qmodel',
  'qmodel_38max': 'qmodel',
  'qwen3.7-max': 'qmodel',
  'qmodel_latest': 'qmodel',
  'qwen3.7-plus': 'qmodel',
  'qmodel': 'qmodel',
  'qwen': 'qmodel',

  // GLM
  'glm-5.3': 'gmodel',
  'glm-5.2': 'gmodel',
  'gmodel': 'gmodel',
  'gm51model': 'gmodel',
  'glm': 'gmodel',

  // Kimi
  'kimi-k3': 'kmodel',
  'kmodel_latest': 'kmodel',
  'kimi-k2.7-code': 'kmodel',
  'kmodel': 'kmodel',
  'kimi': 'kmodel',

  // Cantus
  'cantus': 'ultimate',
  'cmodel': 'ultimate',

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
  const clean = String(modelInput).toLowerCase().trim().replace(/_/g, '-');
  if (MODEL_MAPPINGS[clean]) return MODEL_MAPPINGS[clean];
  const rawClean = String(modelInput).toLowerCase().trim();
  if (MODEL_MAPPINGS[rawClean]) return MODEL_MAPPINGS[rawClean];
  
  if (rawClean.includes('qwen') || rawClean.startsWith('q')) return 'qmodel';
  if (rawClean.includes('kimi') || rawClean.startsWith('k')) return 'kmodel';
  if (rawClean.includes('glm') || rawClean.startsWith('g')) return 'gmodel';
  if (rawClean.includes('flash')) return 'deepseek-v4-flash';
  if (rawClean.includes('deepseek') || rawClean.startsWith('d')) return 'dmodel';
  if (rawClean.includes('minimax') || rawClean.startsWith('m')) return 'mmodel';
  if (rawClean.includes('cantus') || rawClean.startsWith('c')) return 'ultimate';
  
  return 'auto';
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
  signal,
}) {
  const bearerToken = await qoderTokenManager.getBearerToken();
  const backendModel = resolveDirectModelKey(model);
  const reqId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();

  // Convert OpenAI or Anthropic tool definitions to standard Qoder/OpenAI format
  let nativeTools = undefined;
  if (Array.isArray(tools) && tools.length > 0) {
    nativeTools = tools.map((t) => {
      // 1. OpenAI function tool format: { type: 'function', function: { name, description, parameters } }
      if (t.type === 'function' && t.function) {
        return {
          type: 'function',
          function: {
            name: t.function.name,
            description: t.function.description || '',
            parameters: t.function.parameters || { type: 'object', properties: {} },
          },
        };
      }
      // 2. Anthropic tool format: { name, description, input_schema }
      if (t.name && (t.input_schema || !t.type)) {
        return {
          type: 'function',
          function: {
            name: t.name,
            description: t.description || '',
            parameters: t.input_schema || t.parameters || { type: 'object', properties: {} },
          },
        };
      }
      // 3. Generic fallback
      return {
        type: 'function',
        function: {
          name: t.name || 'unknown_tool',
          description: t.description || '',
          parameters: t.parameters || { type: 'object', properties: {} },
        },
      };
    });
  }

  // Format messages (supporting Anthropic multi-part content, tool_use, and tool_result)
  const nativeMessages = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      nativeMessages.push({
        role: m.role || 'user',
        content: m.content,
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        ...(m.name ? { name: m.name } : {}),
      });
    } else if (Array.isArray(m.content)) {
      // Anthropic multi-part content blocks
      const textParts = [];
      const toolCalls = [];
      const toolResults = [];

      for (const part of m.content) {
        if (!part) continue;
        if (part.type === 'text') {
          if (part.text) textParts.push(part.text);
        } else if (part.type === 'tool_use') {
          toolCalls.push({
            id: part.id || `call_${crypto.randomUUID()}`,
            type: 'function',
            function: {
              name: part.name,
              arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input || {}),
            },
          });
        } else if (part.type === 'tool_result') {
          let resContent = '';
          if (typeof part.content === 'string') {
            resContent = part.content;
          } else if (Array.isArray(part.content)) {
            resContent = part.content.map(p => typeof p === 'string' ? p : (p.text || JSON.stringify(p))).join('\n');
          } else if (part.content != null) {
            resContent = JSON.stringify(part.content);
          }
          toolResults.push({
            role: 'tool',
            tool_call_id: part.tool_use_id,
            content: resContent || 'Success',
          });
        }
      }

      if (m.role === 'assistant') {
        const assistantMsg = {
          role: 'assistant',
          content: textParts.join('\n'),
        };
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls;
        }
        nativeMessages.push(assistantMsg);
      } else {
        if (textParts.length > 0) {
          nativeMessages.push({
            role: m.role || 'user',
            content: textParts.join('\n'),
          });
        }
        for (const tr of toolResults) {
          nativeMessages.push(tr);
        }
        if (textParts.length === 0 && toolResults.length === 0) {
          nativeMessages.push({
            role: m.role || 'user',
            content: '',
          });
        }
      }
    } else {
      nativeMessages.push({
        role: m.role || 'user',
        content: m.content != null ? String(m.content) : '',
      });
    }
  }

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
    let parsedErr = {};
    try { parsedErr = JSON.parse(errText); } catch {}
    throw new Error(`Qoder Cloud HTTP ${response.status}: ${parsedErr.message || errText}`);
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
            if (parsed.code || parsed.error || parsed.type === 'invalid_model_error') {
              throw new Error(`Qoder Cloud Error [${parsed.code || parsed.type}]: ${parsed.message || JSON.stringify(parsed)}`);
            }
            yield parsed;
          } catch (e) {
            if (e.message.startsWith('Qoder Cloud Error')) {
              throw e;
            }
            // Ignore malformed JSON chunks
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
