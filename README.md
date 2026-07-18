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
  to put even the best missed-cut player behind the last-place finisher.) A golfer
  confirmed to have missed the cut carries a red **MC** badge next to their name on
  every tab. The cut is recognised as **final the moment round 2 is complete** —
  the board doesn't wait for round 3 to start; survivors are read off the 36-hole
  line (top 70 and ties). The worst-round penalty itself only lands once round 3 is
  actually played (there's no field-worst-round to charge before then), so in the
  gap a cut golfer shows the badge but their score is still their real 36 holes.

### How the penalty updates live

Only **completed** rounds count toward "worst in the field". A player three holes
into a round sitting at +1 has not shot +1 — counting them would make the penalty
read far too soft all morning and then lurch when the stragglers signed their
cards.

Restricting it to finished 18s makes the number honest at every moment. It starts
as soon as the first card is signed and can only ever **rise** as more players
come in — a manager never sees their penalty move in their favour. While anyone is
still on the course it is shown as *provisional*, with a count of how many can
still post worse; once the last card is in, it is final. No polling interval or
end-of-day batch job is needed: it converges by itself.
- **Ties** are broken by whose **predicted winning score** is closest to the
  actual winning score.

### A playoff never changes a golfer's score

If two or more players tie for the win they go to a **playoff** — extra holes to
decide the trophy. ESPN reports those holes as a further round (period 5+) on the
golfers involved, and left alone that would wreck the fantasy maths two ways: the
golfers *in* the playoff would have their extra-hole strokes added to their total
(penalising them for tying for the win), and every golfer *not* in it could be
charged a "missed round" penalty for a round they were never part of.

The fantasy score is a **72-hole to-par figure**, so a playoff must not touch it
at all. Any round beyond `TOURNAMENT_ROUNDS` (4) is therefore dropped the moment
the feed is parsed — it never reaches the round count, the penalty maths, the
totals or the scorecards. A golfer's overall to-par comes from ESPN's own `score`,
which already excludes playoff strokes, so the two always agree. The winner and
the runner-up finish level on fantasy score, exactly as they finished level over
72 holes. `tests.js` pins this under "playoff contingency".

### The playoff winner earns a one-stroke draft bonus

Leaving the winner and runner-up dead level is fair on **strokes**, but it means
someone who picked the eventual champion gets no reward over someone who picked
the golfer they beat. So there is one deliberate exception, and it lives entirely
in the **draft order**, never in a score.

The golfer who **wins** the playoff gives their owners a **−1 bonus**. Concretely:

- No stroke count is touched. Every golfer's total stays a clean 72-hole figure —
  the winner and runner-up are still level at, say, −12. Participating in a
  playoff never penalises or adjusts anyone's score.
- The bonus is a **separate figure** applied to the entry's *draft-order* total
  (`adjustedTotal`). The board shows the real combined score and the −1 bonus
  side by side, tagged as a bonus, so the two are never confused.
- It is decided **only once the championship is complete**, so it never flickers
  on while the extra holes are still being played. The winner is read off the
  feed as the playoff participant with the best (lowest) aggregate over the extra
  holes — the same way the trophy is decided.
- Every manager who drafted the winner gets it (Scheffler carries seven owners);
  a manager who drafted the *runner-up* gets nothing. That is the whole point:
  picking the right golfer of a playoff pair now beats picking the wrong one.

`tests.js` pins this under "playoff winner bonus".

### Dead heats are deliberately left unresolved

The tiebreaker can itself tie. Jack and Patrick John Kealy III both predicted −9,
so if they ever finish level on combined score, nothing separates them. Two
predictions can also sit an equal distance either side of the winning score — if
the winner finishes at −10, then −9 and −11 are both exactly one stroke off.

**This is a known gap and the league has chosen to leave it open.** A second
tiebreaker will be agreed before the draft in August, if it turns out to be
needed at all.

So the dashboard must not paper over it. When a dead heat occurs the affected
managers get a red **"dead heat — league must settle"** badge, and the ordering
between them is arbitrary and meaningless. Do **not** "fix" this by adding a
silent fallback (alphabetical, entry order, closest-without-going-over, or
anything else) — inventing an order would hide the very situation the league
needs to be told about. `tests.js` pins this behaviour under "unresolved ties".

## The four tabs

The view is stored in the URL hash, so links are shareable and the browser's back
button moves between tabs.

- **Draft order** (`#draft`) — the home tab. Who picks when.
- **Score tracker** (`#tracker`) — every predicted winning score plotted against
  the live leader, ranked by who's closest.
- **Golfers & cut** (`#golfers`) — all eleven drafted golfers with their real
  live scores, split by the cut line: above it you survive, below it you're going
  home. Each active golfer shows a live status pill next to their name — *thru N*
  while they're out, *F* once the round's signed.
- **Scorecards** (`#cards`) — live position, today's score, holes played and a
  hole-by-hole card for every drafted golfer.

### Tee times for upcoming rounds

Any golfer who has **not yet started their next round** shows a ⛳ tee-time chip —
on the draft board, the leaderboard and the scorecards. A golfer who is mid-round,
has finished the tournament, or missed the cut has no upcoming round, so no chip.
The chip stays up until the golfer has actually **played a hole** — a placeholder
round score ESPN can hang on a player at the tee doesn't drop it early, so it
lasts until the tee genuinely occurs, then clears itself.

**Tee times are fetched automatically** — no manual entry. ESPN's public
scoreboard (the feed the site itself reads) carries no tee times, but ESPN's
deeper *core* API does, on each competitor's status. That API sends no CORS
headers, so the browser can't read it directly; instead a scheduled GitHub
Action (`.github/workflows/tee-times.yml`) runs `scripts/fetch-tee-times.mjs`
every 15 minutes, pulls the upcoming-round tee time for each drafted golfer, and
commits `tee-times.json`. The site fetches that file and shows the chips.

```
tee-times.json → { "event": "401811957", "rounds": { "2": { "scheffler": "…Z" } } }
```

`config.js` still has a `TEE_TIMES` map as a manual fallback/override — normally
empty, but anything you put there is used when `tee-times.json` can't be loaded.
The Action can be paused any time (Actions tab → tee-times → disable); the site
keeps working, just without new tee times. It only commits when a time actually
changes, so it doesn't spam the history.

The time is rendered in **the viewer's own local timezone** — the browser knows
where you are, so a manager in California sees Pacific and one in Scotland sees
BST from the same shared instant, each with the zone spelled out (e.g.
`⛳ 9:15 AM BST`) so a screenshot is never ambiguous. The weekday is added when the
tee isn't today.

### What the Scorecards tab can and cannot show

It shows live tournament position, today's round score, "thru" count, total, and
an 18-hole grid coloured eagle / birdie / par / bogey / double+. Unplayed holes
are drawn as empty outlines, so a card fills in as the round goes on.

It does **not** show where a ball is on the hole, or which stroke a player is on
mid-hole. That data does not exist in any free feed. ESPN's own metadata says so
outright:

```
shotChartAvailable:   false
playByPlayAvailable:  false
playByPlaySource:     { description: "none", state: "none" }
holeByHoleSource:     { description: "feed", state: "full" }   <- what we use
```

Shot positions come from the PGA Tour's ShotLink system (laser-surveyed GPS, the
data behind the TV shot tracers), which is proprietary and licensed. A hole is
therefore only ever *played* or *not played* here — there is no mid-hole state,
and none is invented.

**Tournament position is computed by us, not read from the feed.** We rank the
whole field by total using standard competition ranking (ties share a position
and the next player skips: 1, T2, T2, 4). Players who missed the cut are excluded
from the ranking pool and shown as `CUT`.

**Hole colours rely on one property of the feed:** each hole's `scoreType` is that
hole's score to par, not a running total. This is asserted against real data in
`tests.js` — every full card in a real event sums hole-by-hole to its round score
(454 of them), and the derived pars reconstruct a par-70 course.

### How the cut line is worked out

The Open cuts to the **top 70 and ties** after 36 holes, so the line is not a
fixed number:

- **Rounds 1–2** it's a *projection*. We sort the field on their running totals
  and read off the 70th score; anyone level with it is inside too. This number
  moves all through Friday.
- **Round 3 onward** it's a *fact*. Anyone with a third-round score survived, and
  the line is the worst 36-hole total among them.

This view shows each golfer's **real** score, not their penalised fantasy score —
it's about the golfer, not the maths. The penalty only appears on the draft board.

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
