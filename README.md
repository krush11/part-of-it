# Part of It

A certain Managerial Ethics professor has a catchphrase. This site lets the class count it, together, without anyone having to keep count.

- **Intro page** (`/`): what this is, with the prof's photo. The poster lives at `public/img/prof.webp`.
- **Counter** (`/count`): one big button, **HE SAID IT!** Tap it whenever you hear the phrase.
- **Sign-in** is just your roll number (`b26032`, `bi26002`, `bl26012` …, rolls 01–60). The `@astra.xlri.ac.in` is filled in for you and you're signed in the moment the roll is valid. Once per semester.
- The big number is **how many times the class agrees he said it today**. It only goes up when enough different phones tap at about the same moment.
- You get a private **ears rating** (🦇 Bat Ears, 😴 Back Bencher, 🔫 Trigger Happy…) and there's an anonymous live feed and a history of past lectures. Nobody's roll number is shown to anyone.

## How the counting works

Each tap is a *vote that he just said it*, not a running total. The server re-scores the whole day from the tap log every time ([`lib/consensus.js`](lib/consensus.js)):

1. **Debounce.** Taps from the same student under 600 ms apart are one tap.
2. **Cluster.** Taps are grouped when they land within 3 s of each other (people need 0.5–4 s to hear it, reach for the phone and tap). Clusters longer than 10 s are split at their quietest point.
3. **Quorum.** A cluster counts only if it has enough **distinct devices**: 20% of the devices active in the last 10 minutes, at least 3 and at most 6. Ten tabs on one phone are one device.
4. **Reliability.** Each student gets a weight from how often their taps land in confirmed clusters (a one-coin Dawid–Skene model). Students with low weight, or tapping far more than everyone else, can't start or extend a cluster, so a spammer can't glue real clusters together or inflate anything. The cluster also needs enough total weight.
5. **Repeats.** If most people in a cluster tapped twice, "part of it, part of it" counts as 2 (median of taps per student, capped at 3).

What this gives you:

| Problem | Result |
|---|---|
| Someone taps 50 times for fun | +0. Alone they never reach the quorum; mashing is debounced; their weight drops. |
| You miss a few taps | Nothing. The count doesn't depend on your total. |
| You lose track | There's nothing to track. Just tap when you hear it. |
| Only 5 students paying attention | Quorum drops to 3. |
| He says it twice in a row | Counted as 2. |

Known limits: sign-in has no password, so a determined person with several incognito windows can still fake a crowd. This stops casual pranks, not an adversary. An undo within 15 s can briefly drop the count by one.

## Where things live

It runs on **Vercel**. Taps are stored in **Supabase** (project `tbjzjyqyepobswuxmzbk`), table `poi_taps`, one row per tap. The project URL and publishable key are in `lib/db.js`; the publishable key is meant to be public.

```
public/               the web pages (static)
  index.html            intro page
  count.html, count.js  the counter
  style.css             meme theme
  img/prof.webp         the prof, as a recruitment poster
api/                  one Vercel function per endpoint
  state.js              GET  everything the page shows
  login.js              POST {roll}
  logout.js             POST
  tap.js                POST {ageMs}   "he said it"
  untap.js              POST           undo my last tap (15 s window)
lib/app.js            request handling shared by every api/ file
lib/consensus.js      the counting algorithm (pure, tested)
lib/db.js             Supabase access (+ an in-memory stand-in for local dev)
supabase/schema.sql   database setup; run once in Supabase
dev-server.js         runs it locally without Vercel
```

## Set up Supabase (one time, and again after schema changes)

Either in the dashboard: **SQL Editor → New query**, paste [`supabase/schema.sql`](supabase/schema.sql), **Run**. Or from the terminal with the Supabase CLI (log in once with `npx supabase login`; on Windows PowerShell use `npx.cmd`):

```bash
npx supabase db query --remote=tbjzjyqyepobswuxmzbk -f supabase/schema.sql --yes
```

Safe to re-run. The same command with `--read-only "select ..."` runs ad-hoc queries, and without `--read-only` it can clear tables (`delete from public.poi_taps`).

The app only ever calls the functions this creates. With the public key you can record one tap for today, undo your own last tap, and read *anonymous* tap timings. You can't read emails, write other days, or set counts. The roll-number rule is enforced by the database too.

## Deploy to Vercel

Import the GitHub repository at [vercel.com/new](https://vercel.com/new) (framework **Other**, no build command) and deploy. Every push to `master` redeploys. Or: `npm i -g vercel && vercel --prod`.

Nothing needs configuring in Vercel. Settings live in code:

| Setting | Where |
|---|---|
| Supabase project + key | `lib/db.js` |
| Time zone (daily reset), roll-number rule | `lib/app.js` |
| Algorithm thresholds | top of `lib/consensus.js` |

## Run locally

Requires Node.js 22.

```bash
npm install
npm run dev -- --local   # http://localhost:3000 with an in-memory database, no Supabase needed
npm run dev              # same, against the real Supabase project
npm test                 # algorithm tests + schema.sql tests (on an in-process Postgres)
```

To test `schema.sql` against a real Postgres instead: `TEST_DATABASE_URL='postgresql://...' npm test` (use a throwaway database).

## A funnier prof photo

If you want to turn the photo into a meme poster, try this prompt with an image model:

> Turn this professor's photo into an affectionate, cartoonish meme poster: he stands at a lecture podium in a superhero cape, the chalkboard behind him completely filled with the words "PART OF IT" written over and over, a speech bubble saying "and this is… part of it", students in the foreground holding up glowing tally counters. Bright comic-book style, halftone dots, bold outlines, friendly not mocking, no text other than "PART OF IT".
