// Shared request handling for the Vercel functions in /api (and dev-server.js).
const { createStore, DatabaseError } = require('./db');

// Vercel runs in UTC, so set TIMEZONE to your class's zone (e.g. America/New_York)
// to make the count reset at your midnight.
const TIMEZONE = process.env.TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
// Optional: restrict sign-in to one domain, e.g. "university.edu".
const ALLOWED_DOMAIN = (process.env.ALLOWED_DOMAIN || '').toLowerCase().replace(/^@/, '');
const COOKIE = 'poi_email';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const store = createStore();

function today() {
  // en-CA formats as YYYY-MM-DD
  return new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

// ---------- "session": the cookie just remembers which email you typed ----------
// There's no password, so anyone can sign in as any email anyway; signing the
// cookie wouldn't add protection, and skipping it means no secret to configure.
function currentUser(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) {
      const email = decodeURIComponent(v.join('='));
      return EMAIL_RE.test(email) ? email : null;
    }
  }
  return null;
}

function setSession(req, res, email) {
  const maxAge = 60 * 60 * 24 * 180; // ~a semester
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${encodeURIComponent(email)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
  );
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// ---------- helpers ----------
function sendJSON(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  // Vercel parses JSON bodies for us; the local dev server doesn't.
  if (req.body !== undefined) {
    return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  }
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 10_000) throw new Error('Request too large.');
  }
  return data ? JSON.parse(data) : {};
}

// Every open page polls every few seconds, so cache the class-wide numbers
// briefly (per function instance) and drop the cache when this instance writes.
let statsCache = { at: 0, day: null, rows: null };
async function classStats(day) {
  if (statsCache.day === day && Date.now() - statsCache.at < 2000) return statsCache.rows;
  const rows = await store.dailyModes(day);
  statsCache = { at: Date.now(), day, rows };
  return rows;
}
function invalidateStats() {
  statsCache.at = 0;
}

async function state(email) {
  const day = today();
  const myCount = email ? await store.join(email, day) : 0;
  const rows = await classStats(day);
  const todayRow = rows.find((r) => r.date === day);
  return {
    email,
    date: day,
    myCount,
    mode: todayRow ? todayRow.mode : 0,
    students: todayRow ? todayRow.students : 0,
    history: rows.filter((r) => r.date !== day).slice(0, 30),
  };
}

// ---------- routes ----------
const routes = {
  state: {
    method: 'GET',
    run: async (req) => [200, await state(currentUser(req))],
  },

  login: {
    method: 'POST',
    run: async (req, res) => {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email) || email.length > 254) {
        return [400, { error: 'Please enter a valid email address.' }];
      }
      if (ALLOWED_DOMAIN && !email.endsWith('@' + ALLOWED_DOMAIN)) {
        return [403, { error: `Please use your @${ALLOWED_DOMAIN} email.` }];
      }
      setSession(req, res, email);
      invalidateStats();
      return [200, await state(email)];
    },
  },

  logout: {
    method: 'POST',
    run: async (req, res) => {
      clearSession(res);
      return [200, await state(null)];
    },
  },

  increment: {
    method: 'POST',
    run: async (req) => {
      const email = currentUser(req);
      if (!email) return [401, { error: 'Please sign in first.' }];
      await store.increment(email, today());
      invalidateStats();
      return [200, await state(email)];
    },
  },

  decrement: {
    method: 'POST',
    run: async (req) => {
      const email = currentUser(req);
      if (!email) return [401, { error: 'Please sign in first.' }];
      await store.decrement(email, today());
      invalidateStats();
      return [200, await state(email)];
    },
  },
};

// Returns a (req, res) handler, the shape Vercel expects from files in /api.
function handler(name) {
  const route = routes[name];
  return async (req, res) => {
    if (req.method !== route.method) {
      res.setHeader('Allow', route.method);
      return sendJSON(res, 405, { error: 'Method not allowed' });
    }
    try {
      const [status, body] = await route.run(req, res);
      sendJSON(res, status, body);
    } catch (err) {
      if (err instanceof DatabaseError) {
        console.error(err.message);
        return sendJSON(res, 503, { error: 'Database unavailable, try again in a moment.' });
      }
      if (err instanceof SyntaxError) return sendJSON(res, 400, { error: 'Invalid JSON.' });
      console.error(err);
      sendJSON(res, 500, { error: 'Something went wrong.' });
    }
  };
}

module.exports = { handler, routes, store, TIMEZONE };
