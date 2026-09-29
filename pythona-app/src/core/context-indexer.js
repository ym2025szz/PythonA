const DEFAULT_IGNORES = [
  '.git/**', '.venv/**', 'venv/**', 'node_modules/**', '**/__pycache__/**', '.env',
  '*.pem', '*.key', 'credentials*', 'secrets*'
];

const SECRET_PATTERNS = [
  { type: 'private-key', expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { type: 'anthropic-key', expression: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { type: 'openai-key', expression: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { type: 'google-api-key', expression: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  { type: 'github-token', expression: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { type: 'aws-access-key', expression: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { type: 'slack-token', expression: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { type: 'stripe-secret', expression: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { type: 'jwt', expression: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g },
  { type: 'credential', expression: /\b(password|passwd|api[_-]?key|secret|token)\s*[:=]\s*(["']?)[^\s"']{6,}\2/gi }
];

function globExpression(pattern) {
  let normalized = String(pattern).replaceAll('\\', '/').replace(/^\.\//, '');
  if (normalized.endsWith('/')) normalized += '**';
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('**', '\u0000').replaceAll('*', '[^/]*').replaceAll('\u0000', '.*');
  const prefix = normalized.includes('/') ? '^' : '^(?:.*/)?';
  return new RegExp(`${prefix}${escaped}$`, 'i');
}

function parseIgnoreFile(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
}

export function redactSecrets(text) {
  let output = String(text || '');
  const findings = [];
  for (const { type, expression } of SECRET_PATTERNS) {
    expression.lastIndex = 0;
    output = output.replace(expression, (match) => {
      if (match.includes('[REDACTED:')) return match;
      findings.push({ type, bytes: new TextEncoder().encode(match).length });
      return `[REDACTED:${type}]`;
    });
  }
  return { text: output, findings };
}

export class ProjectContextIndexer {
  constructor(options = {}) {
    this.workspace = options.workspace;
    this.projectIndex = options.projectIndex || null;
    this.maxFileBytes = Number(options.maxFileBytes) || 512 * 1024;
    this.maxContextBytes = Number(options.maxContextBytes) || 2 * 1024 * 1024;
  }

  async build(request = {}) {
    const summaries = this.workspace?.listFiles?.() || [];
    let ignoreText = '';
    if (summaries.some((file) => file.path === '.pyaignore')) {
      try { ignoreText = (await this.read('.pyaignore')).content; } catch (error) { /* optional */ }
    }
    const ignoreRules = [...DEFAULT_IGNORES, ...parseIgnoreFile(ignoreText)].map(globExpression);
    const preferred = [];
    if (request.selection && request.path) preferred.push({ path: request.path, selection: request.selection, priority: 0 });
    if (request.path) preferred.push({
      path: request.path,
      content: request.content == null ? undefined : String(request.content),
      priority: 1
    });
    const indexed = await this.projectIndex?.contextForRequest?.(request) || [];
    indexed.forEach((item) => preferred.push({ path: item.path, content: item.content, priority: 2 }));
    (request.searchResults || []).forEach((item) => preferred.push({ path: item.path, priority: 3 }));
    (request.attachedFiles || []).forEach((path) => preferred.push({ path, priority: 4 }));
    const unique = [];
    const seen = new Set();
    for (const item of preferred.sort((a, b) => a.priority - b.priority)) {
      if (seen.has(item.path)) continue;
      seen.add(item.path);
      unique.push(item);
    }
    const included = [];
    const excluded = [];
    let totalBytes = 0;
    for (const item of unique) {
      const summary = summaries.find((file) => file.path === item.path);
      if (!summary || summary.editable === false || summary.binary === true) { excluded.push({ path: item.path, reason: 'binary-or-missing' }); continue; }
      if (ignoreRules.some((rule) => rule.test(item.path))) { excluded.push({ path: item.path, reason: 'ignored' }); continue; }
      if (item.content == null && item.selection?.text == null
          && Number(summary.size) > this.maxFileBytes) {
        excluded.push({ path: item.path, reason: 'too-large' });
        continue;
      }
      const record = item.content == null ? await this.read(item.path) : { content: item.content };
      const raw = item.selection?.text != null ? String(item.selection.text) : String(record.content || '');
      if (raw.includes('\u0000')) { excluded.push({ path: item.path, reason: 'binary-or-missing' }); continue; }
      if (new TextEncoder().encode(raw).length > this.maxFileBytes) {
        excluded.push({ path: item.path, reason: 'too-large' });
        continue;
      }
      const redacted = redactSecrets(raw);
      const bytes = new TextEncoder().encode(redacted.text).length;
      if (totalBytes + bytes > this.maxContextBytes) { excluded.push({ path: item.path, reason: 'context-limit' }); continue; }
      totalBytes += bytes;
      included.push({ path: item.path, bytes, content: redacted.text, redactions: redacted.findings });
    }
    return {
      provider: request.provider || null,
      model: request.model || null,
      files: included,
      excluded,
      redactions: included.flatMap((file) => file.redactions.map((finding) => ({ path: file.path, ...finding }))),
      estimatedBytes: totalBytes,
      uploadEnabled: request.uploadEnabled !== false
    };
  }

  async read(path) {
    if (this.workspace?.readAsync) return this.workspace.readAsync(path);
    return this.workspace.read(path);
  }
}
