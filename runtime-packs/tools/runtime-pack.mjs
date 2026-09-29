#!/usr/bin/env node

import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

const CONTROL_FILES = new Set(['manifest.json', 'manifest.ed25519']);
const PAYLOAD_ROOTS = new Set(['lib', 'python', 'stubs', 'metadata']);

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (!flag?.startsWith('--') || rest[index + 1] == null) fail(`Invalid argument: ${flag || '(missing)'}`);
    options[flag.slice(2)] = rest[index + 1];
  }
  return { command, options };
}

function requireOption(options, name) {
  const value = options[name];
  if (!value) fail(`Missing --${name}`);
  return resolve(value);
}

function portablePath(root, path) {
  const value = relative(root, path).split(sep).join('/');
  validateEntryPath(value);
  return value;
}

function validateEntryPath(value) {
  if (!value || value.startsWith('/') || value.startsWith('\\') || value.includes('\\')) fail(`Unsafe pack path: ${value}`);
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) fail(`Unsafe pack path: ${value}`);
  if (!CONTROL_FILES.has(value) && !PAYLOAD_ROOTS.has(parts[0])) fail(`Unsupported pack path: ${value}`);
  if (value.length > 240) fail(`Pack path is too long: ${value}`);
}

function kindFor(path) {
  if (path.startsWith('python/') && /\.so(?:\.|$)/i.test(path)) return 'native';
  if (path.startsWith('lib/')) return 'native';
  if (path.startsWith('python/')) return 'python';
  if (path.startsWith('stubs/')) return 'stub';
  return 'metadata';
}

async function payloadFiles(root) {
  const result = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) fail(`Links are not allowed in a runtime pack: ${path}`);
      if (stat.isDirectory()) await visit(path);
      else if (stat.isFile()) result.push(path);
      else fail(`Unsupported filesystem entry: ${path}`);
    }
  }
  await visit(root);
  return result;
}

async function digestFile(path) {
  const bytes = await readFile(path);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.byteLength
  };
}

function canonicalManifest(manifest) {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function jarExecutable() {
  const executable = process.platform === 'win32' ? 'jar.exe' : 'jar';
  return process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', executable) : executable;
}

function runJar(arguments_, options = {}) {
  const result = spawnSync(jarExecutable(), arguments_, { encoding: 'utf8', ...options });
  if (result.error) fail(`Unable to start jar: ${result.error.message}`);
  if (result.status !== 0) fail(`jar failed (${result.status}): ${result.stderr || result.stdout}`);
  return result.stdout;
}

function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 1) fail('Unsupported runtime pack schemaVersion');
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(manifest.packId || '')) fail('Invalid packId');
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version || '')) fail('Invalid version');
  if (!/^[A-Za-z0-9._-]{1,96}$/.test(manifest.buildId || '')) fail('Invalid buildId');
  if (manifest.buildId.startsWith('.') || [
    'active.json', 'active.previous.json', 'activation.pending.json', 'activation.failed.json'
  ].includes(manifest.buildId)) fail('Reserved buildId');
  if (!/^cp\d{2,3}$/.test(manifest.pythonAbi || '')) fail('Invalid pythonAbi');
  if (manifest.abi !== 'arm64-v8a') fail('Only arm64-v8a runtime packs are accepted');
  if (!Number.isInteger(manifest.minApi) || manifest.minApi < 30) fail('minApi must be at least 30');
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail('Runtime pack has no payload files');
  if (!Array.isArray(manifest.licenses) || manifest.licenses.length === 0) fail('Runtime pack must declare licenses');
  if (!Array.isArray(manifest.dependencies)) fail('Runtime pack dependencies must be an array');
  if (new Set(manifest.dependencies).size !== manifest.dependencies.length) fail('Runtime pack dependencies must be unique');
  for (const dependency of manifest.dependencies) {
    if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(dependency)) {
      fail(`Invalid exact runtime pack dependency: ${dependency}`);
    }
  }
  if (manifest.capabilities?.cuda !== false || manifest.capabilities?.multiprocessing !== false) {
    fail('v1 runtime packs must explicitly disable CUDA and multiprocessing');
  }
}

