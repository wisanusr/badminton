// Pairing tests. Run: node tests/pairing.js
// The pairing engine lives in index.html between "// pairing:start" and "// pairing:end" (plain JS, no JSX).
// This file cuts that block out and runs it in a vm, and plays whole evenings on a simulated court
// (people arrive/leave at different times, games last ~10 min, courts finish independently) with a seeded random.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('// pairing:start');
const end = html.indexOf('// pairing:end');
if (start === -1 || end === -1) throw new Error('pairing block not found in index.html');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(html.slice(start, end) + '\nthis.api = { proposeGame, planQueue, numberQueue, pairQueue, pairStreak, checkGame, parseAvoidRules, pairSkillOf, pairKey };', ctx);
const { proposeGame, planQueue, numberQueue, pairQueue, pairStreak, checkGame, parseAvoidRules, pairSkillOf, pairKey } = ctx.api;
const plain = x => JSON.parse(JSON.stringify(x));

// mulberry32: small seeded PRNG
const seeded = seed => () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const SKILLS = { 'นิวส์': 'H', 'แทน': 'M', 'แอม': 'M', 'กั๊ก': 'M', 'ครีม': 'M', 'หวาน': 'M', 'ต้อม': 'H', 'เหมียว': 'B', 'GP': 'H', 'มอส': 'H', 'พลอย': 'M', 'ปฐม': 'M' };
const EIGHT = ['นิวส์', 'แทน', 'แอม', 'กั๊ก', 'ครีม', 'หวาน', 'ต้อม', 'เหมียว'];
const MIN = 60000;

// people: [{ name, arrive (minute), leave (minute, optional) }] or plain names (arrive at minute 0 in list order)
// ahead = 0: propose one game whenever a court is free; ahead > 0: keep a queue of that many games planned in advance
// (re-planned when someone arrives or leaves, topped up otherwise) and free courts take the first game they can
// returns games: [{ court, teams, start, end, at (minute), notes, pool (who was free) }]
function simulate({ people, courts = 1, minutes = 120, avoid = [], seed = 1, gameLen = () => 10, ahead = 0 }) {
  const rnd = seeded(seed);
  const ps = people.map(p => (typeof p === 'string' ? { name: p, arrive: 0 } : p))
    .map((p, i) => ({ id: 'P' + i, name: p.name, skill: pairSkillOf(SKILLS[p.name]), arrive: p.arrive, leave: p.leave === undefined ? Infinity : p.leave }));
  const order = ps.slice().sort((a, b) => a.arrive - b.arrive || Number(a.id.slice(1)) - Number(b.id.slice(1)));
  order.forEach((p, i) => { p.order = i; p.arrivedAt = p.arrive * MIN; });
  const games = [];
  const playing = Array(courts).fill(null);   // { game, until }
  let tick = 0;
  let queue = [];
  let replan = false;   // someone came or left: re-plan the unlocked queued games at the next planning step
  for (let t = 0; t < minutes; t++) {
    playing.forEach((c, i) => { if (c && c.until <= t) { c.game.end = ++tick; playing[i] = null; } });
    const here = ps.filter(p => p.arrive <= t && p.leave > t);
    if (ps.some(p => p.arrive === t || p.leave === t)) replan = true;
    for (let i = 0; i < courts; i++) {
      if (playing[i]) continue;
      const busy = new Set(playing.filter(Boolean).flatMap(c => c.game.teams.flat()));
      const free = here.filter(p => !busy.has(p.id));
      let g;
      if (ahead) {
        queue = planQueue({ players: here, games, queue, ahead, courts, now: tick, clock: t * MIN, avoid, allPlayers: ps, replan, random: rnd });
        replan = false;
        const k = queue.findIndex(q => !q.teams.flat().some(id => busy.has(id)));
        if (k === -1) continue;
        g = queue[k];
        queue = queue.filter((_, j) => j !== k);
      } else {
        g = proposeGame({ players: free, games, now: tick, clock: t * MIN, avoid, allPlayers: ps, random: rnd });
      }
      if (!g) continue;
      const game = { court: i, teams: plain(g.teams), notes: plain(g.notes), pool: free.map(p => p.id), start: ++tick, end: null, at: t };
      games.push(game);
      playing[i] = { game, until: t + gameLen(rnd) };
    }
  }
  return { games, ps, id: n => ps.find(p => p.name === n).id };
}
const ids = g => g.teams.flat();
const sameCourt = (g, a, b) => ids(g).includes(a) && ids(g).includes(b);
const countGames = games => { const n = {}; games.forEach(g => ids(g).forEach(id => { n[id] = (n[id] || 0) + 1; })); return n; };

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
// scenario tests run twice: one game at a time, and with a queue of games planned ahead
const MODES = [['', 0], [' [queue 3 ahead]', 3]];
const both = (name, fn) => MODES.forEach(([label, ahead]) => test(name + label, () => fn(ahead)));

