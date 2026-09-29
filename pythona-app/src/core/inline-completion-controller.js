import { redactSecrets } from './context-indexer.js';

export const INLINE_LIMITS = Object.freeze({ idleMs: 800, gapMs: 3000, perMinute: 12, cooldownMs: 30000,
  prefixBytes: 6144, suffixBytes: 2048, outputBytes: 2048, lines: 8 });
const encoder = new TextEncoder();
const bytes = text => encoder.encode(text).length;
const identifier = () => globalThis.crypto?.randomUUID?.() || `inline-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
function bounded(text, limit, tail = false) {
  const characters = Array.from(text);
  if (tail) characters.reverse();
  const chosen = []; let used = 0;
  for (const character of characters) {
    const count = bytes(character);
    if (used + count > limit) break;
    chosen.push(character); used += count;
  }
  if (tail) chosen.reverse();
  return chosen.join('');
}
function identity(snapshot, selection) {
  return { workspaceId: snapshot.workspaceId || 'default', uri: snapshot.uri, epoch: snapshot.epoch, bufferVersion: snapshot.bufferVersion,
    cursor: snapshot.cursor, selection: { anchor: snapshot.selection.anchor, head: snapshot.selection.head },
    selectionVersion: snapshot.selectionVersion, modelSelectionVersion: selection.modelSelectionVersion ?? snapshot.modelSelectionVersion,
    generation: selection.generation ?? snapshot.generation };
}
export function inlineSnapshotKey(snapshot, selection = {}) {
  return JSON.stringify({ ...identity(snapshot, selection), provider: selection.provider,
    model: selection.model, profileId: selection.profileId });
}
export function inlineContext(snapshot) {
  const text = String(snapshot.text ?? snapshot.content ?? '');
  const cursor = snapshot.cursor;
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > text.length) return null;
  if (cursor > 0 && cursor < text.length && /[\uD800-\uDBFF]/.test(text[cursor - 1]) && /[\uDC00-\uDFFF]/.test(text[cursor])) return null;
  let prefixStart = Math.max(0, cursor - INLINE_LIMITS.prefixBytes - 1);
  let suffixEnd = Math.min(text.length, cursor + INLINE_LIMITS.suffixBytes + 1);
  if (/[\uDC00-\uDFFF]/.test(text[prefixStart] || '')) prefixStart++;
  if (/[\uD800-\uDBFF]/.test(text[suffixEnd - 1] || '')) suffixEnd--;
  const prefix = bounded(text.slice(prefixStart, cursor), INLINE_LIMITS.prefixBytes, true);
  const suffix = bounded(text.slice(cursor, suffixEnd), INLINE_LIMITS.suffixBytes);
  // If redaction changes a cursor excerpt, omit the whole request. A completion
  // based on substituted secrets would be both surprising and semantically stale.
  if (redactSecrets(prefix + suffix).text !== prefix + suffix
    || /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=._-]{6,}/i.test(prefix + suffix)
    || prefix.includes('\0') || suffix.includes('\0')) return null;
  return { prefix, suffix };
}
export function validInlineText(text) {
  return typeof text === 'string' && !text.includes('\0') && !text.includes('```')
    && bytes(text) <= INLINE_LIMITS.outputBytes && text.split('\n').length <= INLINE_LIMITS.lines
    && redactSecrets(text).text === text;
}

