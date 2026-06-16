/**
 * Map calibration routes: world-bounds calibration data dump, get/save
 * calibration bounds, and calibration from two reference points.
 *
 * Behavior-preserving extraction from web-map/server.ts (P1-1 god-file split).
 * Handlers are verbatim; only `this.` -> `ctx.` was applied.
 */
import path from 'path';
import fs from 'fs';
import type { Express } from 'express';
import type { WebMapRouteContext } from '../types/route-context.js';
import { requireTier } from '../auth.js';
import { API_ERRORS, sendError } from '../api-errors.js';
import { safeError } from '../route-helpers.js';
import { errMsg } from '../../utils/error.js';
import type { DbRow } from '../types/db-rows.js';

export function registerCalibrationRoutes(app: Express, ctx: WebMapRouteContext): void {
  // ── API: Calibration data — all entity positions for map alignment ──
  app.get('/api/calibration-data', requireTier('admin'), (req, res) => {
    try {
      const srv = req.srv;
      const cachePath = path.join(srv.dataDir, 'save-cache.json');
      if (!fs.existsSync(cachePath)) return res.json([]);
      const data = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as {
        players?: Record<string, DbRow>;
        worldState?: Record<string, DbRow[]>;
      };

      const points: (number | string)[][] = [];
      const add = (arr: DbRow[] | undefined, type: string) => {
        if (!arr) return;
        for (const item of arr) {
          const x = item.x ?? item.worldX ?? null;
          const y = item.y ?? item.worldY ?? null;
          if (x !== null && y !== null && !(x === 0 && y === 0)) points.push([x as number, y as number, type]);
        }
      };

      // Players
      for (const [, p] of Object.entries(data.players ?? {})) {
        if (p.x != null && !(p.x === 0 && p.y === 0)) points.push([p.x as number, p.y as number, 'P']);
      }

      // World entities
      const ws = data.worldState ?? {};
      add(ws.preBuildActors, 'p');
      add(ws.droppedBackpacks, 'b');
      add(ws.explodableBarrelPositions, 'e');
      add(ws.destroyedRandCarPositions, 'd');
      add(ws.savedActors, 'A');
      add(ws.aiSpawns, 'a');

      // LOD pickups (positions extracted)
      if (ws.lodPickups) {
        for (const p of ws.lodPickups) {
          if (p.x != null && !(p.x === 0 && p.y === 0)) points.push([p.x as number, p.y as number, 'l']);
        }
      }

      // Houses
      if (ws.houses) {
        for (const h of ws.houses) {
          if (h.x != null && !(h.x === 0 && h.y === 0)) points.push([h.x as number, h.y as number, 'H']);
        }
      }

      // Global containers
      if (ws.globalContainers) {
        for (const c of ws.globalContainers) {
          if (c.x != null && !(c.x === 0 && c.y === 0)) points.push([c.x as number, c.y as number, 'c']);
        }
      }

      console.log(`[WEB MAP] Calibration data: ${points.length} positions`);
      res.json(points);
    } catch (err: unknown) {
      console.error('[WEB MAP] Calibration data error:', errMsg(err));
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });

  // ── API: Get world bounds / calibration ──

  app.get('/api/calibration', requireTier('admin'), (_req, res) => {
    res.json(ctx._worldBounds);
  });

  // ── API: Save calibration ──
  app.post('/api/calibration', requireTier('admin'), (req, res) => {
    const body1187 = req.body as { xMin: number; xMax: number; yMin: number; yMax: number };
    const { xMin, xMax, yMin, yMax } = body1187;
    if ([xMin, xMax, yMin, yMax].some((v) => typeof v !== 'number' || isNaN(v))) {
      sendError(res, API_ERRORS.INVALID_BOUNDS, 400);
      return;
    }
    ctx._saveCalibration({ xMin, xMax, yMin, yMax });
    res.json({ ok: true, bounds: ctx._worldBounds });
  });

  // ── API: Calibrate from two reference points ──
  app.post('/api/calibrate-from-points', requireTier('admin'), (req, res) => {
    // Each point: { worldX, worldY, pixelX, pixelY } where pixel is 0-4096
    const { point1, point2 } = req.body as {
      point1?: { worldX: number; worldY: number; pixelX: number; pixelY: number };
      point2?: { worldX: number; worldY: number; pixelX: number; pixelY: number };
    };
    if (!point1 || !point2) {
      sendError(res, API_ERRORS.MISSING_POINTS, 400);
      return;
    }

    // Solve: pixelLat = ((worldX - xMin) / (xMax - xMin)) * 4096
    //        pixelLng = ((worldY - yMin) / (yMax - yMin)) * 4096
    // Given 2 points we can solve for xMin/xMax and yMin/yMax

    // For X axis (vertical / lat):
    // lat1 = ((wx1 - xMin) / xSpan) * 4096
    // lat2 = ((wx2 - xMin) / xSpan) * 4096
    // lat1/4096 * xSpan + xMin = wx1
    // lat2/4096 * xSpan + xMin = wx2
    // → xSpan = (wx2 - wx1) / ((lat2 - lat1) / 4096)
    // → xMin = wx1 - (lat1/4096) * xSpan

    const lat1 = point1.pixelY; // pixel Y from bottom = lat
    const lat2 = point2.pixelY;
    const lng1 = point1.pixelX;
    const lng2 = point2.pixelX;

    if (Math.abs(lat2 - lat1) < 1 || Math.abs(lng2 - lng1) < 1) {
      sendError(res, API_ERRORS.POINTS_TOO_CLOSE, 400);
      return;
    }

    const xSpan = (point2.worldX - point1.worldX) / ((lat2 - lat1) / 4096);
    const xMin = point1.worldX - (lat1 / 4096) * xSpan;
    const xMax = xMin + xSpan;

    const ySpan = (point2.worldY - point1.worldY) / ((lng2 - lng1) / 4096);
    const yMin = point1.worldY - (lng1 / 4096) * ySpan;
    const yMax = yMin + ySpan;

    const bounds = {
      xMin: Math.round(xMin),
      xMax: Math.round(xMax),
      yMin: Math.round(yMin),
      yMax: Math.round(yMax),
    };

    ctx._saveCalibration(bounds);
    res.json({ ok: true, bounds });
  });
}
