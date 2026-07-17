// Diagnostic: run the real scoring against the live ESPN feed and print what the
// app would show for the cut right now. Temporary — for debugging only.
import { fetchLeaderboard, computeStandings } from '../scoring.js';

const board = await fetchLeaderboard({});
const std = computeStandings(board);

console.log('started:', board.started, '| complete:', board.complete, '| detail:', board.statusDetail);
console.log('roundsStarted:', std.roundsStarted);
console.log('cut:', JSON.stringify(std.cut));

// Is any player still mid-round (what blocks the "round 2 complete" call)?
const mid = board.field.filter((p) => {
  if (p.roundsPlayed === 0) return false;
  const cur = Math.max(...Object.keys(p.rounds).map(Number));
  return (p.holes?.[cur] ?? 0) < 18;
});
console.log(`players mid-round: ${mid.length}`);
console.log(mid.slice(0, 8).map((p) => {
  const cur = Math.max(...Object.keys(p.rounds).map(Number));
  return `  ${p.name}: R${cur} thru ${p.holes?.[cur] ?? 0}`;
}).join('\n'));

console.log('\nOur golfers:');
for (const g of std.golferBoard) {
  if (!g.found) { console.log(`  ${g.name}: not in field`); continue; }
  console.log(`  ${g.name}: total ${g.total}, R${g.currentRound} thru ${g.thru}, pos ${g.position}, madeCut ${g.madeCut}`);
}
