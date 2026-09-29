// PythonA compatibility adapter for the pinned official DSH ACP package.
// The upstream package is MIT-licensed and stays byte-for-byte intact on disk.
// This projects its public session/event assistant/chunk facts onto ACP while
// keeping its existing ordered output queue, tools, permissions and lifecycle.
'use strict';
const crypto = require('node:crypto');
const { pathToFileURL, fileURLToPath } = require('node:url');
const EXPECTED_SHA256 = 'c7caf33cdd5768e4e9e27302731708d0bb379b07038079867b403939d6c33aba';
const TARGET = '/usr/local/lib/node_modules/@deepseek-ai/dsh-acp/lib/index.js';
const STATE = Symbol('pythona-acp-stream');
const MAX_STREAM_CHARS = 1024 * 1024;

function enqueue(record, update) {
  const inflight = record.inflight;
  record.outputTail = record.outputTail.then(() => record.notify({
    sessionId: record.agent.session.id, update,
  })).catch((error) => {
    if (inflight) inflight.outputError ??= error;
    record.ctx.logger.warn('acp: PythonA stream delivery failed');
  });
}

function send(record, state, kind, text, blockIndex) {
  if (!text) return;
  if (state.text.length + state.thought.length + text.length > MAX_STREAM_CHARS) {
    state.limitReached = true;
    state.blocks.clear();
    if (record.inflight) record.inflight.outputError ??= new Error('pythona-acp-stream-limit');
    record.agent.cancel({ kind: 'user' });
    return;
  }
  state[kind] += text;
  enqueue(record, { sessionUpdate: kind === 'text' ? 'agent_message_chunk' : 'agent_thought_chunk',
    messageId: state.id, content: { type: 'text', text },
    ...(Number.isSafeInteger(blockIndex) && blockIndex >= 0
      ? { _meta: { pythonaBlockIndex: blockIndex } } : {}) });
}

function reset(record, state, reason) {
  enqueue(record, { sessionUpdate: 'pythona_stream_reset', messageId: state.id, reason });
}

/** True means this live event has replaced the upstream committed projection. */
function streamSessionEvent(record, session, event, assistantUpdates) {
  if (event.type === 'turn/end') { delete record[STATE]; return false; }
  if (event.type !== 'assistant/chunk' && event.type !== 'assistant/message') return false;
  const key = `${event.data.turn}:${event.data.step}`;
  let state = record[STATE];
  if (event.type === 'assistant/chunk') {
    const chunk = event.data.chunk;
    if (state?.key === key && state.limitReached) return true;
    if (!state || state.key !== key || state.retry) {
      const attempt = state?.key === key ? state.attempt + 1 : 0;
      if (state?.key === key && state.retry) reset(record, state, 'retry');
      state = { key, id: `pythona:${key}:${attempt}`, attempt, text: '', thought: '', blocks: new Map() };
      record[STATE] = state;
    }
    if (chunk.type === 'finish') {
      state.retry = chunk.reason?.kind === 'error';
      return true;
    }
    const kind = chunk.type === 'text-delta' ? 'text' : chunk.type === 'reasoning-delta' ? 'thought' : null;
    if (kind && typeof chunk.text === 'string') {
      send(record, state, kind, chunk.text, chunk.index);
      if (state.limitReached) return true;
      const block = state.blocks.get(chunk.index) ?? { kind, text: '' };
      block.text += chunk.text;
      state.blocks.set(chunk.index, block);
    } else if (chunk.type === 'block-end' && ['text', 'reasoning'].includes(chunk.block?.type)) {
      const kind = chunk.block.type === 'text' ? 'text' : 'thought';
      const previous = state.blocks.get(chunk.index)?.text ?? '';
      const complete = chunk.block.text;
      if (typeof complete === 'string' && complete.startsWith(previous)) {
        send(record, state, kind, complete.slice(previous.length), chunk.index);
        state.blocks.set(chunk.index, { kind, text: complete });
      }
    }
    return true;
  }
  if (!state || state.key !== key) return false; // Other producers retain upstream behavior.
  delete record[STATE];
  if (state.limitReached) return true;
  const inflight = record.inflight;
  record.outputTail = record.outputTail.then(async () => {
    const updates = await assistantUpdates(record.ctx, session, event);
    const grouped = { text: '', thought: '' };
    for (const update of updates) {
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') grouped.text += update.content.text;
      if (update.sessionUpdate === 'agent_thought_chunk' && update.content?.type === 'text') grouped.thought += update.content.text;
    }
    const mismatch = !grouped.text.startsWith(state.text) || !grouped.thought.startsWith(state.thought);
    if (mismatch) await record.notify({ sessionId: record.agent.session.id,
      update: { sessionUpdate: 'pythona_stream_reset', messageId: state.id, reason: 'reconcile' } });
    const remaining = { text: mismatch ? 0 : state.text.length, thought: mismatch ? 0 : state.thought.length };
    const knownBlocks = {
      text: [...state.blocks].filter(([, block]) => block.kind === 'text'),
      thought: [...state.blocks].filter(([, block]) => block.kind === 'thought'),
    };
    for (const original of updates) {
      const kind = original.sessionUpdate === 'agent_message_chunk' ? 'text'
        : original.sessionUpdate === 'agent_thought_chunk' ? 'thought' : null;
      let update = original;
      if (kind && original.content?.type === 'text') {
        const text = original.content.text;
        const known = knownBlocks[kind].shift();
        const blockIndex = known && text.startsWith(known[1].text) ? known[0] : undefined;
        const skipped = Math.min(text.length, remaining[kind]);
        remaining[kind] -= skipped;
        if (skipped === text.length) continue;
        update = { ...original, messageId: state.id, content: { type: 'text', text: text.slice(skipped) },
          ...(Number.isSafeInteger(blockIndex) && blockIndex >= 0
            ? { _meta: { pythonaBlockIndex: blockIndex } } : {}) };
      }
      await record.notify({ sessionId: record.agent.session.id, update });
    }
  }).catch((error) => {
    if (inflight) inflight.outputError ??= error;
    record.ctx.logger.warn('acp: PythonA committed stream reconciliation failed');
  });
  return true;
}

