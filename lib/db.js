// Supabase storage. Reached only through the functions defined in
// supabase/schema.sql; no email ever comes back out.
const { createClient } = require('@supabase/supabase-js');

// The publishable key is meant to be public (it's what browsers use), so it's
// safe to keep in the code. Access is limited by supabase/schema.sql.
const SUPABASE_PROJECT_ID = 'tbjzjyqyepobswuxmzbk';
const SUPABASE_URL = `https://${SUPABASE_PROJECT_ID}.supabase.co`;
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_iQIxBjIRQLbRvRe5i4zGHg_GQKreVZf';

function createSupabase(url = SUPABASE_URL, key = SUPABASE_PUBLISHABLE_KEY) {
  if (process.env.POI_LOCAL_DB) return createLocalSupabase();
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Dev only (`npm run dev -- --local`): a stand-in for Supabase backed by
// PGlite, an in-process Postgres, with supabase/schema.sql applied and calls
// made as the `anon` role. Data lives in memory and vanishes on restart.
function createLocalSupabase() {
  const fs = require('node:fs');
  const path = require('node:path');
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  const ready = (async () => {
    await db.exec(`do $$ begin
      if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    end $$;`);
    await db.exec(fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8'));
    await db.exec('grant usage on schema public to anon; set role anon;');
  })();
  const argOrder = new Map();
  return {
    async rpc(fn, args = {}) {
      try {
        await ready;
        if (!argOrder.has(fn)) {
          const r = await db.query(
            'select proargnames, proargmodes::text[] as modes, proretset from pg_proc where proname = $1',
            [fn]
          );
          if (!r.rows.length) return { data: null, error: { code: 'PGRST202', message: `function ${fn} does not exist` } };
          const { proargnames, modes, proretset } = r.rows[0];
          // Only IN parameters; `returns table` adds OUT columns to proargnames.
          const names = (proargnames || []).filter((_, i) => !modes || modes[i] === 'i');
          argOrder.set(fn, { names, setof: proretset });
        }
        const { names, setof } = argOrder.get(fn);
        const values = names.map((n) => (args[n] === undefined ? null : args[n]));
        const placeholders = names.map((_, i) => `$${i + 1}`).join(', ');
        const r = setof
          ? await db.query(`select * from public.${fn}(${placeholders})`, values)
          : await db.query(`select public.${fn}(${placeholders}) as v`, values);
        return { data: setof ? r.rows : r.rows[0].v, error: null };
      } catch (err) {
        return { data: null, error: { message: err.message } };
      }
    },
  };
}

class DatabaseError extends Error {}

function createStore(supabase = createSupabase()) {
  async function rpc(fn, args) {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) {
      const hint =
        error.code === 'PGRST202' || /does not exist|schema cache/i.test(error.message)
          ? ' (run supabase/schema.sql in the Supabase SQL Editor)'
          : '';
      throw new DatabaseError(`${fn}: ${error.message}${hint}`);
    }
    return data;
  }

  return {
    // Fails fast at startup if the project is unreachable or the SQL hasn't been run.
    async init() {
      await rpc('poi_tap_days', { p_before: '2000-01-01', p_limit: 1 });
    },

    // Record a tap. Resolves true if stored, false if it was a double tap or
    // the student hit the daily cap.
    async tap(email, day, deviceHash, atIso) {
      return Boolean(await rpc('poi_tap', { p_email: email, p_day: day, p_device: deviceHash, p_at: atIso }));
    },

    // Remove the student's newest tap if it's under 15 s old.
    async untap(email, day) {
      return Boolean(await rpc('poi_untap', { p_email: email, p_day: day }));
    },

    // [{ student, device, t }] for one day, anonymous, in time order.
    async tapsForDay(day) {
      const rows = (await rpc('poi_taps_for_day', { p_day: day })) || [];
      return rows.map(([student, device, t]) => ({ student, device, t: Number(t) }));
    },

    // The caller's anonymous id for the day, or null if they haven't tapped.
    async myId(email, day) {
      const id = await rpc('poi_my_id', { p_email: email, p_day: day });
      return id === null || id === undefined ? null : id;
    },

    // ['YYYY-MM-DD', ...] days before `before` that have taps, newest first.
    async tapDays(before, limit = 14) {
      return (await rpc('poi_tap_days', { p_before: before, p_limit: limit })) || [];
    },

    // Place a target bid (0–150, steps of 10). Resolves to the bid on record,
    // which is the existing one if the student already bid today.
    async bid(email, day, bid) {
      return rpc('poi_bid', { p_email: email, p_day: day, p_bid: bid });
    },

    // The caller's bid for the day, or null.
    async myBid(email, day) {
      const b = await rpc('poi_my_bid', { p_email: email, p_day: day });
      return b === null || b === undefined ? null : b;
    },

    // [{ bid, students }] for one day, ascending by bid.
    async bidsForDay(day) {
      const rows = (await rpc('poi_bids_for_day', { p_day: day })) || [];
      return rows.map(([bid, students]) => ({ bid, students }));
    },

    // Legacy per-student counts: [{ date, mode, students }], newest first.
    async dailyModes(upToDay, limit = 31) {
      return (await rpc('poi_daily_modes', { p_up_to: upToDay, p_limit: limit })) || [];
    },
  };
}

module.exports = { createSupabase, createStore, DatabaseError, SUPABASE_URL };
