// Crowd-consensus counter.
//
// Every tap is a vote that the prof *just* said it. We count an utterance only
// when enough different devices tap at about the same time. Nobody has to keep
// a running total, so missing a tap or losing track costs nothing, and one
// person tapping on their own (or mashing) never moves the class number.
//
// The whole day is re-scored from the raw tap log on every call. The function
// is pure: same taps + same `now` → same answer.
//
// Input taps: { student, device, t }  (anonymous ids; t in ms since epoch)

const DEFAULTS = {
  // Taps by the same student closer together than this are one tap (mashing).
  DEBOUNCE_MS: 600,
  // A seed tap joins the current cluster if it comes within this long of the
  // previous seed tap. Hearing a phrase + reaching for the phone takes 0.5–4 s,
  // so consecutive taps from a room of people land well inside 3 s of each other.
  GAP_MS: 3000,
  // Past this length a cluster is split at its largest internal gap.
  MAX_SPAN_MS: 10000,
  // Devices that tapped in this window are "listening"; the quorum scales with them.
  ACTIVE_WINDOW_MS: 10 * 60 * 1000,
  // Quorum = clamp(ceil(Q_FRAC × active devices), Q_MIN, Q_MAX).
  Q_MIN: 3,
  Q_MAX: 6,
  Q_FRAC: 0.2,
  // Students whose reliability falls below this can't start or extend a cluster.
  SEED_MIN_W: 0.25,
  // Nor can students tapping far more than everyone else: more than
  // max(RATE_MIN_TAPS, RATE_FACTOR × median taps per student). Gluing clusters
  // together needs taps under GAP_MS apart all the time, i.e. 20+ a minute,
  // while honest students tap about once per utterance.
  RATE_FACTOR: 3,
  RATE_MIN_TAPS: 12,
  // Most utterances one cluster can count ("part of it… part of it… part of it").
  MAX_REPEAT: 3,
  // How many confirmed events to return in the feed.
  FEED_LIMIT: 25,
};

function quorumFor(active, P) {
  return Math.min(P.Q_MAX, Math.max(P.Q_MIN, Math.ceil(P.Q_FRAC * active)));
}

// Step 1: sort and drop mashed taps.
function clean(rawTaps, P) {
  const taps = rawTaps
    .filter((x) => Number.isFinite(x.t))
    .map((x) => ({ student: x.student, device: x.device, t: x.t }))
    .sort((a, b) => a.t - b.t);
  const lastKept = new Map();
  const out = [];
  for (const tap of taps) {
    const prev = lastKept.get(tap.student);
    if (prev !== undefined && tap.t - prev < P.DEBOUNCE_MS) continue;
    lastKept.set(tap.student, tap.t);
    out.push(tap);
  }
  return out;
}

// Step 3: group taps into clusters. Only seed taps open/extend a cluster;
// non-seed taps are attached to a nearby cluster or ignored.
function cluster(taps, isSeed, P) {
  const clusters = [];
  let cur = null;
  let noise = []; // non-seed taps not yet attached to anything

  const open = (tap) => {
    cur = { taps: [], seeds: [], start: tap.t, lastSeed: tap.t };
    // Non-seed taps shortly before the first seed belong to this cluster.
    const keep = [];
    for (const n of noise) (n.t >= tap.t - P.GAP_MS ? cur.taps : keep).push(n);
    noise = keep;
    clusters.push(cur);
  };

  for (const tap of taps) {
    if (isSeed(tap)) {
      if (!cur || tap.t - cur.lastSeed > P.GAP_MS) open(tap);
      cur.taps.push(tap);
      cur.seeds.push(tap);
      cur.lastSeed = tap.t;
    } else if (cur && tap.t - cur.lastSeed <= P.GAP_MS) {
      cur.taps.push(tap);
    } else {
      noise.push(tap);
    }
  }
  return clusters.flatMap((c) => splitLong(c, P));
}

// A cluster longer than MAX_SPAN is cut into pieces no longer than MAX_SPAN.
// Walking left to right, each piece ends at the largest gap between seeds
// inside its window, so cuts land where the room was quietest.
function splitLong(c, P) {
  const seeds = c.seeds;
  if (seeds.length < 2 || c.lastSeed - c.start <= P.MAX_SPAN_MS) return [c];

  const pieces = [];
  let i = 0;
  while (i < seeds.length) {
    let j = i;
    while (j + 1 < seeds.length && seeds[j + 1].t - seeds[i].t <= P.MAX_SPAN_MS) j++;
    if (j + 1 < seeds.length) {
      // Must cut somewhere in (i .. j+1]; pick the widest gap.
      let best = j;
      let bestGap = seeds[j + 1].t - seeds[j].t;
      for (let k = i; k < j; k++) {
        const g = seeds[k + 1].t - seeds[k].t;
        if (g > bestGap) {
          bestGap = g;
          best = k;
        }
      }
      j = best;
    }
    pieces.push([i, j]);
    i = j + 1;
  }

  // Hand every tap (seed or not) to the piece whose time range it falls in.
  const out = [];
  let tapIdx = 0;
  pieces.forEach(([a, b], n) => {
    const pieceSeeds = seeds.slice(a, b + 1);
    const cut = n + 1 < pieces.length ? (seeds[b].t + seeds[b + 1].t) / 2 : Infinity;
    const taps = [];
    while (tapIdx < c.taps.length && c.taps[tapIdx].t < cut) taps.push(c.taps[tapIdx++]);
    out.push({ taps, seeds: pieceSeeds, start: pieceSeeds[0].t, lastSeed: pieceSeeds[pieceSeeds.length - 1].t });
  });
  return out;
}

