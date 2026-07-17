// Probe: what authoritative cut data does ESPN publish? Looks for a cut line on
// the scoreboard/core event, and each of our golfers' official status (cut vs
// active) on the core API. Temporary diagnostic.
import { GOLFERS, EVENT } from '../config.js';

const CORE = 'https://sports.core.api.espn.com/v2/sports/golf/leagues/pga';
const SB = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard';
const UA = { headers: { 'user-agent': 'cut-probe' } };
const j = async (u) => { const r = await fetch(u, UA); return r.ok ? r.json() : { __err: r.status }; };
const scan = (o, re) => {
  const h = [];
  (function w(x, p) {
    if (x && typeof x === 'object') for (const k in x) {
      if (re.test(k)) h.push(`${p}${k} = ${JSON.stringify(x[k]).slice(0, 90)}`);
      w(x[k], `${p}${k}.`);
    }
  })(o, '');
  return h;
};

const sb = await j(`${SB}?dates=${EVENT.date}`);
const sev = (sb.events || []).find((e) => e.id === EVENT.id) || (sb.events || [])[0];
console.log('=== scoreboard event: fields mentioning "cut" ===');
console.log(scan(sev, /cut/i).slice(0, 12).join('\n') || '(none)');

const cev = await j(`${CORE}/events/${EVENT.id}?lang=en&region=us`);
console.log('\n=== core event: fields mentioning "cut" ===');
console.log(scan(cev, /cut/i).slice(0, 12).join('\n') || '(none)');

const compRef = cev.competitions?.[0]?.$ref;
const comp = compRef ? await j(compRef) : {};
console.log('\n=== core competition: fields mentioning "cut" ===');
console.log(scan(comp, /cut/i).slice(0, 12).join('\n') || '(none)');

const compBase = compRef ? compRef.split('?')[0] : '';
console.log('\n=== our golfers: official core status ===');
for (const [key, g] of Object.entries(GOLFERS)) {
  const c = await j(`${compBase}/competitors/${g.id}?lang=en&region=us`);
  if (c.__err) { console.log(`${key}: competitor ${c.__err}`); continue; }
  const st = c.status?.$ref ? await j(c.status.$ref) : {};
  const type = st.type || {};
  console.log(
    `${key.padEnd(12)} period=${st.period} thru=${st.thru} ` +
    `type=${type.name || type.id}/${type.state || ''} ` +
    `position=${JSON.stringify(st.position)}`,
  );
}
