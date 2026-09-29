// The caller batches render() calls. This view retains rows, open details and
// unchanged Markdown nodes, and never inserts model text as HTML.
export const DSH_VISIBLE_MESSAGES = 80;
export const DSH_VISIBLE_TEXT = 65536;
const MAX_BLOCKS = 384;
const MAX_INLINE_PARTS = 256;

export function safeMarkdownHref(value) {
  const text = String(value || '').trim();
  if (!/^https?:\/\//i.test(text) || /[\u0000-\u0020\u007f]/.test(text)) return null;
  try {
    const parsed = new URL(text);
    return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : null;
  } catch { return null; }
}

export function markdownInline(text) {
  const source = String(text || '');
  const parts = [];
  // Deliberately small Markdown vocabulary: no HTML, image fetches or actions.
  const token = /(`[^`\n]+`|\*\*[^*\n]+\*\*|(?<!\*)\*[^*\n]+\*(?!\*)|\[[^\]\n]+\]\([^\s)]+\))/g;
  let offset = 0;
  for (const match of source.matchAll(token)) {
    if (parts.length >= MAX_INLINE_PARTS - 2) break;
    if (match.index > offset) parts.push({ type: 'text', text: source.slice(offset, match.index) });
    const value = match[0];
    if (value.startsWith('`')) parts.push({ type: 'code', text: value.slice(1, -1) });
    else if (value.startsWith('**')) parts.push({ type: 'strong', text: value.slice(2, -2) });
    else if (value.startsWith('*')) parts.push({ type: 'em', text: value.slice(1, -1) });
    else {
      const bracket = value.indexOf('](');
      const href = safeMarkdownHref(value.slice(bracket + 2, -1));
      parts.push(href ? { type: 'link', text: value.slice(1, bracket), href } : { type: 'text', text: value });
    }
    offset = match.index + value.length;
  }
  if (offset < source.length || !parts.length) parts.push({ type: 'text', text: source.slice(offset) });
  return parts;
}

export function markdownBlocks(value, { maxText = DSH_VISIBLE_TEXT, maxBlocks = MAX_BLOCKS } = {}) {
  const source = String(value || '');
  const text = source.slice(0, Math.max(1, maxText)).replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const blocks = [];
  let index = 0;
  while (index < lines.length && blocks.length < maxBlocks) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})([^`~]*)$/);
    if (fence) {
      const contents = [];
      const marker = fence[1][0];
      const length = fence[1].length;
      index++;
      while (index < lines.length) {
        const close = lines[index].trim();
        if (close.length >= length && [...close].every(char => char === marker)) { index++; break; }
        contents.push(lines[index++]);
      }
      blocks.push({ type: 'code', text: contents.join('\n'), language: fence[2].trim().slice(0, 40) });
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) { blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] }); index++; continue; }
    const list = line.match(/^\s{0,3}([-+*]|\d+[.)])\s+(.+)$/);
    if (list) {
      const ordered = /^\d/.test(list[1]);
      const items = [];
      while (index < lines.length && items.length < MAX_BLOCKS) {
        const next = lines[index].match(/^\s{0,3}([-+*]|\d+[.)])\s+(.+)$/);
        if (!next || /^\d/.test(next[1]) !== ordered) break;
        items.push(next[2]); index++;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    const paragraph = [line]; index++;
    while (index < lines.length && lines[index].trim()
      && !/^\s{0,3}(?:`{3,}|~{3,}|#{1,4}\s|[-+*]\s|\d+[.)]\s)/.test(lines[index])) paragraph.push(lines[index++]);
    blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
  }
  return { blocks, truncated: source.length > Math.max(1, maxText) || index < lines.length };
}

function updateText(node, value) {
  const text = String(value ?? '');
  if (node.data === text) return;
  if (text.startsWith(node.data)) node.appendData(text.slice(node.data.length));
  else node.data = text;
}