test('parseAvoidRules reads "a, b / c; d / e" and skips broken parts', () => {
  assert.deepStrictEqual(plain(parseAvoidRules('แทน, หวาน / ต้อม; A/B; broken; /x')), [[['แทน', 'หวาน'], ['ต้อม']], [['A'], ['B']]]);
  assert.deepStrictEqual(plain(parseAvoidRules('')), []);
});

test('pairSkillOf maps B/M/H, anything else is unset (0)', () => {
  assert.deepStrictEqual(['b', 'M', ' H ', 'C', ''].map(pairSkillOf), [1, 2, 3, 0, 0]);
});

test('fewer than 4 free players: no game', () => {
  const ps = ['a', 'b', 'c'].map((n, i) => ({ id: n, name: n, arrivedAt: 0, order: i }));
  assert.strictEqual(proposeGame({ players: ps, games: [], now: 0, clock: 0 }), null);
});

test('first come, first play: the first game is the first 4 to check in', () => {
  for (let seed = 1; seed <= 30; seed++) {
    // listed out of order on purpose; arrival minutes decide. The first game starts at minute 3 once 4 people are in.
    const people = [{ name: 'นิวส์', arrive: 9 }, { name: 'แทน', arrive: 1 }, { name: 'แอม', arrive: 7 }, { name: 'กั๊ก', arrive: 0 },
      { name: 'ครีม', arrive: 2 }, { name: 'หวาน', arrive: 3 }];
    const { games, id } = simulate({ people, minutes: 4, seed });
    assert.deepStrictEqual(ids(games[0]).sort(), ['กั๊ก', 'แทน', 'ครีม', 'หวาน'].map(id).sort(), `seed ${seed}`);
  }
});

test('first game with everyone already there: the first 4 to check in, not a random 4', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const { games, id } = simulate({ people: EIGHT, minutes: 1, seed });
    assert.deepStrictEqual(ids(games[0]).sort(), EIGHT.slice(0, 4).map(id).sort(), `seed ${seed}`);
  }
});

both('8 players, 1 court, 2 hours: nobody plays 3 in a row, games even (±1), no same partners as last game', ahead => {
  for (let seed = 1; seed <= 30; seed++) {
    const { games, ps } = simulate({ people: EIGHT, seed, ahead });
    assert(games.length >= 11, `seed ${seed}: only ${games.length} games`);
    const streak = {}, last = {};
    games.forEach(g => {
      ps.forEach(p => {
        streak[p.id] = ids(g).includes(p.id) ? (streak[p.id] || 0) + 1 : 0;
        assert(streak[p.id] <= 2, `seed ${seed}: ${p.name} played 3 in a row`);
      });
      g.teams.forEach(([a, b]) => assert(!(last[a] === pairKey(a, b) && last[b] === pairKey(a, b)), `seed ${seed}: same partners again`));
      g.teams.forEach(([a, b]) => { last[a] = last[b] = pairKey(a, b); });
    });
    const n = Object.values(countGames(games));
    assert.strictEqual(n.length, 8);
    assert(Math.max(...n) - Math.min(...n) <= 1, `seed ${seed}: uneven ${n}`);
  }
});

