/**
 * Steam profile sync + 雙綁定 gate + 玩家地圖視圖的整合測試：
 *
 *   - fetchSteamProfile（GetPlayerSummaries stub、avatar host allowlist）
 *   - extractVehicleOwnerSteamId（vehicles.extra 車鑰匙字串解析）
 *   - user_links v28 欄位 + updateSteamProfile / touchSteamProfile
 *   - ENABLE_STEAM_PROFILE_SYNC gate：survivor/mod 未綁 403、admin 豁免、關閉時不擋
 *   - /auth/me 的 steamPersona/steamAvatar/steamLinkRequired
 *   - /auth/refresh 的過期補抓（24h 節流：抓過就不再打 Steam）
 *   - /api/players survivor 過濾（self+同 clan 才有座標；敏感欄位裁掉）
 *   - /api/me/mapdata（owner==self 的載具 / 夥伴 / 馬）
 *
 * 比照 steam-link-routes.test.ts：真 express app + 真 setupAuth + memory DB，
 * 走 HTTP；對 api.steampowered.com 的外連 fetch 用 stub 攔截。
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';

import config from '../src/config/index.js';
import { setupAuth } from '../src/web-map/auth.js';
import { fetchSteamProfile } from '../src/web-map/steam-profile.js';
import { extractVehicleOwnerSteamId, vehicleBelongsTo } from '../src/web-map/route-helpers.js';
import { registerMeRoutes } from '../src/web-map/routes/me.routes.js';
import { registerPlayersRoutes } from '../src/web-map/routes/players.routes.js';
import _database from '../src/db/database.js';
import { SCHEMA_VERSION } from '../src/db/schema.js';

const HumanitZDB = _database as any;

const TOKEN = 'a'.repeat(64);
const STEAM_SELF = '76561198000000101';
const STEAM_MATE = '76561198000000102';
const STEAM_STRANGER = '76561198000000103';

// ── fetch stub：只攔 api.steampowered.com，其餘 pass-through ────────────────

const realFetch: typeof fetch = global.fetch.bind(globalThis);
type Responder = (url: string, init?: RequestInit) => Response;
let steamApiResponder: Responder | null = null;
let steamApiCalls = 0;

function installFetchStub(): void {
  global.fetch = (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : String((input as { url?: string }).url ?? input);
    if (url.startsWith('https://api.steampowered.com/')) {
      steamApiCalls++;
      if (!steamApiResponder) return Promise.reject(new Error(`unexpected Steam API fetch: ${url}`));
      return Promise.resolve(steamApiResponder(url, init));
    }
    return realFetch(input as string, init);
  };
}

function restoreFetch(): void {
  global.fetch = realFetch;
  steamApiResponder = null;
  steamApiCalls = 0;
}

function summariesResponse(steamId: string, persona: string, avatar: string): Response {
  return new Response(
    JSON.stringify({ response: { players: [{ steamid: steamId, personaname: persona, avatarfull: avatar }] } }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

// ── cookie jar ─────────────────────────────────────────────────────────────

type Jar = Map<string, string>;

function updateJar(jar: Jar, res: Response): void {
  for (const raw of res.headers.getSetCookie()) {
    const pair = raw.split(';')[0] ?? '';
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const name = pair.slice(0, idx);
    const value = pair.slice(idx + 1);
    if (value === '') jar.delete(name);
    else jar.set(name, value);
  }
}

function cookieHeader(jar: Jar): string {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

// ── app boot ──────────────────────────────────────────────────────────────

let _savedNodeEnv: string | undefined;

function setAuthEnv(): void {
  process.env.DISCORD_OAUTH_SECRET = 'oauth-client-secret-dummy';
  process.env.WEB_MAP_CALLBACK_URL = 'http://127.0.0.1/auth/callback';
  process.env.WEB_MAP_SESSION_SECRET = 'k'.repeat(64);
  process.env.WEB_PANEL_TEST_AUTH_TOKEN = TOKEN;
  _savedNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
}

function cleanAuthEnv(): void {
  delete process.env.DISCORD_OAUTH_SECRET;
  delete process.env.WEB_MAP_CALLBACK_URL;
  delete process.env.WEB_MAP_SESSION_SECRET;
  delete process.env.WEB_PANEL_TEST_AUTH_TOKEN;
  if (_savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = _savedNodeEnv;
}

interface Booted {
  url: string;
  db: any;
  savePlayers: Map<string, Record<string, unknown>>;
  close: () => Promise<void>;
}

async function bootApp(label: string): Promise<Booted> {
  const db = new HumanitZDB({ memory: true, label });
  db.init();

  // save cache 資料源（/api/players 與 /api/me/mapdata 的馬都吃這裡）
  const savePlayers = new Map<string, Record<string, unknown>>();

  const app = express();
  const authMiddleware = setupAuth(app, null, { userLinks: db.userLinks });
  app.use(authMiddleware);
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    (req as { srv?: unknown }).srv = {
      db,
      serverId: 'primary',
      isPrimary: true,
      dataDir: '/tmp/unused',
      playerNameMap: new Map(),
      playerStats: { getStats: () => null, getStatsByName: () => null },
      playtime: { getPlaytime: () => null },
      getPlayerList: async () => ({ players: [] }),
    };
    next();
  });
  const ctx = {
    _db: db,
    _worldBounds: { xMin: 0, xMax: 409600, yMin: -409600, yMax: 0 },
    _parseSaveData: () => savePlayers,
    _parseSaveDataForServer: () => savePlayers,
    _cleanPlayerDisplayName: (n: string) => n,
    _resolvePlayerDisplayName: (steamId: string, data: Record<string, unknown>) => (data.name as string) || steamId,
    _worldToLeaflet: (x: number, y: number) => [x / 100, y / 100] as [number, number],
    _getToggles: () => ({}),
  } as unknown as Parameters<typeof registerMeRoutes>[1];
  registerMeRoutes(app, ctx);
  registerPlayersRoutes(app, ctx);

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      resolve(s);
    });
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    db,
    savePlayers,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          db.close();
          resolve();
        });
      }),
  };
}

/** test-login 建 session（選配 steamId 直接綁定）。 */
async function login(base: string, jar: Jar, tier = 'admin', steamId?: string): Promise<void> {
  const res = await fetch(`${base}/auth/test-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: TOKEN, tier, ...(steamId ? { steamId } : {}) }),
  });
  assert.equal(res.status, 200, `test-login should succeed (got ${String(res.status)})`);
  updateJar(jar, res);
}

async function getJson(base: string, jar: Jar, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, { headers: { cookie: cookieHeader(jar) } });
  updateJar(jar, res);
  return { status: res.status, body: await res.json() };
}

// 測試期間直接撥 config singleton（生產路徑是 bot-config live reload 同一機制）
let _savedSync: boolean;
let _savedKey: string;
function saveConfig(): void {
  _savedSync = config.enableSteamProfileSync;
  _savedKey = config.steamWebApiKey;
}
function restoreConfig(): void {
  config.enableSteamProfileSync = _savedSync;
  config.steamWebApiKey = _savedKey;
}

// ══════════════════════════════════════════════════════════
// 1 — 單元：fetchSteamProfile / extractVehicleOwnerSteamId
// ══════════════════════════════════════════════════════════

describe('fetchSteamProfile', () => {
  before(() => {
    installFetchStub();
  });
  after(() => {
    restoreFetch();
  });
  beforeEach(() => {
    steamApiCalls = 0;
  });

  it('returns persona + avatar from GetPlayerSummaries', async () => {
    steamApiResponder = () => summariesResponse(STEAM_SELF, 'Tester', 'https://avatars.steamstatic.com/abc_full.jpg');
    const p = await fetchSteamProfile(STEAM_SELF, 'key');
    assert.deepEqual(p, { persona: 'Tester', avatar: 'https://avatars.steamstatic.com/abc_full.jpg' });
  });

  it('rejects avatar URLs outside the Steam CDN allowlist', async () => {
    steamApiResponder = () => summariesResponse(STEAM_SELF, 'Tester', 'https://evil.example.com/x.jpg');
    const p = await fetchSteamProfile(STEAM_SELF, 'key');
    assert.deepEqual(p, { persona: 'Tester', avatar: null });
  });

  it('returns null on HTTP error / missing player / missing key', async () => {
    steamApiResponder = () => new Response('forbidden', { status: 403 });
    assert.equal(await fetchSteamProfile(STEAM_SELF, 'key'), null);
    steamApiResponder = () => summariesResponse('76561198999999999', 'Other', '');
    assert.equal(await fetchSteamProfile(STEAM_SELF, 'key'), null);
    assert.equal(await fetchSteamProfile(STEAM_SELF, ''), null);
    assert.equal(steamApiCalls, 2, 'no fetch without an API key');
  });
});

describe('extractVehicleOwnerSteamId', () => {
  it('extracts the owner SteamID64 from the car-key binding string', () => {
    const extra = JSON.stringify({
      SoftClass: 'BP_Van_C',
      Data: [`1\r\n1\r\nNone\r\n${STEAM_SELF}_+_|000217225ed84f2aacac2dfd6b505916`],
    });
    assert.equal(extractVehicleOwnerSteamId(extra), STEAM_SELF);
  });

  it('returns null for unowned vehicles and malformed input', () => {
    assert.equal(extractVehicleOwnerSteamId(JSON.stringify({ Data: ['0\r\n1\r\nNone\r\nNone'] })), null);
    assert.equal(extractVehicleOwnerSteamId(JSON.stringify({ Mods: [] })), null);
    assert.equal(extractVehicleOwnerSteamId('not-json'), null);
    assert.equal(extractVehicleOwnerSteamId(null), null);
    assert.equal(extractVehicleOwnerSteamId(''), null);
  });

  it('vehicleBelongsTo matches ANY owner token, not just the first (multi-key)', () => {
    // 多把鑰匙：第一個是別人、第二個才是自己 —— 只看首個匹配會漏放自己的車
    const multi = JSON.stringify({
      Data: [`1\r\n1\r\nNone\r\n${STEAM_STRANGER}_+_|aaaa`, `1\r\n1\r\nNone\r\n${STEAM_SELF}_+_|bbbb`],
    });
    assert.equal(vehicleBelongsTo(multi, STEAM_SELF), true);
    assert.equal(vehicleBelongsTo(multi, STEAM_STRANGER), true);
    assert.equal(vehicleBelongsTo(multi, '76561198000000999'), false);
    assert.equal(vehicleBelongsTo(JSON.stringify({ Data: ['0\r\n1\r\nNone\r\nNone'] }), STEAM_SELF), false);
    assert.equal(vehicleBelongsTo('not-json', STEAM_SELF), false);
  });
});

// ══════════════════════════════════════════════════════════
// 2 — repo：v28 欄位 + updateSteamProfile / touchSteamProfile
// ══════════════════════════════════════════════════════════

describe('user_links v28 steam profile columns', () => {
  let db: any;
  before(() => {
    db = new HumanitZDB({ memory: true, label: 'SteamProfileRepo' });
    db.init();
  });
  after(() => {
    db.close();
  });

  it('fresh DB has the v28 columns and update/touch work', () => {
    db.userLinks.insertLink({ discordUserId: 'u1', steamId: STEAM_SELF, createdBy: 'u1' });
    assert.equal(
      db.userLinks.updateSteamProfile('u1', STEAM_SELF, 'Tester', 'https://avatars.steamstatic.com/a.jpg'),
      true,
    );
    let row = db.userLinks.getByDiscordId('u1');
    assert.equal(row.steam_persona, 'Tester');
    assert.equal(row.steam_avatar, 'https://avatars.steamstatic.com/a.jpg');
    assert.ok(row.steam_profile_updated_at, 'updated_at stamped');

    // touch：只動時間戳，persona/avatar 不變
    assert.equal(db.userLinks.touchSteamProfile('u1', STEAM_SELF), true);
    row = db.userLinks.getByDiscordId('u1');
    assert.equal(row.steam_persona, 'Tester');

    // 無綁定列 → no-op
    assert.equal(db.userLinks.updateSteamProfile('nobody', STEAM_SELF, 'X', null), false);
    assert.equal(db.userLinks.touchSteamProfile('nobody', STEAM_SELF), false);
  });

  it('partial profile keeps cached fields (COALESCE, null is not a clear)', () => {
    db.userLinks.insertLink({ discordUserId: 'u2', steamId: STEAM_MATE, createdBy: 'u2' });
    db.userLinks.updateSteamProfile('u2', STEAM_MATE, 'Name1', 'https://avatars.steamstatic.com/one.jpg');
    // avatar host 不在 allowlist 等情境 → avatar=null，不得清掉舊快取
    db.userLinks.updateSteamProfile('u2', STEAM_MATE, 'Name2', null);
    const row = db.userLinks.getByDiscordId('u2');
    assert.equal(row.steam_persona, 'Name2', 'non-null field updates');
    assert.equal(row.steam_avatar, 'https://avatars.steamstatic.com/one.jpg', 'null field keeps cache');
  });

  it('stale fetch after unlink→relink is a no-op (write is keyed by steam_id)', () => {
    // 用本測試專屬的 steam ids —— user_links.steam_id 有 UNIQUE 約束，
    // 不能與同一 in-memory DB 中其他測試的綁定衝突。
    const STEAM_X = '76561198000000201';
    const STEAM_Y = '76561198000000202';
    // u3 綁 X → X 的 fetch 在途中 → unlink → relink 成 Y
    db.userLinks.insertLink({ discordUserId: 'u3', steamId: STEAM_X, createdBy: 'u3' });
    db.userLinks.deleteByDiscordId('u3');
    db.userLinks.insertLink({ discordUserId: 'u3', steamId: STEAM_Y, createdBy: 'u3' });

    // X 的回應晚到：update 與 touch 都必須 no-op，不得污染 Y 的 row
    assert.equal(db.userLinks.updateSteamProfile('u3', STEAM_X, 'StaleX', 'https://x.example/a.jpg'), false);
    assert.equal(db.userLinks.touchSteamProfile('u3', STEAM_X), false);
    const row = db.userLinks.getByDiscordId('u3');
    assert.equal(row.steam_persona, null, 'stale persona must not land');
    assert.equal(row.steam_profile_updated_at, null, 'stale touch must not suppress first sync');

    // Y 自己的 fetch 正常落地
    assert.equal(db.userLinks.updateSteamProfile('u3', STEAM_Y, 'FreshY', null), true);
    assert.equal(db.userLinks.getByDiscordId('u3').steam_persona, 'FreshY');
  });
});

// ══════════════════════════════════════════════════════════
// 3 — gate + /auth/me / /auth/refresh
// ══════════════════════════════════════════════════════════

describe('Integration: steam link gate + profile in /auth/me', () => {
  let booted: Booted;

  before(async () => {
    setAuthEnv();
    installFetchStub();
    saveConfig();
    booted = await bootApp('SteamGate');
  });

  after(async () => {
    await booted.close();
    restoreConfig();
    restoreFetch();
    cleanAuthEnv();
  });

  beforeEach(() => {
    config.enableSteamProfileSync = false;
    config.steamWebApiKey = '';
    steamApiResponder = null;
    steamApiCalls = 0;
  });

  it('gate off: unlinked survivor reaches routes (409 from /api/me/player)', async () => {
    const jar: Jar = new Map();
    await login(booted.url, jar, 'survivor');
    const r = await getJson(booted.url, jar, '/api/me/player');
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'STEAM_NOT_LINKED');
    const me = await getJson(booted.url, jar, '/auth/me');
    assert.equal(me.body.steamLinkRequired, false);
  });

  it('gate on: unlinked survivor gets 403 STEAM_LINK_REQUIRED on /api/*', async () => {
    config.enableSteamProfileSync = true;
    const jar: Jar = new Map();
    await login(booted.url, jar, 'survivor');
    const r = await getJson(booted.url, jar, '/api/me/player');
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'STEAM_LINK_REQUIRED');
    // /auth/* 不受 gate 影響，且回報 steamLinkRequired
    const me = await getJson(booted.url, jar, '/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.steamLinkRequired, true);
  });

  it('gate on: unlinked MOD also gets 403 (same tier band as survivor)', async () => {
    config.enableSteamProfileSync = true;
    const jar: Jar = new Map();
    await login(booted.url, jar, 'mod');
    const r = await getJson(booted.url, jar, '/api/me/player');
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'STEAM_LINK_REQUIRED');
    const me = await getJson(booted.url, jar, '/auth/me');
    assert.equal(me.body.steamLinkRequired, true);
  });

  it('gate cannot be bypassed with an uppercase /API/ path (Express is case-insensitive)', async () => {
    config.enableSteamProfileSync = true;
    const jar: Jar = new Map();
    await login(booted.url, jar, 'survivor');
    // /API/me/player 會命中 /api/me/player handler；gate 必須用小寫比對攔下
    const r = await getJson(booted.url, jar, '/API/me/player');
    assert.equal(r.status, 403, 'uppercase path must NOT bypass the gate');
    assert.equal(r.body.error, 'STEAM_LINK_REQUIRED');
  });

  it('gate fails CLOSED (503) when the link lookup throws', async () => {
    config.enableSteamProfileSync = true;
    const jar: Jar = new Map();
    await login(booted.url, jar, 'survivor', STEAM_SELF);
    // 讓 getByDiscordId 拋錯，模擬 DB 故障 —— 安全閘門不得 fail-open
    const orig = booted.db.userLinks.getByDiscordId;
    booted.db.userLinks.getByDiscordId = () => {
      throw new Error('simulated DB failure');
    };
    try {
      const r = await getJson(booted.url, jar, '/api/me/player');
      assert.equal(r.status, 503);
      assert.equal(r.body.error, 'STEAM_LINK_CHECK_UNAVAILABLE');
    } finally {
      booted.db.userLinks.getByDiscordId = orig;
    }
  });

  it('gate on: linked survivor passes; admin is exempt', async () => {
    config.enableSteamProfileSync = true;
    const linked: Jar = new Map();
    await login(booted.url, linked, 'survivor', STEAM_SELF);
    const r = await getJson(booted.url, linked, '/api/me/player');
    assert.equal(r.status, 200);
    const me = await getJson(booted.url, linked, '/auth/me');
    assert.equal(me.body.steamLinkRequired, false);

    // admin 未綁：不被 gate 擋（否則會被鎖在設定頁外），到達 route 得 409
    booted.db.userLinks.deleteByDiscordId('e2e-test');
    const admin: Jar = new Map();
    await login(booted.url, admin, 'admin');
    const ra = await getJson(booted.url, admin, '/api/me/player');
    assert.equal(ra.status, 409);
    const mea = await getJson(booted.url, admin, '/auth/me');
    assert.equal(mea.body.steamLinkRequired, false);
  });

  it('/auth/me returns cached steamPersona/steamAvatar', async () => {
    const jar: Jar = new Map();
    await login(booted.url, jar, 'survivor', STEAM_SELF);
    booted.db.userLinks.updateSteamProfile('e2e-test', STEAM_SELF, 'PersonaX', 'https://avatars.steamstatic.com/p.jpg');
    const me = await getJson(booted.url, jar, '/auth/me');
    assert.equal(me.body.steamPersona, 'PersonaX');
    assert.equal(me.body.steamAvatar, 'https://avatars.steamstatic.com/p.jpg');
  });

  it('/auth/refresh fetches a stale profile once, then throttles for 24h', async () => {
    config.enableSteamProfileSync = true;
    config.steamWebApiKey = 'test-key';
    steamApiResponder = () => summariesResponse(STEAM_SELF, 'FreshName', 'https://avatars.steamstatic.com/f.jpg');
    const jar: Jar = new Map();
    await login(booted.url, jar, 'survivor', STEAM_SELF);

    const r1 = await getJson(booted.url, jar, '/auth/refresh');
    assert.equal(r1.status, 200);
    assert.equal(r1.body.steamPersona, 'FreshName');
    assert.equal(steamApiCalls, 1);

    const r2 = await getJson(booted.url, jar, '/auth/refresh');
    assert.equal(r2.body.steamPersona, 'FreshName');
    assert.equal(steamApiCalls, 1, 'second refresh within 24h must not re-fetch');
  });

  it('/auth/refresh failure only touches the timestamp (keeps old profile, no retry storm)', async () => {
    config.enableSteamProfileSync = true;
    config.steamWebApiKey = 'test-key';
    const jar: Jar = new Map();
    await login(booted.url, jar, 'survivor', STEAM_SELF);
    booted.db.userLinks.updateSteamProfile('e2e-test', STEAM_SELF, 'OldName', null);
    // 讓快取過期：把時間戳倒回 25 小時前
    booted.db.db
      .prepare(
        "UPDATE user_links SET steam_profile_updated_at = datetime('now', '-25 hours') WHERE discord_user_id = 'e2e-test'",
      )
      .run();
    steamApiResponder = () => new Response('oops', { status: 500 });

    const r1 = await getJson(booted.url, jar, '/auth/refresh');
    assert.equal(r1.body.steamPersona, 'OldName', 'failed fetch keeps the old persona');
    assert.equal(steamApiCalls, 1);
    await getJson(booted.url, jar, '/auth/refresh');
    assert.equal(steamApiCalls, 1, 'failure also stamps updated_at — no retry storm');
  });

  it('/auth/refresh never calls Steam when ENABLE_STEAM_PROFILE_SYNC is off (even if stale)', async () => {
    config.enableSteamProfileSync = false; // sync 關閉
    config.steamWebApiKey = 'test-key';
    const jar: Jar = new Map();
    await login(booted.url, jar, 'survivor', STEAM_SELF);
    booted.db.userLinks.updateSteamProfile('e2e-test', STEAM_SELF, 'OldName', null);
    booted.db.db
      .prepare(
        "UPDATE user_links SET steam_profile_updated_at = datetime('now', '-25 hours') WHERE discord_user_id = 'e2e-test'",
      )
      .run();
    steamApiResponder = () => summariesResponse(STEAM_SELF, 'ShouldNotFetch', '');
    await getJson(booted.url, jar, '/auth/refresh');
    assert.equal(steamApiCalls, 0, 'sync off → no external Steam call even when profile is stale');
  });
});

// ══════════════════════════════════════════════════════════
// 3b — v27 → v28 ALTER migration（既有 user_links 資料列）
// ══════════════════════════════════════════════════════════

describe('Schema v28 — user_links ALTER migration on an existing v27 DB', () => {
  it('adds steam profile columns to a v27 DB, preserving existing link rows', () => {
    const db = new HumanitZDB({ memory: true, label: 'V28Migrate' });
    db.init();
    try {
      // 塞一筆綁定，然後把 DB「降級」成 v27 世界：刪掉 v28 新欄位 + 版本撥回 27。
      db.userLinks.insertLink({ discordUserId: 'd1', steamId: STEAM_SELF, createdBy: 'd1' });
      db.db.exec('ALTER TABLE user_links DROP COLUMN steam_persona');
      db.db.exec('ALTER TABLE user_links DROP COLUMN steam_avatar');
      db.db.exec('ALTER TABLE user_links DROP COLUMN steam_profile_updated_at');
      db._setMeta('schema_version', '27');

      const cols0 = (db.db.prepare('PRAGMA table_info(user_links)').all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      assert.ok(!cols0.includes('steam_persona'), 'precondition: v27 DB has no steam_persona');

      db._applySchema();

      assert.equal(db._getMeta('schema_version'), String(SCHEMA_VERSION));
      const cols = (db.db.prepare('PRAGMA table_info(user_links)').all() as Array<{ name: string }>).map((c) => c.name);
      assert.ok(cols.includes('steam_persona'), 'steam_persona added by v28');
      assert.ok(cols.includes('steam_avatar'), 'steam_avatar added by v28');
      assert.ok(cols.includes('steam_profile_updated_at'), 'steam_profile_updated_at added by v28');

      // 既有綁定列必須保留，新欄位為 null
      const row = db.userLinks.getByDiscordId('d1');
      assert.equal(row.steam_id, STEAM_SELF, 'existing link row preserved');
      assert.equal(row.steam_persona ?? null, null, 'new column defaults to null');

      // 重跑 migration 不得拋（duplicate column 被吸收）
      db._setMeta('schema_version', '27');
      assert.doesNotThrow(() => db._applySchema());
      assert.equal(db._getMeta('schema_version'), String(SCHEMA_VERSION));
      assert.equal(db.userLinks.getByDiscordId('d1')?.steam_id, STEAM_SELF);
    } finally {
      db.close();
    }
  });
});

// ══════════════════════════════════════════════════════════
// 4 — /api/players survivor 過濾 + /api/me/mapdata
// ══════════════════════════════════════════════════════════

function savePlayer(name: string, x: number, y: number, extras: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    x,
    y,
    z: 10,
    health: 77,
    maxHealth: 100,
    inventory: [{ item: 'Axe' }],
    equipment: [],
    quickSlots: [],
    backpackItems: [],
    ...extras,
  };
}

describe('Integration: survivor map visibility', () => {
  let booted: Booted;

  before(async () => {
    setAuthEnv();
    installFetchStub();
    saveConfig();
    config.enableSteamProfileSync = false;
    booted = await bootApp('SurvivorMap');

    booted.savePlayers.set(
      STEAM_SELF,
      savePlayer('SelfPlayer', 1000, 2000, {
        horses: [
          {
            class: 'BP_Horse_C',
            displayName: 'Horse',
            name: '小紅',
            x: 500,
            y: 600,
            z: 5,
            health: 90,
            maxHealth: 100,
            ownerSteamId: STEAM_SELF,
          },
          {
            class: 'BP_Horse_C',
            displayName: 'Horse',
            name: 'NoPos',
            x: 0,
            y: 0,
            z: 0,
            health: 90,
            maxHealth: 100,
            ownerSteamId: STEAM_SELF,
          },
        ],
      }),
    );
    booted.savePlayers.set(STEAM_MATE, savePlayer('MatePlayer', 3000, 4000));
    booted.savePlayers.set(STEAM_STRANGER, savePlayer('StrangerPlayer', 5000, 6000));

    booted.db.clan.upsertClan('TestClan', [
      { steamId: STEAM_SELF, name: 'SelfPlayer', rank: 'Leader' },
      { steamId: STEAM_MATE, name: 'MatePlayer', rank: 'Member' },
    ]);

    booted.db.worldObject.replaceVehicles([
      {
        class: 'BP_Van_C',
        displayName: 'My Van',
        x: 1500,
        y: 2500,
        z: 0,
        health: 50,
        maxHealth: 100,
        fuel: 10.25,
        extra: { Data: [`1\r\n1\r\nNone\r\n${STEAM_SELF}_+_|000217225ed84f2aacac2dfd6b505916`] },
      },
      {
        class: 'BP_Truck_C',
        displayName: 'Wild Truck',
        x: 100,
        y: 200,
        z: 0,
        health: 60,
        maxHealth: 100,
        fuel: 5,
        extra: { Data: ['0\r\n1\r\nNone\r\nNone'] },
      },
      {
        class: 'BP_Car_C',
        displayName: 'Stranger Car',
        x: 300,
        y: 400,
        z: 0,
        health: 70,
        maxHealth: 100,
        fuel: 8,
        extra: { Data: [`1\r\n1\r\nNone\r\n${STEAM_STRANGER}_+_|ffffffffffffffffffffffffffffffff`] },
      },
    ]);
    booted.db.worldObject.replaceCompanions([
      { type: 'dog', actorName: 'Dog1', ownerSteamId: STEAM_SELF, x: 1100, y: 2100, z: 0, health: 80 },
      { type: 'dog', actorName: 'Dog2', ownerSteamId: STEAM_STRANGER, x: 1200, y: 2200, z: 0, health: 80 },
    ]);
  });

  after(async () => {
    await booted.close();
    restoreConfig();
    restoreFetch();
    cleanAuthEnv();
  });

  it('survivor list view: coords only for self + clanmates; sensitive fields stripped', async () => {
    const jar: Jar = new Map();
    await login(booted.url, jar, 'survivor', STEAM_SELF);
    const { status, body } = await getJson(booted.url, jar, '/api/players');
    assert.equal(status, 200);
    const byId = new Map((body.players as Array<Record<string, unknown>>).map((p) => [p.steamId, p]));

    const self = byId.get(STEAM_SELF) ?? {};
    assert.equal(self.hasPosition, true);
    assert.ok((self.inventory as unknown[]).length > 0, 'own inventory retained');
    assert.ok((self.horses as unknown[]).length > 0, 'own horses retained');
    assert.equal(self.health, 77);

    const mate = byId.get(STEAM_MATE) ?? {};
    assert.equal(mate.hasPosition, true, 'clanmate position visible');
    assert.notEqual(mate.lat, null);
    assert.deepEqual(mate.inventory, [], 'clanmate inventory stripped');
    assert.equal(mate.health, null, 'clanmate vitals stripped');

    const stranger = byId.get(STEAM_STRANGER) ?? {};
    assert.equal(stranger.hasPosition, false, 'stranger position hidden');
    assert.equal(stranger.lat, null);
    assert.equal(stranger.worldX, null);
    assert.deepEqual(stranger.inventory, []);
    assert.equal(stranger.name, 'StrangerPlayer', 'public fields kept');
  });

  it('mod list view is unchanged (all positions + inventories)', async () => {
    booted.db.userLinks.deleteByDiscordId('e2e-test');
    const jar: Jar = new Map();
    await login(booted.url, jar, 'mod');
    const { body } = await getJson(booted.url, jar, '/api/players');
    const byId = new Map((body.players as Array<Record<string, unknown>>).map((p) => [p.steamId, p]));
    const stranger = byId.get(STEAM_STRANGER) ?? {};
    assert.equal(stranger.hasPosition, true);
    assert.ok((stranger.inventory as unknown[]).length > 0);
  });

  it('survivor detail view: stranger gets the public allowlist only; clanmate keeps coords', async () => {
    const jar: Jar = new Map();
    await login(booted.url, jar, 'survivor', STEAM_SELF);

    const stranger = await getJson(booted.url, jar, `/api/players/${STEAM_STRANGER}`);
    assert.equal(stranger.status, 200);
    assert.equal(stranger.body.hasPosition, false);
    assert.equal(stranger.body.lat, null);
    assert.ok(!('inventory' in stranger.body), 'no inventory key for strangers');
    assert.ok(!('horses' in stranger.body), 'no horses key for strangers');

    const mate = await getJson(booted.url, jar, `/api/players/${STEAM_MATE}`);
    assert.equal(mate.body.hasPosition, true);
    assert.ok(!('inventory' in mate.body), 'clanmate detail still has no inventory');

    const self = await getJson(booted.url, jar, `/api/players/${STEAM_SELF}`);
    assert.equal(self.body.hasPosition, true);
    assert.ok('inventory' in self.body, 'own detail keeps everything');
  });

  it('/api/me/mapdata returns only owner==self vehicles / companions / horses', async () => {
    const jar: Jar = new Map();
    await login(booted.url, jar, 'survivor', STEAM_SELF);
    const { status, body } = await getJson(booted.url, jar, '/api/me/mapdata');
    assert.equal(status, 200);

    assert.equal(body.vehicles.length, 1, 'only own vehicle');
    assert.equal(body.vehicles[0].name, 'My Van');
    assert.equal(body.vehicles[0].fuel, 10.3);
    assert.equal(body.vehicles[0].lat, 15, '_worldToLeaflet applied (1500/100)');

    assert.equal(body.companions.length, 1, 'only own dog');
    assert.equal(body.companions[0].type, 'dog');

    assert.equal(body.horses.length, 1, 'own horse with a valid position (0,0,0 filtered)');
    assert.equal(body.horses[0].name, '小紅');
    assert.equal(body.horses[0].lat, 5);
  });

  it('/api/me/mapdata without a link returns 409', async () => {
    booted.db.userLinks.deleteByDiscordId('e2e-test');
    const jar: Jar = new Map();
    await login(booted.url, jar, 'survivor');
    const { status, body } = await getJson(booted.url, jar, '/api/me/mapdata');
    assert.equal(status, 409);
    assert.equal(body.error, 'STEAM_NOT_LINKED');
  });
});
