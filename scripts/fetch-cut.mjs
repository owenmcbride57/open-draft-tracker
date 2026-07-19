// Fetch ESPN's authoritative cut status for our drafted golfers and write
// cut-status.json.
//
// Runs in GitHub Actions (see .github/workflows/cut-status.yml), NOT in the
// browser. The public scoreboard feed the site uses carries no reliable cut
// flag — a golfer who missed the cut looks, in that feed, much like one who
// simply hasn't teed off their next round yet, which is what made the cut so
// fiddly (and buggy) to infer. ESPN's deeper "core" API publishes each player's
// real status (STATUS_CUT vs an active round), but sends no CORS headers, so a
// static site can't read it. A server-side Action can, and commits the result.
//
// Output shape (what app.js loads and computeStandings consumes as `cutStatus`):
//   { "event": "401811957", "decided": true,
//     "cut": { "scheffler": false, "rose": true, ... } }
// keyed by golfer key; true = missed the cut, false = still in.

import { writeFileSync } from 'node:fs';
import { GOLFERS, EVENT } from '../config.js';

const OURS = new Map(Object.entries(GOLFERS).map(([key, g]) => [String(g.id), key]));
const CORE = 'https://sports.core.api.espn.com/v2/sports/golf/leagues/pga';
const UA = { headers: { 'user-agent': 'open-draft-tracker cut-fetch (github actions)' } };

const getJSON = async (url) => {
  const r = await fetch(url, UA);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
};

const event = await getJSON(`${CORE}/events/${EVENT.id}?lang=en&region=us`);
const compRef = event.competitions?.[0]?.$ref;
if (!compRef) throw new Error('no competition ref on event');

const compBase = compRef.split('?')[0];
const list = await getJSON(`${compBase}/competitors?limit=300&lang=en&region=us`);
const items = list.items || [];
console.log(`field: ${items.length} competitors`);

const cut = {};
let resolved = 0;
let anyCut = false;
let maxPeriod = 0;
for (const it of items) {
  const id = it.$ref?.match(/competitors\/(\d+)/)?.[1];
  const key = id && OURS.get(id);
  if (!key) continue; // not one of our drafted golfers
  try {
    const competitor = await getJSON(it.$ref);
    const statusRef = competitor.status?.$ref;
    if (!statusRef) {
      console.log(`${key}: no status ref`);
      continue;
    }
    const st = await getJSON(statusRef);
    const name = st.type?.name || '';
    const isCut = name === 'STATUS_CUT';
    cut[key] = isCut;
    resolved++;
    if (isCut) anyCut = true;
    if (st.period) maxPeriod = Math.max(maxPeriod, st.period);
    console.log(`${key.padEnd(12)} ${name || '?'} period=${st.period ?? '?'} -> ${isCut ? 'CUT' : 'in'}`);
  } catch (e) {
    console.log(`skip ${key}: ${e.message}`);
  }
}

// The cut is "decided" once it has actually happened: someone we track is marked
// cut, or our survivors have moved past the 36-hole rounds into round 3+. Before
// then there is nothing authoritative to assert, so the site keeps inferring.
const decided = anyCut || maxPeriod >= 3;

// Never clobber a good file with an empty one on a transient upstream failure.
if (resolved === 0) {
  console.log('No golfers resolved; leaving cut-status.json untouched.');
  process.exit(0);
}

const out = { event: EVENT.id, decided, cut };
writeFileSync(new URL('../cut-status.json', import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
console.log(`\nWrote cut-status.json — ${resolved} golfers, decided=${decided}.`);
