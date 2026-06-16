/**
 * Player-facing routes: all player positions, single player detail, the
 * admin full-save snapshot, and the RCON online player list.
 *
 * Behavior-preserving extraction from web-map/server.ts (P1-1 god-file split).
 * Handlers are verbatim; only `this.` -> `ctx.` was applied.
 */
import type { Express } from 'express';
import type { WebMapRouteContext } from '../types/route-context.js';
import { requireTier } from '../auth.js';
import { rateLimit } from '../rate-limit.js';
import { API_ERRORS, sendError } from '../api-errors.js';
import { safeError, _requestLocale, _isoTimestamp, _cleanInventorySlots } from '../route-helpers.js';
import { normalizePlayerHorses, PERK_MAP } from '../../parsers/save-parser.js';
import { AFFLICTION_MAP } from '../../parsers/game-data.js';
import { cleanItemName } from '../../parsers/ue4-names.js';
import { resolveItemArray } from '../../i18n/item-names.js';

export function registerPlayersRoutes(app: Express, ctx: WebMapRouteContext): void {
  // ── API: Get all player positions ──
  app.get('/api/players', requireTier('survivor'), rateLimit(10000, 10), async (req, res) => {
    const srv = req.srv;
    const itemLocale = _requestLocale(req);

    // Resolve data sources based on server
    const players = srv.isPrimary ? ctx._parseSaveData() : ctx._parseSaveDataForServer(srv.dataDir);
    const dbNameMap = srv.playerNameMap;
    const logStatsProvider = srv.playerStats;
    const playtimeProvider = srv.playtime;

    // Query RCON for online players (non-blocking — if it fails, all show offline)
    const onlineSteamIds = new Set();
    const onlineNameMap = new Map<string, string>();
    try {
      const list = await srv.getPlayerList();
      const playerArr = list.players;
      for (const p of playerArr) {
        onlineSteamIds.add(p.steamId);
        const onlineName = ctx._cleanPlayerDisplayName(p.name);
        if (onlineName) onlineNameMap.set(p.steamId, onlineName);
      }
    } catch {
      /* RCON unavailable — all players show offline */
    }

    // Build clan membership lookup from DB
    const clanLookup: Record<string, { clanName: string; rank: string }> = {}; // steamId → { clanName, rank }
    if (srv.db) {
      try {
        const clans = srv.db.clan.getAllClans();
        for (const clan of clans as unknown as Array<{
          // SAFETY: getAllClans() DbRow preserves steam_id at runtime
          name: string;
          members?: Array<{ steam_id: string; rank: string }>;
        }>) {
          for (const m of clan.members || []) {
            clanLookup[m.steam_id] = { clanName: clan.name, rank: m.rank };
          }
        }
      } catch {
        /* clan data unavailable */
      }
    }

    // save_last_login fallback (covers caches that omit lastLogin)
    const saveLoginMap = new Map<string, string>();
    if (srv.db) {
      try {
        for (const r of srv.db.player.getSaveLastLogins()) {
          saveLoginMap.set(r.steam_id as string, r.save_last_login as string);
        }
      } catch {
        /* pre-v24 DB */
      }
    }

    const result = [];

    for (const [steamId, rawData] of players) {
      const data = rawData as Record<string, unknown>;
      const dx = data.x as number | null;
      const dy = data.y as number | null;
      const dz = data.z as number | null;
      const hasPosition = dx !== null && !(dx === 0 && dy === 0 && dz === 0);

      const name = ctx._resolvePlayerDisplayName(steamId, data, srv.db, dbNameMap, onlineNameMap);
      let lat = null,
        lng = null;
      if (hasPosition) {
        [lat, lng] = ctx._worldToLeaflet(dx, dy as number);
      }

      // Get log-based stats
      const logStats = logStatsProvider.getStats(steamId) || logStatsProvider.getStatsByName(name);

      // Get playtime
      const ptData = playtimeProvider.getPlaytime(steamId);

      // Resolve profession display name from enum code
      const professionName = PERK_MAP[data.startingPerk as string] || (data.startingPerk as string) || 'Unknown';

      result.push({
        steamId,
        name,
        hasPosition,
        lat,
        lng,
        worldX: hasPosition ? Math.round(dx) : null,
        worldY: hasPosition ? Math.round(dy as number) : null,
        worldZ: hasPosition ? Math.round(dz as number) : null,
        isOnline: onlineSteamIds.has(steamId),

        // Character
        male: data.male,
        profession: professionName,
        affliction: AFFLICTION_MAP[data.affliction as number] || 'Unknown',
        unlockedProfessions: ((data.unlockedProfessions as unknown[] | undefined) ?? []).map(
          (p: unknown) => PERK_MAP[p as string] || p,
        ),

        // Current-life kill stats
        zeeksKilled: data.zeeksKilled || 0,
        headshots: data.headshots || 0,
        meleeKills: data.meleeKills || 0,
        gunKills: data.gunKills || 0,
        blastKills: data.blastKills || 0,
        fistKills: data.fistKills || 0,
        takedownKills: data.takedownKills || 0,
        vehicleKills: data.vehicleKills || 0,

        // Lifetime kill stats
        lifetimeKills: data.lifetimeKills || 0,
        lifetimeHeadshots: data.lifetimeHeadshots || 0,
        lifetimeMeleeKills: data.lifetimeMeleeKills || 0,
        lifetimeGunKills: data.lifetimeGunKills || 0,
        lifetimeBlastKills: data.lifetimeBlastKills || 0,
        lifetimeFistKills: data.lifetimeFistKills || 0,
        lifetimeTakedownKills: data.lifetimeTakedownKills || 0,
        lifetimeVehicleKills: data.lifetimeVehicleKills || 0,
        lifetimeDaysSurvived: data.lifetimeDaysSurvived || 0,
        hasExtendedStats: data.hasExtendedStats || false,

        // Survival
        daysSurvived: data.daysSurvived || 0,
        timesBitten: data.timesBitten || 0,
        fishCaught: data.fishCaught || 0,
        fishCaughtPike: data.fishCaughtPike || 0,
        exp: data.exp || 0,
        level: data.level || 0,
        expCurrent: data.expCurrent || 0,
        expRequired: data.expRequired || 0,
        skillsPoint: data.skillsPoint || 0,

        // Vitals
        health: data.health,
        maxHealth: data.maxHealth,
        hunger: data.hunger,
        maxHunger: data.maxHunger,
        thirst: data.thirst,
        maxThirst: data.maxThirst,
        stamina: data.stamina,
        maxStamina: data.maxStamina,
        infection: data.infection,
        maxInfection: data.maxInfection,
        battery: data.battery,
        fatigue: data.fatigue,
        infectionBuildup: data.infectionBuildup,

        // Status effects (cleaned)
        playerStates: ((data.playerStates as unknown[] | undefined) ?? []).map((s: unknown) =>
          cleanItemName(s as string),
        ),
        bodyConditions: ((data.bodyConditions as unknown[] | undefined) ?? []).map((s: unknown) =>
          cleanItemName(s as string),
        ),

        // Inventory (server-side cleaned, locale-aware)
        equipment: _cleanInventorySlots((data.equipment as unknown[] | undefined) ?? [], itemLocale),
        quickSlots: _cleanInventorySlots((data.quickSlots as unknown[] | undefined) ?? [], itemLocale),
        inventory: _cleanInventorySlots((data.inventory as unknown[] | undefined) ?? [], itemLocale),
        backpackItems: _cleanInventorySlots((data.backpackItems as unknown[] | undefined) ?? [], itemLocale),

        // Recipes & skills (cleaned — resolveItemArray filters out hex GUIDs
        // and localizes table-backed item names)
        craftingRecipes: resolveItemArray((data.craftingRecipes as unknown[] | undefined) ?? [], itemLocale),
        buildingRecipes: resolveItemArray((data.buildingRecipes as unknown[] | undefined) ?? [], itemLocale),
        unlockedSkills: resolveItemArray((data.unlockedSkills as unknown[] | undefined) ?? [], itemLocale),

        // Lore
        lore: (data.lore as unknown[] | undefined) ?? [],
        uniqueLoots: resolveItemArray((data.uniqueLoots as unknown[] | undefined) ?? [], itemLocale),
        craftedUniques: resolveItemArray((data.craftedUniques as unknown[] | undefined) ?? [], itemLocale),

        // Companions (cleaned)
        companionData: ((data.companionData as Record<string, unknown>[] | undefined) ?? []).map(
          (c: Record<string, unknown>) =>
            typeof c === 'object'
              ? { ...c, type: cleanItemName((c.type as string | undefined) ?? '') }
              : cleanItemName(c as string),
        ),
        horses: normalizePlayerHorses(data.horses),

        // Log-derived stats
        deaths: logStats?.deaths || 0,
        pvpKills: logStats?.pvpKills || 0,
        pvpDeaths: logStats?.pvpDeaths || 0,
        builds: logStats?.builds || 0,
        containersLooted: logStats?.containersLooted || 0,
        raidsOut: logStats?.raidsOut || 0,
        raidsIn: logStats?.raidsIn || 0,
        connects: logStats?.connects || 0,

        // Clan
        clanName: clanLookup[steamId]?.clanName || null,
        clanRank: clanLookup[steamId]?.rank || null,

        // Playtime
        totalPlaytime: ptData ? Math.floor(ptData.totalMs / 60000) : 0,
        lastSeen: ptData?.lastSeen || null,
        // Save-authoritative last login (game save LastLogin, UTC ISO)
        saveLastLogin: _isoTimestamp(data.lastLogin, saveLoginMap.get(steamId)),
      });
    }

    res.json({
      server: srv.serverId,
      players: result,
      worldBounds: ctx._worldBounds,
      toggles: ctx._getToggles(),
      lastUpdated: new Date().toISOString(),
    });
  });

  // ── API: Get single player detail ──
  app.get('/api/players/:steamId', requireTier('survivor'), (req, res) => {
    const srv = req.srv;
    const steamId = req.params.steamId as string;
    const players = srv.isPrimary ? ctx._parseSaveData() : ctx._parseSaveDataForServer(srv.dataDir);
    const storedDetail = srv.db?.player.getPlayerDetail(steamId);
    const storedSnapshot =
      storedDetail && typeof storedDetail['snapshot'] === 'object' && storedDetail['snapshot'] !== null
        ? (storedDetail['snapshot'] as Record<string, unknown>)
        : null;
    const rawPlayerData = players.get(steamId) ?? storedSnapshot;
    if (!rawPlayerData) {
      sendError(res, API_ERRORS.PLAYER_NOT_FOUND, 404);
      return;
    }
    const data = rawPlayerData as Record<string, unknown>;
    const storedHasSaveSnapshot: boolean | null = storedDetail
      ? storedDetail['has_save_snapshot'] === true || storedDetail['has_save_snapshot'] === 1
      : null;
    const hasSaveSnapshot =
      storedHasSaveSnapshot ?? (data['hasSaveSnapshot'] !== false && data['hasSaveSnapshot'] !== 0);
    const lastSaveSnapshotAt = storedDetail
      ? hasSaveSnapshot
        ? (storedDetail['last_save_snapshot_at'] ?? storedDetail['updated_at'] ?? null)
        : null
      : (data['lastSaveSnapshotAt'] ?? null);

    const dbNameMap = srv.playerNameMap;
    const name = ctx._resolvePlayerDisplayName(steamId, data, srv.db, dbNameMap);
    const pdx = data.x as number | null;
    const pdy = data.y as number | null;
    const pdz = data.z as number | null;
    const hasPosition = pdx !== null && !(pdx === 0 && pdy === 0 && pdz === 0);
    let lat = null,
      lng = null;
    if (hasPosition) {
      [lat, lng] = ctx._worldToLeaflet(pdx, pdy as number);
    }

    // Resolve display names
    const professionName = PERK_MAP[data.startingPerk as string] || (data.startingPerk as string) || 'Unknown';
    const logStats = srv.playerStats.getStats(steamId) || srv.playerStats.getStatsByName(name);
    const ptData = srv.playtime.getPlaytime(steamId);

    res.json({
      steamId: req.params.steamId,
      name,
      hasPosition,
      lat,
      lng,
      worldX: pdx,
      worldY: pdy,
      worldZ: pdz,
      profession: professionName,
      affliction: AFFLICTION_MAP[data.affliction as number] || 'Unknown',
      unlockedProfessions: ((data.unlockedProfessions as unknown[] | undefined) ?? []).map(
        (p: unknown) => PERK_MAP[p as string] || p,
      ),
      ...data,
      // Override raw enum values with resolved names
      startingPerk: professionName,
      // Normalize agent-v4 raw GVAS horse arrays from older snapshots
      horses: normalizePlayerHorses(data.horses),
      // Save-authoritative last login: cache value first, then the players
      // column (which survives syncs that omit lastLogin via COALESCE)
      saveLastLogin: _isoTimestamp(data.lastLogin, storedDetail?.['save_last_login']),
      // Log-derived
      deaths: logStats?.deaths || 0,
      pvpKills: logStats?.pvpKills || 0,
      pvpDeaths: logStats?.pvpDeaths || 0,
      builds: logStats?.builds || 0,
      containersLooted: logStats?.containersLooted || 0,
      raidsOut: logStats?.raidsOut || 0,
      raidsIn: logStats?.raidsIn || 0,
      connects: logStats?.connects || 0,
      // Playtime
      totalPlaytime: ptData ? Math.floor(ptData.totalMs / 60000) : 0,
      lastSeen: ptData?.lastSeen || null,
      // Save-backed marker is a presentation gate for vitals/detail availability.
      // Prefer the DB marker when reading from player_details; cache-only rows fall back to cache metadata.
      hasSaveSnapshot,
      lastSaveSnapshotAt,
      // Toggles for conditional display
      toggles: ctx._getToggles(),
    });
  });

  // ── Panel: Get latest full player save snapshot (admin) ──
  app.get('/api/panel/players/:steamId/snapshot', requireTier('admin'), rateLimit(10000, 15), (req, res) => {
    const steamId = req.params.steamId as string;
    const detail = req.srv.db?.player.getPlayerDetail(steamId);
    if (!detail) {
      sendError(res, API_ERRORS.PLAYER_NOT_FOUND, 404);
      return;
    }
    const hasSaveSnapshot = detail['has_save_snapshot'] === true || detail['has_save_snapshot'] === 1;

    res.json({
      steamId,
      hasSaveSnapshot,
      lastSaveSnapshotAt: detail['last_save_snapshot_at'] ?? null,
      snapshot: detail['snapshot'] ?? {},
      metadata: {
        sourceFile: detail['source_file'] ?? null,
        sourceMtimeMs: detail['source_mtime_ms'] ?? null,
        sourceSize: detail['source_size'] ?? null,
        cacheVersion: detail['cache_version'] ?? null,
        agentVersion: detail['agent_version'] ?? null,
        parserSignature: detail['parser_signature'] ?? null,
        updatedAt: detail['updated_at'] ?? null,
      },
    });
  });
  // ── API: Get RCON player list (online status) ──
  app.get('/api/online', requireTier('survivor'), async (req, res) => {
    // Serve from background-polled player cache — instant response
    const cached = ctx._getCached('online', req.srv.serverId, 30000) as Record<string, unknown> | null;
    if (cached) return res.json({ players: cached });
    try {
      const list = await req.srv.getPlayerList();
      ctx._setCache('online', req.srv.serverId, list);
      res.json({ players: list });
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });
}