async function copyContent(text, button) {
  try {
    if (globalThis.navigator?.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const field=button.ownerDocument.createElement('textarea');field.value=text;field.style.position='fixed';field.style.opacity='0';button.ownerDocument.body.append(field);field.select();
      const copied=button.ownerDocument.execCommand('copy');field.remove();if(!copied)throw new Error('copy unavailable');
    }
    button.textContent='已复制';setTimeout(()=>{if(button.isConnected)button.textContent='复制';},1500);
  } catch { button.textContent='复制失败'; }
}

function inlineInto(parent, text, document) {
  if (parent.__inlineSource === text) return;
  parent.__inlineSource = text;
  const parts = markdownInline(text);
  const nodes = parent.__inlineNodes || [];
  const next = parts.map((part, index) => {
    let item = nodes[index];
    const signature = `${part.type}:${part.href || ''}`;
    if (!item || item.signature !== signature) {
      const node = part.type === 'text' ? document.createTextNode('') : document.createElement(part.type === 'link' ? 'a' : part.type);
      const content = part.type === 'text' ? node : document.createTextNode('');
      if (part.type !== 'text') node.append(content);
      if (part.type === 'link') { node.href = part.href; node.target = '_blank'; node.rel = 'noopener noreferrer'; }
      item = { node, content, signature };
    }
    updateText(item.content, part.text);
    if (parent.childNodes[index] !== item.node) parent.insertBefore(item.node, parent.childNodes[index] || null);
    return item;
  });
  while (parent.childNodes.length > next.length) parent.lastChild.remove();
  parent.__inlineNodes = next;
}

function markdownInto(parent, text, document, maxText, omitted = false) {
  if (parent.__markdownText === text && parent.__markdownOmitted === omitted) return;
  parent.__markdownText = text;
  parent.__markdownOmitted = omitted;
  const parsed = markdownBlocks(text, { maxText });
  const previous = parent.__blocks || [];
  const next = parsed.blocks.map((block, index) => {
    const signature = `${block.type}:${block.level || ''}:${block.ordered || false}`;
    let item = previous[index];
    if (!item || item.signature !== signature) {
      const tag = block.type === 'code' ? 'pre' : block.type === 'heading' ? `h${block.level + 1}` : block.type === 'list' ? (block.ordered ? 'ol' : 'ul') : 'p';
      const node = document.createElement(tag);
      item = { node, signature };
      if (block.type === 'code') {
        const code = document.createElement('code');
        item.content = document.createTextNode(''); code.append(item.content); node.append(code);
        const copy=document.createElement('button');copy.type='button';copy.className='dsh-copy dsh-code-copy';copy.textContent='复制';copy.setAttribute('aria-label','复制代码');
        copy.addEventListener('click',()=>copyContent(item.content.data,copy));node.append(copy);
      }
    }
    if (block.type === 'code') { updateText(item.content, block.text); item.node.dataset.language = block.language; }
    else if (block.type === 'list') {
      block.items.forEach((value, itemIndex) => {
        const child = item.node.children[itemIndex] || document.createElement('li');
        inlineInto(child, value, document);
        if (!child.parentNode) item.node.append(child);
      });
      while (item.node.children.length > block.items.length) item.node.lastElementChild.remove();
    } else inlineInto(item.node, block.text, document);
    if (parent.children[index] !== item.node) parent.insertBefore(item.node, parent.children[index] || null);
    return item;
  });
  while (parent.children.length > next.length) parent.lastElementChild.remove();
  if (parsed.truncated || omitted) {
    const notice = document.createElement('p'); notice.className = 'dsh-truncated';
    notice.textContent = '此消息超过实时显示上限，部分内容已省略。'; parent.append(notice);
  }
  parent.__blocks = next;
}

function boundedValue(value, maximum = 2048) { return String(value ?? '').slice(0, maximum); }
const TOOL_STATES = { pending: '等待中', running: '执行中', in_progress: '执行中', completed: '已完成', complete: '已完成', success: '已完成', failed: '失败', error: '失败', cancelled: '已取消', canceled: '已取消', awaiting_approval: '等待确认' };

