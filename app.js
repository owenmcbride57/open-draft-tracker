// Load our dependencies at the same version this file was loaded at, so a cached
// app.js can never be paired with a differently-cached scoring.js. index.html
// sets ?v=N on this script; we pass it straight down the import graph.
const V = new URL(import.meta.url).search;

const { REFRESH_SECONDS } = await import(`./config.js${V}`);
const { fetchLeaderboard, computeStandings, formatToPar } = await import(`./scoring.js${V}`);

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status-line');
const refreshEl = document.getElementById('refresh-line');
const errorEl = document.getElementById('error');
const leaderNoteEl = document.getElementById('leader-note');
const refreshBtn = document.getElementById('refresh');
const leaderScoreEl = document.getElementById('leader-score');
const leaderNamesEl = document.getElementById('leader-names');
const closestEl = document.getElementById('closest');
const trackEl = document.getElementById('track');
const predListEl = document.getElementById('pred-list');
const cutLineEl = document.getElementById('cut-line');
const cutNoteEl = document.getElementById('cut-note');
const golferBoardEl = document.getElementById('golfer-board');
const gLeaderScoreEl = document.getElementById('g-leader-score');
const gLeaderNamesEl = document.getElementById('g-leader-names');
const scorecardsEl = document.getElementById('scorecards');

// ---------------------------------------------------------------------------
// Tabs. Driven off the URL hash so a link to a specific view survives a reload
// and can be shared into the group chat.
// ---------------------------------------------------------------------------

const VIEWS = ['draft', 'tracker', 'golfers', 'cards'];

function showView(name) {
  const view = VIEWS.includes(name) ? name : 'draft';
  for (const el of document.querySelectorAll('.panel-view')) {
    el.hidden = el.dataset.view !== view;
  }
  for (const el of document.querySelectorAll('.tab')) {
    const active = el.dataset.tab === view;
    el.classList.toggle('active', active);
    el.setAttribute('aria-selected', active);
  }
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    location.hash = tab.dataset.tab;
  });
}

window.addEventListener('hashchange', () => showView(location.hash.slice(1)));
showView(location.hash.slice(1));

const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'];

// Rows the user has opened. Kept across refreshes so a 60s repaint doesn't
// collapse a card someone is reading.
const expanded = new Set();

