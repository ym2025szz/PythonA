// PythonA only owns this one custom provider leaf. Official dsh reads and serves
// the resulting settings through its own settings-file and llm-pi-ai packages.
const fs = require('node:fs');
const { createRequire } = require('node:module');
const yaml = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh-settings-file/package.json')('yaml');
const profile = JSON.parse(fs.readFileSync('/root/.pythona-provider.json', 'utf8'));
const filename = '/root/.dsh/settings.yaml';
fs.mkdirSync('/root/.dsh', { recursive: true });
const document = yaml.parseDocument(fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : '{}');
if (document.errors.length) throw new Error('Invalid existing dsh settings; original retained');
const path = ['llm-pi-ai', 'providers', 'pythona-custom'];
if (Object.keys(profile).length) document.setIn(path, profile);
else if (document.hasIn(path)) document.deleteIn(path);
const next = document.toString();
const previous = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : '';
if (next !== previous) {
  const temporary = filename + '.pythona-tmp';
  fs.writeFileSync(temporary, next, { mode: 0o600 });
  fs.renameSync(temporary, filename);
}
// In-process load keeps ACP's stdin/stdout unchanged and avoids a shell.
require('/root/.pythona-acp-stream.cjs').install();
process.argv = [process.execPath, '/usr/local/bin/dsh', '--profile', 'acp'];
import('/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js').catch(() => {
  process.stderr.write('PythonA dsh bootstrap failed\n');
  process.exitCode = 1;
});
