import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packRoot = resolve(here, '..');
const tool = join(packRoot, 'tools', 'runtime-pack.mjs');
const template = join(packRoot, 'manifest.template.json');

function run(arguments_, options = {}) {
  return spawnSync(process.execPath, [tool, ...arguments_], {
    encoding: 'utf8',
    env: process.env,
    ...options
  });
}

function runJar(arguments_, options = {}) {
  const executable = process.platform === 'win32' ? 'jar.exe' : 'jar';
  const command = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', executable) : executable;
  return spawnSync(command, arguments_, { encoding: 'utf8', ...options });
}

async function createPackFixture(context, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  context.after(() => rm(root, { recursive: true, force: true }));
  const license = join(root, 'payload', 'metadata', 'licenses', 'NOTICE.txt');
  await mkdir(dirname(license), { recursive: true });
  await writeFile(license, 'test notice\n', 'utf8');
  const privateKey = join(root, 'test-private.pem');
  const publicKey = join(root, 'test-public.pem');
  const pack = join(root, 'test.pya-pack');
  assert.equal(run(['keygen', '--private', privateKey, '--public', publicKey]).status, 0);
  const built = run([
    'build', '--template', template,
    '--payload', join(root, 'payload'),
    '--private', privateKey,
    '--out', pack
  ]);
  assert.equal(built.status, 0, built.stderr);
  return { root, pack, publicKey, license };
}

test('runtime pack helper signs and verifies a declared payload', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pythona-pack-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const license = join(root, 'payload', 'metadata', 'licenses', 'NOTICE.txt');
  await mkdir(dirname(license), { recursive: true });
  await writeFile(license, 'test notice\n', 'utf8');

  const privateKey = join(root, 'test-private.pem');
  const publicKey = join(root, 'test-public.pem');
  const pack = join(root, 'test.pya-pack');
  const generated = run(['keygen', '--private', privateKey, '--public', publicKey]);
  assert.equal(generated.status, 0, generated.stderr);
  assert.match(
    generated.stdout,
    /-PPYTHONA_RUNTIME_PACK_PUBLIC_KEY_RAW_BASE64=[A-Za-z0-9+/]{43}=/
  );
  const built = run([
    'build', '--template', template,
    '--payload', join(root, 'payload'),
    '--private', privateKey,
    '--out', pack
  ]);
  assert.equal(built.status, 0, built.stderr);
  const header = await readFile(pack);
  assert.equal(header.subarray(0, 2).toString('ascii'), 'PK');
  const verified = run(['verify', '--pack', pack, '--public', publicKey]);
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /verified test\.pya-pack/);
});

test('runtime pack helper refuses a manifest with unsupported capability claims', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pythona-pack-invalid-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const payload = join(root, 'payload', 'metadata', 'licenses');
  await mkdir(payload, { recursive: true });
  await writeFile(join(payload, 'NOTICE.txt'), 'test notice\n', 'utf8');
  const invalidTemplate = JSON.parse(await readFile(template, 'utf8'));
  invalidTemplate.capabilities.cuda = true;
  const invalidPath = join(root, 'invalid.json');
  await writeFile(invalidPath, JSON.stringify(invalidTemplate), 'utf8');
  const privateKey = join(root, 'test-private.pem');
  const publicKey = join(root, 'test-public.pem');
  assert.equal(run(['keygen', '--private', privateKey, '--public', publicKey]).status, 0);
  const built = run([
    'build', '--template', invalidPath,
    '--payload', join(root, 'payload'),
    '--private', privateKey,
    '--out', join(root, 'invalid.pya-pack')
  ]);
  assert.notEqual(built.status, 0);
  assert.match(built.stderr, /disable CUDA/);
});

test('runtime pack verification rejects a replaced Ed25519 signature', async (context) => {
  const { root, pack, publicKey } = await createPackFixture(context, 'pythona-pack-signature-');
  const replacement = join(root, 'manifest.ed25519');
  await writeFile(replacement, Buffer.alloc(64, 0xa5));
  const updated = runJar(['--update', '--file', pack, '-C', root, 'manifest.ed25519']);
  assert.equal(updated.status, 0, updated.stderr);

  const verified = run(['verify', '--pack', pack, '--public', publicKey]);
  assert.notEqual(verified.status, 0);
  assert.match(verified.stderr, /signature is invalid/);
});

test('runtime pack verification rejects payload hash tampering', async (context) => {
  const { root, pack, publicKey } = await createPackFixture(context, 'pythona-pack-hash-');
  const replacementRoot = join(root, 'replacement');
  const replacement = join(replacementRoot, 'metadata', 'licenses', 'NOTICE.txt');
  await mkdir(dirname(replacement), { recursive: true });
  await writeFile(replacement, 'tampered notice\n', 'utf8');
  const updated = runJar([
    '--update', '--file', pack,
    '-C', replacementRoot, 'metadata/licenses/NOTICE.txt'
  ]);
  assert.equal(updated.status, 0, updated.stderr);

  const verified = run(['verify', '--pack', pack, '--public', publicKey]);
  assert.notEqual(verified.status, 0);
  assert.match(verified.stderr, /Payload digest mismatch/);
});

test('runtime pack verification rejects undeclared archive entries', async (context) => {
  const { root, pack, publicKey } = await createPackFixture(context, 'pythona-pack-extra-');
  const replacementRoot = join(root, 'extra');
  const extra = join(replacementRoot, 'metadata', 'undeclared.txt');
  await mkdir(dirname(extra), { recursive: true });
  await writeFile(extra, 'not declared\n', 'utf8');
  const updated = runJar([
    '--update', '--file', pack,
    '-C', replacementRoot, 'metadata/undeclared.txt'
  ]);
  assert.equal(updated.status, 0, updated.stderr);

  const verified = run(['verify', '--pack', pack, '--public', publicKey]);
  assert.notEqual(verified.status, 0);
  assert.match(verified.stderr, /Undeclared payload/);
});
