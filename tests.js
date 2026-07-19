// Verifies the scoring rules against both synthetic cases and real ESPN data.
// Open tests.html in a browser to run.
import { EVENT, GOLFERS, ENTRIES } from './config.js';
import { fetchLeaderboard, computeStandings, formatToPar } from './scoring.js';

// This file runs in two places: in the browser via tests.html (results render
// into the page) and under Node via `npm test` (results print to the console and
// the process exits non-zero on any failure). Everything below is written to work
// in either, keying off whether a DOM is present.
const isBrowser = typeof document !== 'undefined';
const out = isBrowser ? document.getElementById('out') : null;
let passed = 0;
let failed = 0;
let skipped = 0;

const assert = {
  ok(cond, msg = 'expected truthy') {
    if (!cond) throw new Error(msg);
  },
  equal(actual, expected, msg) {
    if (actual !== expected) {
      throw new Error(msg ? `${msg} (got ${actual}, expected ${expected})` : `got ${actual}, expected ${expected}`);
    }
  },
  deepEqual(actual, expected, msg) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${msg || 'deepEqual'}\n      got      ${a}\n      expected ${b}`);
  },
};

function log(text, cls = '') {
  if (isBrowser) {
    const el = document.createElement('div');
    el.className = cls;
    el.textContent = text;
    out.appendChild(el);
  } else {
    console.log(text);
  }
}

function group(name) {
  log(name, 'group');
}

function check(name, fn) {
  try {
    fn();
    log(`  ✓ ${name}`, 'pass');
    passed++;
  } catch (err) {
    log(`  ✗ ${name}\n      ${err.message}`, 'fail');
    failed++;
  }
}

// A check that depends on live ESPN data. When the feed can't be reached — a CI
// box with no route to ESPN, an offline run — it is skipped rather than failed,
// so the offline unit suite stays a reliable gate.
let liveDataAvailable = true;
function liveCheck(name, fn) {
  if (!liveDataAvailable) {
    log(`  ~ ${name} (skipped: live feed unavailable)`, 'skip');
    skipped++;
    return;
  }
  check(name, fn);
}

const id = (key) => GOLFERS[key].id;

// By default every round given is a completed 18. Pass `holesInLastRound` to
// leave the final round in progress.
function player(name, rounds, playerId, holesInLastRound = 18) {
  const r = {};
  const h = {};
  const cards = {};
  rounds.forEach((v, i) => {
    const round = i + 1;
    const played = i === rounds.length - 1 ? holesInLastRound : 18;
    r[round] = v;
    h[round] = played;
    // A synthetic card: every hole a par except hole 1, which carries the whole
    // round's score so the per-hole results still sum to the round total.
    cards[round] = Array.from({ length: played }, (_, k) => ({
      hole: k + 1,
      strokes: k === 0 ? 4 + v : 4,
      result: k === 0 ? (v === 0 ? 'E' : v > 0 ? `+${v}` : `${v}`) : 'E',
    }));
  });
  return {
    id: playerId,
    name,
    rounds: r,
    holes: h,
    cards,
    roundsPlayed: rounds.length,
    total: rounds.reduce((a, b) => a + b, 0),
  };
}

function board(field, opts = {}) {
  return { field, started: true, complete: false, statusDetail: '', startDate: '', ...opts };
}

// ---------------------------------------------------------------------------

group('config');

check('every entry has exactly 3 distinct picks that resolve to a known golfer', () => {
  assert.equal(ENTRIES.length, 10, 'expected 10 managers');
  for (const e of ENTRIES) {
    assert.equal(e.picks.length, 3, `${e.manager} does not have 3 picks`);
    for (const p of e.picks) assert.ok(GOLFERS[p], `${e.manager} picked unknown golfer "${p}"`);
    assert.equal(new Set(e.picks).size, 3, `${e.manager} picked the same golfer twice`);
    assert.ok(Number.isInteger(e.prediction), `${e.manager} has no prediction`);
  }
});

check('golfer ESPN ids are unique', () => {
  const ids = Object.values(GOLFERS).map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate ESPN athlete id');
});

group('missed-cut penalty');

check('a cut golfer is charged the field worst for R3 and R4', () => {
  const field = [
    player('Scottie Scheffler', [5, 5], id('scheffler')), // cut after 36
    player('Rory McIlroy', [-3, -3, -3, -3], id('mcilroy')),
    player('Collin Morikawa', [0, 0, 0, 0], id('morikawa')),
    player('Grinder A', [2, 2, 9, 4], 'x1'), // worst R3 = +9
    player('Grinder B', [2, 2, 4, 11], 'x2'), // worst R4 = +11
  ];
  const { rows } = computeStandings(board(field));
  const jack = rows.find((r) => r.manager === 'Jack');
  const s = jack.golfers.find((g) => g.id === id('scheffler'));

  assert.equal(s.cut, true, 'should be flagged as cut');
  assert.deepEqual(
    s.penaltyRounds,
    [
      { round: 3, score: 9, provisional: false },
      { round: 4, score: 11, provisional: false },
    ],
    'should take the field worst in each missed round',
  );
  assert.equal(s.total, 30, '5 + 5 + 9 + 11');
  assert.equal(jack.total, 18, 'Scheffler 30 + McIlroy -12 + Morikawa 0');
});

check('a golfer who made the cut takes no penalty', () => {
  const field = [
    player('Scottie Scheffler', [-2, -2, -2, -2], id('scheffler')),
    player('Rory McIlroy', [-1, -1, -1, -1], id('mcilroy')),
    player('Collin Morikawa', [0, 0, 0, 0], id('morikawa')),
    player('Grinder A', [2, 2, 12, 12], 'x1'),
  ];
  const { rows } = computeStandings(board(field));
  const jack = rows.find((r) => r.manager === 'Jack');
  for (const g of jack.golfers) {
    assert.equal(g.cut, false, `${g.name} should not be cut`);
    assert.equal(g.penaltyRounds.length, 0);
  }
  assert.equal(jack.total, -12, '-8 + -4 + 0');
});

check('no penalty for rounds that have not started yet', () => {
  const field = [
    player('Scottie Scheffler', [4, 4], id('scheffler')),
    player('Rory McIlroy', [-2, -2], id('mcilroy')),
    player('Collin Morikawa', [0, 0], id('morikawa')),
    player('Grinder A', [8, 8], 'x1'),
  ];
  const { rows, roundsStarted } = computeStandings(board(field));
  assert.equal(roundsStarted, 2);
  const jack = rows.find((r) => r.manager === 'Jack');
  assert.equal(jack.total, 4, 'just the 36-hole totals: 8 + -4 + 0');
  assert.ok(jack.golfers.every((g) => !g.cut), 'nobody is cut before R3 exists');
});

group('live worst-score-of-the-day');

check('players still out on the course do not set the worst score', () => {
  // Rory missed the cut. Round 3 is underway: one player has POSTED +6, another
  // is only 5 holes in at +2. The +2 must not count as a round score — he has
  // not shot +2, he is merely +2 so far.
  const field = [
    player('Rory McIlroy', [5, 5], GOLFERS.mcilroy.id), // cut
    player('Posted A', [0, 0, 6, 0], 'p1'), // finished R3 at +6
    player('Posted B', [0, 0, 3, 0], 'p2'), // finished R3 at +3
    player('Still Playing', [0, 0, 2], 'p3', 5), // 5 holes into R3, +2 so far
  ];
  const { penalties } = computeStandings(board(field));

  assert.equal(penalties[3].score, 6, 'worst POSTED round is +6, not the in-progress +2');
  assert.equal(penalties[3].posted, 2, 'two players have signed for a third round');
  assert.equal(penalties[3].playing, 1, 'one is still out there');
  assert.equal(penalties[3].settled, false, 'cannot be final while someone can still post worse');
});

check('the penalty settles once the last card is in', () => {
  const field = [
    player('Rory McIlroy', [5, 5], GOLFERS.mcilroy.id),
    player('Posted A', [0, 0, 6, 0], 'p1'),
    player('Posted B', [0, 0, 9, 0], 'p2'),
  ];
  const { penalties } = computeStandings(board(field));

  assert.equal(penalties[3].score, 9);
  assert.equal(penalties[3].playing, 0);
  assert.equal(penalties[3].settled, true, 'nobody left on the course, so it is final');
});

check('the live penalty only ever rises as more cards come in', () => {
  // Same round, sampled at three points in the day. The number must be
  // monotonic — a manager should never see their penalty get *better*.
  const cutGolfer = () => player('Rory McIlroy', [5, 5], GOLFERS.mcilroy.id);

  const morning = computeStandings(
    board([cutGolfer(), player('A', [0, 0, 2, 0], 'a'), player('B', [0, 0, 1], 'b', 4)]),
  );
  const afternoon = computeStandings(
    board([cutGolfer(), player('A', [0, 0, 2, 0], 'a'), player('B', [0, 0, 5, 0], 'b')]),
  );
  const evening = computeStandings(
    board([
      cutGolfer(),
      player('A', [0, 0, 2, 0], 'a'),
      player('B', [0, 0, 5, 0], 'b'),
      player('C', [0, 0, 11, 0], 'c'),
    ]),
  );

  assert.equal(morning.penalties[3].score, 2, 'only A has posted');
  assert.equal(afternoon.penalties[3].score, 5, 'B signs for +5');
  assert.equal(evening.penalties[3].score, 11, 'C limps in at +11');
  assert.ok(
    morning.penalties[3].score <= afternoon.penalties[3].score &&
      afternoon.penalties[3].score <= evening.penalties[3].score,
    'the penalty must never move in the golfer’s favour',
  );
});

check('a round nobody has finished yet charges no penalty at all', () => {
  const field = [
    player('Rory McIlroy', [5, 5], GOLFERS.mcilroy.id), // cut
    player('Early Bird', [0, 0, 1], 'p1', 3), // 3 holes into R3
  ];
  const { penalties, rows } = computeStandings(board(field));

  assert.equal(penalties[3].score, null, 'no completed round 3 exists yet');
  assert.equal(penalties[3].posted, 0);

  // Rory should carry only his real 36 holes — no invented third-round number.
  const harry = rows.find((r) => r.manager === 'Harry');
  const rory = harry.golfers.find((g) => g.id === GOLFERS.mcilroy.id);
  assert.equal(rory.total, 10, 'just +5 +5; nothing added for the unfinished round');
  assert.equal(rory.penaltyRounds.length, 0);
});

check('a provisional penalty is flagged as such', () => {
  const field = [
    player('Rory McIlroy', [5, 5], GOLFERS.mcilroy.id),
    player('Posted', [0, 0, 7, 0], 'p1'),
    player('Still Playing', [0, 0, 1], 'p2', 9),
  ];
  const { rows } = computeStandings(board(field));
  const harry = rows.find((r) => r.manager === 'Harry');
  const rory = harry.golfers.find((g) => g.id === GOLFERS.mcilroy.id);

  const r3 = rory.penaltyRounds.find((p) => p.round === 3);
  assert.equal(r3.score, 7);
  assert.equal(r3.provisional, true, 'someone is still out, so this can still get worse');
});

group('ranking + tiebreak');

check('lowest combined score picks first, highest picks last', () => {
  const field = [
    player('Scottie Scheffler', [-5, -5, -5, -5], id('scheffler')),
    player('Rory McIlroy', [0, 0, 0, 0], id('mcilroy')),
    player('Collin Morikawa', [0, 0, 0, 0], id('morikawa')),
    player('Tommy Fleetwood', [0, 0, 0, 0], id('fleetwood')),
    player('Matt Fitzpatrick', [0, 0, 0, 0], id('fitzpatrick')),
    player('Justin Rose', [0, 0, 0, 0], id('rose')),
    player('Cameron Young', [0, 0, 0, 0], id('young')),
    player('Jon Rahm', [3, 3, 3, 3], id('rahm')),
    player('Bryson DeChambeau', [3, 3, 3, 3], id('dechambeau')),
    player('Viktor Hovland', [0, 0, 0, 0], id('hovland')),
    player('Ludvig Åberg', [0, 0, 0, 0], id('aberg')),
  ];
  const { rows } = computeStandings(board(field));
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].total >= rows[i - 1].total, 'board must be sorted ascending');
    assert.equal(rows[i].pick, i + 1);
  }
  assert.equal(rows[0].pick, 1);
  // Harry: McIlroy 0 + Rahm +12 + DeChambeau +12 = +24, the worst haul.
  assert.equal(rows[rows.length - 1].manager, 'Harry', 'Harry should pick last');
});

check('ties are broken by the prediction closest to the winning score', () => {
  // All ten managers tie at E; the field leader finishes at -10.
  const field = [
    ...Object.values(GOLFERS).map((g) => player(g.name, [0, 0, 0, 0], g.id)),
    player('Some Winner', [-4, -3, -2, -1], 'w1'),
  ];
  const { rows, winningScore } = computeStandings(board(field));
  assert.equal(winningScore, -10);
  assert.ok(rows.every((r) => r.total === 0), 'everyone should be tied on score');

  assert.equal(rows[0].manager, 'Ferrell', 'predicted -10, exactly right');
  assert.equal(rows[0].tiebreak, 0);

  // Jack (-9), Patrick John Kealy III (-9) and Sweeney (-11) are all exactly
  // 1 off. The tiebreaker does not separate them, so they are ordered
  // alphabetically. See "unresolved ties" below.
  assert.deepEqual(
    rows.slice(1, 4).map((r) => r.manager),
    ['Jack', 'Patrick John Kealy III', 'Sweeney'],
    'the three managers 1 stroke off should sort together',
  );
  assert.ok(rows.slice(1, 4).every((r) => r.tiebreak === 1));

  assert.equal(rows[rows.length - 1].manager, 'AJ', 'predicted -16, furthest off');
  assert.equal(rows[rows.length - 1].tiebreak, 6);
  assert.ok(rows.every((r) => r.tiedOnScore), 'rows should be flagged as tied');
});

group('unresolved ties');

check('managers level on score AND equally off on prediction are flagged, not silently ordered', () => {
  // Jack and Patrick John Kealy III both predicted -9, so if they tie on
  // combined score the tiebreaker can never separate them. And with the winner
  // at -12, Coop (-15) is 3 off too — a three-way dead heat the rules as
  // written cannot settle.
  const field = [
    ...Object.values(GOLFERS).map((g) => player(g.name, [0, 0, 0, 0], g.id)),
    player('Some Winner', [-3, -3, -3, -3], 'w1'), // -12
  ];
  const { rows, winningScore } = computeStandings(board(field));
  assert.equal(winningScore, -12);

  const jack = rows.find((r) => r.manager === 'Jack');
  const pj = rows.find((r) => r.manager === 'Patrick John Kealy III');
  const coop = rows.find((r) => r.manager === 'Coop');

  assert.equal(jack.total, pj.total, 'tied on combined score');
  assert.equal(jack.tiebreak, 3);
  assert.equal(pj.tiebreak, 3);
  assert.equal(coop.tiebreak, 3);
  assert.ok(jack.unresolved && pj.unresolved && coop.unresolved, 'all three flagged');
  assert.deepEqual(
    jack.unresolvedWith,
    ['Coop', 'Patrick John Kealy III'],
    'Jack should be told exactly who he is still level with',
  );
});

check('a manager whose prediction is unique among the tied group is resolved cleanly', () => {
  // Winner at -10: Ferrell predicted -10 exactly, nobody else did.
  const field = [
    ...Object.values(GOLFERS).map((g) => player(g.name, [0, 0, 0, 0], g.id)),
    player('Some Winner', [-4, -3, -2, -1], 'w1'), // -10
  ];
  const { rows } = computeStandings(board(field));
  const ferrel = rows.find((r) => r.manager === 'Ferrell');
  assert.equal(ferrel.pick, 1, 'nailed the prediction, so picks first');
  assert.equal(ferrel.tiedOnScore, true, 'was tied on score...');
  assert.equal(ferrel.unresolved, false, '...but the prediction settled it outright');
});

group('current leader tracker');

check('reports the leader, and every manager who shares the lead', () => {
  const field = [
    ...Object.values(GOLFERS).map((g) => player(g.name, [0, 0, 0, 0], g.id)),
    player('Leader One', [-3, -3, -3, -3], 'w1'), // -12
    player('Leader Two', [-6, -2, -2, -2], 'w2'), // -12, co-leader
    player('Chasing', [-2, -2, -2, -2], 'w3'), // -8
  ];
  const { winningScore, leaders } = computeStandings(board(field));
  assert.equal(winningScore, -12);
  assert.deepEqual(leaders.sort(), ['Leader One', 'Leader Two'], 'a shared lead lists both');
});

check('predictions are ranked by distance from the leader, closest first', () => {
  const field = [
    ...Object.values(GOLFERS).map((g) => player(g.name, [0, 0, 0, 0], g.id)),
    player('Some Winner', [-3, -3, -3, -3], 'w1'), // -12
  ];
  const { predictions } = computeStandings(board(field));

  assert.equal(predictions[0].manager, 'Goon', 'predicted -12, exactly right');
  assert.equal(predictions[0].delta, 0);
  assert.equal(predictions[0].direction, 'exact');

  // Deltas must be non-decreasing down the list.
  for (let i = 1; i < predictions.length; i++) {
    assert.ok(predictions[i].delta >= predictions[i - 1].delta, 'must be sorted by delta');
  }

  // Harry called -5; the leader at -12 has blown past it.
  const harry = predictions.find((p) => p.manager === 'Harry');
  assert.equal(harry.delta, 7);
  assert.equal(harry.direction, 'under', 'leader is better than Harry predicted');

  // AJ called -16; the leader has not got there yet.
  const aj = predictions.find((p) => p.manager === 'AJ');
  assert.equal(aj.delta, 4);
  assert.equal(aj.direction, 'over', 'leader has not reached AJ’s number');
});

check('before the tournament starts there is no leader and no closest prediction', () => {
  const field = Object.values(GOLFERS).map((g) => player(g.name, [], g.id));
  const { winningScore, leaders, predictions } = computeStandings(
    board(field, { started: false }),
  );
  assert.equal(winningScore, null, 'no leader before a ball is struck');
  assert.deepEqual(leaders, []);
  assert.ok(predictions.every((p) => p.delta === null), 'no deltas without a leader');
  // Falls back to ordering by the call itself: boldest (-16) first.
  assert.equal(predictions[0].manager, 'AJ');
  assert.equal(predictions[predictions.length - 1].manager, 'Harry');
});

group('live scorecards');

check('tournament position uses standard ranking — ties share it, the next skips', () => {
  const field = [
    player('Scottie Scheffler', [-6], GOLFERS.scheffler.id), // -6, outright 1st
    player('Rory McIlroy', [-4], GOLFERS.mcilroy.id), // -4, tied
    player('Collin Morikawa', [-4], GOLFERS.morikawa.id), // -4, tied
    player('Jon Rahm', [-1], GOLFERS.rahm.id), // -1, so 4th (2 and 3 consumed)
  ];
  const { scorecards } = computeStandings(board(field));
  const pos = (id) => scorecards.find((g) => g.id === id).position;

  assert.equal(pos(GOLFERS.scheffler.id), '1', 'outright lead is not tied');
  assert.equal(pos(GOLFERS.mcilroy.id), 'T2');
  assert.equal(pos(GOLFERS.morikawa.id), 'T2');
  assert.equal(pos(GOLFERS.rahm.id), '4', 'two players tied at 2 means the next is 4th');
});

check('a mid-round golfer reports today’s score and holes played', () => {
  const field = [
    player('Scottie Scheffler', [-2, -3], GOLFERS.scheffler.id, 12), // 12 holes into R2
    player('Rory McIlroy', [0, 0], GOLFERS.mcilroy.id),
  ];
  const { scorecards } = computeStandings(board(field));
  const s = scorecards.find((g) => g.id === GOLFERS.scheffler.id);

  assert.equal(s.state, 'playing');
  assert.equal(s.currentRound, 2);
  assert.equal(s.thru, 12, 'twelve holes of round two are in');
  assert.equal(s.today, -3, 'today is the running round score, not the total');
  assert.equal(s.total, -5, 'total is still the full to-par');
  assert.equal(s.roundComplete, false);
});

check('a completed round reads as finished, not still playing', () => {
  const field = [player('Scottie Scheffler', [-2], GOLFERS.scheffler.id, 18)];
  const { scorecards } = computeStandings(board(field));
  const s = scorecards.find((g) => g.id === GOLFERS.scheffler.id);
  assert.equal(s.state, 'round-done');
  assert.equal(s.thru, 18);
  assert.equal(s.roundComplete, true);
});

check('the card lays out all 18 holes, marking the unplayed ones', () => {
  const field = [player('Scottie Scheffler', [-1], GOLFERS.scheffler.id, 5)];
  const { scorecards } = computeStandings(board(field));
  const s = scorecards.find((g) => g.id === GOLFERS.scheffler.id);

  assert.equal(s.holes.length, 18, 'always a full scorecard');
  assert.equal(s.holes.filter((h) => h.played).length, 5, 'five holes played');
  assert.equal(s.holes[0].played, true);
  assert.equal(s.holes[0].hole, 1);
  assert.equal(s.holes[17].played, false, 'hole 18 not reached');
  assert.ok(s.holes.every((h, i) => h.hole === i + 1), 'holes are in course order 1-18');
});

check('a cut golfer is marked CUT and carries no live round', () => {
  const field = [
    player('Rory McIlroy', [4, 4], GOLFERS.mcilroy.id), // no round 3 -> cut
    player('Scottie Scheffler', [-2, -2, -2], GOLFERS.scheffler.id), // survived
  ];
  const { scorecards } = computeStandings(board(field));
  const rory = scorecards.find((g) => g.id === GOLFERS.mcilroy.id);
  const scottie = scorecards.find((g) => g.id === GOLFERS.scheffler.id);

  assert.equal(rory.state, 'cut');
  assert.equal(rory.position, 'CUT', 'not given a live position among survivors');
  assert.equal(scottie.position, '1', 'the survivor is ranked, and the cut player is not in the pool');
});

check('a confirmed missed cut is flagged for the MC badge on every view', () => {
  // The badge keys off madeCut===false (leaderboard) and state==='cut'
  // (scorecards); a survivor must not trip either, and neither must fire before
  // the cut is decided.
  const decided = [
    player('Rory McIlroy', [5, 5], GOLFERS.mcilroy.id), // no round 3 -> cut
    player('Scottie Scheffler', [-2, -2, -2], GOLFERS.scheffler.id), // survived
  ];
  const d = computeStandings(board(decided));
  assert.equal(d.golferBoard.find((g) => g.id === GOLFERS.mcilroy.id).madeCut, false, 'cut golfer flagged');
  assert.equal(d.golferBoard.find((g) => g.id === GOLFERS.scheffler.id).madeCut, true, 'survivor not flagged');
  assert.equal(d.scorecards.find((g) => g.id === GOLFERS.mcilroy.id).state, 'cut', 'scorecard shows cut');

  // Round 2 still being played (thru 9): the cut isn't final, so nobody is flagged.
  const early = computeStandings(board([player('Rory McIlroy', [5, 5], GOLFERS.mcilroy.id, 9)]));
  assert.equal(early.golferBoard.find((g) => g.id === GOLFERS.mcilroy.id).madeCut, null, 'no flag while round 2 is live');
});

check('the cut is final the moment round 2 is complete, before any round 3', () => {
  // Everyone has signed for 36 holes and no third round has begun.
  const field = [
    player('Scottie Scheffler', [-3, -3], GOLFERS.scheffler.id), // -6, inside
    player('Rory McIlroy', [4, 5], GOLFERS.mcilroy.id), // +9, outside
  ];
  for (let i = 0; i < 69; i++) field.push(player(`Good ${i}`, [-1, -1], `g${i}`)); // -2 → fills the top 70
  const { cut, golferBoard, scorecards } = computeStandings(board(field));

  assert.equal(cut.decided, true, 'final as soon as round 2 is in');
  assert.ok(!cut.byThirdRound, 'decided by the 36-hole line, not by a third round');
  assert.equal(cut.line, -2, 'the 70th score is -2');

  const rory = golferBoard.find((g) => g.id === GOLFERS.mcilroy.id);
  const scottie = golferBoard.find((g) => g.id === GOLFERS.scheffler.id);
  assert.equal(rory.madeCut, false, 'below the line → cut');
  assert.equal(scottie.madeCut, true, 'above the line → safe');
  assert.equal(rory.position, 'CUT', 'shown as CUT on the leaderboard');
  assert.equal(scorecards.find((g) => g.id === GOLFERS.mcilroy.id).state, 'cut', 'and cut on the scorecard');
});

check('a lone "thru 0" withdrawal does not hold the cut open', () => {
  // Real case: a WD sits in the feed at "round 2, thru 0" long after everyone
  // else has finished. It must not keep the cut a projection forever.
  const field = [
    player('Scottie Scheffler', [-3, -3], GOLFERS.scheffler.id), // -6, inside
    player('Rory McIlroy', [4, 5], GOLFERS.mcilroy.id), // +9, outside
  ];
  for (let i = 0; i < 69; i++) field.push(player(`Good ${i}`, [-1, -1], `g${i}`)); // -2
  field.push(player('WD Guy', [3, 0], 'wd1', 0)); // round 2 exists but thru 0

  const { cut, golferBoard } = computeStandings(board(field));
  assert.equal(cut.decided, true, 'still final despite the stuck withdrawal');
  assert.equal(golferBoard.find((g) => g.id === GOLFERS.mcilroy.id).madeCut, false, 'the cut golfer is flagged');
  assert.equal(golferBoard.find((g) => g.id === GOLFERS.scheffler.id).madeCut, true, 'the survivor is not');
});

check('a survivor who has not yet teed off round 3 is not flagged as cut', () => {
  // Saturday morning: round 2 is complete and the leaders' round-3 groups have
  // begun, so a third-round score exists in the field — but most survivors have
  // not started their own round yet. Their missing round-3 score must not be read
  // as a missed cut; only the 36-hole line decides who is out.
  const field = [
    player('Scottie Scheffler', [4, 5], GOLFERS.scheffler.id), // +9, genuinely cut
    player('Rory McIlroy', [-3, -3], GOLFERS.mcilroy.id), // -6, safe, not yet out
    player('Collin Morikawa', [-2, -2], GOLFERS.morikawa.id), // -4, safe, not yet out
  ];
  for (let i = 0; i < 68; i++) field.push(player(`Good ${i}`, [-1, -1], `g${i}`)); // -2, safe
  field.push(player('Early Starter', [-1, -1, 1], 'early', 6)); // -2, six holes into round 3

  const { cut, golferBoard } = computeStandings(board(field));
  assert.equal(cut.decided, true, 'the cut is final once round 2 is in');
  assert.ok(cut.byThirdRound, 'a round-3 score exists, so it reads by the third round');

  const flag = (id) => golferBoard.find((g) => g.id === id).madeCut;
  assert.equal(flag(GOLFERS.mcilroy.id), true, 'the survivor still awaiting his tee time is safe');
  assert.equal(flag(GOLFERS.morikawa.id), true, 'as is the other one');
  assert.equal(flag(GOLFERS.scheffler.id), false, 'only the golfer above the line is cut');
});

check('a placeholder round-3 line does not resurrect a cut golfer', () => {
  // The reported bug: ESPN sometimes hangs an empty third round (a score, zero
  // holes) on a player who actually missed the cut. Left unchecked they read as
  // "made the cut" and show as playing at "E today", slotted in among the
  // survivors — and they pollute the cut line too. The cut is a 36-hole fact, so
  // an empty round-3 line must not override it.
  const cutGolfer = player('Rory McIlroy', [5, 5], GOLFERS.mcilroy.id); // +10, well outside
  cutGolfer.rounds[3] = 0; // a round-3 score…
  cutGolfer.holes[3] = 0; // …but not a single hole struck
  cutGolfer.cards[3] = [];
  cutGolfer.roundsPlayed = 3;

  const field = [
    cutGolfer,
    player('Scottie Scheffler', [-2, -2, -2], GOLFERS.scheffler.id), // survived, out in R3
    player('Grinder', [2, 2, 1], 'x1'), // survived at +4 through 36
  ];
  const { cut, golferBoard, scorecards } = computeStandings(board(field));

  assert.equal(cut.line, 4, 'the line reads the real R3 field, not the placeholder');
  const rory = golferBoard.find((g) => g.id === GOLFERS.mcilroy.id);
  assert.equal(rory.madeCut, false, 'still cut despite the empty third round');
  assert.equal(rory.position, 'CUT', 'not slotted in among the survivors');
  const card = scorecards.find((g) => g.id === GOLFERS.mcilroy.id);
  assert.equal(card.state, 'cut', 'the scorecard shows CUT, not a live "E today"');
});

check('the golfer board carries live round progress for the status indicator', () => {
  const field = [player('Scottie Scheffler', [-3, -3, -2], GOLFERS.scheffler.id, 9)];
  const g = computeStandings(board(field)).golferBoard.find((x) => x.id === GOLFERS.scheffler.id);
  assert.equal(g.currentRound, 3, 'on their third round');
  assert.equal(g.thru, 9, 'nine holes in');
  assert.equal(g.roundComplete, false, 'not finished the round');
});

check('a golfer who has not teed off shows no position or card', () => {
  const field = Object.values(GOLFERS).map((g) => player(g.name, [], g.id));
  const { scorecards } = computeStandings(board(field, { started: false }));
  assert.ok(scorecards.every((g) => g.state === 'not-started'));
  assert.ok(scorecards.every((g) => g.position == null));
  assert.ok(scorecards.every((g) => g.holes.length === 0));
});

check('every drafted golfer gets a card, active ones first', () => {
  const field = [
    player('Rory McIlroy', [5, 5], GOLFERS.mcilroy.id), // cut
    player('Scottie Scheffler', [-2, -2, -2], GOLFERS.scheffler.id), // playing
  ];
  const { scorecards } = computeStandings(board(field));
  assert.equal(scorecards.length, Object.keys(GOLFERS).length, 'all 11 golfers listed');
  assert.equal(scorecards[0].id, GOLFERS.scheffler.id, 'the active golfer sorts above the cut one');
});

group('cut line');

check('projects the cut at the 70th player and ties while rounds 1-2 are live', () => {
  // 50 players at -1, then our 11 golfers at E (places 51-61), then a block at
  // +3 covering places 62 onward. The 70th score therefore falls at +3, so that
  // is the line — and our golfers sit 3 strokes inside it.
  const filler = [];
  for (let i = 0; i < 50; i++) filler.push(player(`Good ${i}`, [-1, 0], `g${i}`));
  for (let i = 0; i < 10; i++) filler.push(player(`Edge ${i}`, [1, 2], `e${i}`)); // +3
  for (let i = 0; i < 26; i++) filler.push(player(`Bad ${i}`, [4, 5], `b${i}`)); // +9

  const field = [
    ...Object.values(GOLFERS).map((g) => player(g.name, [0, 0], g.id)), // E
    ...filler,
    // Someone still out on the course in round 2, so the cut is not yet final.
    player('Still Playing', [0, 0], 'live1', 9), // E, thru 9 of round 2
  ];
  const { cut, golferBoard } = computeStandings(board(field));

  assert.equal(cut.decided, false, 'still a projection while round 2 is being played');
  assert.equal(cut.line, 3, 'the 70th score is +3');

  // Our golfers are all at E, comfortably inside a +3 line.
  const scheffler = golferBoard.find((g) => g.id === GOLFERS.scheffler.id);
  assert.equal(scheffler.inside, true);
  assert.equal(scheffler.toCut, -3, 'E is 3 strokes inside a +3 line');
});

check('a golfer level with the line is inside it — "and ties"', () => {
  const filler = [];
  for (let i = 0; i < 69; i++) filler.push(player(`Good ${i}`, [-2, -2], `g${i}`)); // -4
  for (let i = 0; i < 30; i++) filler.push(player(`Bad ${i}`, [5, 5], `b${i}`)); // +10

  // Put Scheffler exactly on the 70th score.
  const field = [
    player('Scottie Scheffler', [-2, -2], GOLFERS.scheffler.id), // -4, ties the line
    ...filler,
  ];
  const { cut, golferBoard } = computeStandings(board(field));
  const scheffler = golferBoard.find((g) => g.id === GOLFERS.scheffler.id);

  assert.equal(cut.line, -4);
  assert.equal(scheffler.toCut, 0, 'exactly on the line');
  assert.equal(scheffler.inside, true, 'ties survive the cut, they are not eliminated');
});

check('once round 3 starts the cut is a fact, not a projection', () => {
  const field = [
    // Survived: has a third round.
    player('Scottie Scheffler', [0, 0, -2, -2], GOLFERS.scheffler.id),
    // Did not: stopped at 36 holes.
    player('Rory McIlroy', [4, 4], GOLFERS.mcilroy.id),
    player('Grinder', [2, 3, 1, 1], 'x1'), // survived at +5 through 36
    player('Gone', [6, 6], 'x2'),
  ];
  const { cut, golferBoard } = computeStandings(board(field));

  assert.equal(cut.decided, true, 'round 3 exists, so the cut has happened');
  assert.equal(cut.line, 5, 'worst 36-hole total among survivors: Grinder at +5');

  const scheffler = golferBoard.find((g) => g.id === GOLFERS.scheffler.id);
  const rory = golferBoard.find((g) => g.id === GOLFERS.mcilroy.id);

  assert.equal(scheffler.madeCut, true);
  assert.equal(scheffler.inside, true);
  assert.equal(rory.madeCut, false, 'no third round means no cut made');
  assert.equal(rory.inside, false);
});

check('every drafted golfer is listed, with the managers who picked them', () => {
  const field = Object.values(GOLFERS).map((g) => player(g.name, [0, 0], g.id));
  const { golferBoard } = computeStandings(board(field));

  assert.equal(golferBoard.length, Object.keys(GOLFERS).length, 'all 11 golfers listed');

  // Scheffler was the most popular pick — he should carry several owners.
  const scheffler = golferBoard.find((g) => g.id === GOLFERS.scheffler.id);
  assert.ok(scheffler.owners.includes('Jack'), 'Jack picked Scheffler');
  assert.ok(scheffler.owners.length >= 5, `expected many owners, got ${scheffler.owners.length}`);

  // Hovland was picked by exactly one person.
  const hovland = golferBoard.find((g) => g.id === GOLFERS.hovland.id);
  assert.deepEqual(hovland.owners, ['Coop']);

  // Owners are listed side by side, so the short name is used where one is set.
  // The draft board still shows the full name.
  assert.ok(
    scheffler.owners.includes('PJ'),
    `expected the short name on the golfers tab, got ${scheffler.owners.join(', ')}`,
  );
  assert.ok(
    !scheffler.owners.includes('Patrick John Kealy III'),
    'the full name should not appear in the owners list',
  );
  const { rows } = computeStandings(board(field));
  assert.ok(
    rows.some((r) => r.manager === 'Patrick John Kealy III'),
    'the draft board keeps the full name',
  );
});

check('a golfer appears exactly once, even if the feed carries duplicate ids', () => {
  // Guards the demo-mode bug: the replayed event's real field also contains our
  // golfers, so a careless graft produced two competitors sharing one athlete id
  // and the views disagreed about the same person.
  const field = [
    player('Scottie Scheffler', [-4, -4, -4, -5], GOLFERS.scheffler.id), // -17
    ...Object.values(GOLFERS)
      .filter((g) => g.key !== 'scheffler' && g.id !== GOLFERS.scheffler.id)
      .map((g) => player(g.name, [0, 0, 0, 0], g.id)),
  ];
  const { golferBoard, leaders, winningScore } = computeStandings(board(field));

  const ids = golferBoard.map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length, 'no golfer listed twice');

  const scheffler = golferBoard.filter((g) => g.id === GOLFERS.scheffler.id);
  assert.equal(scheffler.length, 1, 'exactly one Scheffler row');

  // The leader panel and the golfer board must agree about the same player.
  assert.equal(winningScore, -17);
  assert.deepEqual(leaders, ['Scottie Scheffler']);
  assert.equal(scheffler[0].total, -17, 'the golfer board shows the same score');
  assert.equal(scheffler[0].inside, true, 'the leader cannot also have missed the cut');
});

check('no cut line before anyone has teed off', () => {
  const field = Object.values(GOLFERS).map((g) => player(g.name, [], g.id));
  const { cut } = computeStandings(board(field, { started: false }));
  assert.equal(cut.line, null);
  assert.equal(cut.decided, false);
});

check('formatToPar renders E, minus and plus', () => {
  assert.equal(formatToPar(0), 'E');
  assert.equal(formatToPar(-9), '-9');
  assert.equal(formatToPar(7), '+7');
  assert.equal(formatToPar(null), '—');
});

// ---------------------------------------------------------------------------

group('tee times');

// Tee times are hand-entered (config's TEE_TIMES) and attached to the field
// player as teeTime + the round they're for (teePeriod). These checks exercise
// the surfacing logic directly by setting those two fields on a player; a
// separate group below covers pulling them out of the config in fetchLeaderboard.
const TEE = '2026-07-16T09:15Z';
const withTee = (p, teeTime, teePeriod) => ({ ...p, teeTime, teePeriod });

check('a golfer yet to tee off carries their round-1 tee time everywhere', () => {
  const field = Object.values(GOLFERS).map((g) => withTee(player(g.name, [], g.id), TEE, 1));
  const { rows, scorecards, golferBoard } = computeStandings(board(field, { started: false }));

  assert.ok(scorecards.every((g) => g.teeTime === TEE), 'every scorecard shows the tee');
  assert.ok(golferBoard.every((g) => g.teeTime === TEE), 'every leaderboard row shows the tee');
  const drafted = rows.flatMap((r) => r.golfers).find((x) => x.id === GOLFERS.scheffler.id);
  assert.equal(drafted.teeTime, TEE, 'the draft board shows it too');
});

check('the tee time stays put until a hole is played, not on a placeholder round score', () => {
  // ESPN can hang an "E"/"-" round score on a player at the tee, before any hole
  // is complete. The chip must persist until the golfer genuinely gets underway,
  // so it stays there right up until the tee actually occurs.
  const field = [withTee(player('Scottie Scheffler', [0], GOLFERS.scheffler.id, 0), TEE, 1)];
  const s = computeStandings(board(field)).scorecards.find((g) => g.id === GOLFERS.scheffler.id);
  assert.equal(s.thru, 0, 'no holes recorded yet');
  assert.equal(s.teeTime, TEE, 'a placeholder round score must not drop the tee time');
});

check('a golfer mid-round has no upcoming tee time', () => {
  // On the course in round 1 (9 holes in): the tee time is for the round already
  // begun, so there is nothing upcoming to count down to.
  const field = [withTee(player('Scottie Scheffler', [-2], GOLFERS.scheffler.id, 9), TEE, 1)];
  const s = computeStandings(board(field)).scorecards.find((g) => g.id === GOLFERS.scheffler.id);
  assert.equal(s.state, 'playing');
  assert.ok(s.teeTime == null, 'no tee time while playing');
});

check('a golfer between rounds shows the next round’s tee time', () => {
  // Finished round 1, round-2 pairing published → period 2, no round-2 card yet.
  const field = [
    withTee(player('Scottie Scheffler', [-3], GOLFERS.scheffler.id), TEE, 2),
    player('Rory McIlroy', [-1], GOLFERS.mcilroy.id),
  ];
  const s = computeStandings(board(field)).scorecards.find((g) => g.id === GOLFERS.scheffler.id);
  assert.equal(s.state, 'round-done');
  assert.equal(s.teeTime, TEE, 'the tee time for the round they are yet to start');
});

check('a missed-cut golfer shows no tee time even if the feed still carries one', () => {
  const field = [
    withTee(player('Rory McIlroy', [4, 4], GOLFERS.mcilroy.id), TEE, 3), // cut, stale next tee
    player('Scottie Scheffler', [-2, -2, -2], GOLFERS.scheffler.id), // survived → cut decided
  ];
  const { scorecards, golferBoard } = computeStandings(board(field));
  assert.ok(scorecards.find((g) => g.id === GOLFERS.mcilroy.id).teeTime == null, 'no tee on the card');
  assert.ok(golferBoard.find((g) => g.id === GOLFERS.mcilroy.id).teeTime == null, 'none on the board');
});

check('with no period in the feed, a completed round still yields the next tee', () => {
  const field = [
    withTee(player('Scottie Scheffler', [-3], GOLFERS.scheffler.id), TEE, null),
    player('Rory McIlroy', [-1], GOLFERS.mcilroy.id),
  ];
  const s = computeStandings(board(field)).scorecards.find((g) => g.id === GOLFERS.scheffler.id);
  assert.equal(s.teeTime, TEE);
});

check('with no period in the feed, a mid-round golfer has no tee time', () => {
  const field = [withTee(player('Scottie Scheffler', [-2], GOLFERS.scheffler.id, 9), TEE, null)];
  const s = computeStandings(board(field)).scorecards.find((g) => g.id === GOLFERS.scheffler.id);
  assert.ok(s.teeTime == null);
});

check('an unparseable or absent tee time is ignored, never rendered', () => {
  const bad = Object.values(GOLFERS).map((g) => withTee(player(g.name, [], g.id), 'not-a-date', 1));
  assert.ok(computeStandings(board(bad, { started: false })).golferBoard.every((g) => g.teeTime == null));

  const none = Object.values(GOLFERS).map((g) => player(g.name, [], g.id)); // no teeTime field at all
  assert.ok(computeStandings(board(none, { started: false })).golferBoard.every((g) => g.teeTime == null));
});

// ---------------------------------------------------------------------------

group('tee times from config');

// The times come from config's TEE_TIMES, keyed by the round a golfer is about
// to play. fetchLeaderboard attaches the right one to each golfer; these checks
// stub the feed and confirm it picks the upcoming round and respects play state.
{
  const fmtP = (v) => (v === 0 ? 'E' : v > 0 ? `+${v}` : `${v}`);
  const holeCard = (n, s) =>
    Array.from({ length: n }, (_, k) => ({ period: k + 1, value: 4, scoreType: { displayValue: k === 0 ? fmtP(s) : 'E' } }));
  // roundScores is one entry per round; holesLast leaves the final round partway.
  const makeComp = (gid, name, roundScores, holesLast = 18) => ({
    id: gid,
    athlete: { id: gid, displayName: name },
    score: fmtP(roundScores.reduce((a, b) => a + b, 0)),
    linescores: roundScores.map((s, i) =>
      ({ period: i + 1, displayValue: fmtP(s), linescores: holeCard(i === roundScores.length - 1 ? holesLast : 18, s) })),
  });
  const eventWith = (competitors) => ({
    id: EVENT.id,
    name: EVENT.name,
    date: '2026-07-17T06:00Z',
    status: { type: { name: 'STATUS_IN_PROGRESS', completed: false }, completed: false },
    competitions: [{ competitors }],
  });
  const withStubbedFeed = async (competitors, opts) => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ events: [eventWith(competitors)] }) });
    try {
      return await fetchLeaderboard(opts);
    } finally {
      globalThis.fetch = realFetch;
    }
  };

  const times = { 1: { scheffler: '2026-07-16T06:35Z' }, 2: { scheffler: '2026-07-17T13:40Z' } };

  // Round 1 complete, not yet out for round 2 → the round-2 tee, from config.
  const between = await withStubbedFeed([makeComp(GOLFERS.scheffler.id, 'Scottie Scheffler', [-3])], { teeTimes: times });
  check('a between-rounds golfer gets the next round tee from config', () => {
    const p = between.field.find((x) => x.id === GOLFERS.scheffler.id);
    assert.equal(p.teePeriod, 2, 'the upcoming round is 2');
    assert.equal(p.teeTime, '2026-07-17T13:40Z', 'pulled from TEE_TIMES[2]');
    const card = computeStandings(between).scorecards.find((g) => g.id === GOLFERS.scheffler.id);
    assert.equal(card.teeTime, '2026-07-17T13:40Z', 'and it surfaces on the scorecard');
  });

  // Out on the course in round 2 (9 holes in) → no upcoming tee.
  const playing = await withStubbedFeed([makeComp(GOLFERS.scheffler.id, 'Scottie Scheffler', [-3, -1], 9)], { teeTimes: times });
  check('a golfer already underway shows no tee, even with a time on file', () => {
    const card = computeStandings(playing).scorecards.find((g) => g.id === GOLFERS.scheffler.id);
    assert.ok(card.teeTime == null, 'a started round has no upcoming tee');
  });

  // A time on file for a golfer, but the wrong round → nothing surfaces.
  const noEntry = await withStubbedFeed([makeComp(GOLFERS.scheffler.id, 'Scottie Scheffler', [-3])], { teeTimes: { 1: times[1] } });
  check('no config entry for the upcoming round means no chip', () => {
    const p = noEntry.field.find((x) => x.id === GOLFERS.scheffler.id);
    assert.equal(p.teePeriod, 2, 'upcoming round is 2');
    assert.ok(p.teeTime == null, 'only round 1 is on file, so round 2 is null');
  });
}

// ---------------------------------------------------------------------------

group('playoff contingency');

// A tie for the win is settled by a playoff, which ESPN reports as a 5th round on
// the golfers involved. Those extra holes decide the trophy, not the fantasy
// score, so they must never be added to a golfer's total nor penalise the field.
// Stub fetch with a playoff event and drive the real ingestion path.
{
  const fmtP = (v) => (v === 0 ? 'E' : v > 0 ? `+${v}` : `${v}`);
  const holeCard = (n, s) =>
    Array.from({ length: n }, (_, k) => ({ period: k + 1, value: 4, scoreType: { displayValue: k === 0 ? fmtP(s) : 'E' } }));
  const roundLS = (period, s, holes) => ({ period, displayValue: fmtP(s), linescores: holeCard(holes, s) });
  const makeComp = (gid, name, roundScores, totalDisplay, playoffScore = null) => {
    const linescores = roundScores.map((s, i) => roundLS(i + 1, s, 18));
    if (playoffScore != null) linescores.push(roundLS(5, playoffScore, 4)); // 4 extra holes
    return {
      id: gid,
      athlete: { id: gid, displayName: name },
      score: totalDisplay, // ESPN's own to-par, which already excludes playoff strokes
      linescores,
      status: {
        type: { name: 'STATUS_IN_PROGRESS' },
        period: playoffScore != null ? 5 : 4,
        teeTime: playoffScore != null ? '2026-07-19T18:30Z' : null,
      },
    };
  };
  const event = {
    id: EVENT.id,
    name: EVENT.name,
    date: '2026-07-19T12:00Z',
    status: { type: { name: 'STATUS_IN_PROGRESS', completed: false, detail: 'Playoff' }, completed: false },
    competitions: [{
      competitors: [
        makeComp(GOLFERS.scheffler.id, 'Scottie Scheffler', [-3, -3, -3, -3], '-12', 4), // wins a playoff at +4
        makeComp(GOLFERS.mcilroy.id, 'Rory McIlroy', [-3, -3, -3, -3], '-12'), // same 72-hole score, no playoff
        makeComp(GOLFERS.fleetwood.id, 'Tommy Fleetwood', [-2, -2, -2, -2], '-8'),
      ],
    }],
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ events: [event] }) });
  let pboard;
  try {
    pboard = await fetchLeaderboard({ demo: false });
  } finally {
    globalThis.fetch = realFetch;
  }
  const pstd = computeStandings(pboard);
  const golferTotal = (gid) => pstd.rows.flatMap((r) => r.golfers).find((g) => g.id === gid)?.total;

  check('a 5th-round playoff score never enters the model', () => {
    const w = pboard.field.find((p) => p.id === GOLFERS.scheffler.id);
    assert.ok(w.rounds[5] === undefined, 'no round 5 in the model');
    assert.equal(w.roundsPlayed, 4, 'only the four tournament rounds count');
    assert.equal(pstd.roundsStarted, 4, 'roundsStarted stays at 4');
    assert.equal(pstd.penalties[5], undefined, 'no round-5 penalty is ever computed');
  });

  check('a golfer dragged into a playoff is not charged its extra strokes', () => {
    assert.equal(golferTotal(GOLFERS.scheffler.id), -12, 'the winner keeps -12, not -8');
    assert.equal(golferTotal(GOLFERS.mcilroy.id), -12, 'the loser, same 72 holes, also -12');
    assert.equal(
      golferTotal(GOLFERS.scheffler.id),
      golferTotal(GOLFERS.mcilroy.id),
      'the playoff does not separate them on fantasy score',
    );
  });

  check('the playoff is not surfaced as an upcoming tee time or a 5th-round card', () => {
    const card = pstd.scorecards.find((g) => g.id === GOLFERS.scheffler.id);
    assert.ok(card.teeTime == null, 'no playoff tee-time chip');
    assert.equal(card.currentRound, 4, 'the card shows round 4, not a playoff round');
  });

  check('a playoff that is not yet complete awards no bonus', () => {
    // The stub above is STATUS_IN_PROGRESS (completed: false). The winner is only
    // settled once the championship is over, so nothing is credited mid-playoff.
    assert.equal(pstd.playoffWinner, null, 'no winner while the playoff is live');
    for (const r of pstd.rows) {
      assert.equal(r.playoffBonus, 0, `${r.manager} should carry no bonus yet`);
      assert.equal(r.adjustedTotal, r.total, `${r.manager} draft total is unadjusted`);
    }
  });
}

// ---------------------------------------------------------------------------

group('playoff winner bonus');

// The winner of a playoff earns their owners a one-stroke DRAFT-ORDER bonus. It
// is deliberately kept off every stroke count: golfer totals stay pure 72-hole
// figures, and only the entry's `adjustedTotal` — the number the draft is ranked
// on — moves. These drive the fixtures directly through the model.
{
  const withPlayoff = (p, playoffScore) => ({ ...p, inPlayoff: true, playoffScore });

  // Scheffler and McIlroy both finish 72 holes at -12. Scheffler wins the playoff
  // (the lower aggregate over the extra holes); McIlroy is the runner-up.
  const makeField = () => [
    withPlayoff(player('Scottie Scheffler', [-3, -3, -3, -3], id('scheffler')), -1),
    withPlayoff(player('Rory McIlroy', [-3, -3, -3, -3], id('mcilroy')), 0),
    player('Collin Morikawa', [-2, -2, -2, -2], id('morikawa')),
    player('Tommy Fleetwood', [-1, -1, -1, -1], id('fleetwood')),
    player('Matt Fitzpatrick', [0, 0, 0, 0], id('fitzpatrick')),
  ];

  const done = computeStandings(board(makeField(), { complete: true }));

  check('the winner is the playoff participant with the best aggregate', () => {
    assert.ok(done.playoffWinner, 'a winner is resolved');
    assert.equal(done.playoffWinner.id, id('scheffler'), 'Scheffler won the playoff');
    assert.equal(done.playoffWinner.name, 'Scottie Scheffler');
  });

  check('the winner keeps a clean 72-hole score — no strokes added or removed', () => {
    const gb = (gid) => done.golferBoard.find((g) => g.id === gid);
    assert.equal(gb(id('scheffler')).total, -12, 'winner still -12');
    assert.equal(gb(id('mcilroy')).total, -12, 'runner-up still -12, level with the winner');
    assert.equal(gb(id('scheffler')).playoffWinner, true, 'winner flagged on the golfer board');
    assert.equal(gb(id('mcilroy')).playoffWinner, false, 'runner-up is not flagged');
  });

  check('drafting the winner deducts one stroke from the draft-order total only', () => {
    // Braddy: scheffler, fleetwood, fitzpatrick → -12 + -4 + 0 = -16 actual.
    const braddy = done.rows.find((r) => r.manager === 'Braddy');
    assert.equal(braddy.total, -16, 'actual combined score is unchanged');
    assert.equal(braddy.playoffBonus, -1, 'one-stroke bonus for drafting the winner');
    assert.equal(braddy.adjustedTotal, -17, 'draft-order total carries the bonus');
    const s = braddy.golfers.find((g) => g.id === id('scheffler'));
    assert.equal(s.playoffWinner, true, 'the winning pick is flagged inside the entry');
    assert.equal(s.total, -12, "the winning pick's own score is untouched");
  });

  check('drafting only the runner-up earns no bonus', () => {
    // Goon: mcilroy, rose, young — has the loser, not the winner.
    const goon = done.rows.find((r) => r.manager === 'Goon');
    assert.equal(goon.playoffBonus, 0, 'no bonus for the runner-up');
    assert.equal(goon.adjustedTotal, goon.total, 'draft total equals actual score');
    assert.ok(
      !goon.golfers.some((g) => g.playoffWinner),
      'no winning pick in this entry',
    );
  });

  check('the bonus is at most one stroke even if the winner sits among other picks', () => {
    // Every Scheffler owner gets exactly -1, never a multiple.
    for (const r of done.rows) {
      const hasWinner = r.golfers.some((g) => g.playoffWinner);
      assert.equal(r.playoffBonus, hasWinner ? -1 : 0, `${r.manager} bonus`);
    }
  });

  check('the bonus lifts a winner-owner clear of a same-scoring non-owner', () => {
    // The whole point: a manager who drafted the winner ends up ahead of one who
    // finished level on raw strokes but drafted the runner-up. (Ferrell and Goon
    // both sit at -12 raw; Ferrell has Scheffler, Goon has McIlroy.)
    let demonstrated = false;
    for (const r of done.rows) {
      if (!r.golfers.some((g) => g.playoffWinner)) continue;
      for (const t of done.rows) {
        if (t === r || t.total !== r.total) continue;
        if (t.golfers.some((g) => g.playoffWinner)) continue; // both bonused → level is fine
        assert.ok(r.adjustedTotal < t.adjustedTotal, `${r.manager} should sit clear of ${t.manager}`);
        demonstrated = true;
      }
    }
    assert.ok(demonstrated, 'at least one dead heat was broken by the bonus');
  });

  check('a tie in the playoff aggregate resolves no winner (safety net)', () => {
    const field = makeField();
    field[0] = withPlayoff(player('Scottie Scheffler', [-3, -3, -3, -3], id('scheffler')), 0);
    field[1] = withPlayoff(player('Rory McIlroy', [-3, -3, -3, -3], id('mcilroy')), 0);
    const std = computeStandings(board(field, { complete: true }));
    assert.equal(std.playoffWinner, null, 'still level → no winner declared');
    for (const r of std.rows) assert.equal(r.playoffBonus, 0, `${r.manager} unbonused`);
  });

  check('the lower aggregate wins, whichever golfer posts it', () => {
    const field = makeField();
    // Flip it: now McIlroy has the better aggregate.
    field[0] = withPlayoff(player('Scottie Scheffler', [-3, -3, -3, -3], id('scheffler')), 1);
    field[1] = withPlayoff(player('Rory McIlroy', [-3, -3, -3, -3], id('mcilroy')), -2);
    const std = computeStandings(board(field, { complete: true }));
    assert.equal(std.playoffWinner.id, id('mcilroy'), 'McIlroy took the playoff');
  });
}

// The bonus survives the real ingestion path: playoff periods are captured as
// participation without ever entering a golfer's score, and a completed event
// credits the winner. Reuses the same stubbing shape as the contingency block.
{
  const fmtP = (v) => (v === 0 ? 'E' : v > 0 ? `+${v}` : `${v}`);
  const holeCard = (n, s) =>
    Array.from({ length: n }, (_, k) => ({ period: k + 1, value: 4, scoreType: { displayValue: k === 0 ? fmtP(s) : 'E' } }));
  const roundLS = (period, s, holes) => ({ period, displayValue: fmtP(s), linescores: holeCard(holes, s) });
  const makeComp = (gid, name, roundScores, totalDisplay, playoffScore = null) => {
    const linescores = roundScores.map((s, i) => roundLS(i + 1, s, 18));
    if (playoffScore != null) linescores.push(roundLS(5, playoffScore, 4));
    return { id: gid, athlete: { id: gid, displayName: name }, score: totalDisplay, linescores };
  };
  const event = {
    id: EVENT.id,
    name: EVENT.name,
    date: '2026-07-19T12:00Z',
    status: { type: { name: 'STATUS_FINAL', completed: true, detail: 'Final' }, completed: true },
    competitions: [{
      competitors: [
        makeComp(GOLFERS.scheffler.id, 'Scottie Scheffler', [-3, -3, -3, -3], '-12', -1), // wins
        makeComp(GOLFERS.mcilroy.id, 'Rory McIlroy', [-3, -3, -3, -3], '-12', 0), // loses
        makeComp(GOLFERS.morikawa.id, 'Collin Morikawa', [-2, -2, -2, -2], '-8'),
      ],
    }],
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ events: [event] }) });
  let pboard;
  try {
    pboard = await fetchLeaderboard({ demo: false });
  } finally {
    globalThis.fetch = realFetch;
  }
  const std = computeStandings(pboard);

  check('playoff participation is parsed off the feed without touching the score', () => {
    const w = pboard.field.find((p) => p.id === GOLFERS.scheffler.id);
    assert.equal(w.inPlayoff, true, 'flagged as a playoff participant');
    assert.equal(w.playoffScore, -1, 'the aggregate over the extra holes is captured');
    assert.ok(w.rounds[5] === undefined, 'but no 5th round enters the model');
    assert.equal(w.total, -12, 'and the 72-hole score is unchanged');
  });

  check('a completed feed credits the winner through the full path', () => {
    assert.equal(std.playoffWinner.id, GOLFERS.scheffler.id, 'Scheffler credited');
    const braddy = std.rows.find((r) => r.manager === 'Braddy');
    assert.equal(braddy.playoffBonus, -1, 'his owner gets the draft bonus');
    assert.equal(braddy.adjustedTotal, braddy.total - 1, 'adjusted one below actual');
  });
}

// ---------------------------------------------------------------------------

group('live-feed cut placeholders');

// The live ESPN feed does NOT trim a cut golfer to two rounds. Mid-tournament it
// hangs a placeholder on the round they will not play — displayValue "-", zero
// holes — and toPar reads "-" as even par. Recording that as a real round put
// every cut golfer into the survivor pool, poisoned the cut line, and left no one
// flagged as cut. This drives the real ingestion path with that exact shape.
{
  const fmtP = (v) => (v === 0 ? 'E' : v > 0 ? `+${v}` : `${v}`);
  const holeCard = (n) => Array.from({ length: n }, (_, k) => ({ period: k + 1, value: 4, scoreType: { displayValue: 'E' } }));
  // rounds: array of { s?: scoreToPar, holes } — a 0-hole entry with no score is
  // ESPN's "-" placeholder for a round not begun.
  const comp = (gid, name, rounds) => ({
    id: gid,
    athlete: { id: gid, displayName: name },
    score: fmtP(rounds.filter((r) => r.holes > 0).reduce((a, r) => a + r.s, 0)),
    linescores: rounds.map((r, i) => ({
      period: i + 1,
      displayValue: r.holes > 0 ? fmtP(r.s) : '-',
      linescores: holeCard(r.holes),
    })),
  });

  const finishedR3 = (s1, s2, s3) => [{ s: s1, holes: 18 }, { s: s2, holes: 18 }, { s: s3, holes: 18 }, { holes: 0 }];
  const cutGolfer = (s1, s2) => [{ s: s1, holes: 18 }, { s: s2, holes: 18 }, { holes: 0 }]; // R3 "-" placeholder
  const notTeedR3 = (s1, s2) => [{ s: s1, holes: 18 }, { s: s2, holes: 18 }, { holes: 0 }]; // identical shape to a cut golfer

  const field = [
    comp(GOLFERS.scheffler.id, 'Scottie Scheffler', cutGolfer(4, 5)), // +9 → missed the cut
    comp(GOLFERS.mcilroy.id, 'Rory McIlroy', finishedR3(-3, -3, -1)), // survivor, third round in
    comp(GOLFERS.morikawa.id, 'Collin Morikawa', notTeedR3(-2, -2)), // -4 survivor, not yet out for R3
  ];
  for (let i = 0; i < 68; i++) field.push(comp(`g${i}`, `Good ${i}`, finishedR3(-1, -1, 0))); // -2, safe
  for (let i = 0; i < 80; i++) field.push(comp(`c${i}`, `Cut ${i}`, cutGolfer(4, 5))); // +9, out

  const event = {
    id: EVENT.id,
    name: EVENT.name,
    date: '2026-07-18T06:00Z',
    status: { type: { name: 'STATUS_IN_PROGRESS', completed: false }, completed: false },
    competitions: [{ competitors: field }],
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ events: [event] }) });
  let board;
  try {
    board = await fetchLeaderboard({});
  } finally {
    globalThis.fetch = realFetch;
  }
  const std = computeStandings(board);
  const g = (id) => std.golferBoard.find((x) => x.id === id);

  check('a "-" placeholder round is not ingested as a played round', () => {
    const s = board.field.find((p) => p.id === GOLFERS.scheffler.id);
    assert.ok(s.rounds[3] === undefined, 'the cut golfer has no third round');
    assert.equal(s.roundsPlayed, 2, 'only the two rounds actually played');
  });

  check('the cut line is not poisoned by cut golfers who "played" a phantom round', () => {
    assert.equal(std.cut.decided, true, 'the cut is settled by the third round');
    assert.equal(std.cut.line, -2, 'the line is the real 36-hole line, not the field worst');
  });

  check('a cut golfer is flagged, and both kinds of survivor are not', () => {
    assert.equal(g(GOLFERS.scheffler.id).madeCut, false, 'the +9 golfer is cut');
    assert.equal(g(GOLFERS.scheffler.id).position, 'CUT', 'and shown as CUT');
    assert.equal(g(GOLFERS.mcilroy.id).madeCut, true, 'the survivor already into round 3 is safe');
    assert.equal(g(GOLFERS.morikawa.id).madeCut, true, 'the survivor not yet out for round 3 is also safe');
  });
}

// ---------------------------------------------------------------------------

group('real ESPN data — 2026 Genesis Scottish Open (completed, real cut)');

const toPar = (d) => (d === 'E' ? 0 : Number(String(d).replace('+', '')));
let realField = [];
try {
  const res = await fetch(
    'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard?dates=20260709',
  );
  const data = await res.json();
  const ev = data.events.find((e) => e.name === 'Genesis Scottish Open');
  realField = ev.competitions[0].competitors.map((c) => {
    const rounds = {};
    const holes = {};
    const cards = {};
    for (const ls of c.linescores || []) {
      rounds[ls.period] = toPar(ls.displayValue);
      holes[ls.period] = (ls.linescores || []).length;
      cards[ls.period] = (ls.linescores || [])
        .map((h) => ({ hole: h.period, strokes: h.value, result: h.scoreType?.displayValue ?? 'E' }))
        .sort((a, b) => a.hole - b.hole);
    }
    return {
      id: c.id,
      name: c.athlete.displayName,
      rounds,
      holes,
      cards,
      roundsPlayed: Object.keys(rounds).length,
      total: toPar(c.score),
    };
  });
} catch (err) {
  log(`  ~ live ESPN feed unavailable (${err.message}) — skipping real-data checks`, 'skip');
  liveDataAvailable = false;
}

liveCheck('feed parses: both 4-round and 2-round players present', () => {
  const made = realField.filter((p) => p.roundsPlayed === 4).length;
  const missed = realField.filter((p) => p.roundsPlayed === 2).length;
  assert.ok(made > 50 && missed > 50, `made=${made} missed=${missed}`);
  assert.equal(made + missed, realField.length, 'every player played 2 or 4 rounds');
  log(`      ${made} made the cut, ${missed} missed`, 'note');
});

liveCheck('ESPN really does give 18 holes per completed round (the fix depends on it)', () => {
  // If ESPN ever stopped nesting the hole-by-hole card, every round would look
  // "in progress" and no penalty would ever be charged. Assert the shape.
  let checked = 0;
  for (const p of realField) {
    for (const [round, count] of Object.entries(p.holes)) {
      assert.equal(count, 18, `${p.name} round ${round} has ${count} holes, expected 18`);
      checked++;
    }
  }
  assert.ok(checked > 400, `expected hundreds of completed rounds, saw ${checked}`);
  log(`      ${checked} completed rounds, all carrying a full 18-hole card`, 'note');
});

liveCheck('per-hole results sum to the round score, for every card in the field', () => {
  // This is the assumption the scorecard grid rests on: scoreType is the score
  // for THAT hole (birdie/par/bogey), not a running total. If ESPN ever changed
  // it to cumulative, the colours would be nonsense — so assert it on real data.
  let cards = 0;
  for (const p of realField) {
    for (const [round, card] of Object.entries(p.cards)) {
      if (card.length < 18) continue;
      const sum = card.reduce((a, h) => a + toPar(h.result), 0);
      assert.equal(sum, p.rounds[round], `${p.name} round ${round}: holes sum to ${sum}, round is ${p.rounds[round]}`);
      cards++;
    }
  }
  assert.ok(cards > 400, `expected hundreds of cards, checked ${cards}`);
  log(`      ${cards} full cards, every one summing hole-by-hole to its round score`, 'note');
});

liveCheck('a real card yields a sensible par for every hole', () => {
  // The grid derives par as strokes - holeResult. Par must land in 3..5.
  const p = realField.find((x) => x.roundsPlayed === 4);
  const card = p.cards[1];
  const pars = card.map((h) => h.strokes - toPar(h.result));
  assert.ok(pars.every((n) => n >= 3 && n <= 5), `implausible pars: ${pars.join(',')}`);
  assert.equal(pars.length, 18);
  const total = pars.reduce((a, b) => a + b, 0);
  assert.ok(total >= 68 && total <= 74, `course par worked out to ${total}, expected ~70-72`);
  log(`      ${p.name}'s round 1 implies a par-${total} course`, 'note');
});

