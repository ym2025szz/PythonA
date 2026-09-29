/** Native drafts are separate from executable/exported workspace files. */
export class EditorDraftClient {
  constructor(broker, workspaceId = 'default', options = {}) {
    this.broker = broker;
    this.nativeAuthoritative = Boolean(broker?.available);
    this.workspaceId = workspaceId;
    this.storage = options.storage ?? null;
    this.prefix = `pythona.editor-draft.v1:${workspaceId}:`;
  }
  async request(method, payload = {}) {
    if (this.broker?.available) {
      this.nativeAuthoritative = true;
      return this.broker.request('draft', method, { workspaceId: this.workspaceId, ...payload });
    }
    if (this.nativeAuthoritative) throw Object.assign(new Error('原生草稿服务已断开，未保存内容仍保留在编辑器中'), { code: 'draft-disconnected' });
    // Browser mode can opt into storage; native mode never copies drafts here.
    if (!this.storage) return method === 'list' ? { drafts: [] } : null;
    if (method === 'list') {
      const drafts = [];
      for (let index = 0; index < this.storage.length; index += 1) {
        const key = this.storage.key(index);
        if (key?.startsWith(this.prefix)) {
          try { const value = JSON.parse(this.storage.getItem(key)); drafts.push({ path: value.path, updatedAt: value.updatedAt }); } catch (_) { /* preserve unreadable entries */ }
        }
      }
      return { drafts };
    }
    const key = this.prefix + payload.path;
    if (method === 'read') return JSON.parse(this.storage.getItem(key) || 'null');
    if (method === 'write') { this.storage.setItem(key, JSON.stringify(payload)); return { saved: true }; }
    if (method === 'delete') { this.storage.removeItem(key); return { deleted: true }; }
    throw new Error('Unknown draft method');
  }
  async list() {
    const result = await this.request('list');
    this.warnings = Array.isArray(result?.errors) ? result.errors : [];
    return result?.drafts || [];
  }
  read(path) { return this.request('read', { path }); }
  write(draft) { return this.request('write', draft); }
  delete(path) { return this.request('delete', { path }); }
}