both('8 players, 1 court, 2 hours: groups mix (no two fixed groups of 4 taking turns all evening)', ahead => {
  for (let seed = 1; seed <= 30; seed++) {
    const { games, ps } = simulate({ people: EIGHT, seed, ahead });
    ps.forEach(p => {
      const met = new Set(), partners = new Set();
      games.filter(g => ids(g).includes(p.id)).forEach(g => {
        ids(g).forEach(x => { if (x !== p.id) met.add(x); });
        g.teams.forEach(t => { if (t.includes(p.id)) t.forEach(x => { if (x !== p.id) partners.add(x); }); });
      });
      assert(met.size >= 6, `seed ${seed}: ${p.name} only shared games with ${met.size} of 7`);
      // skill balance pairs the one B player with an H player most of the time, so partners vary less than opponents
      assert(partners.size >= 3, `seed ${seed}: ${p.name} only partnered ${partners.size} people`);
    });
  }
});

both('late arrival plays the next game, but does not then play non-stop to catch up', ahead => {
  for (let seed = 1; seed <= 30; seed++) {
    const people = EIGHT.slice(0, 7).map(name => ({ name, arrive: 0 })).concat([{ name: 'เหมียว', arrive: 45 }]);
    const { games, id } = simulate({ people, seed, ahead });
    const after = games.filter(g => g.at >= 45);
    assert(ids(after[0]).includes(id('เหมียว')), `seed ${seed}: not in the first game after check-in`);
    const mine = after.filter(g => ids(g).includes(id('เหมียว'))).length;
    assert(mine <= Math.ceil(after.length * 4 / 8) + 1, `seed ${seed}: late player got ${mine} of ${after.length} games`);
  }
});

both('people who left are not picked again', ahead => {
  const people = EIGHT.map((name, i) => ({ name, arrive: 0, leave: i < 3 ? 60 : undefined }));
  const { games, ps } = simulate({ people, seed: 5, ahead });
  games.filter(g => g.at >= 60).forEach(g => ps.slice(0, 3).forEach(p => assert(!ids(g).includes(p.id), `${p.name} played after leaving`)));
});

both('2 courts finishing at different times: no one on two courts at once, everyone gets games', ahead => {
  for (let seed = 1; seed <= 20; seed++) {
    const people = ['นิวส์', 'แทน', 'แอม', 'กั๊ก', 'ครีม', 'หวาน', 'ต้อม', 'เหมียว', 'GP', 'มอส', 'พลอย', 'ปฐม'];
    const { games } = simulate({ people, courts: 2, seed, ahead, gameLen: r => 8 + Math.floor(r() * 6) });
    games.forEach(g => {
      const overlap = games.filter(o => o !== g && o.start < (g.end || Infinity) && g.start < (o.end || Infinity));
      overlap.forEach(o => assert(!ids(o).some(x => ids(g).includes(x)), `seed ${seed}: someone on two courts`));
    });
    const n = Object.values(countGames(games));
    assert.strictEqual(n.length, 12);
    assert(Math.max(...n) - Math.min(...n) <= 2, `seed ${seed}: uneven ${n}`);
  }
});

both('avoid rule: แทน/หวาน never share a court with ต้อม unless only those 4 were free (then the game carries a note)', ahead => {
  const avoid = parseAvoidRules('แทน, หวาน / ต้อม');
  for (let seed = 1; seed <= 30; seed++) {
    for (const courts of [1, 2]) {
      const people = ['นิวส์', 'แทน', 'แอม', 'กั๊ก', 'ครีม', 'หวาน', 'ต้อม', 'เหมียว', 'GP', 'พลอย']
        .map((name, i) => ({ name, arrive: name === 'พลอย' ? 60 : i * 2, leave: name === 'GP' ? 60 : undefined }));
      const { games, id } = simulate({ people, courts, avoid, seed, ahead });
      games.forEach(g => {
        if (!sameCourt(g, id('แทน'), id('ต้อม')) && !sameCourt(g, id('หวาน'), id('ต้อม'))) return;
        const withoutTom = g.pool.filter(x => x !== id('ต้อม')).length;
        const withoutPair = g.pool.filter(x => x !== id('แทน') && x !== id('หวาน')).length;
        assert(withoutTom < 4 && withoutPair < 4, `seed ${seed} courts ${courts} min ${g.at}: rule broken though avoidable`);
        assert(g.notes.some(n => n.includes('ต้อม')), 'the game says why');
      });
    }
  }
});

