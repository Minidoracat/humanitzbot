/**
 * Snapshot Service — captures full world state on each save poll cycle.
 *
 * Records temporal data (player positions, AI spawns, vehicles, structures,
 * houses, companions, backpacks, weather) to timeline_* DB tables. This
 * enables time-scroll playback on the live map and historical analytics.
 *
 * Hooks into the save poll cycle via `recordSnapshot(saveData)` — called
 * by PlayerStatsChannel after each successful save parse.
 *
 * @module snapshot-service
 */

import { createHash } from 'node:crypto';
import { cleanName } from '../parsers/ue4-names.js';
import { createLogger, type Logger } from '../utils/log.js';
import { createStructuredLogger } from '../logger/logger.js';
import { errMsg } from '../utils/error.js';
import config from '../config/index.js';
import type { HumanitZDB } from '../db/database.js';

// ── AI type → display name mapping ──────────────────────────

const AI_DISPLAY_NAMES: Record<string, string> = {
  // Zombies
  ZombieDefault: 'Zombie',
  ZombieDefault2: 'Zombie',
  ZombieFemale: 'Female Zombie',
  ZombieFemale2: 'Female Zombie',
  ZombieUrban: 'Urban Zombie',
  ZombieRunner: 'Runner',
  ZombieBrute: 'Brute',
  ZombieFatty: 'Bloater',
  ZombieBellyToxic: 'Bloater',
  ZombieMutant: 'Mutant',
  ZombieCop: 'Police Zombie',
  ZombiePolice1: 'Police Zombie',
  ZombiePolice2: 'Police Zombie',
  ZombiePoliceArmor: 'Police Armoured',
  ZombieMilitaryArmor: 'Military Armoured',
  ZombieMilitaryArmorV2: 'Military Armoured V2',
  ZombieCamo: 'Camo Zombie',
  ZombieHazmat: 'Hazmat Zombie',
  ZombieMedic: 'Medic Zombie',
  ZombieBruteRunner: 'Runner Brute',
  ZombieBruteComp: 'Brute',
  ZombieBruteCop: 'Riot Brute',

  // Zombie animals
  AnimalZDog: 'Dog Zombie',
  AnimalZBear: 'Zombie Bear',
  AnimalZStag: 'Zombie Stag',

  // Animals
  AnimalWold: 'Wolf', // typo in game data
  AnimalBear: 'Bear',
  AnimalRabbit: 'Rabbit',
  AnimalPig: 'Pig',
  AnimalStag: 'Stag',
  AnimalDoe: 'Doe',
  AnimalChicken: 'Chicken',

  // Bandits
  BanditPistol: 'Bandit (Pistol)',
  BanditMelee: 'Bandit (Melee)',
  BanditShotgun: 'Bandit (Shotgun)',
  BanditRifle: 'Bandit (Rifle)',
  BanditSniper: 'Bandit (Sniper)',
};

interface SnapshotHeader {
  gameDay: number;
  gameTime: number;
  playerCount: number;
  onlineCount: number;
  aiCount: number;
  structureCount: number;
  vehicleCount: number;
  containerCount: number;
  worldItemCount: number;
  weatherType: string;
  season: string;
  airdropActive: boolean;
  airdropX: number | null;
  airdropY: number | null;
  airdropAiAlive: number;
  summary: Record<string, unknown>;
}

interface TimelinePlayer {
  steamId: string;
  name: string;
  online: number;
  x: number | null;
  y: number | null;
  z: number | null;
  health: number;
  maxHealth: number;
  hunger: number;
  thirst: number;
  infection: number;
  stamina: number;
  level: number;
  zeeksKilled: number;
  daysSurvived: number;
  lifetimeKills: number;
}

interface TimelineAI {
  aiType: string;
  category: string;
  displayName: string;
  nodeUid: string;
  x: number | null;
  y: number | null;
  z: number | null;
}

interface TimelineVehicle {
  class: string;
  displayName: string;
  x: number | null;
  y: number | null;
  z: number | null;
  health: number;
  maxHealth: number;
  fuel: number;
  itemCount: number;
}

interface TimelineStructure {
  actorClass: string;
  displayName: string;
  ownerSteamId: string;
  x: number | null;
  y: number | null;
  z: number | null;
  currentHealth: number;
  maxHealth: number;
  upgradeLevel: number;
}

interface TimelineHouse {
  uid: string;
  name: string;
  windowsOpen: number;
  windowsTotal: number;
  doorsOpen: number;
  doorsLocked: number;
  doorsTotal: number;
  destroyedFurniture: number;
  hasGenerator: boolean;
  sleepers: number;
  clean: number;
  x: null;
  y: null;
}

