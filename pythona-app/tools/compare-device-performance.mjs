import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// All measurements have a lower-is-better interpretation. This tool compares
// recorded device evidence; it never treats desktop timings as device data.
export const METRICS = Object.freeze({
  coldStartMs: { unit: 'ms', label: '应用冷启动' },
  warmStartMs: { unit: 'ms', label: '应用热启动' },
  editorReadyMs: { unit: 'ms', label: '编辑器首次可输入' },
  runtimeReadyMs: { unit: 'ms', label: 'Runtime 首次就绪' },
  languageReadyMs: { unit: 'ms', label: 'Language 首次就绪' },
  dshCatalogMs: { unit: 'ms', label: '首次模型目录' },
  dshFirstTokenMs: { unit: 'ms', label: '首个模型 token' },
  projectIndexMs: { unit: 'ms', label: '500 文件完整索引' },
  testDiscoverMs: { unit: 'ms', label: '工作区测试发现' },
  runStartMs: { unit: 'ms', label: '普通 Run 启动' },
  singleRunMs: { unit: 'ms', label: '单文件运行完成' },
  inputFrameMs: { unit: 'ms', label: '编辑输入到绘制', targetP95Below: 50 },
  runtimeCancelMs: { unit: 'ms', label: '普通 Run 取消', targetP95Below: 1000 },
  testCancelMs: { unit: 'ms', label: '测试取消', targetP95Below: 1000 },
  dshCancelMs: { unit: 'ms', label: 'DSH 取消', targetP95Below: 1000 },
  pssKiB: { unit: 'KiB', label: '应用所有进程 PSS 合计' },
  runtimeRestarts: { unit: 'count', label: 'Runtime 异常重启' },
  languageRestarts: { unit: 'count', label: 'Language 异常重启' },
  dshRestarts: { unit: 'count', label: 'DSH 异常重启' }
});

const REQUIRED_MATCHES = Object.freeze([
  'device.serial', 'device.api', 'device.abi', 'device.webviewVersion',
  'app.variant', 'fixture.sha256', 'fixture.fileCount',
  'procedure.id', 'procedure.sha256', 'procedure.repetitions', 'procedure.warmupRuns',
  'procedure.observationSeconds', 'procedure.orientation', 'procedure.powerMode',
  'procedure.refreshRateHz', 'procedure.charging', 'procedure.networkProfile'
]);
const SHA256 = /^[a-f0-9]{64}$/i;
const GIT = /^[a-f0-9]{7,40}$/i;
const get = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

export function percentile(samples, fraction) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

