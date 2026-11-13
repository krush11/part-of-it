// Shared request handling for the Vercel functions in /api (and dev-server.js).
const crypto = require('node:crypto');
const { createStore, DatabaseError } = require('./db');
const consensus = require('./consensus');

// The class's time zone: each day's count starts at midnight here.
const TIMEZONE = 'Asia/Kolkata';
// Who may sign in: XLRI roll emails like b26032 / bi26002 / bl26012 @astra.xlri.ac.in
const DOMAIN = 'astra.xlri.ac.in';
const ROLL_RE = /^b[il]?260(0[1-9]|[1-5][0-9]|60)$/;
const EMAIL_RE = /^b[il]?260(0[1-9]|[1-5][0-9]|60)@astra\.xlri\.ac\.in$/;

const EMAIL_COOKIE = 'poi_email';
const DEVICE_COOKIE = 'poi_device';
// A tap may be back-dated by at most this much (network / cold-start delay).
const MAX_TAP_AGE_MS = 5000;
const HISTORY_DAYS = 14;
// Target bids: how many times he'll say it today. 0, 10, 20 … 150.
const BID_MAX = 150;
const BID_STEP = 10;

const store = createStore();

function today() {
  // en-CA formats as YYYY-MM-DD
  return new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

// ---------- cookies ----------
// The email cookie just remembers which roll number you typed. There's no
// password, so anyone can sign in as any roll anyway; signing the cookie
// wouldn't add protection. The device cookie is a random id per browser, used
// to count *distinct devices* in the consensus algorithm (so ten tabs on one
// phone can't fake a crowd).
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}

function addCookie(res, name, value, maxAge, req) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  const line = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, line) : line);
}

function currentUser(req) {
  const email = cookies(req)[EMAIL_COOKIE];
  return email && EMAIL_RE.test(email) ? email : null;
}

function setSession(req, res, email) {
  addCookie(res, EMAIL_COOKIE, email, 60 * 60 * 24 * 180, req); // ~a semester
}

function clearSession(req, res) {
  addCookie(res, EMAIL_COOKIE, '', 0, req);
}

