// ---------------------------------------------------------------------------
// League config. This is the only file you should need to edit.
// ---------------------------------------------------------------------------

// The Open Championship 2026. ESPN event id, used to pull the live leaderboard.
export const EVENT = {
  id: '401811957',
  date: '20260716', // ESPN indexes the scoreboard by start date
  name: 'The Open',
};

// Golfers are pinned by ESPN athlete id, not by name: the field contains both
// Matt Fitzpatrick and his brother Alex, and "Åberg" has a non-ASCII character
// that is easy to get wrong. Ids are stable, names are not.
export const GOLFERS = {
  scheffler:   { id: '9478',    name: 'Scottie Scheffler',  seed: 1 },
  mcilroy:     { id: '3470',    name: 'Rory McIlroy',       seed: 2 },
  young:       { id: '4425906', name: 'Cameron Young',      seed: 3 },
  fitzpatrick: { id: '9037',    name: 'Matt Fitzpatrick',   seed: 4 },
  morikawa:    { id: '10592',   name: 'Collin Morikawa',    seed: 6 },
  fleetwood:   { id: '5539',    name: 'Tommy Fleetwood',    seed: 7 },
  rose:        { id: '569',     name: 'Justin Rose',        seed: 8 },
  rahm:        { id: '9780',    name: 'Jon Rahm',           seed: 11 },
  hovland:     { id: '4364873', name: 'Viktor Hovland',     seed: 12 },
  aberg:       { id: '4375972', name: 'Ludvig Åberg',       seed: 19 },
  dechambeau:  { id: '10046',   name: 'Bryson DeChambeau',  seed: null },
};

// Each manager's three picks, plus their predicted winning score (to par),
// which breaks ties.
//
// `short` is optional and used only where names are listed side by side (the
// golfers tab, where a popular golfer can carry seven owners). The draft board
// always shows the full name.
export const ENTRIES = [
  { manager: 'Jack',                     picks: ['scheffler', 'mcilroy', 'morikawa'],      prediction: -9 },
  { manager: 'Braddy',                   picks: ['scheffler', 'fleetwood', 'fitzpatrick'], prediction: -8 },
  { manager: 'Goon',                     picks: ['mcilroy', 'rose', 'young'],              prediction: -12 },
  { manager: 'Ferrell',                  picks: ['fitzpatrick', 'scheffler', 'rose'],      prediction: -10 },
  { manager: 'Doc',                      picks: ['young', 'fleetwood', 'aberg'],           prediction: -8 },
  { manager: 'Harry',                    picks: ['mcilroy', 'rahm', 'dechambeau'],         prediction: -5 },
  { manager: 'Sweeney',                  picks: ['mcilroy', 'scheffler', 'fitzpatrick'],   prediction: -11 },
  { manager: 'AJ',                       picks: ['scheffler', 'morikawa', 'fleetwood'],    prediction: -16 },
  { manager: 'Patrick John Kealy III',   short: 'PJ', picks: ['scheffler', 'fitzpatrick', 'fleetwood'], prediction: -9 },
  { manager: 'Coop',                     picks: ['scheffler', 'fitzpatrick', 'hovland'],   prediction: -15 },
];

// Tee times for upcoming rounds — entered by hand, because ESPN's public feed
// does not carry them (its scoreboard has scores and hole-by-hole cards, but no
// tee times or pairings). The Open posts the next round's tee times the evening
// before; paste them here and the ⛳ chip appears on the board.
//
// Shape: TEE_TIMES[round][golferKey] = an ISO instant in UTC (note the trailing
// "Z"). The app renders it in each viewer's own local time, and only shows it
// until that golfer actually tees off the round — once they post a hole ESPN's
// score clears the chip automatically, so stale entries look after themselves.
// You only ever add the next round's block; old rounds can stay or be deleted.
//
// Golfer keys are the ones in GOLFERS above (scheffler, mcilroy, young, …).
// Example — Friday's second round:
//   2: {
//     scheffler: '2026-07-17T13:40Z',
//     mcilroy:   '2026-07-17T09:15Z',
//   },
export const TEE_TIMES = {
  // round: { golferKey: 'YYYY-MM-DDTHH:MMZ', … }
};

// How often to re-pull the leaderboard, in seconds.
export const REFRESH_SECONDS = 60;

// The Open cuts to the top 70 and ties after 36 holes. The line therefore moves
// all through Friday as the field posts scores — it is not a fixed number.
export const CUT_SIZE = 70;

// The championship is played over this many rounds. It matters because a tie for
// the win is settled by a playoff — extra holes ESPN reports as further rounds
// (period 5+). Those strokes decide the trophy, not the score: the fantasy total
// is a 72-hole figure, so a golfer dragged into a playoff must be neither charged
// nor credited for it. Anything beyond this round count is dropped as a playoff.
export const TOURNAMENT_ROUNDS = 4;
