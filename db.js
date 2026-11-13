// Supabase (Postgres) storage. One row per student per lecture day.
const { Pool } = require('pg');

const SCHEMA = `
create table if not exists part_of_it_counts (
  email      text        not null,
  day        date        not null,
  count      integer     not null default 0 check (count >= 0),
  updated_at timestamptz not null default now(),
  primary key (email, day)
);
-- Keep the table private from Supabase's public REST API (anon key).
-- The server connects as the table owner, which bypasses RLS.
alter table part_of_it_counts enable row level security;
`;

function createPool(connectionString) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Use the connection string from Supabase → Connect.');
  }
  const url = new URL(connectionString);
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname) || url.hostname.startsWith('/');
  // Supabase's certificate isn't in Node's default trust store, so we encrypt
  // without verifying the chain. Drop sslmode so pg doesn't override this.
  url.searchParams.delete('sslmode');
  return new Pool({
    connectionString: url.toString(),
    ssl: local ? false : { rejectUnauthorized: false },
    max: Number(process.env.DB_POOL_SIZE) || 5,
  });
}

function createStore(pool) {
  return {
    pool,

    async init() {
      await pool.query(SCHEMA);
    },

    // Make sure the student has a row for today (count 0) so they're
    // included in the class mode as soon as they join.
    async join(email, day) {
      await pool.query(
        `insert into part_of_it_counts (email, day) values ($1, $2)
         on conflict (email, day) do nothing`,
        [email, day]
      );
    },

    async increment(email, day) {
      await pool.query(
        `insert into part_of_it_counts (email, day, count) values ($1, $2, 1)
         on conflict (email, day)
         do update set count = part_of_it_counts.count + 1, updated_at = now()`,
        [email, day]
      );
    },

    async decrement(email, day) {
      await pool.query(
        `update part_of_it_counts
            set count = greatest(count - 1, 0), updated_at = now()
          where email = $1 and day = $2`,
        [email, day]
      );
    },

    async myCount(email, day) {
      const { rows } = await pool.query(
        'select count from part_of_it_counts where email = $1 and day = $2',
        [email, day]
      );
      return rows[0] ? rows[0].count : 0;
    },

    // Mode per day. Ordering by count desc makes mode() pick the highest
    // value on a tie (late joiners tend to have lower counts).
    async dailyModes(upToDay, limit = 31) {
      const { rows } = await pool.query(
        `select to_char(day, 'YYYY-MM-DD') as date,
                mode() within group (order by count desc) as mode,
                count(*)::int as students
           from part_of_it_counts
          where day <= $1
          group by day
          order by day desc
          limit $2`,
        [upToDay, limit]
      );
      return rows;
    },
  };
}

module.exports = { createPool, createStore };
