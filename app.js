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

const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'];

// Rows the user has opened. Kept across refreshes so a 60s repaint doesn't
// collapse a card someone is reading.
const expanded = new Set();

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
      cls = 'round penalty';
    } else if (r > roundsStarted) {
      cls = 'round pending';
    }
    cells.push(`<span class="${cls}" title="Round ${r}">${text}</span>`);
  }
  return cells.join('');
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
    <span class="golfer-name">${golfer.name}${badge}</span>
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
    tieNote = `<span class="chip danger">dead heat with ${row.unresolvedWith.join(', ')} — league must settle</span>`;
  } else if (row.tiedOnScore) {
    tieNote = `<span class="chip">tied on score — separated by prediction ${formatToPar(row.prediction)}</span>`;
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

  const marker = live
    ? `<span class="leader-marker" style="left:${pos(winningScore)}%">
         <span class="leader-marker-label">${formatToPar(winningScore)}</span>
       </span>`
    : '';

  trackEl.innerHTML = `
    <span class="track-line"></span>
    ${marker}
    ${dots}
    <span class="track-end left">${formatToPar(lo)}</span>
    <span class="track-end right">${formatToPar(hi)}</span>`;

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

function render(board, standings) {
  const { rows, roundsStarted, penalties, winningScore } = standings;

  renderLeaderPanel(standings);

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
      .filter(([r]) => Number(r) >= 3)
      .map(([r, p]) => `R${r} ${formatToPar(p)}`);
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
