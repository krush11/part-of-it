const test = require('node:test');
const assert = require('node:assert');
const { score, quorumFor, DEFAULTS } = require('./consensus');

// Deterministic RNG so the scenarios are reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const T0 = Date.UTC(2026, 10, 13, 4, 30); // a lecture morning
const sec = (s) => s * 1000;

// Honest students: each hears the utterance and taps 0.5–4 s later, with a
// given probability of actually bothering to tap.
function honestTaps({ students, utterances, participation = 1, random, jitter = [500, 4000] }) {
  const taps = [];
  for (const at of utterances) {
    for (let s = 1; s <= students; s++) {
      if (random() > participation) continue;
      const delay = jitter[0] + random() * (jitter[1] - jitter[0]);
      taps.push({ student: s, device: s, t: at + delay });
    }
  }
  return taps;
}

// Lecture: an utterance roughly every 30–90 s.
function lecture(n, random, start = T0) {
  const out = [];
  let t = start;
  for (let i = 0; i < n; i++) {
    t += sec(30 + random() * 60);
    out.push(t);
  }
  return out;
}

test('quorum scales with listeners and is clamped', () => {
  assert.strictEqual(quorumFor(0, DEFAULTS), 3);
  assert.strictEqual(quorumFor(5, DEFAULTS), 3);
  assert.strictEqual(quorumFor(20, DEFAULTS), 4);
  assert.strictEqual(quorumFor(40, DEFAULTS), 6);
  assert.strictEqual(quorumFor(60, DEFAULTS), 6);
});

test('40 honest students with realistic jitter → exact count', () => {
  const random = rng(1);
  const utterances = lecture(30, random);
  const taps = honestTaps({ students: 40, utterances, participation: 0.7, random });
  const r = score(taps, utterances[utterances.length - 1] + sec(60));
  assert.strictEqual(r.count, 30);
  assert.strictEqual(r.events, 30);
  assert.strictEqual(r.pending, null);
});

test('only 5 students in the room → still exact', () => {
  const random = rng(2);
  const utterances = lecture(20, random);
  const taps = honestTaps({ students: 5, utterances, random });
  const r = score(taps, utterances[utterances.length - 1] + sec(60));
  assert.strictEqual(r.count, 20);
});

test('one person alone can never move the count', () => {
  const taps = [];
  for (let i = 0; i < 70; i++) taps.push({ student: 1, device: 1, t: T0 + sec(i * 5) });
  const r = score(taps, T0 + sec(1000));
  assert.strictEqual(r.count, 0);
});

test('one device signed in as 10 roll numbers → +0 (sybil)', () => {
  const taps = [];
  for (let i = 0; i < 20; i++) {
    for (let s = 1; s <= 10; s++) taps.push({ student: 100 + s, device: 1, t: T0 + sec(i * 30) + s * 200 });
  }
  const r = score(taps, T0 + sec(2000));
  assert.strictEqual(r.count, 0);
});

test('a spammer tapping every second does not glue or split real clusters', () => {
  const random = rng(3);
  const utterances = lecture(25, random);
  const taps = honestTaps({ students: 20, utterances, participation: 0.8, random });
  const end = utterances[utterances.length - 1] + sec(60);
  for (let t = T0; t < end; t += sec(1)) taps.push({ student: 99, device: 99, t });
  const r = score(taps, end + sec(10));
  assert.strictEqual(r.count, 25);
  // ...and the spammer loses the right to shape clusters, and most of their weight
  assert.deepStrictEqual(r._debug.excluded, [99]);
  const w = score(taps, end + sec(10), { myId: 99 }).me.weight;
  assert.ok(w < 0.5, `spammer weight ${w}`);
});

test('a spammer during a dense lecture (every 30 s) still cannot glue clusters', () => {
  const random = rng(31);
  const utterances = [];
  for (let i = 1; i <= 30; i++) utterances.push(T0 + sec(30 * i));
  const taps = honestTaps({ students: 20, utterances, participation: 0.8, random });
  const end = utterances[29] + sec(30);
  for (let t = T0; t < end; t += sec(2)) taps.push({ student: 99, device: 99, t });
  const r = score(taps, end + sec(10));
  assert.strictEqual(r.count, 30);
  assert.deepStrictEqual(r._debug.excluded, [99]);
});