interface TimelineCompanion {
  entityType: string;
  actorName: string;
  displayName: string;
  ownerSteamId: string;
  x: number | null;
  y: number | null;
  z: number | null;
  health: number;
  extra: Record<string, unknown>;
}

interface TimelineBackpack {
  class: string;
  x: number | null;
  y: number | null;
  z: number | null;
  itemCount: number;
  items: { item: string; amount: number }[];
}

// Loose save-data shapes — save-parser is not yet migrated
type SaveEntity = Record<string, unknown>;

interface SaveData {
  players?: Map<string, SaveEntity> | Record<string, SaveEntity> | SaveEntity[];
  worldState?: Record<string, unknown>;
  vehicles?: Map<string, SaveEntity> | Record<string, SaveEntity> | SaveEntity[];
  structures?: Map<string, SaveEntity> | Record<string, SaveEntity> | SaveEntity[];
  containers?: Map<string, SaveEntity> | Record<string, SaveEntity> | SaveEntity[];
  companions?: Map<string, SaveEntity> | Record<string, SaveEntity> | SaveEntity[];
  horses?: Map<string, SaveEntity> | Record<string, SaveEntity> | SaveEntity[];
}

interface DedupState {
  lastHash: string | null;
  keyframeId: number | null;
  sinceKeyframe: number;
}

interface RecordSnapshotOptions {
  onlinePlayers?: Set<string>;
  /**
   * Bypass the min-interval throttle. No production caller passes this yet —
   * it is reserved for a future manual "snapshot now" action, which must set
   * it or be silently throttled.
   */
  force?: boolean;
}

export interface SnapshotServiceOptions {
  label?: string;
  retentionDays?: number;
  trackStructures?: boolean;
  trackHouses?: boolean;
  trackBackpacks?: boolean;
  minIntervalSeconds?: number;
}

export class SnapshotService {
  private _db: HumanitZDB;
  private _log: Logger;
  private _debugLog: ReturnType<typeof createStructuredLogger>;
  private _retentionDays: number;
  private _trackStructures: boolean;
  private _trackHouses: boolean;
  private _trackBackpacks: boolean;
  private _minIntervalMs: number;
  private _lastSnapshotId: number | null = null;
  private _lastSnapshotAt: number | null = null;
  private _snapshotCount: number = 0;
  private _pruneCounter: number = 0;
  // Entity fan-out dedup (v25 structures, v26 backpacks/houses): when a tick's entity set is
  // byte-identical to the last keyframe, reference it (*_ref_snapshot_id) instead of
  // re-storing the rows. A keyframe is forced at least every KEYFRAME_EVERY ticks to cap how
  // long a ref chain points back to one keyframe. Retention is reference-aware (see
  // TimelineRepository.purgeOldTimeline) so a referenced keyframe is never pruned out from
  // under a retained ref; if one is ever missing anyway, the read path degrades to [].
  // NOTE: the cadence is in *ticks*, so the wall-clock keyframe spacing = KEYFRAME_EVERY ×
  // the effective snapshot interval (TIMELINE_SNAPSHOT_MIN_INTERVAL, default 300s → ~hourly).
  private _dedup: Record<'structures' | 'backpacks' | 'houses', DedupState> = {
    structures: { lastHash: null, keyframeId: null, sinceKeyframe: 0 },
    backpacks: { lastHash: null, keyframeId: null, sinceKeyframe: 0 },
    houses: { lastHash: null, keyframeId: null, sinceKeyframe: 0 },
  };
  // Players delta（v26）：離線且狀態不變的玩家不重複寫列（截至 v26 分析時，
  // 生產實測 760k 列中 >99.9% 是離線玩家的不變快照）。每 KEYFRAME_EVERY tick
  // 寫一次全名冊 keyframe（snapshot 標記 players_keyframe=1），讓重建查詢
  // （keyframe 全名冊 + 之後 delta overlay）的回看距離有界、被 wipe 的玩家在
  // 下一個 keyframe 起消失（幽靈窗 ≤ 一個 keyframe 週期 ≈ 1hr）。
  // null = 重啟後第一 tick，強制全量。
  private _lastPlayerSigs: Map<string, string> | null = null;
  private _playersSinceKeyframe: number = 0;
  // 同一個 cadence 同時驅動兩套機制：structures/backpacks/houses 的 hash-ref
  // dedup（強制新 keyframe 的上限）與 players 的全名冊 keyframe 週期。
  private static readonly KEYFRAME_EVERY = 12;
  // Retention prune 改為 async 分批（fire-and-forget）—— 前一輪未完成時不重入。
  private _pruneInFlight: boolean = false;

