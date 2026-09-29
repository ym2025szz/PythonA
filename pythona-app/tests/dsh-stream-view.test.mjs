import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownBlocks, markdownInline, safeMarkdownHref } from '../src/ui/dsh-stream-view.js';

test('stream Markdown accepts text, headings, lists and unfinished fenced code', () => {
  const first = markdownBlocks('# Example\n\nHello **world**.\n\n- one\n- two\n\n```python\nprint("hel');
  assert.deepEqual(first.blocks.map(block => block.type), ['heading', 'paragraph', 'list', 'code']);
  assert.equal(first.blocks[3].language, 'python');
  assert.equal(first.blocks[3].text, 'print("hel');
  const done = markdownBlocks('# Example\n\nHello **world**.\n\n- one\n- two\n\n```python\nprint("hello")\n```');
  assert.deepEqual(done.blocks.slice(0, 3), first.blocks.slice(0, 3));
  assert.equal(done.blocks[3].text, 'print("hello")');
  assert.equal(done.truncated, false);
});

test('Markdown never creates raw HTML or arbitrary URL actions', () => {
  const source = '<img src=x onerror=alert(1)> [run](javascript:alert) [private](file:///data/data/key) [ok](https://example.com/path)';
  const parts = markdownInline(source);
  assert.equal(parts.filter(part => part.type === 'link').length, 1);
  assert.equal(parts.find(part => part.type === 'link').href, 'https://example.com/path');
  assert.ok(parts.some(part => part.text.includes('<img src=x onerror=alert(1)>')));
  for (const value of ['javascript:alert(1)', 'data:text/html,abc', 'file:///workspace/a', 'https://u:p@example.com', 'https://example.com/\nattack', '//example.com']) assert.equal(safeMarkdownHref(value), null);
  assert.equal(safeMarkdownHref('https://example.com/a'), 'https://example.com/a');
});

test('Markdown is bounded by characters, blocks, inline parts and list items', () => {
  const textBounded = markdownBlocks('x'.repeat(500), { maxText: 100 });
  assert.equal(textBounded.blocks[0].text.length, 100);
  assert.equal(textBounded.truncated, true);
  const blocksBounded = markdownBlocks(Array.from({ length: 50 }, (_, i) => `paragraph ${i}`).join('\n\n'), { maxBlocks: 4 });
  assert.equal(blocksBounded.blocks.length, 4);
  assert.equal(blocksBounded.truncated, true);
  const inline = markdownInline('**b**'.repeat(1000));
  assert.ok(inline.length <= 256);
  assert.ok(inline.at(-1).text.length > 1000);
  const list = markdownBlocks('- item\n'.repeat(500));
  assert.ok(list.blocks.every(block => block.type !== 'list' || block.items.length <= 384));
});

test('ordinary CRLF normalization is not reported as truncation', () => {
  assert.equal(markdownBlocks('hello\r\n\r\nworld\r\n').truncated, false);
  assert.deepEqual(markdownInline('Hi `name` **bold** *italic*').map(part => part.type), ['text', 'code', 'text', 'strong', 'text', 'em']);
});