function validate(record, role) {
  const errors = [];
  const invalid = (path, detail) => errors.push(`${role}.${path}: ${detail}`);
  if (!record || typeof record !== 'object' || Array.isArray(record)) return [`${role}: 必须是 JSON 对象`];
  if (record.schemaVersion !== 1) invalid('schemaVersion', '必须为 1');
  if (record.source !== 'android-device') invalid('source', '必须为 android-device，桌面测量不可替代真机');
  for (const path of ['device.serial', 'device.model', 'device.abi', 'device.webviewVersion',
    'app.version', 'app.variant', 'procedure.id', 'procedure.powerMode', 'procedure.networkProfile']) {
    if (!nonempty(get(record, path))) invalid(path, '缺失或不是非空字符串');
  }
  if (!Number.isSafeInteger(record.device?.api) || record.device.api < 30) invalid('device.api', '必须为 API 30 或更高的整数');
  for (const path of ['app.apkSha256', 'fixture.sha256', 'procedure.sha256']) {
    if (!SHA256.test(String(get(record, path) || ''))) invalid(path, '必须记录实际 SHA-256');
  }
  if (!GIT.test(record.app?.gitRevision || '')) invalid('app.gitRevision', '必须记录构建源 Git revision');
  if (typeof record.app?.dirty !== 'boolean') invalid('app.dirty', '必须明确记录构建源是否有未提交修改');
  if (!/^0\.3(?:\.|$)/.test(record.app?.version || '') && role === 'baseline') invalid('app.version', '基线必须为 0.3');
  if (!/^0\.4(?:\.|$)/.test(record.app?.version || '') && role === 'candidate') invalid('app.version', '候选必须为 0.4');
  if (record.fixture?.fileCount !== 500) invalid('fixture.fileCount', '本验收必须使用相同的 500 文件夹具');
  if (!Number.isSafeInteger(record.procedure?.repetitions) || record.procedure.repetitions < 5) invalid('procedure.repetitions', '至少 5 轮，正式收口建议 20 轮');
  if (!Number.isSafeInteger(record.procedure?.warmupRuns) || record.procedure.warmupRuns < 0) invalid('procedure.warmupRuns', '必须记录非负预热轮数');
  if (!Number.isFinite(record.procedure?.observationSeconds) || record.procedure.observationSeconds < 60) invalid('procedure.observationSeconds', '异常重启观察窗至少为 60 秒');
  if (record.procedure?.orientation !== 'landscape') invalid('procedure.orientation', '平板验收固定为 landscape');
  if (!Number.isFinite(record.procedure?.refreshRateHz) || record.procedure.refreshRateHz <= 0) invalid('procedure.refreshRateHz', '必须记录正数刷新率');
  if (typeof record.procedure?.charging !== 'boolean') invalid('procedure.charging', '必须记录充电状态');
  const validMetrics = {};
  for (const [name, spec] of Object.entries(METRICS)) {
    const metric = record.metrics?.[name];
    const prefix = `metrics.${name}`;
    const before = errors.length;
    if (!metric || typeof metric !== 'object') { invalid(prefix, '缺少实测数据'); continue; }
    if (metric.unit !== spec.unit) invalid(`${prefix}.unit`, `必须为 ${spec.unit}`);
    if (!nonempty(metric.method)) invalid(`${prefix}.method`, '必须记录测量方法和计时边界');
    if (!Array.isArray(metric.samples) || metric.samples.length < Math.max(5, record.procedure?.repetitions || 5)) {
      invalid(`${prefix}.samples`, '样本数量必须覆盖全部重复轮次，且至少 5 个');
    } else if (metric.samples.length > 100_000) invalid(`${prefix}.samples`, '超过 100000 个样本上限');
    else if (metric.samples.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0
      || (spec.unit === 'count' && !Number.isSafeInteger(value)))) invalid(`${prefix}.samples`, '样本必须是有限非负数；计数必须为整数');
    if (spec.unit === 'count' && Array.isArray(metric.samples) && metric.samples.length !== record.procedure?.repetitions)
      invalid(`${prefix}.samples`, '异常重启计数必须每轮一个样本，观察总时长才能一致');
    if (errors.length === before) validMetrics[name] = metric;
  }
  return { errors, validMetrics };
}

function change(baseline, candidate) {
  if (baseline === 0) return { baseline, candidate, regressionPercent: candidate === 0 ? 0 : null, fromZero: candidate > 0, blocked: candidate > 0 };
  const regressionPercent = (candidate - baseline) / baseline * 100;
  // Compare the raw values. The displayed rounded percent must not affect admission.
  return { baseline, candidate, regressionPercent, fromZero: false, blocked: candidate > baseline * 1.2 };
}

export function compareDevicePerformance(baseline, candidate) {
  const checkedBaseline = validate(baseline, 'baseline');
  const checkedCandidate = validate(candidate, 'candidate');
  const errors = [
    ...(Array.isArray(checkedBaseline) ? checkedBaseline : checkedBaseline.errors),
    ...(Array.isArray(checkedCandidate) ? checkedCandidate : checkedCandidate.errors)
  ];
  const mismatches = [];
  for (const path of REQUIRED_MATCHES) {
    const before = get(baseline, path), after = get(candidate, path);
    if (before != null && after != null && before !== after) mismatches.push(`${path}: 基线与候选不一致`);
  }
  errors.push(...mismatches);
  const measurements = [];
  const warnings = [];
  for (const [name, spec] of Object.entries(METRICS)) {
    const before = checkedBaseline.validMetrics?.[name];
    const after = checkedCandidate.validMetrics?.[name];
    if (after && spec.targetP95Below != null) {
      const p95 = percentile(after.samples, .95);
      if (p95 >= spec.targetP95Below) warnings.push({ metric: name, kind: 'absolute-target', p95,
        target: `< ${spec.targetP95Below} ${spec.unit}`, message: `${spec.label}未达到单独的体验目标` });
    }
    if (!before || !after) {
      measurements.push({ name, label: spec.label, unit: spec.unit, comparable: false, reason: '缺少有效样本' });
      continue;
    }
    if (before.method !== after.method) {
      errors.push(`metrics.${name}.method: 测量方法或计时边界不一致`);
      measurements.push({ name, label: spec.label, unit: spec.unit, comparable: false, reason: '测量方法不一致' });
      continue;
    }
    if (mismatches.length || baseline?.source !== 'android-device' || candidate?.source !== 'android-device') {
      measurements.push({ name, label: spec.label, unit: spec.unit, comparable: false, reason: '设备或测量条件不可比' });
      continue;
    }
    measurements.push({ name, label: spec.label, unit: spec.unit, comparable: true,
      baselineCount: before.samples.length, candidateCount: after.samples.length,
      p50: change(percentile(before.samples, .5), percentile(after.samples, .5)),
      p95: change(percentile(before.samples, .95), percentile(after.samples, .95)),
      ...(spec.unit === 'count' ? { total: change(before.samples.reduce((sum, value) => sum + value, 0),
        after.samples.reduce((sum, value) => sum + value, 0)) } : {}) });
  }
  const regressions = measurements.filter(item => item.comparable && (item.p50.blocked || item.p95.blocked || item.total?.blocked)).map(item => item.name);
  if (candidate?.procedure?.repetitions < 20) warnings.push({ kind: 'sample-size', message: '重复少于 20 轮，p95 受单次波动影响较大；正式收口建议至少 20 轮' });
  const status = errors.length ? 'INCOMPLETE' : regressions.length ? 'BLOCKED' : 'PASS';
  return {
    schemaVersion: 1, status, exitCode: status === 'PASS' ? 0 : status === 'BLOCKED' ? 1 : 2,
    scope: '仅比较输入文件中的 Android 同机测量；不代表 API 30、长期压力或真实模型链路验收已经完成',
    regressionThresholdPercent: 20, percentiles: 'nearest-rank',
    errors, warnings, regressions, measurements,
    evidence: {
      baseline: { version: baseline?.app?.version ?? null, apkSha256: baseline?.app?.apkSha256 ?? null, gitRevision: baseline?.app?.gitRevision ?? null },
      candidate: { version: candidate?.app?.version ?? null, apkSha256: candidate?.app?.apkSha256 ?? null, gitRevision: candidate?.app?.gitRevision ?? null },
      deviceSerial: candidate?.device?.serial ?? null, fixtureSha256: candidate?.fixture?.sha256 ?? null
    }
  };
}

