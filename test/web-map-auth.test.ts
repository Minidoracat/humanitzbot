import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const cjsRequire = createRequire(__filename);

// Stub config before requiring auth module

import * as _auth from '../src/web-map/auth.js';
const { isAuthorised, isEnabled, resolveTier, requireTier, TIER, _test } = _auth as any;
const { _parseCookies, getSessionSecret } = _test;

describe('Web Map Auth', () => {
  // ── isEnabled ──────────────────────────────────────────────

  describe('isEnabled()', () => {
    it('returns false when env vars are not set', () => {
      delete process.env.DISCORD_OAUTH_SECRET;
      delete process.env.WEB_MAP_CALLBACK_URL;
      assert.equal(isEnabled(), false);
    });

    it('returns false when only secret is set', () => {
      process.env.DISCORD_OAUTH_SECRET = 'test-secret';
      delete process.env.WEB_MAP_CALLBACK_URL;
      assert.equal(isEnabled(), false);
      delete process.env.DISCORD_OAUTH_SECRET;
    });

    it('returns false when only callback is set', () => {
      delete process.env.DISCORD_OAUTH_SECRET;
      process.env.WEB_MAP_CALLBACK_URL = 'http://localhost:3000/auth/callback';
      assert.equal(isEnabled(), false);
      delete process.env.WEB_MAP_CALLBACK_URL;
    });

    it('returns true when both are set', () => {
      process.env.DISCORD_OAUTH_SECRET = 'test-secret';
      process.env.WEB_MAP_CALLBACK_URL = 'http://localhost:3000/auth/callback';
      assert.equal(isEnabled(), true);
      delete process.env.DISCORD_OAUTH_SECRET;
      delete process.env.WEB_MAP_CALLBACK_URL;
    });
  });

  // ── Cookie parsing ─────────────────────────────────────────

  describe('_parseCookies', () => {
    it('parses a single cookie', () => {
      const result = _parseCookies('hmz_session=abc123.sig');
      assert.deepEqual(result, { hmz_session: 'abc123.sig' });
    });

    it('parses multiple cookies', () => {
      const result = _parseCookies('a=1; b=2; c=3');
      assert.deepEqual(result, { a: '1', b: '2', c: '3' });
    });

    it('handles cookies with = in value', () => {
      const result = _parseCookies('token=abc=def=ghi');
      assert.deepEqual(result, { token: 'abc=def=ghi' });
    });

    it('returns empty object for null/undefined', () => {
      assert.deepEqual(_parseCookies(null), {});
      assert.deepEqual(_parseCookies(undefined), {});
      assert.deepEqual(_parseCookies(''), {});
    });

    it('trims whitespace', () => {
      const result = _parseCookies('  a = 1 ;  b = 2  ');
      assert.deepEqual(result, { a: '1', b: '2' });
    });
  });

  // ── isAuthorised ───────────────────────────────────────────

  describe('isAuthorised', () => {
    it('returns false for null member', () => {
      assert.equal(isAuthorised(null, []), false);
    });

    it('returns false for undefined member', () => {
      assert.equal(isAuthorised(undefined, ['123']), false);
    });

    describe('with allowed roles configured', () => {
      const allowedRoles = ['111', '222', '333'];

      it('returns true when member has one of the allowed roles', () => {
        const member = { roles: ['999', '222', '444'], permissions: '0' };
        assert.equal(isAuthorised(member, allowedRoles), true);
      });

      it('returns false when member has none of the allowed roles', () => {
        const member = { roles: ['999', '888'], permissions: '0' };
        assert.equal(isAuthorised(member, allowedRoles), false);
      });

      it('returns true even without admin permission if role matches', () => {
        const member = { roles: ['111'], permissions: '0' };
        assert.equal(isAuthorised(member, allowedRoles), true);
      });
    });

    describe('without allowed roles (admin-only mode)', () => {
      const noRoles: string[] = [];

      it('returns true for member with Administrator permission (0x8)', () => {
        // Administrator = 0x8 = 8
        const member = { roles: [], permissions: '8' };
        assert.equal(isAuthorised(member, noRoles), true);
      });

      it('returns true when admin bit is part of larger permission set', () => {
        // Some combination including 0x8
        const member = { roles: [], permissions: '2147483656' }; // includes 0x8
        assert.equal(isAuthorised(member, noRoles), true);
      });

      it('returns false for member without Administrator permission', () => {
        // ManageMessages = 0x2000, no admin
        const member = { roles: [], permissions: '8192' };
        assert.equal(isAuthorised(member, noRoles), false);
      });

      it('returns false for member with permissions = 0', () => {
        const member = { roles: [], permissions: '0' };
        assert.equal(isAuthorised(member, noRoles), false);
      });

      it('handles missing permissions field', () => {
        const member = { roles: [] };
        assert.equal(isAuthorised(member, noRoles), false);
      });
    });
  });

  // ── resolveTier ────────────────────────────────────────────

  describe('resolveTier', () => {
    const authCfg = {
      adminRoles: ['admin-role'],
      modRoles: ['mod-role'],
      survivorRoles: ['survivor-role'],
    };

    it('returns public for null member', () => {
      assert.equal(resolveTier(null, authCfg), 'public');
    });

    it('returns admin for Discord Administrator permission', () => {
      const member = { roles: [], permissions: '8' };
      assert.equal(resolveTier(member, authCfg), 'admin');
    });

    it('returns admin for admin role', () => {
      const member = { roles: ['admin-role'], permissions: '0' };
      assert.equal(resolveTier(member, authCfg), 'admin');
    });

    it('returns mod for mod role', () => {
      const member = { roles: ['mod-role'], permissions: '0' };
      assert.equal(resolveTier(member, authCfg), 'mod');
    });

    it('returns survivor for survivor role', () => {
      const member = { roles: ['survivor-role'], permissions: '0' };
      assert.equal(resolveTier(member, authCfg), 'survivor');
    });

    it('returns public for member without qualifying roles', () => {
      const member = { roles: ['random-role'], permissions: '0' };
      assert.equal(resolveTier(member, authCfg), 'public');
    });

    it('returns survivor for any guild member when no survivorRoles configured', () => {
      const noSurvivorCfg = { adminRoles: [], modRoles: [], survivorRoles: [] };
      const member = { roles: ['random-role'], permissions: '0' };
      assert.equal(resolveTier(member, noSurvivorCfg), 'survivor');
    });
  });

  // ── TIER ───────────────────────────────────────────────────

  describe('TIER', () => {
    it('has correct tier levels', () => {
      assert.equal(TIER.public, 0);
      assert.equal(TIER.survivor, 1);
      assert.equal(TIER.mod, 2);
      assert.equal(TIER.admin, 3);
    });
  });

  // ── setupAuth ──────────────────────────────────────────────

  describe('setupAuth', () => {
    it('disabled mode: sets public tier when OAuth is not configured', () => {
      delete process.env.DISCORD_OAUTH_SECRET;
      delete process.env.WEB_MAP_CALLBACK_URL;
      delete process.env.WEB_PANEL_ALLOW_NO_AUTH;

      const { setupAuth: setup } = _auth as any;

      const routes: Record<string, unknown> = {};
      const app = {
        get: (path: string, handler: unknown) => {
          routes[`GET ${path}`] = handler;
        },
        post: (path: string, handler: unknown) => {
          routes[`POST ${path}`] = handler;
        },
        use: () => {},
      };

      const middleware = setup(app);
      assert.equal(typeof middleware, 'function');

      // Middleware should set public tier
      const req: Record<string, unknown> = {};
      let nextCalled = false;
      middleware(req, {}, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true);
      assert.equal(req.tier, 'public');
      assert.equal(req.tierLevel, 0);

      // /auth/me should return authenticated: false + oauthNotConfigured
      let meResponse: Record<string, unknown> = {};
      const meHandler = routes['GET /auth/me'] as (req: unknown, res: unknown) => void;
      meHandler(
        {},
        {
          json: (data: Record<string, unknown>) => {
            meResponse = data;
          },
        },
      );
      assert.equal(meResponse.authenticated, false);
      assert.equal(meResponse.tier, 'public');
      assert.equal(meResponse.oauthNotConfigured, true);

      // Auth routes should still be registered
      assert.equal(typeof routes['GET /auth/login'], 'function');
    });

    it('dev mode: sets admin tier when WEB_PANEL_ALLOW_NO_AUTH=true', () => {
      delete process.env.DISCORD_OAUTH_SECRET;
      delete process.env.WEB_MAP_CALLBACK_URL;
      process.env.WEB_PANEL_ALLOW_NO_AUTH = 'true';

      try {
        const { setupAuth: setup } = _auth as any;

        const routes: Record<string, unknown> = {};
        const useHandlers: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
        const app = {
          get: (path: string, handler: unknown) => {
            routes[`GET ${path}`] = handler;
          },
          post: (path: string, handler: unknown) => {
            routes[`POST ${path}`] = handler;
          },
          use: (mw: (req: unknown, res: unknown, next: () => void) => void) => {
            useHandlers.push(mw);
          },
        };

        const middleware = setup(app);
        assert.equal(typeof middleware, 'function');

        // Middleware should set admin tier
        const req: Record<string, unknown> = {};
        let nextCalled = false;
        middleware(req, {}, () => {
          nextCalled = true;
        });
        assert.equal(nextCalled, true);
        assert.equal(req.tier, 'admin');
        assert.equal(req.tierLevel, 3);

        // Run the stub-session middleware and cross-check that /auth/me agrees
        // with the injected session.user — so a future drift between the two
        // (e.g. username changed in one place but not the other) fails loudly.
        const stubSession = useHandlers[0];
        assert.ok(stubSession, 'stub session middleware should be registered');
        const sessionReq: Record<string, unknown> = {};
        stubSession(sessionReq, {}, () => {});
        const sessionUser = (sessionReq.session as Record<string, unknown>).user as Record<string, unknown>;

        let meResponse: Record<string, unknown> = {};
        const meHandler = routes['GET /auth/me'] as (req: unknown, res: unknown) => void;
        meHandler(
          {},
          {
            json: (data: Record<string, unknown>) => {
              meResponse = data;
            },
          },
        );
        assert.equal(meResponse.authenticated, true);
        assert.equal(meResponse.devMode, true);
        assert.equal(meResponse.tier, sessionUser.tier);
        assert.equal(meResponse.tierLevel, sessionUser.tierLevel);
        assert.equal(meResponse.username, sessionUser.username);
      } finally {
        delete process.env.WEB_PANEL_ALLOW_NO_AUTH;
      }
    });

    it('strict check: WEB_PANEL_ALLOW_NO_AUTH=false does not enable dev mode', () => {
      delete process.env.DISCORD_OAUTH_SECRET;
      delete process.env.WEB_MAP_CALLBACK_URL;
      process.env.WEB_PANEL_ALLOW_NO_AUTH = 'false';

      try {
        const { setupAuth: setup } = _auth as any;

        const routes: Record<string, unknown> = {};
        const app = {
          get: (path: string, handler: unknown) => {
            routes[`GET ${path}`] = handler;
          },
          post: (path: string, handler: unknown) => {
            routes[`POST ${path}`] = handler;
          },
          use: () => {},
        };

        const middleware = setup(app);

        // Should be public, not admin
        const req: Record<string, unknown> = {};
        middleware(req, {}, () => {});
        assert.equal(req.tier, 'public');
        assert.equal(req.tierLevel, 0);
      } finally {
        delete process.env.WEB_PANEL_ALLOW_NO_AUTH;
      }
    });

    // ── Strict flag: only the literal string "true" activates dev mode ──

    for (const badValue of ['TRUE', 'True', '1', 'yes', 'on']) {
      it(`strict check: WEB_PANEL_ALLOW_NO_AUTH=${JSON.stringify(badValue)} does not enable dev mode`, () => {
        delete process.env.DISCORD_OAUTH_SECRET;
        delete process.env.WEB_MAP_CALLBACK_URL;
        process.env.WEB_PANEL_ALLOW_NO_AUTH = badValue;

        try {
          const { setupAuth: setup } = _auth as any;
          const app = { get: () => {}, post: () => {}, use: () => {} };
          const middleware = setup(app);
          const req: Record<string, unknown> = {};
          middleware(req, {}, () => {});
          assert.equal(req.tier, 'public');
          assert.equal(req.tierLevel, 0);
        } finally {
          delete process.env.WEB_PANEL_ALLOW_NO_AUTH;
        }
      });
    }

    // ── Partial OAuth config: both secret and callback URL must be set ──

    it('partial OAuth: only DISCORD_OAUTH_SECRET set → disabled mode', () => {
      process.env.DISCORD_OAUTH_SECRET = 'test-secret';
      delete process.env.WEB_MAP_CALLBACK_URL;
      delete process.env.WEB_PANEL_ALLOW_NO_AUTH;

      try {
        const { setupAuth: setup } = _auth as any;

        const routes: Record<string, unknown> = {};
        const app = {
          get: (path: string, handler: unknown) => {
            routes[`GET ${path}`] = handler;
          },
          post: () => {},
          use: () => {},
        };

        const middleware = setup(app);
        const req: Record<string, unknown> = {};
        middleware(req, {}, () => {});
        assert.equal(req.tier, 'public');
        assert.equal(req.tierLevel, 0);

        let meResponse: Record<string, unknown> = {};
        const meHandler = routes['GET /auth/me'] as (req: unknown, res: unknown) => void;
        meHandler(
          {},
          {
            json: (data: Record<string, unknown>) => {
              meResponse = data;
            },
          },
        );
        assert.equal(meResponse.authenticated, false);
        assert.equal(meResponse.oauthNotConfigured, true);
      } finally {
        delete process.env.DISCORD_OAUTH_SECRET;
      }
    });

    it('partial OAuth: only WEB_MAP_CALLBACK_URL set → disabled mode', () => {
      delete process.env.DISCORD_OAUTH_SECRET;
      process.env.WEB_MAP_CALLBACK_URL = 'http://localhost:3000/auth/callback';
      delete process.env.WEB_PANEL_ALLOW_NO_AUTH;

      try {
        const { setupAuth: setup } = _auth as any;

        const routes: Record<string, unknown> = {};
        const app = {
          get: (path: string, handler: unknown) => {
            routes[`GET ${path}`] = handler;
          },
          post: () => {},
          use: () => {},
        };

        const middleware = setup(app);
        const req: Record<string, unknown> = {};
        middleware(req, {}, () => {});
        assert.equal(req.tier, 'public');

        let meResponse: Record<string, unknown> = {};
        const meHandler = routes['GET /auth/me'] as (req: unknown, res: unknown) => void;
        meHandler(
          {},
          {
            json: (data: Record<string, unknown>) => {
              meResponse = data;
            },
          },
        );
        assert.equal(meResponse.authenticated, false);
        assert.equal(meResponse.oauthNotConfigured, true);
      } finally {
        delete process.env.WEB_MAP_CALLBACK_URL;
      }
    });

    // ── Stub session middleware ──

    type StubMiddleware = (req: unknown, res: unknown, next: () => void) => void;

    it('disabled mode: stub session middleware injects empty session with working save/destroy', () => {
      delete process.env.DISCORD_OAUTH_SECRET;
      delete process.env.WEB_MAP_CALLBACK_URL;
      delete process.env.WEB_PANEL_ALLOW_NO_AUTH;

      const { setupAuth: setup } = _auth as any;

      const middlewares: StubMiddleware[] = [];
      const app = {
        get: () => {},
        post: () => {},
        use: (mw: StubMiddleware) => {
          middlewares.push(mw);
        },
      };

      setup(app);
      const stubSession = middlewares[0];
      assert.ok(stubSession, 'stub session middleware should be registered');

      const req: Record<string, unknown> = {};
      let nextCalled = false;
      stubSession(req, {}, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true);

      const session = req.session as Record<string, unknown>;
      assert.ok(session, 'req.session should be injected');
      assert.equal(session.user, undefined, 'disabled mode leaves user undefined');
      assert.equal(session.username, undefined);
      assert.equal(session.discordId, undefined);
      assert.equal(typeof session.save, 'function');
      assert.equal(typeof session.destroy, 'function');

      let saveErr: unknown = 'unset';
      (session.save as (cb: (err: Error | null) => void) => void)((err) => {
        saveErr = err;
      });
      assert.equal(saveErr, null, 'stub save() invokes callback with null');

      let destroyErr: unknown = 'unset';
      (session.destroy as (cb: (err: Error | null) => void) => void)((err) => {
        destroyErr = err;
      });
      assert.equal(destroyErr, null, 'stub destroy() invokes callback with null');
    });

    it('dev mode: stub session middleware populates Developer user with full SessionUser fields', () => {
      delete process.env.DISCORD_OAUTH_SECRET;
      delete process.env.WEB_MAP_CALLBACK_URL;
      process.env.WEB_PANEL_ALLOW_NO_AUTH = 'true';

      try {
        const { setupAuth: setup } = _auth as any;

        const middlewares: StubMiddleware[] = [];
        const app = {
          get: () => {},
          post: () => {},
          use: (mw: StubMiddleware) => {
            middlewares.push(mw);
          },
        };

        setup(app);
        const stubSession = middlewares[0];
        assert.ok(stubSession, 'stub session middleware should be registered');

        const before = Date.now();
        const req: Record<string, unknown> = {};
        stubSession(req, {}, () => {});

        const session = req.session as Record<string, unknown>;
        assert.ok(session, 'req.session should be injected');
        assert.equal(session.username, 'Developer');
        assert.equal(session.discordId, 'dev');

        const user = session.user as Record<string, unknown>;
        assert.ok(user, 'dev mode populates session.user');
        assert.equal(user.userId, 'dev');
        assert.equal(user.username, 'Developer');
        assert.equal(user.displayName, 'Developer');
        assert.equal(user.avatar, null);
        assert.deepEqual(user.roles, []);
        assert.equal(user.tier, 'admin');
        assert.equal(user.tierLevel, TIER.admin);
        assert.equal(user.inGuild, true);
        assert.equal(typeof user.lastRoleCheck, 'number');
        assert.ok((user.lastRoleCheck as number) >= before, 'lastRoleCheck should be a recent timestamp');
      } finally {
        delete process.env.WEB_PANEL_ALLOW_NO_AUTH;
      }
    });

    // ── Integration: setupAuth middleware + requireTier ──

    it('dev mode: tier injected by middleware passes requireTier("admin")', () => {
      delete process.env.DISCORD_OAUTH_SECRET;
      delete process.env.WEB_MAP_CALLBACK_URL;
      process.env.WEB_PANEL_ALLOW_NO_AUTH = 'true';

      try {
        const { setupAuth: setup, requireTier: rt } = _auth as any;
        const app = { get: () => {}, post: () => {}, use: () => {} };
        const middleware = setup(app);

        const req: Record<string, unknown> = { path: '/api/admin/settings' };
        middleware(req, {}, () => {});

        const guard = rt('admin');
        let nextCalled = false;
        guard(
          req,
          {
            status: () => ({ json: () => {} }),
            redirect: () => {},
            send: () => {},
          },
          () => {
            nextCalled = true;
          },
        );
        assert.equal(nextCalled, true, 'dev-injected admin tier should pass admin guard');
      } finally {
        delete process.env.WEB_PANEL_ALLOW_NO_AUTH;
      }
    });

    it('landingOnly mode: tier injected by middleware is blocked by requireTier("survivor") on API', () => {
      delete process.env.DISCORD_OAUTH_SECRET;
      delete process.env.WEB_MAP_CALLBACK_URL;
      delete process.env.WEB_PANEL_ALLOW_NO_AUTH;

      const { setupAuth: setup, requireTier: rt } = _auth as any;
      const app = { get: () => {}, post: () => {}, use: () => {} };
      const middleware = setup(app);

      const req: Record<string, unknown> = { path: '/api/players' };
      middleware(req, {}, () => {});

      const guard = rt('survivor');
      let statusCode: number | null = null;
      let jsonBody: unknown = null;
      const res = {
        status: (c: number) => {
          statusCode = c;
          return res;
        },
        json: (body: unknown) => {
          jsonBody = body;
        },
        redirect: () => {},
        send: () => {},
      };
      guard(req, res, () => {});
      assert.equal(statusCode, 401, 'public tier should be blocked from survivor API');
      assert.ok((jsonBody as Record<string, unknown>).error, 'response should carry an error message');
    });

    // ── /auth/login and /auth/logout redirect behaviour in no-OAuth modes ──

    it('disabled mode: /auth/login and /auth/logout redirect to /', () => {
      delete process.env.DISCORD_OAUTH_SECRET;
      delete process.env.WEB_MAP_CALLBACK_URL;
      delete process.env.WEB_PANEL_ALLOW_NO_AUTH;

      const { setupAuth: setup } = _auth as any;
      const routes: Record<string, unknown> = {};
      const app = {
        get: (path: string, handler: unknown) => {
          routes[`GET ${path}`] = handler;
        },
        post: () => {},
        use: () => {},
      };
      setup(app);

      let loginRedirect: string | null = null;
      (routes['GET /auth/login'] as (req: unknown, res: unknown) => void)(
        {},
        {
          redirect: (t: string) => {
            loginRedirect = t;
          },
        },
      );
      assert.equal(loginRedirect, '/');

      let logoutRedirect: string | null = null;
      (routes['GET /auth/logout'] as (req: unknown, res: unknown) => void)(
        {},
        {
          redirect: (t: string) => {
            logoutRedirect = t;
          },
        },
      );
      assert.equal(logoutRedirect, '/');
    });

    it('dev mode: /auth/login and /auth/logout redirect to /', () => {
      delete process.env.DISCORD_OAUTH_SECRET;
      delete process.env.WEB_MAP_CALLBACK_URL;
      process.env.WEB_PANEL_ALLOW_NO_AUTH = 'true';

      try {
        const { setupAuth: setup } = _auth as any;
        const routes: Record<string, unknown> = {};
        const app = {
          get: (path: string, handler: unknown) => {
            routes[`GET ${path}`] = handler;
          },
          post: () => {},
          use: () => {},
        };
        setup(app);

        let loginRedirect: string | null = null;
        (routes['GET /auth/login'] as (req: unknown, res: unknown) => void)(
          {},
          {
            redirect: (t: string) => {
              loginRedirect = t;
            },
          },
        );
        assert.equal(loginRedirect, '/');

        let logoutRedirect: string | null = null;
        (routes['GET /auth/logout'] as (req: unknown, res: unknown) => void)(
          {},
          {
            redirect: (t: string) => {
              logoutRedirect = t;
            },
          },
        );
        assert.equal(logoutRedirect, '/');
      } finally {
        delete process.env.WEB_PANEL_ALLOW_NO_AUTH;
      }
    });

    it('registers auth routes when OAuth is configured', () => {
      process.env.DISCORD_OAUTH_SECRET = 'test-secret';
      process.env.WEB_MAP_CALLBACK_URL = 'http://localhost:3000/auth/callback';

      const { setupAuth: setup } = cjsRequire('../src/web-map/auth');

      const routes: Record<string, unknown> = {};
      const middlewares: unknown[] = [];
      const app = {
        get: (path: string, handler: unknown) => {
          routes[`GET ${path}`] = handler;
        },
        post: (path: string, handler: unknown) => {
          routes[`POST ${path}`] = handler;
        },
        use: (mw: unknown) => {
          middlewares.push(mw);
        },
      };

      const middleware = setup(app);
      assert.equal(typeof middleware, 'function');

      // Auth routes should be registered
      assert.ok(routes['GET /auth/login']);
      assert.ok(routes['GET /auth/callback']);
      assert.ok(routes['GET /auth/logout']);
      assert.ok(routes['GET /auth/me']);

      // express-session middleware should be registered via app.use
      assert.ok(middlewares.length > 0, 'express-session middleware should be registered');

      delete process.env.DISCORD_OAUTH_SECRET;
      delete process.env.WEB_MAP_CALLBACK_URL;
    });

    it('auth middleware skips /auth/ paths', () => {
      process.env.DISCORD_OAUTH_SECRET = 'test-secret';
      process.env.WEB_MAP_CALLBACK_URL = 'http://localhost:3000/auth/callback';

      const { setupAuth: setup } = cjsRequire('../src/web-map/auth');
      const app = {
        get: () => {},
        post: () => {},
        use: () => {},
      };

      const middleware = setup(app);

      let nextCalled = false;
      middleware({ path: '/auth/login', headers: {} }, {}, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true);

      delete process.env.DISCORD_OAUTH_SECRET;
      delete process.env.WEB_MAP_CALLBACK_URL;
    });

    it('auth middleware sets public tier for unauthenticated requests and calls next()', () => {
      process.env.DISCORD_OAUTH_SECRET = 'test-secret';
      process.env.WEB_MAP_CALLBACK_URL = 'http://localhost:3000/auth/callback';

      const { setupAuth: setup } = cjsRequire('../src/web-map/auth');
      const app = {
        get: () => {},
        post: () => {},
        use: () => {},
      };

      const middleware = setup(app);

      let nextCalled = false;
      // req.session is set by express-session middleware (not present here → public tier)
      const req: Record<string, unknown> = { path: '/api/players', headers: {}, session: {} };
      const res = {
        status: () => res,
        json: () => {},
        redirect: () => {},
      };

      middleware(req, res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true);
      assert.equal(req.tier, 'public');
      assert.equal(req.tierLevel, 0);

      delete process.env.DISCORD_OAUTH_SECRET;
      delete process.env.WEB_MAP_CALLBACK_URL;
    });

    it('auth middleware reads tier from req.session.user', () => {
      process.env.DISCORD_OAUTH_SECRET = 'test-secret';
      process.env.WEB_MAP_CALLBACK_URL = 'http://localhost:3000/auth/callback';

      const { setupAuth: setup } = cjsRequire('../src/web-map/auth');
      const app = {
        get: () => {},
        post: () => {},
        use: () => {},
      };

      const middleware = setup(app);

      let nextCalled = false;
      const req: Record<string, unknown> = {
        path: '/api/players',
        headers: {},
        session: {
          user: {
            userId: 'user123',
            username: 'TestUser',
            tier: 'survivor',
            tierLevel: TIER.survivor,
            lastRoleCheck: Date.now(),
          },
          save: () => {},
        },
      };

      middleware(req, {}, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true);
      assert.equal(req.tier, 'survivor');
      assert.equal(req.tierLevel, TIER.survivor);

      delete process.env.DISCORD_OAUTH_SECRET;
      delete process.env.WEB_MAP_CALLBACK_URL;
    });

    it('requireTier blocks unauthenticated API requests with 401', () => {
      const { requireTier: rt } = cjsRequire('../src/web-map/auth');
      const guard = rt('survivor');

      let statusCode: number | null = null;
      let jsonBody: unknown = null;
      const req = { path: '/api/players', tier: 'public', tierLevel: 0 };
      const res = {
        status: (code: number) => {
          statusCode = code;
          return res;
        },
        json: (body: unknown) => {
          jsonBody = body;
        },
        redirect: () => {},
      };

      guard(req, res, () => {});
      assert.equal(statusCode, 401);
      assert.ok((jsonBody as Record<string, unknown>).error);
    });

    it('middleware re-checks roles from guild cache when lastRoleCheck is stale', () => {
      process.env.DISCORD_OAUTH_SECRET = 'test-secret';
      process.env.WEB_MAP_CALLBACK_URL = 'http://localhost:3000/auth/callback';

      // Set guildId on the config singleton directly — env vars are only read at
      // module load time so process.env.DISCORD_GUILD_ID has no effect here.
      const config = cjsRequire('../src/config/index').default;
      const savedGuildId = config.guildId;
      config.guildId = '987654321';

      try {
        const { setupAuth: setup, TIER: T } = cjsRequire('../src/web-map/auth');

        // Build a mock bot client with a guild member cache
        const mockMember = {
          roles: { cache: { map: () => ['111'] } },
          permissions: { bitfield: 0n },
        };

        const mockGuild = {
          members: { cache: { get: () => mockMember } },
        };
        const mockClient = {
          guilds: { cache: { get: (id: string) => (id === '987654321' ? mockGuild : null) } },
        };

        const app = {
          get: () => {},
          post: () => {},
          use: () => {},
        };

        const middleware = setup(app, mockClient);

        // Mock session with stale lastRoleCheck (admin tier, but mock member has no admin role/permission)
        let saveCalled = false;
        const req: Record<string, unknown> = {
          path: '/api/players',
          headers: {},
          session: {
            user: {
              userId: 'user123',
              username: 'TestUser',
              displayName: 'Test',
              avatar: null,
              roles: ['999'], // old admin role
              tier: 'admin',
              tierLevel: T.admin,
              inGuild: true,
              lastRoleCheck: 0, // way in the past → triggers refresh
            },
            save: (cb: ((err: null) => void) | undefined) => {
              saveCalled = true;
              if (cb) cb(null);
            },
          },
        };

        let nextCalled = false;
        middleware(req, {}, () => {
          nextCalled = true;
        });
        assert.equal(nextCalled, true);

        // The mock member has no admin role/permission → tier should downgrade
        const user = (req.session as Record<string, unknown>).user as Record<string, unknown>;
        assert.notEqual(user.tier, 'admin', 'Tier should have been downgraded from admin');
        assert.ok((user.lastRoleCheck as number) > 0, 'lastRoleCheck should be updated');
        assert.ok(saveCalled, 'session.save() should be called after role mutation');
      } finally {
        delete process.env.DISCORD_OAUTH_SECRET;
        delete process.env.WEB_MAP_CALLBACK_URL;
        config.guildId = savedGuildId;
      }
    });
  });

  // ── getSessionSecret ───────────────────────────────────────

  describe('getSessionSecret', () => {
    it('returns a string', () => {
      const secret = getSessionSecret();
      assert.equal(typeof secret, 'string');
      assert.ok(secret.length > 0);
    });

    it('returns the same value on subsequent calls', () => {
      const s1 = getSessionSecret();
      const s2 = getSessionSecret();
      assert.equal(s1, s2);
    });
  });

  // ── requireTier ────────────────────────────────────────────

  describe('requireTier', () => {
    it('allows requests that meet the tier requirement', () => {
      const guard = requireTier('survivor');
      let nextCalled = false;
      const req = { path: '/api/players', tier: 'admin', tierLevel: TIER.admin };
      guard(req, {}, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true);
    });

    it('returns 403 for logged-in users with insufficient tier', () => {
      const guard = requireTier('admin');
      let statusCode: number | null = null;
      let jsonBody: unknown = null;
      const req = { path: '/api/admin/settings', tier: 'survivor', tierLevel: TIER.survivor };
      const res = {
        status: (code: number) => {
          statusCode = code;
          return res;
        },
        json: (body: unknown) => {
          jsonBody = body;
        },
        send: () => {},
        redirect: () => {},
      };
      guard(req, res, () => {});
      assert.equal(statusCode, 403);
      assert.ok(((jsonBody as Record<string, unknown>).error as string).includes('admin'));
    });

    it('redirects non-API public requests to login', () => {
      const guard = requireTier('survivor');
      let redirectTarget: string | null = null;
      const req = { path: '/dashboard', tier: 'public', tierLevel: 0 };
      const res = {
        status: () => res,
        json: () => {},
        redirect: (target: string) => {
          redirectTarget = target;
        },
        send: () => {},
      };
      guard(req, res, () => {});
      assert.equal(redirectTarget, '/auth/login');
    });
  });
});