  /**
   * @param db - HumanitZDB instance
   * @param options
   * @param options.label - Log prefix
   * @param options.retentionDays - How many days to keep timeline data (default: 14)
   * @param options.trackStructures - Track structures in timeline (can be large, default: true)
   * @param options.trackHouses - Track house state in timeline (default: true)
   * @param options.trackBackpacks - Track dropped backpacks (default: true)
   * @param options.minIntervalSeconds - Minimum seconds between recorded snapshots;
   *   0 records on every save sync (default: config.timelineSnapshotMinInterval)
   */
  constructor(db: HumanitZDB, options: SnapshotServiceOptions = {}) {
    this._db = db;
    this._log = createLogger(options.label, 'TIMELINE');
    // The Logger wrapper has no debug level — throttle skips go straight to the
    // structured logger so they stay hidden at the default 'info' min level.
    this._debugLog = createStructuredLogger(this._log.label);
    this._retentionDays = options.retentionDays ?? config.timelineRetentionDays;
    this._trackStructures = options.trackStructures !== false;
    this._trackHouses = options.trackHouses !== false;
    this._trackBackpacks = options.trackBackpacks !== false;
    this._minIntervalMs = Math.max(options.minIntervalSeconds ?? config.timelineSnapshotMinInterval, 0) * 1000;
  }

