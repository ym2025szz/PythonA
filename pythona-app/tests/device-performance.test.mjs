import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { METRICS, compareDevicePerformance, percentile, renderReport } from '../tools/compare-device-performance.mjs';

// Synthetic unit-test input only. Never ship these values as a device baseline.
function evidence(version = '0.3.0') {
  return { schemaVersion: 1, source: 'android-device',
    device: { serial: 'TEST-DEVICE', model: 'test-only', api: 37, abi: 'arm64-v8a', webviewVersion: '149.test' },
    app: { version, variant: 'debug', gitRevision: 'abcdef0123456789', dirty: false, apkSha256: 'a'.repeat(64) },
    fixture: { sha256: 'b'.repeat(64), fileCount: 500 },
    procedure: { id: 'pythona-device-v1', sha256: 'c'.repeat(64), repetitions: 20, warmupRuns: 3,
      observationSeconds: 60, orientation: 'landscape', powerMode: 'balanced', refreshRateHz: 60,
      charging: false, networkProfile: 'test-only-fixed-provider-and-model' },
    metrics: Object.fromEntries(Object.entries(METRICS).map(([name, spec]) => [name,
      { unit: spec.unit, method: `test-only-${name}-v1`, samples: Array(20).fill(spec.unit === 'count' ? 0 : 100) }])) };
}
const candidate = () => evidence('0.4.0');

test('device gate computes nearest-rank percentiles without mutating samples', () => {
  const samples = [5, 1, 3, 2, 4];
  assert.equal(percentile(samples, .5), 3);
  assert.equal(percentile(samples, .95), 5);
  assert.deepEqual(samples, [5, 1, 3, 2, 4]);
  assert.equal(percentile([], .95), null);
});

test('device gate passes complete comparable data and keeps target warnings separate', () => {
  const report = compareDevicePerformance(evidence(), candidate());
  assert.equal(report.status, 'PASS');
  assert.equal(report.exitCode, 0);
  assert.equal(report.measurements.length, Object.keys(METRICS).length);
  assert.ok(report.warnings.some(item => item.metric === 'inputFrameMs'));
  assert.ok(renderReport(report).includes('p50'));
  assert.ok(renderReport(report).includes('不代表 API 30'));
});

test('device gate admits exactly 20 percent and blocks a greater p95 regression', () => {
  const next = candidate();
  next.metrics.coldStartMs.samples = Array(20).fill(120);
  assert.equal(compareDevicePerformance(evidence(), next).status, 'PASS');
  next.metrics.coldStartMs.samples = [...Array(18).fill(100), 120.001, 130];
  const report = compareDevicePerformance(evidence(), next);
  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.exitCode, 1);
  assert.deepEqual(report.regressions, ['coldStartMs']);
  const change = report.measurements.find(item => item.name === 'coldStartMs');
  assert.equal(change.p50.blocked, false);
  assert.equal(change.p95.blocked, true);
});

test('device gate blocks new restarts from zero without serializing Infinity', () => {
  const next = candidate();
  next.metrics.runtimeRestarts.samples.fill(1);
  const report = compareDevicePerformance(evidence(), next);
  assert.equal(report.status, 'BLOCKED');
  const restart = report.measurements.find(item => item.name === 'runtimeRestarts');
  assert.equal(restart.p95.fromZero, true);
  assert.equal(restart.p95.regressionPercent, null);
  assert.ok(renderReport(report).includes('从零增加'));
  assert.ok(!JSON.stringify(report).includes('Infinity'));
  next.metrics.runtimeRestarts.samples = [...Array(19).fill(0), 1];
  const rare = compareDevicePerformance(evidence(), next);
  assert.equal(rare.status, 'BLOCKED');
  assert.equal(rare.measurements.find(item => item.name === 'runtimeRestarts').total.candidate, 1);
});

test('missing feature baseline stays INCOMPLETE even if other measured metrics regress', () => {
  const previous = evidence(), next = candidate();
  delete previous.metrics.testDiscoverMs;
  next.metrics.coldStartMs.samples.fill(200);
  const report = compareDevicePerformance(previous, next);
  assert.equal(report.status, 'INCOMPLETE');
  assert.equal(report.exitCode, 2);
  assert.ok(report.errors.some(error => error.includes('testDiscoverMs')));
  assert.ok(report.regressions.includes('coldStartMs'));
  assert.equal(report.measurements.find(item => item.name === 'testDiscoverMs').comparable, false);
});

