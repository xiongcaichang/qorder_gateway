import crypto from 'crypto';

/**
 * Convert Anthropic tool definitions to a normalized format.
 * Anthropic uses `input_schema` where OpenAI uses `parameters`.
 */
export function normalizeAnthropicTools(tools) {
  if (!tools || !Array.isArray(tools)) return [];
  return tools.map((tool) => ({
    name: tool.name || tool.function?.name,
    description: tool.description || tool.function?.description || '',
    parameters: tool.input_schema || tool.parameters || tool.function?.parameters || {},
  }));
}

/**
 * Convert OpenAI tool definitions to a normalized format.
 */
export function normalizeOpenAiTools(tools) {
  if (!tools || !Array.isArray(tools)) return [];
  return tools.map((tool) => ({
    name: tool.function?.name || tool.name,
    description: tool.function?.description || tool.description || '',
    parameters: tool.function?.parameters || tool.parameters || {},
  }));
}

/**
 * Build unified system prompt for tool protocol instructions.
 */
export function buildToolSystemPrompt(tools) {
  if (!tools || !Array.isArray(tools) || tools.length === 0) return '';
  const toolDescriptions = tools.map((t) => ({
    name: t.name,
    description: t.description || '',
    parameters: t.parameters || {},
  }));

  return [
    '[Tool Protocol] 以下工具可供调用：',
    '',
    JSON.stringify(toolDescriptions, null, 2),
    '',
    '如需调用工具，请输出以下格式的 JSON 代码块：',
    '```json',
    '{"tool_calls": [{"name": "工具名称", "arguments": {参数对象}}]}',
    '```',
    '',
    '如不需要调用工具，直接以正常文本回复，不要输出任何工具调用 JSON 代码块。',
  ].join('\n');
}

/**
 * Extract balanced JSON containing "tool_calls", parse markdown code blocks,
 * and support DSML (<｜｜DSML｜｜tool_calls>) & XML (<tool_call>) formats.
 */
export function parseModelToolCalls(text) {
  if (!text || typeof text !== 'string') return { cleanedText: '', toolCalls: [] };
  const toolCalls = [];

  // 1. Try markdown ```json ... ``` block
  const jsonBlockRe = /```(?:json)?\s*\n([\s\S]*?)\n```/gi;
  let match;
  while ((match = jsonBlockRe.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed && Array.isArray(parsed.tool_calls)) {
        for (const call of parsed.tool_calls) {
          if (call && call.name) {
            toolCalls.push({
              id: 'toolu_' + crypto.randomBytes(12).toString('hex'),
              name: call.name,
              input: call.arguments || call.input || {},
            });
          }
        }
      }
    } catch (_) {}
  }

  // 2. Try DSML Tool Calls (<｜｜DSML｜｜tool_calls>...)
  const dsmlBlockRegex = /<[｜|]{2}DSML[｜|]{2}tool_calls>([\s\S]*?)<\/[｜|]{2}DSML[｜|]{2}tool_calls>/gi;
  while ((match = dsmlBlockRegex.exec(text)) !== null) {
    const body = match[1];
    const invokeRegex = /<[｜|]{2}DSML[｜|]{2}invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/[｜|]{2}DSML[｜|]{2}invoke>/gi;
    let invMatch;
    while ((invMatch = invokeRegex.exec(body)) !== null) {
      const name = invMatch[1];
      const invBody = invMatch[2];
      const input = {};
      const paramRegex = /<[｜|]{2}DSML[｜|]{2}parameter\s+name=["']([^"']+)["'](?:\s+string=["']([^"']+)["'])?\s*>([\s\S]*?)<\/[｜|]{2}DSML[｜|]{2}parameter>/gi;
      let pMatch;
      while ((pMatch = paramRegex.exec(invBody)) !== null) {
        const pName = pMatch[1];
        const isString = pMatch[2] === 'true';
        const pVal = pMatch[3].trim();
        if (isString) {
          input[pName] = pVal;
        } else {
          try {
            input[pName] = JSON.parse(pVal);
          } catch {
            input[pName] = pVal;
          }
        }
      }
      toolCalls.push({
        id: 'toolu_' + crypto.randomBytes(12).toString('hex'),
        name,
        input,
      });
    }
  }

  // 3. Try XML <tool_call>...</tool_call>
  const xmlBlockRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  while ((match = xmlBlockRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed.name) {
        toolCalls.push({
          id: 'toolu_' + crypto.randomBytes(12).toString('hex'),
          name: parsed.name,
          input: parsed.arguments || parsed.input || {},
        });
      }
    } catch {}
  }

  // 4. Raw JSON fallback with brace counting
  let rawJsonCandidate = null;
  if (toolCalls.length === 0 && text.includes('"tool_calls"')) {
    for (let start = 0; start < text.length; start++) {
      if (text[start] !== '{') continue;
      let depth = 0;
      let inString = false;
      let escapeNext = false;
      let end = start;

      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (escapeNext) { escapeNext = false; continue; }
        if (ch === '\\' && inString) { escapeNext = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        if (ch === '}') {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }

      if (depth === 0) {
        const candidate = text.slice(start, end + 1);
        if (candidate.includes('"tool_calls"')) {
          try {
            const parsed = JSON.parse(candidate);
            if (parsed && Array.isArray(parsed.tool_calls)) {
              for (const call of parsed.tool_calls) {
                if (call && call.name) {
                  toolCalls.push({
                    id: 'toolu_' + crypto.randomBytes(12).toString('hex'),
                    name: call.name,
                    input: call.arguments || call.input || {},
                  });
                }
              }
              rawJsonCandidate = candidate;
              break;
            }
          } catch {}
        }
      }
    }
  }

  let cleanedText = text
    .replace(/```(?:json)?\s*\n[\s\S]*?"tool_calls"[\s\S]*?\n```/gi, '')
    .replace(/<[｜|]{2}DSML[｜|]{2}tool_calls>[\s\S]*?<\/[｜|]{2}DSML[｜|]{2}tool_calls>/gi, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '');

  if (rawJsonCandidate) {
    cleanedText = cleanedText.replace(rawJsonCandidate, '');
  }

  // Also remove standalone `{"tool_calls": [...]}` if present
  cleanedText = cleanedText.replace(/\{[\s\r\n]*"tool_calls"[\s\S]*?\}/gi, '').trim();

  return { cleanedText, toolCalls };
}

