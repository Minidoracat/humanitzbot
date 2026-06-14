/**
 * Database panel routes: table list with row counts, ad-hoc admin query, and
 * generic per-table browse. Registered tables + query before the :table param
 * route so literal paths match first.
 *
 * Behavior-preserving extraction from web-map/server.ts (P1-1 god-file split).
 * Handlers are verbatim; only `this.` -> `ctx.` was applied.
 */
import type { Express } from 'express';
import type { WebMapRouteContext } from '../types/route-context.js';
import { requireTier } from '../auth.js';
import { rateLimit } from '../rate-limit.js';
import { API_ERRORS, sendError } from '../api-errors.js';
import { safeError, sendErrorWithData } from '../route-helpers.js';
import type { DbRow } from '../types/db-rows.js';

export function registerDbRoutes(app: Express, ctx: WebMapRouteContext): void {
  // ── Panel: DB table list with row counts ──
  app.get('/api/panel/db/tables', requireTier('admin'), rateLimit(10000, 5), (req, res) => {
    const srv = req.srv;
    if (!srv.db) return res.json({ tables: [] });

    const ALLOWED = new Set([
      'activity_log',
      'chat_log',
      'players',
      'player_aliases',
      'clans',
      'clan_members',
      'world_state',
      'structures',
      'vehicles',
      'companions',
      'world_horses',
      'dead_bodies',
      'containers',
      'loot_actors',
      'quests',
      'server_settings',
      'snapshots',
      // 'game_items',
      'game_professions',
      'game_afflictions',
      'game_skills',
      'game_challenges',
      'game_recipes',
      'item_instances',
      'item_movements',
      'item_groups',
      'world_drops',
      'game_buildings',
      'game_loot_pools',
      'game_loot_pool_items',
      'game_vehicles_ref',
      'game_animals',
      'game_crops',
      'game_car_upgrades',
      'game_ammo_types',
      'game_repair_data',
      'game_furniture',
      'game_traps',
      'game_sprays',
      'game_quests',
      'game_lore',
      'game_loading_tips',
      'game_spawn_locations',
      'game_server_setting_defs',
    ]);

    try {
      const allTables = srv.db.rawQuery(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        [],
        { ctx: 'admin:list-tables' },
      ) as Array<{ name: string }>;
      const tables = [];

      for (const t of allTables) {
        if (!ALLOWED.has(t.name)) continue;
        try {
          const row = srv.db.rawQuery(`SELECT COUNT(*) as c FROM "${t.name}"`, [], {
            ctx: 'admin:table-count',
            mode: 'get',
          }) as { c: number } | undefined;
          const cols = srv.db.rawQuery(`PRAGMA table_info("${t.name}")`, [], { ctx: 'admin:table-info' }) as Array<{
            name: string;
            type: string;
            pk: number;
            notnull: number;
          }>;
          tables.push({
            name: t.name,
            rowCount: row?.c || 0,
            columns: cols.map((c) => ({
              name: c.name,
              type: c.type,
              pk: c.pk === 1,
              nullable: c.notnull === 0,
            })),
          });
        } catch {
          /* skip inaccessible tables */
        }
      }

      res.json({ tables });
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });

  // ── Panel: Raw SQL query (SELECT only, admin) ──
  app.post('/api/panel/db/query', requireTier('admin'), rateLimit(10000, 5), (req, res) => {
    const srv = req.srv;
    if (!srv.db) {
      sendErrorWithData(res, API_ERRORS.NO_DATABASE, { rows: [], columns: [] });
      return;
    }

    const body = req.body as { sql?: string; limit?: string | number };
    const sql = (body.sql || '').trim();
    if (!sql) {
      sendError(res, API_ERRORS.NO_SQL_PROVIDED, 400);
      return;
    }

    // Only allow SELECT statements
    const upper = sql
      .replace(/\/\*[^*]*(?:\*(?!\/)[^*]*)*\*\//g, '')
      .replace(/--[^\n]*/g, '')
      .trim()
      .toUpperCase();
    if (!upper.startsWith('SELECT')) {
      sendError(res, API_ERRORS.ONLY_SELECT_ALLOWED, 400);
      return;
    }
    // Block dangerous keywords after SELECT
    if (/\b(DROP|DELETE|INSERT|UPDATE|ALTER|CREATE|ATTACH|DETACH|REPLACE|PRAGMA\s+\w+\s*=)\b/i.test(sql)) {
      sendError(res, API_ERRORS.QUERY_CONTAINS_DISALLOWED_KEYWORDS, 400);
      return;
    }

    const limit = Math.min(parseInt(String(body.limit ?? '200'), 10) || 200, 1000);

    try {
      // Wrap in a limited query if no LIMIT clause
      let query = sql;
      if (!/\bLIMIT\b/i.test(sql)) {
        query = sql.replace(/;?\s*$/, '') + ' LIMIT ' + String(limit);
      }

      const rows = srv.db.rawQuery(query, [], { ctx: 'admin:run-query' });
      const columns = rows.length > 0 ? Object.keys(rows[0] ?? {}) : [];

      res.json({ rows, columns, count: rows.length });
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 400, safeError(err));
    }
  });
  // ── Panel: Comprehensive DB query (admin only) ──
  app.get('/api/panel/db/:table', requireTier('admin'), rateLimit(10000, 15), (req, res) => {
    const srv = req.srv;
    if (!srv.db) return res.json({ rows: [], columns: [] });

    const table = req.params.table as string;
    // Defense-in-depth: validate table name is alphanumeric + underscores only
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
      sendError(res, API_ERRORS.INVALID_TABLE_NAME, 400);
      return;
    }
    const limit = Math.min(parseInt((req.query.limit as string) || '', 10) || 50, 1000);
    const search = (req.query.search as string) || '';

    // Whitelist of queryable tables
    const ALLOWED = new Set([
      'activity_log',
      'chat_log',
      'players',
      'player_aliases',
      'clans',
      'clan_members',
      'world_state',
      'structures',
      'vehicles',
      'companions',
      'world_horses',
      'dead_bodies',
      'containers',
      'loot_actors',
      'quests',
      'server_settings',
      'snapshots',
      // 'game_items',
      'game_professions',
      'game_afflictions',
      'game_skills',
      'game_challenges',
      'game_recipes',
      'item_instances',
      'item_movements',
      'item_groups',
      'world_drops',
      // v11 reference tables
      'game_buildings',
      'game_loot_pools',
      'game_loot_pool_items',
      'game_vehicles_ref',
      'game_animals',
      'game_crops',
      'game_car_upgrades',
      'game_ammo_types',
      'game_repair_data',
      'game_furniture',
      'game_traps',
      'game_sprays',
      'game_quests',
      'game_lore',
      'game_loading_tips',
      'game_spawn_locations',
      'game_server_setting_defs',
    ]);

    if (!ALLOWED.has(table)) {
      sendError(res, API_ERRORS.TABLE_NOT_QUERYABLE, 400, table);
      return;
    }
    // Defense-in-depth: validate table name is a safe SQL identifier
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
      sendError(res, API_ERRORS.INVALID_TABLE_NAME, 400);
      return;
    }

    try {
      // Get column names
      const pragma = srv.db.rawQuery(`PRAGMA table_info("${table}")`, [], {
        ctx: 'admin:pragma',
      }) as Array<{ name: string; type: string }>;
      const columns = pragma.map((c) => c.name);

      // Build query with optional search
      let query = `SELECT * FROM "${table}"`;
      const params = [];

      if (search) {
        // Search across text columns
        const textCols = pragma.filter(
          (c) => c.type.toUpperCase().includes('TEXT') || c.type === '' || c.type.toUpperCase().includes('VARCHAR'),
        );
        if (textCols.length > 0) {
          const clauses = textCols.map((c) => `"${c.name}" LIKE ?`);
          query += ` WHERE ${clauses.join(' OR ')}`;
          for (let i = 0; i < textCols.length; i++) params.push(`%${search}%`);
        }
      }

      // Order by most recent first if created_at or updated_at exists
      if (columns.includes('created_at')) query += ' ORDER BY created_at DESC';
      else if (columns.includes('updated_at')) query += ' ORDER BY updated_at DESC';
      else if (columns.includes('id')) query += ' ORDER BY id DESC';

      query += ` LIMIT ?`;
      params.push(limit);

      const rows = srv.db.rawQuery(query, params, { ctx: 'admin:run-query-params' }) as DbRow[];

      // Resolve steam IDs in player-related tables
      if (columns.includes('steam_id') || columns.includes('owner_steam_id')) {
        for (const row of rows) {
          const sid = (row.steam_id || row.owner_steam_id) as string;
          const resolvedName = ctx._resolveServerPlayerName(srv, sid);
          if (sid && resolvedName && !row.name && !row.actor_name && !row.player_name) {
            row._resolved_name = resolvedName;
          }
        }
      }

      res.json({ table, columns, rows, total: rows.length });
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });
}
