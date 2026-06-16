/**
 * Anticheat routes: flag browser with filters, all-player risk scores, flag
 * review (confirm/dismiss/whitelist), and dashboard summary stats.
 *
 * Behavior-preserving extraction from web-map/server.ts (P1-1 god-file split).
 * Handlers are verbatim; only `this.` -> `ctx.` was applied.
 */
import type { Express } from 'express';
import type { WebMapRouteContext } from '../types/route-context.js';
import { requireTier } from '../auth.js';
import { rateLimit } from '../rate-limit.js';
import { API_ERRORS, sendError } from '../api-errors.js';
import { safeError } from '../route-helpers.js';

export function registerAnticheatRoutes(app: Express, _ctx: WebMapRouteContext): void {
  // ══════════════════════════════════════════════════════════════════
  //  Anticheat API — flag browser, risk scores, review
  // ══════════════════════════════════════════════════════════════════

  /** GET /api/panel/anticheat/flags — list flags with optional filters */
  app.get('/api/panel/anticheat/flags', requireTier('admin'), rateLimit(10000, 15), (req, res) => {
    const srv = req.srv;
    if (!srv.db) return res.json([]);
    try {
      const { status, severity, steam_id, detector, limit } = req.query;
      const maxRows = Math.min(parseInt(limit as string, 10) || 100, 500);
      let flags;

      if (steam_id) {
        flags = srv.db.antiCheat.getAcFlagsBySteam(steam_id as string, maxRows);
      } else if (detector) {
        flags = srv.db.antiCheat.getAcFlagsByDetector(detector as string, (status || 'open') as string, maxRows);
      } else if (status) {
        flags = srv.db.antiCheat.getAcFlags(status as string, maxRows);
      } else {
        flags = srv.db.antiCheat.getAcFlags('open', maxRows);
      }

      // Apply severity filter client-side if both status and severity are set
      if (severity) {
        flags = (flags as Record<string, unknown>[]).filter((f) => f.severity === severity);
      }

      // Resolve player names from players table
      const nameMap: Record<string, string> = {};
      try {
        const rows = srv.db.player.listAllPlayerNames();
        for (const r of rows) nameMap[r.steam_id] = r.name;
      } catch {
        /* */
      }

      flags = (flags as Record<string, unknown>[]).map((f) => ({
        ...f,
        player_name: (f.player_name as string | undefined) || nameMap[f.steam_id as string] || f.steam_id,
      }));

      res.json(flags);
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });

  /** GET /api/panel/anticheat/risk-scores — all player risk scores */
  app.get('/api/panel/anticheat/risk-scores', requireTier('admin'), rateLimit(10000, 10), (req, res) => {
    if (!req.srv.db) return res.json([]);
    try {
      const scores = req.srv.db.antiCheat.getAllRiskScores();
      res.json(scores);
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });

  /** POST /api/panel/anticheat/flags/:id/review — confirm, dismiss, or whitelist a flag */
  app.post('/api/panel/anticheat/flags/:id/review', requireTier('admin'), rateLimit(10000, 10), (req, res) => {
    if (!req.srv.db) {
      sendError(res, API_ERRORS.DATABASE_NOT_AVAILABLE, 500);
      return;
    }
    try {
      const flagId = parseInt(req.params.id as string, 10);
      if (isNaN(flagId)) {
        sendError(res, API_ERRORS.INVALID_FLAG_ID, 400);
        return;
      }

      const { status, notes } = req.body as { status?: string; notes?: string };
      if (!status || !['confirmed', 'dismissed', 'whitelisted'].includes(status)) {
        sendError(res, API_ERRORS.INVALID_STATUS, 400);
        return;
      }

      // Get reviewer identity from session
      const reviewedBy = req.session.username || req.session.discordId || 'admin';

      req.srv.db.antiCheat.updateAcFlagStatus(flagId, status, reviewedBy, notes ?? '');
      res.json({ ok: true, flagId, status });
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });

  /** GET /api/panel/anticheat/stats — summary counts for dashboard */
  app.get('/api/panel/anticheat/stats', requireTier('admin'), rateLimit(10000, 10), (req, res) => {
    if (!req.srv.db) return res.json({ open: 0, confirmed: 0, dismissed: 0, total: 0 });
    try {
      const srv = req.srv;
      const countByStatus = (s: string | null) => {
        try {
          if (!srv.db) return 0;
          if (s) return srv.db.antiCheat.countAcFlagsByStatus(s);
          return srv.db.antiCheat.countAllAcFlags();
        } catch {
          return 0;
        }
      };
      const open = countByStatus('open');
      const confirmed = countByStatus('confirmed');
      const dismissed = countByStatus('dismissed');
      const total = countByStatus(null);
      res.json({ open, confirmed, dismissed, total });
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });
}
