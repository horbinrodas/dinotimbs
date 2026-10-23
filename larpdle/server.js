const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const API = 'https://api.deezer.com';
const PORT = process.env.PORT || 3000;
const LIVES = 3, TOP = 30, SINGLE_CHANCE = 0.2, RATE = 120;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fail = (status, message) => Object.assign(new Error(message), { status });

async function dz(p) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const data = await (await fetch(API + p)).json();
    if (data.error?.code === 4) { await sleep(5000); continue; }
    if (data.error) throw new Error(data.error.message || 'Deezer error');
    return data;
  }
  throw new Error('Deezer rate limit, try again in a minute');
}

async function allPages(p) {
  const out = [];
  for (let url = p; url; ) {
    const page = await dz(url);
    out.push(...page.data);
    url = page.next ? page.next.replace(API, '') : null;
  }
  return out;
}

function cache(ttl) {
  const m = new Map();
  return (key, load) => {
    const hit = m.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const value = load().catch(e => { m.delete(key); throw e; });
    m.set(key, { at: Date.now(), value });
    return value;
  };
}
const MIN = 60e3;
const topOf = cache(10 * MIN);
const tracksOf = cache(10 * MIN);
const releasesOf = cache(360 * MIN);

const VERSION = /remix|remaster/i;

const TAG = /remaster|remix|\bmix(ed)?\b|\blive\b|vivo|directo|concierto|unplugged|versi[oó]n|\bedit\b|\bdemo\b|acoustic|\bmono\b|stereo|deluxe|bonus|instrumental|radio|explicit|\bfeat|\bft\b|\bwith\b|\bfrom\b|re-?record|anniversary|session|\btake \d|\b(19|20)\d\d\b/i;
const clean = title => title
  .replace(/\s*[([]([^)\]]*)[)\]]/g, (m, inner) => (TAG.test(inner) ? ' ' : m))
  .replace(/\s+-\s+(.*)$/, (m, inner) => (TAG.test(inner) ? '' : m))
  .replace(/\s+/g, ' ')
  .trim();

function norm(title) {
  const key = clean(title).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return key || title.toLowerCase().trim();
}
const keyOf = t => norm(t.title_short || t.title);

const toSong = t => {
  const title = clean(t.title_short || t.title);
  return { key: norm(title), title, album: t.album?.title ?? '', preview: t.preview };
};

async function findOriginal(t) {
  const title = clean(t.title_short || t.title);
  const q = `${t.artist.name} ${title}`;
  const { data } = await dz(`/search?q=${encodeURIComponent(q)}&limit=25`);
  const original = data.find(o => o.artist?.id === t.artist.id && o.preview && !VERSION.test(o.title)
    && norm(o.title_short || o.title) === norm(title));
  return original ?? (/remix/i.test(t.title) ? null : t);
}

const tagged = t => clean(t.title) !== t.title.trim();
const LIVE_OR_BEST = /\blive\b|en vivo|en directo|concierto|unplugged|greatest|[eé]xitos|best of|\bhits\b|collection|colecci[oó]n|antolog|anthology|essential|lo mejor|mejores|obras|cumbres|definitiv|\bsingles\b|retrospect/i;

async function pickFrom(tracks, skip) {
  const songs = new Map();
  for (const t of tracks) {
    const key = keyOf(t), seen = songs.get(key);
    if (!skip.has(key) && (!seen || (tagged(seen) && !tagged(t)))) songs.set(key, t);
  }
  const fresh = [...songs.values()];
  for (let tries = 0; tries < 5 && fresh.length; tries++) {
    let t = fresh.splice(Math.floor(Math.random() * fresh.length), 1)[0];
    if (VERSION.test(t.title) && !(t = await findOriginal(t))) continue;
    return toSong(t);
  }
  return null;
}

async function pickTop(artist, skip) {
  const tracks = await topOf(artist.id, async () =>
    (await dz(`/artist/${artist.id}/top?limit=${TOP}`)).data.filter(t => t.preview));
  const mine = tracks.filter(t => t.artist?.id === artist.id);
  return pickFrom(mine.length ? mine : tracks, skip);
}

async function pickCatalog(artist, skip) {
  const releases = await releasesOf(artist.id, () => allPages(`/artist/${artist.id}/albums?limit=100`));
  const singles = releases.filter(r => r.record_type === 'single');
  const albums = releases.filter(r => r.record_type !== 'single' && r.record_type !== 'compile' && !LIVE_OR_BEST.test(r.title));
  const longer = albums.length ? albums : releases.filter(r => r.record_type !== 'single');
  for (let tries = 0; tries < 4; tries++) {
    const useSingles = singles.length && (!longer.length || Math.random() < SINGLE_CHANCE);
    const bucket = useSingles ? singles : longer;
    if (!bucket.length) return null;
    const release = bucket[Math.floor(Math.random() * bucket.length)];
    const tracks = await tracksOf(release.id, async () =>
      (await dz(`/album/${release.id}/tracks?limit=100`)).data
        .filter(t => t.preview && t.artist?.id === artist.id)
        .map(t => ({ ...t, album: { title: release.title } })));
    const song = await pickFrom(tracks, skip);
    if (song) return song;
  }
  return null;
}

