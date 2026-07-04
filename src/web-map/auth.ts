/**
 * Discord OAuth2 middleware for the web panel.
 */

import crypto from 'crypto';
import { json as jsonBodyParser } from 'express';
import expressSession from 'express-session';
import { doubleCsrf } from 'csrf-csrf';
import cookieParser from 'cookie-parser';
import _defaultConfig from '../config/index.js';
import { createSessionStore } from './session-store-factory.js';
import { buildRedirectUrl, verifyAssertion, isValidSteamId64 } from './steam-openid.js';
import { rateLimit } from './rate-limit.js';

import type { Express, Request, Response, NextFunction } from 'express';
import type { UserLinksRepository } from '../db/repositories/user-links-repository.js';

// ── Type augmentations for Express request ──────────────────────────────────

interface SessionUser {
  userId: string;
  username: string;
  displayName: string;
  avatar: string | null;
  roles: string[];
  tier: string;
  tierLevel: number | undefined;
  inGuild: boolean;
  lastRoleCheck: number;
  // Marks sessions created via /auth/test-login so audit logs can filter them out.
  isTestSession?: boolean;
}

interface HmzSession {
  user?: SessionUser;
  id?: string;
  // Steam OpenID 綁定流程的一次性 state（5 分鐘 TTL、用後即刪）
  steamLinkState?: { value: string; expires: number };
  save(cb: (err: Error | null) => void): void;
  destroy(cb: (err: Error | null) => void): void;
}

type HmzRequest = Request & {
  session: HmzSession & Request['session'];
  sessionID?: string;
  tier?: string;
  tierLevel?: number;
  csrfToken?: () => string;
};

// ── Configuration ────────────────────────────────────────────────────────────

const DISCORD_API = 'https://discord.com/api/v10';
const OAUTH_SCOPES = 'identify guilds guilds.members.read';

const TIER: Record<string, number> = { public: 0, survivor: 1, mod: 2, admin: 3 };

const COOKIE_NAME = 'hmz_session';
const ROLE_REFRESH_INTERVAL = 5 * 60 * 1000;
// Steam 綁定 state 有效期（發起 → Steam 回跳的最長間隔）
const STEAM_LINK_STATE_TTL = 5 * 60 * 1000;

// ── Helpers ──────────────────────────────────────────────────────────────────

// Allowlist of NODE_ENV values where /auth/test-login may be registered.
// Fail-closed: anything else (unset, 'production', typos) rejects the token.
const TEST_LOGIN_SAFE_ENVS = new Set(['development', 'dev', 'test']);

function getTestAuthToken(): string | null {
  const raw = process.env['WEB_PANEL_TEST_AUTH_TOKEN'];
  if (!raw) return null;
  const nodeEnv = process.env['NODE_ENV'] ?? '';
  if (!TEST_LOGIN_SAFE_ENVS.has(nodeEnv)) {
    console.error(
      `[AUTH] WEB_PANEL_TEST_AUTH_TOKEN requires NODE_ENV to be one of ${[...TEST_LOGIN_SAFE_ENVS].join(', ')} (got ${nodeEnv ? `'${nodeEnv}'` : 'unset'}) — refusing to register /auth/test-login`,
    );
    return null;
  }
  if (raw.length < 32) {
    console.error('[AUTH] WEB_PANEL_TEST_AUTH_TOKEN must be >= 32 characters — refusing to register /auth/test-login');
    return null;
  }
  return raw;
}

let _cachedSessionSecret: string | undefined;
function getSessionSecret(): string {
  if (_cachedSessionSecret) return _cachedSessionSecret;
  if (process.env.WEB_MAP_SESSION_SECRET) {
    _cachedSessionSecret = process.env.WEB_MAP_SESSION_SECRET;
  } else {
    console.warn(
      '[AUTH] WEB_MAP_SESSION_SECRET not set — generating random secret (sessions will not survive restarts)',
    );
    _cachedSessionSecret = crypto.randomBytes(32).toString('hex');
  }
  return _cachedSessionSecret;
}

interface AuthConfig {
  clientId: string;
  clientSecret: string;
  guildId: string;
  callbackUrl: string;
  sessionSecret: string;
  allowedRoles: string[];
  survivorRoles: string[];
  modRoles: string[];
  adminRoles: string[];
}

