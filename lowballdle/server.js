const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3002;
const MAX = 6, WIN_PCT = 0.05, WIN_MIN = 100;
const TZ = 'America/Guatemala', BOARD = 'main', RATE = 120;
const fail = (status, message) => Object.assign(new Error(message), { status });

const db = new DatabaseSync(process.env.DB || path.join(__dirname, 'lowballdle.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY,
    board TEXT NOT NULL DEFAULT 'main',
    day TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    title TEXT NOT NULL,
    price INTEGER NOT NULL CHECK (price > 0),
    tolerance INTEGER,
    condition TEXT, location TEXT, listed_ago TEXT, description TEXT,
    seller_name TEXT, seller_joined TEXT,
    photo BLOB, photo_type TEXT,
    UNIQUE (board, day)
  );
  CREATE TABLE IF NOT EXISTS lines (
    id INTEGER PRIMARY KEY,
    board TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('up', 'down', 'deal', 'sold')),
    tier INTEGER,
    emoji TEXT,
    text TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS price_lines (
    id INTEGER PRIMARY KEY,
    board TEXT,
    amount INTEGER NOT NULL,
    emoji TEXT,
    text TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS offers (
    board TEXT NOT NULL, day TEXT NOT NULL, player TEXT NOT NULL,
    n INTEGER NOT NULL, amount INTEGER NOT NULL,
    verdict TEXT NOT NULL, tier INTEGER, emoji TEXT, line TEXT,
    at INTEGER NOT NULL,
    UNIQUE (board, day, player, n)
  );
`);

const SEED = {
  up: [
    ['🤔', 'So close. Little more', 'We’re like one coffee apart', 'Bro you’re right there. Come up a bit', 'Ehh almost. Throw in a few more'],
    ['😐', 'Yo come on', 'That’s lowkey disrespectful', 'Hit the road dude', 'Nah. Higher. Try again', 'I got 5 other offers waiting', 'Come on now'],
    ['😂', 'LMAO', 'Bro thinks he’s at a garage sale', 'Respectfully, no. Way higher', 'Are you okay?', 'This is a one of a kind item. Come on'],
    ['😡', 'Bro 💀', 'My brother in Christ. Higher.', 'Get off my listing 💀 MUCH higher', 'I can tell you’re broke. WAY higher', 'oh hell nah', 'You should be shot'],
  ],
  down: [
    ['🤔', 'Real big spender huh. Bit lower', 'Bro you’re overpaying a little lol. Lower', 'I’m an honest man. Go a little lower', 'Slightly less please, I have a conscience'],
    ['😳', 'It’s not THAT nice. Lower', 'That’s more than I paid lol. Lower', 'Got a lotta money huh. Lower', 'Bro did you read the listing. Lower'],
    ['🤨', 'Is this a scam. Lower', 'Who sent you. Lower', 'Something’s fishy. Way lower', 'Are you gonna ask me to chashapp you first? Way lower'],
    ['🚩', 'My brother in Christ. Lower.', 'Bro is this a money laundering thing', 'This is a used item. MUCH lower', 'Blink twice if you need help. Lower'],
  ],
  deal: ['Bet 🤝 When can you pick it up?', 'Deal. Cash only, no checks', 'Say less. Come thru 🤝'],
  sold: ['I sold it to my cousin for {price} 💀', 'Too slow. Went for {price}', 'Gone. Some guy paid {price} without even haggling'],
};
if (!db.prepare('SELECT 1 FROM lines LIMIT 1').get()) {
  const add = db.prepare('INSERT INTO lines (kind, tier, emoji, text) VALUES (?, ?, ?, ?)');
  for (const kind of ['up', 'down']) SEED[kind].forEach(([emoji, ...texts], tier) => texts.forEach(t => add.run(kind, tier, emoji, t)));
  SEED.deal.forEach(t => add.run('deal', null, '❤️', t));
  SEED.sold.forEach(t => add.run('sold', null, null, t));
}

const PRICE_SEED = [[10000, 'A HUNNID DOLLARS!']];
if (!db.prepare('SELECT 1 FROM price_lines LIMIT 1').get()) {
  const add = db.prepare('INSERT INTO price_lines (amount, text) VALUES (?, ?)');
  for (const [amount, text] of PRICE_SEED) add.run(amount, text);
}

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

function judge(amount, price, tolerance) {
  if (Math.abs(amount - price) <= (tolerance ?? Math.max(price * WIN_PCT, WIN_MIN))) return { verdict: 'win', tier: null };
  const r = amount / price;
  if (r < 1) return { verdict: 'up', tier: r >= 0.85 ? 0 : r >= 0.6 ? 1 : r >= 0.3 ? 2 : 3 };
  return { verdict: 'down', tier: r <= 1.15 ? 0 : r <= 1.6 ? 1 : r <= 3 ? 2 : 3 };
}

const pickLine = db.prepare(`SELECT emoji, text FROM lines WHERE active = 1 AND kind = ? AND tier IS ?
  AND (board IS NULL OR board = ?) AND text IS NOT ? ORDER BY random() LIMIT 1`);
const line = (kind, tier, last = null) => pickLine.get(kind, tier, BOARD, last) ?? pickLine.get(kind, tier, BOARD, null)
  ?? { emoji: null, text: kind === 'up' ? 'Higher' : kind === 'down' ? 'Lower' : kind === 'deal' ? 'Deal!' : 'Sold for {price}' };

const pickPriceLine = db.prepare(`SELECT emoji, text FROM price_lines WHERE active = 1 AND amount = ?
  AND (board IS NULL OR board = ?) ORDER BY random() LIMIT 1`);

const money = (cents, currency) => new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);

const getItem = db.prepare(`SELECT id, day, currency, title, price, tolerance, condition, location, listed_ago, description,
  seller_name, seller_joined, photo IS NOT NULL AS has_photo FROM items WHERE board = ? AND day = ?`);
const dayNumber = db.prepare('SELECT count(*) AS n FROM items WHERE board = ? AND day <= ?');
const getOffers = db.prepare('SELECT n, amount, verdict, tier, emoji, line FROM offers WHERE board = ? AND day = ? AND player = ? ORDER BY n');
const addOffer = db.prepare('INSERT INTO offers (board, day, player, n, amount, verdict, tier, emoji, line, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');

function game(player) {
  const day = today();
  const item = getItem.get(BOARD, day);
  if (!item) return { day, item: null };
  const offers = getOffers.all(BOARD, day, player);
  const won = offers.some(o => o.verdict === 'win');
  const over = won || offers.length >= MAX;
  const { price, tolerance, id, ...pub } = item;
  return { day, number: dayNumber.get(BOARD, day).n, max: MAX, item: { ...pub, has_photo: !!pub.has_photo }, offers, over, won, price: over ? price : undefined, _item: item };
}

const strip = ({ _item, ...g }) => g;

function offer(player, body) {
  const g = game(player);
  if (!g.item) throw fail(404, 'No listing today');
  if (g.over) throw fail(409, 'This listing is closed');
  const amount = Math.round(Number(body.amount) * 100);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e11) throw fail(400, 'Send a real offer');
  const n = g.offers.length + 1;
  const { verdict, tier } = judge(amount, g._item.price, g._item.tolerance);
  let said = line(verdict === 'win' ? 'deal' : verdict, tier, g.offers.at(-1)?.line);
  const special = verdict !== 'win' && pickPriceLine.get(amount, BOARD);
  if (special) said = { emoji: special.emoji ?? said.emoji, text: special.text };
  try {
    addOffer.run(BOARD, g.day, player, n, amount, verdict, tier, said.emoji, said.text, Date.now());
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw fail(409, 'Slow down, one offer at a time');
    throw e;
  }
  const res = strip(game(player));
  if (res.over && !res.won) res.sold = line('sold', null).text.replace('{price}', money(g._item.price, g._item.currency));
  return res;
}

const finals = db.prepare(`SELECT n, verdict FROM offers WHERE board = ? AND day = ? AND (verdict = 'win' OR n = ?)`);
const firstAvg = db.prepare('SELECT avg(amount) AS a FROM offers WHERE board = ? AND day = ? AND n = 1');
function stats() {
  const day = today();
  const spread = Array(MAX + 1).fill(0);
  for (const f of finals.all(BOARD, day, MAX)) spread[f.verdict === 'win' ? f.n - 1 : MAX]++;
  return { day, players: spread.reduce((a, b) => a + b, 0), spread, avg_first: Math.round(firstAvg.get(BOARD, day).a ?? 0) };
}

const getPhoto = db.prepare('SELECT photo, photo_type FROM items WHERE board = ? AND day = ? AND day <= ?');

async function readJson(req, limit = 10e3) {
  let s = '';
  for await (const chunk of req) {
    s += chunk;
    if (s.length > limit) throw fail(413, 'Too big');
  }
  try { return s ? JSON.parse(s) : {}; } catch { throw fail(400, 'Bad JSON'); }
}

const json = (res, body, code = 200) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

const hits = new Map();
setInterval(() => hits.clear(), 60e3).unref();
function limited(req) {
  const ip = req.headers['x-forwarded-for']?.split(',').pop().trim() || req.socket.remoteAddress;
  const n = (hits.get(ip) || 0) + 1;
  hits.set(ip, n);
  return n > RATE;
}

function playerOf(req, res) {
  const id = /(?:^|;\s*)player=([\w-]{36})/.exec(req.headers.cookie || '')?.[1];
  if (id) return id;
  const fresh = crypto.randomUUID();
  res.setHeader('Set-Cookie', `player=${fresh}; Path=/; Max-Age=315360000; HttpOnly; SameSite=Lax`);
  return fresh;
}


const ADMIN_PATH = process.env.ADMIN_PATH || '/admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const sha = s => crypto.createHash('sha256').update(s).digest();
function authed(req) {
  const s = Buffer.from((req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString();
  return s.includes(':') && crypto.timingSafeEqual(sha(s.slice(s.indexOf(':') + 1)), sha(ADMIN_PASSWORD));
}

const ITEM_FIELDS = ['day', 'title', 'price', 'tolerance', 'condition', 'location', 'listed_ago', 'description', 'seller_name', 'seller_joined'];
const listItems = db.prepare(`SELECT i.id, i.day, i.title, i.price, i.photo IS NOT NULL AS has_photo,
  (SELECT count(DISTINCT player) FROM offers o WHERE o.board = i.board AND o.day = i.day) AS players,
  (SELECT count(*) FROM offers o WHERE o.board = i.board AND o.day = i.day AND o.verdict = 'win') AS wins
  FROM items i WHERE i.board = ? ORDER BY i.day`);
const fullItem = db.prepare(`SELECT id, board, ${ITEM_FIELDS.join(', ')}, photo IS NOT NULL AS has_photo FROM items WHERE id = ?`);
const playedOn = db.prepare('SELECT 1 FROM offers WHERE board = ? AND day = ? LIMIT 1');

const str = (v, max) => {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || v.length > max) throw fail(400, `Keep text under ${max} characters`);
  return v.trim() || null;
};
const cents = (v, field, { optional = false } = {}) => {
  if (optional && (v == null || v === '')) return null;
  if (!Number.isInteger(v) || v < 0 || v > 1e11 || (!optional && v === 0)) throw fail(400, `${field} must be a positive amount`);
  return v;
};

function cleanItem(b) {
  if (typeof b.day !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(b.day) || isNaN(Date.parse(b.day))) throw fail(400, 'Pick a day');
  const title = str(b.title, 200);
  if (!title) throw fail(400, 'Give it a title');
  return {
    day: b.day, title, price: cents(b.price, 'Price'), tolerance: cents(b.tolerance, 'Win margin', { optional: true }),
    condition: str(b.condition, 100), location: str(b.location, 100), listed_ago: str(b.listed_ago, 100),
    description: str(b.description, 2000), seller_name: str(b.seller_name, 100), seller_joined: str(b.seller_joined, 100),
  };
}

function parsePhoto(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) throw fail(400, 'Photo must be a JPEG, PNG or WebP');
  const data = Buffer.from(m[2], 'base64');
  if (data.length > 3e6) throw fail(413, 'Photo is too big, keep it under 3MB');
  return { type: m[1], data };
}

const unique = (fn, message) => {
  try { return fn(); } catch (e) { throw String(e.message).includes('UNIQUE') ? fail(409, message) : e; }
};

function saveItem(b) {
  const v = cleanItem(b);
  const photo = b.photo ? parsePhoto(b.photo) : null;
  let id = b.id ? Number(b.id) : null;
  if (id) {
    const old = fullItem.get(id);
    if (!old) throw fail(404, 'Listing not found');
    if (old.day !== v.day && playedOn.get(old.board, old.day)) throw fail(409, 'People already played this one, its day can’t move');
    unique(() => db.prepare(`UPDATE items SET ${ITEM_FIELDS.map(f => `${f} = ?`).join(', ')} WHERE id = ?`).run(...ITEM_FIELDS.map(f => v[f]), id),
      'That day already has a listing');
  } else {
    if (!photo) throw fail(400, 'Add a photo');
    id = unique(() => db.prepare(`INSERT INTO items (board, ${ITEM_FIELDS.join(', ')}) VALUES (?, ${ITEM_FIELDS.map(() => '?').join(', ')})`)
      .run(BOARD, ...ITEM_FIELDS.map(f => v[f])).lastInsertRowid, 'That day already has a listing');
  }
  if (photo) db.prepare('UPDATE items SET photo = ?, photo_type = ? WHERE id = ?').run(photo.data, photo.type, id);
  return fullItem.get(id);
}

function deleteItem(id) {
  const it = fullItem.get(id);
  if (!it) throw fail(404, 'Listing not found');
  if (playedOn.get(it.board, it.day)) throw fail(409, 'People already played this one, it can’t be deleted');
  db.prepare('DELETE FROM items WHERE id = ?').run(id);
  return { ok: true };
}

function saveLine(b) {
  const kind = b.kind;
  if (!['up', 'down', 'deal', 'sold'].includes(kind)) throw fail(400, 'Unknown kind');
  const tier = kind === 'up' || kind === 'down' ? b.tier : null;
  if (tier !== null && ![0, 1, 2, 3].includes(tier)) throw fail(400, 'Tier must be 0–3');
  const text = str(b.text, 300);
  if (!text) throw fail(400, 'Write something');
  if (kind === 'sold' && !text.includes('{price}')) throw fail(400, 'Sold lines need {price} in them');
  const row = [kind, tier, str(b.emoji, 20), text, b.active === false ? 0 : 1];
  if (b.id) db.prepare('UPDATE lines SET kind = ?, tier = ?, emoji = ?, text = ?, active = ? WHERE id = ?').run(...row, b.id);
  else b.id = db.prepare('INSERT INTO lines (kind, tier, emoji, text, active) VALUES (?, ?, ?, ?, ?)').run(...row).lastInsertRowid;
  return db.prepare('SELECT * FROM lines WHERE id = ?').get(b.id);
}

function savePriceLine(b) {
  const text = str(b.text, 300);
  if (!text) throw fail(400, 'Write something');
  const row = [cents(b.amount, 'Amount'), str(b.emoji, 20), text, b.active === false ? 0 : 1];
  if (b.id) db.prepare('UPDATE price_lines SET amount = ?, emoji = ?, text = ?, active = ? WHERE id = ?').run(...row, b.id);
  else b.id = db.prepare('INSERT INTO price_lines (amount, emoji, text, active) VALUES (?, ?, ?, ?)').run(...row).lastInsertRowid;
  return db.prepare('SELECT * FROM price_lines WHERE id = ?').get(b.id);
}

function tryOffer(b) {
  const price = cents(b.price, 'Price'), amount = cents(b.amount, 'Offer');
  const v = judge(amount, price, cents(b.tolerance, 'Win margin', { optional: true }));
  const special = v.verdict !== 'win' && pickPriceLine.get(amount, BOARD);
  const said = line(v.verdict === 'win' ? 'deal' : v.verdict, v.tier);
  return { ...v, emoji: special?.emoji ?? said.emoji, line: special?.text ?? said.text, special: !!special };
}

const adminRoutes = [
  ['GET', /^api\/items$/, () => ({ today: today(), items: listItems.all(BOARD).map(i => ({ ...i, has_photo: !!i.has_photo })) })],
  ['GET', /^api\/items\/(\d+)$/, (_, id) => fullItem.get(Number(id)) ?? (() => { throw fail(404, 'Listing not found'); })()],
  ['POST', /^api\/items$/, b => saveItem(b)],
  ['DELETE', /^api\/items\/(\d+)$/, (_, id) => deleteItem(Number(id))],
  ['GET', /^api\/lines$/, () => db.prepare('SELECT * FROM lines ORDER BY kind, tier, id').all()],
  ['POST', /^api\/lines$/, b => saveLine(b)],
  ['DELETE', /^api\/lines\/(\d+)$/, (_, id) => (db.prepare('DELETE FROM lines WHERE id = ?').run(Number(id)), { ok: true })],
  ['GET', /^api\/price-lines$/, () => db.prepare('SELECT * FROM price_lines ORDER BY amount, id').all()],
  ['POST', /^api\/price-lines$/, b => savePriceLine(b)],
  ['DELETE', /^api\/price-lines\/(\d+)$/, (_, id) => (db.prepare('DELETE FROM price_lines WHERE id = ?').run(Number(id)), { ok: true })],
  ['POST', /^api\/test$/, b => tryOffer(b)],
];

async function admin(req, res, sub) {
  if (!ADMIN_PASSWORD) return json(res, { error: 'Not found' }, 404);
  if (!authed(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Lowballdle admin", charset="UTF-8"' });
    return res.end('Password needed');
  }
  if (sub === '') {
    res.writeHead(308, { Location: path.posix.basename(ADMIN_PATH) + '/' });
    return res.end();
  }
  if (sub === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
    return res.end(fs.readFileSync(path.join(__dirname, 'admin.html')));
  }
  const p = sub.slice(1);
  const pic = /^photo\/(\d+)$/.exec(p);
  if (pic && req.method === 'GET') {
    const row = db.prepare('SELECT photo, photo_type FROM items WHERE id = ?').get(Number(pic[1]));
    if (!row?.photo) return json(res, { error: 'Not found' }, 404);
    res.writeHead(200, { 'Content-Type': row.photo_type, 'Cache-Control': 'no-store' });
    return res.end(row.photo);
  }
  for (const [method, re, fn] of adminRoutes) {
    const m = re.exec(p);
    if (m && req.method === method) return json(res, await fn(method === 'POST' ? await readJson(req, 5e6) : null, ...m.slice(1)));
  }
  json(res, { error: 'Not found' }, 404);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === ADMIN_PATH || url.pathname.startsWith(ADMIN_PATH + '/')) {
      if (limited(req)) return json(res, { error: 'Slow down' }, 429);
      return await admin(req, res, url.pathname.slice(ADMIN_PATH.length));
    }
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }
    const photo = /^\/photo\/([\w-]+)\/(\d{4}-\d\d-\d\d)$/.exec(url.pathname);
    if (photo) {
      const row = getPhoto.get(photo[1], photo[2], today());
      if (!row?.photo) return json(res, { error: 'Not found' }, 404);
      res.writeHead(200, { 'Content-Type': row.photo_type, 'Cache-Control': 'public, max-age=86400' });
      return res.end(row.photo);
    }
    if (!url.pathname.startsWith('/api/')) return json(res, { error: 'Not found' }, 404);
    if (limited(req)) return json(res, { error: 'Slow down' }, 429);
    const player = playerOf(req, res);
    if (req.method === 'GET' && url.pathname === '/api/today') return json(res, strip(game(player)));
    if (req.method === 'POST' && url.pathname === '/api/offer') return json(res, offer(player, await readJson(req)));
    if (req.method === 'GET' && url.pathname === '/api/stats') return json(res, stats());
    json(res, { error: 'Not found' }, 404);
  } catch (e) {
    if (!e.status) console.error(e);
    json(res, { error: e.status ? e.message : 'Something broke' }, e.status ?? 500);
  }
});

if (require.main === module) server.listen(PORT, process.env.HOST, () => {
  console.log(`Lowballdle → http://localhost:${PORT}`);
  console.log(ADMIN_PASSWORD ? `Admin → http://localhost:${PORT}${ADMIN_PATH}/` : 'Admin is off (set ADMIN_PASSWORD to turn it on)');
});
module.exports = { db, judge, today, server };
