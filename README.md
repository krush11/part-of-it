# Part of It Counter

Our professor says "part of it" a lot. This app lets the class keep count.

- Students sign in with just their email. There's no password.
- Each student taps **He said it!** every time they hear the phrase. Each student has their own count.
- The big number at the top is the **mode** of all students' counts for today, meaning the count the most students agree on. If there's a tie, the higher value wins, because students who show up late usually have lower counts.
- Counts start over each day (one lecture = one day). Totals from past lectures show up in a history table.
- The page updates every 3 seconds, so everyone sees the class total change live.

It runs on **Vercel**. Counts are saved in **Supabase** (project `tbjzjyqyepobswuxmzbk`) in a table called `part_of_it_counts`, with one row per student per day. The project URL and the publishable key are written directly in `lib/db.js`. The publishable key is designed to be public, so that's safe.

## Project layout

```
public/           the web page (served as static files)
api/              one Vercel serverless function per endpoint
  state.js          GET  current counts
  login.js          POST {email}
  logout.js         POST
  increment.js      POST +1 for the signed-in student
  decrement.js      POST undo one
lib/app.js        shared request handling used by every api/ file
lib/db.js         Supabase connection (project URL + publishable key)
supabase/schema.sql   database setup, run once in Supabase
dev-server.js     runs the same thing locally without Vercel
vercel.json       Vercel config
```

## 1. Set up Supabase (one time)

Open the Supabase dashboard and go to **SQL Editor → New query**. Paste in the contents of [`supabase/schema.sql`](supabase/schema.sql) and click **Run**. Running it again later does no harm.

This creates the table and four small functions. The app uses only those functions, so the public key can't read students' emails or change counts directly. It can only add or undo one tap for an email, and only for today. Students' counts appear in **Table Editor → part_of_it_counts**.

## 2. Deploy to Vercel

**From the dashboard:** go to [vercel.com/new](https://vercel.com/new), import this GitHub repository, and leave the framework preset as **Other** with no build command. Under **Environment Variables**, add `TIMEZONE` (see below), then click **Deploy**.

**Or from the command line:**

```bash
npm i -g vercel
vercel                                  # first deploy, links the project
vercel env add TIMEZONE production      # e.g. America/New_York
vercel --prod
```

After that, every push to the repository's main branch redeploys automatically, and other branches get preview URLs.

## Configuration (Vercel environment variables)

Both are optional, and nothing secret needs to be configured.

| Variable         | Purpose                                                                     |
|------------------|-----------------------------------------------------------------------------|
| `TIMEZONE`       | Decides when a new day starts, e.g. `America/New_York`. Vercel runs on UTC, so without this the count resets at UTC midnight |
| `ALLOWED_DOMAIN` | Only allow emails from this domain, e.g. `university.edu`                  |

Changing an environment variable takes effect on the next deployment.

## Run locally

Requires Node.js 22.

```bash
npm install
npm run dev                                     # http://localhost:3000, uses the Supabase project
TEST_DATABASE_URL='postgresql://...' npm test   # tests schema.sql; use a throwaway Postgres, not production
```

`vercel dev` also works if you have the Vercel CLI.

## Notes

- Signing in with only an email confirms nothing, so anyone could type in someone else's address. That's acceptable for a class joke. The mode also keeps one prankster from moving the total.
- The cookie just remembers which email you typed. Signing it wouldn't add any protection, since there's no password, so there's no secret to set up.
- `ALLOWED_DOMAIN` is checked by the Vercel functions only. Someone who calls the Supabase functions directly with the public key can skip it, though they still can't read the data or change more than one tap at a time.
