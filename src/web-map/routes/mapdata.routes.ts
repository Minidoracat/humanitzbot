/**
 * Map-data panel routes: clan list and the consolidated world map data
 * (structures, vehicles, containers, companions, dead bodies, quests).
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
import { cleanName as cleanActorName } from '../../parsers/ue4-names.js';
import type { StructureRow, VehicleRow, ContainerRow, CompanionRow, DeadBodyRow, QuestRow } from '../types/db-rows.js';

export function registerMapdataRoutes(app: Express, ctx: WebMapRouteContext): void {
  // ── Panel: Clans from DB ──
  app.get('/api/panel/clans', requireTier('survivor'), (req, res) => {
    const srv = req.srv;
    if (!srv.db) return res.json({ clans: [] });

    try {
      const clans = srv.db.clan.getAllClans();
      res.json({ clans });
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });

  // ── Panel: Map world data (structures, vehicles, containers, companions, dead bodies) ──
  // Gated at 'mod' to match the Live Map UI tier (data-min-tier="2"). This payload exposes
  // griefing-sensitive intel — structure owner SteamIDs, base/container locations and item
  // counts — so it must NOT be reachable by tier-1 survivors via a direct API call.
  app.get('/api/panel/mapdata', requireTier('mod'), rateLimit(10000, 10), (req, res) => {
    const srv = req.srv;
    if (!srv.db) return res.json({ structures: [], vehicles: [], containers: [], companions: [], deadBodies: [] });

    const layers = ((req.query.layers as string) || 'all').split(',');
    const showAll = layers.includes('all');
    const result: Record<string, unknown> = {};

    try {
      if (showAll || layers.includes('structures')) {
        const rows = srv.db.worldObject.getPositionedStructures() as StructureRow[];
        result.structures = rows.map((r: StructureRow) => {
          const [lat, lng] = ctx._worldToLeaflet(r.pos_x, r.pos_y);
          let itemCount = 0;
          try {
            const items = JSON.parse(r.inventory || '[]') as unknown[];
            itemCount = items.filter((i: unknown) => i && i !== 'Empty' && i !== 'None').length;
          } catch {}
          return {
            id: r.id,
            name: r.display_name || cleanActorName(r.actor_class),
            owner: r.owner_steam_id,
            lat,
            lng,
            health: r.current_health,
            maxHealth: r.max_health,
            upgrade: r.upgrade_level,
            itemCount,
          };
        });
      }

      if (showAll || layers.includes('vehicles')) {
        const rows = srv.db.worldObject.getPositionedVehicles() as VehicleRow[];
        result.vehicles = rows.map((r: VehicleRow) => {
          const [lat, lng] = ctx._worldToLeaflet(r.pos_x, r.pos_y);
          return {
            id: r.id,
            name: r.display_name || cleanActorName(r.class),
            lat,
            lng,
            health: r.health,
            maxHealth: r.max_health,
            fuel: Math.round(r.fuel * 10) / 10,
          };
        });
      }

      if (showAll || layers.includes('containers')) {
        const rows = srv.db.worldObject.getPositionedContainers() as ContainerRow[];
        result.containers = rows.map((r: ContainerRow) => {
          const [lat, lng] = ctx._worldToLeaflet(r.pos_x, r.pos_y);
          let itemCount = 0;
          try {
            const items = JSON.parse(r.items || '[]') as unknown[];
            itemCount = items.filter(
              (i: unknown) =>
                i &&
                typeof i === 'object' &&
                (i as Record<string, unknown>).item &&
                (i as Record<string, unknown>).item !== 'None' &&
                (i as Record<string, unknown>).item !== 'Empty',
            ).length;
          } catch {}
          return { name: cleanActorName(r.actor_name), lat, lng, locked: !!r.locked, itemCount };
        });
      }

      if (showAll || layers.includes('companions')) {
        const rows = srv.db.worldObject.getPositionedCompanions() as CompanionRow[];
        result.companions = rows.map((r: CompanionRow) => {
          const [lat, lng] = ctx._worldToLeaflet(r.pos_x, r.pos_y);
          return { id: r.id, type: r.type, owner: r.owner_steam_id, lat, lng, health: r.health };
        });
      }

      if (showAll || layers.includes('deadBodies')) {
        const rows = srv.db.worldObject.getPositionedDeadBodies() as DeadBodyRow[];
        result.deadBodies = rows.map((r: DeadBodyRow) => {
          const [lat, lng] = ctx._worldToLeaflet(r.pos_x, r.pos_y);
          return { name: r.actor_name, lat, lng };
        });
      }

      if (showAll || layers.includes('quests')) {
        // SAFETY: getPositionedQuests() returns DbRow[] (Record<string, unknown>); single `as QuestRow[]` fails TS2352, runtime shape is SELECT * from quests
        const rows = srv.db.quest.getPositionedQuests() as unknown as QuestRow[];
        result.quests = rows.map((r: QuestRow) => {
          const [lat, lng] = ctx._worldToLeaflet(r.pos_x, r.pos_y);
          // The quests' readable names and timestamps live in the time map:
          // { questName: ISO timestamp } — GUID ids carry no display value.
          // One row can hold several quests sharing a transform.
          let entries: Array<{ name: string; time: string | null }> = [];
          try {
            const timeMap = JSON.parse(r.time || '{}') as Record<string, string | null>;
            entries = Object.entries(timeMap).map(([name, time]) => ({ name, time: time ?? null }));
          } catch {}
          let itemCount = 0;
          try {
            const items = JSON.parse(r.items || '[]') as unknown[];
            itemCount = items.filter(
              (i: unknown) =>
                i &&
                typeof i === 'object' &&
                (i as Record<string, unknown>).item &&
                (i as Record<string, unknown>).item !== 'None' &&
                (i as Record<string, unknown>).item !== 'Empty',
            ).length;
          } catch {}
          const first = entries[0];
          return { id: r.id, name: first?.name ?? '', time: first?.time ?? null, entries, lat, lng, itemCount };
        });
      }

      // AI layers from latest timeline snapshot
      const wantAI = showAll || layers.includes('zombies') || layers.includes('animals') || layers.includes('bandits');
      if (wantAI) {
        try {
          const latestSnapId = srv.db.timeline.getLatestTimelineSnapshotId();
          if (latestSnapId) {
            const aiRows = srv.db.timeline.getTimelineAIForMap(latestSnapId) as Array<{
              ai_type: string;
              category: string;
              display_name: string;
              pos_x: number;
              pos_y: number;
            }>;
            const zombies = [],
              animals = [],
              bandits = [];
            for (const r of aiRows) {
              if (r.pos_x === 0 && r.pos_y === 0) continue;
              const [lat, lng] = ctx._worldToLeaflet(r.pos_x, r.pos_y);
              const entry = { name: r.display_name || cleanActorName(r.ai_type), lat, lng, type: r.ai_type };
              if (r.category === 'zombie') zombies.push(entry);
              else if (r.category === 'animal') animals.push(entry);
              else if (r.category === 'bandit') bandits.push(entry);
            }
            if (showAll || layers.includes('zombies')) result.zombies = zombies;
            if (showAll || layers.includes('animals')) result.animals = animals;
            if (showAll || layers.includes('bandits')) result.bandits = bandits;
          }
        } catch {
          /* timeline_ai may not exist yet */
        }
      }

      // Build steam_id → name lookup for owner resolution
      const nameMap: Record<string, string> = {};
      const nameRows = srv.db.player.listAllPlayerNames();
      for (const nr of nameRows) nameMap[nr.steam_id] = nr.name;
      result.nameMap = nameMap;

      res.json(result);
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });
}