const games = new Map();
setInterval(() => {
  for (const [id, g] of games) if (Date.now() - g.seen > 120 * MIN) games.delete(id);
}, 10 * MIN).unref();

const state = g => ({ streak: g.streak, lives: g.lives, track: g.track, over: g.lives <= 0 });

async function newRound(g) {
  const pick = g.level === 'larper' ? pickTop : pickCatalog;
  const song = (await pick(g.artist, g.played)) ?? (await pick(g.artist, new Set()));
  if (!song) throw new Error(`Couldn't find a playable song for ${g.artist.name}.`);
  g.played.add(song.key);
  g.track++;
  g.song = song;
  g.answered = false;
  return { ...state(g), preview: song.preview };
}

function getGame(gameId) {
  const g = games.get(String(gameId || ''));
  if (!g) throw fail(404, 'Game expired');
  g.seen = Date.now();
  return g;
}

const routes = {
  async 'POST /api/game/start'({ artistId, artistName, level }) {
    const id = Number(artistId);
    if (!Number.isInteger(id) || id <= 0 || typeof artistName !== 'string' || !artistName || artistName.length > 200) {
      throw fail(400, 'Pick an artist');
    }
    const g = {
      artist: { id, name: artistName }, level: level === 'larper' ? 'larper' : 'not-larper',
      streak: 0, lives: LIVES, track: 0, played: new Set(), seen: Date.now(),
    };
    const round = await newRound(g);
    const gameId = crypto.randomUUID();
    games.set(gameId, g);
    return { gameId, ...round };
  },

  async 'POST /api/game/guess'({ gameId, guess }) {
    const g = getGame(gameId);
    if (g.answered || g.lives <= 0) throw fail(409, 'Already answered');
    const text = typeof guess === 'string' ? guess.slice(0, 200) : '';
    const correct = !!text.trim() && norm(text) === g.song.key;
    if (correct) g.streak++;
    else g.lives--;
    g.answered = true;
    return { correct, title: g.song.title, album: g.song.album, ...state(g) };
  },

  async 'POST /api/game/next'({ gameId }) {
    const g = getGame(gameId);
    if (!g.answered) throw fail(409, 'Answer first');
    if (g.lives <= 0) throw fail(409, 'Game over');
    return newRound(g);
  },
};

async function searchArtists(q) {
  if (!q) return [];
  const { data } = await dz(`/search/artist?q=${encodeURIComponent(q)}&limit=25`);
  const best = new Map();
  for (const a of data) {
    const key = a.name.toLowerCase();
    if (!best.has(key) || a.nb_fan > best.get(key).nb_fan) best.set(key, a);
  }
  const exact = a => a.name.toLowerCase() === q.toLowerCase();
  return [...best.values()]
    .sort((a, b) => exact(b) - exact(a) || b.nb_fan - a.nb_fan)
    .slice(0, 8)
    .map(a => ({ id: a.id, name: a.name, picture: a.picture_medium, fans: a.nb_fan }));
}

async function searchSongs(id, name, query) {
  const words = norm(query).split(' ').filter(Boolean);
  if (!words.length) return [];
  const { data } = await dz(`/search?q=${encodeURIComponent(`${name} ${query}`)}&limit=50`);
  const titles = new Map();
  for (const t of data) {
    if (t.artist?.id !== id) continue;
    const title = clean(t.title_short || t.title);
    const key = norm(title), titleWords = key.split(' ');
    if (!words.every(w => titleWords.some(tw => tw.startsWith(w)))) continue;
    if (!titles.has(key)) titles.set(key, title);
  }
  return [...titles.values()];
}

async function readJson(req) {
  let s = '';
  for await (const chunk of req) {
    s += chunk;
    if (s.length > 10e3) throw fail(413, 'Too big');
  }
  try { return s ? JSON.parse(s) : {}; } catch { throw fail(400, 'Bad JSON'); }
}

const json = (res, body, code = 200) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const hits = new Map();
setInterval(() => hits.clear(), MIN).unref();
function limited(req) {
  const ip = req.headers['x-forwarded-for']?.split(',').pop().trim() || req.socket.remoteAddress;
  const n = (hits.get(ip) || 0) + 1;
  hits.set(ip, n);
  return n > RATE;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const q = (url.searchParams.get('q') || '').trim();
  try {
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }
    if (/^\/fonts\/[\w-]+\.woff2$/.test(url.pathname) && fs.existsSync(path.join(__dirname, url.pathname))) {
      res.writeHead(200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'public, max-age=31536000, immutable' });
      return fs.createReadStream(path.join(__dirname, url.pathname)).pipe(res);
    }
    if (url.pathname.startsWith('/api/') && limited(req)) return json(res, { error: 'Slow down' }, 429);
    if (url.pathname === '/api/artists') return json(res, await searchArtists(q));
    if (url.pathname === '/api/songs') {
      return json(res, await searchSongs(Number(url.searchParams.get('id')), url.searchParams.get('name') || '', q));
    }
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) return json(res, await route(await readJson(req)));
    json(res, { error: 'Not found' }, 404);
  } catch (e) {
    json(res, { error: e.message }, e.status ?? 502);
  }
}).listen(PORT, process.env.HOST, () => console.log(`Larpdle → http://localhost:${PORT}`));
