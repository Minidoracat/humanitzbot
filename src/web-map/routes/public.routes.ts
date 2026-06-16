/**
 * Public / pre-plugin routes: the multi-server list and the public landing data.
 *
 * These register BEFORE the plugin route loop in _setupRoutes (exactly as on
 * main, where /api/servers and /api/landing preceded the plugin registration
 * boundary). Keeping them pre-plugin preserves Express first-match precedence
 * for any plugin-registered routes.
 *
 * Behavior-preserving extraction from web-map/server.ts (P1-1 god-file split).
 * Handlers are verbatim; only `this.` -> `ctx.` was applied.
 */
import type { Express } from 'express';
import type { WebMapRouteContext } from '../types/route-context.js';
import { requireTier } from '../auth.js';
import { rateLimit } from '../rate-limit.js';
import { createRconTimeout } from '../route-helpers.js';
import config from '../../config/index.js';

export function registerPublicRoutes(app: Express, ctx: WebMapRouteContext): void {
  // ── API: List available servers (multi-server support) ──
  app.get('/api/servers', requireTier('survivor'), (_req, res) => {
    const servers = [{ id: 'primary', name: config.serverName || 'Primary Server' }];
    const additional = ctx._loadServerList();
    for (const s of additional) {
      const dir = ctx._getServerDataDir(s.id);
      if (dir) servers.push({ id: s.id, name: s.name || s.id });
    }
    res.json({ servers, multiServer: additional.length > 0 });
  });
  // ═══════════════════════════════════════════════════════
  // Public Landing API — no auth required
  // ═══════════════════════════════════════════════════════

  /**
   * Returns server status, connect info, and multi-server data for the
   * public landing page. No authentication needed.
   */
  app.get('/api/landing', rateLimit(30000, 20), async (_req, res) => {
    // Serve from background-polled cache — instant response
    const cached = ctx._getCached('landing', 'global', 30000) as Record<string, unknown> | null;
    if (cached) return res.json(cached);
    // First request before background poller has run — build on demand
    try {
      const rconTimeout = createRconTimeout();
      await ctx._buildLandingData(rconTimeout);
      const built = ctx._getCached('landing', 'global', 30000) as Record<string, unknown> | null;
      if (built) return res.json(built);
    } catch {
      /* build failed */
    }
    res.json({
      primary: {
        name: config.serverName || 'HumanitZ Server',
        status: 'unknown',
        onlineCount: 0,
        totalPlayers: 0,
      },
      servers: [],
    });
  });
}