function getAuthConfig(): AuthConfig {
  return {
    clientId: _defaultConfig.clientId ?? '',
    clientSecret: process.env.DISCORD_OAUTH_SECRET || '',
    guildId: _defaultConfig.guildId ?? '',
    callbackUrl: process.env.WEB_MAP_CALLBACK_URL || '',
    sessionSecret: getSessionSecret(),
    allowedRoles: (process.env.WEB_MAP_ALLOWED_ROLES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    survivorRoles: (process.env.WEB_PANEL_SURVIVOR_ROLES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    modRoles: (process.env.WEB_PANEL_MOD_ROLES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    adminRoles: (process.env.WEB_PANEL_ADMIN_ROLES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

// ── Discord API helpers ──────────────────────────────────────────────────────

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string;
  avatar?: string;
}

interface GuildMember {
  roles: string[];
  permissions: string;
}

async function exchangeCode(code: string, authCfg: AuthConfig): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: authCfg.clientId,
    client_secret: authCfg.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: authCfg.callbackUrl,
  });

  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${String(res.status)}): ${text}`);
  }

  return res.json() as Promise<TokenResponse>;
}

async function getUser(accessToken: string): Promise<DiscordUser> {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch user (${String(res.status)})`);
  return res.json() as Promise<DiscordUser>;
}

