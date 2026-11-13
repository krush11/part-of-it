// Tests supabase/schema.sql against a real Postgres, acting as Supabase's
// public `anon` role (what the publishable key maps to).
// Point TEST_DATABASE_URL at a throwaway database, never production.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const url = process.env.TEST_DATABASE_URL;

test('schema.sql', { skip: !url && 'TEST_DATABASE_URL not set' }, async (t) => {
  const { Client } = require('pg');
  const db = new Client({ connectionString: url });
  await db.connect();
  t.after(() => db.end());

  // Supabase already has these roles; a plain Postgres doesn't.
  await db.query(`do $$ begin
    if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  end $$;`);
  await db.query('drop table if exists public.part_of_it_taps cascade');
  await db.query(fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8'));
  await db.query('grant usage on schema public to anon');

  // Insert taps at exact times (seconds after 10:00) on a given day, as admin.
  async function taps(day, list) {
    for (const [who, sec] of list) {
      await db.query(
        `insert into public.part_of_it_taps (email, day, at)
         values ($1, $2, ($2::date + time '10:00') + make_interval(secs => $3))`,
        [`${who}@uni.edu`, day, sec]
      );
    }
  }
  async function summary(day) {
    await db.query('set role anon');
    try {
      return (await db.query('select * from public.poi_summary($1)', [day])).rows[0];
    } finally {
      await db.query('reset role');
    }
  }

  await t.test('honest class: each moment counts once', async () => {
    const day = '2001-01-01';
    const moments = [0, 30, 60, 90];
    const list = [];
    moments.forEach((m, i) => {
      // 5 students, reaction times 0-4s; e misses the 3rd moment
      ['a', 'b', 'c', 'd', 'e'].forEach((who, j) => {
        if (!(who === 'e' && i === 2)) list.push([who, m + j]);
      });
    });
    await taps(day, list);
    assert.deepStrictEqual(await summary(day), { total: 4, active: 5, quorum: 2 });
  });

  await t.test('a spammer alone adds nothing, and spam inside a real moment counts once', async () => {
    const day = '2001-01-01'; // same class as above
    const spam = [];
    for (let s = 100; s <= 300; s += 3) spam.push(['spammer', s]); // alone, every 3s
    spam.push(['spammer', 1], ['spammer', 3], ['spammer', 5]); // mashing during moment 1
    await taps(day, spam);
    assert.strictEqual((await summary(day)).total, 4);
  });

  await t.test('a straggler tap just after a moment does not create a second one', async () => {
    const day = '2001-01-02';
    await taps(day, [['a', 0], ['b', 1], ['c', 2], ['d', 9], ['a', 40], ['b', 41]]);
    assert.strictEqual((await summary(day)).total, 2);
  });

  await t.test('two quick moments 8s apart both count; slow reactions within 7s count once', async () => {
    const day = '2001-01-03';
    await taps(day, [['a', 0], ['b', 1], ['a', 8], ['b', 9], ['a', 60], ['b', 63], ['c', 66]]);
    assert.strictEqual((await summary(day)).total, 3);
  });

  await t.test('two pranksters cannot fake moments in a class of 12', async () => {
    const day = '2001-01-04';
    const list = [];
    for (let i = 0; i < 10; i++) list.push([`s${i}`, i % 4]); // real moment at 0s
    list.push(['p1', 60], ['p2', 61], ['p1', 120], ['p2', 121]); // pranksters together
    await taps(day, list);
    const s = await summary(day);
    assert.strictEqual(s.total, 1);
    assert.strictEqual(s.active, 12);
  });

  await t.test('students who never tap are ignored; a lone student still works', async () => {
    const day = '2001-01-05';
    await taps(day, [['solo', 0], ['solo', 20], ['solo', 40]]);
    assert.deepStrictEqual(await summary(day), { total: 3, active: 1, quorum: 1 });
    assert.deepStrictEqual(await summary('2001-01-06'), { total: 0, active: 0, quorum: 1 });
  });

  await t.test('tap functions, distribution and permissions as anon', async (st) => {
    const today = (await db.query("select to_char(current_date, 'YYYY-MM-DD') as d")).rows[0].d;
    await db.query('set role anon');
    st.after(() => db.query('reset role'));
    const call = async (sql, args) => (await db.query(sql, args)).rows[0].n;
    const inc = (email) => call('select public.poi_increment($1, $2) as n', [email, today]);
    const dec = (email) => call('select public.poi_decrement($1, $2) as n', [email, today]);

    // second tap within 2 seconds is ignored; email is normalised
    assert.strictEqual(await inc('X@Uni.edu '), 1);
    assert.strictEqual(await inc('x@uni.edu'), 1);
    assert.strictEqual(await inc('y@uni.edu'), 1);
    assert.strictEqual(await call('select public.poi_my_count($1, $2) as n', ['x@uni.edu', today]), 1);

    // undo removes the latest tap and never goes below zero
    assert.strictEqual(await dec('y@uni.edu'), 0);
    assert.strictEqual(await dec('y@uni.edu'), 0);

    // distribution only lists students with taps
    const dist = (await db.query('select * from public.poi_distribution($1)', ['2001-01-02'])).rows;
    assert.deepStrictEqual(dist, [
      { count: 2, students: 2, emails: ['a@uni.edu', 'b@uni.edu'] },
      { count: 1, students: 2, emails: ['c@uni.edu', 'd@uni.edu'] },
    ]);
    assert.deepStrictEqual((await db.query('select * from public.poi_distribution($1)', [today])).rows, [
      { count: 1, students: 1, emails: ['x@uni.edu'] },
    ]);

    // the public key can't touch the table, write other days, or store junk
    await assert.rejects(db.query('select * from public.part_of_it_taps'), /permission denied/);
    await assert.rejects(db.query('delete from public.part_of_it_taps'), /permission denied/);
    await assert.rejects(db.query("select public.poi_increment('z@uni.edu', '2001-01-01')"), /day must be today/);
    await assert.rejects(db.query('select public.poi_increment($1, $2)', ['not-an-email', today]), /check constraint/);
  });
});
