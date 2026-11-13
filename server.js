// "Part of it" counter: a tiny zero-dependency Node server.
// Students sign in with their email, tap a button each time the professor
// says "part of it", and the class total is the mode of everyone's counts.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { mode } = require('./stats');

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'counts.json');
const TIMEZONE = process.env.TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
// Optional: restrict sign-in to one domain, e.g. "university.edu".
const ALLOWED_DOMAIN = (process.env.ALLOWED_DOMAIN || '').toLowerCase().replace(/^@/, '');
// Set SESSION_SECRET in production so logins survive restarts.
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const PUBLIC_DIR = path.join(__dirname, 'public');
const COOKIE = 'poi_session';

// ---------- storage ----------
// Shape: { days: { "YYYY-MM-DD": { "student@school.edu": 3, ... } } }
let db = { days: {} };
try {
  db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (!db.days) db.days = {};
} catch {
  /* first run */
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  }, 200);
}

function today() {
  // en-CA formats as YYYY-MM-DD
  return new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

function dayCounts(day) {
  if (!db.days[day]) db.days[day] = {};
  return db.days[day];
}

// ---------- sessions (signed cookie holding the email) ----------
function sign(value) {
  const mac = crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
  return `${Buffer.from(value).toString('base64url')}.${mac}`;
}

function unsign(token) {
  if (!token || !token.includes('.')) return null;
  const [b64, mac] = token.split('.');
  let value;
  try {
    value = Buffer.from(b64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const expected = crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? value : null;
}

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function currentUser(req) {
  return unsign(getCookie(req, COOKIE));
}

function setSession(res, email) {
  const maxAge = 60 * 60 * 24 * 180; // ~a semester
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${encodeURIComponent(sign(email))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`
  );
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// ---------- helpers ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sendJSON(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 10_000) {
        reject(new Error('too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('bad json'));
      }
    });
  });
}

function state(email) {
  const day = today();
  const counts = dayCounts(day);
  if (email && !(email in counts)) {
    counts[email] = 0; // joining today's lecture
    save();
  }
  const values = Object.values(counts);
  const history = Object.keys(db.days)
    .filter((d) => d !== day && Object.keys(db.days[d]).length > 0)
    .sort()
    .reverse()
    .slice(0, 30)
    .map((d) => ({
      date: d,
      mode: mode(Object.values(db.days[d])),
      students: Object.keys(db.days[d]).length,
    }));
  return {
    email,
    date: day,
    myCount: email ? counts[email] : 0,
    mode: mode(values),
    students: values.length,
    history,
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  try {
    if (pathname === '/api/state' && req.method === 'GET') {
      return sendJSON(res, 200, state(currentUser(req)));
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email) || email.length > 254) {
        return sendJSON(res, 400, { error: 'Please enter a valid email address.' });
      }
      if (ALLOWED_DOMAIN && !email.endsWith('@' + ALLOWED_DOMAIN)) {
        return sendJSON(res, 403, { error: `Please use your @${ALLOWED_DOMAIN} email.` });
      }
      setSession(res, email);
      return sendJSON(res, 200, state(email));
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      clearSession(res);
      return sendJSON(res, 200, state(null));
    }

    if ((pathname === '/api/increment' || pathname === '/api/decrement') && req.method === 'POST') {
      const email = currentUser(req);
      if (!email) return sendJSON(res, 401, { error: 'Please sign in first.' });
      const counts = dayCounts(today());
      const current = counts[email] || 0;
      counts[email] = pathname === '/api/increment' ? current + 1 : Math.max(0, current - 1);
      save();
      return sendJSON(res, 200, state(email));
    }

    if (pathname.startsWith('/api/')) return sendJSON(res, 404, { error: 'Not found' });
    if (req.method === 'GET') return serveStatic(req, res);
    res.writeHead(405).end();
  } catch (err) {
    sendJSON(res, 400, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Part-of-it counter running on http://localhost:${PORT} (timezone: ${TIMEZONE})`);
});
