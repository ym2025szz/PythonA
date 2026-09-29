import { isDshDisconnect, dshDisconnectedError } from './dsh-service-lifecycle.js';

const makeId = () => `turn-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;

/** Only native ACP history can resume model context. Browser previews stay unavailable. */
export class ConversationClient {
  constructor(broker, { workspaceId = 'default' } = {}) {
    this.broker = broker;
    this.workspaceId = workspaceId;
    this.selected = null;
    this.activeTurn = null;
    this.loading = false;
    this.operationEpoch = 0;
    this.pendingRequests = new Set();
    this.listeners = new Set();
    this.unsubscribe = broker?.subscribe?.('dsh', event => this.applyEvent(event)) || (() => {});
    this.unsubscribeStatus = broker?.subscribeStatus?.(event => this.handleLifecycle(event)) || (() => {});
  }
  get available() { return Boolean(this.broker?.available); }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  notify(event) { for (const listener of this.listeners) listener(event); }
  request(method, payload = {}) {
    if (!this.available) return Promise.reject(Object.assign(new Error('浏览器预览不支持官方会话恢复'), { code: 'conversation-unavailable' }));
    const epoch = this.operationEpoch;
    return new Promise((resolve, reject) => {
      this.pendingRequests.add(reject);
      let operation;
      try { operation = this.broker.request('dsh', `conversation.${method}`, { ...payload, workspaceId: this.workspaceId }); }
      catch (error) { this.pendingRequests.delete(reject); reject(error); return; }
      Promise.resolve(operation).then(result => {
        this.pendingRequests.delete(reject);
        if (epoch !== this.operationEpoch) reject(dshDisconnectedError()); else resolve(result);
      }, error => { this.pendingRequests.delete(reject); reject(error); });
    });
  }
  async create(title = '') {
    this.assertIdle();
    const epoch = this.operationEpoch;
    this.loading = true;
    try { return await this.createRecord(title, epoch); }
    finally { if (epoch === this.operationEpoch) this.loading = false; }
  }
  async createRecord(title, epoch = this.operationEpoch) {
    const { conversation } = await this.request('create', { title });
    this.assertEpoch(epoch);
    this.selected = conversation;
    return conversation;
  }
  list({ archived = false, offset = 0 } = {}) { return this.request('list', { archived, offset }); }
  async read(conversationId, { before } = {}) {
    const epoch = this.operationEpoch;
    const result = await this.request('read', { conversationId, ...(before == null ? {} : { before }) });
    this.assertEpoch(epoch);
    // History is never a live source of approval buttons or patch transactions.
    result.messages = (result.messages || []).map(message => ({ ...message, historyReadOnly: true,
      tools: (message.tools || []).map(({ approvalId: _approval, options: _options, ...tool }) => ({ ...tool, historyReadOnly: true })) }));
    return result;
  }
  async select(conversationId) {
    this.assertIdle();
    const epoch = this.operationEpoch;
    this.loading = true;
    try {
      const page = await this.read(conversationId);
      this.assertEpoch(epoch);
      this.selected = page.conversation;
      return page;
    } finally { if (epoch === this.operationEpoch) this.loading = false; }
  }
  async rename(conversationId, title) {
    const epoch = this.operationEpoch;
    const { conversation } = await this.request('rename', { conversationId, title });
    this.assertEpoch(epoch);
    if (this.selected?.id === conversationId) this.selected = conversation;
    return conversation;
  }
  async archive(conversationId, archived = true) {
    this.assertIdle();
    const epoch = this.operationEpoch;
    this.loading = true;
    try {
      const { conversation } = await this.request('archive', { conversationId, archived });
      this.assertEpoch(epoch);
      if (this.selected?.id === conversationId) this.selected = archived ? null : conversation;
      return conversation;
    } finally { if (epoch === this.operationEpoch) this.loading = false; }
  }
  saveDraft(conversationId, draft) { return this.request('draft', { conversationId, draft }); }
  async beginTurn({ conversationId = this.selected?.id, ...payload } = {}) {
    this.assertIdle();
    const epoch = this.operationEpoch;
    this.loading = true;
    try {
      if (!conversationId) conversationId = (await this.createRecord('', epoch)).id;
      this.assertEpoch(epoch);
      const turnId = makeId();
      this.activeTurn = { conversationId, turnId, workspaceId: this.workspaceId };
      return { ...payload, ...this.activeTurn };
    } finally { if (epoch === this.operationEpoch) this.loading = false; }
  }
  failStart(error) {
    const turn = this.activeTurn;
    this.activeTurn = null;
    if (turn) this.notify({ type: 'error', ...turn, message: error?.message || String(error || '') });
  }
  applyEvent(event = {}) {
    const outer = event?.event && typeof event.event === 'object' ? event.event : event;
    if (this.handleLifecycle(outer)) return true;
    const turn = this.activeTurn;
    if (!turn || event.conversationId !== turn.conversationId || event.turnId !== turn.turnId
        || (event.workspaceId && event.workspaceId !== turn.workspaceId)) return false;
    if (event.kind === 'done' || event.kind === 'error') {
      // Native terminal already waited for ACP close and persistence.
      this.activeTurn = null;
      this.notify({ ...event, type: 'turn-finished' });
    }
    return true;
  }
  assertIdle() {
    if (this.loading) throw Object.assign(new Error('正在载入会话，请稍候'), { code: 'conversation-loading' });
    if (this.activeTurn) throw Object.assign(new Error('请等待本轮保存完成或停止当前请求'), { code: 'conversation-busy' });
  }
  assertEpoch(epoch) { if (epoch !== this.operationEpoch) throw dshDisconnectedError(); }
  handleLifecycle(event = {}) {
    if (!isDshDisconnect(event)) return false;
    const turn = this.activeTurn;
    this.operationEpoch++;
    this.activeTurn = null;
    this.loading = false;
    const error = dshDisconnectedError(event);
    for (const reject of this.pendingRequests) reject(error);
    this.pendingRequests.clear();
    if (turn) this.notify({ type: 'interrupted', ...turn, code: error.code, message: error.message });
    return true;
  }
  dispose() {
    this.unsubscribe(); this.unsubscribeStatus(); this.listeners.clear();
    this.handleLifecycle({ type: 'service-disconnected' });
  }
}
