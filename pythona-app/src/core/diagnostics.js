// Diagnostics deliberately accept numeric measurements only: never persist
// source, prompts, file paths, provider URLs or credential-bearing events.
export const METRIC_NAMES = Object.freeze([
  'webviewStartMs', 'resumeFrameMs', 'runtimeReadyMs', 'languageReadyMs',
  'dshCatalogMs', 'dshFirstTokenMs', 'projectIndexMs', 'inputFrameMs',
  'runtimeCancelMs', 'testCancelMs', 'dshCancelMs', 'testDiscoverMs',
  'runStartMs', 'runtimeRestarts', 'languageRestarts', 'dshRestarts',
  'localCompletionMs', 'inlineCompletionMs', 'dshScrollFrameMs'
]);

export class PerformanceDiagnostics {
  constructor({ limit = 256, now = () => globalThis.performance.now() } = {}) {
    this.limit = Math.max(1, Math.min(1024, Number(limit) || 256));
    this.now = now;
    this.samples = new Map();
    this.starts = new Map();
  }
  record(name, value) {
    if (!METRIC_NAMES.includes(name) || !Number.isFinite(value) || value < 0) return false;
    const values = this.samples.get(name) || [];
    values.push(Math.round(value * 100) / 100);
    if (values.length > this.limit) values.splice(0, values.length - this.limit);
    this.samples.set(name, values);
    return true;
  }
  start(name) { if (METRIC_NAMES.includes(name)) this.starts.set(name, this.now()); }
  cancel(name) { this.starts.delete(name); }
  finish(name) {
    if (!this.starts.has(name)) return false;
    const start = this.starts.get(name);
    this.starts.delete(name);
    return this.record(name, Math.max(0, this.now() - start));
  }
  snapshot() {
    return {
      schemaVersion: 1,
      sampleLimit: this.limit,
      scope: 'WebView measurements; native cold start/PSS/device comparison require device benchmark',
      metrics: Object.fromEntries([...this.samples].map(([name, values]) => {
        const sorted = [...values].sort((a, b) => a - b);
        return [name, { count: values.length, latest: values.at(-1),
          p50: sorted[Math.ceil(sorted.length * .5) - 1],
          p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) }];
      }))
    };
  }
}

export function shouldSubmitPrompt(event, composing = false) {
  return event?.key === 'Enter' && !event.shiftKey && !event.isComposing
    && event.keyCode !== 229 && !composing;
}

export function dshErrorMessage(error) {
  const source = `${error?.code || ''} ${error?.message || error || ''}`;
  const messages = {
    'dsh-key-required': '尚未配置官方 API Key，请到设置中配置。',
    'dsh-auth-failed': 'Provider 未接受凭据，请检查 API Key 和账号状态。',
    'dsh-rate-limited': 'Provider 暂时限制请求，请稍后重试。',
    'dsh-network-error': '模型服务连接失败，请检查网络后重试。',
    'dsh-model-unavailable': '所选模型不可用，请刷新目录或切换模型。',
    'dsh-timeout': '模型请求超时，可以重试或换用响应更快的模型。',
    'dsh-busy': 'DSH 正在处理另一项请求，请等待完成或先取消。',
    'acp-transport-closed': 'DSH 连接已断开，请等待恢复或在启动状态中重试。',
    'process-exit': 'DSH 进程已退出，请重新连接后再试。'
  };
  for (const [code, message] of Object.entries(messages)) if (source.includes(code)) return message;
  return 'DSH 请求未完成，请检查模型配置和连接状态后重试。';
}

export function boundDshTranscript(messages, activities) {
  const boundedMessages = messages.slice(-200);
  const boundedActivities = activities.slice(-300);
  let characters = 0;
  for (const message of boundedMessages) {
    message.text = String(message.text || '');
    if (message.text.length > 65536) {
      message.omittedCharacters = (message.omittedCharacters || 0) + message.text.length - 65536;
      message.text = message.text.slice(0, 65536);
    }
    characters += message.text.length;
  }
  while (characters > 2 * 1024 * 1024 && boundedMessages.length > 1) characters -= boundedMessages.shift().text.length;
  for (const activity of boundedActivities) {
    activity.title = String(activity.title || '').slice(0, 512);
    activity.detail = String(activity.detail || '').slice(0, 2048);
  }
  return { messages: boundedMessages, activities: boundedActivities };
}

export function runtimeStartupState(capabilities) {
  return capabilities?.available === true
    ? { state: 'ready', detail: capabilities.python || 'CPython 已就绪' }
    : { state: 'error', detail: capabilities?.reason || 'Runtime 能力尚未就绪' };
}

export function dshStartupState(catalog, error = null) {
  const hasModels = catalog?.providers?.some(provider => provider.official && provider.models?.length);
  if (catalog?.official && catalog?.connected && hasModels) return { state: 'ready', detail: '官方 dsh 和模型目录已就绪' };
  return { state: 'error', detail: error?.message || '官方 dsh 模型目录不可用；可以重试或使用兼容 Provider' };
}

export function normalizeCursorPositions(value, paths) {
  const result = {};
  for (const path of (paths || []).slice(-100)) {
    const offset = value?.[path];
    if (Number.isSafeInteger(offset) && offset >= 0) result[path] = offset;
  }
  return result;
}
