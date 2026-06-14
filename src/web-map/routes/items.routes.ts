/**
 * Item-tracking panel routes: tracked items (instances + groups), per-item
 * locations & movements, group lookup, global movements, item lookup, and the
 * generic reference lookup endpoint.
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
  _queryString,
  _requestLocale,
  _parseItemListView,
  _parseBoundedPositiveInt,
  _parseNonNegativeInt,
  _withItemDisplayName,
} from '../route-helpers.js';
import { resolveItemId, searchItemIds } from '../../i18n/item-names.js';
import type { ItemInstanceRow, ItemGroupRow, ItemMovementRow, ItemLocationSummaryRow } from '../types/db-rows.js';

export function registerItemsRoutes(app: Express, ctx: WebMapRouteContext): void {
  // ── Panel: Item Tracking API ──

  // GET /api/panel/items — All tracked items (instances + groups), with filters
  app.get('/api/panel/items', requireTier('admin'), rateLimit(10000, 15), (req, res) => {
    const srv = req.srv;
    const limit = _parseBoundedPositiveInt(req.query.limit, 100, 500);
    const offset = _parseNonNegativeInt(req.query.offset);
    if (!srv.db)
      return res.json({
        instances: [],
        groups: [],
        locations: [],
        counts: { instances: 0, groups: 0 },
        pagination: { limit, offset, nextOffset: offset, hasMoreInstances: false, hasMoreGroups: false },
      });
    try {
      const search = _queryString(req.query.search).trim();
      const locationType = _queryString(req.query.locationType).trim();
      const locationId = _queryString(req.query.locationId).trim();
      const view = _parseItemListView(req.query.view);
      const includeLocations = _queryString(req.query.includeLocations).toLowerCase() === 'true';
      const pageOptions = {
        limit: limit + 1,
        offset,
        search,
        // Let display-name queries ('繃帶', 'antiseptic') reach rows whose raw
        // id ('Bandage', 'BandageAnti') the raw LIKE match would never hit.
        matchedIds: search ? searchItemIds(search) : [],
        locationType,
        locationId,
      };

      const instancePage =
        view === 'groups' ? [] : (srv.db.item.getActiveItemInstancesPage(pageOptions) as ItemInstanceRow[]);
      const groupPage =
        view === 'instances' ? [] : (srv.db.item.getActiveItemGroupsPage(pageOptions) as ItemGroupRow[]);
      const hasMoreInstances = instancePage.length > limit;
      const hasMoreGroups = groupPage.length > limit;
      const instances = instancePage.slice(0, limit);
      const groups = groupPage.slice(0, limit);
      const locations = includeLocations
        ? (srv.db.item.getItemLocationSummaryPage({ limit, offset, search }) as ItemLocationSummaryRow[])
        : [];

      const itemLocale = _requestLocale(req);
      res.json({
        instances: instances.map((row) => _withItemDisplayName(row, itemLocale)),
        groups: groups.map((row) => _withItemDisplayName(row, itemLocale)),
        locations,
        counts: {
          instances: srv.db.item.getItemInstanceCount(),
          groups: srv.db.item.getItemGroupCount(),
        },
        pagination: {
          limit,
          offset,
          nextOffset: offset + limit,
          hasMoreInstances,
          hasMoreGroups,
        },
      });
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });

  // GET /api/panel/items/locations — Lazy location summary for item filters
  app.get('/api/panel/items/locations', requireTier('admin'), rateLimit(10000, 15), (req, res) => {
    const srv = req.srv;
    const limit = _parseBoundedPositiveInt(req.query.limit, 100, 500);
    const offset = _parseNonNegativeInt(req.query.offset);
    if (!srv.db)
      return res.json({
        locations: [],
        pagination: { limit, offset, nextOffset: offset, hasMore: false },
      });
    try {
      const search = _queryString(req.query.search).trim();
      const rows = srv.db.item.getItemLocationSummaryPage({
        limit: limit + 1,
        offset,
        search,
      }) as ItemLocationSummaryRow[];
      const hasMore = rows.length > limit;
      res.json({
        locations: rows.slice(0, limit),
        pagination: { limit, offset, nextOffset: offset + limit, hasMore },
      });
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });

  // GET /api/panel/items/:id/movements — Movement history for an instance
  app.get('/api/panel/items/:id/movements', requireTier('admin'), (req, res) => {
    const srv = req.srv;
    if (!srv.db) return res.json({ movements: [] });
    try {
      const id = parseInt(req.params.id as string, 10);
      const instance = srv.db.item.getItemInstance(id);
      if (!instance) {
        sendError(res, API_ERRORS.INSTANCE_NOT_FOUND, 404);
        return;
      }

      const movements = srv.db.item.getItemMovements(id) as ItemMovementRow[];
      const itemLocale = _requestLocale(req);
      res.json({
        instance: _withItemDisplayName(instance as ItemInstanceRow, itemLocale),
        movements: movements.map((row) => _withItemDisplayName(row, itemLocale)),
      });
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });

  // GET /api/panel/groups/:id — Group detail with movement history
  app.get('/api/panel/groups/:id', requireTier('admin'), (req, res) => {
    const srv = req.srv;
    if (!srv.db) return res.json({ group: null, movements: [] });
    try {
      const id = parseInt(req.params.id as string, 10);
      const group = srv.db.item.getItemGroup(id) as ItemGroupRow | undefined;
      if (!group) {
        sendError(res, API_ERRORS.GROUP_NOT_FOUND, 404);
        return;
      }
      let groupAttachments: unknown = group.attachments;
      try {
        groupAttachments = JSON.parse(group.attachments as string);
      } catch {
        groupAttachments = [];
      }
      const itemLocale = _requestLocale(req);
      const groupOut = _withItemDisplayName({ ...group, attachments: groupAttachments }, itemLocale);

      const movements = srv.db.item.getItemMovementsByGroup(id) as ItemMovementRow[];
      res.json({ group: groupOut, movements: movements.map((row) => _withItemDisplayName(row, itemLocale)) });
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });

  // GET /api/panel/movements — Recent item movements across all items
  app.get('/api/panel/movements', requireTier('admin'), (req, res) => {
    const srv = req.srv;
    if (!srv.db) return res.json({ movements: [] });
    try {
      const limit = Math.min(parseInt((req.query.limit as string) || '', 10) || 50, 500);
      const steamId = (req.query.steamId as string) || '';
      const locationType = (req.query.locationType as string) || '';
      const locationId = (req.query.locationId as string) || '';

      let movements;
      if (steamId) {
        movements = srv.db.item.getItemMovementsByPlayer(steamId, limit) as ItemMovementRow[];
      } else if (locationType && locationId) {
        movements = srv.db.item.getItemMovementsByLocation(locationType, locationId, limit) as ItemMovementRow[];
      } else {
        movements = srv.db.item.getRecentItemMovements(limit) as ItemMovementRow[];
      }

      const itemLocale = _requestLocale(req);
      res.json({ movements: movements.map((row) => _withItemDisplayName(row, itemLocale)) });
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });

  // GET /api/panel/items/lookup — Look up item instance/group by name + fingerprint data
  // Used by item popups across the entire UI to bridge save data → item tracking DB
  app.get('/api/panel/items/lookup', requireTier('survivor'), (req, res) => {
    const srv = req.srv;
    if (!srv.db) return res.json({ match: null, movements: [] });
    try {
      const { fingerprint, item: itemName, steamId } = req.query;
      if (!fingerprint && !itemName) {
        sendError(res, API_ERRORS.NEED_FINGERPRINT_OR_ITEM_NAME, 400);
        return;
      }

      let match: ((ItemInstanceRow | ItemGroupRow) & { attachments?: unknown }) | null = null;
      let movements: ItemMovementRow[] = [];
      let matchType = null; // 'instance' or 'group'

      // Try exact fingerprint match first
      if (fingerprint) {
        // Check instances
        const instances = srv.db.item.findItemsByFingerprint(fingerprint as string) as ItemInstanceRow[];
        if (instances.length > 0) {
          // If steamId provided, prefer the instance at that player's location
          const inst = steamId
            ? (instances.find((i: ItemInstanceRow) => i.location_type === 'player' && i.location_id === steamId) ??
              instances[0])
            : instances[0];
          match = inst ?? null;
          matchType = 'instance';
          if (match) {
            try {
              match.attachments = JSON.parse(match.attachments as string) as string[];
            } catch {
              match.attachments = [];
            }
            movements = srv.db.item.getItemMovements(match.id) as ItemMovementRow[];
          }
        }

        // Check groups if no instance match
        if (!match) {
          const groups = srv.db.item.findActiveGroupsByFingerprint(fingerprint as string) as ItemGroupRow[];
          if (groups.length > 0) {
            const grp = steamId
              ? (groups.find((g: ItemGroupRow) => g.location_type === 'player' && g.location_id === steamId) ??
                groups[0])
              : groups[0];
            match = grp ?? null;
            matchType = 'group';
            if (match) {
              try {
                match.attachments = JSON.parse(match.attachments as string) as string[];
              } catch {
                match.attachments = [];
              }
              movements = srv.db.item.getItemMovementsByGroup(match.id) as ItemMovementRow[];
            }
          }
        }
      }

      // Fall back to item name search if no fingerprint match. The frontend
      // may send a localized display label or a cased variant ('Gasmask2'
      // vs 'GasMask2') instead of the raw id stored in the tracking DB —
      // retry case-insensitively, then reverse-resolve the label to an id.
      if (!match && itemName) {
        let instances = srv.db.item.getItemInstancesByItem(itemName as string) as ItemInstanceRow[];
        if (instances.length === 0) {
          instances = srv.db.item.getItemInstancesByItemNoCase(itemName as string) as ItemInstanceRow[];
        }
        if (instances.length === 0) {
          const rawId = resolveItemId(itemName);
          if (rawId && rawId.toLowerCase() !== (itemName as string).toLowerCase()) {
            instances = srv.db.item.getItemInstancesByItemNoCase(rawId) as ItemInstanceRow[];
          }
        }
        if (instances.length > 0) {
          const inst = steamId
            ? (instances.find((i: ItemInstanceRow) => i.location_type === 'player' && i.location_id === steamId) ??
              instances[0])
            : instances[0];
          match = inst ?? null;
          matchType = 'instance';
          if (match) {
            try {
              match.attachments = JSON.parse(match.attachments as string) as string[];
            } catch {
              match.attachments = [];
            }
            movements = srv.db.item.getItemMovements(match.id) as ItemMovementRow[];
          }
        }
      }

      // Resolve player names in movements
      const nameCache: Record<string, string> = {};
      const resolveName = (sid: string) => {
        if (!sid) return null;
        if (nameCache[sid]) return nameCache[sid];
        const name = ctx._resolveServerPlayerName(srv, sid) || sid;
        nameCache[sid] = name;
        return name;
      };

      // Enrich movement data with resolved names
      const itemLocale = _requestLocale(req);
      const enrichedMovements = movements.map((m: ItemMovementRow) =>
        _withItemDisplayName(
          {
            ...m,
            from_name: m.from_type === 'player' ? resolveName(m.from_id) : null,
            to_name: m.to_type === 'player' ? resolveName(m.to_id) : null,
            attributed_name: m.attributed_name || resolveName(m.attributed_steam_id),
          },
          itemLocale,
        ),
      );

      // Build ownership chain — unique players who have held this item
      const ownershipChain = [];
      const seenOwners = new Set();
      for (const m of movements) {
        if (m.to_type === 'player' && m.to_id && !seenOwners.has(m.to_id)) {
          seenOwners.add(m.to_id);
          ownershipChain.push({ steamId: m.to_id, name: resolveName(m.to_id), at: m.created_at });
        }
      }

      res.json({
        match: match ? _withItemDisplayName(match, itemLocale) : match,
        matchType,
        movements: enrichedMovements,
        ownershipChain,
        totalMovements: movements.length,
      });
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });

  // ── Panel: Entity lookup (survivor+) — lightweight reference data for info popups ──
  app.get('/api/panel/lookup/:type/:name', requireTier('survivor'), rateLimit(5000, 20), (req, res) => {
    const srv = req.srv;
    if (!srv.db) return res.json({ found: false });
    const type = req.params.type as string;
    const name = decodeURIComponent((req.params.name as string) || '');
    if (!name) return res.json({ found: false });

    const result: Record<string, unknown> = { found: false, type, name, data: {} };

    try {
      // Route by type to appropriate reference/world table
      if (type === 'item') {
        const row = srv.db.gameData.findByName('game_items', name);
        if (row) {
          result.found = true;
          result.data = row;
          result.refTable = 'game_items';
        }
      } else if (type === 'structure' || type === 'building') {
        const row = srv.db.gameData.findByName('game_buildings', name);
        if (row) {
          result.found = true;
          result.data = row;
          result.refTable = 'game_buildings';
        }
        if (!result.found) {
          const wRow = srv.db.worldObject.findStructureByName(name);
          if (wRow) {
            result.found = true;
            result.data = wRow;
            result.refTable = 'structures';
          }
        }
      } else if (type === 'vehicle') {
        const row = srv.db.gameData.findByName('game_vehicles_ref', name);
        if (row) {
          result.found = true;
          result.data = row;
          result.refTable = 'game_vehicles_ref';
        }
      } else if (type === 'animal') {
        const row = srv.db.gameData.findByName('game_animals', name);
        if (row) {
          result.found = true;
          result.data = row;
          result.refTable = 'game_animals';
        }
      } else if (type === 'recipe') {
        const row = srv.db.gameData.findByName('game_recipes', name);
        if (row) {
          result.found = true;
          result.data = row;
          result.refTable = 'game_recipes';
        }
      } else if (type === 'affliction') {
        const row = srv.db.gameData.findByName('game_afflictions', name);
        if (row) {
          result.found = true;
          result.data = row;
          result.refTable = 'game_afflictions';
        }
      } else if (type === 'profession') {
        const row = srv.db.gameData.findByName('game_professions', name);
        if (row) {
          result.found = true;
          result.data = row;
          result.refTable = 'game_professions';
        }
      } else if (type === 'skill') {
        const row = srv.db.gameData.findByName('game_skills', name);
        if (row) {
          result.found = true;
          result.data = row;
          result.refTable = 'game_skills';
        }
      } else if (type === 'container') {
        const row = srv.db.worldObject.findContainerByName(name);
        if (row) {
          result.found = true;
          result.data = row;
          result.refTable = 'containers';
        }
      }

      // Fallback: try game_items for anything not found
      if (!result.found) {
        const fallback = srv.db.gameData.findByName('game_items', name);
        if (fallback) {
          result.found = true;
          result.data = fallback;
          result.refTable = 'game_items';
        }
      }

      // Count activity log references
      result.activityCount = srv.db.activityLog.countByTextSearch(`%${name}%`);

      res.json(result);
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });
}
