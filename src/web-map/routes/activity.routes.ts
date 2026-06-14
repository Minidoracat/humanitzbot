/**
 * Activity panel routes: the activity feed and aggregated activity statistics
 * over a resolved time range.
 *
 * Behavior-preserving extraction from web-map/server.ts (P1-1 god-file split).
 * Handlers are verbatim; only `this.` -> `ctx.` was applied.
 */
import type { Express } from 'express';
import type { WebMapRouteContext } from '../types/route-context.js';
import { requireTier } from '../auth.js';
import { rateLimit } from '../rate-limit.js';
import { API_ERRORS, sendError } from '../api-errors.js';
import {
  safeError,
  _requestLocale,
  _resolveActivityRange,
  _activityBucketOffsetMinutes,
  _hasEntityActor,
} from '../route-helpers.js';
import { cleanNameCached } from '../../parsers/ue4-names.js';
import { resolveItemName, searchItemIds } from '../../i18n/item-names.js';
import type { ActivityRow } from '../types/db-rows.js';

export function registerActivityRoutes(app: Express, ctx: WebMapRouteContext): void {
  // ── Panel: Activity feed from DB ──
  app.get('/api/panel/activity', requireTier('survivor'), rateLimit(10000, 20), (req, res) => {
    const srv = req.srv;
    if (!srv.db) return res.json({ events: [] });

    const limit = Math.min(parseInt((req.query.limit as string) || '', 10) || 50, 500);
    const offset = Math.max(parseInt((req.query.offset as string) || '0', 10) || 0, 0);
    const type = (req.query.type as string) || '';
    const actor = (req.query.actor as string) || '';
    const mode = ((req.query.mode as string) || '').toLowerCase();
    const q = (req.query.q as string) || actor;
    const steamId = (req.query.steamId as string) || actor || q;
    const activityRange = _resolveActivityRange(req.query, srv.config.botTimezone || 'UTC');
    const rangeOptions = {
      dateFrom: activityRange.dateFrom,
      dateTo: activityRange.dateTo,
      bucketOffsetMinutes: _activityBucketOffsetMinutes(activityRange.timezone),
    };

    try {
      let events;
      if (mode === 'player') {
        events = srv.db.activityLog.searchActivityByPlayer(steamId, {
          category: type,
          limit,
          offset,
          ...rangeOptions,
        });
      } else if (mode === 'item') {
        events = srv.db.activityLog.searchActivityByItem(q, {
          category: type,
          limit,
          offset,
          // '繃帶'/'antiseptic' reach raw-id rows the LIKE match never hits
          matchedIds: searchItemIds(q),
          ...rangeOptions,
        });
      } else if (mode === 'container') {
        events = srv.db.activityLog.searchActivityByContainer(q, { category: type, limit, offset, ...rangeOptions });
      } else if (mode === 'text') {
        events = srv.db.activityLog.searchActivity(q, { category: type, limit, offset, ...rangeOptions });
      } else if (actor) {
        events = srv.db.activityLog.searchActivity(actor, { category: type, limit, offset, ...rangeOptions });
      } else if (type) {
        events = srv.db.activityLog.getActivityByCategory(type, limit, offset, rangeOptions);
      } else {
        events = srv.db.activityLog.getRecentActivity(limit, offset, rangeOptions);
      }

      // Resolve steam IDs through this server's SQLite aliases + clean UE4 blueprint names
      const activityLocale = _requestLocale(req);
      const resolved = (events as unknown as ActivityRow[]).map((e) => {
        // SAFETY: getRecentActivity returns DbRow[] with ActivityRow shape
        const out: ActivityRow & {
          actor_name?: string;
          target_name?: string;
          item?: string;
          display?: string;
          item_display?: string;
        } = { ...e };
        const actorIsSteamId = !!out.actor && /^\d{17}$/.test(out.actor);
        const details = out.details as unknown;
        if (!out.steam_id && details && typeof details === 'object' && !Array.isArray(details)) {
          const detailRecord = details as Record<string, unknown>;
          const ownerCandidate =
            detailRecord.owner || detailRecord.newOwner || detailRecord.ownerSteamId || detailRecord.oldOwner || '';
          const ownerSteamId =
            typeof ownerCandidate === 'string' || typeof ownerCandidate === 'number' ? String(ownerCandidate) : '';
          if (/^\d{17}$/.test(ownerSteamId)) out.steam_id = ownerSteamId;
        }
        if (out.steam_id) {
          const attributedName = ctx._resolveServerPlayerName(srv, out.steam_id);
          if (attributedName) out.attributed_name = attributedName;
        }
        if (!out.actor_name && out.steam_id && (!out.actor || actorIsSteamId)) {
          const actorName = ctx._resolveServerPlayerName(srv, out.steam_id);
          if (actorName) out.actor_name = actorName;
        } else if (!out.actor_name && out.actor) {
          const actorName = ctx._resolveServerPlayerName(srv, out.actor);
          if (actorName) out.actor_name = actorName;
        }
        if (!out.target_name && out.target_steam_id) {
          const targetName = ctx._resolveServerPlayerName(srv, out.target_steam_id);
          if (targetName) out.target_name = targetName;
        }
        // Display-layer cleaning: `item_display`/`display` carry the
        // human-readable labels while `item`/`actor`/`actor_name` keep their
        // previous values so frontend activity search (LIKE queries against
        // the raw DB columns) keeps matching as before.
        if (out.item) {
          out.item_display = resolveItemName(out.item, activityLocale);
          out.item = cleanNameCached(out.item);
        }
        if (out.actor && !out.actor_name) out.actor_name = cleanNameCached(out.actor);
        if (_hasEntityActor(out.type)) {
          const rawActorName = out.actor_name || out.actor;
          if (rawActorName) out.display = cleanNameCached(rawActorName);
        }
        return out;
      });

      res.json({ events: resolved, range: activityRange, timezone: activityRange.timezone });
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });

  // ── Panel: Activity stats (aggregated trends) ──
  app.get('/api/panel/activity-stats', requireTier('survivor'), rateLimit(15000, 10), (req, res) => {
    const srv = req.srv;
    if (!srv.db)
      return res.json({ categories: {}, hourly: [], daily: [], types: {}, topPlayers: [], topContainers: [] });

    try {
      const activityRange = _resolveActivityRange(req.query, srv.config.botTimezone || 'UTC');
      const rangeOptions = {
        dateFrom: activityRange.dateFrom,
        dateTo: activityRange.dateTo,
        bucketOffsetMinutes: _activityBucketOffsetMinutes(activityRange.timezone),
      };
      const total = srv.db.activityLog.getActivityCount(rangeOptions);

      // Count by type
      const typeCounts = srv.db.activityLog.countByType(rangeOptions) as { type: string; count: number }[];
      const types: Record<string, number> = {};
      for (const r of typeCounts) types[r.type] = r.count;

      // Count by category
      const categories: Record<string, number> = {};
      const catMap: Record<string, string[]> = {
        container: ['container_item_added', 'container_item_removed', 'container_loot', 'container_destroyed'],
        inventory: ['inventory_item_added', 'inventory_item_removed'],
        vehicle: [
          'vehicle_fuel_changed',
          'vehicle_health_changed',
          'vehicle_appeared',
          'vehicle_destroyed',
          'vehicle_change',
        ],
        session: ['player_connect', 'player_disconnect'],
        combat: ['player_death', 'player_death_pvp', 'damage_taken'],
        structure: [
          'player_build',
          'structure_placed',
          'structure_destroyed',
          'structure_damaged',
          'structure_upgraded',
          'building_destroyed',
          'raid_damage',
          'clan_building_damage',
        ],
        horse: ['horse_appeared', 'horse_disappeared', 'horse_change'],
        admin: ['admin_access', 'anticheat_flag'],
      };
      for (const [cat, typesList] of Object.entries(catMap)) {
        let sum = 0;
        for (const t of typesList) sum += types[t] ?? 0;
        if (sum > 0) categories[cat] = sum;
      }

      // Hourly distribution (last 7 days)
      const hourly = srv.db.activityLog.hourlyDistribution(7, rangeOptions) as { hour: number; count: number }[];

      // Daily totals (last 30 days)
      const daily = srv.db.activityLog.dailyCount(30, rangeOptions) as { day: string; count: number }[];

      // Daily by category (last 14 days, for stacked chart)
      const dailyByType = srv.db.activityLog.dailyByType(14, rangeOptions) as {
        day: string;
        type: string;
        count: number;
      }[];

      // Top reliable player actors and container actors (last 7 days)
      const topPlayers = srv.db.activityLog.topPlayers(7, 10, rangeOptions) as { steam_id: string; count: number }[];
      const topContainers = srv.db.activityLog.topContainers(7, 10, rangeOptions) as {
        actor: string;
        actor_name?: string;
        count: number;
      }[];

      // Resolve player names and clean container actor names separately
      const resolvedTopPlayers = topPlayers.map((p) => ({
        steam_id: p.steam_id,
        actor: ctx._resolveServerPlayerName(srv, p.steam_id) ?? p.steam_id,
        count: p.count,
      }));
      const resolvedTopContainers = topContainers.map((c) => ({
        actor: c.actor,
        actor_name: c.actor_name || c.actor,
        display: cleanNameCached(c.actor_name || c.actor),
        count: c.count,
      }));

      // Date range
      const range = srv.db.activityLog.dateRange(rangeOptions);

      res.json({
        total,
        types,
        categories,
        hourly,
        daily,
        dailyByType,
        topPlayers: resolvedTopPlayers,
        topContainers: resolvedTopContainers,
        topActors: resolvedTopPlayers,
        dateRange: { earliest: range?.earliest, latest: range?.latest },
        selectedRange: activityRange,
        timezone: activityRange.timezone,
      });
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });
}