export class InlineCompletionController {
  constructor({ client, getSnapshot, isEligible = () => true, getSelection, onSuggestion = () => {}, onState = () => {},
    clock = () => Date.now(), setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimer = timer => globalThis.clearTimeout(timer), enabled = true }) {
    Object.assign(this, { client, getSnapshot, isEligible, getSelection, onSuggestion, onState, clock, setTimer, clearTimer, enabled });
    this.timer = null; this.flight = null; this.starts = []; this.ignored = new Set();
    this.lastRequested = ''; this.cooldownUntil = 0; this.authPaused = false; this.modelKey = ''; this.generation = 0; this.disposed = false;
    this.unsubscribeClient = this.client?.subscribeInvalidation?.(event => this.invalidate(event.reason || 'service-disconnected')) || (() => {});
  }
  state(status, extra = {}) { this.onState({ status, ...extra }); }
  setEnabled(value) {
    this.enabled = Boolean(value);
    this.invalidate('setting');
    if (this.enabled) this.schedule(); else this.state('disabled');
  }
  resetAuthorization() { this.authPaused = false; this.cooldownUntil = 0; this.lastRequested = ''; this.schedule(); }
  current() {
    const snapshot = this.getSnapshot?.();
    const selection = this.getSelection?.();
    if (!snapshot || !selection || !snapshot.selection) return null;
    const modelKey = JSON.stringify([selection.provider, selection.model, selection.profileId,
      selection.modelSelectionVersion, selection.generation]);
    if (this.modelKey !== modelKey) { this.authPaused = false; this.modelKey = modelKey; }
    const supported = typeof this.client?.supports === 'function' ? this.client.supports(selection) : this.client?.available;
    const eligible = this.enabled && !this.disposed && supported && this.isEligible(snapshot)
      && snapshot.codeUpload === true && /\.py$/i.test(snapshot.path || '') && snapshot.focused !== false
      && snapshot.editable !== false && !snapshot.readOnly && !snapshot.composing && !snapshot.diff
      && snapshot.selection.anchor === snapshot.cursor && snapshot.selection.head === snapshot.cursor;
    if (!eligible || !selection.model || (!selection.provider && selection.officialMode !== false)) return null;
    const context = inlineContext(snapshot);
    if (!context) return null;
    return { snapshot, selection, context, key: inlineSnapshotKey(snapshot, selection) };
  }
  schedule() {
    if (this.timer != null) this.clearTimer(this.timer);
    this.timer = null;
    const current = this.current();
    if (!current || this.flight || this.authPaused || this.ignored.has(current.key) || this.lastRequested === current.key) return;
    const now = this.clock();
    this.starts = this.starts.filter(time => now - time < 60000);
    if (now < this.cooldownUntil) { this.state('cooldown', { until: this.cooldownUntil }); return; }
    if (this.starts.length >= INLINE_LIMITS.perMinute) { this.state('cooldown', { until: this.starts[0] + 60000 }); return; }
    const due = Math.max(INLINE_LIMITS.idleMs, this.starts.length ? this.starts.at(-1) + INLINE_LIMITS.gapMs - now : 0);
    this.state('waiting');
    this.timer = this.setTimer(() => { this.timer = null; this.trigger(); }, due);
  }
  async trigger() {
    if (this.flight || this.disposed || !this.enabled) return;
    const current = this.current();
    if (!current || this.authPaused || this.ignored.has(current.key) || this.lastRequested === current.key) return;
    const now = this.clock();
    this.starts = this.starts.filter(time => now - time < 60000);
    if (now < this.cooldownUntil || this.starts.length >= 12 || (this.starts.length && now - this.starts.at(-1) < 3000)) return;
    const { snapshot, selection, context, key } = current;
    const completionId = identifier();
    const abort = new AbortController();
    const flight = { completionId, abort, generation: this.generation, key };
    this.flight = flight; this.lastRequested = key; this.starts.push(now); this.state('requesting');
    const payload = { ...identity(snapshot, selection), ...context, completionId, requestId: completionId,
      path: snapshot.path, codeUpload: true, officialMode: selection.officialMode !== false,
      provider: selection.provider || selection.profileId || 'compatibility', model: selection.model, profileId: selection.profileId || '' };
    let result;
    try { result = await this.client.complete(payload, { signal: abort.signal }); }
    catch (_) { result = { status: 'error', error: { code: 'inline-provider-error' } }; }
    if (this.flight !== flight || flight.generation !== this.generation) return;
    this.flight = null;
    const newest = this.current();
    if (!newest || newest.key !== key || abort.signal.aborted) { this.state('idle'); return; }
    if (result.status === 'completed' && validInlineText(result.text)) {
      if (result.text.length) { this.onSuggestion({ text: result.text, token: completionId, source: 'ai', snapshot: payload }); this.state('ready'); }
      else this.state('idle');
      return;
    }
    const code = result.error?.code || result.code || (result.status === 'completed' ? 'inline-output-rejected' : '');
    if (code === 'inline-auth' || code === 'inline-auth-paused') { this.authPaused = true; this.state('paused', { code }); return; }
    if (result.status === 'error' || (result.status === 'completed' && code)) {
      this.cooldownUntil = this.clock() + INLINE_LIMITS.cooldownMs;
      this.state('cooldown', { code, until: this.cooldownUntil }); return;
    }
    this.state('idle', { code });
  }
  invalidate(reason = 'changed') {
    this.generation++;
    if (this.timer != null) this.clearTimer(this.timer);
    this.timer = null;
    if (this.flight) { this.flight.abort.abort(reason); this.flight = null; }
    this.onSuggestion(null); this.state(this.enabled ? 'idle' : 'disabled', { reason });
  }
  reject() {
    const current = this.current();
    if (current) this.ignored.add(current.key);
    while (this.ignored.size > 64) this.ignored.delete(this.ignored.values().next().value);
    this.invalidate('rejected');
  }
  dispose() { this.disposed = true; this.unsubscribeClient(); this.invalidate('disposed'); this.client?.dispose?.(); }
}
