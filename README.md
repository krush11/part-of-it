# Part of It Counter

Our professor says "part of it" a lot. This app lets the class keep count.

- Students sign in with just their email. There's no password.
- Each student taps **He said it!** every time they hear the phrase. Each student has their own count.
- The big number at the top is the **mode** of all students' counts for today, meaning the count the most students agree on. If there's a tie, the higher value wins, because students who show up late usually have lower counts.
- Counts start over each day (one lecture = one day). Totals from past lectures show up in a history table.
- The page updates every 3 seconds, so everyone sees the class total change live.

Counts are saved in a **Supabase** (Postgres) table called `part_of_it_counts`, with one row per student per day. The app creates the table on its own the first time it starts.

## Set up Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. In the project, click **Connect** and copy the **Session pooler** connection string. It looks like
   `postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`.
   Replace `[YOUR-PASSWORD]` with your database password. If the password has special characters such as `@`, `#` or `/`, URL-encode them.
   Use the pooler and not the "Direct connection": Heroku can only reach the pooler, because the direct connection needs IPv6.

You don't have to run any SQL by hand. Students' counts appear in the Supabase **Table Editor** under `part_of_it_counts`.

## Deploy to Heroku

```bash
heroku create your-app-name
heroku config:set DATABASE_URL='postgresql://postgres.xxxx:password@aws-0-us-east-1.pooler.supabase.com:5432/postgres'
heroku config:set SESSION_SECRET="$(openssl rand -hex 32)"
heroku config:set TIMEZONE=America/New_York          # your class's time zone
heroku config:set ALLOWED_DOMAIN=youruniversity.edu  # optional
git push heroku main    # or: git push heroku your-branch:main
heroku open
```

The `Procfile` tells Heroku to run `node server.js`. Heroku sets `PORT` itself.

## Run locally

Requires Node.js 22.

```bash
npm install
DATABASE_URL='postgresql://...' npm start   # http://localhost:3000
TEST_DATABASE_URL='postgresql://...' npm test  # use a throwaway database, not production
```

## Configuration (environment variables)

| Variable         | Required | Purpose                                                       |
|------------------|----------|---------------------------------------------------------------|
| `DATABASE_URL`   | yes      | Supabase Postgres connection string (Session pooler)          |
| `SESSION_SECRET` | yes      | Secret used to sign login cookies. Without it, everyone gets logged out whenever the app restarts, which on Heroku happens at least once a day |
| `TIMEZONE`       | no       | Decides when a new day starts, e.g. `America/New_York` (Heroku defaults to UTC) |
| `ALLOWED_DOMAIN` | no       | Only allow emails from this domain, e.g. `university.edu`     |
| `DB_POOL_SIZE`   | no       | Maximum number of database connections (default 5)            |

## Notes

- Signing in with only an email confirms nothing, so anyone could type in someone else's address. That's acceptable for a class joke. The mode also keeps one prankster from moving the total.
- The table has row-level security turned on, so it can't be read through Supabase's public API with the anon key. Only this server, which connects with the database password, can read it.
