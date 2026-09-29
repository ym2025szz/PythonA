import { redactSecrets } from './context-indexer.js';

const finiteCount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;

export function createDshTurn(selection = {}) {
  return { id: `turn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, model: String(selection.model || ''),
    provider: String(selection.providerId || ''), reasoning: String(selection.reasoningLevel || 'off'),
    phase: 'waiting', startedAt: Date.now(), finishedAt: null, usage: null, segment: null, tools: new Map(), sequence: 0 };
}

export function contextUsage(usage = {}) {
  // ACP reports measured context occupancy, not billed input/output tokens.
  const used = finiteCount(usage.used);
  const size = finiteCount(usage.size);
  if (used == null) return null;
  return { used, size: size > 0 ? size : null, percent: size > 0 ? Math.min(100, used / size * 100) : null };
}

export function finishDshTurn(turn, phase = 'completed') {
  if (!turn) return;
  if (!turn.finishedAt) { turn.phase = phase; turn.finishedAt = Date.now(); }
  if (turn.segment) { turn.segment.streaming = false; turn.segment.outcome = phase; }
  for (const message of turn.tools.values()) {
    if (!['completed', 'failed', 'cancelled', 'denied'].includes(message.tool.status)) message.tool.status = phase === 'completed' ? 'unknown' : phase;
  }
}

export function applyDshStreamEvent(turn, event, messages) {
  if (!turn || turn.finishedAt) return false;
  const kind = event.kind || event.type;
  if (kind === 'stream_reset' && event.messageId) {
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].streamMessageId === event.messageId) messages.splice(index, 1);
    }
    if (turn.segment?.streamMessageId === event.messageId) turn.segment = null;
    turn.phase = 'waiting';
    return true;
  }
  if (kind === 'usage') { turn.usage = contextUsage(event.usage) || turn.usage; return true; }
  if (kind === 'delta' || kind === 'thought') {
    const segmentKind = kind === 'thought' ? 'thought' : 'answer';
    const blockIndex = Number.isInteger(event.blockIndex) && event.blockIndex >= 0 ? event.blockIndex : null;
    if (!turn.segment || turn.segment.kind !== segmentKind || !turn.segment.streaming || turn.segment.streamMessageId !== event.messageId) {
      if (turn.segment) turn.segment.streaming = false;
      turn.segment = { id: `${turn.id}-${++turn.sequence}`, role: 'assistant', kind: segmentKind, text: '', streaming: true, streamMessageId: event.messageId, blockIndex, model:{model:turn.model,provider:turn.provider,reasoningLevel:turn.reasoning} };
      messages.push(turn.segment);
    }
    // Independent upstream Markdown blocks must not merge a final list item
    // with the next code fence. Never infer boundaries from partial text.
    const boundary = blockIndex != null && turn.segment.blockIndex != null && turn.segment.blockIndex !== blockIndex;
    if (blockIndex != null) turn.segment.blockIndex = blockIndex;
    const text = (boundary && turn.segment.text ? '\n\n' : '') + String(event.text || '');
    const capacity = Math.max(0, 65536 - turn.segment.text.length);
    turn.segment.text += text.slice(0, capacity);
    turn.segment.omittedCharacters = (turn.segment.omittedCharacters || 0) + Math.max(0, text.length - capacity);
    turn.phase = kind === 'thought' ? 'thinking' : 'answering';
    return true;
  }
  const callId = event.callId || event.toolCallId;
  if (callId && ['scope', 'tool-call', 'tool-result', 'tool_result'].includes(kind === 'scope' ? kind : event.type || kind)) {
    const key = String(callId).slice(0, 512);
    let message = turn.tools.get(key);
    if (!message) {
      if (turn.tools.size >= 100) return true;
      message = { id: `${turn.id}-tool-${key}`, role: 'system', kind: 'tool', text: '', tool: { callId: key, title: '工作区工具', status: 'pending', locations: [] } };
      turn.tools.set(key, message);
      messages.push(message);
    }
    if (turn.segment) turn.segment.streaming = false;
    const title = event.title || event.name || (!event.status && event.text);
    if (title) message.tool.title = redactSecrets(String(title)).text.slice(0, 512);
    message.tool.status = event.status || (['tool-result', 'tool_result'].includes(event.type || kind) ? 'completed' : message.tool.status);
    if (Array.isArray(event.locations)) message.tool.locations = event.locations.slice(0, 16).map(location => ({ path: String(location.path || '').slice(0, 1024), line: finiteCount(location.line) }));
    turn.phase = 'tool';
    return true;
  }
  return false;
}

export function summarizeDshContext(context = {}) {
  let remaining = 65536;
  const files = (Array.isArray(context.files) ? context.files : []).slice(0, 100).map(file => {
    const safe = redactSecrets(String(file.content || '')).text;
    const preview = safe.slice(0, Math.min(8192, remaining));
    remaining -= preview.length;
    return { path: String(file.path || '').slice(0, 1024), bytes: finiteCount(file.bytes) || 0,
      redactions: Array.isArray(file.redactions) ? file.redactions.length : finiteCount(file.redactions) || 0,
      preview, truncated: preview.length < safe.length };
  });
  return { provider: String(context.provider || ''), model: String(context.model || ''),
    estimatedBytes: finiteCount(context.estimatedBytes) ?? files.reduce((total,file)=>total+file.bytes,0), files,
    excluded: (Array.isArray(context.excluded) ? context.excluded : []).slice(0, 100).map(file => ({ path: String(file.path || '').slice(0, 1024), reason: String(file.reason || '').slice(0, 64) })),
    redactions: Array.isArray(context.redactions) ? context.redactions.length : files.reduce((total,file)=>total+file.redactions,0) };
}
