// Supabase storage. One row per student per lecture day, reached only through
// the functions defined in supabase/schema.sql.
const { createClient } = require('@supabase/supabase-js');

// The publishable key is meant to be public (it's what browsers use), so it's
// safe to keep in the code. Access is limited by supabase/schema.sql.
const SUPABASE_PROJECT_ID = 'tbjzjyqyepobswuxmzbk';
const SUPABASE_URL = `https://${SUPABASE_PROJECT_ID}.supabase.co`;
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_iQIxBjIRQLbRvRe5i4zGHg_GQKreVZf';

function createSupabase(url = SUPABASE_URL, key = SUPABASE_PUBLISHABLE_KEY) {
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
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
      await rpc('poi_daily_modes', { p_up_to: '2000-01-01', p_limit: 1 });
    },

    // Make sure the student has a row for today (count 0) so they're
    // included in the class mode as soon as they join. Returns their count.
    async join(email, day) {
      return (await rpc('poi_join', { p_email: email, p_day: day })) ?? 0;
    },

    async increment(email, day) {
      return rpc('poi_increment', { p_email: email, p_day: day });
    },

    async decrement(email, day) {
      return rpc('poi_decrement', { p_email: email, p_day: day });
    },

    // [{ count, students, emails: [...] }] for one day, highest count first.
    async distribution(day) {
      return (await rpc('poi_distribution', { p_day: day })) || [];
    },

    // [{ date: 'YYYY-MM-DD', mode, students }], newest first.
    async dailyModes(upToDay, limit = 31) {
      return (await rpc('poi_daily_modes', { p_up_to: upToDay, p_limit: limit })) || [];
    },
  };
}

module.exports = { createSupabase, createStore, DatabaseError, SUPABASE_URL };