test('an attentive student who taps every utterance is not treated as a spammer', () => {
  const random = rng(32);
  const utterances = lecture(30, random);
  // most people catch 40% of them; student 1 catches all
  const taps = honestTaps({ students: 20, utterances, participation: 0.4, random }).filter((x) => x.student !== 1);
  for (const at of utterances) taps.push({ student: 1, device: 1, t: at + 800 });
  const r = score(taps, utterances[29] + sec(60), { myId: 1 });
  assert.deepStrictEqual(r._debug.excluded, []);
  assert.ok(r.me.weight > 0.8);
});

test('mashing the button is one tap; a few extra taps do not inflate repeats', () => {
  const random = rng(4);
  const utterances = lecture(10, random);
  const taps = honestTaps({ students: 15, utterances, random });
  // student 7 mashes 6 times per utterance
  for (const at of utterances) for (let k = 0; k < 6; k++) taps.push({ student: 7, device: 7, t: at + 1000 + k * 100 });
  const r = score(taps, utterances[9] + sec(60));
  assert.strictEqual(r.count, 10);
});

test('late joiner and dropout do not affect the count', () => {
  const random = rng(5);
  const utterances = lecture(20, random);
  const taps = honestTaps({ students: 12, utterances, random });
  // student 13 joins for the last 5 only; student 14 taps only the first 5
  for (const at of utterances.slice(15)) taps.push({ student: 13, device: 13, t: at + 1500 });
  for (const at of utterances.slice(0, 5)) taps.push({ student: 14, device: 14, t: at + 1500 });
  const r = score(taps, utterances[19] + sec(60));
  assert.strictEqual(r.count, 20);
});

test('"part of it, part of it" 2 s apart counts as 2', () => {
  const random = rng(6);
  const at = T0 + sec(100);
  const taps = honestTaps({ students: 15, utterances: [at, at + sec(2)], random, jitter: [500, 2000] });
  const r = score(taps, at + sec(60));
  assert.strictEqual(r.events, 1, 'one cluster');
  assert.strictEqual(r.count, 2);
});

test('two utterances 8 s apart are two separate clusters', () => {
  const random = rng(7);
  const at = T0 + sec(100);
  const taps = honestTaps({ students: 15, utterances: [at, at + sec(8)], random, jitter: [500, 3000] });
  const r = score(taps, at + sec(60));
  assert.strictEqual(r.events, 2);
  assert.strictEqual(r.count, 2);
});

test('pending cluster: uncounted below quorum, counted as soon as it reaches it', () => {
  const now = T0 + sec(100);
  const taps = [
    { student: 1, device: 1, t: now - 1500 },
    { student: 2, device: 2, t: now - 900 },
  ];
  let r = score(taps, now);
  assert.strictEqual(r.count, 0);
  assert.deepStrictEqual(r.pending, { devices: 2, quorum: 3, confirmed: false, utterances: 0 });

  taps.push({ student: 3, device: 3, t: now - 200 });
  r = score(taps, now);
  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.pending.confirmed, true);
});

test('"me" stats: taps, hits, accuracy, weight', () => {
  const random = rng(8);
  const utterances = lecture(10, random);
  const taps = honestTaps({ students: 10, utterances, random });
  // student 1 also taps 5 times when nobody else does
  for (let i = 0; i < 5; i++) taps.push({ student: 1, device: 1, t: T0 - sec(100) + sec(i * 10) });
  const r = score(taps, utterances[9] + sec(60), { myId: 1 });
  assert.strictEqual(r.me.taps, 15);
  assert.strictEqual(r.me.hits, 10);
  assert.strictEqual(r.me.events, 10);
  assert.ok(Math.abs(r.me.accuracy - 10 / 15) < 1e-9);
  assert.ok(r.me.weight > 0.5);
  assert.strictEqual(r.feed.length, 10);
});

test('2000 taps score quickly', () => {
  const random = rng(9);
  const utterances = lecture(40, random);
  const taps = honestTaps({ students: 50, utterances, random });
  assert.ok(taps.length >= 1900);
  const start = process.hrtime.bigint();
  const r = score(taps, utterances[39] + sec(60));
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.strictEqual(r.count, 40);
  assert.ok(ms < 200, `took ${ms}ms`);
});