async function getGuildMember(accessToken: string, guildId: string): Promise<GuildMember | null> {
  const res = await fetch(`${DISCORD_API}/users/@me/guilds/${guildId}/member`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to fetch guild member (${String(res.status)})`);
  return res.json() as Promise<GuildMember>;
}

// ── Tier Resolution ──────────────────────────────────────────────────────────

function resolveTier(member: GuildMember | null, authCfg: AuthConfig): string {
  if (!member) return 'public';

  const memberRoles: string[] = member.roles;
  const permissions = BigInt(member.permissions || '0');
  const isDiscordAdmin = (permissions & 0x8n) !== 0n;

  if (isDiscordAdmin) return 'admin';
  if (authCfg.adminRoles.length > 0 && memberRoles.some((r) => authCfg.adminRoles.includes(r))) {
    return 'admin';
  }

  if (authCfg.modRoles.length > 0 && memberRoles.some((r) => authCfg.modRoles.includes(r))) {
    return 'mod';
  }

  if (authCfg.survivorRoles.length > 0) {
    if (memberRoles.some((r) => authCfg.survivorRoles.includes(r))) return 'survivor';
    return 'public';
  }

  return 'survivor';
}

function isAuthorised(member: GuildMember | null, allowedRoles: string[]): boolean {
  if (!member) return false;
  if (allowedRoles.length > 0) {
    return member.roles.some((roleId: string) => allowedRoles.includes(roleId));
  }
  const permissions = BigInt(member.permissions || '0');
  return (permissions & 0x8n) !== 0n;
}

// ── Middleware & Routes ──────────────────────────────────────────────────────

function isEnabled(): boolean {
  return !!(process.env.DISCORD_OAUTH_SECRET && process.env.WEB_MAP_CALLBACK_URL);
}

function escapeHtml(str: string | undefined): string {
  const lookup: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return (str || 'Unknown error').replace(/[&<>"']/g, (c) => lookup[c] || c);
}

/** log 遮罩：userId/steamId 只留前 6 碼（PII 減量，仍足以關聯排查）。 */
function maskId(s: string | undefined): string {
  if (!s) return '';
  return s.length > 6 ? `${s.slice(0, 6)}…` : s;
}

/** better-sqlite3 constraint 錯誤（user_links PK/UNIQUE 衝突 → 呼叫端轉譯 409）。 */
function isSqliteConstraintError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT');
}

interface DiscordClient {
  guilds?: {
    cache?: {
      get(id: string): DiscordGuild | undefined;
    };
  };
}

interface DiscordGuild {
  members: {
    cache: {
      get(id: string): DiscordGuildMember | undefined;
    };
    fetch(id: string): Promise<DiscordGuildMember | null>;
  };
}

interface DiscordGuildMember {
  roles: {
    cache: { map<T>(fn: (r: { id: string }) => T): T[] };
  };
  permissions: {
    bitfield: bigint;
  };
}

function setupAuth(
  app: Express,
  client: DiscordClient | null,
  opts: { db?: unknown; userLinks?: UserLinksRepository } = {},
): (req: Request, res: Response, next: NextFunction) => void {
  const authCfg = getAuthConfig();
  // Steam↔Discord 綁定 repository（可能未接 DB —— 路由內逐一防呆）
  const userLinks = opts.userLinks;

  if (!authCfg.clientSecret || !authCfg.callbackUrl) {
    // Per-request stub session so route handlers that call req.session.* don't crash.
    app.use((_req: Request, _res: Response, next: NextFunction) => {
      Object.assign(_req, {
        session: {
          user: undefined,
          save(cb: (err: Error | null) => void) {
            cb(null);
          },
          destroy(cb: (err: Error | null) => void) {
            cb(null);
          },
        },
      });
      next();
    });

    console.warn('[AUTH] Discord OAuth not configured — web panel login disabled');
    console.warn('[AUTH] Set DISCORD_OAUTH_SECRET + WEB_MAP_CALLBACK_URL in .env to enable');
    app.get('/auth/me', (_req: Request, res: Response) => {
      res.json({
        authenticated: false,
        tier: 'public',
        tierLevel: TIER['public'],
        oauthNotConfigured: true,
      });
    });
    app.get('/auth/login', (_req: Request, res: Response) => {
      res.redirect('/');
    });
    app.get('/auth/logout', (_req: Request, res: Response) => {
      res.redirect('/');
    });
    return (_req: Request, _res: Response, next: NextFunction) => {
      const hmzReq = _req as HmzRequest;
      hmzReq.tier = 'public';
      hmzReq.tierLevel = TIER['public'];
      next();
    };
  }

  // ── express-session setup ──
  const sessionTtl = _defaultConfig.sessionTtl || 604800;
  const isSecure = authCfg.callbackUrl.startsWith('https');
  const store = createSessionStore(_defaultConfig, opts.db);

  app.use(
    expressSession({
      name: COOKIE_NAME,
      secret: authCfg.sessionSecret,
      store: store || undefined,
      resave: false,
      saveUninitialized: false,
      rolling: false,
      cookie: {
        httpOnly: true,
        secure: isSecure,
        sameSite: 'lax',
        maxAge: sessionTtl * 1000,
        path: '/',
      },
    }),
  );

  // Same-origin enforcement for mutating requests
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      next();
      return;
    }
    if (req.path === '/auth/callback') {
      next();
      return;
    }
    // /auth/test-login is authenticated by the token in the request body,
    // not by session/origin. It must work from CI runners / AI agents whose
    // Origin may not match WEB_MAP_CALLBACK_URL.
    if (req.path === '/auth/test-login') {
      next();
      return;
    }

    const origin = req.get('origin') || req.get('referer');
    if (!origin) {
      next();
      return;
    }

    try {
      const requestOrigin = new URL(origin).origin;
      const appOrigin = new URL(authCfg.callbackUrl).origin;
      if (requestOrigin !== appOrigin) {
        return res.status(403).json({ ok: false, error: 'CSRF_REJECTED', message: 'Cross-origin request blocked' });
      }
    } catch {
      return res.status(403).json({ ok: false, error: 'CSRF_REJECTED', message: 'Invalid origin header' });
    }
    next();
  });

  // CSRF protection
  app.use(cookieParser(authCfg.sessionSecret));
  const csrfSigningSecret = crypto.createHmac('sha256', authCfg.sessionSecret).update('csrf-signing-key').digest('hex');
  const { doubleCsrfProtection } = doubleCsrf({
    getSecret: () => csrfSigningSecret,
    getSessionIdentifier: (req: Request) => {
      const hmzReq = req as HmzRequest;
      return hmzReq.sessionID || hmzReq.session.id || '';
    },
    cookieName: isSecure ? '__Host-hmz.csrf' : 'hmz.csrf',
    cookieOptions: {
      sameSite: 'strict',
      path: '/',
      secure: isSecure,
      httpOnly: true,
    },
    size: 32,
    ignoredMethods: ['GET', 'HEAD', 'OPTIONS'],
    getCsrfTokenFromRequest: (req: Request) => req.headers['x-csrf-token'],
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/auth/callback') {
      next();
      return;
    }
    // /auth/test-login has its own bearer-style auth (token in body) and is
    // only reachable when NODE_ENV is a dev-like value, so a CSRF check is
    // inapplicable and would require a pre-existing session.
    if (req.path === '/auth/test-login') {
      next();
      return;
    }
    doubleCsrfProtection(req, res, next);
  });
  app.use((err: Error & { code?: string }, req: Request, res: Response, next: NextFunction) => {
    if (err.code === 'EBADCSRFTOKEN') {
      console.warn(`[AUTH] CSRF rejected: ${req.method} ${req.originalUrl}`);
      return res.status(403).json({ ok: false, error: 'CSRF_REJECTED', message: 'Invalid or missing CSRF token' });
    }
    next(err);
  });

  console.log(`[AUTH] Discord OAuth enabled — callback: ${authCfg.callbackUrl}`);
  console.log(`[AUTH] Session store: ${_defaultConfig.sessionStore || 'sqlite'}, TTL: ${sessionTtl}s`);
  if (authCfg.adminRoles.length > 0) console.log(`[AUTH] Admin roles: ${authCfg.adminRoles.join(', ')}`);
  if (authCfg.modRoles.length > 0) console.log(`[AUTH] Mod roles: ${authCfg.modRoles.join(', ')}`);
  if (authCfg.survivorRoles.length > 0) console.log(`[AUTH] Survivor roles: ${authCfg.survivorRoles.join(', ')}`);
  else console.log(`[AUTH] No survivor roles set — any guild member gets survivor access`);

  // ── Test login (E2E / AI automation) ──
  // Registered only when WEB_PANEL_TEST_AUTH_TOKEN is set, token length >= 32,
  // and NODE_ENV !== 'production'. Creates a synthetic session bypassing Discord.
  const testAuthToken = getTestAuthToken();
  if (testAuthToken) {
    // Derive the public base from the OAuth callback URL so operators see a
    // ready-to-use template. Token is intentionally NOT printed — logs often
    // get shipped to aggregators / rotated to disk / captured in screenshots,
    // and the token alone grants admin access.
    const baseUrl = new URL(authCfg.callbackUrl).origin;
    console.warn(`[AUTH] Test login enabled — NODE_ENV=${process.env['NODE_ENV'] ?? 'unset'}`);
    console.warn(`[AUTH] Test login endpoint: POST ${baseUrl}/auth/test-login`);
    console.warn(`[AUTH] Body: {"token":"<WEB_PANEL_TEST_AUTH_TOKEN>","tier":"admin"}`);
    console.warn('[AUTH] ⚠ Anyone with the token gets admin access — treat it like a password');
    app.post('/auth/test-login', jsonBodyParser(), (req: Request, res: Response) => {
      const hmzReq = req as HmzRequest;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const provided = body['token'];
      if (typeof provided !== 'string') {
        return res.status(401).json({ ok: false, error: 'MISSING_TOKEN' });
      }
      const expected = Buffer.from(testAuthToken);
      const actual = Buffer.from(provided);
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
        console.warn(`[AUTH] Test login rejected: invalid token (len=${String(actual.length)})`);
        return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
      }
      const requestedTier = body['tier'];
      const tier = typeof requestedTier === 'string' && requestedTier in TIER ? requestedTier : 'admin';

      // 選配 steamId：讓 e2e 能測 /api/me 系列（audit 標記 is_test_session=1）
      const requestedSteamId = body['steamId'];
      if (requestedSteamId !== undefined) {
        if (typeof requestedSteamId !== 'string' || !isValidSteamId64(requestedSteamId)) {
          return res.status(400).json({ ok: false, error: 'INVALID_STEAM_ID' });
        }
        if (!userLinks) {
          return res.status(503).json({ ok: false, error: 'LINKS_UNAVAILABLE' });
        }
        try {
          // e2e 可重跑：清掉 e2e-test 既有綁定 + 重綁 + audit 同一 transaction ——
          // steamId 被他人綁走時整筆 rollback，不留「已刪未綁」半套狀態
          userLinks.replaceLinkWithAudit(
            { discordUserId: 'e2e-test', steamId: requestedSteamId, createdBy: 'e2e-test' },
            {
              action: 'bind',
              discordUserId: 'e2e-test',
              steamId: requestedSteamId,
              actorId: 'e2e-test',
              actorTier: tier,
              isTestSession: true,
              ip: req.ip,
            },
          );
        } catch (err: unknown) {
          if (isSqliteConstraintError(err)) {
            // steamId 已被其他 Discord 帳號綁走
            return res.status(409).json({ ok: false, error: 'STEAM_ALREADY_LINKED' });
          }
          throw err;
        }
      }

      hmzReq.session.user = {
        userId: 'e2e-test',
        username: 'E2E Test User',
        displayName: 'E2E Test',
        avatar: null,
        roles: [],
        tier,
        tierLevel: TIER[tier],
        inGuild: false,
        lastRoleCheck: Date.now(),
        isTestSession: true,
      };
      hmzReq.session.save((err: Error | null) => {
        if (err) console.error('[AUTH] Test session save error:', err.message);
        console.warn(`[AUTH] Test login granted tier=${tier} userId=e2e-test`);
        res.json({ ok: true, tier, userId: 'e2e-test' });
      });
    });
  }

  // ── Auth routes ──
  app.get('/auth/login', (_req: Request, res: Response) => {
    const state = crypto.randomBytes(16).toString('hex');
    res.setHeader('Set-Cookie', `hmz_oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=300`);
    const url =
      `${DISCORD_API}/oauth2/authorize?` +
      new URLSearchParams({
        client_id: authCfg.clientId,
        redirect_uri: authCfg.callbackUrl,
        response_type: 'code',
        scope: OAUTH_SCOPES,
        state,
      }).toString();
    res.redirect(url);
  });

  app.get('/auth/callback', async (req: Request, res: Response) => {
    const hmzReq = req as HmzRequest;
    const { code, state, error, error_description } = req.query;

    if (error) {
      res.setHeader('Set-Cookie', 'hmz_oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      if (error === 'access_denied') {
        res.redirect('/');
        return;
      }
      const safeDesc = escapeHtml(error_description as string | undefined);
      return res.status(400).send(`<h2>Authorization Error</h2><p>${safeDesc}</p><a href="/auth/login">Try again</a>`);
    }
    if (!code) return res.status(400).send('Missing authorization code');

    const cookies = _parseCookies(req.headers.cookie);
    const expectedState = cookies['hmz_oauth_state'];
    if (
      !state ||
      !expectedState ||
      typeof state !== 'string' ||
      typeof expectedState !== 'string' ||
      state.length !== expectedState.length ||
      !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(expectedState))
    ) {
      return res
        .status(403)
        .send('<h2>Invalid OAuth State</h2><p>Please try logging in again.</p><a href="/auth/login">Login</a>');
    }
    res.setHeader('Set-Cookie', 'hmz_oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');

    try {
      const tokenData = await exchangeCode(code as string, authCfg);
      const accessToken = tokenData.access_token;
      const user = await getUser(accessToken);
      const member = await getGuildMember(accessToken, authCfg.guildId);

      const tier = resolveTier(member, authCfg);

      const sessionUser: SessionUser = {
        userId: user.id,
        username: user.username,
        displayName: user.global_name || user.username,
        avatar: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : null,
        roles: member?.roles || [],
        tier,
        tierLevel: TIER[tier],
        inGuild: !!member,
        lastRoleCheck: Date.now(),
      };

      // Session fixation 防護：登入成功先換新 session id，再寫入使用者資料。
      // regenerate() 會把 req.session 換成全新實例 —— 之後必須重新透過
      // hmzReq.session 存取（舊參照已失效）。
      hmzReq.session.regenerate((regenErr: Error | null) => {
        if (regenErr) {
          console.error('[AUTH] Session regenerate error after OAuth:', regenErr.message);
          res
            .status(500)
            .send(
              '<h2>Authentication Error</h2><p>Session error, please try again.</p><a href="/auth/login">Try again</a>',
            );
          return;
        }
        hmzReq.session.user = sessionUser;
        hmzReq.session.save((err: Error | null) => {
          if (err) {
            // save 失敗代表 session 沒落地 —— 照樣 redirect 只會回到未登入
            // 首頁且掩蓋根因，直接回 500 可讀錯誤頁。
            console.error('[AUTH] Session save error after OAuth:', err.message);
            res
              .status(500)
              .send(
                '<h2>Authentication Error</h2><p>Session error, please try again.</p><a href="/auth/login">Try again</a>',
              );
            return;
          }
          res.redirect('/');
        });
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[AUTH] OAuth callback error:', msg);
      const safeMsg = escapeHtml(msg);
      res.status(500).send(`<h2>Authentication Error</h2><p>${safeMsg}</p><a href="/auth/login">Try again</a>`);
    }
  });

  app.get('/auth/logout', (req: Request, res: Response) => {
    const hmzReq = req as HmzRequest;
    hmzReq.session.destroy((err: Error | null) => {
      if (err) console.error('[AUTH] Session destroy error:', err.message);
      const cookieOpts = { httpOnly: true, sameSite: 'lax' as const, secure: isSecure, path: '/' };
      res.clearCookie(COOKIE_NAME, cookieOpts);
      res.clearCookie('hmz_oauth_state', cookieOpts);
      res.redirect('/');
    });
  });

  app.get('/auth/me', (req: Request, res: Response) => {
    const hmzReq = req as HmzRequest;
    const user = hmzReq.session.user;
    if (!user) {
      return res.json({ authenticated: false, tier: 'public', tierLevel: 0, csrfToken: hmzReq.csrfToken?.() });
    }
    // Steam 綁定狀態每請求現查 DB，絕不寫進 session（評審定案）——
    // 否則解綁後 session 內殘留 steamId 會造成幽靈存取。同步查詢微秒級。
    // 選配功能故障不可拖垮核心登入端點：查詢失敗降級 steamLinked:false。
    let steamId: string | undefined;
    try {
      steamId = userLinks ? (userLinks.getByDiscordId(user.userId)?.steam_id as string | undefined) : undefined;
    } catch (err: unknown) {
      console.warn('[AUTH] /auth/me user_links lookup failed:', err instanceof Error ? err.message : String(err));
    }
    res.json({
      authenticated: true,
      userId: user.userId,
      username: user.username,
      displayName: user.displayName,
      avatar: user.avatar,
      tier: user.tier,
      tierLevel: user.tierLevel,
      inGuild: user.inGuild,
      steamLinked: !!steamId,
      ...(steamId ? { steamId } : {}),
      csrfToken: hmzReq.csrfToken?.(),
    });
  });

  app.get('/auth/refresh', async (req: Request, res: Response) => {
    const hmzReq = req as HmzRequest;
    const user = hmzReq.session.user;
    if (!user) {
      return res.json({ authenticated: false, tier: 'public', tierLevel: 0, csrfToken: hmzReq.csrfToken?.() });
    }
    if (client && authCfg.guildId && user.userId) {
      try {
        const guild = client.guilds?.cache?.get(authCfg.guildId);
        if (guild) {
          const member = await guild.members.fetch(user.userId).catch(() => null);
          if (member) {
            const memberData: GuildMember = {
              roles: member.roles.cache.map((r: { id: string }) => r.id),
              permissions: member.permissions.bitfield.toString(),
            };
            const newTier = resolveTier(memberData, authCfg);
            user.tier = newTier;
            user.tierLevel = TIER[newTier];
            user.inGuild = true;
            user.roles = memberData.roles;
          } else {
            user.tier = 'public';
            user.tierLevel = TIER['public'];
            user.inGuild = false;
          }
          user.lastRoleCheck = Date.now();
          hmzReq.session.save((err: Error | null) => {
            if (err) console.error('[AUTH] Session save error after refresh:', err.message);
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[AUTH] Refresh guild check failed:', msg);
      }
    }
    // 與 /auth/me 一致：steamLinked 每請求現查（前端 refresh poll 會用整包
    // 回應覆蓋 S.user，缺欄位會讓綁定列顯示錯誤狀態）；查詢失敗降級 false。
    let refreshSteamId: string | undefined;
    try {
      refreshSteamId = userLinks ? (userLinks.getByDiscordId(user.userId)?.steam_id as string | undefined) : undefined;
    } catch (err: unknown) {
      console.warn('[AUTH] /auth/refresh user_links lookup failed:', err instanceof Error ? err.message : String(err));
    }
    res.json({
      authenticated: true,
      userId: user.userId,
      username: user.username,
      displayName: user.displayName,
      avatar: user.avatar,
      tier: user.tier,
      tierLevel: user.tierLevel,
      inGuild: user.inGuild,
      steamLinked: !!refreshSteamId,
      ...(refreshSteamId ? { steamId: refreshSteamId } : {}),
      csrfToken: hmzReq.csrfToken?.(),
    });
  });

  // ── Steam 帳號綁定（OpenID 2.0） ──
  // 注意：下方 tier middleware 開頭就跳過所有 /auth/* 路徑，requireTier 掛在
  // 這些路由上完全無效 —— 必須在 handler 內自查 req.session.user（比照
  // /auth/refresh 模式）。
  const appOrigin = new URL(authCfg.callbackUrl).origin;

  app.get('/auth/steam/link', rateLimit(60_000, 10), (req: Request, res: Response) => {
    const hmzReq = req as HmzRequest;
    if (!hmzReq.session.user) {
      res.redirect('/auth/login');
      return;
    }
    if (!userLinks) {
      res.status(503).json({ ok: false, error: 'LINKS_UNAVAILABLE' });
      return;
    }
    // 一次性 state：存 session（非 cookie），5 分鐘 TTL，callback 用後即刪
    const state = crypto.randomBytes(32).toString('hex');
    hmzReq.session.steamLinkState = { value: state, expires: Date.now() + STEAM_LINK_STATE_TTL };
    const returnTo = `${appOrigin}/auth/steam/callback?state=${state}`;
    hmzReq.session.save((err: Error | null) => {
      if (err) {
        // state 沒落地就導去 Steam，回跳必 403 且根因被掩蓋 —— 中止並回 500。
        console.error('[AUTH] Session save error before Steam link:', err.message);
        res.status(500).send('<h2>Steam Link Failed</h2><p>Session error, please try again.</p><a href="/">Back</a>');
        return;
      }
      res.redirect(buildRedirectUrl(appOrigin, returnTo));
    });
  });

  app.get('/auth/steam/callback', rateLimit(60_000, 10), async (req: Request, res: Response) => {
    const hmzReq = req as HmzRequest;

    // 使用者在 Steam 頁面按取消 → 比照 Discord access_denied 慣例，靜默回首頁
    if (req.query['openid.mode'] === 'cancel') {
      delete hmzReq.session.steamLinkState;
      res.redirect('/');
      return;
    }

    const user = hmzReq.session.user;
    if (!user) {
      res
        .status(401)
        .send('<h2>Not Signed In</h2><p>Please sign in with Discord first.</p><a href="/auth/login">Login</a>');
      return;
    }

    // state 單次使用：先取出即刪；過期 / 缺失 / 不符一律拒絕
    const stored = hmzReq.session.steamLinkState;
    delete hmzReq.session.steamLinkState;
    const state = req.query['state'];
    // 比對 Buffer byte 長度而非字串長度 —— 多位元組輸入下兩者可能不同，
    // timingSafeEqual 遇長度不等的 Buffer 會拋 RangeError（500 而非 403）
    const stateBuf = typeof state === 'string' ? Buffer.from(state) : null;
    const storedBuf = stored ? Buffer.from(stored.value) : null;
    const stateOk =
      !!stored &&
      !!stateBuf &&
      !!storedBuf &&
      stored.expires > Date.now() &&
      stateBuf.length === storedBuf.length &&
      crypto.timingSafeEqual(stateBuf, storedBuf);
    if (!stateOk) {
      res.status(403).send('<h2>Invalid Link State</h2><p>Please try linking again.</p><a href="/">Back</a>');
      return;
    }

    try {
      const expectedReturnTo = `${appOrigin}/auth/steam/callback?state=${stored.value}`;
      const result = await verifyAssertion(req.query, expectedReturnTo);
      if (!result.ok) {
        // reason 只進 log —— 對外不輸出內部枚舉（避免給攻擊者驗證 oracle）
        console.warn(`[AUTH] Steam link verification failed for ${maskId(user.userId)}: ${result.reason}`);
        if (result.reason === 'network_error' || result.reason === 'check_auth_http_error') {
          // Steam 端暫時不可用 —— 非使用者問題，指引稍後重新發起綁定
          res
            .status(503)
            .send(
              '<h2>Steam Link Failed</h2><p>Steam is temporarily unreachable. Please try linking again later.</p><a href="/">Back</a>',
            );
          return;
        }
        res
          .status(400)
          .send('<h2>Steam Link Failed</h2><p>Verification failed, please try again.</p><a href="/">Back</a>');
        return;
      }
      if (!userLinks) {
        res.status(503).send('<h2>Steam Link Failed</h2><p>Link storage unavailable.</p><a href="/">Back</a>');
        return;
      }
      try {
        // 純 INSERT + audit 同 transaction —— 兩側任一已綁爆 constraint 轉譯
        // 409；audit 寫入失敗則整筆 rollback（不留無稽核的綁定）。
        userLinks.bindWithAudit(
          { discordUserId: user.userId, steamId: result.steamId, createdBy: user.userId },
          {
            action: 'bind',
            discordUserId: user.userId,
            steamId: result.steamId,
            actorId: user.userId,
            actorTier: user.tier,
            isTestSession: user.isTestSession,
            reason: 'self_service',
            ip: req.ip,
          },
        );
      } catch (err: unknown) {
        if (isSqliteConstraintError(err)) {
          console.warn(`[AUTH] Steam link conflict: discord=${maskId(user.userId)} steam=${maskId(result.steamId)}`);
          res
            .status(409)
            .send(
              '<h2>Already Linked</h2><p>This Discord account or Steam account already has a link. Unlink it first, or contact an admin.</p><a href="/">Back</a>',
            );
          return;
        }
        throw err;
      }
      console.log(`[AUTH] Steam linked: discord=${maskId(user.userId)} steam=${maskId(result.steamId)}`);
      res.redirect('/');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[AUTH] Steam link callback error:', msg);
      res.status(500).send('<h2>Steam Link Failed</h2><p>Internal error.</p><a href="/">Back</a>');
    }
  });

  // POST 的 CSRF 已由全域 double-submit middleware 涵蓋（/auth/steam/* 不在跳過清單）
  app.post('/auth/steam/unlink', (req: Request, res: Response) => {
    const hmzReq = req as HmzRequest;
    const user = hmzReq.session.user;
    if (!user) {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
      return;
    }
    if (!userLinks) {
      res.status(503).json({ ok: false, error: 'LINKS_UNAVAILABLE' });
      return;
    }
    // delete + audit 同 transaction；steamId 由 repo 在同一 tx 內讀取（防 TOCTOU）
    const removedSteamId = userLinks.unbindWithAudit(user.userId, {
      action: 'unbind',
      discordUserId: user.userId,
      actorId: user.userId,
      actorTier: user.tier,
      isTestSession: user.isTestSession,
      reason: 'self_service',
      ip: req.ip,
    });
    if (removedSteamId) {
      console.log(`[AUTH] Steam unlinked: discord=${maskId(user.userId)} steam=${maskId(removedSteamId)}`);
    }
    res.json({ ok: true, unlinked: removedSteamId !== null });
  });

  // ── Tier-aware middleware ──
  return (req: Request, _res: Response, next: NextFunction) => {
    if (req.path.startsWith('/auth/')) {
      next();
      return;
    }

    const hmzReq = req as HmzRequest;
    const user = hmzReq.session.user;
    if (user) {
      if (client && authCfg.guildId && user.userId && Date.now() - (user.lastRoleCheck || 0) > ROLE_REFRESH_INTERVAL) {
        const guild = client.guilds?.cache?.get(authCfg.guildId);
        const member = guild?.members.cache.get(user.userId);
        if (member) {
          const memberData: GuildMember = {
            roles: member.roles.cache.map((r: { id: string }) => r.id),
            permissions: member.permissions.bitfield.toString(),
          };
          const newTier = resolveTier(memberData, authCfg);
          if (newTier !== user.tier) {
            console.log(`[AUTH] Role change detected for ${user.username}: ${user.tier} → ${newTier}`);
          }
          user.tier = newTier;
          user.tierLevel = TIER[newTier];
          user.roles = memberData.roles;
        } else if (guild) {
          user.tier = 'public';
          user.tierLevel = TIER['public'];
          user.inGuild = false;
        }
        user.lastRoleCheck = Date.now();
        hmzReq.session.save((err: Error | null) => {
          if (err) console.error('[AUTH] Session save error after role check:', err.message);
        });
      }
      hmzReq.tier = user.tier;
      hmzReq.tierLevel = user.tierLevel;
    } else {
      hmzReq.tier = 'public';
      hmzReq.tierLevel = TIER['public'];
    }
    next();
  };
}

function requireTier(minTier: string): (req: Request, res: Response, next: NextFunction) => void {
  const minLevel = TIER[minTier] || 0;
  return (req: Request, res: Response, next: NextFunction) => {
    const hmzReq = req as HmzRequest;
    const level = hmzReq.tierLevel || 0;
    if (level >= minLevel) {
      next();
      return;
    }

    if (hmzReq.tier === 'public') {
      if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Authentication required', login: '/auth/login' });
      }
      res.redirect('/auth/login');
      return;
    }

    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ error: `Requires ${minTier} access or higher` });
    }
    return res
      .status(403)
      .send(`<h2>Access Denied</h2><p>You need <strong>${minTier}</strong> access or higher.</p><a href="/">Back</a>`);
  };
}

// ── Internal: cookie parsing ──────────────────────────────────────────────

function _parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name) cookies[name.trim()] = rest.join('=').trim();
  }
  return cookies;
}

export { setupAuth, requireTier, isEnabled, isAuthorised, resolveTier, TIER };
export type { HmzRequest, SessionUser, DiscordClient };

// Exported for testing
const _test = { getSessionSecret, _parseCookies, getAuthConfig, getTestAuthToken };
export { _test };
