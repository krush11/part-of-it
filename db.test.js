// Runs against a real Postgres. Point TEST_DATABASE_URL at a throwaway
// database (never production: the test deletes its own rows).
const test = require('node:test');
const assert = require('node:assert');
const { createPool, createStore } = require('./db');

const url = process.env.TEST_DATABASE_URL;

test('counts and class mode', { skip: !url && 'TEST_DATABASE_URL not set' }, async (t) => {
  const store = createStore(createPool(url));
  t.after(async () => {
    await store.pool.query("delete from part_of_it_counts where email like '%@test.invalid'");
    await store.pool.end();
  });
  await store.init();
  await store.pool.query("delete from part_of_it_counts where email like '%@test.invalid'");

  const day = '2001-01-02';
  const bump = async (who, n) => {
    for (let i = 0; i < n; i++) await store.increment(`${who}@test.invalid`, day);
  };

  // a=3, b=3, c=1, d=1 -> tie between 3 and 1, higher wins
  await bump('a', 3);
  await bump('b', 3);
  await bump('c', 1);
  await bump('d', 1);
  let [row] = await store.dailyModes(day, 1);
  assert.deepStrictEqual(row, { date: day, mode: 3, students: 4 });

  // e joins with 0 and taps once -> 1 becomes the clear mode
  await store.join('e@test.invalid', day);
  assert.strictEqual(await store.myCount('e@test.invalid', day), 0);
  await bump('e', 1);
  [row] = await store.dailyModes(day, 1);
  assert.strictEqual(row.mode, 1);

  // decrement never goes below zero
  await store.decrement('c@test.invalid', day);
  await store.decrement('c@test.invalid', day);
  assert.strictEqual(await store.myCount('c@test.invalid', day), 0);

  // concurrent taps are not lost
  await Promise.all(Array.from({ length: 20 }, () => store.increment('a@test.invalid', day)));
  assert.strictEqual(await store.myCount('a@test.invalid', day), 23);
});
