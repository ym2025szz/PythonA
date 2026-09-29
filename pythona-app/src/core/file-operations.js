import { normalizePath } from './workspace-store.js';

function safePath(value) {
  const raw = String(value || '').replaceAll('\\', '/');
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:/.test(raw) || raw.includes('\0')
      || raw.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('请使用工作区内的相对文件路径');
  return normalizePath(raw);
}

function transactionId() { return 'files-' + (globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)); }

/** Text-file operations reuse the same atomic revision/hash transaction as Diff. */
export class FileOperationHistory {
  constructor(store, { limit = 16, maxBytes = 8 * 1024 * 1024 } = {}) {
    this.store = store;
    this.limit = Math.max(1, Math.min(32, limit));
    this.maxBytes = Math.max(1024, Math.min(16 * 1024 * 1024, maxBytes));
    this.history = [];
    this.bytes = 0;
    this.busy = false;
  }
  get latest() { return this.history.at(-1) || null; }
  base(path) {
    const record = this.store.has(path) ? this.store.read(path) : null;
    if (record?.editable === false) throw new Error('此操作只支持可编辑文本文件');
    return { path, beforeExists: Boolean(record), beforeText: record?.content || '',
      baseRevision: record?.revision ?? (this.store.tombstones.get(path) || 0),
      baseSha256: record?.sha256 || record?.hash || '' };
  }
  async create(path, content = '') {
    await this.store.ready;
    const target = safePath(path);
    if (this.store.has(target)) throw new Error('文件已存在：' + target);
    return this.apply([{ ...this.base(target), afterText: String(content) }], '新建 ' + target, target);
  }
  async rename(from, to) {
    await this.store.ready;
    const source = safePath(from); const target = safePath(to);
    if (source === target) throw new Error('新旧文件路径相同');
    if (!this.store.has(source)) throw new Error('文件不存在：' + source);
    if (this.store.has(target)) throw new Error('目标文件已存在：' + target);
    const before = this.base(source);
    return this.apply([{ ...this.base(target), afterText: before.beforeText },
      { ...before, delete: true, afterText: '' }], '重命名 ' + source + ' → ' + target, target);
  }
  async remove(path) {
    await this.store.ready;
    const target = safePath(path);
    if (!this.store.has(target)) throw new Error('文件不存在：' + target);
    return this.apply([{ ...this.base(target), delete: true, afterText: '' }], '删除 ' + target, null);
  }
  async apply(files, label, focusPath) {
    if (this.busy) throw new Error('文件操作正在进行');
    const bytes = files.reduce((sum, file) => sum + new TextEncoder().encode(file.beforeText + file.afterText).length, 0);
    if (bytes > this.maxBytes) throw new Error('文件超出可撤销操作的 8 MiB 内存上限');
    this.busy = true;
    try {
      const result = await this.store.applyBatchAsync({ transactionId: transactionId(), files }, { source: 'file-operation' });
      const written = new Map(result.files.map(file => [file.path, file]));
      const deleted = new Map((result.deleted || []).map(file => [file.path, file]));
      const inverse = files.map(file => {
        const after = file.delete ? deleted.get(file.path) : written.get(file.path);
        if (!after) throw new Error('原生文件事务未返回完整结果');
        return { path: file.path, beforeText: file.delete ? '' : file.afterText,
          afterText: file.beforeText, delete: !file.beforeExists,
          baseRevision: after.revision, baseSha256: file.delete ? '' : after.sha256 || after.hash };
      });
      this.history.push({ label, bytes, inverse, bases: files.map(file => ({ path: file.path, revision: file.baseRevision })),
        focusPath: files.find(file => file.beforeExists)?.path || null });
      this.bytes += bytes;
      while (this.history.length > this.limit || this.bytes > this.maxBytes) this.bytes -= this.history.shift().bytes;
      return { ...result, focusPath };
    } finally { this.busy = false; }
  }
  async undo() {
    if (this.busy) throw new Error('文件操作正在进行');
    const previous = this.latest;
    if (!previous) return null;
    this.busy = true;
    try {
      const result = await this.store.applyBatchAsync({ transactionId: transactionId(), files: previous.inverse }, { source: 'file-operation-undo' });
      this.history.pop(); this.bytes -= previous.bytes;
      // Adjacent undo entries may touch the same path. Advance only matching
      // historical bases after our own inverse; external revisions never do.
      const next = this.latest;
      if (next) for (const file of next.inverse) {
        const originalBase = previous.bases.find(item => item.path === file.path);
        if (originalBase?.revision !== file.baseRevision) continue;
        const restored = result.files.find(item => item.path === file.path);
        const deleted = result.deleted?.find(item => item.path === file.path);
        if (restored && restored.content === file.beforeText) {
          file.baseRevision = restored.revision;
          file.baseSha256 = restored.sha256 || restored.hash;
        } else if (deleted && file.beforeText === '') {
          file.baseRevision = deleted.revision; file.baseSha256 = '';
        }
      }
      return { ...result, focusPath: previous.focusPath };
    } finally { this.busy = false; }
  }
}
