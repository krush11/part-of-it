// Tests supabase/schema.sql against a real Postgres, acting as Supabase's
// public `anon` role (what the publishable key maps to).
//
// By default this runs on PGlite, an in-process Postgres, so `npm test` needs
// no database. Set TEST_DATABASE_URL to run against a throwaway Postgres
// instead (never production).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

async function connect() {
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    const { Client } = require('pg');
    const db = new Client({ connectionString: url });
    await db.connect();
    return { query: (sql, args) => db.query(sql, args), exec: (sql) => db.query(sql), close: () => db.end() };
  }
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  // PGlite needs exec() for multi-statement scripts like schema.sql.
  return { query: (sql, args) => db.query(sql, args), exec: (sql) => db.exec(sql), close: () => db.close() };
}

const ROLL_RE = /^b[il]?260(0[1-9]|[1-5][0-9]|60)@astra\.xlri\.ac\.in$/;

test('roll-number email rule', () => {
  for (const ok of ['b26032', 'bi26002', 'bl26012', 'b26001', 'b26060']) {
    assert.ok(ROLL_RE.test(`${ok}@astra.xlri.ac.in`), ok);
  }
  for (const bad of ['b26000', 'b26061', 'bx26001', 'b25001', 'b260321', 'bi2600', 'b26032@xlri.ac.in', 'b26032@astra.xlri.ac.in.evil.com']) {
    assert.ok(!ROLL_RE.test(bad.includes('@') ? bad : `${bad}@astra.xlri.ac.in`), bad);
  }
});

test('schema.sql: taps, anonymised reads and permissions', async (t) => {
  const db = await connect();
  t.after(() => db.close());

  // Supabase already has these roles; a plain Postgres doesn't.
  await db.exec(`do $$ begin
    if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  end $$;`);
  await db.exec('drop table if exists public.poi_taps cascade');
  await db.exec('drop table if exists public.part_of_it_counts cascade');
  await db.exec(fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8'));
  await db.query('grant usage on schema public to anon');
  await db.query('set role anon');

  const today = (await db.query("select to_char(current_date, 'YYYY-MM-DD') as d")).rows[0].d;
  const dev = (n) => `device-${n}`.padEnd(16, '0');
  const one = async (sql, args) => Object.values((await db.query(sql, args)).rows[0])[0];
  const tap = (email, device, at) =>
    one('select public.poi_tap($1, $2, $3, $4)', [email, today, device, at === undefined ? null : at]);
  const taps = async () => one('select public.poi_taps_for_day($1)', [today]);

  // Three students tap, two of them on the same device.
  assert.strictEqual(await tap('b26001@astra.xlri.ac.in', dev(1)), true);
  assert.strictEqual(await tap('B26002@astra.xlri.ac.in ', dev(1)), true, 'email is normalised');
  assert.strictEqual(await tap('bi26003@astra.xlri.ac.in', dev(2)), true);

  // The read is anonymous: ids only, stable, devices shared where shared.
  let rows = await taps();
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows.map((r) => r.length), [3, 3, 3]);
  assert.strictEqual(rows[0][1], rows[1][1], 'students 1 and 2 share a device id');
  assert.notStrictEqual(rows[0][1], rows[2][1]);
  assert.ok(Number.isFinite(Number(rows[0][2])), 'at_ms is a number');
  assert.strictEqual(JSON.stringify(rows).includes('@'), false, 'no emails in the payload');

  // My id = my first tap id, and it doesn't move when others tap.
  const myId = await one('select public.poi_my_id($1, $2)', ['b26001@astra.xlri.ac.in', today]);
  assert.strictEqual(String(rows[0][0]), String(myId));
  assert.strictEqual(await one('select public.poi_my_id($1, $2)', ['b26059@astra.xlri.ac.in', today]), null);

  // Double tap within 600 ms → false, nothing stored.
  assert.strictEqual(await tap('b26001@astra.xlri.ac.in', dev(1)), false);
  assert.strictEqual((await taps()).length, 3);

  // Backdating: up to 5 s is kept, more is clamped to now (not rejected).
  const past = new Date(Date.now() - 4000).toISOString();
  assert.strictEqual(await tap('b26004@astra.xlri.ac.in', dev(4), past), true);
  rows = await taps();
  const stored = Number(rows.find((r) => String(r[0]) !== String(myId) && Number(r[2]) < Date.now() - 3000)[2]);
  assert.ok(Math.abs(stored - new Date(past).getTime()) < 50, 'kept the 4 s backdate');
  const wayBack = new Date(Date.now() - 60_000).toISOString();
  assert.strictEqual(await tap('b26005@astra.xlri.ac.in', dev(5), wayBack), true);
  rows = await taps();
  assert.ok(Number(rows[rows.length - 1][2]) > Date.now() - 6000, 'a 60 s backdate was clamped to ~now');

  // Undo removes my newest tap; a second undo has nothing to remove.
  assert.strictEqual(await one('select public.poi_untap($1, $2)', ['b26005@astra.xlri.ac.in', today]), true);
  assert.strictEqual(await one('select public.poi_untap($1, $2)', ['b26005@astra.xlri.ac.in', today]), false);
  assert.strictEqual((await taps()).length, 4);

  // Days with taps, newest first; today is excluded when asking for "before today".
  const tomorrow = (await db.query("select to_char(current_date + 1, 'YYYY-MM-DD') as d")).rows[0].d;
  assert.deepStrictEqual(await one('select public.poi_tap_days($1, 14)', [tomorrow]), [today]);
  assert.deepStrictEqual(await one('select public.poi_tap_days($1, 14)', [today]), []);

  // Guard rails.
  await assert.rejects(db.query("select public.poi_tap('b26001@astra.xlri.ac.in', '2001-01-01', $1, null)", [dev(1)]), /day must be today/);
  await assert.rejects(db.query('select public.poi_tap($1, $2, $3, null)', ['someone@gmail.com', today, dev(9)]), /check constraint/);
  await assert.rejects(db.query('select public.poi_tap($1, $2, $3, null)', ['b26061@astra.xlri.ac.in', today, dev(9)]), /check constraint/);
  await assert.rejects(db.query('select * from public.poi_taps'), /permission denied/);
  await assert.rejects(db.query("delete from public.poi_taps"), /permission denied/);
  await assert.rejects(db.query('select * from public.part_of_it_counts'), /permission denied/);

  // More than 1000 taps still come back whole (PostgREST's row limit does not
  // apply to a single JSON value).
  await db.query('reset role');
  await db.query(
    `insert into public.poi_taps (email, day, device, at)
     select 'b26010@astra.xlri.ac.in', $1, $2, now() - (g || ' seconds')::interval
       from generate_series(1, 1200) g`,
    [today, dev(10)]
  );
  await db.query('set role anon');
  assert.strictEqual((await taps()).length, 1204);
  assert.strictEqual(await tap('b26010@astra.xlri.ac.in', dev(10)), false, 'daily cap reached');

  await db.query('reset role');
});
