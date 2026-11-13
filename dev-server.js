// Local stand-in for Vercel: serves public/ and the same /api handlers.
// Usage: npm run dev   (then open http://localhost:3000)
// `vercel dev` works too if you have the Vercel CLI.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { handler, routes, store, TIMEZONE } = require('./lib/app');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const api = Object.fromEntries(Object.keys(routes).map((name) => [`/api/${name}`, handler(name)]));

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (api[pathname]) return api[pathname](req, res);
  if (pathname.startsWith('/api/')) return res.writeHead(404).end('Not found');

  const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC_DIR)) return res.writeHead(403).end();
  fs.readFile(file, (err, buf) => {
    if (err) return res.writeHead(404).end('Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

store
  .init()
  .then(() => server.listen(PORT, () => console.log(`http://localhost:${PORT} (timezone: ${TIMEZONE})`)))
  .catch((err) => {
    console.error('Could not reach Supabase:', err.message);
    process.exit(1);
  });
