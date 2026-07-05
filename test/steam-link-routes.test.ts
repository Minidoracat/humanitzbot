/**
 * Integration tests for Steam↔Discord account linking:
 *
 *   - /auth/steam/link + /auth/steam/callback + /auth/steam/unlink（auth.ts）
 *   - /auth/me 的 steamLinked/steamId 現查（不進 session）
 *   - /auth/test-login 的選配 steamId（e2e 支援）
 *   - /api/me/player（me.routes.ts，未綁 409）
 *   - /api/admin/links CRUD（admin-actions.routes.ts）
 *   - Discord /auth/callback 的 session regenerate（fixation 防護）
 *
 * 比照 web-map-auth-integration.test.ts：真 express app + 真 setupAuth，
 * 走 HTTP。對 steamcommunity.com / discord.com 的外連 fetch 用 stub 攔截，
 * 其餘請求 pass-through 給真正的 fetch（測試客戶端也用 fetch）。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';

// 靜態 import：強迫 dotenv 副作用現在發生（見 web-map-auth-integration.test.ts 註解）
import { setupAuth } from '../src/web-map/auth.js';
import { registerMeRoutes } from '../src/web-map/routes/me.routes.js';
import { registerAdminActionsRoutes } from '../src/web-map/routes/admin-actions.routes.js';
import { _test as steamOpenIdTest } from '../src/web-map/steam-openid.js';
import _database from '../src/db/database.js';

const HumanitZDB = _database as any;

const TOKEN = 'a'.repeat(64);
const STEAM_A = '76561198000000001';
const STEAM_B = '76561198000000002';
const STEAM_C = '76561198000000003';

// ── fetch stub：攔外連、pass-through 其他 ────────────────────────────────

const realFetch: typeof fetch = global.fetch.bind(globalThis);
type Responder = (url: string, init?: RequestInit) => Response;
let steamResponder: Responder | null = null;
let discordResponder: Responder | null = null;

function installFetchStub(): void {
  global.fetch = (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : String((input as { url?: string }).url ?? input);
    if (url.startsWith('https://steamcommunity.com/')) {
      if (!steamResponder) return Promise.reject(new Error(`unexpected Steam fetch: ${url}`));
      return Promise.resolve(steamResponder(url, init));
    }
    if (url.startsWith('https://discord.com/')) {
      if (!discordResponder) return Promise.reject(new Error(`unexpected Discord fetch: ${url}`));
      return Promise.resolve(discordResponder(url, init));
    }
    return realFetch(input as string, init);
  };
}

function restoreFetch(): void {
  global.fetch = realFetch;
  steamResponder = null;
  discordResponder = null;
}

const steamOk: Responder = () => new Response('ns:http://specs.openid.net/auth/2.0\nis_valid:true\n', { status: 200 });

// ── cookie jar（多 cookie：hmz_session + hmz.csrf + hmz_oauth_state） ─────

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

interface Booted {
  url: string;
  db: any;
  close: () => Promise<void>;
}

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

async function bootApp(label: string): Promise<Booted> {
  const db = new HumanitZDB({ memory: true, label });
  db.init();

  const app = express();
  const authMiddleware = setupAuth(app, null, { userLinks: db.userLinks });
  app.use(authMiddleware);
  app.use(express.json());
  // 模擬 server.ts 的多伺服器 middleware：掛 req.srv
  app.use('/api', (req, _res, next) => {
    (req as { srv?: unknown }).srv = {
      db,
      serverId: 'primary',
      playtime: { getPlaytime: () => null },
    };
    next();
  });
  const ctx = { _db: db } as unknown as Parameters<typeof registerMeRoutes>[1];
  registerMeRoutes(app, ctx);
  registerAdminActionsRoutes(app, ctx);

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      resolve(s);
    });
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    db,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          db.close();
          resolve();
        });
      }),
  };
}

/** test-login 建 session，回傳 csrf token（也把 csrf cookie 收進 jar）。 */
async function login(base: string, jar: Jar, tier = 'admin', steamId?: string): Promise<string> {
  const res = await fetch(`${base}/auth/test-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: TOKEN, tier, ...(steamId ? { steamId } : {}) }),
  });
  assert.equal(res.status, 200, `test-login should succeed (got ${String(res.status)})`);
  updateJar(jar, res);
  const me = await fetch(`${base}/auth/me`, { headers: { cookie: cookieHeader(jar) } });
  updateJar(jar, me);
  const body = (await me.json()) as { csrfToken?: string };
  return body.csrfToken ?? '';
}

/** 發起綁定流程：回傳 Steam redirect URL 與其中的 state。 */
async function initiateLink(base: string, jar: Jar): Promise<{ location: string; state: string; returnTo: string }> {
  const res = await fetch(`${base}/auth/steam/link`, {
    headers: { cookie: cookieHeader(jar) },
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  updateJar(jar, res);
  const location = res.headers.get('location') ?? '';
  assert.ok(location.startsWith('https://steamcommunity.com/openid/login?'), `unexpected redirect: ${location}`);
  const returnTo = new URL(location).searchParams.get('openid.return_to') ?? '';
  const state = new URL(returnTo).searchParams.get('state') ?? '';
  assert.ok(state.length >= 32, 'state should be a non-trivial random string');
  return { location, state, returnTo };
}

/** 組一份會通過 verifyAssertion 的 Steam 回跳 query（nonce 每次唯一）。 */
function assertionParams(returnTo: string, steamId: string, state: string): URLSearchParams {
  const nonce = `${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}${crypto.randomUUID()}`;
  return new URLSearchParams({
    state,
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'id_res',
    'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
    'openid.claimed_id': `https://steamcommunity.com/openid/id/${steamId}`,
    'openid.identity': `https://steamcommunity.com/openid/id/${steamId}`,
    'openid.return_to': returnTo,
    'openid.response_nonce': nonce,
    'openid.assoc_handle': '1234567890',
    'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
    'openid.sig': 'ZmFrZXNpZw==',
  });
}

