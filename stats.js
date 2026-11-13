// Mode of a list of counts. On a tie, the highest tied value wins
// (students who joined late tend to have lower counts).
function mode(values) {
  if (values.length === 0) return 0;
  const freq = new Map();
  for (const v of values) freq.set(v, (freq.get(v) || 0) + 1);
  let best = 0;
  let bestFreq = 0;
  for (const [v, f] of freq) {
    if (f > bestFreq || (f === bestFreq && v > best)) {
      best = v;
      bestFreq = f;
    }
  }
  return best;
}

module.exports = { mode };
