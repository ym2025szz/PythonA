import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.PYTHONA_PORT || 4173);
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf'
};

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const relative = decoded === '/' ? '/index.html' : decoded;
  const candidate = normalize(join(root, relative));
  return candidate.startsWith(root) ? candidate : null;
}

const server = createServer(async (request, response) => {
  try {
    const filePath = safePath(request.url || '/');
    if (!filePath) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    response.writeHead(200, {
      'Content-Type': mime[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    response.end(await readFile(filePath));
  } catch (error) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log('PythonA dev server: http://127.0.0.1:' + port + '/');
});
