import { createMultiFilePatch } from './patch-engine.js';
import { toDocumentUri } from './language-service.js';

export function captureRenameBase(store, document) {
  if (document.dirty || document.conflict) throw new Error('请先保存并解决文件冲突');
  return { path: document.path, bufferVersion: document.bufferVersion,
    buffer: document.buffer, files: new Map(store.listFiles().map(f => [f.path, { ...f }])) };
}

export function createRenameTransaction(edit, base) {
  if (!edit || edit.truncated) throw new Error('重命名结果不完整');
  const files = Object.entries(edit.changes || {}).map(([uri, edits]) => {
    if (!Array.isArray(edits) || edits.length !== 1) throw new Error('重命名结果格式不支持');
    const e = edits[0], path = e.path;
    if (!path || toDocumentUri(path) !== uri || !base.files.has(path)) throw new Error('重命名包含未知文件');
    const record = base.files.get(path);
    if (record.editable === false || typeof e.before !== 'string' || e.before !== record.content || typeof e.newText !== 'string') {
      throw new Error('文件已发生修改：' + path);
    }
    return { path, beforeText: e.before, afterText: e.newText,
      baseRevision: record.revision, baseSha256: record.sha256 || record.hash };
  });
  return createMultiFilePatch(files, { title: 'Rename → ' + edit.newName });
}

export function validateRenameBase(store, document, base, transaction) {
  if (document.path !== base.path || document.bufferVersion !== base.bufferVersion
      || document.buffer !== base.buffer || document.dirty || document.conflict) {
    throw new Error('缓冲区已变化，重命名预览已失效');
  }
  for (const f of transaction.files) {
    if (!store.has(f.path)) throw new Error('文件已删除：' + f.path);
    const current = store.read(f.path);
    if (current.revision !== f.baseRevision || (current.sha256 || current.hash) !== f.baseSha256
        || current.content !== f.beforeText) throw new Error('文件已变化，整批重命名已失效：' + f.path);
  }
}
