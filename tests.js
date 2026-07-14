// Verifies the scoring rules against both synthetic cases and real ESPN data.
// Open tests.html in a browser to run.
import { GOLFERS, ENTRIES } from './config.js';
import { computeStandings, formatToPar } from './scoring.js';

const out = document.getElementById('out');
let passed = 0;
let failed = 0;

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
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text;
  out.appendChild(el);
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

const id = (key) => GOLFERS[key].id;

function player(name, rounds, playerId) {
  const r = {};
  rounds.forEach((v, i) => (r[i + 1] = v));
  return {
    id: playerId,
    name,
    rounds: r,
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
    [{ round: 3, score: 9 }, { round: 4, score: 11 }],
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

check('formatToPar renders E, minus and plus', () => {
  assert.equal(formatToPar(0), 'E');
  assert.equal(formatToPar(-9), '-9');
  assert.equal(formatToPar(7), '+7');
  assert.equal(formatToPar(null), '—');
});

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
    for (const ls of c.linescores || []) rounds[ls.period] = toPar(ls.displayValue);
    return {
      id: c.id,
      name: c.athlete.displayName,
      rounds,
      roundsPlayed: Object.keys(rounds).length,
      total: toPar(c.score),
    };
  });
} catch (err) {
  log(`  ✗ could not fetch real data: ${err.message}`, 'fail');
  failed++;
}

check('feed parses: both 4-round and 2-round players present', () => {
  const made = realField.filter((p) => p.roundsPlayed === 4).length;
  const missed = realField.filter((p) => p.roundsPlayed === 2).length;
  assert.ok(made > 50 && missed > 50, `made=${made} missed=${missed}`);
  assert.equal(made + missed, realField.length, 'every player played 2 or 4 rounds');
  log(`      ${made} made the cut, ${missed} missed`, 'note');
});

check('our per-round parsing sums to ESPN’s own total for every finisher', () => {
  for (const p of realField.filter((x) => x.roundsPlayed === 4)) {
    const sum = Object.values(p.rounds).reduce((a, b) => a + b, 0);
    assert.equal(sum, p.total, `${p.name}: rounds sum to ${sum}, ESPN says ${p.total}`);
  }
});

check('a penalised cut golfer ends up worse than the last-place finisher', () => {
  const { penalties } = computeStandings(board(realField));
  assert.ok(penalties[3] > 0 && penalties[4] > 0, 'expected positive worst-round penalties');

  const worstFinisher = Math.max(
    ...realField.filter((p) => p.roundsPlayed === 4).map((p) => p.total),
  );
  const bestCutPlayer = Math.min(
    ...realField.filter((p) => p.roundsPlayed === 2).map((p) => p.total),
  );
  const penalised = bestCutPlayer + penalties[3] + penalties[4];
  assert.ok(
    penalised > worstFinisher,
    `best cut player lands at ${penalised}, last finisher ${worstFinisher}`,
  );
  log(
    `      penalty R3 ${formatToPar(penalties[3])}, R4 ${formatToPar(penalties[4])} — ` +
      `even the best missed-cut player lands at ${formatToPar(penalised)}, ` +
      `behind the last finisher at ${formatToPar(worstFinisher)}`,
    'note',
  );
});

const summary = document.getElementById('summary');
summary.textContent = failed === 0 ? `ALL ${passed} CHECKS PASSED` : `${failed} FAILED, ${passed} passed`;
summary.className = failed === 0 ? 'ok' : 'bad';
