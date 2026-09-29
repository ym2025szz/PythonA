const disconnectedTypes = new Set(['disconnected', 'reconnecting', 'binding-died', 'null-binding', 'service-crashed', 'service-disconnected']);

/** Native Binder lifecycle arrives on the service channel, not just broker status. */
export function isDshDisconnect(event = {}) {
  return (!event.channel || event.channel === 'dsh') && disconnectedTypes.has(String(event.type || ''));
}

export function dshDisconnectedError(event = {}) {
  return Object.assign(new Error(event.message || event.error?.message || 'DSH 服务已断开，本轮不会自动重发'), { code: 'service-disconnected' });
}