function currentDevice(req, res) {
  let id = cookies(req)[DEVICE_COOKIE];
  if (!id || !/^[0-9a-f]{32}$/.test(id)) {
    id = crypto.randomBytes(16).toString('hex');
    addCookie(res, DEVICE_COOKIE, id, 60 * 60 * 24 * 400, req);
  }
  return crypto.createHash('sha256').update(id).digest('hex');
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

// ---------- caches (per function instance) ----------
// Every open page polls every few seconds, so today's taps are cached briefly
// and dropped whenever this instance records a tap. Finished days never
// change, so their scores are kept for the life of the instance.
const CACHE_MS = 2000;
let tapsCache = { day: null, at: 0, taps: null };
let bidsCache = { day: null, at: 0, bids: null };
const myIdCache = new Map(); // `${email}|${day}` -> { at, id }
const myBidCache = new Map(); // `${email}|${day}` -> { at, bid }
const dayMemo = new Map(); // 'YYYY-MM-DD' -> { date, count, events, students }
let historyCache = { day: null, at: 0, rows: null };

async function todaysTaps(day) {
  if (tapsCache.day === day && Date.now() - tapsCache.at < CACHE_MS) return tapsCache.taps;
  const taps = await store.tapsForDay(day);
  tapsCache = { day, at: Date.now(), taps };
  return taps;
}

async function myIdFor(email, day) {
  const key = `${email}|${day}`;
  const hit = myIdCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.id;
  const id = await store.myId(email, day);
  myIdCache.set(key, { at: Date.now(), id });
  return id;
}

async function todaysBids(day) {
  if (bidsCache.day === day && Date.now() - bidsCache.at < CACHE_MS) return bidsCache.bids;
  const bids = await store.bidsForDay(day);
  bidsCache = { day, at: Date.now(), bids };
  return bids;
}

async function myBidFor(email, day) {
  const key = `${email}|${day}`;
  const hit = myBidCache.get(key);
  // A bid never changes once placed, so a known bid is cached for good.
  if (hit && (hit.bid !== null || Date.now() - hit.at < CACHE_MS)) return hit.bid;
  const bid = await store.myBid(email, day);
  myBidCache.set(key, { at: Date.now(), bid });
  return bid;
}

function invalidate(email, day) {
  tapsCache.at = 0;
  bidsCache.at = 0;
  myIdCache.delete(`${email}|${day}`);
  myBidCache.delete(`${email}|${day}`);
}

async function scoreDay(date) {
  if (dayMemo.has(date)) return dayMemo.get(date);
  const taps = await store.tapsForDay(date);
  // Score as of the far future: nothing is pending on a finished day.
  const r = consensus.score(taps, Number.MAX_SAFE_INTEGER);
  const row = { date, count: r.count, events: r.events, students: r.students };
  dayMemo.set(date, row);
  return row;
}

async function historyFor(day) {
  if (historyCache.day === day && Date.now() - historyCache.at < 60_000) return historyCache.rows;
  const [tapDays, legacy] = await Promise.all([
    store.tapDays(day, HISTORY_DAYS),
    // Days from before the tap-based counter existed.
    store.dailyModes(day, 31).catch((err) => {
      console.error(err.message);
      return [];
    }),
  ]);
  const rows = await Promise.all(tapDays.map(scoreDay));
  const seen = new Set(rows.map((r) => r.date));
  for (const l of legacy) {
    if (l.date !== day && !seen.has(l.date)) rows.push({ date: l.date, count: l.mode, students: l.students, legacy: true });
  }
  rows.sort((a, b) => (a.date < b.date ? 1 : -1));
  historyCache = { day, at: Date.now(), rows: rows.slice(0, HISTORY_DAYS) };
  return historyCache.rows;
}

async function state(email, extra = {}) {
  const day = today();
  const [taps, myId, history, bids, myBid] = await Promise.all([
    todaysTaps(day),
    email ? myIdFor(email, day) : null,
    historyFor(day),
    todaysBids(day),
    email ? myBidFor(email, day) : null,
  ]);
  const r = consensus.score(taps, Date.now(), { myId });
  return {
    email,
    roll: email ? email.split('@')[0] : null,
    date: day,
    tz: TIMEZONE,
    count: r.count,
    events: r.events,
    students: r.students,
    devices: r.devices,
    pending: r.pending,
    feed: r.feed,
    me: r.me,
    bids,
    myBid,
    bidOptions: { max: BID_MAX, step: BID_STEP },
    history,
    ...extra,
  };
}

// ---------- routes ----------
const routes = {
  state: {
    method: 'GET',
    run: async (req, res) => {
      currentDevice(req, res); // hand out a device cookie on first visit
      return [200, await state(currentUser(req))];
    },
  },

  login: {
    method: 'POST',
    run: async (req, res) => {
      const body = await readBody(req);
      let roll = String(body.roll || body.email || '').trim().toLowerCase();
      if (roll.endsWith('@' + DOMAIN)) roll = roll.slice(0, -(DOMAIN.length + 1));
      if (!ROLL_RE.test(roll)) {
        return [400, { error: "That's not a roll number, that's a cry for help 😭" }];
      }
      const email = `${roll}@${DOMAIN}`;
      setSession(req, res, email);
      currentDevice(req, res);
      return [200, await state(email)];
    },
  },

  logout: {
    method: 'POST',
    run: async (req, res) => {
      clearSession(req, res);
      return [200, await state(null)];
    },
  },

  // "He said it!" — a vote that the prof just said it.
  tap: {
    method: 'POST',
    run: async (req, res) => {
      const email = currentUser(req);
      if (!email) return [401, { error: 'Sign in first 🙏' }];
      const body = await readBody(req);
      const age = Math.min(MAX_TAP_AGE_MS, Math.max(0, Number(body.ageMs) || 0));
      const at = new Date(Date.now() - age).toISOString();
      const day = today();
      const stored = await store.tap(email, day, currentDevice(req, res), at);
      invalidate(email, day);
      return [200, await state(email, { stored })];
    },
  },

  // "Call your shot" — predict today's final count. One bid, no take-backs.
  bid: {
    method: 'POST',
    run: async (req) => {
      const email = currentUser(req);
      if (!email) return [401, { error: 'Sign in first 🙏' }];
      const body = await readBody(req);
      const bid = Number(body.bid);
      if (!Number.isInteger(bid) || bid < 0 || bid > BID_MAX || bid % BID_STEP !== 0) {
        return [400, { error: `Pick a number from 0 to ${BID_MAX}, in steps of ${BID_STEP}.` }];
      }
      const day = today();
      const stored = await store.bid(email, day, bid);
      invalidate(email, day);
      return [200, await state(email, { locked: stored !== bid })];
    },
  },

  // "oops" — take back my last tap (only within 15 s).
  untap: {
    method: 'POST',
    run: async (req) => {
      const email = currentUser(req);
      if (!email) return [401, { error: 'Sign in first 🙏' }];
      const day = today();
      const removed = await store.untap(email, day);
      invalidate(email, day);
      return [200, await state(email, { removed })];
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
        return sendJSON(res, 503, { error: 'Database is having a moment, try again 🫠' });
      }
      if (err instanceof SyntaxError) return sendJSON(res, 400, { error: 'Invalid JSON.' });
      console.error(err);
      sendJSON(res, 500, { error: 'Something went wrong.' });
    }
  };
}

module.exports = { handler, routes, store, TIMEZONE, ROLL_RE, EMAIL_RE };
