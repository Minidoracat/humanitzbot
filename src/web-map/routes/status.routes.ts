/**
 * Panel status routes: module status and panel status/stats/capabilities (all
 * served from the background cache). These register AFTER the plugin route loop
 * in _setupRoutes, matching main (where /api/status/modules and the panel
 * status/stats/capabilities routes followed the plugin registration boundary).
 * The public /api/servers + /api/landing routes live in public.routes.ts and
 * register before the plugin loop.
 *
 * Behavior-preserving extraction from web-map/server.ts (P1-1 god-file split).
 * Handlers are verbatim; only `this.` -> `ctx.` was applied.
 */
import type { Express } from 'express';
import type { WebMapRouteContext } from '../types/route-context.js';
import { requireTier } from '../auth.js';
import serverResources from '../../server/server-resources.js';

export function registerStatusRoutes(app: Express, ctx: WebMapRouteContext): void {
  // ═══════════════════════════════════════════════════════
  // Panel API routes — server management, activity, chat, RCON console, settings
  // ═══════════════════════════════════════════════════════

  // ── Status: Module status ──
  app.get('/api/status/modules', requireTier('admin'), (_req, res) => {
    res.json({ modules: ctx._moduleStatus || {} });
  });
  // ── Panel: Server status (RCON info + resources) — served from background cache ──
  app.get('/api/panel/status', requireTier('survivor'), async (req, res) => {
    const srv = req.srv;
    // Serve from background-polled cache — instant response
    const cached = ctx._getCached('status', srv.serverId, 30000) as Record<string, unknown> | null;
    if (cached) return res.json(cached);
    // Fallback: build on demand if background poller hasn't run yet
    try {
      const rconTimeout = (promise: Promise<unknown>) =>
        Promise.race([
          promise,
          new Promise((_, rej) =>
            setTimeout(() => {
              rej(new Error('RCON timeout'));
            }, 5000),
          ),
        ]);
      await ctx._buildStatusCache(srv, rconTimeout);
      const built = ctx._getCached('status', srv.serverId, 30000) as Record<string, unknown> | null;
      if (built) return res.json(built);
    } catch {
      /* build failed */
    }
    res.json({ serverState: 'unknown', onlineCount: 0, timezone: srv.config.botTimezone || 'UTC' });
  });
  // ── Panel: Quick stats — served from background cache ──
  app.get('/api/panel/stats', requireTier('survivor'), async (req, res) => {
    const srv = req.srv;
    // Serve from background-polled cache — instant response
    const cached = ctx._getCached('stats', srv.serverId, 30000) as Record<string, unknown> | null;
    if (cached) return res.json(cached);
    // Fallback: build on demand if background poller hasn't run yet
    try {
      const rconTimeout = (promise: Promise<unknown>) =>
        Promise.race([
          promise,
          new Promise((_, rej) =>
            setTimeout(() => {
              rej(new Error('RCON timeout'));
            }, 5000),
          ),
        ]);
      await ctx._buildStatsCache(srv, rconTimeout);
      const built = ctx._getCached('stats', srv.serverId, 30000) as Record<string, unknown> | null;
      if (built) return res.json(built);
    } catch {
      /* build failed */
    }
    res.json({ totalPlayers: 0, onlinePlayers: 0, eventsToday: 0, chatsToday: 0 });
  });
  // ── Panel: Server capabilities — tells the client what this server has ──
  app.get('/api/panel/capabilities', requireTier('survivor'), (req, res) => {
    const srv = req.srv;
    const cached = ctx._getCached('caps', srv.serverId, 30000) as Record<string, unknown> | null;
    if (cached) return res.json(cached);

    const caps: Record<string, unknown> = {
      db: !!srv.db,
      rcon: !!srv.rcon,
      scheduler: !!srv.scheduler?.isActive(),
      saveService: srv.isPrimary ? !!ctx._saveService : !!srv.db,
      resources: srv.isPrimary && !!serverResources,
      hasPlugin: ctx._plugins.some((p: Record<string, unknown>) => {
        // Check if this plugin is associated with this server
        if (srv.isPrimary) return false; // plugins are typically non-primary
        return !!p.name;
      }),
      isPrimary: srv.isPrimary,
      serverId: srv.serverId,
      serverName: srv.config.serverName || '',
    };
    // Check if this is the hzmod-enabled server
    for (const plugin of ctx._plugins) {
      if (plugin.name === 'hzmod') {
        // hzmod is registered with a serverId — only show on that server's dashboard
        const pluginSrv = plugin.serverId;
        if (!pluginSrv) {
          caps.hzmod = true;
          break;
        } // no serverId set → show everywhere
        if (pluginSrv === srv.serverId) {
          caps.hzmod = true;
        } // matches this server
        break;
      }
    }
    ctx._setCache('caps', srv.serverId, caps);
    res.json(caps);
  });
}
