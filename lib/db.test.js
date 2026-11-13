// Tests supabase/schema.sql against a real Postgres, acting as Supabase's
// public `anon` role (what the publishable key maps to).
// Point TEST_DATABASE_URL at a throwaway database, never production.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const url = process.env.TEST_DATABASE_URL;

test('schema.sql: counts, class mode and permissions', { skip: !url && 'TEST_DATABASE_URL not set' }, async (t) => {
  const { Client } = require('pg');
  const db = new Client({ connectionString: url });
  await db.connect();
  t.after(() => db.end());

  // Supabase already has these roles; a plain Postgres doesn't.
  await db.query(`do $$ begin
    if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  end $$;`);
  await db.query('drop table if exists public.part_of_it_counts cascade');
  await db.query(fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8'));
  await db.query('grant usage on schema public to anon');
  await db.query('set role anon');

  const today = (await db.query("select to_char(current_date, 'YYYY-MM-DD') as d")).rows[0].d;
  const call = async (sql, args) => (await db.query(sql, args)).rows[0];
  const inc = (email) => call('select public.poi_increment($1, $2) as n', [email, today]);
  const dec = (email) => call('select public.poi_decrement($1, $2) as n', [email, today]);
  const join = (email) => call('select public.poi_join($1, $2) as n', [email, today]);
  const modes = async () => (await db.query('select * from public.poi_daily_modes($1, 5)', [today])).rows;

  // a=3, b=3, c=1, d=1 -> tie between 3 and 1, higher wins
  for (const [who, n] of [['a', 3], ['b', 3], ['c', 1], ['d', 1]]) {
    for (let i = 0; i < n; i++) await inc(`${who}@uni.edu`);
  }
  assert.deepStrictEqual(await modes(), [{ date: today, mode: 3, students: 4 }]);

  // e joins with 0, then taps once -> 1 becomes the clear mode
  assert.strictEqual((await join('E@Uni.edu ')).n, 0); // normalised to e@uni.edu
  assert.strictEqual((await inc('e@uni.edu')).n, 1);
  assert.strictEqual((await modes())[0].mode, 1);

  // undo never goes below zero
  await dec('c@uni.edu');
  assert.strictEqual((await dec('c@uni.edu')).n, 0);

  // anon can't read or write the table directly
  await assert.rejects(db.query('select * from public.part_of_it_counts'), /permission denied/);
  await assert.rejects(
    db.query("update public.part_of_it_counts set count = 999"),
    /permission denied/
  );
  // ...can't write to other days or store junk emails
  await assert.rejects(db.query("select public.poi_increment('x@uni.edu', '2001-01-01')"), /day must be today/);
  await assert.rejects(db.query("select public.poi_increment('not-an-email', $1)", [today]), /check constraint/);

  await db.query('reset role');
});
