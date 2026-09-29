// Observe before submitting: short scripts may finish before admission returns.
// Only bounded output from this task is returned to the requesting DSH tool.
export async function collectRunResult(adapter, start, { timeoutMs = 110_000, cancel = async () => {}, now = () => performance.now() } = {}) {
  const startedAt = now();
  let runId = null;
  let stdout = '';
  let stderr = '';
  let truncated = false;
  let settled = false;
  let finish;
  let timer;
  const terminal = new Promise(resolve => { finish = result => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({ ...result, stdout, stderr, truncated: Boolean(result.truncated || truncated), durationMillis: Math.max(0, Math.round(now() - startedAt)) });
  }; });
  const unsubscribe = adapter.subscribe(event => {
    if (!runId && ['started', 'accepted'].includes(event.type)) runId = event.runId;
    if (!runId || event.runId !== runId) return;
    if (event.type === 'output') {
      const text = String(event.text || '');
      const remaining = Math.max(0, 65536 - stdout.length - stderr.length);
      truncated ||= text.length > remaining;
      if (event.stream === 'stderr') stderr += text.slice(0, remaining);
      else stdout += text.slice(0, remaining);
    }
    if (event.type === 'finished') finish(event.result
      ? { status: event.result.status, counts: event.result.counts, truncated: event.result.truncated }
      : { status: event.exitCode === 0 ? 'completed' : 'error', exitCode: event.exitCode });
    if (event.type === 'stopped') finish({ status: 'cancelled' });
    if (event.type === 'failed') finish({ status: 'error', message: event.error?.message || 'Runtime failed' });
  });
  timer = setTimeout(() => {
    Promise.resolve(cancel(runId)).catch(() => {});
    finish({ status: 'timeout', message: 'DSH requested run exceeded its 110 second observation limit' });
  }, timeoutMs);
  timer.unref?.();
  try {
    const accepted = await start();
    if (!accepted) finish({ status: 'error', message: 'Run admission failed or the active file has unsaved changes' });
    else {
      runId = accepted.runId || runId;
      if (Object.prototype.hasOwnProperty.call(accepted, 'exitCode')) finish({ status: accepted.exitCode === 0 ? 'completed' : 'error', exitCode: accepted.exitCode });
    }
    return await terminal;
  } catch (error) {
    finish({ status: 'error', message: error.message || 'Run failed' });
    return await terminal;
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}