async function keygen(options) {
  const privatePath = requireOption(options, 'private');
  const publicPath = requireOption(options, 'public');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  await mkdir(dirname(privatePath), { recursive: true });
  await mkdir(dirname(publicPath), { recursive: true });
  await writeFile(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
  await writeFile(publicPath, publicKey.export({ type: 'spki', format: 'pem' }), { flag: 'wx', mode: 0o644 });
  const subjectPublicKeyInfo = publicKey.export({ type: 'spki', format: 'der' });
  const rawPublicKey = subjectPublicKeyInfo.subarray(subjectPublicKeyInfo.byteLength - 32).toString('base64');
  process.stdout.write(
    `created ${privatePath}\ncreated ${publicPath}\n`
    + `Android Gradle property: -PPYTHONA_RUNTIME_PACK_PUBLIC_KEY_RAW_BASE64=${rawPublicKey}\n`
  );
}

async function build(options) {
  const payload = requireOption(options, 'payload');
  const templatePath = requireOption(options, 'template');
  const privatePath = requireOption(options, 'private');
  const output = requireOption(options, 'out');
  const template = JSON.parse(await readFile(templatePath, 'utf8'));
  const sourceFiles = await payloadFiles(payload);
  const entries = [];
  let unpackedBytes = 0;
  for (const source of sourceFiles) {
    const path = portablePath(payload, source);
    if (CONTROL_FILES.has(path)) fail(`${path} is reserved`);
    const digest = await digestFile(source);
    unpackedBytes += digest.size;
    entries.push({ path, ...digest, kind: kindFor(path) });
  }
  const manifest = {
    ...template,
    maxUnpackedBytes: template.maxUnpackedBytes || unpackedBytes,
    files: entries
  };
  validateManifest(manifest);
  if (manifest.maxUnpackedBytes < unpackedBytes) fail('maxUnpackedBytes is smaller than the payload');

  const staging = await mkdtemp(join(tmpdir(), 'pythona-pack-'));
  try {
    for (const source of sourceFiles) {
      const path = portablePath(payload, source);
      const target = join(staging, ...path.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    }
    const manifestBytes = canonicalManifest(manifest);
    const privateKey = await readFile(privatePath);
    const signature = sign(null, manifestBytes, privateKey);
    await writeFile(join(staging, 'manifest.json'), manifestBytes);
    await writeFile(join(staging, 'manifest.ed25519'), signature);
    await mkdir(dirname(output), { recursive: true });
    await rm(output, { force: true });
    runJar(['--create', '--file', output, '--no-manifest', '-C', staging, '.']);
    const packDigest = await digestFile(output);
    process.stdout.write(`${output}\nsha256 ${packDigest.sha256}\nsize ${packDigest.size}\n`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function verifyPack(options) {
  const pack = requireOption(options, 'pack');
  const publicPath = requireOption(options, 'public');
  const rawEntries = runJar(['--list', '--file', pack]).split(/\r?\n/).filter(Boolean);
  const files = rawEntries.filter((entry) => !entry.endsWith('/')).map((entry) => entry.replace(/^\.\//, ''));
  const unique = new Set();
  for (const entry of files) {
    validateEntryPath(entry);
    if (unique.has(entry)) fail(`Duplicate ZIP entry: ${entry}`);
    unique.add(entry);
  }
  for (const control of CONTROL_FILES) if (!unique.has(control)) fail(`Missing ${control}`);

  const staging = await mkdtemp(join(tmpdir(), 'pythona-pack-verify-'));
  try {
    runJar(['--extract', '--file', pack], { cwd: staging });
    const manifestBytes = await readFile(join(staging, 'manifest.json'));
    const signature = await readFile(join(staging, 'manifest.ed25519'));
    const publicKey = await readFile(publicPath);
    if (!verify(null, manifestBytes, publicKey, signature)) fail('Runtime pack signature is invalid');
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    validateManifest(manifest);
    const declared = new Set(manifest.files.map((entry) => entry.path));
    for (const entry of manifest.files) {
      validateEntryPath(entry.path);
      if (!unique.has(entry.path)) fail(`Missing payload: ${entry.path}`);
      const digest = await digestFile(join(staging, ...entry.path.split('/')));
      if (digest.size !== entry.size || digest.sha256 !== entry.sha256) fail(`Payload digest mismatch: ${entry.path}`);
    }
    for (const entry of files) {
      if (!CONTROL_FILES.has(entry) && !declared.has(entry)) fail(`Undeclared payload: ${entry}`);
    }
    process.stdout.write(`verified ${basename(pack)} (${manifest.packId}@${manifest.version}, ${manifest.buildId})\n`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

const { command, options } = parseArguments(process.argv.slice(2));
try {
  if (command === 'keygen') await keygen(options);
  else if (command === 'build') await build(options);
  else if (command === 'verify') await verifyPack(options);
  else fail('Usage: runtime-pack.mjs keygen|build|verify [options]');
} catch (error) {
  process.stderr.write(`runtime-pack: ${error.message}\n`);
  process.exitCode = 1;
}
