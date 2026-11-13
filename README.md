# Part of It Counter

Our professor says "part of it" a lot. This app lets the class keep count.

- Students sign in with just their email. There's no password.
- Each student taps **He said it!** every time they hear the phrase. Each student has their own count.
- The big number at the top is the **mode** of all students' counts for today, meaning the count the most students agree on. If there's a tie, the higher value wins, because students who show up late usually have lower counts.
- Counts start over each day (one lecture = one day). Totals from past lectures show up in a history table.
- The page updates every 3 seconds, so everyone sees the class total change live.

## Run it

Requires Node.js 18 or later. There are no dependencies to install.

```bash
npm start          # http://localhost:3000
npm test           # runs the tests for the mode calculation
```

## Configuration (environment variables)

| Variable         | Default                 | Purpose                                                  |
|------------------|-------------------------|----------------------------------------------------------|
| `PORT`           | `3000`                  | Port to listen on                                        |
| `SESSION_SECRET` | random on each start    | Secret used to sign login cookies. Set this so students stay logged in after a restart |
| `ALLOWED_DOMAIN` | (any)                   | Only allow emails from this domain, e.g. `university.edu` |
| `TIMEZONE`       | the server's time zone  | Decides when a new day starts, e.g. `America/New_York`   |
| `DATA_FILE`      | `data/counts.json`      | Where counts are saved                                    |

## Deploying

The app is one Node process that saves its data to a JSON file. It runs on any host that keeps files on a persistent disk, such as Render (with a disk attached), Railway, Fly.io (with a volume) or a small VPS. Set `SESSION_SECRET`, plus `ALLOWED_DOMAIN` if you want to keep out people who aren't students.

Note: signing in with only an email confirms nothing, so anyone could type in someone else's address. That's acceptable for a class joke. The mode also keeps one prankster from moving the total.