test('device gate refuses another device, API, ABI, WebView, fixture, procedure or variant', () => {
  for (const [path, value] of [
    ['device.serial', 'OTHER'], ['device.api', 30], ['device.abi', 'x86_64'],
    ['device.webviewVersion', '148.test'], ['fixture.sha256', 'd'.repeat(64)],
    ['procedure.sha256', 'e'.repeat(64)], ['procedure.repetitions', 5],
    ['procedure.charging', true], ['app.variant', 'release']
  ]) {
    const next = candidate(), [group, key] = path.split('.');
    next[group][key] = value;
    const report = compareDevicePerformance(evidence(), next);
    assert.equal(report.status, 'INCOMPLETE', path);
    assert.ok(report.errors.some(error => error.includes(path)), path);
    assert.ok(report.measurements.every(metric => metric.comparable === false), path);
  }
});

test('desktop evidence, unsupported schema and absent provenance cannot pass', () => {
  const cases = [null, {}, { ...candidate(), source: 'desktop' }, { ...candidate(), schemaVersion: 99 }];
  for (const next of cases) assert.equal(compareDevicePerformance(evidence(), next).status, 'INCOMPLETE');
  const next = candidate();
  delete next.app.apkSha256;
  delete next.app.gitRevision;
  delete next.app.dirty;
  assert.equal(compareDevicePerformance(evidence(), next).status, 'INCOMPLETE');
});

test('invalid numbers, units, undersampling and different measurement boundaries do not pass', () => {
  for (const value of [-1, NaN, Infinity, '100', true]) {
    const next = candidate();
    next.metrics.coldStartMs.samples[0] = value;
    assert.equal(compareDevicePerformance(evidence(), next).status, 'INCOMPLETE');
  }
  for (const change of [
    metric => { metric.unit = 'seconds'; },
    metric => { metric.samples = [1]; },
    metric => { metric.method = 'different-clock-and-boundary'; }
  ]) {
    const next = candidate();
    change(next.metrics.coldStartMs);
    assert.equal(compareDevicePerformance(evidence(), next).status, 'INCOMPLETE');
  }
  const next = candidate();
  next.metrics.dshRestarts.samples[0] = .5;
  assert.equal(compareDevicePerformance(evidence(), next).status, 'INCOMPLETE');
});

test('absolute input and cancellation targets are strict separate warnings', () => {
  const previous = evidence(), next = candidate();
  for (const value of [previous, next]) {
    value.metrics.inputFrameMs.samples.fill(50);
    value.metrics.runtimeCancelMs.samples.fill(1000);
    value.metrics.testCancelMs.samples.fill(999);
    value.metrics.dshCancelMs.samples.fill(999);
  }
  const report = compareDevicePerformance(previous, next);
  assert.equal(report.status, 'PASS');
  assert.deepEqual(report.warnings.map(item => item.metric).sort(), ['inputFrameMs', 'runtimeCancelMs']);
});

test('CLI writes reviewable JSON, uses nonzero INCOMPLETE and never overwrites evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pythona-device-gate-'));
  const cli = fileURLToPath(new URL('../tools/compare-device-performance.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', windowsHide: true });
  try {
    const baselinePath = join(directory, 'baseline.json'), candidatePath = join(directory, 'candidate.json');
    const reportPath = join(directory, 'report.json');
    const baselineText = JSON.stringify(evidence());
    await writeFile(baselinePath, baselineText);
    await writeFile(candidatePath, JSON.stringify(candidate()));
    assert.equal(run(baselinePath, candidatePath, '--json', reportPath).status, 0);
    assert.equal(JSON.parse(await readFile(reportPath, 'utf8')).status, 'PASS');
    assert.equal(run(baselinePath, candidatePath, '--json', baselinePath).status, 2);
    assert.equal(await readFile(baselinePath, 'utf8'), baselineText);
    const missing = run(join(directory, 'missing.json'), candidatePath);
    assert.equal(missing.status, 2);
    assert.ok(missing.stdout.includes('INCOMPLETE'));
    await writeFile(candidatePath, '{invalid json');
    assert.equal(run(baselinePath, candidatePath).status, 2);
    assert.equal(run(baselinePath, candidatePath, '--unknown', reportPath).status, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
