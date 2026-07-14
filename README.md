# The Open 2026 — Fantasy Draft Order Tracker

A live dashboard that turns the league's Open Championship picks into this year's
draft order. Ten managers, three golfers each, lowest combined score picks first.

It is a static site: no server, no API key, no database. The page pulls the live
leaderboard straight from ESPN in the browser and recomputes the standings every
60 seconds.

## The rules it implements

- Each manager's score is the **sum of their three golfers' scores to par**.
- **Lowest combined score picks first**, highest picks last.
- **Missed cut:** for every round a golfer does not play, they are charged the
  **worst score any player in the field posted in that round**. So a golfer who
  misses the cut keeps their real 36-hole score and then takes the field's worst
  round twice. (In the 2026 Scottish Open that would have been +9 and +7 — enough
  to put even the best missed-cut player behind the last-place finisher.)
- **Ties** are broken by whose **predicted winning score** is closest to the
  actual winning score.

### One thing the rules don't cover

The tiebreaker can itself tie. Jack and Patrick John Kealy III both predicted −9,
so if they ever finish level on combined score, nothing separates them. Two
predictions can also sit an equal distance either side of the winning score — if
the winner finishes at −10, then −9 and −11 are both exactly one stroke off.

The dashboard does not paper over this. When it happens the affected managers get
a red **"dead heat — league must settle"** badge instead of a silently invented
order. The league has agreed to settle any such tie after the fact.

## How live is it?

ESPN serves this feed with `cache-control: max-age=1` — it is not cached, so
every poll gets genuinely current data. The real latency is upstream: a score
appears once a player finishes a hole and the walking scorer enters it, which is
typically 30–90 seconds behind the shot itself.

The board polls every 60 seconds, shows an **"Updated Xs ago"** label so nobody
has to guess how stale it is, and has a **Refresh** button for anyone who wants
to pull immediately. The button disables itself mid-request so an impatient
league can't stack up duplicate fetches.

## Why there's no database

The page holds no state: every poll recomputes the standings from ESPN and throws
the previous answer away. There is nothing to go stale, drift, or need a backup.

A database would introduce a *second* copy of the truth that can disagree with the
first — the classic failure being a golfer WDing, ESPN revising a scorecard, and a
stored row keeping the old number while the board reports it confidently. The
parsing is verified exact against real data (see Tests), so recomputing from
source every time is the more reliable option, not the lazier one.

## Running it

Any static file server works:

```sh
python3 -m http.server 4173
# then open http://localhost:4173
```

## Previewing the finished board

Before the tournament starts there is nothing to rank, so the board just lists
the entries. To see what the live board looks like — rankings, cut penalties,
tiebreak badges — add `?demo`:

```
http://localhost:4173/index.html?demo
```

Demo mode replays a real completed tournament with the league's golfers grafted
onto real scorelines, and labels itself loudly so it can't be mistaken for real
Open scores.

## Tests

Open `tests.html` in a browser. It checks the cut penalty, the ranking, the
tiebreak and the dead-heat detection, and validates the parsing against a real
completed ESPN leaderboard.

## Deploying a change

GitHub Pages caches each file separately, so a browser can otherwise end up
holding a new `app.js` next to a stale `scoring.js` — which breaks the board with
an undefined-property error rather than failing safe.

To prevent that, `index.html` pins the whole module graph to one version:

```html
<link rel="stylesheet" href="./styles.css?v=2" />
<script type="module" src="./app.js?v=2"></script>
```

`app.js` and `scoring.js` read that `?v=` off their own URL and pass it down to
everything they import. So the only file that can be stale is `index.html`, and a
stale `index.html` simply loads the previous version of *everything* — old but
consistent, never mixed.

**When you change any JS or CSS, bump both numbers in `index.html`.** Forgetting
means returning visitors keep the old version for a few minutes; it does not
break the page.

## Editing the league

Everything you'd want to change lives in `config.js`: the golfers (pinned by ESPN
athlete id, because the field contains both Matt and Alex Fitzpatrick), each
manager's three picks and their predicted winning score, and the refresh interval.

## Files

| File | Purpose |
| --- | --- |
| `config.js` | League setup — the only file you should need to edit |
| `scoring.js` | Fetches ESPN, applies the cut penalty, ranks the managers |
| `app.js` | Renders the board and refreshes it |
| `tests.html` / `tests.js` | The test suite |