function transformSource(source, adapterUrl = pathToFileURL(__filename).href) {
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== EXPECTED_SHA256) {
    throw new Error('pythona-acp-version-mismatch');
  }
  const text = bytes.toString('utf8');
  const anchor = '\tonSessionEvent(session, event) {\n';
  if (text.split(anchor).length !== 2) throw new Error('pythona-acp-hook-mismatch');
  const base = `import pythonaAcpStream from ${JSON.stringify(adapterUrl)};\n`
    + text.replace(anchor, anchor + '\t\tif (pythonaAcpStream.streamSessionEvent(this, session, event, assistantUpdates)) return;\n');
  return attachInline(base, adapterUrl);
}

/** Inline is optional: failed inline wiring must preserve verified ACP streaming. */
function attachInline(text, adapterUrl) {
  const inlineUrl = new URL('./.pythona-inline-completion.cjs', adapterUrl).href;
  const applyAnchor = 'function apply(ctx, config) {\n';
  const connectionAnchor = 'const connection = agent({ name: "deepseek-harness-acp" })';
  const promptAnchor = '.onRequest(methods.agent.session.prompt, ({ params, signal }) => implementation.prompt(params, signal))';
  for (const value of [applyAnchor, connectionAnchor, promptAnchor]) {
    if (text.split(value).length !== 2) return text;
  }
  return text.replace(applyAnchor, applyAnchor + `\tconst pythonaInline = pythonaAcpStream.createInline(ctx, createUserMessage, ${JSON.stringify(inlineUrl)});\n`)
      .replace(connectionAnchor, connectionAnchor
        + '.onRequest("pythona/inline_capabilities", value => value, () => pythonaInline.capabilities())'
        + '.onRequest("pythona/inline_complete", value => value, ({params, signal}) => pythonaInline.complete(params, signal))'
        + '.onRequest("pythona/inline_cancel", value => value, ({params}) => pythonaInline.cancel(params?.completionId))')
      .replace(promptAnchor, '.onRequest(methods.agent.session.prompt, ({ params, signal }) => { pythonaInline.cancelActive(); return implementation.prompt(params, signal); })');
}

function createInline(ctx, createUserMessage, moduleUrl, load = () => require(fileURLToPath(moduleUrl))) {
  const unavailable = {
    capabilities: () => ({ version: 1, available: false, execution: 'llm-only', tools: false, sessions: false }),
    complete: async () => ({ status: 'error', error: { code: 'inline-unavailable' } }),
    cancel: () => ({ cancelled: false }), cancelActive: () => ({ cancelled: false }),
  };
  if (process.env.PYTHONA_INLINE_DISABLED === '1') return unavailable;
  try {
    const controller = load().create(ctx, createUserMessage);
    for (const method of ['capabilities', 'complete', 'cancel', 'cancelActive']) {
      if (typeof controller?.[method] !== 'function') return unavailable;
    }
    return controller;
  } catch (_) { return unavailable; } // No API key, module error text or provider details enter logs.
}

function install() {
  const { registerHooks } = require('node:module');
  if (typeof registerHooks !== 'function') throw new Error('pythona-acp-stream-hooks-unavailable');
  const targetUrl = pathToFileURL(TARGET).href;
  return registerHooks({ load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url !== targetUrl) return loaded;
    return { ...loaded, source: transformSource(loaded.source) };
  } });
}

module.exports = { install, transformSource, attachInline, createInline, streamSessionEvent, EXPECTED_SHA256 };
