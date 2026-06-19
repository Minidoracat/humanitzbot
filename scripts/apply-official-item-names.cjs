// P2-4: align locales/zh-CN/items.json with the game's OFFICIAL Simplified names
// from Game.locres (matched by English name). Player-facing consistency: the bot
// should call an item what the player sees in-game, even when an LLM name was more
// "descriptive". zh-CN only — the official locres ships Simplified only.
//
// Minimal diff: literal value replace, preserves key order/formatting.
// Guards encode the invariants test/item-names.test.ts enforces, so a green run
// here means a green test run (no blind regressions / collisions):
//   - GLOSSARY: shared term roots that must survive (Shells→霰弹, Shotgun→霰弹枪…)
//   - PINNED:   ids the test asserts to an exact value (12G, GASMASK2)
//   - collision: never let an official name duplicate another display name
//
// Needs data/locres/Game.{en,zh}.locres (extracted from the client pak; gitignored).
//   node scripts/apply-official-item-names.cjs
const fs = require('node:fs');

function parseLocres(path) {
  const b = fs.readFileSync(path);
  let p = 17; // magic(16)+version(1)
  const strOff = Number(b.readBigInt64LE(p));
  p += 8;
  const fstr = () => {
    const len = b.readInt32LE(p);
    p += 4;
    if (len === 0) return '';
    if (len < 0) {
      const s = b.subarray(p, p + -len * 2 - 2).toString('utf16le');
      p += -len * 2;
      return s;
    }
    const s = b.subarray(p, p + len - 1).toString('latin1');
    p += len;
    return s;
  };
  const sp = p;
  p = strOff;
  const nStr = b.readInt32LE(p);
  p += 4;
  const strings = [];
  for (let i = 0; i < nStr; i++) {
    strings.push(fstr());
    p += 4;
  }
  p = sp + 4;
  const nNs = b.readUInt32LE(p);
  p += 4;
  const map = {};
  for (let i = 0; i < nNs; i++) {
    p += 4;
    const ns = fstr();
    const nk = b.readUInt32LE(p);
    p += 4;
    for (let j = 0; j < nk; j++) {
      p += 4;
      const key = fstr();
      p += 4;
      map[ns + ' ' + key] = strings[b.readInt32LE(p)];
      p += 4;
    }
  }
  return map;
}

const en = parseLocres('data/locres/Game.en.locres');
const zh = parseLocres('data/locres/Game.zh.locres');
const official = new Map(); // english(lower) -> official zh
for (const k of Object.keys(en)) {
  const e = (en[k] || '').trim();
  const z = (zh[k] || '').trim();
  if (e && z) official.set(e.toLowerCase(), z);
}

const enItems = JSON.parse(fs.readFileSync('locales/en/items.json', 'utf8'));
const zhObj = JSON.parse(fs.readFileSync('locales/zh-CN/items.json', 'utf8'));

// --- invariants mirrored from test/item-names.test.ts -----------------------
// shared glossary roots: if the EN name matches, the zh-CN name MUST contain term
const GLOSSARY = [
  [/Shells\b/, '霰弹'],
  [/Shotgun\b/, '霰弹枪'],
  [/Suppressor\b/, '消音器'],
  [/Walkie/, '无线电对讲机'],
  [/^Duct Tape/, '强力胶带'],
  [/Screwdriver\b/, '螺丝刀'],
];
// ids the test pins to an exact value, plus its allowed-duplicate exceptions —
// never touch (changing them could break a pin or a sanctioned variant pair)
const PINNED = new Set(['12G', 'GASMASK2', 'BrownPantsShortPockets', 'Canteen1']);

// 1. collect candidate replacements that pass per-item guards
const cand = [];
for (const id of Object.keys(enItems)) {
  if (PINNED.has(id)) continue;
  const enName = (enItems[id] || '').trim();
  const off = official.get(enName.toLowerCase());
  const cur = zhObj[id];
  if (!off || cur == null || off === cur) continue;
  // game left it untranslated (official zh is ASCII) — keep existing Chinese
  if (!/[一-鿿]/.test(off)) continue;
  // glossary: official must keep the shared root for any pattern this EN matches
  const violates = GLOSSARY.some(([re, term]) => re.test(enName) && !off.includes(term));
  if (violates) continue;
  cand.push({ id, en: enName, from: cur, to: off });
}

// 2. collision filter (fixpoint): the final name set must stay unique. Dropping a
//    candidate reverts it to its original value, which can itself collide with an
//    applied one — so iterate until no applied candidate participates in a dup.
const byId = new Map(cand.map((c) => [c.id, c]));
const applied = new Set(cand.map((c) => c.id));
for (;;) {
  const finalName = {};
  for (const id of Object.keys(zhObj)) finalName[id] = applied.has(id) ? byId.get(id).to : zhObj[id];
  const count = {};
  for (const id of Object.keys(finalName)) count[finalName[id]] = (count[finalName[id]] || 0) + 1;
  const drop = [...applied].filter((id) => count[byId.get(id).to] > 1);
  if (drop.length === 0) break;
  for (const id of drop) applied.delete(id);
}
const apply = cand.filter((c) => applied.has(c.id));
const droppedCollide = cand.length - apply.length;

// 3. apply via literal text replace (preserve key order / formatting)
let text = fs.readFileSync('locales/zh-CN/items.json', 'utf8');
const changes = [];
for (const c of apply) {
  const find = JSON.stringify(c.id) + ': ' + JSON.stringify(c.from);
  const repl = JSON.stringify(c.id) + ': ' + JSON.stringify(c.to);
  if (!text.includes(find)) {
    console.error('WARN: could not locate ' + find);
    continue;
  }
  text = text.replace(find, repl);
  changes.push(c);
}

fs.writeFileSync('locales/zh-CN/items.json', text);
JSON.parse(text); // sanity: still valid JSON
console.log(
  'applied ' + changes.length + ' official replacements (dropped ' + droppedCollide + ' collisions) to locales/zh-CN/items.json',
);
for (const c of changes) console.log('  ' + c.id + '  ' + JSON.stringify(c.from) + ' -> ' + JSON.stringify(c.to) + '  (en=' + JSON.stringify(c.en) + ')');
