/**
 * Timeline / history routes: snapshot bounds & list, single snapshot, player
 * trail, AI population, and death-cause data.
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
import type { DeathCauseRow } from '../types/db-rows.js';

export function registerTimelineRoutes(app: Express, ctx: WebMapRouteContext): void {
  app.get('/api/timeline/bounds', requireTier('mod'), rateLimit(10000, 10), (req, res) => {
    if (!req.srv.db) return res.json({ earliest: null, latest: null, count: 0 });
    try {
      const bounds = req.srv.db.timeline.getTimelineBounds();
      res.json(bounds || { earliest: null, latest: null, count: 0 });
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });

  /** GET /api/timeline/snapshots?from=&to=&limit= — snapshot list (metadata only) */
  app.get('/api/timeline/snapshots', requireTier('mod'), rateLimit(10000, 10), (req, res) => {
    if (!req.srv.db) return res.json([]);
    try {
      const { from, to, limit } = req.query;
      let snapshots;
      if (from && to) {
        snapshots = req.srv.db.timeline.getTimelineSnapshotRange(from as string, to as string);
      } else {
        snapshots = req.srv.db.timeline.getTimelineSnapshots(parseInt(limit as string, 10) || 50);
      }
      res.json(snapshots);
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });

  /** GET /api/timeline/snapshot/:id — full snapshot data (all entities with map coords) */
  app.get('/api/timeline/snapshot/:id', requireTier('mod'), rateLimit(10000, 15), (req, res) => {
    if (!req.srv.db) {
      sendError(res, API_ERRORS.DATABASE_NOT_AVAILABLE, 404);
      return;
    }
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        sendError(res, API_ERRORS.INVALID_SNAPSHOT_ID, 400);
        return;
      }

      const full = req.srv.db.timeline.getTimelineSnapshotFull(id);
      if (!full) {
        sendError(res, API_ERRORS.SNAPSHOT_NOT_FOUND, 404);
        return;
      }

      // Convert world coordinates to leaflet coordinates for all entities
      const convert = (item: Record<string, unknown>) => {
        if (item.pos_x != null && item.pos_y != null && !(item.pos_x === 0 && item.pos_y === 0)) {
          const [lat, lng] = ctx._worldToLeaflet(item.pos_x as number, item.pos_y as number);
          return { ...item, lat, lng };
        }
        return { ...item, lat: null, lng: null };
      };

      full.players = (full.players as Record<string, unknown>[]).map(convert);
      full.ai = (full.ai as Record<string, unknown>[]).map(convert);
      full.vehicles = (full.vehicles as Record<string, unknown>[]).map(convert);
      full.structures = (full.structures as Record<string, unknown>[]).map(convert);
      full.companions = (full.companions as Record<string, unknown>[]).map(convert);
      full.backpacks = (full.backpacks as Record<string, unknown>[]).map(convert);

      // Build name map for owner resolution
      const nameMap: Record<string, string> = {};
      try {
        const rows = req.srv.db.player.listAllPlayerNames();
        for (const r of rows) nameMap[r.steam_id] = r.name;
      } catch {
        /* */
      }
      (full as Record<string, unknown>).nameMap = nameMap;

      res.json(full);
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });

  /** GET /api/timeline/player/:steamId/trail?from=&to= — player position history */
  app.get('/api/timeline/player/:steamId/trail', requireTier('mod'), rateLimit(10000, 10), (req, res) => {
    if (!req.srv.db) return res.json([]);
    try {
      const { steamId } = req.params;
      const { from, to } = req.query;
      if (!from || !to) {
        sendError(res, API_ERRORS.FROM_AND_TO_REQUIRED, 400);
        return;
      }

      const positions = req.srv.db.timeline.getPlayerPositionHistory(steamId as string, from as string, to as string);
      // Convert to map coordinates
      const trail = (positions as Record<string, unknown>[])
        .map((p) => {
          if (p.pos_x != null && p.pos_y != null && !(p.pos_x === 0 && p.pos_y === 0)) {
            const [lat, lng] = ctx._worldToLeaflet(p.pos_x as number, p.pos_y as number);
            return { lat, lng, health: p.health, online: p.online, time: p.created_at, gameDay: p.game_day };
          }
          return null;
        })
        .filter(Boolean);

      res.json(trail);
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });

  /** GET /api/timeline/ai/population?from=&to= — AI population over time */
  app.get('/api/timeline/ai/population', requireTier('mod'), rateLimit(10000, 10), (req, res) => {
    if (!req.srv.db) return res.json([]);
    try {
      const { from, to } = req.query;
      if (!from || !to) {
        sendError(res, API_ERRORS.FROM_AND_TO_REQUIRED, 400);
        return;
      }
      const data = req.srv.db.timeline.getAIPopulationHistory(from as string, to as string);
      res.json(data);
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });

  /** GET /api/timeline/deaths?limit=&player= — recent death causes */
  app.get('/api/timeline/deaths', requireTier('mod'), rateLimit(10000, 15), (req, res) => {
    if (!req.srv.db) return res.json([]);
    try {
      const { limit, player } = req.query;
      let deaths;
      if (player) {
        deaths = req.srv.db.deathCause.getDeathCausesByPlayer(player as string, parseInt(limit as string, 10) || 50);
      } else {
        deaths = req.srv.db.deathCause.getDeathCauses(parseInt(limit as string, 10) || 50);
      }
      // Add map coordinates
      deaths = (deaths as DeathCauseRow[]).map((d: DeathCauseRow) => {
        if (d.pos_x != null && d.pos_y != null && !(d.pos_x === 0 && d.pos_y === 0)) {
          const [lat, lng] = ctx._worldToLeaflet(d.pos_x, d.pos_y);
          return { ...d, lat, lng };
        }
        return { ...d, lat: null, lng: null };
      });
      res.json(deaths);
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });

  /** GET /api/timeline/deaths/stats — death cause breakdown */
  app.get('/api/timeline/deaths/stats', requireTier('mod'), rateLimit(10000, 10), (req, res) => {
    if (!req.srv.db) return res.json([]);
    try {
      const stats = req.srv.db.deathCause.getDeathCauseStats();
      res.json(stats);
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });
}
