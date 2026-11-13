# Part of It Counter

Our professor says "part of it" a lot. This app lets the class keep count.

- Students sign in with just their email. There's no password.
- Each student taps **He said it!** every time they hear the phrase. Each student has their own count.
- The big number at the top is the **mode** of all students' counts for today, meaning the count the most students agree on. If there's a tie, the higher value wins, because students who show up late usually have lower counts.
- Counts start over each day (one lecture = one day). Totals from past lectures show up in a history table.
- The page updates every 3 seconds, so everyone sees the class total change live.

Counts are saved in **Supabase** (project `tbjzjyqyepobswuxmzbk`) in a table called `part_of_it_counts`, with one row per student per day. The project URL and the publishable key are written directly in `db.js`. The publishable key is designed to be public, so that's safe.

## Set up Supabase (one time)

Open the Supabase dashboard and go to **SQL Editor → New query**. Paste in the contents of [`supabase/schema.sql`](supabase/schema.sql) and click **Run**. Running it again later does no harm.

This creates the table and four small functions. The app uses only those functions, so the public key can't read students' emails or change counts directly. It can only add or undo one tap for an email, and only for today. Students' counts appear in **Table Editor → part_of_it_counts**.

## Deploy to Heroku

```bash
heroku create your-app-name
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
npm start                                      # http://localhost:3000, uses the Supabase project
TEST_DATABASE_URL='postgresql://...' npm test  # tests schema.sql; use a throwaway Postgres, not production
```

## Configuration (environment variables)

| Variable         | Required | Purpose                                                       |
|------------------|----------|---------------------------------------------------------------|
| `SESSION_SECRET` | yes      | Secret used to sign login cookies. Without it, everyone gets logged out whenever the app restarts, which on Heroku happens at least once a day |
| `TIMEZONE`       | no       | Decides when a new day starts, e.g. `America/New_York` (Heroku defaults to UTC) |
| `ALLOWED_DOMAIN` | no       | Only allow emails from this domain, e.g. `university.edu`     |

## Notes

- Signing in with only an email confirms nothing, so anyone could type in someone else's address. That's acceptable for a class joke. The mode also keeps one prankster from moving the total.
- `ALLOWED_DOMAIN` is checked by this server only. Someone who calls the Supabase functions directly with the public key can skip it, though they still can't read the data or change more than one tap at a time.