  /**
   * Record a complete world snapshot from parsed save data.
   * Called after each successful save poll.
   *
   * @param saveData - The full parsed save object (from save-cache.json or parseSave())
   * @param options
   * @param options.onlinePlayers - Set of currently online player names (lowercase)
   * @param options.force - Bypass the min-interval throttle (manual/forced snapshots)
   * @returns The snapshot ID, or null if throttled or failed
   */
  recordSnapshot(saveData: SaveData, options: RecordSnapshotOptions = {}): number | null {
    if (!(saveData as SaveData | null | undefined)) return null;

    if (!options.force && this._minIntervalMs > 0 && this._lastSnapshotAt !== null) {
      const elapsedMs = Date.now() - this._lastSnapshotAt;
      if (elapsedMs < this._minIntervalMs) {
        this._debugLog.debug(
          `Snapshot throttled (${String(Math.round(elapsedMs / 1000))}s since last, min interval ${String(this._minIntervalMs / 1000)}s)`,
        );
        return null;
      }
    }

    try {
      const ws: Record<string, unknown> = saveData.worldState ?? {};
      const players = this._normalizePlayers(saveData.players);
      const vehicles = this._normalizeToArray(saveData.vehicles);
      const structures = this._normalizeToArray(saveData.structures);
      const containers = this._normalizeToArray(saveData.containers);
      const aiSpawns = (ws['aiSpawns'] as SaveEntity[] | undefined) ?? [];
      const houses = (ws['houses'] as SaveEntity[] | undefined) ?? [];
      const backpacks = (ws['droppedBackpacks'] as SaveEntity[] | undefined) ?? [];
      const companions = this._normalizeToArray(saveData.companions);
      const horses = this._normalizeToArray(saveData.horses);
      const onlineSet = options.onlinePlayers ?? new Set<string>();

      const timeOfDay = ws['timeOfDay'] as Record<string, unknown> | number | undefined;
      const gameTime =
        typeof timeOfDay === 'object' ? ((timeOfDay['time'] as number | undefined) ?? 0) : (timeOfDay ?? 0);
      const gameDay =
        typeof timeOfDay === 'object'
          ? ((ws['totalDaysElapsed'] as number | undefined) ?? (timeOfDay['day'] as number | undefined) ?? 0)
          : ((ws['totalDaysElapsed'] as number | undefined) ?? 0);

      const airdrop = ws['airdrop'] as Record<string, unknown> | undefined;

      // Build snapshot header
      const snapshot: SnapshotHeader = {
        gameDay,
        gameTime,
        playerCount: players.length,
        onlineCount:
          onlineSet.size ||
          players.filter((p) => onlineSet.has(((p['name'] as string | undefined) ?? '').toLowerCase())).length,
        aiCount: aiSpawns.length,
        structureCount: structures.length,
        vehicleCount: vehicles.length,
        containerCount: containers.length,
        worldItemCount: ((ws['lodPickups'] as unknown[] | undefined) ?? []).length,
        weatherType: this._resolveWeather(ws['weatherState']),
        season: this._resolveSeason(ws),
        airdropActive: !!airdrop?.['uid'],
        airdropX: (airdrop?.['x'] as number | undefined) ?? null,
        airdropY: (airdrop?.['y'] as number | undefined) ?? null,
        airdropAiAlive: (airdrop?.['aiAlive'] as number | undefined) ?? 0,
        summary: {
          gameDifficulty: ws['gameDifficulty'] ?? {},
          heliCrash: ws['heliCrashData'] ?? [],
          destroyedSleepers: (ws['destroyedSleepers'] as unknown[] | undefined)?.length ?? 0,
          destroyedRandCars: (ws['destroyedRandCars'] as unknown[] | undefined)?.length ?? 0,
          explodableBarrels: (ws['explodableBarrels'] as unknown[] | undefined)?.length ?? 0,
          buildingDecayCount: ws['buildingDecayCount'] ?? 0,
        },
      };

      // Build entity arrays
      const timelinePlayers: TimelinePlayer[] = players.map((p) => ({
        steamId: (p['steamId'] as string | undefined) ?? (p['steam_id'] as string | undefined) ?? '',
        name: (p['name'] as string | undefined) ?? '',
        online: onlineSet.has(((p['name'] as string | undefined) ?? '').toLowerCase()) ? 1 : 0,
        x: (p['x'] as number | undefined) ?? (p['pos_x'] as number | undefined) ?? null,
        y: (p['y'] as number | undefined) ?? (p['pos_y'] as number | undefined) ?? null,
        z: (p['z'] as number | undefined) ?? (p['pos_z'] as number | undefined) ?? null,
        health: (p['health'] as number | undefined) ?? 0,
        maxHealth: (p['maxHealth'] as number | undefined) ?? (p['max_health'] as number | undefined) ?? 100,
        hunger: (p['hunger'] as number | undefined) ?? 0,
        thirst: (p['thirst'] as number | undefined) ?? 0,
        infection: (p['infection'] as number | undefined) ?? 0,
        stamina: (p['stamina'] as number | undefined) ?? 0,
        level: (p['level'] as number | undefined) ?? 0,
        zeeksKilled: (p['zeeksKilled'] as number | undefined) ?? (p['zeeks_killed'] as number | undefined) ?? 0,
        daysSurvived: (p['daysSurvived'] as number | undefined) ?? (p['days_survived'] as number | undefined) ?? 0,
        lifetimeKills: (p['lifetimeKills'] as number | undefined) ?? (p['lifetime_kills'] as number | undefined) ?? 0,
      }));

      // Filter out dead AI (graveTimeMinutes > 0 means killed, waiting to respawn)
      const aliveAI = aiSpawns.filter(
        (a) => !(a['graveTimeMinutes'] as number | undefined) || (a['graveTimeMinutes'] as number) <= 0,
      );
      const timelineAI: TimelineAI[] = aliveAI.map((a) => {
        const aiType = (a['type'] as string | undefined) ?? 'Unknown';
        return {
          aiType,
          category: (a['category'] as string | undefined) ?? this._classifyAICategory(aiType),
          displayName: AI_DISPLAY_NAMES[aiType] ?? cleanName(aiType),
          nodeUid: (a['nodeUid'] as string | undefined) ?? '',
          x: (a['x'] as number | undefined) ?? null,
          y: (a['y'] as number | undefined) ?? null,
          z: (a['z'] as number | undefined) ?? null,
        };
      });

      const timelineVehicles: TimelineVehicle[] = vehicles.map((v) => ({
        class: (v['class'] as string | undefined) ?? '',
        displayName: (v['displayName'] as string | undefined) ?? cleanName((v['class'] as string | undefined) ?? ''),
        x: (v['x'] as number | undefined) ?? (v['pos_x'] as number | undefined) ?? null,
        y: (v['y'] as number | undefined) ?? (v['pos_y'] as number | undefined) ?? null,
        z: (v['z'] as number | undefined) ?? (v['pos_z'] as number | undefined) ?? null,
        health: (v['health'] as number | undefined) ?? 0,
        maxHealth: (v['maxHealth'] as number | undefined) ?? (v['max_health'] as number | undefined) ?? 0,
        fuel: (v['fuel'] as number | undefined) ?? 0,
        itemCount: ((v['inventory'] as unknown[] | undefined) ?? []).length,
      }));

      const timelineStructures: TimelineStructure[] = this._trackStructures
        ? structures.map((s) => ({
            actorClass: (s['actorClass'] as string | undefined) ?? (s['actor_class'] as string | undefined) ?? '',
            displayName:
              (s['displayName'] as string | undefined) ??
              (s['display_name'] as string | undefined) ??
              cleanName((s['actorClass'] as string | undefined) ?? (s['actor_class'] as string | undefined) ?? ''),
            ownerSteamId:
              (s['ownerSteamId'] as string | undefined) ?? (s['owner_steam_id'] as string | undefined) ?? '',
            x: (s['x'] as number | undefined) ?? (s['pos_x'] as number | undefined) ?? null,
            y: (s['y'] as number | undefined) ?? (s['pos_y'] as number | undefined) ?? null,
            z: (s['z'] as number | undefined) ?? (s['pos_z'] as number | undefined) ?? null,
            currentHealth:
              (s['currentHealth'] as number | undefined) ?? (s['current_health'] as number | undefined) ?? 0,
            maxHealth: (s['maxHealth'] as number | undefined) ?? (s['max_health'] as number | undefined) ?? 0,
            upgradeLevel: (s['upgradeLevel'] as number | undefined) ?? (s['upgrade_level'] as number | undefined) ?? 0,
          }))
        : [];

      const timelineHouses: TimelineHouse[] = this._trackHouses
        ? houses.map((h) => {
            const floatData = h['floatData'] as Record<string, number> | undefined;
            return {
              uid: (h['uid'] as string | undefined) ?? '',
              name: (h['name'] as string | undefined) ?? '',
              windowsOpen: (h['windowsOpen'] as number | undefined) ?? 0,
              windowsTotal: (h['windowsTotal'] as number | undefined) ?? 0,
              doorsOpen: (h['doorsOpen'] as number | undefined) ?? 0,
              doorsLocked: (h['doorsLocked'] as number | undefined) ?? 0,
              doorsTotal: (h['doorsTotal'] as number | undefined) ?? 0,
              destroyedFurniture: (h['destroyedFurniture'] as number | undefined) ?? 0,
              hasGenerator: !!h['hasGenerator'],
              sleepers: floatData?.['Sleepers'] ?? (h['sleepers'] as number | undefined) ?? 0,
              clean: floatData?.['Clean'] ?? (h['clean'] as number | undefined) ?? 0,
              x: null, // houses don't have positions in save data
              y: null,
            };
          })
        : [];

      // Merge companions + horses into one timeline array
      const timelineCompanions: TimelineCompanion[] = [
        ...companions.map((c) => ({
          entityType: (c['type'] as string | undefined) ?? 'dog',
          actorName: (c['actorName'] as string | undefined) ?? (c['actor_name'] as string | undefined) ?? '',
          displayName: cleanName(
            (c['actorName'] as string | undefined) ?? (c['actor_name'] as string | undefined) ?? '',
          ),
          ownerSteamId: (c['ownerSteamId'] as string | undefined) ?? (c['owner_steam_id'] as string | undefined) ?? '',
          x: (c['x'] as number | undefined) ?? (c['pos_x'] as number | undefined) ?? null,
          y: (c['y'] as number | undefined) ?? (c['pos_y'] as number | undefined) ?? null,
          z: (c['z'] as number | undefined) ?? (c['pos_z'] as number | undefined) ?? null,
          health: (c['health'] as number | undefined) ?? 0,
          extra: (c['extra'] as Record<string, unknown> | undefined) ?? {},
        })),
        ...horses.map((h) => {
          const extra = h['extra'] as Record<string, number> | undefined;
          return {
            entityType: 'horse',
            actorName: (h['actorName'] as string | undefined) ?? (h['actor_name'] as string | undefined) ?? '',
            displayName:
              (h['horseName'] as string | undefined) ??
              (h['horse_name'] as string | undefined) ??
              (h['displayName'] as string | undefined) ??
              (h['display_name'] as string | undefined) ??
              'Horse',
            ownerSteamId:
              (h['ownerSteamId'] as string | undefined) ?? (h['owner_steam_id'] as string | undefined) ?? '',
            x: (h['x'] as number | undefined) ?? (h['pos_x'] as number | undefined) ?? null,
            y: (h['y'] as number | undefined) ?? (h['pos_y'] as number | undefined) ?? null,
            z: (h['z'] as number | undefined) ?? (h['pos_z'] as number | undefined) ?? null,
            health: (h['health'] as number | undefined) ?? 0,
            extra: {
              energy: (h['energy'] as number | undefined) ?? 0,
              stamina: (h['stamina'] as number | undefined) ?? 0,
              saddle: extra?.['Saddle'] ?? 0,
            },
          };
        }),
      ];

      const timelineBackpacks: TimelineBackpack[] = this._trackBackpacks
        ? backpacks.map((b) => {
            const items = ((b['items'] as SaveEntity[] | undefined) ?? []).slice(0, 10);
            return {
              class: (b['class'] as string | undefined) ?? '',
              x: (b['x'] as number | undefined) ?? null,
              y: (b['y'] as number | undefined) ?? null,
              z: (b['z'] as number | undefined) ?? null,
              itemCount: ((b['items'] as unknown[] | undefined) ?? []).length,
              items: items.map((i) => ({
                item: (i['item'] as string | undefined) ?? '',
                amount: (i['amount'] as number | undefined) ?? 1,
              })),
            };
          })
        : [];

      // Entity fan-out dedup: if the set is unchanged from the last keyframe (and we haven't
      // hit the forced-keyframe cadence), reference that keyframe and skip writing the rows
      // for this tick. First tick after restart / a content change / the cadence boundary
      // writes a fresh full keyframe.
      const structuresPlan = this._planDedup('structures', this._trackStructures, () =>
        this._hashStructures(timelineStructures),
      );
      const backpacksPlan = this._planDedup('backpacks', this._trackBackpacks, () =>
        this._hashBackpacks(timelineBackpacks),
      );
      const housesPlan = this._planDedup('houses', this._trackHouses, () => this._hashHouses(timelineHouses));

      // Players delta：keyframe tick（重啟後第一 tick 或 cadence 到期）寫全名冊
      // 並把 snapshot 標記 players_keyframe=1，其餘 tick 只寫 online 或狀態簽章
      // 有變的玩家。識別鍵一律走 _playerKey（steamId || name）。
      const playerSigs = new Map<string, string>();
      for (const p of timelinePlayers) playerSigs.set(this._playerKey(p), this._playerSig(p));
      const playersKeyframe =
        this._lastPlayerSigs === null || this._playersSinceKeyframe >= SnapshotService.KEYFRAME_EVERY - 1;
      const playersToWrite = playersKeyframe
        ? timelinePlayers
        : timelinePlayers.filter(
            (p) =>
              p.online === 1 || this._lastPlayerSigs?.get(this._playerKey(p)) !== playerSigs.get(this._playerKey(p)),
          );

      // Write to DB
      const snapId = this._db.timeline.insertTimelineSnapshot({
        snapshot: {
          ...snapshot,
          structuresStateHash: structuresPlan.hash,
          structuresRefSnapshotId: structuresPlan.refId,
          backpacksStateHash: backpacksPlan.hash,
          backpacksRefSnapshotId: backpacksPlan.refId,
          housesStateHash: housesPlan.hash,
          housesRefSnapshotId: housesPlan.refId,
          playersKeyframe,
        },
        players: playersToWrite,
        ai: timelineAI,
        vehicles: timelineVehicles,
        structures: structuresPlan.refId === null ? timelineStructures : [],
        houses: housesPlan.refId === null ? timelineHouses : [],
        companions: timelineCompanions,
        backpacks: backpacksPlan.refId === null ? timelineBackpacks : [],
      });

      // Update keyframe state for the next tick's dedup decision (only after a successful
      // insert — a failed tick leaves state untouched so the next tick retries a full write).
      this._commitDedup('structures', this._trackStructures, structuresPlan, snapId);
      this._commitDedup('backpacks', this._trackBackpacks, backpacksPlan, snapId);
      this._commitDedup('houses', this._trackHouses, housesPlan, snapId);
      if (playersKeyframe) {
        this._lastPlayerSigs = playerSigs;
        this._playersSinceKeyframe = 0;
      } else {
        // 只更新本 tick 實際寫入的玩家簽章；離開存檔的玩家移除（記憶體有界，
        // 且其殘留簽章不會讓「重新出現且狀態相同」的玩家被誤判為不變 —— 因為
        // 這裡同步刪掉了）。
        const lastSigs = this._lastPlayerSigs as Map<string, string>;
        for (const p of playersToWrite) {
          const key = this._playerKey(p);
          lastSigs.set(key, playerSigs.get(key) as string);
        }
        for (const key of [...lastSigs.keys()]) {
          if (!playerSigs.has(key)) lastSigs.delete(key);
        }
        this._playersSinceKeyframe++;
      }

      this._lastSnapshotId = snapId;
      this._lastSnapshotAt = Date.now();
      this._snapshotCount++;

      // Periodic pruning (every 12 snapshots ≈ 1 hour at 5-min intervals).
      // Fire-and-forget：分批 purge 是 async（批間讓出 event loop），recordSnapshot
      // 本身維持同步；_pruneOldData 內部有 reentrancy 防護與 try/catch。
      this._pruneCounter++;
      if (this._pruneCounter >= 12) {
        this._pruneCounter = 0;
        void this._pruneOldData();
      }

      const entityCount =
        timelinePlayers.length +
        timelineAI.length +
        timelineVehicles.length +
        timelineStructures.length +
        timelineHouses.length +
        timelineCompanions.length +
        timelineBackpacks.length;
      this._log.info(
        `Snapshot #${String(this._snapshotCount)} recorded (${String(entityCount)} entities, id=${String(snapId)})`,
      );

      return snapId;
    } catch (err) {
      this._log.error('Failed to record snapshot:', errMsg(err));
      return null;
    }
  }

