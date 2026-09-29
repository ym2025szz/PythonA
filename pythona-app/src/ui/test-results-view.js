const PAGE_SIZE = 50;
const outcomeLabels = { passed: '通过', failed: '失败', error: '异常', skipped: '跳过' };
const statusLabels = {
  passed: '全部通过', failed: '测试失败', error: '测试异常', errors: '测试异常',
  cancelled: '已取消', timeout: '已超时', timed_out: '已超时',
  empty: '未发现测试', 'no-tests': '未发现测试', no_tests: '未发现测试',
  'collection-error': '收集失败', collection_error: '收集失败',
  running: '正在运行', discovering: '正在发现测试', interrupted: '运行中断'
};
const collapsedSuites = new WeakMap();
const failed = item => item.outcome === 'failed' || item.outcome === 'error';
const boundedCount = value => Math.max(0, Number(value) || 0);

/** Pagination/filtering operate only on case rows, never the run's original totals. */
export function buildTestResultsModel(result, { filter = 'all', failedFirst = true, page = 0 } = {}) {
  if (!result) return null;
  const all = Array.isArray(result.cases) ? result.cases : [];
  const visible = all.map((item,index) => ({item,index})).filter(({item}) =>
    filter === 'failed' ? failed(item) : filter === 'passed' || filter === 'skipped' ? item.outcome === filter : true);
  if (failedFirst) visible.sort((left,right) => Number(failed(right.item)) - Number(failed(left.item)) || left.index - right.index);
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const selectedPage = Math.min(pages - 1, Math.max(0, Math.floor(Number(page) || 0)));
  const slice = visible.slice(selectedPage * PAGE_SIZE, (selectedPage + 1) * PAGE_SIZE).map(({item}) => item);
  const byPath = new Map();
  for (const item of slice) {
    const key = String(item.path || '<workspace>');
    if (!byPath.has(key)) byPath.set(key, { path:key, cases:[], total:0, failures:0 });
    byPath.get(key).cases.push(item);
  }
  for (const {item} of visible) {
    const group = byPath.get(String(item.path || '<workspace>'));
    if (group) { group.total++; if (failed(item)) group.failures++; }
  }
  const counts = Object.fromEntries(['collected','passed','failed','skipped','errors'].map(key => [key,boundedCount(result.counts?.[key])]));
  let status = String(result.status || 'error');
  // An incorrectly normalized empty result must never look like a green run.
  if (status === 'passed' && counts.collected === 0 && all.length === 0) status = 'empty';
  if (status === 'passed' && (counts.failed || counts.errors)) status = counts.errors ? 'error' : 'failed';
  return { framework:String(result.framework || '测试'), status, statusLabel:statusLabels[status] || `未完成：${status}`,
    counts, storedCount:all.length, filteredCount:visible.length, page:selectedPage, pages,
    groups:[...byPath.values()], truncated:Boolean(result.truncated), durationMillis:boundedCount(result.durationMillis),
    message:String(result.message || ''), filter };
}

function element(document, tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function renderTestResults(container, result, options = {}) {
  if (!container) return null;
  const document = container.ownerDocument;
  let collapse = collapsedSuites.get(container);
  if (!collapse) { collapse = new Map(); collapsedSuites.set(container,collapse); }
  // Capture the latest user choice before replacing DOM, even if a toggle
  // event was coalesced by the browser and has not been delivered yet.
  for (const suite of container.querySelectorAll('details[data-test-suite]')) collapse.set(suite.dataset.testSuite,!suite.open);
  container.replaceChildren();
  const model = buildTestResultsModel(result,options);
  if (!model) { container.append(element(document,'p','尚未运行测试。','empty-message')); return null; }
  const {counts} = model;
  const title = element(document,'div',`${model.framework} · ${model.statusLabel} · ${model.durationMillis} ms`,'tool-title');
  title.dataset.testStatus = model.status;
  const summary = element(document,'div',`共 ${counts.collected} 个 · ${counts.passed} 通过 / ${counts.failed} 失败 / ${counts.skipped} 跳过 / ${counts.errors} 异常`,'test-totals');
  container.append(title,summary);
  if (model.message) container.append(element(document,'p',model.message,'test-message'));
  if (model.truncated) container.append(element(document,'p',`结果已截断：保存了 ${model.storedCount} 个用例详情，统计仍为全部 ${counts.collected} 个用例。`,'test-message'));
  if (model.filter !== 'all') container.append(element(document,'p',`当前筛选 ${model.filteredCount} 个用例；上方统计为完整测试任务。`,'test-filter-summary'));
  if (!model.filteredCount) {
    container.append(element(document,'p',model.storedCount ? '当前筛选没有匹配用例。' : model.status === 'empty' ? '未发现可运行的测试。' : '本次任务没有可显示的用例详情。','empty-message'));
    return model;
  }
  if (model.pages > 1) {
    const controls = element(document,'div',null,'settings-actions test-pagination');
    const previous = element(document,'button','上一页'); previous.type = 'button'; previous.disabled = model.page === 0;
    const next = element(document,'button','下一页'); next.type = 'button'; next.disabled = model.page + 1 >= model.pages;
    previous.addEventListener('click',()=>options.onPage?.(model.page - 1));
    next.addEventListener('click',()=>options.onPage?.(model.page + 1));
    controls.append(previous,element(document,'span',`${model.page + 1} / ${model.pages} 页 · ${model.filteredCount} 个用例`),next);
    container.append(controls);
  }
  for (const group of model.groups) {
    const suite = element(document,'details',null,'test-suite');
    suite.dataset.testSuite = group.path;
    suite.open = !collapse.get(group.path);
    suite.addEventListener('toggle',()=>collapse.set(group.path,!suite.open));
    const suiteTitle = element(document,'summary',`${group.path} · ${group.total} 个${group.failures ? ` · ${group.failures} 失败/异常` : ''}`);
    suite.append(suiteTitle);
    for (const item of group.cases) {
      const row = element(document,'div',null,'test-case'); row.dataset.testOutcome = item.outcome;
      const open = element(document,'button',null,'result-row'); open.type = 'button';
      open.disabled = !item.path || typeof options.onOpen !== 'function';
      open.append(element(document,'strong',`${outcomeLabels[item.outcome] || '异常'} · ${item.name || item.nodeId || item.id}`),
        element(document,'span',`${item.path || '<workspace>'}${item.line > 0 ? `:${item.line}` : ''} · ${boundedCount(item.durationMillis)} ms`));
      open.addEventListener('click',()=>options.onOpen?.(item));
      const rerun = element(document,'button','重跑'); rerun.type = 'button';
      rerun.setAttribute('aria-label',`重新运行 ${item.name || item.nodeId || '测试'}`);
      rerun.disabled = Boolean(options.busy) || !item.path || !item.nodeId || typeof options.onRerun !== 'function';
      rerun.addEventListener('click',()=>options.onRerun?.(item));
      row.append(open,rerun);
      if (item.message || item.traceback) {
        const details = element(document,'details',null,'test-traceback');
        details.append(element(document,'summary',item.outcome === 'skipped' ? '跳过原因' : failed(item) ? '失败详情 / traceback' : '测试详情'));
        if (item.message) details.append(element(document,'p',String(item.message)));
        if (item.traceback && item.traceback !== item.message) details.append(element(document,'pre',String(item.traceback)));
        row.append(details);
      }
      suite.append(row);
    }
    container.append(suite);
  }
  return model;
}