// ══════════════════════════════════════════════════════════
// 1 — /auth/steam/* 綁定 / 解綁流程
// ══════════════════════════════════════════════════════════

describe('Integration: Steam link/unlink flow', () => {
  let booted: Booted;

  before(async () => {
    setAuthEnv();
    installFetchStub();
    steamResponder = steamOk;
    steamOpenIdTest.seenNonces.clear();
    booted = await bootApp('SteamLinkFlow');
  });

  after(async () => {
    await booted.close();
    restoreFetch();
    cleanAuthEnv();
  });

  it('GET /auth/steam/link without a session redirects to /auth/login', async () => {
    const res = await fetch(`${booted.url}/auth/steam/link`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/auth/login');
  });

  it('GET /auth/steam/callback with openid.mode=cancel silently redirects to /', async () => {
    const res = await fetch(`${booted.url}/auth/steam/callback?openid.mode=cancel`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/');
  });

  it('link redirect carries realm/return_to derived from WEB_MAP_CALLBACK_URL origin', async () => {
    const jar: Jar = new Map();
    await login(booted.url, jar);
    const { location, returnTo } = await initiateLink(booted.url, jar);
    const params = new URL(location).searchParams;
    assert.equal(params.get('openid.realm'), 'http://127.0.0.1');
    assert.equal(params.get('openid.mode'), 'checkid_setup');
    assert.ok(returnTo.startsWith('http://127.0.0.1/auth/steam/callback?state='));
  });

  it('callback with a mismatched state is rejected with 403', async () => {
    const jar: Jar = new Map();
    await login(booted.url, jar);
    const { returnTo } = await initiateLink(booted.url, jar);
    const wrongState = 'f'.repeat(64);
    const qp = assertionParams(returnTo, STEAM_A, wrongState);
    const res = await fetch(`${booted.url}/auth/steam/callback?${qp.toString()}`, {
      headers: { cookie: cookieHeader(jar) },
      redirect: 'manual',
    });
    assert.equal(res.status, 403);
  });

  it('callback with an expired state is rejected with 403', async (t) => {
    const jar: Jar = new Map();
    await login(booted.url, jar);
    const { state, returnTo } = await initiateLink(booted.url, jar);
    // 把 Date 往後撥 6 分鐘（state TTL 5 分鐘）—— 只 mock Date，timer 照常
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    t.mock.timers.tick(6 * 60 * 1000);
    try {
      const qp = assertionParams(returnTo, STEAM_A, state);
      const res = await fetch(`${booted.url}/auth/steam/callback?${qp.toString()}`, {
        headers: { cookie: cookieHeader(jar) },
        redirect: 'manual',
      });
      assert.equal(res.status, 403);
    } finally {
      t.mock.timers.reset();
    }
  });

  it('successful callback inserts the link + bind audit, and state is single-use', async () => {
    const jar: Jar = new Map();
    await login(booted.url, jar);
    const { state, returnTo } = await initiateLink(booted.url, jar);
    const qp = assertionParams(returnTo, STEAM_A, state);
    const url = `${booted.url}/auth/steam/callback?${qp.toString()}`;

    const res = await fetch(url, { headers: { cookie: cookieHeader(jar) }, redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/');

    const link = booted.db.userLinks.getByDiscordId('e2e-test');
    assert.ok(link, 'link row should exist');
    assert.equal(link.steam_id, STEAM_A);
    assert.equal(link.verified_via, 'steam_openid');

    const audit = booted.db.userLinks.getAuditFor('e2e-test');
    assert.ok(audit.total >= 1);
    const bind = audit.rows.find((r: Record<string, unknown>) => r.action === 'bind' && r.reason === 'self_service');
    assert.ok(bind, 'self-service bind audit row should exist (reason distinguishes it from admin binds)');
    assert.equal(bind.steam_id, STEAM_A);
    assert.equal(bind.is_test_session, 1, 'test-login session must be flagged in audit');

    // /auth/me 現查 —— 回報 steamLinked + steamId
    const me = await fetch(`${booted.url}/auth/me`, { headers: { cookie: cookieHeader(jar) } });
    const meBody = (await me.json()) as Record<string, unknown>;
    assert.equal(meBody.steamLinked, true);
    assert.equal(meBody.steamId, STEAM_A);

    // 同一 callback URL 重放：state 已用掉 → 403（也保護 nonce 不會被重放）
    const replay = await fetch(url, { headers: { cookie: cookieHeader(jar) }, redirect: 'manual' });
    assert.equal(replay.status, 403);
  });

  it('binding again while already linked returns the 409 conflict page', async () => {
    const jar: Jar = new Map();
    await login(booted.url, jar); // e2e-test 已在上一測綁 STEAM_A
    const { state, returnTo } = await initiateLink(booted.url, jar);
    const qp = assertionParams(returnTo, STEAM_B, state);
    const res = await fetch(`${booted.url}/auth/steam/callback?${qp.toString()}`, {
      headers: { cookie: cookieHeader(jar) },
      redirect: 'manual',
    });
    assert.equal(res.status, 409);
  });

  it('POST /auth/steam/unlink removes the link and writes an unbind audit', async () => {
    const jar: Jar = new Map();
    const csrf = await login(booted.url, jar);
    const res = await fetch(`${booted.url}/auth/steam/unlink`, {
      method: 'POST',
      headers: { cookie: cookieHeader(jar), 'x-csrf-token': csrf },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.unlinked, true);
    assert.equal(booted.db.userLinks.getByDiscordId('e2e-test'), undefined);

    const audit = booted.db.userLinks.getAuditFor('e2e-test');
    const unbind = audit.rows.find((r: Record<string, unknown>) => r.action === 'unbind');
    assert.ok(unbind, 'unbind audit row should exist');
    assert.equal(unbind.steam_id, STEAM_A);
    assert.equal(unbind.reason, 'self_service');

    // /auth/me 現查 —— 解綁後立即 false
    const me = await fetch(`${booted.url}/auth/me`, { headers: { cookie: cookieHeader(jar) } });
    const meBody = (await me.json()) as Record<string, unknown>;
    assert.equal(meBody.steamLinked, false);
    assert.equal('steamId' in meBody, false);

    // 再解一次：無事可解 → unlinked:false
    const again = await fetch(`${booted.url}/auth/steam/unlink`, {
      method: 'POST',
      headers: { cookie: cookieHeader(jar), 'x-csrf-token': csrf },
    });
    const againBody = (await again.json()) as Record<string, unknown>;
    assert.equal(againBody.unlinked, false);
  });

  it('binding a Steam ID already held by another Discord account returns 409', async () => {
    booted.db.userLinks.insertLink({ discordUserId: '111111111111111111', steamId: STEAM_C, createdBy: 'seed' });
    const jar: Jar = new Map();
    await login(booted.url, jar);
    const { state, returnTo } = await initiateLink(booted.url, jar);
    const qp = assertionParams(returnTo, STEAM_C, state);
    const res = await fetch(`${booted.url}/auth/steam/callback?${qp.toString()}`, {
      headers: { cookie: cookieHeader(jar) },
      redirect: 'manual',
    });
    assert.equal(res.status, 409);
    assert.equal(booted.db.userLinks.getByDiscordId('e2e-test'), undefined, 'no link row for the loser');
  });

  it('POST /auth/steam/unlink without a session is rejected (CSRF layer, 403)', async () => {
    // CSRF token 與 session id 綁定（getSessionIdentifier）——匿名請求每次拿到
    // 新 session id，不可能湊出有效 token，因此在 CSRF middleware 就被 403 擋下，
    // 連 handler 的 401 防線都到不了（那條是 defense-in-depth）。
    const jar: Jar = new Map();
    const me = await fetch(`${booted.url}/auth/me`);
    updateJar(jar, me);
    const meBody = (await me.json()) as { csrfToken?: string };
    const res = await fetch(`${booted.url}/auth/steam/unlink`, {
      method: 'POST',
      headers: { cookie: cookieHeader(jar), 'x-csrf-token': meBody.csrfToken ?? '' },
    });
    assert.equal(res.status, 403);
    // 完全裸打（無 cookie、無 token）也一樣被擋
    const bare = await fetch(`${booted.url}/auth/steam/unlink`, { method: 'POST' });
    assert.equal(bare.status, 403);
  });
});

// ══════════════════════════════════════════════════════════
// 2 — test-login steamId + /auth/me 現查 + /api/me/player
// ══════════════════════════════════════════════════════════

describe('Integration: test-login steamId + /api/me/player', () => {
  let booted: Booted;

  before(async () => {
    setAuthEnv();
    installFetchStub();
    booted = await bootApp('SteamLinkMe');
  });

  after(async () => {
    await booted.close();
    restoreFetch();
    cleanAuthEnv();
  });

  it('test-login with steamId writes a link + audit flagged is_test_session', async () => {
    const jar: Jar = new Map();
    await login(booted.url, jar, 'admin', STEAM_A);
    const link = booted.db.userLinks.getByDiscordId('e2e-test');
    assert.equal(link?.steam_id, STEAM_A);
    const audit = booted.db.userLinks.getAuditFor('e2e-test');
    assert.equal(audit.rows[0].is_test_session, 1);

    const me = await fetch(`${booted.url}/auth/me`, { headers: { cookie: cookieHeader(jar) } });
    const meBody = (await me.json()) as Record<string, unknown>;
    assert.equal(meBody.steamLinked, true);
    assert.equal(meBody.steamId, STEAM_A);
  });

  it('/auth/me reflects an out-of-band unlink immediately (per-request lookup)', async () => {
    const jar: Jar = new Map();
    await login(booted.url, jar, 'admin', STEAM_A);
    // 模擬他處解綁（admin / 另一分頁）：session 完全沒動
    booted.db.userLinks.deleteByDiscordId('e2e-test');
    const me = await fetch(`${booted.url}/auth/me`, { headers: { cookie: cookieHeader(jar) } });
    const meBody = (await me.json()) as Record<string, unknown>;
    assert.equal(meBody.steamLinked, false, 'stale session must not report a deleted link');
  });

  it('test-login with an invalid steamId returns 400', async () => {
    const res = await fetch(`${booted.url}/auth/test-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN, steamId: '123' }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.error, 'INVALID_STEAM_ID');
  });

  it('GET /api/me/player unauthenticated returns 401', async () => {
    const res = await fetch(`${booted.url}/api/me/player`);
    assert.equal(res.status, 401);
  });

  it('GET /api/me/player without a link returns 409 STEAM_NOT_LINKED', async () => {
    const jar: Jar = new Map();
    await login(booted.url, jar, 'survivor'); // 前一測已把 link 刪掉
    const res = await fetch(`${booted.url}/api/me/player`, { headers: { cookie: cookieHeader(jar) } });
    assert.equal(res.status, 409);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.error, 'STEAM_NOT_LINKED');
  });

  it('GET /api/me/player with a link returns the safe player summary only', async () => {
    booted.db.db
      .prepare('INSERT INTO players (steam_id, name, level, days_survived, zeeks_killed) VALUES (?, ?, ?, ?, ?)')
      .run(STEAM_B, 'MePlayer', 7, 12, 34);
    const jar: Jar = new Map();
    await login(booted.url, jar, 'survivor', STEAM_B);

    const res = await fetch(`${booted.url}/api/me/player`, { headers: { cookie: cookieHeader(jar) } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { steamId: string; player: Record<string, unknown> | null };
    assert.equal(body.steamId, STEAM_B);
    assert.ok(body.player, 'player summary should be present');
    assert.equal(body.player.name, 'MePlayer');
    assert.equal(body.player.level, 7);
    assert.equal(body.player.daysSurvived, 12);
    assert.equal(body.player.zeeksKilled, 34);

    // key-set 全等斷言：白名單外任何欄位（管理欄位 / inventory / 座標…）
    // 一旦被加進回應就會 fail —— 比黑名單迴圈更嚴格
    const whitelist = [
      'name',
      'online',
      'profession',
      'level',
      'expCurrent',
      'expRequired',
      'skillsPoint',
      'daysSurvived',
      'lifetimeDaysSurvived',
      'zeeksKilled',
      'headshots',
      'lifetimeKills',
      'timesBitten',
      'fishCaught',
      'health',
      'maxHealth',
      'firstSeen',
      'lastSeen',
      'totalPlaytime',
    ];
    assert.deepEqual(Object.keys(body.player).sort(), [...whitelist].sort());
  });

  it('/auth/refresh reports steamLinked per-request — false before bind, true after', async () => {
    booted.db.userLinks.deleteByDiscordId('e2e-test');
    const jar: Jar = new Map();
    await login(booted.url, jar, 'survivor');

    const before = await fetch(`${booted.url}/auth/refresh`, { headers: { cookie: cookieHeader(jar) } });
    const beforeBody = (await before.json()) as Record<string, unknown>;
    assert.equal(beforeBody.steamLinked, false);
    assert.equal('steamId' in beforeBody, false);

    // 綁定後同一 session 的 refresh 立即反映（現查、不進 session）
    booted.db.userLinks.insertLink({ discordUserId: 'e2e-test', steamId: STEAM_A, createdBy: 'e2e-test' });
    const after = await fetch(`${booted.url}/auth/refresh`, { headers: { cookie: cookieHeader(jar) } });
    const afterBody = (await after.json()) as Record<string, unknown>;
    assert.equal(afterBody.steamLinked, true);
    assert.equal(afterBody.steamId, STEAM_A);
    booted.db.userLinks.deleteByDiscordId('e2e-test');
  });

  it('GET /api/me/player with a link but no player row returns player:null', async () => {
    const jar: Jar = new Map();
    await login(booted.url, jar, 'survivor', STEAM_C); // 沒 seed players row
    const res = await fetch(`${booted.url}/api/me/player`, { headers: { cookie: cookieHeader(jar) } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { player: unknown };
    assert.equal(body.player, null);
  });
});

// ══════════════════════════════════════════════════════════
// 3 — /api/admin/links CRUD
// ══════════════════════════════════════════════════════════

describe('Integration: /api/admin/links CRUD', () => {
  let booted: Booted;
  const jar: Jar = new Map();
  let csrf = '';
  const DISCORD_ID = '222222222222222222';

  before(async () => {
    setAuthEnv();
    installFetchStub();
    booted = await bootApp('SteamLinkAdmin');
    csrf = await login(booted.url, jar, 'admin');
  });

  after(async () => {
    await booted.close();
    restoreFetch();
    cleanAuthEnv();
  });

  function adminFetch(path: string, init: { method?: string; body?: string } = {}): Promise<Response> {
    return fetch(`${booted.url}${path}`, {
      ...init,
      headers: {
        cookie: cookieHeader(jar),
        'x-csrf-token': csrf,
        'Content-Type': 'application/json',
      },
    });
  }

  it('GET lists links (empty at first)', async () => {
    const res = await adminFetch('/api/admin/links');
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.deepEqual(body.rows, []);
    assert.equal(body.total, 0);
  });

  it('POST creates a manual link with audit (verified_via=admin_manual)', async () => {
    const res = await adminFetch('/api/admin/links', {
      method: 'POST',
      body: JSON.stringify({ discordUserId: DISCORD_ID, steamId: STEAM_A, reason: 'support ticket #42' }),
    });
    assert.equal(res.status, 200);
    const link = booted.db.userLinks.getByDiscordId(DISCORD_ID);
    assert.equal(link?.steam_id, STEAM_A);
    assert.equal(link?.verified_via, 'admin_manual');
    assert.equal(link?.created_by, 'e2e-test');

    const audit = booted.db.userLinks.getAuditFor(DISCORD_ID);
    assert.equal(audit.rows[0].action, 'admin_bind');
    assert.equal(audit.rows[0].reason, 'support ticket #42');
    assert.equal(audit.rows[0].actor_id, 'e2e-test');
    assert.equal(audit.rows[0].actor_tier, 'admin');

    const list = await adminFetch(`/api/admin/links?query=${STEAM_A}`);
    const listBody = (await list.json()) as { rows: Array<Record<string, unknown>>; total: number };
    assert.equal(listBody.total, 1);
    assert.equal(listBody.rows[0]?.discord_user_id, DISCORD_ID);
  });

  it('POST duplicate returns 409 ALREADY_LINKED', async () => {
    const res = await adminFetch('/api/admin/links', {
      method: 'POST',
      body: JSON.stringify({ discordUserId: DISCORD_ID, steamId: STEAM_B, reason: 'dup' }),
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.error, 'ALREADY_LINKED');
  });

  it('POST without reason returns 400 REASON_REQUIRED', async () => {
    const res = await adminFetch('/api/admin/links', {
      method: 'POST',
      body: JSON.stringify({ discordUserId: '333333333333333333', steamId: STEAM_B, reason: '   ' }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.error, 'REASON_REQUIRED');
  });

  it('POST with an invalid steamId returns 400 INVALID_STEAM_ID_FORMAT', async () => {
    const res = await adminFetch('/api/admin/links', {
      method: 'POST',
      body: JSON.stringify({ discordUserId: '333333333333333333', steamId: '99999999999999999', reason: 'x' }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.code, 'INVALID_STEAM_ID_FORMAT');
  });

  it('POST with an invalid discordUserId returns 400 INVALID_DISCORD_USER_ID', async () => {
    const res = await adminFetch('/api/admin/links', {
      method: 'POST',
      body: JSON.stringify({ discordUserId: 'not-a-snowflake', steamId: STEAM_B, reason: 'x' }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.error, 'INVALID_DISCORD_USER_ID');
  });

  it('DELETE without reason returns 400, unknown id returns 404', async () => {
    const noReason = await adminFetch(`/api/admin/links/${DISCORD_ID}`, { method: 'DELETE', body: JSON.stringify({}) });
    assert.equal(noReason.status, 400);

    const notFound = await adminFetch('/api/admin/links/444444444444444444', {
      method: 'DELETE',
      body: JSON.stringify({ reason: 'cleanup' }),
    });
    assert.equal(notFound.status, 404);
  });

  it('DELETE removes the link and writes an admin_unbind audit', async () => {
    const res = await adminFetch(`/api/admin/links/${DISCORD_ID}`, {
      method: 'DELETE',
      body: JSON.stringify({ reason: 'user requested' }),
    });
    assert.equal(res.status, 200);
    assert.equal(booted.db.userLinks.getByDiscordId(DISCORD_ID), undefined);
    const audit = booted.db.userLinks.getAuditFor(DISCORD_ID);
    assert.equal(audit.rows[0].action, 'admin_unbind');
    assert.equal(audit.rows[0].reason, 'user requested');
    assert.equal(audit.rows[0].steam_id, STEAM_A);
  });

  it('non-admin tier is rejected with 403', async () => {
    const survivorJar: Jar = new Map();
    await login(booted.url, survivorJar, 'survivor');
    const res = await fetch(`${booted.url}/api/admin/links`, { headers: { cookie: cookieHeader(survivorJar) } });
    assert.equal(res.status, 403);
  });

  it('DELETE with a non-snowflake discordUserId returns 400 INVALID_DISCORD_USER_ID', async () => {
    const res = await adminFetch('/api/admin/links/not-a-snowflake', {
      method: 'DELETE',
      body: JSON.stringify({ reason: 'x' }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.error, 'INVALID_DISCORD_USER_ID');
  });

  it('permission matrix: anonymous/survivor/mod × GET/POST/DELETE are all non-2xx', async () => {
    for (const tier of [null, 'survivor', 'mod']) {
      const jar: Jar = new Map();
      let tierCsrf = '';
      if (tier) tierCsrf = await login(booted.url, jar, tier);
      const headers = {
        cookie: cookieHeader(jar),
        'x-csrf-token': tierCsrf,
        'Content-Type': 'application/json',
      };
      const attempts: Array<[string, string, string | undefined]> = [
        ['GET', '/api/admin/links', undefined],
        [
          'POST',
          '/api/admin/links',
          JSON.stringify({ discordUserId: '555555555555555555', steamId: STEAM_B, reason: 'x' }),
        ],
        ['DELETE', '/api/admin/links/555555555555555555', JSON.stringify({ reason: 'x' })],
      ];
      for (const [method, path, body] of attempts) {
        const res = await fetch(`${booted.url}${path}`, { method, headers, ...(body ? { body } : {}) });
        await res.arrayBuffer(); // 消化 body，避免連線洩漏
        assert.ok(
          res.status < 200 || res.status >= 300,
          `${tier ?? 'anonymous'} ${method} ${path} must be rejected (got ${String(res.status)})`,
        );
      }
    }
    // 矩陣掃過後不得產生任何 link
    assert.equal(booted.db.userLinks.getByDiscordId('555555555555555555'), undefined);
  });
});

// ══════════════════════════════════════════════════════════
// 5 — callback 錯誤分類（route level）：不洩漏內部 reason、不落資料
// ══════════════════════════════════════════════════════════

describe('Integration: Steam callback error classification', () => {
  let booted: Booted;

  before(async () => {
    setAuthEnv();
    installFetchStub();
    steamOpenIdTest.seenNonces.clear();
    booted = await bootApp('SteamLinkErrors');
  });

  after(async () => {
    await booted.close();
    restoreFetch();
    cleanAuthEnv();
  });

  it('check_authentication is_valid:false → 400 generic page, no link, no audit, no reason leak', async () => {
    steamResponder = () => new Response('ns:http://specs.openid.net/auth/2.0\nis_valid:false\n', { status: 200 });
    const jar: Jar = new Map();
    await login(booted.url, jar);
    const auditBefore = booted.db.userLinks.getAuditFor('e2e-test').total;

    const { state, returnTo } = await initiateLink(booted.url, jar);
    const qp = assertionParams(returnTo, STEAM_A, state);
    const res = await fetch(`${booted.url}/auth/steam/callback?${qp.toString()}`, {
      headers: { cookie: cookieHeader(jar) },
      redirect: 'manual',
    });
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.ok(!text.includes('not_valid'), 'internal reason enum must not leak into the response');

    assert.equal(booted.db.userLinks.getByDiscordId('e2e-test'), undefined, 'no link row on failed verification');
    assert.equal(booted.db.userLinks.getAuditFor('e2e-test').total, auditBefore, 'no audit row on failed verification');
  });

  it('network error reaching Steam → 503 with a retry hint, no link written', async () => {
    steamResponder = () => {
      throw new TypeError('fetch failed');
    };
    const jar: Jar = new Map();
    await login(booted.url, jar);

    const { state, returnTo } = await initiateLink(booted.url, jar);
    const qp = assertionParams(returnTo, STEAM_A, state);
    const res = await fetch(`${booted.url}/auth/steam/callback?${qp.toString()}`, {
      headers: { cookie: cookieHeader(jar) },
      redirect: 'manual',
    });
    assert.equal(res.status, 503);
    const text = await res.text();
    assert.ok(/temporarily unreachable/i.test(text), 'should tell the user to retry later');
    assert.equal(booted.db.userLinks.getByDiscordId('e2e-test'), undefined);
  });
});

// ══════════════════════════════════════════════════════════
// 6 — rate limiting：/auth/steam/link 每 IP 每分鐘 10 次
// ══════════════════════════════════════════════════════════

describe('Integration: /auth/steam/link rate limit', () => {
  let booted: Booted;

  before(async () => {
    setAuthEnv();
    installFetchStub();
    booted = await bootApp('SteamLinkRate');
  });

  after(async () => {
    await booted.close();
    restoreFetch();
    cleanAuthEnv();
  });

  it('11th request within the window is rejected with 429', async () => {
    // rate limit 在 session 檢查之前 —— 匿名請求即可觸發（302 → /auth/login）
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${booted.url}/auth/steam/link`, { redirect: 'manual' });
      await res.arrayBuffer();
      assert.equal(res.status, 302, `request ${String(i + 1)} should pass the limiter`);
    }
    const res11 = await fetch(`${booted.url}/auth/steam/link`, { redirect: 'manual' });
    assert.equal(res11.status, 429);
    const body = (await res11.json()) as Record<string, unknown>;
    assert.equal(body.code, 'RATE_LIMITED');
  });
});

// ══════════════════════════════════════════════════════════
// 4 — Discord /auth/callback：session regenerate（fixation 防護）
// ══════════════════════════════════════════════════════════

describe('Integration: Discord callback regenerates the session id', () => {
  let booted: Booted;

  before(async () => {
    setAuthEnv();
    installFetchStub();
    discordResponder = (url) => {
      if (url.includes('/oauth2/token')) {
        return new Response(
          JSON.stringify({
            access_token: 'at',
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: 'rt',
            scope: 'identify',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/users/@me')) {
        return new Response(JSON.stringify({ id: '123456789012345678', username: 'tester', global_name: 'Tester' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // guild member lookup — 非 guild 成員
      return new Response('not found', { status: 404 });
    };
    booted = await bootApp('SteamLinkRegen');
  });

  after(async () => {
    await booted.close();
    restoreFetch();
    cleanAuthEnv();
  });

  it('issues a NEW session id on login and invalidates the pre-login session', async () => {
    // 1. 先有一顆「登入前」session（模擬被種下的固定 session id）
    const jar: Jar = new Map();
    await login(booted.url, jar);
    const preLoginSession = jar.get('hmz_session');
    assert.ok(preLoginSession, 'pre-login session cookie should exist');

    // 2. 走 OAuth 流程（Discord API 已 stub）
    const loginRes = await fetch(`${booted.url}/auth/login`, {
      headers: { cookie: cookieHeader(jar) },
      redirect: 'manual',
    });
    updateJar(jar, loginRes);
    const state = new URL(loginRes.headers.get('location') ?? '').searchParams.get('state') ?? '';

    const cb = await fetch(`${booted.url}/auth/callback?code=abc&state=${state}`, {
      headers: { cookie: cookieHeader(jar) },
      redirect: 'manual',
    });
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.get('location'), '/');

    // 3. callback 必須換發新的 session id（fixation 防護）
    const newSession = cb.headers
      .getSetCookie()
      .map((c) => c.split(';')[0] ?? '')
      .find((c) => c.startsWith('hmz_session='))
      ?.slice('hmz_session='.length);
    assert.ok(newSession, 'callback should set a session cookie');
    assert.notEqual(newSession, preLoginSession, 'session id must change on login (regenerate)');

    // 4. 新 session 是登入後的 Discord 使用者
    const meNew = await fetch(`${booted.url}/auth/me`, { headers: { cookie: `hmz_session=${newSession}` } });
    const meNewBody = (await meNew.json()) as Record<string, unknown>;
    assert.equal(meNewBody.authenticated, true);
    assert.equal(meNewBody.userId, '123456789012345678');

    // 5. 舊 session 已被銷毀 —— 拿舊 cookie 查不到使用者
    const meOld = await fetch(`${booted.url}/auth/me`, { headers: { cookie: `hmz_session=${preLoginSession}` } });
    const meOldBody = (await meOld.json()) as Record<string, unknown>;
    assert.equal(meOldBody.authenticated, false, 'pre-login session must be destroyed by regenerate');
  });
});