  /** Get the most recent snapshot ID. */
  get lastSnapshotId(): number | null {
    return this._lastSnapshotId;
  }

  /** Get total snapshots recorded this session. */
  get snapshotCount(): number {
    return this._snapshotCount;
  }

  // ── Internal helpers ───────────────────────────────────────

  /** Convert Map or object to array of values. */
  private _normalizeToArray(
    data: Map<string, SaveEntity> | Record<string, SaveEntity> | SaveEntity[] | undefined | null,
  ): SaveEntity[] {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    if (data instanceof Map) return [...data.values()];
    return Object.values(data);
  }

  /**
   * Players 專用 normalize：Map / Record 的 key 就是 steamId，而生產 save-cache
   * 的 player value 物件「沒有」頂層 steamId 欄位（截至 v26 分析時實測 454/454
   * 缺欄）—— 只取 values 會讓 timeline_players.steam_id 全空、delta 識別鍵塌縮。
   * 這裡把 key 帶進 entry；既有非空 steamId/steam_id 欄位優先、不覆蓋。
   */
  private _normalizePlayers(
    data: Map<string, SaveEntity> | Record<string, SaveEntity> | SaveEntity[] | undefined | null,
  ): SaveEntity[] {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    const entries = data instanceof Map ? [...data.entries()] : Object.entries(data);
    return entries.map(([sid, p]) =>
      (p['steamId'] as string | undefined) || (p['steam_id'] as string | undefined) ? p : { ...p, steamId: sid },
    );
  }

