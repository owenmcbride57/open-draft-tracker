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

The tiebreaker can itself tie. Owen and Pj both predicted −9, so if they ever
finish level on combined score, nothing separates them. Two predictions can also
sit an equal distance either side of the winning score — if the winner finishes
at −10, then −9 and −11 are both exactly one stroke off.

The dashboard does not paper over this. When it happens the affected managers get
a red **"dead heat — league must settle"** badge instead of a silently invented
order. Agree a rule in advance if you want to avoid an argument on draft night.

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
