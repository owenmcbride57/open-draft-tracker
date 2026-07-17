// Inherit the version we were loaded at (see index.html) so config.js can't be
// served from a different cache generation than this file.
const { EVENT, GOLFERS, ENTRIES, CUT_SIZE, TOURNAMENT_ROUNDS } = await import(
  `./config.js${new URL(import.meta.url).search}`
);

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard';

// ESPN reports every score relative to par as a display string: "E", "-5", "+8".
function toPar(displayValue) {
  if (displayValue == null) return null;
  const v = String(displayValue).trim();
  if (v === 'E' || v === '-') return 0;
  const n = Number(v.replace('+', ''));
  return Number.isFinite(n) ? n : null;
}

export function formatToPar(n) {
  if (n == null) return '—';
  if (n === 0) return 'E';
  return n > 0 ? `+${n}` : `${n}`;
}

export async function fetchLeaderboard({ demo = false } = {}) {
  // Demo mode replays a real completed tournament (the 2026 Scottish Open, which
  // had a genuine 36-hole cut) with our golfers' ids grafted onto real
  // scorelines, so the league can see how the finished board will look before a
  // ball is struck at The Open. Everything downstream is the production code path.
  const date = demo ? '20260709' : EVENT.date;
  const wanted = demo ? 'Genesis Scottish Open' : EVENT.name;

  const res = await fetch(`${SCOREBOARD}?dates=${date}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
  const data = await res.json();

  const event = demo
    ? (data.events || []).find((e) => e.name === wanted)
    : (data.events || []).find((e) => e.id === EVENT.id) ||
      (data.events || []).find((e) => e.name === EVENT.name);
  if (!event) throw new Error(`Could not find ${wanted} in the ESPN feed`);

  if (demo) applyDemoIdentities(event);

  const competition = event.competitions?.[0] || {};
  const status = event.status?.type || {};

  // Flatten the field into something we can reason about.
  const field = (competition.competitors || []).map((c) => {
    const rounds = {}; // round number -> score to par for that round
    const holes = {}; // round number -> holes completed in it (18 = round done)
    const cards = {}; // round number -> [{ hole, strokes, result }] in hole order

    for (const ls of c.linescores || []) {
      // A tie for the win is settled by a playoff, which ESPN reports as further
      // rounds (period 5+). Those extra holes decide the trophy, not the score —
      // the fantasy total is a 72-hole figure — so a golfer dragged into a playoff
      // must be neither charged nor credited for it. Dropping the period here is
      // the whole contingency: it never reaches roundsStarted, the penalty maths,
      // the totals or the scorecards. (The golfer's overall to-par total comes
      // from ESPN's own `score`, which already excludes playoff strokes.)
      if (Number(ls.period) > TOURNAMENT_ROUNDS) continue;

      const par = toPar(ls.displayValue);
      if (par == null) continue;
      rounds[ls.period] = par;

      // ESPN nests the hole-by-hole card inside each round. Each hole carries
      // the strokes taken (value) and that hole's result to par (scoreType,
      // e.g. "-1" birdie, "E" par, "+1" bogey — verified: the per-hole results
      // sum exactly to the round total). A round with fewer than 18 holes is
      // still in progress, and its round score is only a running total.
      const perHole = (ls.linescores || [])
        .map((h) => ({
          hole: h.period, // the actual hole number, e.g. 10 for a back-nine start
          strokes: h.value,
          result: h.scoreType?.displayValue ?? 'E',
        }))
        .sort((a, b) => a.hole - b.hole);

      holes[ls.period] = perHole.length;
      cards[ls.period] = perHole;
    }

    // ESPN carries the tee time for the round the player is about to (or has
    // just begun to) play on the competitor's status, alongside which round
    // (period) it refers to. We keep the raw ISO instant — the browser turns it
    // into the viewer's own local time at render — and never invent one: if the
    // feed hasn't published the next round's pairings yet, teeTime is simply null.
    const st = c.status || {};

    return {
      id: c.id,
      name: c.athlete?.displayName || 'Unknown',
      rounds,
      holes,
      cards,
      roundsPlayed: Object.keys(rounds).length,
      total: toPar(c.score),
      teeTime: st.teeTime ?? null,
      teePeriod: st.period ?? null,
    };
  });

  return {
    field,
    started: status.name !== 'STATUS_SCHEDULED',
    complete: status.completed === true,
    statusDetail: status.detail || status.description || '',
    startDate: event.date,
  };
}

// Graft our golfers onto real scorelines from a completed event. Deliberately
// hands three of them to players who missed the cut so the penalty rule is
// visible on the board. Demo only — never touches the live path.
function applyDemoIdentities(event) {
  const competitors = event.competitions?.[0]?.competitors || [];

  // The replayed event has a real field, and several of our golfers actually
  // played in it. Grafting our ids on top would create duplicate athlete ids —
  // the lookup map would keep whichever came last, and the leader panel could
  // then disagree with the golfer board about the same person. Retire the real
  // entries first so every id in the demo field is unique.
  const ourIds = new Set(Object.values(GOLFERS).map((g) => g.id));
  for (const c of competitors) {
    if (ourIds.has(c.id)) c.id = `real-${c.id}`;
  }

  const madeCut = competitors.filter((c) => (c.linescores || []).length === 4);
  const missedCut = competitors.filter((c) => (c.linescores || []).length === 2);

  const keys = Object.keys(GOLFERS);
  // Spread the survivors across the leaderboard rather than stacking them at the top.
  const survivors = [0, 2, 5, 9, 14, 22, 31, 48].map((i) => madeCut[i]).filter(Boolean);
  const casualties = [1, 12, 30].map((i) => missedCut[i]).filter(Boolean);
  const slots = [...survivors, ...casualties];

  keys.forEach((key, i) => {
    const slot = slots[i];
    if (!slot) return;
    slot.id = GOLFERS[key].id;
    slot.athlete = { ...(slot.athlete || {}), displayName: GOLFERS[key].name };
  });
}

// Where the cut currently sits.
//
// Rounds 1-2: a projection. Sort the field on their running total and read off
// the score of the player in CUT_SIZE-th place; everyone level with them is
// inside too ("and ties"). This number moves all through Friday.
//
// Round 3+: the cut has happened, so it's a fact, not a guess. Anyone with a
// third-round score survived it, and the line is the worst 36-hole total among
// them.
function computeCut(field, roundsStarted) {
  if (roundsStarted === 0) return { line: null, decided: false };

  if (roundsStarted >= 3) {
    const survivors = field.filter((p) => p.rounds[3] != null);
    if (survivors.length === 0) return { line: null, decided: true };
    const line = Math.max(
      ...survivors.map((p) => (p.rounds[1] ?? 0) + (p.rounds[2] ?? 0)),
    );
    return { line, decided: true };
  }

  const totals = field
    .map((p) => p.total)
    .filter((t) => t != null)
    .sort((a, b) => a - b);
  if (totals.length === 0) return { line: null, decided: false };

  const line = totals[Math.min(CUT_SIZE - 1, totals.length - 1)];
  return { line, decided: false };
}

const HOLES = 18;

// The worst score anyone in the field has POSTED in a given round — the penalty
// a missed-cut golfer is charged for it.
//
// Only completed rounds count. A player three holes into a round sitting at +1
// has not "shot +1"; counting them would drag the worst-in-field far too soft
// all morning and then lurch as the stragglers sign their cards. Restricting to
// finished 18s means the number is honest at every moment: it can only ever go
// up as more cards come in, and by the time the round is done it is final.
function worstInRound(field, round) {
  let worst = null;
  let posted = 0;
  let playing = 0;

  for (const p of field) {
    const score = p.rounds[round];
    if (score == null) continue;

    const done = (p.holes?.[round] ?? HOLES) >= HOLES;
    if (!done) {
      playing++;
      continue;
    }

    posted++;
    if (worst == null || score > worst) worst = score;
  }

  return {
    score: worst,
    posted, // how many players have finished this round
    playing, // how many are still out there and could yet post worse
    settled: playing === 0 && posted > 0,
  };
}

// Did this player miss the cut? Only knowable once round 3 exists: a survivor
// has a third-round score, a casualty stops at 36 holes.
function missedCut(player, cut) {
  return cut.decided && player.roundsPlayed > 0 && player.rounds[3] == null;
}

// The tee time for a golfer's *upcoming* round — but only while they genuinely
// have not started it. Returns the raw ISO instant (formatted into the viewer's
// local time by the render layer) or null.
//
// "Not started their next round" is read off the feed rather than guessed: the
// tee time is stamped with the round (period) it belongs to, so if the golfer
// already has a card for that round they're mid-play — nothing to count down to.
// Before the tournament this is their round-1 tee; between rounds it becomes the
// next round's tee the moment ESPN publishes the pairing, and until then it's
// null. A golfer who has finished the tournament, or missed the cut, has no next
// round and so no upcoming tee.
function upcomingTee(player, cut) {
  const iso = player.teeTime;
  if (!iso || !Number.isFinite(Date.parse(iso))) return null;
  if (missedCut(player, cut)) return null;

  const period = player.teePeriod;
  // A tee time for a playoff (a period beyond the tournament's rounds) is not a
  // "next round" the fantasy scoring recognises — the event is scored over its
  // rounds only — so there is nothing upcoming to show.
  if (period != null && period > TOURNAMENT_ROUNDS) return null;
  if (period != null) {
    // They've begun the round the tee time is for → it's not upcoming.
    const begun = player.rounds[period] != null || (player.holes?.[period] ?? 0) > 0;
    if (begun) return null;
  } else if (player.roundsPlayed > 0) {
    // No period in the feed: fall back to progress. Only a golfer whose latest
    // round is complete is waiting on a next tee; a mid-round one is not.
    const cur = Math.max(...Object.keys(player.rounds).map(Number));
    if ((player.holes?.[cur] ?? 0) < HOLES) return null;
  }
  return iso;
}

// Live tournament position, computed from the field rather than read off a feed
// field we can't verify until play starts. Standard competition ranking: ties
// share a position and the next player skips (1, T2, T2, 4). Players who missed
// the cut are not ranked among the survivors.
function computeFieldRanks(field, cut) {
  const active = field
    .filter((p) => p.total != null && p.roundsPlayed > 0 && !missedCut(p, cut))
    .sort((a, b) => a.total - b.total);

  const rankById = new Map();
  let i = 0;
  while (i < active.length) {
    let j = i;
    while (j + 1 < active.length && active[j + 1].total === active[i].total) j++;
    for (let k = i; k <= j; k++) {
      rankById.set(active[k].id, { pos: i + 1, tied: j > i });
    }
    i = j + 1;
  }
  return rankById;
}

export function computeStandings(board) {
  const { field, started } = board;
  const byId = new Map(field.map((p) => [p.id, p]));

  // How far into the tournament are we? A round "counts" once anyone has a
  // score for it. Before Thursday this is 0 and nothing is penalised.
  let roundsStarted = 0;
  for (const p of field) {
    for (const r of Object.keys(p.rounds)) roundsStarted = Math.max(roundsStarted, Number(r));
  }

  // Penalty per round, computed live from the field. Early in a round nobody has
  // posted a card yet, so there is no worst score to charge — we simply don't
  // penalise that round until the first player signs for one.
  const penalties = {};
  for (let r = 1; r <= roundsStarted; r++) penalties[r] = worstInRound(field, r);

  // Running winning score — the leader's total. Used for the tiebreaker.
  // Only meaningful once shots have actually been hit: before Thursday ESPN
  // reports the whole field at "E", which would make the tiebreaker fire
  // against a winning score of zero and produce a fake-looking ranking.
  const winningScore =
    roundsStarted === 0
      ? null
      : field.reduce(
          (best, p) => (p.total != null && (best == null || p.total < best) ? p.total : best),
          null,
        );

  // Where the cut currently sits. Computed up front because the draft board, the
  // golfer board and the scorecards all need it — not least to know whether a
  // golfer even has a next round to show a tee time for.
  const cut = computeCut(field, roundsStarted);

  const rows = ENTRIES.map((entry) => {
    const golfers = entry.picks.map((key) => {
      const meta = GOLFERS[key];
      const player = byId.get(meta.id);

      if (!player) {
        return { ...meta, missing: true, total: null, rounds: {}, penaltyRounds: [] };
      }

      // Sum the golfer's actual round scores, substituting the field's worst
      // score for any round they did not play (i.e. they missed the cut or WD'd).
      let total = 0;
      const penaltyRounds = [];
      for (let r = 1; r <= roundsStarted; r++) {
        if (player.rounds[r] != null) {
          total += player.rounds[r];
        } else if (penalties[r]?.score != null) {
          total += penalties[r].score;
          penaltyRounds.push({
            round: r,
            score: penalties[r].score,
            // Still players on the course who could post worse — this number can
            // only rise from here.
            provisional: !penalties[r].settled,
          });
        }
      }

      // Live progress through the golfer's current round, for the draft board's
      // per-golfer hole indicator (not started → thru N → round complete). ESPN
      // has no mid-hole state, so a hole is only ever played or not — "thru N"
      // counts the holes whose cards are in.
      let thru = 0;
      let currentRound = 0;
      let roundComplete = false;
      if (player.roundsPlayed > 0) {
        currentRound = Math.max(...Object.keys(player.rounds).map(Number));
        thru = player.holes?.[currentRound] ?? 0;
        roundComplete = thru >= HOLES;
      }

      return {
        ...meta,
        missing: false,
        espnName: player.name,
        rounds: player.rounds,
        actual: player.total,
        total: roundsStarted > 0 ? total : null,
        penaltyRounds,
        cut: penaltyRounds.length > 0,
        thru,
        currentRound,
        roundComplete,
        // Tee time for the round they're waiting to start (null once they've begun).
        teeTime: upcomingTee(player, cut),
      };
    });

    const total = roundsStarted > 0
      ? golfers.reduce((sum, g) => sum + (g.total ?? 0), 0)
      : null;

    const tiebreak = winningScore != null ? Math.abs(entry.prediction - winningScore) : null;

    return { ...entry, golfers, total, tiebreak };
  });

  // Lowest combined score picks first. Ties broken by whose predicted winning
  // score is closest to the actual one. Before a ball is struck there is nothing
  // to rank, so leave the entries in their listed order rather than implying one.
  if (roundsStarted > 0) {
    rows.sort((a, b) => {
      if (a.total !== b.total) return (a.total ?? 0) - (b.total ?? 0);
      if (a.tiebreak !== b.tiebreak) return (a.tiebreak ?? 0) - (b.tiebreak ?? 0);
      return a.manager.localeCompare(b.manager);
    });
  }

  // Flag rows whose position was decided by the tiebreaker, and — importantly —
  // rows the tiebreaker could NOT decide. Several managers predicted the same
  // score (Jack and Patrick both said -9), and two predictions can also sit an equal
  // distance either side of the winning score. In those cases the order below is
  // arbitrary and the league has to settle it, so say so rather than pretending.
  rows.forEach((row, i) => {
    row.pick = i + 1;
    if (!started || row.total == null) {
      row.tiedOnScore = false;
      row.unresolved = false;
      row.unresolvedWith = [];
      return;
    }
    const tiedOnScore = rows.filter((r) => r !== row && r.total === row.total);
    const stillTied = tiedOnScore.filter((r) => r.tiebreak === row.tiebreak);

    row.tiedOnScore = tiedOnScore.length > 0;
    row.unresolved = stillTied.length > 0;
    row.unresolvedWith = stillTied.map((r) => r.manager);
  });

  // Who is actually leading — there is often more than one, and at The Open the
  // leader is frequently someone nobody in the league picked.
  const leaders =
    winningScore == null
      ? []
      : field.filter((p) => p.total === winningScore).map((p) => p.name);

  // Everyone's prediction measured against the live leader, closest first. This
  // is the tiebreaker in flight: it only settles the draft if managers finish
  // level on combined score, but it's the number the league will be watching.
  const predictions = ENTRIES.map((e) => ({
    manager: e.manager,
    prediction: e.prediction,
    delta: winningScore == null ? null : Math.abs(e.prediction - winningScore),
    // Is the leader currently better (lower) than they predicted?
    direction:
      winningScore == null || e.prediction === winningScore
        ? 'exact'
        : winningScore < e.prediction
          ? 'under' // leader is beating the prediction
          : 'over', // leader hasn't reached the prediction yet
  })).sort((a, b) =>
    // Once there's a leader, closest prediction first. Before that there is no
    // "closest", so order by the call itself — boldest to most conservative.
    winningScore == null
      ? a.prediction - b.prediction || a.manager.localeCompare(b.manager)
      : a.delta - b.delta || a.manager.localeCompare(b.manager),
  );

  // Each golfer's actual place in the whole field (not just among the drafted
  // ones), shared by the leaderboard and scorecard views. Standard competition
  // ranking; cut players are excluded from the pool and shown as CUT.
  const rankById = computeFieldRanks(field, cut);

  // Owners are listed side by side against each golfer, so use the short name
  // where one is set. Scheffler carries seven of them.
  const owners = new Map();
  for (const entry of ENTRIES) {
    for (const key of entry.picks) {
      if (!owners.has(key)) owners.set(key, []);
      owners.get(key).push(entry.short ?? entry.manager);
    }
  }

  const golferBoard = Object.entries(GOLFERS)
    .map(([key, meta]) => {
      const player = byId.get(meta.id);
      const total = player?.total ?? null;

      // After the cut, survival is a fact: you have a third round or you don't.
      // Before it, it's a projection against a moving line.
      const survived = player ? player.rounds[3] != null : false;
      const madeCut = cut.decided ? survived : null;
      const projectedIn =
        cut.decided || cut.line == null || total == null ? null : total <= cut.line;

      // Overall place in the field, alongside the golfer's relative placing in
      // this drafted list. A cut golfer is out of the ranked pool → CUT; before
      // there is anything to rank it is simply null (rendered as —).
      const rank = player ? rankById.get(player.id) : null;
      const position = !player
        ? null
        : missedCut(player, cut)
          ? 'CUT'
          : rank
            ? `${rank.tied ? 'T' : ''}${rank.pos}`
            : null;

      return {
        ...meta,
        key,
        owners: owners.get(key) ?? [],
        found: !!player,
        total,
        position,
        rounds: player?.rounds ?? {},
        roundsPlayed: player?.roundsPlayed ?? 0,
        madeCut,
        projectedIn,
        // Strokes inside (negative) or outside (positive) the line.
        toCut: total != null && cut.line != null ? total - cut.line : null,
        inside: cut.decided ? survived : projectedIn,
        // Tee time for their upcoming round, while they've yet to start it.
        teeTime: player ? upcomingTee(player, cut) : null,
      };
    })
    .sort((a, b) => {
      if (a.total == null) return 1;
      if (b.total == null) return -1;
      return a.total - b.total || a.name.localeCompare(b.name);
    });

  // Live scorecards: for each drafted golfer, where they stand right now and the
  // hole-by-hole card for the round they're on. ESPN publishes no shot-level or
  // positional data (shotChartAvailable / playByPlayAvailable are both false),
  // so a hole is only ever "played" or "not played" — there is no mid-hole state
  // to show, and we do not invent one. (rankById is computed above, shared with
  // the leaderboard view.)
  const scorecards = Object.entries(GOLFERS)
    .map(([key, meta]) => {
      const p = byId.get(meta.id);
      const base = { ...meta, key, owners: owners.get(key) ?? [] };

      if (!p) return { ...base, found: false, state: 'missing', total: null, holes: [] };
      if (p.roundsPlayed === 0) {
        return {
          ...base,
          found: true,
          state: 'not-started',
          total: null,
          holes: [],
          thru: 0,
          teeTime: upcomingTee(p, cut),
        };
      }

      const cutGone = missedCut(p, cut);
      const rank = rankById.get(p.id);
      const currentRound = Math.max(...Object.keys(p.rounds).map(Number));
      const card = p.cards?.[currentRound] ?? [];
      const thru = card.length;
      const roundComplete = thru >= 18;

      // Always lay out all 18 holes so the grid reads as a scorecard. A player
      // off the back tee will have holes 10-18 filled and 1-9 empty — that is
      // genuinely their card, not a gap.
      const byHole = new Map(card.map((h) => [h.hole, h]));
      const holes = [];
      for (let h = 1; h <= 18; h++) {
        const played = byHole.get(h);
        holes.push(
          played
            ? { hole: h, strokes: played.strokes, result: played.result, played: true }
            : { hole: h, played: false },
        );
      }

      return {
        ...base,
        found: true,
        state: cutGone ? 'cut' : roundComplete ? 'round-done' : 'playing',
        position: cutGone ? 'CUT' : rank ? `${rank.tied ? 'T' : ''}${rank.pos}` : null,
        total: p.total,
        today: p.rounds[currentRound],
        currentRound,
        thru,
        roundComplete,
        holes,
        // Set only between rounds: the tee time for the round they're yet to start.
        teeTime: upcomingTee(p, cut),
      };
    })
    // Active golfers first, then the cut, then anyone missing; ranked within.
    .sort((a, b) => {
      const group = (g) => (g.state === 'missing' ? 3 : g.state === 'not-started' ? 2 : g.state === 'cut' ? 1 : 0);
      if (group(a) !== group(b)) return group(a) - group(b);
      if (a.total == null) return 1;
      if (b.total == null) return -1;
      return a.total - b.total || a.name.localeCompare(b.name);
    });

  return {
    rows,
    roundsStarted,
    penalties,
    winningScore,
    leaders,
    predictions,
    cut,
    golferBoard,
    scorecards,
  };
}