export class DshStreamView {
  constructor(container, { jumpButton, maxRows = DSH_VISIBLE_MESSAGES, maxText = DSH_VISIBLE_TEXT, onFollowChange, onOpenLocation, onContext, onHistoricalPatch, onRetry } = {}) {
    this.container = container;
    this.document = container.ownerDocument;
    this.maxRows = Math.max(1, Math.min(200, maxRows));
    this.maxText = Math.max(1, Math.min(262144, maxText));
    this.jumpButton = jumpButton;
    this.onFollowChange = onFollowChange;
    this.onOpenLocation = onOpenLocation;
    this.onContext=onContext;this.onHistoricalPatch=onHistoricalPatch;this.onRetry=onRetry;
    this.rows = new Map();
    this.identities = new WeakMap();
    this.sequence = 0;
    this.following = true;
    this.list = this.document.createElement('div');
    this.list.className = 'dsh-message-list';
    this.list.setAttribute('aria-label', 'DSH 对话');
    this.omitted = this.document.createElement('div');
    this.omitted.className = 'dsh-history-notice';
    this.list.append(this.omitted);
    container.prepend(this.list);
    this.onScroll = () => this.setFollowing(container.scrollHeight - container.scrollTop - container.clientHeight < 56);
    this.onJump = () => this.scrollToLatest();
    container.addEventListener('scroll', this.onScroll, { passive: true });
    jumpButton?.addEventListener('click', this.onJump);
    this.setFollowing(true);
  }

  setFollowing(value) {
    const changed = this.following !== value;
    this.following = value;
    if (this.jumpButton) this.jumpButton.hidden = value;
    if (changed) this.onFollowChange?.(value);
  }

  scrollToLatest() {
    this.setFollowing(true);
    this.container.scrollTop = this.container.scrollHeight;
  }

  keyFor(message) {
    if (message.id != null) return `id:${message.id}`;
    if (!this.identities.has(message)) this.identities.set(message, `object:${++this.sequence}`);
    return this.identities.get(message);
  }

  createRow(message, kind) {
    const node = this.document.createElement('article');
    node.className = `dsh-message ${['assistant', 'user', 'system'].includes(message.role) ? message.role : 'assistant'} dsh-${kind}-message`;
    const content = this.document.createElement('div');
    content.className = 'dsh-message-content';
    const row = { node, content, kind };
    if (kind === 'thought' || kind === 'tool') {
      const details = this.document.createElement('details');
      details.className = `dsh-${kind}-details`;
      const summary = this.document.createElement('summary');
      const title = this.document.createElement('span'); title.className = 'dsh-card-title';
      const status = this.document.createElement('span'); status.className = 'dsh-card-status';
      summary.append(title, status); details.append(summary, content); node.append(details);
      Object.assign(row, { details, title, status });
    } else {
      const label = this.document.createElement('div'); label.className = 'dsh-message-label';
      label.textContent = message.role === 'user' ? '你' : message.role === 'system' ? '状态' : 'DSH';
      row.label=label;
      node.append(label, content);
    }
    return row;
  }