  /**
   * Delta 識別鍵：steam_id 非空取 steam_id，否則退回 name（防解析器邊角 / 生產
   * legacy 空 steam_id 列）。寫入 filter、簽章 Map、重建 overlay
   * （TimelineRepository._timelinePlayersAsOf）必須用同一把鍵。
   */
  private _playerKey(p: TimelinePlayer): string {
    return p.steamId !== '' ? p.steamId : p.name;
  }

  /** Classify AI type into category. */
  private _classifyAICategory(type: string): string {
    if (!type) return 'unknown';
    if (/^Bandit/i.test(type)) return 'bandit';
    if (/^Animal(?!Z)/i.test(type)) return 'animal';
    return 'zombie';
  }

  /** Resolve weather type from UDS weather state. */
  private _resolveWeather(weatherState: unknown): string {
    if (!weatherState || !Array.isArray(weatherState)) return '';
    const udw = (weatherState as Array<Record<string, unknown>>).find((w) => w['name'] === 'UDWRandomWeatherState');
    if (!udw || !udw['children']) return '';
    const current = (udw['children'] as Array<Record<string, unknown>>).find(
      (c) => c['name'] === 'CurrentRandomWeatherType',
    );
    if (!current) return '';
    // Map UDS enumerator to human name
    const weatherMap: Record<string, string> = {
      'UDS_WeatherTypes::NewEnumerator0': 'Clear',
      'UDS_WeatherTypes::NewEnumerator1': 'Partly Cloudy',
      'UDS_WeatherTypes::NewEnumerator2': 'Cloudy',
      'UDS_WeatherTypes::NewEnumerator3': 'Overcast',
      'UDS_WeatherTypes::NewEnumerator4': 'Light Rain',
      'UDS_WeatherTypes::NewEnumerator5': 'Rain',
      'UDS_WeatherTypes::NewEnumerator6': 'Thunderstorm',
      'UDS_WeatherTypes::NewEnumerator7': 'Light Snow',
      'UDS_WeatherTypes::NewEnumerator8': 'Snow',
      'UDS_WeatherTypes::NewEnumerator9': 'Blizzard',
      'UDS_WeatherTypes::NewEnumerator10': 'Fog',
    };
    const value = current['value'] as string | undefined;
    return (value ? weatherMap[value] : undefined) ?? value ?? '';
  }

