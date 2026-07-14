import { REFRESH_SECONDS } from './config.js';
import { fetchLeaderboard, computeStandings, formatToPar } from './scoring.js';

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status-line');
const refreshEl = document.getElementById('refresh-line');
const errorEl = document.getElementById('error');
const leaderNoteEl = document.getElementById('leader-note');

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

function render(board, standings) {
  const { rows, roundsStarted, penalties, winningScore } = standings;

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

  refreshEl.textContent = DEMO
    ? 'DEMO — replaying a finished event, not real Open scores'
    : `Updated ${new Date().toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
      })}`;
}

// ?demo replays a finished tournament so the league can see the live board
// (rankings, cut penalties, tiebreaks) before The Open starts.
const DEMO = new URLSearchParams(location.search).has('demo');

async function tick() {
  try {
    const board = await fetchLeaderboard({ demo: DEMO });
    render(board, computeStandings(board));
    errorEl.hidden = true;
    if (DEMO) document.body.classList.add('demo');
  } catch (err) {
    errorEl.hidden = false;
    errorEl.textContent = `Couldn't load scores: ${err.message}. Retrying in ${REFRESH_SECONDS}s.`;
  }
}

tick();
setInterval(tick, REFRESH_SECONDS * 1000);