/**
 * Extract the client working directory from headers, body, or system prompt.
 */
export function resolveClientCwd(req) {
  // 1. Direct headers
  const headerCwd =
    req.headers?.['x-working-directory'] ||
    req.headers?.['x-cwd'] ||
    req.headers?.['x-project-dir'] ||
    req.headers?.['x-workspace-dir'] ||
    req.headers?.['x-project-path'];
  if (headerCwd && typeof headerCwd === 'string' && headerCwd.trim()) {
    return headerCwd.trim();
  }

  // 2. Direct body properties
  const bodyCwd = req.body?.cwd || req.body?.working_directory || req.body?.project_dir || req.body?.workspace_dir;
  if (bodyCwd && typeof bodyCwd === 'string' && bodyCwd.trim()) {
    return bodyCwd.trim();
  }

  // 3. Extract from system prompt (Claude Code standard: "Current working directory: /path/to/dir")
  const system = req.body?.system;
  let systemText = '';
  if (typeof system === 'string') systemText = system;
  else if (Array.isArray(system)) systemText = system.map(s => s.text || '').join('\n');

  if (systemText) {
    const match = systemText.match(/(?:Current working directory|working directory|cwd|Working in)[:\s]+([\/~][^\n\r\t]+)/i);
    if (match && match[1]) {
      return match[1].trim().replace(/[.,;:]+$/, '');
    }
  }

  // 4. Extract from conversation messages if present
  for (const m of (req.body?.messages || [])) {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    const match = content.match(/(?:Current working directory|working directory|cwd|Working in)[:\s]+([\/~][^\n\r\t]+)/i);
    if (match && match[1]) {
      return match[1].trim().replace(/[.,;:]+$/, '');
    }
  }

  return process.cwd();
}

/**
 * Format OpenAI messages for SDK consumption.
 */
export function formatOpenAIMessagesForSDK(messages, rawTools, clientCwd) {
  const parts = [];
  if (clientCwd) {
    parts.push(`[Current Working Directory]\n${clientCwd}`);
  }

  const tools = normalizeOpenAiTools(rawTools);
  if (tools.length > 0) {
    parts.push(buildToolSystemPrompt(tools));
  }

  for (const m of (messages || [])) {
    if (m.role === 'system') {
      parts.push(`[System] ${m.content}`);
    } else if (m.role === 'tool') {
      const id = m.tool_call_id || 'unknown';
      parts.push(`<tool_result id="${id}">\n${m.content}\n</tool_result>`);
    } else if (m.role === 'assistant') {
      if (m.tool_calls && Array.isArray(m.tool_calls)) {
        const toolCallsStr = m.tool_calls.map(c => `[assistant called tool: ${c.function?.name || c.name} with arguments: ${c.function?.arguments || JSON.stringify(c.arguments || {})}]`).join('\n');
        parts.push(`[Assistant] ${m.content ? m.content + '\n' : ''}${toolCallsStr}`);
      } else {
        parts.push(`[Assistant] ${m.content || ''}`);
      }
    } else if (m.role === 'user') {
      parts.push(m.content || '');
    }
  }
  return parts.join('\n\n');
}

/**
 * Format Anthropic messages and system prompt for SDK consumption.
 */
export function formatAnthropicMessagesForSDK(system, messages, rawTools, clientCwd) {
  const parts = [];
  if (system) {
    if (typeof system === 'string' && system.trim()) {
      parts.push(`[System] ${system.trim()}`);
    } else if (Array.isArray(system)) {
      const sysText = system.map(b => b.text || '').join('\n').trim();
      if (sysText) parts.push(`[System] ${sysText}`);
    }
  }

  if (clientCwd) {
    parts.push(`[Current Working Directory]\n${clientCwd}`);
  }

  const tools = normalizeAnthropicTools(rawTools);
  if (tools.length > 0) {
    parts.push(buildToolSystemPrompt(tools));
  }

  for (const m of (messages || [])) {
    let contentText = '';
    if (typeof m.content === 'string') {
      contentText = m.content;
    } else if (Array.isArray(m.content)) {
      contentText = m.content
        .map(b => {
          if (b.type === 'text') return b.text || '';
          if (b.type === 'tool_use') return `[assistant called tool: ${b.name} with arguments: ${JSON.stringify(b.input || {})}]`;
          if (b.type === 'tool_result') {
            const resultText = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
            return `<tool_result id="${b.tool_use_id}">\n${resultText}\n</tool_result>`;
          }
          return b.text || JSON.stringify(b);
        })
        .filter(Boolean)
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