function formatChange(item) {
  if (item.fromZero) return `${item.baseline} → ${item.candidate}（从零增加，阻断）`;
  return `${item.baseline} → ${item.candidate}（${item.regressionPercent >= 0 ? '+' : ''}${item.regressionPercent.toFixed(2)}%）${item.blocked ? ' 阻断' : ''}`;
}

export function renderReport(report) {
  const lines = [`PythonA 同机性能门槛：${report.status}`, report.scope,
    '门槛：p50 或 p95 相对 0.3 回归超过 20% 即阻断；缺失或不可比数据不能通过。', ''];
  for (const item of report.measurements) lines.push(item.comparable
    ? `${item.label} [${item.unit}] p50 ${formatChange(item.p50)}；p95 ${formatChange(item.p95)}${item.total ? `；总计 ${formatChange(item.total)}` : ''}；样本 ${item.baselineCount}/${item.candidateCount}`
    : `${item.label}：未完成（${item.reason}）`);
  if (report.errors.length) lines.push('', '待补齐/纠正：', ...report.errors.map(error => `- ${error}`));
  if (report.warnings.length) lines.push('', '独立体验目标/测量提示：', ...report.warnings.map(warning => `- ${warning.message}${warning.target ? `：p95=${warning.p95}，目标 ${warning.target}` : ''}`));
  return lines.join('\n');
}

async function loadEvidence(path) {
  if ((await stat(path)).size > 16 * 1024 * 1024) throw new Error('测量文件超过 16 MiB 上限');
  const content = await readFile(path);
  if (content.length > 16 * 1024 * 1024) throw new Error('测量文件超过 16 MiB 上限');
  return JSON.parse(content.toString('utf8'));
}

export async function main(args = process.argv.slice(2)) {
  if (args.length < 2 || args.length > 4 || (args.length > 2 && (args[2] !== '--json' || !args[3]))) {
    console.error('用法：node tools/compare-device-performance.mjs baseline.json candidate.json [--json report.json]');
    return 2;
  }
  let report;
  try {
    const [baseline, candidate] = await Promise.all([loadEvidence(args[0]), loadEvidence(args[1])]);
    report = compareDevicePerformance(baseline, candidate);
  } catch (error) {
    report = { schemaVersion: 1, status: 'INCOMPLETE', exitCode: 2,
      scope: '无法读取有效的真机测量输入，不得宣称性能门槛通过', errors: [String(error.message)], warnings: [], regressions: [], measurements: [] };
  }
  console.log(renderReport(report));
  if (args[2] === '--json') {
    const target = resolve(args[3]);
    if (target === resolve(args[0]) || target === resolve(args[1])) { console.error('拒绝覆盖原始测量输入'); return 2; }
    try { await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' }); }
    catch (error) { console.error(`报告未写入：${error.message}`); return 2; }
  }
  return report.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
