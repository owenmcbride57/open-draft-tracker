// Inherit the version we were loaded at (see index.html) so config.js can't be
// served from a different cache generation than this file.
const { EVENT, GOLFERS, ENTRIES, CUT_SIZE } = await import(
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
    for (const ls of c.linescores || []) {
      const par = toPar(ls.displayValue);
      if (par != null) rounds[ls.period] = par;
    }
    return {
      id: c.id,
      name: c.athlete?.displayName || 'Unknown',
      rounds,
      roundsPlayed: Object.keys(rounds).length,
      total: toPar(c.score),
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

// The worst score anyone in the field posted in a given round. This is the
// penalty a missed-cut golfer is charged for that round.
function worstInRound(field, round) {
  let worst = null;
  for (const p of field) {
    const r = p.rounds[round];
    if (r == null) continue;
    if (worst == null || r > worst) worst = r;
  }
  return worst;
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

  // Penalty per round, computed live from the field.
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
        } else if (penalties[r] != null) {
          total += penalties[r];
          penaltyRounds.push({ round: r, score: penalties[r] });
        }
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

  // Every golfer the league drafted, with their real live score (no penalty
  // applied — this view is about the golfer, not the fantasy maths) and where
  // they stand against the cut.
  const cut = computeCut(field, roundsStarted);

  const owners = new Map();
  for (const entry of ENTRIES) {
    for (const key of entry.picks) {
      if (!owners.has(key)) owners.set(key, []);
      owners.get(key).push(entry.manager);
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

      return {
        ...meta,
        key,
        owners: owners.get(key) ?? [],
        found: !!player,
        total,
        rounds: player?.rounds ?? {},
        roundsPlayed: player?.roundsPlayed ?? 0,
        madeCut,
        projectedIn,
        // Strokes inside (negative) or outside (positive) the line.
        toCut: total != null && cut.line != null ? total - cut.line : null,
        inside: cut.decided ? survived : projectedIn,
      };
    })
    .sort((a, b) => {
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
  };
}
