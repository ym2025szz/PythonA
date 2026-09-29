/** Versioned completion channel. It never opens a conversation or tool stream. */
export class InlineCompletionClient {
  constructor(broker, options = {}) {
    this.broker = broker;
    this.capability = options.capabilities || null;
    this.pending = new Map();
    this.runtimeGeneration = Number.isSafeInteger(options.generation) ? options.generation : null;
    this.invalidationListeners = new Set();
    if (typeof options.onInvalidate === 'function') this.invalidationListeners.add(options.onInvalidate);
    this.unsubscribe = broker?.subscribe?.('dsh', event => this.receive(event)) || (() => {});
    this.unsubscribeStatus = broker?.subscribeStatus?.(event => {
      if (event?.channel && event.channel !== 'dsh') return;
      if (['disconnected', 'service-disconnected', 'service-crashed', 'reconnecting', 'binding-died'].includes(event?.type)) {
        this.invalidate(event.type, event);
      }
    }) || (() => {});
  }
  setCapabilities(value) {
    const next = value?.inlineCompletion || value || null;
    const generation = value?.generation ?? next?.generation;
    if (Number.isSafeInteger(generation)) {
      if (this.runtimeGeneration != null && this.runtimeGeneration !== generation) this.invalidate('generation-changed', { generation });
      this.runtimeGeneration = generation;
    }
    this.capability = next;
  }
  subscribeInvalidation(listener) { this.invalidationListeners.add(listener); return () => this.invalidationListeners.delete(listener); }
  invalidate(reason, event = {}) {
    this.capability = null;
    if (Number.isSafeInteger(event.generation)) this.runtimeGeneration = event.generation;
    for (const entry of [...this.pending.values()]) entry.finish({ status: 'error', error: { code: 'inline-disconnected' } });
    for (const listener of this.invalidationListeners) { try { listener({ reason, generation: this.runtimeGeneration }); } catch (_) {} }
  }
  get available() { return Boolean(this.broker?.available && this.capability?.version === 1 && this.capability?.available !== false); }
  supports(selection = {}) {
    if (!this.available) return false;
    if (selection.officialMode === false) return this.capability.compatibilityAvailable === true;
    if (typeof this.capability.officialAvailable === 'boolean') return this.capability.officialAvailable;
    // Older capability v1 payloads advertised only the official route.
    return this.capability.available === true;
  }
  complete(payload, { signal } = {}) {
    if (!this.supports(payload)) return Promise.resolve({ status: 'error', error: { code: 'inline-unavailable' } });
    if (signal?.aborted) return Promise.resolve({ status: 'cancelled' });
    if (Number.isSafeInteger(payload.generation)) {
      if (this.runtimeGeneration != null && this.runtimeGeneration !== payload.generation)
        return Promise.resolve({ status: 'error', error: { code: 'inline-stale-generation' } });
      this.runtimeGeneration = payload.generation;
    }
    return new Promise(resolve => {
      const id = payload.completionId;
      if (!id || this.pending.has(id)) { resolve({ status: 'error', error: { code: 'inline-invalid-identity' } }); return; }
      let timer;
      const onAbort = () => {
        this.cancel(id);
        entry.finish({ status: 'cancelled', completionId: id });
      };
      const entry = { payload,
        finish: value => {
          if (this.pending.get(id) !== entry) return;
          this.pending.delete(id); clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort); resolve(value);
        } };
      this.pending.set(id, entry);
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        this.cancel(id); entry.finish({ status: 'error', error: { code: 'inline-timeout' }, completionId: id });
      }, 30000);
      Promise.resolve(this.broker.request('dsh', 'inlineComplete', payload)).then(response => {
        const result = response?.payload || response;
        if (!result?.accepted) entry.finish({ status: 'rejected', code: result?.code || response?.error?.code || 'inline-rejected', completionId: id });
      }).catch(() => entry.finish({ status: 'error', error: { code: 'inline-disconnected' }, completionId: id }));
    });
  }
  receive(event) {
    const type = event?.type || event?.kind;
    if (['service-crashed', 'service-disconnected', 'runtime-stopped'].includes(type)
      || (type === 'runtime-progress' && event.phase === 'stopped')) {
      this.invalidate(type, event); return;
    }
    if (type === 'runtime-progress' && Number.isSafeInteger(event.generation)) {
      if ((this.runtimeGeneration != null && event.generation !== this.runtimeGeneration)
        || (this.runtimeGeneration == null && this.capability)) this.invalidate('generation-changed', event);
      this.runtimeGeneration = event.generation;
      return;
    }
    if (event?.kind !== 'inlineCompletion') return;
    const entry = this.pending.get(event.completionId);
    if (!entry || !['completed', 'cancelled', 'error'].includes(event.status)) return;
    for (const field of ['workspaceId', 'uri', 'epoch', 'bufferVersion', 'cursor', 'selectionVersion', 'modelSelectionVersion', 'generation']) {
      if (event[field] !== entry.payload[field]) return;
    }
    if (event.selection?.anchor !== entry.payload.selection?.anchor || event.selection?.head !== entry.payload.selection?.head) return;
    if (event.capabilityVersion !== 1) return;
    entry.finish(event);
  }
  cancel(completionId) {
    if (!this.broker?.available) return Promise.resolve({ cancelled: false });
    return Promise.resolve(this.broker.request('dsh', 'inlineCancel', { completionId })).catch(() => ({ cancelled: false }));
  }
  dispose() {
    for (const [id, entry] of [...this.pending]) { this.cancel(id); entry.finish({ status: 'cancelled' }); }
    this.unsubscribe(); this.unsubscribeStatus();
    this.invalidationListeners.clear();
  }
}