const queueWorld = (names = EIGHT) => names.map((n, i) => ({ id: 'P' + i, name: n, skill: pairSkillOf(SKILLS[n]), arrivedAt: 0, order: i }));

test('planQueue: plans "ahead" games; topping up keeps the games already planned', () => {
  const players = queueWorld();
  const base = { players, games: [], now: 0, clock: 0 };
  const q2 = planQueue({ ...base, ahead: 2, random: seeded(1) });
  assert.strictEqual(q2.length, 2);
  const q4 = planQueue({ ...base, ahead: 4, queue: q2, random: seeded(2) });
  assert.strictEqual(q4.length, 4);
  assert.deepStrictEqual(plain(q4.slice(0, 2)), plain(q2), 'no reshuffle of announced games');
  // the queue is planned as one sequence: game 2 is played by the 4 who sit out game 1
  assert.deepStrictEqual(plain(ids(q2[0]).concat(ids(q2[1])).sort()), players.map(p => p.id).sort());
});

test('planQueue: replan (someone arrived) redraws unlocked games but keeps locked ones; the newcomer gets in early', () => {
  const players = queueWorld(EIGHT.slice(0, 7));
  const base = { games: [], now: 0, clock: 30 * MIN, ahead: 3 };
  const q = planQueue({ ...base, players, random: seeded(1) });
  q[1] = { ...q[1], locked: true };
  const newcomer = { id: 'P7', name: 'เหมียว', skill: 1, arrivedAt: 30 * MIN, order: 7 };
  const r = planQueue({ ...base, players: players.concat(newcomer), queue: q, replan: true, random: seeded(9) });
  assert.deepStrictEqual(plain(r[1].teams), plain(q[1].teams), 'locked game kept');
  assert(ids(r[0]).includes('P7') || ids(r[2]).includes('P7'), 'newcomer is in an unlocked game soon');
});

test('planQueue: a game with someone who left is re-planned even if locked', () => {
  const players = queueWorld();
  const q = planQueue({ players, games: [], now: 0, clock: 0, ahead: 2, random: seeded(3) }).map(g => ({ ...g, locked: true }));
  const gone = ids(q[0])[0];
  const r = planQueue({ players: players.filter(p => p.id !== gone), games: [], queue: q, now: 0, clock: 0, ahead: 2, replan: true, random: seeded(4) });
  assert(!r.some(g => ids(g).includes(gone)));
  assert.deepStrictEqual(plain(r[1].teams), plain(q[1].teams), 'the other locked game stays');
});

test('planQueue: with 2 courts, consecutive queued games never share a player (they run at the same time)', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const players = queueWorld(['นิวส์', 'แทน', 'แอม', 'กั๊ก', 'ครีม', 'หวาน', 'ต้อม', 'เหมียว', 'GP', 'มอส']);
    const live = { teams: [['P0', 'P1'], ['P2', 'P3']], start: 1, end: null };
    const q = planQueue({ players, games: [live], now: 1, clock: 0, ahead: 4, courts: 2, random: seeded(seed) });
    assert(!ids(q[0]).some(x => ids(live).includes(x)), `seed ${seed}: first queued game uses someone still on court`);
    for (let k = 1; k < q.length; k++) assert(!ids(q[k]).some(x => ids(q[k - 1]).includes(x)), `seed ${seed}: games ${k} and ${k + 1} overlap`);
  }
});

