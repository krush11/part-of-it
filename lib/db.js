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
      await rpc('poi_summary', { p_day: '2000-01-01' });
    },

    // How many times this student tapped on `day`.
    async myCount(email, day) {
      return (await rpc('poi_my_count', { p_email: email, p_day: day })) ?? 0;
    },

    // Records a tap (ignored if within 2s of the student's last one). Returns their count.
    async increment(email, day) {
      return rpc('poi_increment', { p_email: email, p_day: day });
    },

    // Removes the student's latest tap. Returns their count.
    async decrement(email, day) {
      return rpc('poi_decrement', { p_email: email, p_day: day });
    },

    // { total, active, quorum }: confirmed "part of it" moments for the day.
    async summary(day) {
      const rows = await rpc('poi_summary', { p_day: day });
      return (rows && rows[0]) || { total: 0, active: 0, quorum: 1 };
    },

    // [{ count, students, emails: [...] }] for one day, highest count first.
    async distribution(day) {
      return (await rpc('poi_distribution', { p_day: day })) || [];
    },
  };
}

module.exports = { createSupabase, createStore, DatabaseError, SUPABASE_URL };