  /** Resolve current season from world state. */
  private _resolveSeason(ws: Record<string, unknown>): string {
    // Check for season in weather state
    if (ws['weatherState'] && Array.isArray(ws['weatherState'])) {
      // Could derive season from SimulationDate, but for now return
      // the dedicated season field if present
      void (ws['weatherState'] as Array<Record<string, unknown>>).find((w) => w['name'] === 'SimulationDate');
    }
    // Check direct season field
    if (ws['currentSeason']) return ws['currentSeason'] as string;
    // Derive from total days (roughly 30-day seasons)
    const days = (ws['totalDaysElapsed'] as number | undefined) ?? 0;
    const seasonIdx = Math.floor((days % 120) / 30);
    return ['Spring', 'Summer', 'Autumn', 'Winter'][seasonIdx] ?? 'Unknown';
  }

  /**
   * Dedup decision for one entity kind: returns the content hash and — when the set is
   * unchanged from the last keyframe and the cadence hasn't expired — the keyframe id to
   * reference instead of re-storing the rows. Disabled tracking → both null (rows are []
   * anyway; hashing an empty set every tick would just ref an empty keyframe for no gain).
   */
  private _planDedup(
    kind: 'structures' | 'backpacks' | 'houses',
    enabled: boolean,
    hashFn: () => string,
  ): { hash: string | null; refId: number | null } {
    if (!enabled) return { hash: null, refId: null };
    const state = this._dedup[kind];
    const hash = hashFn();
    const unchanged = state.keyframeId !== null && hash === state.lastHash;
    // -1 because the counter only advances on ref ticks: with KEYFRAME_EVERY=12 this forces
    // a fresh keyframe on the 12th tick after the last one (not the 13th).
    const forceKeyframe = state.sinceKeyframe >= SnapshotService.KEYFRAME_EVERY - 1;
    return { hash, refId: unchanged && !forceKeyframe ? state.keyframeId : null };
  }