test('numberQueue: match numbers stay fixed as games start, get redrawn, and the queue is topped up', () => {
  const players = queueWorld();
  const plan = (queue, games, ahead, seed, replan = false) =>
    numberQueue(planQueue({ players, games, queue, ahead, now: games.length * 2, clock: 0, replan, random: seeded(seed) }), queue, games);
  let q = plan([], [], 3, 1);
  assert.deepStrictEqual(plain(q.map(g => g.no)), [1, 2, 3]);
  // start #1: it leaves the queue with its number, #2 #3 keep theirs, the top-up is #4
  const games = [{ no: 1, teams: q[0].teams, start: 1, end: 2 }];
  q = plan(q.slice(1), games, 3, 2);
  assert.deepStrictEqual(plain(q.map(g => g.no)), [2, 3, 4]);
  // redraw #3 (placeholder keeps the slot number) and a full replan: numbers do not move
  q = plan(q.map((g, k) => (k === 1 ? { no: g.no } : g)), games, 3, 3);
  assert.deepStrictEqual(plain(q.map(g => g.no)), [2, 3, 4]);
  q = plan(q, games, 3, 4, true);
  assert.deepStrictEqual(plain(q.map(g => g.no)), [2, 3, 4]);
  // a game started out of order (#3 before #2): #2 stays #2, next new one is #5
  const games2 = games.concat([{ no: 3, teams: q[1].teams, start: 3, end: 4 }]);
  q = plan([q[0], q[2]], games2, 3, 5);
  assert.deepStrictEqual(plain(q.map(g => g.no)), [2, 4, 5]);
});

test('full queue: 8 people, 1 court, 2 hours × 6 = 12 matches that keep the rules all the way', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const players = queueWorld();
    const q = planQueue({ players, games: [], now: 0, clock: 0, ahead: 12, perHour: 6, random: seeded(seed) });
    assert.strictEqual(q.length, 12);
    const streak = {};
    q.forEach(g => players.forEach(p => {
      streak[p.id] = ids(g).includes(p.id) ? (streak[p.id] || 0) + 1 : 0;
      assert(streak[p.id] <= 2, `seed ${seed}: ${p.name} 3 in a row`);
    }));
    const n = Object.values(countGames(q));
    assert(Math.max(...n) - Math.min(...n) <= 1, `seed ${seed}: uneven ${n}`);
  }
});

test('full queue: one-hour players only in their hour (matches 1-6 = first hour, 7-12 = second)', () => {
  for (let seed = 1; seed <= 20; seed++) {
    // P6, P7 only 18:00-19:00; P8, P9 only 19:00-20:00
    const players = queueWorld(['นิวส์', 'แทน', 'แอม', 'กั๊ก', 'ครีม', 'หวาน', 'ต้อม', 'เหมียว', 'GP', 'มอส'])
      .map((p, i) => (i === 6 || i === 7 ? { ...p, hours: [true, false] } : i >= 8 ? { ...p, hours: [false, true] } : p));
    const q = planQueue({ players, games: [], now: 0, clock: 0, ahead: 12, perHour: 6, random: seeded(seed) });
    q.forEach((g, k) => {
      if (k >= 6) assert(!ids(g).some(x => x === 'P6' || x === 'P7'), `seed ${seed}: first-hour player in match ${k + 1}`);
      if (k < 6) assert(!ids(g).some(x => x === 'P8' || x === 'P9'), `seed ${seed}: second-hour player in match ${k + 1}`);
    });
    assert(q.slice(0, 6).some(g => ids(g).includes('P6')) && q.slice(6).some(g => ids(g).includes('P8')), 'they still play in their hour');
    // after 7 matches have been played, the next queued one is match 8 = second hour
    const played = q.slice(0, 7).map((g, i) => ({ teams: g.teams, start: 2 * i + 1, end: 2 * i + 2 }));
    const r = planQueue({ players, games: played, now: 14, clock: 0, ahead: 5, perHour: 6, slotBase: 7, random: seeded(seed) });
    r.forEach(g => assert(!ids(g).some(x => x === 'P6' || x === 'P7'), `seed ${seed}: first-hour player after match 7`));
  }
});

