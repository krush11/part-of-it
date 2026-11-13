// Local stand-in for Vercel: serves public/ and the same /api handlers.
// Usage: npm run dev              (http://localhost:3000, uses the Supabase project)
//        npm run dev -- --local   (same, but an in-memory Postgres instead of Supabase)
// `vercel dev` works too if you have the Vercel CLI.
if (process.argv.includes('--local')) process.env.POI_LOCAL_DB = '1';
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
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};
const api = Object.fromEntries(Object.keys(routes).map((name) => [`/api/${name}`, handler(name)]));

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (api[pathname]) return api[pathname](req, res);
  if (pathname.startsWith('/api/')) return res.writeHead(404).end('Not found');

  let file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC_DIR)) return res.writeHead(403).end();
  // Like Vercel's cleanUrls: /count serves count.html
  if (!path.extname(file) && fs.existsSync(file + '.html')) file += '.html';
  fs.readFile(file, (err, buf) => {
    if (err) return res.writeHead(404).end('Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

store
  .init()
  .then(() =>
    server.listen(PORT, () =>
      console.log(`http://localhost:${PORT} (timezone: ${TIMEZONE}, db: ${process.env.POI_LOCAL_DB ? 'in-memory' : 'Supabase'})`)
    )
  )
  .catch((err) => {
    console.error('Could not reach Supabase:', err.message);
    process.exit(1);
  });