// Turn an ISO tee-time instant into the viewer's own local clock time. Passing
// no locale/zone to toLocaleTimeString uses the browser's timezone, so the time
// shown is automatically local to whoever is looking — a viewer in California
// sees Pacific, one in London sees BST, from the one shared instant. timeZoneName
// makes the zone explicit so a shared screenshot is never ambiguous, and the
// weekday is added when the tee isn't today (e.g. tomorrow's round). Returns null
// for a missing or unparseable time so callers can simply fall back.
function formatTeeTime(iso) {
  if (!iso) return null;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;

  const time = t.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  const sameDay = t.toDateString() === new Date().toDateString();
  if (sameDay) return time;
  return `${t.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

// A small tee-time chip: a golf flag and the upcoming tee in the viewer's local
// time. Empty string when there's no upcoming tee, so it drops out cleanly.
function teeTag(iso) {
  const t = formatTeeTime(iso);
  return t
    ? `<span class="tee-time" title="Tee time for the upcoming round — your local time">⛳ ${t}</span>`
    : '';
}

function roundCells(golfer, roundsStarted) {
  const cells = [];
  for (let r = 1; r <= 4; r++) {
    const played = golfer.rounds?.[r] != null;
    const penalty = golfer.penaltyRounds?.find((p) => p.round === r);

    let text = '·';
    let cls = 'round pending';
    if (played) {
      text = formatToPar(golfer.rounds[r]);
      cls = 'round played';
    } else if (penalty) {
      text = formatToPar(penalty.score);
      cls = `round penalty${penalty.provisional ? ' provisional' : ''}`;
    } else if (r > roundsStarted) {
      cls = 'round pending';
    }
    cells.push(`<span class="${cls}" title="Round ${r}">${text}</span>`);
  }
  return cells.join('');
}

// A small round thumbnail for a golfer, from ESPN's headshot CDN keyed by the
// same athlete id we pin in config.js. If the image 404s (or the CDN is blocked)
// it removes itself, revealing the golfer's initials underneath — so a name is
// never left with an empty or broken image beside it.
function avatar(g) {
  const initials = g.name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return `<span class="avatar" aria-hidden="true">
    <span class="avatar-fallback">${initials}</span>
    <img src="https://a.espncdn.com/i/headshots/golf/players/full/${g.id}.png"
         alt="" loading="lazy" decoding="async" onerror="this.remove()" />
  </span>`;
}

// A per-golfer progress indicator for the round they're on: not started → thru
// N → F. A missed-cut golfer has no live round, so the MC badge stands in for it.
function holeIndicator(golfer) {
  if (golfer.missing || golfer.cut) return '';

  const thru = golfer.thru ?? 0;
  let cls = 'idle';
  let label = 'Not started';
  if (golfer.roundComplete) {
    cls = 'done';
    label = 'F';
  } else if (thru > 0) {
    cls = 'live';
    label = `thru ${thru}`;
  }

  const pct = golfer.roundComplete ? 100 : Math.round((thru / 18) * 100);
  const round = golfer.currentRound ? ` of round ${golfer.currentRound}` : '';
  // Waiting to start a round (not yet teed off, or done for the day with the next
  // round's tee published) — show when they go out. scoring.js only sets teeTime
  // while the round genuinely hasn't started, so no extra guard is needed here.
  const tee = teeTag(golfer.teeTime);
  return `<span class="hole-progress ${cls}" title="${label}${round}">
    <span class="hp-bar"><span class="hp-fill" style="width:${pct}%"></span></span>
    <span class="hp-label">${label}</span>
  </span>${tee}`;
}

function golferRow(golfer, roundsStarted) {
  if (golfer.missing) {
    return `<li class="golfer missing">
      <span class="golfer-name">${golfer.name}</span>
      <span class="golfer-note">not in field</span>
      <span class="golfer-total">—</span>
    </li>`;
  }

  const badge = golfer.cut ? '<span class="badge cut">MC</span>' : '';
  return `<li class="golfer${golfer.cut ? ' is-cut' : ''}">
    <span class="golfer-name">${golfer.name}${badge}${holeIndicator(golfer)}</span>
    <span class="rounds">${roundCells(golfer, roundsStarted)}</span>
    <span class="golfer-total">${formatToPar(golfer.total)}</span>
  </li>`;
}

function entryCard(row, roundsStarted, live) {
  const isOpen = expanded.has(row.manager);
  const cut = row.golfers.filter((g) => g.cut).length;

  const penaltyNote = cut
    ? `<span class="chip warn">${cut} missed cut · penalty applied</span>`
    : '';
  let tieNote = '';
  if (row.unresolved) {
    tieNote = `<span class="chip danger">dead heat — tiebreaker not settled · ${formatToPar(row.prediction)}</span>`;
  } else if (row.tiedOnScore) {
    tieNote = `<span class="chip">tiebreaker settled · ${formatToPar(row.prediction)}</span>`;
  }

  const picksPreview = row.golfers.map((g) => g.name.split(' ').slice(-1)[0]).join(' · ');

  return `<li class="entry${isOpen ? ' open' : ''}${cut ? ' has-cut' : ''}${row.unresolved ? ' unresolved' : ''}" data-manager="${row.manager}">
    <button class="entry-head" aria-expanded="${isOpen}">
      <span class="pick">${live ? ORDINALS[row.pick - 1] : '—'}</span>
      <span class="manager">
        <span class="manager-name">${row.manager}</span>
        <span class="picks-preview">${picksPreview}</span>
      </span>
      <span class="chips">${penaltyNote}${tieNote}</span>
      <span class="prediction" title="Predicted winning score (tiebreaker)">${formatToPar(row.prediction)}</span>
      <span class="total">${live ? formatToPar(row.total) : '—'}</span>
    </button>
    <ul class="golfers">
      ${row.golfers.map((g) => golferRow(g, roundsStarted)).join('')}
    </ul>
  </li>`;
}

// Plot every prediction on a shared scale with the live leader marked. Lower
// (better) scores sit to the left, the way a golf leaderboard reads.
function renderLeaderPanel({ winningScore, leaders = [], predictions = [] }) {
  // A visitor holding a cached index.html from before this panel existed will not
  // have these nodes. Skip the panel rather than throwing and taking the whole
  // board down with it — the draft order matters far more than the tracker.
  if (!leaderScoreEl || !leaderNamesEl || !closestEl || !trackEl || !predListEl) return;

  const live = winningScore != null;

  leaderScoreEl.textContent = live ? formatToPar(winningScore) : '—';
  leaderScoreEl.classList.toggle('is-live', live);

  if (!live) {
    leaderNamesEl.textContent = 'No scores yet';
    closestEl.textContent = '—';
  } else {
    // A shared lead is common, and it's usually someone nobody drafted.
    leaderNamesEl.textContent =
      leaders.length === 0
        ? '—'
        : leaders.length <= 2
          ? leaders.join(' & ')
          : `${leaders[0]} +${leaders.length - 1} more`;

    const best = predictions[0];
    const alsoBest = predictions.filter((p) => p.delta === best.delta);
    closestEl.innerHTML =
      best.delta === 0
        ? `<strong>${alsoBest.map((p) => p.manager).join(', ')}</strong> <span class="spot-on">spot on</span>`
        : `<strong>${alsoBest.map((p) => p.manager).join(', ')}</strong> <span class="off">${best.delta} off</span>`;
  }

  // Scale spans every prediction plus the leader, so the marker never falls off
  // the end if someone runs away with it at -20.
  const values = predictions.map((p) => p.prediction);
  if (live) values.push(winningScore);
  const lo = Math.min(...values) - 1;
  const hi = Math.max(...values) + 1;
  const pos = (v) => ((v - lo) / (hi - lo)) * 100;

  // Several managers picked the same number, so collapse them into one dot.
  const groups = new Map();
  for (const p of predictions) {
    if (!groups.has(p.prediction)) groups.set(p.prediction, []);
    groups.get(p.prediction).push(p.manager);
  }

  const dots = [...groups.entries()]
    .map(
      ([value, managers]) => `
      <span class="dot${managers.length > 1 ? ' multi' : ''}"
            style="left:${pos(value)}%"
            title="${managers.join(', ')} — predicted ${formatToPar(value)}">
        <span class="dot-label">${formatToPar(value)}</span>
      </span>`,
    )
    .join('');

  // The live leader. The scale is built from the predictions AND the leader, so
  // this marker is always inside the track — if someone runs away to -25 the
  // scale simply stretches to hold them and the prediction dots bunch up on the
  // right. It can never fall off the end.
  let marker = '';
  if (live) {
    const at = pos(winningScore);
    // Keep the label inside the panel when the marker sits near an edge.
    const edge = at < 14 ? ' edge-left' : at > 86 ? ' edge-right' : '';
    marker = `<span class="leader-marker${edge}" style="left:${at}%">
         <span class="leader-marker-label">LEADER ${formatToPar(winningScore)}</span>
         <span class="leader-dot"></span>
       </span>`;
  }

  trackEl.innerHTML = `
    <span class="track-line"></span>
    ${dots}
    ${marker}`;

  predListEl.innerHTML = predictions
    .map((p) => {
      const delta =
        p.delta == null
          ? ''
          : p.delta === 0
            ? '<span class="delta spot-on">spot on</span>'
            : `<span class="delta">${p.delta} off</span>`;
      // Tell people which way they're wrong — it's the thing they actually want
      // to know once the leader passes their number.
      const dir =
        !live || p.delta === 0
          ? ''
          : p.direction === 'under'
            ? '<span class="dir">leader is past it</span>'
            : '<span class="dir">leader not there yet</span>';
      return `<li>
        <span class="pred-manager">${p.manager}</span>
        <span class="pred-value">${formatToPar(p.prediction)}</span>
        ${delta}
        ${dir}
      </li>`;
    })
    .join('');
}

// Every drafted golfer, ranked, with the cut line drawn straight through the
// list — above it you're surviving, below it you're going home.
function renderGolferBoard({ cut, golferBoard, roundsStarted, winningScore, leaders = [] }) {
  if (!cutLineEl || !cutNoteEl || !golferBoardEl) return;

  // The tournament leader, for context: the cut line alone doesn't tell you what
  // a good score looks like in the day's conditions.
  if (gLeaderScoreEl && gLeaderNamesEl) {
    const live = winningScore != null;
    gLeaderScoreEl.textContent = live ? formatToPar(winningScore) : '—';
    gLeaderScoreEl.classList.toggle('is-live', live);

    if (!live) {
      gLeaderNamesEl.textContent = 'Not started';
    } else {
      const drafted = golferBoard.filter((g) => leaders.includes(g.name));
      const who =
        leaders.length <= 2 ? leaders.join(' & ') : `${leaders[0]} +${leaders.length - 1} more`;
      // The leader is usually someone nobody in the league picked — worth saying.
      gLeaderNamesEl.innerHTML = drafted.length
        ? `${who} <span class="ours">drafted by ${[...new Set(drafted.flatMap((g) => g.owners))].join(', ')}</span>`
        : `${who} <span class="not-ours">nobody picked them</span>`;
    }
  }

  cutLineEl.textContent = cut.line == null ? '—' : formatToPar(cut.line);
  cutLineEl.classList.toggle('is-live', cut.line != null);

  cutNoteEl.textContent =
    roundsStarted === 0
      ? 'Not started. The Open cuts to the top 70 and ties after 36 holes.'
      : cut.decided
        ? 'Final — the cut has been made.'
        : 'Projected: top 70 and ties. This line moves as the field posts scores.';

  const rounds = (g) => {
    const cells = [];
    for (let r = 1; r <= 4; r++) {
      const played = g.rounds?.[r] != null;
      cells.push(
        `<span class="round ${played ? 'played' : 'pending'}">${
          played ? formatToPar(g.rounds[r]) : '·'
        }</span>`,
      );
    }
    return cells.join('');
  };

  const row = (g) => {
    if (!g.found) {
      return `<li class="golfer-row missing">
        <span class="g-name">${avatar(g)}${g.name}</span>
        <span class="g-note">not in field</span>
      </li>`;
    }

    // How comfortable are they? Only meaningful while the cut is still in play.
    let margin = '';
    if (g.toCut != null && !cut.decided) {
      if (g.toCut < 0) margin = `<span class="margin in">${Math.abs(g.toCut)} inside</span>`;
      else if (g.toCut === 0) margin = '<span class="margin edge">on the line</span>';
      else margin = `<span class="margin out">${g.toCut} outside</span>`;
    } else if (cut.decided) {
      margin = g.madeCut
        ? '<span class="margin in">made the cut</span>'
        : '<span class="margin out">missed the cut</span>';
    }

    // Before there's a cut line nobody is outside it — render them neutrally
    // rather than greying the whole field out as if they'd all missed.
    const standing = cut.line == null ? 'neutral' : g.inside ? 'inside' : 'outside';

    const crown = leaders.includes(g.name) ? '<span class="badge lead">LEADER</span>' : '';

    // Overall place in the whole field, alongside the relative placing this
    // list already conveys by order and the cut divider. CUT for the eliminated,
    // — before there is anything to rank.
    const pos =
      g.position == null
        ? '<span class="g-pos none">—</span>'
        : `<span class="g-pos${g.position === 'CUT' ? ' cut' : ''}">${g.position}</span>`;

    return `<li class="golfer-row ${standing}${crown ? ' is-leader' : ''}">
      ${pos}
      <span class="g-name">${avatar(g)}${g.name}${crown}${teeTag(g.teeTime)}</span>
      <span class="g-owners"><span class="count">${g.owners.length}×</span> ${g.owners.join(', ')}</span>
      <span class="g-rounds">${rounds(g)}</span>
      ${margin}
      <span class="g-total">${formatToPar(g.total)}</span>
    </li>`;
  };

  // Split the list where the cut falls, and put an actual line there.
  const inside = golferBoard.filter((g) => g.found && g.inside);
  const outside = golferBoard.filter((g) => g.found && !g.inside);
  const absent = golferBoard.filter((g) => !g.found);

  const divider =
    cut.line == null
      ? ''
      : `<li class="cut-divider">
           <span>${cut.decided ? 'CUT' : 'PROJECTED CUT'} — ${formatToPar(cut.line)}</span>
         </li>`;

  golferBoardEl.innerHTML =
    roundsStarted === 0
      ? golferBoard.map(row).join('')
      : inside.map(row).join('') + divider + outside.map(row).join('') + absent.map(row).join('');
}

// Classify a hole's result for colouring. ESPN gives the hole's score to par
// directly ("-1" birdie, "E" par, "+1" bogey) — verified against real cards,
// where the per-hole results sum exactly to the round total.
function holeClass(result) {
  if (result === 'E') return 'par';
  const n = Number(String(result).replace('+', ''));
  if (!Number.isFinite(n)) return 'par';
  if (n <= -2) return 'eagle';
  if (n === -1) return 'birdie';
  if (n === 0) return 'par';
  if (n === 1) return 'bogey';
  return 'double';
}

function renderScorecards({ scorecards = [], roundsStarted }) {
  if (!scorecardsEl) return;

  if (roundsStarted === 0) {
    scorecardsEl.innerHTML = `<li class="cards-empty">
      No scores yet — cards appear hole by hole once play begins on Thursday.
    </li>`;
    return;
  }

  const grid = (g) =>
    g.holes
      .map((h) => {
        if (!h.played) return `<span class="hole empty" title="Hole ${h.hole}">${h.hole}</span>`;
        // Par is derivable: strokes minus the hole's score to par.
        const par = h.strokes - (h.result === 'E' ? 0 : Number(String(h.result).replace('+', '')));
        return `<span class="hole ${holeClass(h.result)}"
                      title="Hole ${h.hole} · par ${par} · ${h.strokes} strokes (${h.result})">${h.strokes}</span>`;
      })
      .join('');

  const holeNumbers = (g) =>
    g.holes.map((h) => `<span class="hole-num">${h.hole}</span>`).join('');

  scorecardsEl.innerHTML = scorecards
    .map((g) => {
      if (!g.found) {
        return `<li class="scorecard missing">
          <div class="sc-head"><span class="sc-name">${avatar(g)}${g.name}</span>
          <span class="sc-note">not in field</span></div>
        </li>`;
      }

      if (g.state === 'not-started') {
        const tee = formatTeeTime(g.teeTime);
        return `<li class="scorecard idle">
          <div class="sc-head">
            <span class="sc-name">${avatar(g)}${g.name}</span>
            <span class="sc-owners">${g.owners.join(', ')}</span>
            <span class="sc-note">${tee ? `tees off ⛳ ${tee}` : "hasn't teed off"}</span>
          </div>
        </li>`;
      }

      // "Thru" only means something while a round is live. A finished round says
      // F; a cut golfer has no round to be thru.
      let thru = '';
      if (g.state === 'playing') thru = `<span class="sc-thru">thru ${g.thru}</span>`;
      else if (g.state === 'round-done') thru = `<span class="sc-thru">F</span>`;

      const today =
        g.state === 'cut'
          ? ''
          : `<span class="sc-today">${formatToPar(g.today)} <em>today</em></span>`;

      const pos =
        g.position == null
          ? '<span class="sc-pos">—</span>'
          : `<span class="sc-pos${g.position === 'CUT' ? ' cut' : ''}">${g.position}</span>`;

      return `<li class="scorecard ${g.state}">
        <div class="sc-head">
          ${pos}
          <span class="sc-name">${avatar(g)}${g.name}${teeTag(g.teeTime)}</span>
          <span class="sc-owners">${g.owners.join(', ')}</span>
          ${today}
          ${thru}
          <span class="sc-total">${formatToPar(g.total)}</span>
        </div>
        ${
          g.state === 'cut'
            ? '<p class="sc-cutnote">Missed the cut — no further rounds.</p>'
            : `<div class="card-grid">
                 <div class="hole-nums">${holeNumbers(g)}</div>
                 <div class="holes">${grid(g)}</div>
                 <p class="sc-round-label">Round ${g.currentRound}</p>
               </div>`
        }
      </li>`;
    })
    .join('');
}

function render(board, standings) {
  const { rows, roundsStarted, penalties, winningScore } = standings;

  renderLeaderPanel(standings);
  renderGolferBoard(standings);
  renderScorecards(standings);

  // A pick number only means something once someone has actually posted a score.
  const live = roundsStarted > 0;
  boardEl.innerHTML = rows.map((r) => entryCard(r, roundsStarted, live)).join('');

  for (const el of boardEl.querySelectorAll('.entry')) {
    el.querySelector('.entry-head').addEventListener('click', () => {
      const key = el.dataset.manager;
      if (expanded.has(key)) expanded.delete(key);
      else expanded.add(key);
      el.classList.toggle('open');
      el.querySelector('.entry-head').setAttribute('aria-expanded', expanded.has(key));
    });
  }

  if (!board.started) {
    const tee = new Date(board.startDate);
    statusEl.textContent = `Tees off ${tee.toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    })} — no scores yet`;
    leaderNoteEl.textContent = '';
  } else {
    statusEl.textContent = board.complete
      ? 'Final — draft order locked'
      : board.statusDetail || `Round ${roundsStarted} in progress`;

    const applied = Object.entries(penalties)
      .filter(([r, p]) => Number(r) >= 3 && p?.score != null)
      .map(
        ([r, p]) =>
          `R${r} ${formatToPar(p.score)}${p.settled ? '' : ` (provisional — ${p.playing} still out)`}`,
      );
    leaderNoteEl.textContent =
      (winningScore != null ? ` Leader at ${formatToPar(winningScore)}.` : '') +
      (applied.length ? ` Missed-cut penalty: ${applied.join(', ')}.` : '');
  }

  lastUpdated = Date.now();
  paintFreshness();
}

// ?demo replays a finished tournament so the league can see the live board
// (rankings, cut penalties, tiebreaks) before The Open starts.
const DEMO = new URLSearchParams(location.search).has('demo');

let lastUpdated = null;
let inFlight = false;

// Show how stale the board is rather than leaving people to guess. ESPN serves
// this feed with cache-control: max-age=1, so anything we show is at most as old
// as our last poll.
function paintFreshness() {
  if (!refreshEl) return;
  if (DEMO) {
    refreshEl.textContent = 'DEMO — replaying a finished event, not real Open scores';
    return;
  }
  if (inFlight) {
    refreshEl.textContent = 'Refreshing…';
    return;
  }
  if (lastUpdated == null) return;

  const secs = Math.round((Date.now() - lastUpdated) / 1000);
  if (secs < 5) refreshEl.textContent = 'Updated just now';
  else if (secs < 90) refreshEl.textContent = `Updated ${secs}s ago`;
  else refreshEl.textContent = `Updated ${Math.round(secs / 60)} min ago`;
}

async function tick() {
  if (inFlight) return;
  inFlight = true;
  if (refreshBtn) refreshBtn.disabled = true;
  paintFreshness();

  try {
    const board = await fetchLeaderboard({ demo: DEMO });
    inFlight = false;
    render(board, computeStandings(board));
    errorEl.hidden = true;
    if (DEMO) document.body.classList.add('demo');
  } catch (err) {
    inFlight = false;
    errorEl.hidden = false;
    errorEl.textContent = `Couldn't load scores: ${err.message}. Retrying in ${REFRESH_SECONDS}s.`;
    paintFreshness();
  } finally {
    inFlight = false;
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

refreshBtn?.addEventListener('click', tick);

tick();
setInterval(tick, REFRESH_SECONDS * 1000);
// Tick the "updated Xs ago" label independently of the network poll.
setInterval(paintFreshness, 1000);

// ---------------------------------------------------------------------------
// ?debug — a hidden diagnostic. Dumps the raw ESPN competitor `status` for the
// first few golfers and scans each competitor for any tee/time/date field, so we
// can see exactly where (if anywhere) the feed carries a tee time. Only renders
// when ?debug is in the URL, so the league's normal view is untouched.
// ---------------------------------------------------------------------------
async function runDebug() {
  const pre = document.createElement('pre');
  pre.style.cssText =
    'white-space:pre-wrap;word-break:break-word;margin:1rem;padding:1rem;' +
    'background:#0b1a14;border:1px solid #234436;border-radius:8px;color:#eaf3ee;' +
    'font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;';
  pre.textContent = 'debug: fetching ESPN…';
  document.querySelector('main')?.prepend(pre);

  try {
    const { EVENT } = await import(`./config.js${V}`);
    const url = `https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard?dates=${EVENT.date}`;
    const res = await fetch(url, { cache: 'no-store' });
    const data = await res.json();
    const ev =
      (data.events || []).find((e) => e.id === EVENT.id) || (data.events || [])[0];
    const comps = ev?.competitions?.[0]?.competitors || [];

    const out = [];
    out.push(`endpoint: /scoreboard?dates=${EVENT.date}`);
    out.push(`event: ${ev?.name} | state: ${ev?.status?.type?.name} | competitors: ${comps.length}`);

    for (const c of comps.slice(0, 4)) {
      out.push('');
      out.push(`# ${c.athlete?.displayName ?? '?'}`);
      out.push(`status = ${JSON.stringify(c.status)}`);
      const hits = [];
      (function walk(o, path) {
        if (o && typeof o === 'object') {
          for (const k in o) {
            if (/tee|time|date|start|clock/i.test(k)) {
              hits.push(`  ${path}${k} = ${String(JSON.stringify(o[k])).slice(0, 90)}`);
            }
            walk(o[k], `${path}${k}.`);
          }
        }
      })(c, '');
      out.push(hits.length ? `tee/time/date fields:\n${hits.join('\n')}` : 'tee/time/date fields: (none)');
    }
    pre.textContent = out.join('\n');
  } catch (e) {
    pre.textContent = `debug fetch failed: ${e.message}`;
  }
}

if (new URLSearchParams(location.search).has('debug')) runDebug();