  updateRow(row, message) {
    row.node.classList.toggle('is-streaming', Boolean(message.streaming));
    row.message=message;
    if(row.label && message.role==='assistant' && message.model?.model){const value='DSH · '+message.model.model; if(row.label.textContent!==value)row.label.textContent=value;}
    if (!row.actions && ((message.role==='assistant' && row.kind==='text') || message.context || message.historyPatch)) {
      row.actions=this.document.createElement('div');row.actions.className='dsh-message-actions';
      if(message.role==='assistant' && row.kind==='text'){
        const copy=this.document.createElement('button');copy.type='button';copy.className='dsh-copy';copy.textContent='复制';copy.addEventListener('click',()=>copyContent(row.message.text || '',copy));row.actions.append(copy);
      }
      if(message.context && this.onContext){const context=this.document.createElement('button');context.type='button';context.className='dsh-copy';context.textContent='查看该轮上下文';context.addEventListener('click',()=>this.onContext(row.message.context));row.actions.append(context);}
      if(message.historyPatch && this.onHistoricalPatch){const diff=this.document.createElement('button');diff.type='button';diff.className='dsh-copy';diff.textContent='查看历史 Diff';diff.addEventListener('click',()=>this.onHistoricalPatch(row.message.historyPatch));row.actions.append(diff);}
      if(message.retryPrompt && this.onRetry){const retry=this.document.createElement('button');retry.type='button';retry.className='dsh-copy';retry.textContent='重试为新一轮';retry.addEventListener('click',()=>this.onRetry(row.message.retryPrompt));row.actions.append(retry);}
      row.node.append(row.actions);
    }
    if (row.kind === 'tool') {
      const tool = message.tool || message;
      const status = boundedValue(tool.status || 'pending', 60);
      row.node.dataset.status = Object.hasOwn(TOOL_STATES, status) ? status : 'pending';
      row.title.textContent = boundedValue(tool.title || tool.name || '工具调用', 240);
      row.status.textContent = TOOL_STATES[status] || status;
      markdownInto(row.content, boundedValue(message.text || tool.detail, 8192), this.document, this.maxText, Boolean(message.omittedCharacters));
      const locations = Array.isArray(tool.locations) ? tool.locations.slice(0, 24) : [];
      const locationKey = JSON.stringify(locations.map(location => [location.path || location.uri || '', location.line || 1]));
      if (row.locationKey !== locationKey) {
        row.locations?.remove(); row.locationKey = locationKey;
        row.locations = this.document.createElement('div'); row.locations.className = 'dsh-tool-locations';
        for (const location of locations) {
          const item = this.document.createElement(this.onOpenLocation ? 'button' : 'span');
          item.textContent = `${boundedValue(location.path || location.uri, 512)}${location.line ? `:${location.line}` : ''}`;
          if (this.onOpenLocation) { item.type = 'button'; item.addEventListener('click', () => this.onOpenLocation(location)); }
          row.locations.append(item);
        }
        row.details.append(row.locations);
      }
    } else {
      if (row.kind === 'thought') { row.title.textContent = '思考'; row.status.textContent = message.streaming ? '接收中' : message.outcome === 'cancelled' ? '已停止' : '已结束'; }
      markdownInto(row.content, String(message.text || ''), this.document, this.maxText, Boolean(message.omittedCharacters));
    }
  }

  render(messages = []) {
    const visible = messages.slice(-this.maxRows);
    const following = this.following;
    const top = this.container.getBoundingClientRect().top;
    const anchor = following ? null : [...this.rows.values()].find(row => row.node.getBoundingClientRect().bottom > top);
    const anchorTop = anchor?.node.getBoundingClientRect().top;
    const retained = new Map();
    this.omitted.hidden = messages.length <= this.maxRows;
    this.omitted.textContent = this.omitted.hidden ? '' : `当前显示最近 ${this.maxRows} 条消息，较早的 ${messages.length - this.maxRows} 条已省略。`;
    visible.forEach((message, index) => {
      const key = this.keyFor(message);
      const kind = ['thought', 'tool'].includes(message.kind) ? message.kind : 'text';
      let row = this.rows.get(key);
      if (row && row.kind !== kind) { row.node.remove(); row = null; }
      row ||= this.createRow(message, kind);
      this.updateRow(row, message);
      row.node.dataset.messageId = key;
      const position = this.list.children[index + 1];
      if (position !== row.node) this.list.insertBefore(row.node, position || null);
      retained.set(key, row);
    });
    for (const [key, row] of this.rows) if (!retained.has(key)) row.node.remove();
    this.rows = retained;
    if (following) this.scrollToLatest();
    else if (anchor?.node.isConnected) this.container.scrollTop += anchor.node.getBoundingClientRect().top - anchorTop;
    return { visibleRows: retained.size, omittedRows: Math.max(0, messages.length - visible.length), following: this.following };
  }

  dispose() {
    this.container.removeEventListener('scroll', this.onScroll);
    this.jumpButton?.removeEventListener('click', this.onJump);
    this.rows.clear(); this.list.remove();
  }
}