  /** Update keyframe state after a successful insert. */
  private _commitDedup(
    kind: 'structures' | 'backpacks' | 'houses',
    enabled: boolean,
    plan: { hash: string | null; refId: number | null },
    snapId: number,
  ): void {
    if (!enabled) return;
    const state = this._dedup[kind];
    if (plan.refId === null) {
      state.lastHash = plan.hash;
      state.keyframeId = snapId;
      state.sinceKeyframe = 0;
    } else {
      state.sinceKeyframe++;
    }
  }

  /**
   * Order-independent content hash of an entity set. Each row is reduced to a canonical
   * JSON signature tuple (JSON-encoding prevents a literal delimiter inside a field from
   * colliding two distinct sets); signatures are sorted before hashing so a save/DB
   * row-order change alone does NOT look like a content change.
   */
  private _hashRows(sigs: string[]): string {
    const sorted = [...sigs].sort();
    // sha256（非安全用途，sha1 即足夠，但一行成本可同時消除 SAST 告警與理論碰撞）。
    // hash 只在同一 process 記憶體內比對（重啟後 null 強制全量寫入），不與 DB 既存值
    // 跨版本比較，換演算法安全。
    return createHash('sha256')
      .update(`${String(sorted.length)}\n${sorted.join('\n')}`)
      .digest('hex');
  }

  // Every persisted, independently-variable column of each timeline table is included in the
  // signature — a change in any stored field must bust the dedup.
  private _hashStructures(structures: TimelineStructure[]): string {
    return this._hashRows(
      structures.map((s) =>
        JSON.stringify([
          s.actorClass,
          s.displayName,
          s.ownerSteamId,
          s.x,
          s.y,
          s.z,
          s.currentHealth,
          s.maxHealth,
          s.upgradeLevel,
        ]),
      ),
    );
  }

  private _hashBackpacks(backpacks: TimelineBackpack[]): string {
    // items 是我們自己建構的 {item, amount} 陣列，鍵序固定，JSON.stringify 穩定。
    return this._hashRows(backpacks.map((b) => JSON.stringify([b.class, b.x, b.y, b.z, b.itemCount, b.items])));
  }

  private _hashHouses(houses: TimelineHouse[]): string {
    return this._hashRows(
      houses.map((h) =>
        JSON.stringify([
          h.uid,
          h.name,
          h.windowsOpen,
          h.windowsTotal,
          h.doorsOpen,
          h.doorsLocked,
          h.doorsTotal,
          h.destroyedFurniture,
          h.hasGenerator,
          h.sleepers,
          h.clean,
        ]),
      ),
    );
  }

  /** Delta signature of one player row（全部持久化欄位 —— 任一欄位變動都必須觸發寫列）. */
  private _playerSig(p: TimelinePlayer): string {
    return JSON.stringify([
      p.name,
      p.online,
      p.x,
      p.y,
      p.z,
      p.health,
      p.maxHealth,
      p.hunger,
      p.thirst,
      p.infection,
      p.stamina,
      p.level,
      p.zeeksKilled,
      p.daysSurvived,
      p.lifetimeKills,
    ]);
  }

  /** Prune old timeline data beyond retention period (async 分批；不重入). */
  private async _pruneOldData(): Promise<void> {
    if (this._pruneInFlight) return; // 前一輪分批 purge 未完成，跳過本輪
    this._pruneInFlight = true;
    try {
      const result = await this._db.timeline.purgeOldTimeline(`-${String(this._retentionDays)} days`);
      if (result.changes > 0) {
        this._log.info(`Pruned ${String(result.changes)} old timeline snapshots (>${String(this._retentionDays)}d)`);
      }
    } catch (err) {
      this._log.warn('Failed to prune timeline:', errMsg(err));
    } finally {
      this._pruneInFlight = false;
    }
  }
}

export default SnapshotService;
