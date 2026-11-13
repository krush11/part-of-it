const $ = (id) => document.getElementById(id);

// Roll numbers: b26032, bi26002, bl26012 … (01–60)
const ROLL_RE = /^b[il]?260(0[1-9]|[1-5][0-9]|60)$/;
// Could this still become a valid roll number with more typing?
const ROLL_PREFIX_RE = /^b(?:[il](?:2(?:6(?:0(?:[0-6]\d?)?)?)?)?|2(?:6(?:0(?:[0-6]\d?)?)?)?)?$/;

const POLL_MS = 3000;
const UNDO_WINDOW_MS = 15000;

let last = null; // last state we rendered
let timer = null;

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

// ---------- rendering ----------
function fmtDate(iso) {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
}

function fmtTime(ms, tz) {
  return new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: tz });
}

function pop(el) {
  el.classList.remove('pop');
  void el.offsetWidth; // restart the animation
  el.classList.add('pop');
}

function earsTitle(me, events) {
  if (!me || me.taps === 0) return ['👂 Fresh Ears', 'Tap when he says it. Be part of it.'];
  const acc = me.accuracy ?? 0;
  if (me.taps >= 5 && acc >= 0.9) return ['🦇 Bat Ears', 'You hear it before he finishes the sentence.'];
  if (me.taps >= 5 && acc < 0.4) return ['🔫 Trigger Happy', 'Most of your taps were just vibes. Nobody else heard those.'];
  if (events >= 5 && me.events < 0.3 * events) return ['😴 Back Bencher', `The class caught ${events}. You caught ${me.events}. Respect.`];
  if (me.taps >= 3 && acc >= 0.7) return ['🎧 Solid Listener', 'Reliable. Dependable. Part of it.'];
  return ['🙂 Part of It', 'Keep tapping. The algorithm believes in you.'];
}

function render(s) {
  const prev = last;
  last = s;

  $('date').textContent = fmtDate(s.date);
  $('count').textContent = s.count;
  if (prev && s.count > prev.count) {
    pop($('count'));
    if (navigator.vibrate) navigator.vibrate([30, 40, 30]);
  }
  $('students').textContent = s.students;
  $('events').textContent = s.events;

  const p = s.pending;
  const pendingEl = $('pending');
  if (p && p.confirmed) {
    pendingEl.textContent = `✅ confirmed! ${p.devices} ears agree · +${p.utterances}`;
    pendingEl.className = 'pending ok';
    pendingEl.hidden = false;
  } else if (p && p.devices > 0) {
    pendingEl.textContent = `🔥 ${p.devices}/${p.quorum} heard it… confirming`;
    pendingEl.className = 'pending';
    pendingEl.hidden = false;
  } else {
    pendingEl.hidden = true;
  }

  const signedIn = Boolean(s.roll);
  $('login-view').hidden = signedIn;
  $('counter-view').hidden = !signedIn;
  if (signedIn) {
    $('who').textContent = s.roll;
    const me = s.me || { taps: 0, hits: 0, events: 0, accuracy: null };
    $('my-taps').textContent = me.taps;
    $('my-hits').textContent = me.hits;
    $('my-acc').textContent = me.accuracy === null ? '–' : `${Math.round(me.accuracy * 100)}%`;
    const [title, hint] = earsTitle(me, s.events);
    $('title').textContent = title;
    $('ears-hint').textContent = hint;
  } else {
    setTimeout(() => $('roll').focus(), 50);
  }

  // Live feed
  $('feed-view').hidden = s.feed.length === 0;
  const feed = $('feed');
  feed.innerHTML = '';
  s.feed.forEach((e, i) => {
    const li = document.createElement('li');
    const t = document.createElement('time');
    t.textContent = fmtTime(e.t, s.tz);
    const who = document.createElement('span');
    who.textContent = `${e.devices} ears heard it`;
    const plus = document.createElement('strong');
    plus.textContent = `+${e.utterances}`;
    li.append(t, who, plus);
    if (i === 0 && prev && prev.feed[0] && prev.feed[0].t !== e.t) li.className = 'new';
    feed.appendChild(li);
  });

  // History
  $('history-view').hidden = s.history.length === 0;
  const hist = $('history');
  hist.innerHTML = '';
  for (const h of s.history) {
    const tr = document.createElement('tr');
    for (const v of [fmtDate(h.date), h.count, h.students]) {
      const td = document.createElement('td');
      td.textContent = v;
      tr.appendChild(td);
    }
    hist.appendChild(tr);
  }
}

async function refresh() {
  try {
    render(await api('/api/state'));
  } catch {
    /* keep the last view */
  }
}

function schedule() {
  clearTimeout(timer);
  if (!document.hidden) timer = setTimeout(async () => { await refresh(); schedule(); }, POLL_MS);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); } schedule(); });

// ---------- sign-in: one field, no button ----------
const roll = $('roll');
let signingIn = false;

roll.addEventListener('input', async () => {
  let v = roll.value.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!v.startsWith('b')) v = 'b' + v.replace(/^b*/, '');
  if (v !== roll.value) roll.value = v;
  $('login-error').textContent = '';

  const status = $('roll-status');
  if (ROLL_RE.test(v)) {
    status.textContent = '✅';
    if (signingIn) return;
    signingIn = true;
    try {
      render(await api('/api/login', { method: 'POST', body: JSON.stringify({ roll: v }) }));
    } catch (err) {
      $('login-error').textContent = err.message;
      status.textContent = '😬';
    } finally {
      signingIn = false;
    }
  } else if (!ROLL_PREFIX_RE.test(v) || v.length >= 7) {
    status.textContent = '😏';
    $('login-error').textContent = 'nice try. roll numbers go b26001 … b26060 (or bi/bl).';
    roll.classList.remove('shake');
    void roll.offsetWidth;
    roll.classList.add('shake');
  } else {
    status.textContent = '🤔';
  }
});

$('logout').addEventListener('click', async () => {
  try {
    render(await api('/api/logout', { method: 'POST' }));
    roll.value = 'b';
    $('roll-status').textContent = '🤔';
    roll.focus();
  } catch {
    refresh();
  }
});

// ---------- tapping ----------
const tapBtn = $('tap');
let undoTimer = null;

async function sendTap(tappedAt, attempt = 0) {
  try {
    return await api('/api/tap', { method: 'POST', body: JSON.stringify({ ageMs: Date.now() - tappedAt }) });
  } catch (err) {
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 400));
      return sendTap(tappedAt, attempt + 1);
    }
    throw err;
  }
}

tapBtn.addEventListener('click', async () => {
  const tappedAt = Date.now();
  if (navigator.vibrate) navigator.vibrate(15);
  tapBtn.disabled = true;
  tapBtn.classList.add('hit');
  $('tap-sub').textContent = 'heard you 👂';
  setTimeout(() => { tapBtn.disabled = false; tapBtn.classList.remove('hit'); }, 350);

  // Undo link for a bit.
  $('untap').hidden = false;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => { $('untap').hidden = true; }, UNDO_WINDOW_MS);

  try {
    const s = await sendTap(tappedAt);
    render(s);
    $('tap-sub').textContent = s.stored ? 'tap the moment you hear it' : 'easy there, one tap per "part of it" 😅';
  } catch {
    $('tap-sub').textContent = 'network hiccup, tap again 🫠';
    refresh();
  }
});

$('untap').addEventListener('click', async () => {
  $('untap').hidden = true;
  try {
    render(await api('/api/untap', { method: 'POST' }));
    $('tap-sub').textContent = 'undone. we never speak of it again.';
  } catch {
    refresh();
  }
});

refresh().then(schedule);
