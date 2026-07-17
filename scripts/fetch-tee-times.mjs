// Fetch upcoming-round tee times for our drafted golfers and write tee-times.json.
//
// Runs in GitHub Actions (see .github/workflows/tee-times.yml), NOT in the
// browser. ESPN's public scoreboard — the feed the site itself uses — carries no
// tee times, but the deeper "core" API does, on each competitor's status. That
// core API sends no CORS headers, so a static site can't read it directly; a
// server-side Action can, and commits the result for the site to fetch.
//
// Output shape (what app.js expects as `teeTimes`):
//   { "event": "401811957", "rounds": { "2": { "scheffler": "2026-07-17T08:03Z" } } }
// keyed by round number, then golfer key, value an ISO-UTC instant.

import { writeFileSync } from 'node:fs';
import { GOLFERS, EVENT } from '../config.js';

const OURS = new Map(Object.entries(GOLFERS).map(([key, g]) => [String(g.id), key]));
const CORE = 'https://sports.core.api.espn.com/v2/sports/golf/leagues/pga';
const UA = { headers: { 'user-agent': 'open-draft-tracker tee-fetch (github actions)' } };

const getJSON = async (url) => {
  const r = await fetch(url, UA);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
};
const withLimit = (ref) => ref + (ref.includes('?') ? '&' : '?') + 'limit=300';
const statusURL = (ref) => {
  const [path, query] = ref.split('?');
  return `${path}/status${query ? `?${query}` : ''}`;
};

const event = await getJSON(`${CORE}/events/${EVENT.id}?lang=en&region=us`);
const compRef = event.competitions?.[0]?.$ref;
if (!compRef) throw new Error('no competition ref on event');

const competition = await getJSON(compRef);
const listRef = competition.competitors?.$ref;
if (!listRef) throw new Error('no competitors ref on competition');

const list = await getJSON(withLimit(listRef));
const items = list.items || [];
console.log(`field: ${items.length} competitors`);

const rounds = {};
let found = 0;
for (const it of items) {
  const id = it.$ref?.match(/competitors\/(\d+)/)?.[1];
  const key = id && OURS.get(id);
  if (!key) continue; // not one of our drafted golfers
  try {
    const st = await getJSON(statusURL(it.$ref));
    if (st.teeTime && st.period) {
      (rounds[st.period] ||= {})[key] = st.teeTime;
      found++;
      console.log(`R${st.period} ${key.padEnd(12)} ${st.teeTime}  (thru ${st.thru ?? '?'})`);
    } else {
      console.log(`R? ${key.padEnd(12)} no tee time on file yet`);
    }
  } catch (e) {
    console.log(`skip ${key}: ${e.message}`);
  }
}

// Never clobber a good file with an empty one on a transient upstream failure.
if (found === 0) {
  console.log('No tee times resolved; leaving tee-times.json untouched.');
  process.exit(0);
}

const out = { event: EVENT.id, rounds };
writeFileSync(new URL('../tee-times.json', import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
console.log(`\nWrote tee-times.json — ${found} tee times across rounds ${Object.keys(rounds).join(', ')}.`);
