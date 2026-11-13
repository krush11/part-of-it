# Part of It Counter

Our professor says "part of it" a lot. This app lets the class keep count.

- Students sign in with just their email. There's no password.
- Each student taps **He said it!** every time they hear the phrase.
- The big number at the top is the class total for **today only**. Earlier days are ignored, so the same site works across classes on different days. The count resets at midnight Asia/Kolkata.
- Below the counter, **today's taps** lists how many times each student tapped, with their emails. Students who haven't tapped aren't shown.
- The page updates every 3 seconds, so everyone sees the class total change live.

## How the total is counted

Every tap is saved with its time. When the professor says "part of it", honest students tap within a few seconds of each other, so the total is **the number of moments when enough different students tapped together**:

- A moment is confirmed when at least **2 different students, or 30% of the students active in the last 10 minutes (whichever is more)**, tap within **7 seconds** of each other.
- A student's taps inside a confirmed moment count once, however many times they tapped.
- Each student can tap at most once every 2 seconds, and at most 300 times a day.
- If only one student has tapped all day, each of their taps counts. This keeps solo testing working.

What this handles:

| Problem | What happens |
|---|---|
| Students who sign in and never tap | Ignored completely |
| One person spamming the button | Their solo taps never form a moment, so the total doesn't change |
| Mashing the button during a real moment | Still counts once |
| A few pranksters tapping together | Ignored once 30% of the active class is more than their group |
| Late joiners or people who miss some | Don't matter, as long as enough others tapped |

Limits: if the professor says it twice within 7 seconds, it counts once, and a group of colluding pranksters larger than the quorum can still add moments. The constants are at the top of `poi_summary` in `supabase/schema.sql`.

It runs on **Vercel**. Taps are saved in **Supabase** (project `tbjzjyqyepobswuxmzbk`) in a table called `part_of_it_taps`, with one row per tap. The project URL and the publishable key are written directly in `lib/db.js`. The publishable key is designed to be public, so that's safe.

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

This creates the table and a few small functions. The app uses only those functions, so the public key can't touch the table directly. It can only add or undo one tap for an email, and only for today. It can also read the totals and the per-student tap counts, which include students' emails, because the page shows them to everyone. Taps appear in **Table Editor → part_of_it_taps**.

## 2. Deploy to Vercel

**From the dashboard:** go to [vercel.com/new](https://vercel.com/new), import this GitHub repository, leave the framework preset as **Other** with no build command, and click **Deploy**.

**Or from the command line:**

```bash
npm i -g vercel
vercel --prod
```

After that, every push to the repository's main branch redeploys automatically, and other branches get preview URLs.

## Configuration

Nothing needs to be configured in Vercel. All settings are in the code:

| Setting                     | Where          | Current value                         |
|-----------------------------|----------------|---------------------------------------|
| Supabase project + key      | `lib/db.js`    | `tbjzjyqyepobswuxmzbk`, publishable key |
| Time zone (daily reset)     | `lib/app.js`   | `Asia/Kolkata`                        |
| Allowed email domain        | `lib/app.js`   | none (any email)                      |

## Run locally

Requires Node.js 22.

```bash
npm install
npm run dev                                     # http://localhost:3000, uses the Supabase project
TEST_DATABASE_URL='postgresql://...' npm test   # tests schema.sql; use a throwaway Postgres, not production
```

`vercel dev` also works if you have the Vercel CLI.

## Notes

- Signing in with only an email confirms nothing, so anyone could type in someone else's address. That's acceptable for a class joke. The counting method above keeps individual pranksters from moving the total.
- The cookie just remembers which email you typed. Signing it wouldn't add any protection, since there's no password, so there's no secret to set up.
- The allowed email domain is checked by the Vercel functions only. Someone who calls the Supabase functions directly with the public key can skip it, though they still can't read the data or change more than one tap at a time.