liveCheck('our per-round parsing sums to ESPN’s own total for every finisher', () => {
  for (const p of realField.filter((x) => x.roundsPlayed === 4)) {
    const sum = Object.values(p.rounds).reduce((a, b) => a + b, 0);
    assert.equal(sum, p.total, `${p.name}: rounds sum to ${sum}, ESPN says ${p.total}`);
  }
});

liveCheck('a penalised cut golfer ends up worse than the last-place finisher', () => {
  const { penalties } = computeStandings(board(realField));
  const r3 = penalties[3].score;
  const r4 = penalties[4].score;
  assert.ok(r3 > 0 && r4 > 0, 'expected positive worst-round penalties');
  assert.equal(penalties[4].settled, true, 'a finished event has no one still out there');

  const worstFinisher = Math.max(
    ...realField.filter((p) => p.roundsPlayed === 4).map((p) => p.total),
  );
  const bestCutPlayer = Math.min(
    ...realField.filter((p) => p.roundsPlayed === 2).map((p) => p.total),
  );
  const penalised = bestCutPlayer + r3 + r4;
  assert.ok(
    penalised > worstFinisher,
    `best cut player lands at ${penalised}, last finisher ${worstFinisher}`,
  );
  log(
    `      penalty R3 ${formatToPar(r3)}, R4 ${formatToPar(r4)} — ` +
      `even the best missed-cut player lands at ${formatToPar(penalised)}, ` +
      `behind the last finisher at ${formatToPar(worstFinisher)}`,
    'note',
  );
});

const skipNote = skipped > 0 ? ` (${skipped} skipped)` : '';
const summaryText = failed === 0 ? `ALL ${passed} CHECKS PASSED${skipNote}` : `${failed} FAILED, ${passed} passed${skipNote}`;

if (isBrowser) {
  const summary = document.getElementById('summary');
  summary.textContent = summaryText;
  summary.className = failed === 0 ? 'ok' : 'bad';
} else {
  console.log(`\n${summaryText}`);
  // Fail the `npm test` run if any check failed.
  if (failed > 0) process.exitCode = 1;
}