test('full queue, 2 courts: 12 per hour, games next to each other in the queue never share a player', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const players = queueWorld(['นิวส์', 'แทน', 'แอม', 'กั๊ก', 'ครีม', 'หวาน', 'ต้อม', 'เหมียว', 'GP', 'มอส']);
    const live = { court: 0, teams: [['P0', 'P1'], ['P2', 'P3']], start: 1, end: null };
    const q = planQueue({ players, games: [live], now: 1, clock: 0, courts: 2, ahead: 23, perHour: 12, slotBase: 1, random: seeded(seed) });
    assert.strictEqual(q.length, 23);
    assert(!ids(q[0]).some(x => ids(live).includes(x)), `seed ${seed}: first queued game uses someone still on court`);
    for (let k = 1; k < q.length; k++) assert(!ids(q[k]).some(x => ids(q[k - 1]).includes(x)), `seed ${seed}: matches ${k} and ${k + 1} overlap`);
  }
});

test('teams are skill-balanced: H M M B becomes H+B vs M+M', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const { games, ps } = simulate({ people: ['นิวส์', 'แทน', 'แอม', 'เหมียว'], minutes: 1, seed });
    const sum = t => t.reduce((n, id) => n + ps.find(p => p.id === id).skill, 0);
    assert.strictEqual(sum(games[0].teams[0]), sum(games[0].teams[1]), `seed ${seed}`);
  }
});

test('pairStreak: back-to-back games count, a game started without you is a rest', () => {
  const g = (teams, start, end) => ({ teams, start, end });
  const games = [g([['a', 'b'], ['c', 'd']], 1, 2), g([['a', 'e'], ['c', 'f']], 3, 4), g([['b', 'e'], ['d', 'f']], 5, 6)];
  assert.strictEqual(pairStreak('a', games.slice(0, 2), 4), 2);
  assert.strictEqual(pairStreak('a', games, 6), 0, 'game 3 started without a');
  assert.strictEqual(pairStreak('e', games, 6), 2);
  assert.strictEqual(pairStreak('z', games, 6), 0);
});

test('pairQueue: people with no games always come before people who played, even when rounding puts them in the same tier', () => {
  // checked in long before: 1 game over many slots rounds to the same tier as 0 games
  const ps = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((n, i) => ({ id: n, name: n, arrivedAt: 0, order: i }));
  const games = [{ teams: [['a', 'b'], ['c', 'd']], start: 1, end: 2 }];
  const q = pairQueue({ players: ps, games, now: 2, clock: 400 * MIN });
  assert.deepStrictEqual(plain(q.slice(0, 4).map(r => r.id)), ['e', 'f', 'g', 'h']);
});

test('pairQueue: rested and fewer games first; at zero games, arrival order', () => {
  const ps = ['a', 'b', 'c', 'd', 'e', 'f'].map((n, i) => ({ id: n, name: n, arrivedAt: 0, order: i }));
  const games = [{ teams: [['a', 'b'], ['c', 'd']], start: 1, end: 2 }];
  assert.deepStrictEqual(plain(pairQueue({ players: ps, games, now: 2, clock: 10 * MIN }).map(r => r.id)), ['e', 'f', 'a', 'b', 'c', 'd']);
});

test('checkGame flags a hand-made game that breaks the rules', () => {
  const all = ['แทน', 'ต้อม', 'a', 'b'].map((n, i) => ({ id: 'P' + i, name: n }));
  const notes = checkGame({ teams: [['P0', 'P2'], ['P1', 'P3']], games: [], avoid: parseAvoidRules('แทน / ต้อม'), allPlayers: all });
  assert(notes.some(n => n.includes('แทน') && n.includes('ต้อม')));
});

let failed = 0;
for (const t of tests) {
  try { t.fn(); console.log('  ok   ' + t.name); }
  catch (e) { failed++; console.log('  FAIL ' + t.name + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n       ')); }
}
console.log(failed ? `\n${failed} pairing test(s) failed` : '\nPAIRING OK');
process.exit(failed ? 1 : 0);