function lowMedian(values) {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

// Steps 2, 5, 6: quorum, confirmation and repeat count for each cluster.
function evaluate(clusters, seedTaps, weight, now, P) {
  // Sliding window over seed taps (clusters come in time order).
  const active = new Map(); // device -> taps in window
  let lo = 0;
  let hi = 0;
  for (const c of clusters) {
    // Step 2: how many devices were listening when this cluster started?
    while (hi < seedTaps.length && seedTaps[hi].t <= c.start) {
      const d = seedTaps[hi++].device;
      active.set(d, (active.get(d) || 0) + 1);
    }
    while (lo < hi && seedTaps[lo].t < c.start - P.ACTIVE_WINDOW_MS) {
      const d = seedTaps[lo++].device;
      const n = active.get(d) - 1;
      if (n) active.set(d, n);
      else active.delete(d);
    }
    c.quorum = quorumFor(active.size, P);

    // Step 5: enough distinct devices, and enough reliable students.
    const devices = new Set(c.taps.map((x) => x.device));
    const students = new Set(c.taps.map((x) => x.student));
    let weightSum = 0;
    for (const s of students) weightSum += weight(s);
    c.devices = devices.size;
    c.students = students.size;
    c.weightSum = weightSum;
    c.pending = now - c.lastSeed <= P.GAP_MS;
    c.confirmed = devices.size >= c.quorum && weightSum >= 0.5 * c.quorum;

    // Step 6: did most people tap more than once? Then it was said more than once.
    const perSeedStudent = new Map();
    for (const s of c.seeds) perSeedStudent.set(s.student, (perSeedStudent.get(s.student) || 0) + 1);
    const k = lowMedian([...perSeedStudent.values()]);
    c.utterances = c.confirmed ? Math.min(P.MAX_REPEAT, Math.max(1, k)) : 0;
  }
  return clusters;
}

// Step 4: one-coin reliability per student from a scored pass.
// Taps in a still-pending cluster are left out: they haven't had their chance yet.
function reliability(clusters, taps) {
  const stats = new Map();
  const bump = (s, hit) => {
    const e = stats.get(s) || { taps: 0, hits: 0 };
    e.taps++;
    if (hit) e.hits++;
    stats.set(s, e);
  };
  const seen = new Set();
  for (const c of clusters) {
    for (const tap of c.taps) {
      seen.add(tap);
      if (!c.pending) bump(tap.student, c.confirmed);
    }
  }
  for (const tap of taps) if (!seen.has(tap)) bump(tap.student, false); // noise taps
  const w = new Map();
  for (const [s, e] of stats) w.set(s, (e.hits + 1) / (e.taps + 2));
  return { weights: w, stats };
}

function score(rawTaps, now, { myId = null, params } = {}) {
  const P = { ...DEFAULTS, ...(params || {}) };
  const taps = clean(rawTaps, P);

  // Pass A: everyone is a seed with weight 1.
  const passA = evaluate(cluster(taps, () => true, P), taps, () => 1, now, P);
  const { weights, stats } = reliability(passA, taps);
  const w = (s) => (weights.has(s) ? weights.get(s) : 0.5);

  // Pass B: only reliable, normally-paced students shape clusters; weights
  // decide confirmation.
  const tapsPer = new Map();
  for (const tap of taps) tapsPer.set(tap.student, (tapsPer.get(tap.student) || 0) + 1);
  const rateCap = Math.max(P.RATE_MIN_TAPS, P.RATE_FACTOR * lowMedian([...tapsPer.values()]));
  const excluded = new Set();
  for (const [s, n] of tapsPer) if (n > rateCap || w(s) < P.SEED_MIN_W) excluded.add(s);
  const isSeed = (tap) => !excluded.has(tap.student);
  const seedTaps = taps.filter(isSeed);
  const clusters = evaluate(cluster(taps, isSeed, P), seedTaps, w, now, P);

  const confirmed = clusters.filter((c) => c.confirmed);
  const count = confirmed.reduce((n, c) => n + c.utterances, 0);

  const last = clusters[clusters.length - 1];
  const pending =
    last && last.pending
      ? { devices: last.devices, quorum: last.quorum, confirmed: last.confirmed, utterances: last.utterances }
      : null;

  const feed = confirmed
    .slice(-P.FEED_LIMIT)
    .reverse()
    .map((c) => ({ t: Math.round(c.lastSeed), devices: c.devices, utterances: c.utterances }));

  let me = null;
  if (myId !== null && myId !== undefined) {
    const mine = taps.filter((x) => x.student === myId);
    let hits = 0;
    let events = 0;
    for (const c of confirmed) {
      const k = c.taps.filter((x) => x.student === myId).length;
      if (k) {
        hits += k;
        events++;
      }
    }
    const inPending = last && last.pending ? last.taps.some((x) => x.student === myId) : false;
    me = {
      taps: mine.length,
      hits,
      events,
      accuracy: mine.length ? hits / mine.length : null,
      weight: w(myId),
      inPending,
    };
  }

  return {
    count,
    events: confirmed.length,
    students: new Set(taps.map((x) => x.student)).size,
    devices: new Set(taps.map((x) => x.device)).size,
    pending,
    feed,
    me,
    _debug: { clusters, stats, excluded: [...excluded], rateCap },
  };
}

module.exports = { score, quorumFor, DEFAULTS };
