// Diagnostic: inspect the LIVE ESPN feed to see exactly why the cut is (not)
// being detected. Prints the raw linescore shape for a sample of players who
// clearly made the cut and a sample who clearly missed it, plus what
// computeStandings currently computes. Temporary — for debugging only.
import { EVENT } from '../config.js';
import { computeStandings } from '../scoring.js';

const SB = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard';

const res = await fetch(`${SB}?dates=${EVENT.date}`, { cache: 'no-store' });
const data = await res.json();
const event =
  (data.events || []).find((e) => e.id === EVENT.id) ||
  (data.events || []).find((e) => e.name === EVENT.name);

if (!event) {
  console.log('Could not find event. Events present:', (data.events || []).map((e) => `${e.id}:${e.name}`));
  process.exit(0);
}

const status = event.status?.type || {};
console.log('event status:', JSON.stringify(status));
const competitors = event.competitions?.[0]?.competitors || [];
console.log('competitors:', competitors.length);

// Raw shape of one competitor's linescores + any status/cut fields.
function dump(c) {
  const ls = (c.linescores || []).map((l) => ({
    period: l.period,
    display: l.displayValue,
    holes: (l.linescores || []).length,
  }));
  return {
    name: c.athlete?.displayName,
    score: c.score,
    status: c.status?.type?.name || c.status?.type?.description || c.status,
    linescores: ls,
  };
}

// ESPN often exposes a "status" per competitor. Surface any field mentioning cut.
const scan = (o, re, cap = 6) => {
  const hits = [];
  (function w(x, p) {
    if (x && typeof x === 'object' && hits.length < cap)
      for (const k in x) {
        if (re.test(k)) hits.push(`${p}${k}=${JSON.stringify(x[k]).slice(0, 80)}`);
        w(x[k], `${p}${k}.`);
      }
  })(o, '');
  return hits;
};

console.log('\n=== competitor[0] cut-ish fields ===');
console.log(scan(competitors[0], /cut|status|active/i).join('\n') || '(none)');

// Sort by how many linescores each has, to see the split.
const byLen = {};
for (const c of competitors) {
  const n = (c.linescores || []).length;
  byLen[n] = (byLen[n] || 0) + 1;
}
console.log('\n=== distribution: #linescores -> count of players ===');
console.log(JSON.stringify(byLen));

// Show a few players with the FEWEST linescores (likely the cut players) and a
// few with the most (survivors), with full raw shape.
const sorted = [...competitors].sort((a, b) => (a.linescores?.length || 0) - (b.linescores?.length || 0));
console.log('\n=== fewest-linescore players (expected: missed cut) ===');
for (const c of sorted.slice(0, 4)) console.log(JSON.stringify(dump(c)));
console.log('\n=== most-linescore players (expected: made cut) ===');
for (const c of sorted.slice(-4)) console.log(JSON.stringify(dump(c)));

// Now run the real scoring path end to end.
const { fetchLeaderboard } = await import('../scoring.js');
const board = await fetchLeaderboard({});
const std = computeStandings(board);
console.log('\n=== computed ===');
console.log('board.started:', board.started, '| complete:', board.complete);
console.log('roundsStarted:', std.roundsStarted, '| cut:', JSON.stringify(std.cut));
const cutFlagged = std.golferBoard.filter((g) => g.cut).map((g) => g.name);
console.log('golfers flagged cut:', cutFlagged.length ? cutFlagged.join(', ') : '(none)');
for (const g of std.golferBoard) {
  if (!g.found) continue;
  console.log(`  ${g.name.padEnd(20)} rounds=${JSON.stringify(g.rounds)} pos=${g.position} madeCut=${g.madeCut}`);
}
