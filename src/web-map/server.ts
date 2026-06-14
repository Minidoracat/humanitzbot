/**
 * Web Map Server — Interactive Leaflet-based player map served via Express.
 *
 * Features:
 * - 4K game map as tile layer
 * - Live player positions from save data
 * - Hover/click for player stats, inventory, vitals
 * - Admin actions: kick/ban via RCON
 * - Calibration mode for coordinate mapping
 *
 * Integrates with: save-parser, player-stats, playtime-tracker, rcon
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import config, { _tzOffsetMs } from '../config/index.js';
import type { RuntimeConfigApplier } from '../config/runtime-config-applier.js';
import { parseSave, normalizePlayerHorses, PERK_MAP } from '../parsers/save-parser.js';
import { AFFLICTION_MAP } from '../parsers/game-data.js';
import { cleanName as cleanActorName, cleanNameCached, cleanItemName } from '../parsers/ue4-names.js';
import { resolveItemName, resolveItemArray, searchItemIds } from '../i18n/item-names.js';
import playerStats from '../tracking/player-stats.js';
import playtime from '../tracking/playtime-tracker.js';
import rcon from '../rcon/rcon.js';
import { setupAuth, requireTier } from './auth.js';
import { API_ERRORS, sendError } from './api-errors.js';

import type { HumanitZDB } from '../db/database.js';
import type { SaveService } from '../parsers/save-service.js';
import type { ServerScheduler } from '../modules/server-scheduler.js';
import type MultiServerManager from '../server/multi-server.js';
import type { BotControlService } from '../server/bot-control.js';
import type { Client } from 'discord.js';
import type { PanelApi } from '../server/panel-api.js';

import serverResources, { formatBytes, formatUptime } from '../server/server-resources.js';
import { _coerce } from '../db/config-migration.js';
import {
  getPlayerList as _getPlayerList,
  getServerInfo as _getServerInfo,
  sendAdminMessage as _sendAdminMessage,
} from '../rcon/server-info.js';
import _panelApiInstance from '../server/panel-api.js';
import { discoverPaths as _discoverPaths } from '../server/multi-server.js';
import { errMsg } from '../utils/error.js';
import { getDirname } from '../utils/paths.js';
import type {
  DbRow,
  StructureRow,
  VehicleRow,
  ContainerRow,
  CompanionRow,
  DeadBodyRow,
  QuestRow,
  ActivityRow,
} from './types/db-rows.js';
import { DATA_DIR, SERVERS_DIR, SERVERS_FILE, PUBLIC_DIR, CALIBRATION_FILE } from './paths.js';
import { rateLimit } from './rate-limit.js';
import { _discoveryJobs } from './discovery-tracker.js';
import {
  _hasEntityActor,
  _withItemDisplayName,
  _requestLocale,
  _resolveActivityRange,
  _queryString,
  _isoTimestamp,
  _parseBoundedPositiveInt,
  _parseNonNegativeInt,
  _parseItemListView,
  _activityBucketOffsetMinutes,
  safeError,
  stripControlChars,
  safeUnknownString,
  sendErrorWithData,
  _extractLandingSettings,
  _cleanInventorySlots,
} from './route-helpers.js';
import {
  _botConfigItemMetadata,
  _botConfigDisplayValue,
  _serializeBotConfigInputValue,
  _normalizeBotConfigTypedValue,
} from './bot-config-meta.js';
import {
  _setNestedValue,
  _deleteNestedValue,
  _buildServerDefSections,
  _getServerDef,
  _saveServerDef,
  _maskServerDef,
} from './serverdef-repo.js';
import type { ConfigRepo } from './types/config-repo.js';
import { registerTimelineRoutes } from './routes/timeline.routes.js';
import { registerServersActionsRoutes } from './routes/servers-actions.routes.js';
import { registerServersDiscoveryRoutes } from './routes/servers-discovery.routes.js';
import { registerServersCrudRoutes } from './routes/servers-crud.routes.js';
import { registerAnticheatRoutes } from './routes/anticheat.routes.js';
import { registerWelcomeFileRoutes } from './routes/welcome-file.routes.js';
import { registerBotConfigRoutes } from './routes/bot-config.routes.js';
import { registerSchedulerRoutes } from './routes/scheduler.routes.js';
import { registerBackupsSettingsRoutes } from './routes/backups-settings.routes.js';
import { registerChatOpsRoutes } from './routes/chat-ops.routes.js';
import { registerItemsRoutes } from './routes/items.routes.js';

const __dirname = getDirname(import.meta.url);

// ── Server context injected by multi-server middleware ──────────────────────

/** Resolved per-request server context (primary or multi-server instance). */
interface ServerContext {
  db: HumanitZDB | null;
  rcon: typeof rcon | { send(cmd: string): Promise<string>; connected?: boolean };
  config: typeof config;
  playerStats: typeof playerStats;
  playtime: typeof playtime;
  getPlayerList: typeof _getPlayerList;
  getServerInfo: typeof _getServerInfo;
  sendAdminMessage: typeof _sendAdminMessage;
  panelApi: PanelApi | null;
  scheduler: ServerScheduler | null;
  dataDir: string;
  playerNameMap: Record<string, string>;
  isPrimary: boolean;
  serverId: string;
}

// Augment Express Request with custom properties set by auth + multi-server middleware
declare module 'express-serve-static-core' {
  interface Request {
    srv: ServerContext;
  }
}
declare module 'express-session' {
  interface SessionData {
    user?: {
      userId: string;
      username: string;
      displayName: string;
      avatar: string | null;
      roles: string[];
      tier: string;
      tierLevel?: number;
      inGuild: boolean;
      lastRoleCheck: number;
    };
    username?: string;
    discordId?: string;
  }
}

class WebMapServer {
  _client: Client;
  _app: ReturnType<typeof express>;
  _server: import('http').Server | null;
  _port: number;
  _db: HumanitZDB | null;
  _scheduler: ServerScheduler | null;
  _saveService: SaveService | null;
  _multiServerManager: MultiServerManager | null;
  _plugins: Array<Record<string, unknown>>;
  _configRepo: ConfigRepo | null;
  _runtimeConfigApplier: RuntimeConfigApplier | null;
  _worldBounds: { xMin: number; xMax: number; yMin: number; yMax: number };
  _responseCache: Map<string, { data: unknown; ts: number }>;
  _playerCache: Map<string, unknown>;
  _lastParse: number;
  _saveJsonCache: Map<string, { map: Map<string, unknown>; sourcePath: string; mtimeMs: number }>;
  _botControl: BotControlService | null = null;
  _moduleStatus: Record<string, string> | null = null;
  _pollTimer: ReturnType<typeof setInterval> | null = null;
  declare setScheduler: (scheduler: ServerScheduler) => void;
  declare setSaveService: (saveService: SaveService) => void;
  declare setMultiServerManager: (msm: MultiServerManager) => void;
  declare setBotControl: (bc: BotControlService) => void;
  declare setModuleStatus: (status: Record<string, string>) => void;

  constructor(
    client: Client,
    opts: {
      db?: HumanitZDB | null;
      scheduler?: ServerScheduler | null;
      saveService?: SaveService | null;
      multiServerManager?: MultiServerManager | null;
      configRepo?: unknown;
      runtimeConfigApplier?: RuntimeConfigApplier | null;
    } = {},
  ) {
    this._client = client;
    this._app = express();
    // Trust proxy — 'loopback' for local reverse proxy (Caddy/nginx),
    // '1' or 'uniquelocal' for Pterodactyl Docker networking (Bisect bot hosting).
    // Configurable via WEB_MAP_TRUST_PROXY env var.
    const trustProxy = config.webMapTrustProxy;
    this._app.set('trust proxy', /^\d+$/.test(trustProxy) ? parseInt(trustProxy, 10) : trustProxy);
    this._server = null;
    this._port = parseInt(process.env.WEB_MAP_PORT || '', 10) || 3000;
    this._db = opts.db || null;
    this._scheduler = opts.scheduler || null;
    this._saveService = opts.saveService || null;
    this._multiServerManager = opts.multiServerManager || null;
    this._plugins = []; // Registered plugins (private modules)
    this._configRepo = (opts.configRepo || config._configRepo || null) as ConfigRepo | null;
    this._runtimeConfigApplier = opts.runtimeConfigApplier || null;

    // World coordinate bounds — loaded from calibration file or defaults
    this._worldBounds = this._loadCalibration();

    // Setter methods — allow late-binding of dependencies that start after the web panel
    /** @param {object} scheduler ServerScheduler instance */
    this.setScheduler = (scheduler: ServerScheduler) => {
      this._scheduler = scheduler;
    };
    /** @param {object} saveService SaveService instance */
    this.setSaveService = (saveService: SaveService) => {
      this._saveService = saveService;
    };
    /** @param {object} msm MultiServerManager instance */
    this.setMultiServerManager = (msm: MultiServerManager) => {
      this._multiServerManager = msm;
    };
    /** @param {import('../server/bot-control')} bc BotControlService instance */
    this.setBotControl = (bc: BotControlService) => {
      this._botControl = bc;
    };
    /** @param {object} status Module status map { moduleName: statusString } */
    this.setModuleStatus = (status: Record<string, string>) => {
      this._moduleStatus = status;
    };

    // Response cache — keyed by "endpoint:serverId", entries = { data, ts }
    this._responseCache = new Map();

    // Cache: last parsed save data
    this._playerCache = new Map();
    this._lastParse = 0;

    // Cache: parsed JSON save caches keyed by data dir, invalidated when the source file's mtime changes
    this._saveJsonCache = new Map();

    // Security headers
    this._app.use((_req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '0'); // Disabled — modern browsers don't need it, can cause XSS in old ones
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
      // CSP: allow self + CDN scripts/styles + Google Fonts used by the panel frontend
      res.setHeader(
        'Content-Security-Policy',
        [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.jsdelivr.net https://static.cloudflareinsights.com",
          "style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com",
          "img-src 'self' https://cdn.discordapp.com data: blob:",
          "connect-src 'self' https://unpkg.com https://cdn.jsdelivr.net https://static.cloudflareinsights.com",
          "font-src 'self' https://fonts.gstatic.com",
          "frame-ancestors 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          "object-src 'none'",
        ].join('; '),
      );
      res.removeHeader('X-Powered-By');
      next();
    });

    // Set up Express
    this._setupRoutes();
  }

  /** Load calibration data from file, or return defaults. */
  _loadCalibration(): { xMin: number; xMax: number; yMin: number; yMax: number } {
    try {
      if (fs.existsSync(CALIBRATION_FILE)) {
        const data = JSON.parse(fs.readFileSync(CALIBRATION_FILE, 'utf8')) as {
          xMin: number;
          xMax: number;
          yMin: number;
          yMax: number;
        };
        console.log('[WEB MAP] Loaded calibration from file');
        return data;
      }
    } catch (err: unknown) {
      console.error('[WEB MAP] Failed to load calibration:', errMsg(err));
    }

    // Defaults — UE4 X = North (up), Y = East (right)
    // These map world coordinates to the [0, 4096] pixel space of the map image.
    // xMin = world X at the BOTTOM of the map, xMax = world X at the TOP
    // yMin = world Y at the LEFT of the map, yMax = world Y at the RIGHT
    // Source: developer-provided values — Width: 395900, Offset X=201200 Y=-200600
    return {
      xMin: 3250, // south edge (bottom of map)
      xMax: 399150, // north edge (top of map)
      yMin: -398550, // west edge (left of map)
      yMax: -2650, // east edge (right of map)
    };
  }

  /** Save calibration to file. */
  _saveCalibration(bounds: { xMin: number; xMax: number; yMin: number; yMax: number }): void {
    this._worldBounds = bounds;
    try {
      fs.writeFileSync(CALIBRATION_FILE, JSON.stringify(bounds, null, 2));
      console.log('[WEB MAP] Saved calibration:', JSON.stringify(bounds));
    } catch (err: unknown) {
      console.error('[WEB MAP] Failed to save calibration:', errMsg(err));
    }
  }

  /**
   * Server-side response cache — prevents repeated RCON/DB/file hits for the same data.
   * Keyed by "endpoint:serverId". Returns cached JSON or null if expired/missing.
   */
  _getCached(endpoint: string, serverId: string, maxAgeMs = 15000): unknown {
    const key = `${endpoint}:${serverId || 'primary'}`;
    const entry = this._responseCache.get(key);
    if (entry && Date.now() - entry.ts < maxAgeMs) return entry.data;
    return null;
  }

  /** Store a response in the cache. */
  _setCache(endpoint: string, serverId: string, data: unknown): void {
    const key = `${endpoint}:${serverId || 'primary'}`;
    this._responseCache.set(key, { data, ts: Date.now() });
  }

  /**
   * Register a plugin that provides routes, assets, and data hooks.
   * Private modules (e.g. howyagarn/web-plugin) call this to extend the panel.
   * @param {object} plugin — { name, css[], js[], dashboardHtml, registerRoutes(app, helpers), getLandingData() }
   */
  registerPlugin(plugin: Record<string, unknown>): void {
    if (!plugin.name) return;
    this._plugins.push(plugin);
    // If the server is already running, register routes immediately
    if (this._server && typeof plugin.registerRoutes === 'function') {
      try {
        (
          plugin.registerRoutes as (
            app: typeof this._app,
            helpers: { rateLimit: typeof rateLimit; requireTier: typeof requireTier },
          ) => void
        )(this._app, { rateLimit, requireTier });
      } catch (err: unknown) {
        console.error(`[WEB MAP] Plugin ${plugin.name as string} late route registration failed:`, errMsg(err));
      }
    }
    console.log(`[WEB MAP] Plugin registered: ${plugin.name as string}`);
  }

  /**
   * Reconfigure plugin metadata at runtime and clear cached responses that may
   * depend on plugin routing/capability data. Returns an undo callback for
   * best-effort rollback when a downstream runtime rebind fails.
   */
  reconfigurePlugin(name: string, patch: Record<string, unknown>): (() => void) | null {
    const plugins = this._plugins.filter((plugin) => plugin.name === name);
    if (plugins.length === 0) return null;

    const keys = Object.keys(patch);
    const previous = plugins.map((plugin) => ({
      plugin,
      values: Object.fromEntries(keys.map((key) => [key, { had: Object.hasOwn(plugin, key), value: plugin[key] }])),
    }));

    for (const plugin of plugins) Object.assign(plugin, patch);
    this._responseCache.clear();

    return () => {
      for (const entry of previous) {
        for (const key of keys) {
          const old = entry.values[key];
          if (!old) continue;
          if (old.had) entry.plugin[key] = old.value;
          else Reflect.deleteProperty(entry.plugin, key);
        }
      }
      this._responseCache.clear();
    };
  }

  /** Load player names already known by the local database. */
  _loadDbPlayerNameMap(db: HumanitZDB | null): Record<string, string> {
    const map: Record<string, string> = {};
    if (!db) return map;

    try {
      const rows = db.player.listAllPlayerDisplayNames() as Array<{
        steam_id?: unknown;
        name?: unknown;
        display_name?: unknown;
      }>;
      for (const row of rows) {
        const steamId = typeof row.steam_id === 'string' ? row.steam_id.trim() : '';
        if (!/^\d{17}$/.test(steamId)) continue;
        const name = this._cleanPlayerDisplayName(row.display_name) || this._cleanPlayerDisplayName(row.name);
        if (/^\d{17}$/.test(steamId) && name) map[steamId] = name;
      }
    } catch {
      /* DB may not have players yet */
    }

    return map;
  }

  /** Resolve a single SteamID through the server-specific SQLite aliases. */
  _resolveDbPlayerName(db: HumanitZDB | null, steamId: string): string | null {
    if (!db || !/^\d{17}$/.test(steamId)) return null;
    try {
      const name = db.player.resolveSteamIdToName(steamId);
      return name && name !== steamId ? name : null;
    } catch {
      return null;
    }
  }

  /** Resolve a player name from the request's server-specific DB context. */
  _resolveServerPlayerName(srv: ServerContext, steamId: string): string | null {
    return this._cleanPlayerDisplayName(srv.playerNameMap[steamId]) || this._resolveDbPlayerName(srv.db, steamId);
  }

  /** Normalize candidate display names from SQLite, save data, or RCON. */
  _cleanPlayerDisplayName(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const name = value.trim();
    if (!name || name === '-') return null;
    return name;
  }

  /** Resolve a player display name with live/current sources first and SteamID as final fallback. */
  _resolvePlayerDisplayName(
    steamId: string,
    data: Record<string, unknown>,
    db: HumanitZDB | null,
    dbNameMap: Record<string, string>,
    onlineNameMap?: Map<string, string>,
  ): string {
    return (
      this._cleanPlayerDisplayName(onlineNameMap?.get(steamId)) ||
      this._cleanPlayerDisplayName(dbNameMap[steamId]) ||
      this._cleanPlayerDisplayName(this._resolveDbPlayerName(db, steamId)) ||
      this._cleanPlayerDisplayName(data.name) ||
      steamId
    );
  }

  // ── Multi-server helpers ──────────────────────────────────

  /** Load the list of additional (managed) servers. DB-first, fallback to servers.json. */
  _loadServerList(): Array<Record<string, unknown> & { id: string; name?: string }> {
    // DB-backed: read from config_documents
    if (this._configRepo) {
      try {
        const all = this._configRepo.loadAll();
        const servers: Array<Record<string, unknown> & { id: string; name?: string }> = [];
        for (const [scope, { data }] of all) {
          if (!scope.startsWith('server:') || scope === 'server:primary') continue;
          const id = safeUnknownString(data.id);
          if (id) {
            const { name, ...serverData } = data;
            if (name !== undefined && typeof name !== 'string') {
              console.warn(`[WEB MAP] Ignoring invalid server name for ${scope}: expected string`);
            }
            servers.push({
              ...serverData,
              id,
              ...(typeof name === 'string' ? { name } : {}),
            });
          }
        }
        return servers;
      } catch (err: unknown) {
        console.error('[WEB MAP] Failed to load servers from DB:', errMsg(err));
      }
    }
    // Legacy fallback: read from servers.json
    try {
      if (fs.existsSync(SERVERS_FILE)) {
        return JSON.parse(fs.readFileSync(SERVERS_FILE, 'utf8')) as Array<
          Record<string, unknown> & { id: string; name?: string }
        >;
      }
    } catch (err: unknown) {
      console.error('[WEB MAP] Failed to load servers.json:', errMsg(err));
    }
    return [];
  }

  /** Get data directory for a server id (or primary). */
  _getServerDataDir(serverId: string): string | null {
    if (!serverId || serverId === 'primary') return DATA_DIR;
    // Sanitize to prevent path traversal
    const safe = serverId.replace(/[^a-zA-Z0-9_-]/g, '');
    const dir = path.join(SERVERS_DIR, safe);
    return fs.existsSync(dir) ? dir : null;
  }

  /**
   * Resolve all data sources for a given server ID.
   * Returns { db, rcon, config, playerStats, playtime, getPlayerList, getServerInfo,
   *           scheduler, dataDir, isPrimary, serverId } or null if server not found.
   */
  _resolveServer(serverId: string): ServerContext | null {
    const isPrimary = !serverId || serverId === 'primary';
    if (isPrimary) {
      return {
        db: this._db,
        rcon,
        config,
        playerStats,
        playtime,
        getPlayerList: _getPlayerList,
        getServerInfo: _getServerInfo,
        sendAdminMessage: _sendAdminMessage,
        panelApi: _panelApiInstance,
        scheduler: this._scheduler,
        dataDir: DATA_DIR,
        playerNameMap: this._loadDbPlayerNameMap(this._db),
        isPrimary: true,
        serverId: 'primary',
      };
    }
    // Look up multi-server instance
    if (!this._multiServerManager) return null;
    const instance = this._multiServerManager.getInstance(serverId);
    if (!instance || !instance.running) return null;
    return {
      db: instance.db,
      rcon: instance.rcon,
      config: instance.config,
      playerStats: instance.playerStats,
      playtime: instance.playtime,
      getPlayerList: instance.getPlayerList,
      getServerInfo: instance.getServerInfo,
      sendAdminMessage: instance.sendAdminMessage,
      panelApi: instance.panelApi || null,
      scheduler: instance.getServerScheduler(),
      dataDir: instance.dataDir,
      playerNameMap: this._loadDbPlayerNameMap(instance.db),
      isPrimary: false,
      serverId,
    };
  }

  /**
   * Load player-stats.json from a data directory.
   * Returns a { getStats(steamId), getStatsByName(name) } interface.
   */
  _loadLogStatsFrom(dataDir: string): {
    getStats(steamId: string): Record<string, unknown> | null;
    getStatsByName(name: string): Record<string, unknown> | null;
  } {
    try {
      const raw = fs.readFileSync(path.join(dataDir, 'player-stats.json'), 'utf8');
      const data = JSON.parse(raw) as { players?: Record<string, Record<string, unknown>> };
      const players: Record<string, Record<string, unknown>> = data.players ?? {};
      return {
        getStats(steamId: string) {
          return players[steamId] || null;
        },
        getStatsByName(name: string) {
          const lower = (name || '').toLowerCase();
          for (const rec of Object.values(players)) {
            if (((rec.name as string) || '').toLowerCase() === lower) return rec;
          }
          return null;
        },
      };
    } catch {
      return {
        getStats(_steamId?: string) {
          return null;
        },
        getStatsByName(_name?: string) {
          return null;
        },
      };
    }
  }

  /** Load playtime.json from a data directory. */
  _loadPlaytimeFrom(dataDir: string): { getPlaytime(steamId: string): Record<string, unknown> | null } {
    try {
      const raw = fs.readFileSync(path.join(dataDir, 'playtime.json'), 'utf8');
      const data = JSON.parse(raw) as { players?: Record<string, Record<string, unknown>> };
      const players: Record<string, Record<string, unknown>> = data.players ?? {};
      return {
        getPlaytime(steamId: string) {
          const p = players[steamId];
          if (!p) return null;
          return { totalMs: p.totalMs || 0, lastSeen: p.lastSeen || null };
        },
      };
    } catch {
      return {
        getPlaytime(_steamId?: string) {
          return null;
        },
      };
    }
  }

  /**
   * Read and parse a JSON save cache file, reusing the previous parse for the
   * same data dir while the source file and its mtime are unchanged.
   *
   * The returned Map is the shared cache entry — callers must treat it as
   * read-only; mutating it would corrupt the cache for every other consumer.
   */
  _readSaveJsonCached(dataDir: string, sourcePath: string, mtimeMs: number): Map<string, unknown> {
    const cached = this._saveJsonCache.get(dataDir);
    if (cached && cached.sourcePath === sourcePath && cached.mtimeMs === mtimeMs) {
      return cached.map;
    }
    const data = JSON.parse(fs.readFileSync(sourcePath, 'utf8')) as { players?: Record<string, unknown> };
    const map = new Map<string, unknown>();
    for (const [steamId, pData] of Object.entries(data.players ?? {})) {
      map.set(steamId, pData);
    }
    this._saveJsonCache.set(dataDir, { map, sourcePath, mtimeMs });
    return map;
  }

  /**
   * Parse save data for a specific server.
   * Tries (in order): save-cache.json, humanitz-cache.json, raw .sav files.
   * JSON sources are cached per data dir and only re-read when their mtime changes.
   */
  _parseSaveDataForServer(dataDir: string): Map<string, unknown> {
    // 1. Try save-cache.json (written by PlayerStatsChannel)
    try {
      const cachePath = path.join(dataDir, 'save-cache.json');
      if (fs.existsSync(cachePath)) {
        const stat = fs.statSync(cachePath);
        // Use cache if less than 10 minutes old
        if (Date.now() - stat.mtimeMs < 600000) {
          return this._readSaveJsonCached(dataDir, cachePath, stat.mtimeMs);
        }
      }
    } catch {
      /* fall through */
    }

    // 2. Try humanitz-cache.json (agent output)
    try {
      const agentPath = path.join(dataDir, 'humanitz-cache.json');
      if (fs.existsSync(agentPath)) {
        const stat = fs.statSync(agentPath);
        return this._readSaveJsonCached(dataDir, agentPath, stat.mtimeMs);
      }
    } catch {
      /* fall through */
    }

    // 3. Try raw .sav files
    const saveFiles = [
      path.join(dataDir, 'Save_DedicatedSaveMP_NEW.sav'),
      path.join(dataDir, 'Save_DedicatedSaveMP_LIVE.sav'),
      path.join(dataDir, 'Save_DedicatedSaveMP.sav'),
    ];
    for (const savePath of saveFiles) {
      try {
        if (!fs.existsSync(savePath)) continue;
        const buf = fs.readFileSync(savePath);
        return parseSave(buf).players;
      } catch {
        /* try next */
      }
    }

    return new Map();
  }

  /** Parse save file and cache results. Uses save-cache.json when available. */
  _parseSaveData(): Map<string, unknown> {
    const now = Date.now();
    // Cache for 30s
    if (now - this._lastParse < 30000 && this._playerCache.size > 0) {
      return this._playerCache;
    }

    // Try save-cache.json first (written by bot's PlayerStatsChannel — fast, no .sav parsing)
    const cached = this._parseSaveDataForServer(DATA_DIR);
    if (cached.size > 0) {
      this._playerCache = cached;
      this._lastParse = now;
      return this._playerCache;
    }

    // Fallback: try raw .sav files
    const saveFiles = [
      path.join(DATA_DIR, 'Save_DedicatedSaveMP_NEW.sav'),
      path.join(DATA_DIR, 'Save_DedicatedSaveMP_LIVE.sav'),
      path.join(DATA_DIR, 'Save_DedicatedSaveMP.sav'),
    ];

    for (const savePath of saveFiles) {
      try {
        if (!fs.existsSync(savePath)) continue;
        const buf = fs.readFileSync(savePath);
        this._playerCache = parseSave(buf).players;
        this._lastParse = now;
        return this._playerCache;
      } catch (err: unknown) {
        console.error(`[WEB MAP] Failed to parse ${path.basename(savePath)}:`, errMsg(err));
      }
    }
    return this._playerCache;
  }

  /** Convert world coords to Leaflet [lat, lng] for CRS.Simple. */
  _worldToLeaflet(worldX: number, worldY: number): [number, number] {
    const b = this._worldBounds;
    // lat (vertical) = maps UE4 X (north/south) — X+ is up
    const lat = ((worldX - b.xMin) / (b.xMax - b.xMin)) * 4096;
    // lng (horizontal) = maps UE4 Y (east/west) — Y+ is right
    const lng = ((worldY - b.yMin) / (b.yMax - b.yMin)) * 4096;
    return [lat, lng];
  }

  /** Return SHOW_* toggles for the frontend to conditionally display sections. */
  _getToggles(): Record<string, unknown> {
    return {
      showVitals: config.showVitals,
      showHealth: config.showHealth,
      showHunger: config.showHunger,
      showThirst: config.showThirst,
      showStamina: config.showStamina,
      showImmunity: config.showImmunity,
      showBattery: config.showBattery,
      showStatusEffects: config.showStatusEffects,
      showPlayerStates: config.showPlayerStates,
      showBodyConditions: config.showBodyConditions,
      showInfectionBuildup: config.showInfectionBuildup,
      showFatigue: config.showFatigue,
      showInventory: config.showInventory,
      showEquipment: config.showEquipment,
      showQuickSlots: config.showQuickSlots,
      showPockets: config.showPockets,
      showBackpack: config.showBackpack,
      showRecipes: config.showRecipes,
      showCraftingRecipes: config.showCraftingRecipes,
      showBuildingRecipes: config.showBuildingRecipes,
      showLore: config.showLore,
      showCoordinates: config.showCoordinates,
      showRaidStats: config.showRaidStats,
      showPvpKills: config.showPvpKills,
      showConnections: config.showConnections,
    };
  }

  /** Set up Express routes. */
  _setupRoutes(): void {
    const app = this._app;

    // Discord OAuth2 authentication (must be registered before static/API routes)
    // Returns no-op middleware if DISCORD_OAUTH_SECRET / WEB_MAP_CALLBACK_URL are not set
    const authMiddleware = setupAuth(app, this._client, { db: this._db?.db });
    app.use(authMiddleware);

    // ── Root page → panel.html (must come before static middleware) ──
    // If plugins are registered, inject their CSS/JS/HTML before serving

    app.get('/', (_req, res) => {
      if (!this._plugins.length) {
        res.sendFile(path.join(PUBLIC_DIR, 'panel.html'));
        return;
      }
      // Read panel.html and inject plugin assets
      let html;
      try {
        html = fs.readFileSync(path.join(PUBLIC_DIR, 'panel.html'), 'utf8');
      } catch {
        res.sendFile(path.join(PUBLIC_DIR, 'panel.html'));
        return;
      }
      const cssLinks = this._plugins
        .flatMap((p: Record<string, unknown>) =>
          ((p.css || []) as string[]).map((href: string) => `<link rel="stylesheet" href="${href}"`),
        )
        .join('\n    ');
      const jsScripts = this._plugins
        .flatMap((p: Record<string, unknown>) =>
          ((p.js || []) as string[]).map((src: string) => `<script src="${src}"></script>`),
        )
        .join('\n    ');
      const dashHtml = this._plugins
        .map((p: Record<string, unknown>) => (p.dashboardHtml as string) || '')
        .filter(Boolean)
        .join('\n            ');
      if (cssLinks) html = html.replace('</head>', `    ${cssLinks}\n  </head>`);
      if (jsScripts) html = html.replace('</body>', `    ${jsScripts}\n  </body>`);
      if (dashHtml) html = html.replace('<!-- plugin-dashboard-slot -->', dashHtml);
      res.type('text/html').send(html);
    });

    // Serve i18n locale files from project root locales/ directory
    app.use('/locales', express.static(path.join(__dirname, '../../locales')));

    // Serve static files (HTML, JS, CSS, map images)
    app.use(express.static(PUBLIC_DIR, { dotfiles: 'deny' }));
    app.use(express.json());

    // ── Multi-server context middleware ──
    // Resolves ?server=<id> query param into a server context object on req.srv
    // Falls back to primary server if not specified or not found
    app.use('/api', (req, _res, next) => {
      const serverId =
        (req.query.server as string | undefined) ??
        ((req.body as Record<string, unknown> | undefined)?.server as string | undefined) ??
        'primary';
      req.srv = (this._resolveServer(serverId) ?? this._resolveServer('primary')) as ServerContext;
      next();
    });

    // ── API: List available servers (multi-server support) ──
    app.get('/api/servers', requireTier('survivor'), (_req, res) => {
      const servers = [{ id: 'primary', name: config.serverName || 'Primary Server' }];
      const additional = this._loadServerList();
      for (const s of additional) {
        const dir = this._getServerDataDir(s.id);
        if (dir) servers.push({ id: s.id, name: s.name || s.id });
      }
      res.json({ servers, multiServer: additional.length > 0 });
    });

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

    // ── API: Get all player positions ──
    app.get('/api/players', requireTier('survivor'), rateLimit(10000, 10), async (req, res) => {
      const srv = req.srv;
      const itemLocale = _requestLocale(req);

      // Resolve data sources based on server
      const players = srv.isPrimary ? this._parseSaveData() : this._parseSaveDataForServer(srv.dataDir);
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
          const onlineName = this._cleanPlayerDisplayName(p.name);
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

        const name = this._resolvePlayerDisplayName(steamId, data, srv.db, dbNameMap, onlineNameMap);
        let lat = null,
          lng = null;
        if (hasPosition) {
          [lat, lng] = this._worldToLeaflet(dx, dy as number);
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
        worldBounds: this._worldBounds,
        toggles: this._getToggles(),
        lastUpdated: new Date().toISOString(),
      });
    });

    // ── API: Get single player detail ──
    app.get('/api/players/:steamId', requireTier('survivor'), (req, res) => {
      const srv = req.srv;
      const steamId = req.params.steamId as string;
      const players = srv.isPrimary ? this._parseSaveData() : this._parseSaveDataForServer(srv.dataDir);
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
      const name = this._resolvePlayerDisplayName(steamId, data, srv.db, dbNameMap);
      const pdx = data.x as number | null;
      const pdy = data.y as number | null;
      const pdz = data.z as number | null;
      const hasPosition = pdx !== null && !(pdx === 0 && pdy === 0 && pdz === 0);
      let lat = null,
        lng = null;
      if (hasPosition) {
        [lat, lng] = this._worldToLeaflet(pdx, pdy as number);
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
        toggles: this._getToggles(),
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

    // ── API: Get world bounds / calibration ──

    app.get('/api/calibration', requireTier('admin'), (_req, res) => {
      res.json(this._worldBounds);
    });

    // ── API: Save calibration ──
    app.post('/api/calibration', requireTier('admin'), (req, res) => {
      const body1187 = req.body as { xMin: number; xMax: number; yMin: number; yMax: number };
      const { xMin, xMax, yMin, yMax } = body1187;
      if ([xMin, xMax, yMin, yMax].some((v) => typeof v !== 'number' || isNaN(v))) {
        sendError(res, API_ERRORS.INVALID_BOUNDS, 400);
        return;
      }
      this._saveCalibration({ xMin, xMax, yMin, yMax });
      res.json({ ok: true, bounds: this._worldBounds });
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

      this._saveCalibration(bounds);
      res.json({ ok: true, bounds });
    });

    // ── API: Admin action — kick ──
    app.post('/api/admin/kick', requireTier('mod'), rateLimit(5000, 5), async (req, res) => {
      const { steamId } = req.body as { steamId?: string };
      if (!steamId || typeof steamId !== 'string') {
        sendError(res, API_ERRORS.MISSING_STEAM_ID, 400);
        return;
      }
      // Validate steam ID format
      if (!/^\d{17}$/.test(steamId)) {
        sendError(res, API_ERRORS.INVALID_STEAM_ID_FORMAT, 400);
        return;
      }
      try {
        const result = await req.srv.rcon.send(`kick ${steamId}`);
        res.json({ ok: true, result });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    // ── API: Admin action — ban ──
    app.post('/api/admin/ban', requireTier('admin'), rateLimit(5000, 3), async (req, res) => {
      const { steamId } = req.body as { steamId?: string };
      if (!steamId || typeof steamId !== 'string') {
        sendError(res, API_ERRORS.MISSING_STEAM_ID, 400);
        return;
      }
      if (!/^\d{17}$/.test(steamId)) {
        sendError(res, API_ERRORS.INVALID_STEAM_ID_FORMAT, 400);
        return;
      }
      try {
        const result = await req.srv.rcon.send(`ban ${steamId}`);
        res.json({ ok: true, result });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    // ── API: RCON send message ──
    app.post('/api/admin/message', requireTier('mod'), rateLimit(3000, 5), async (req, res) => {
      const { message } = req.body as { message?: string };
      if (!message || typeof message !== 'string') {
        sendError(res, API_ERRORS.MISSING_MESSAGE, 400);
        return;
      }
      if (message.length > 500) {
        sendError(res, API_ERRORS.MESSAGE_TOO_LONG, 400);
        return;
      }
      // Sanitize: strip control chars and collapse newlines to prevent RCON injection
      const safe = stripControlChars(message)
        .replace(/[\r\n]+/g, ' ')
        .trim();
      if (!safe) {
        sendError(res, API_ERRORS.MESSAGE_EMPTY_AFTER_SANITIZATION, 400);
        return;
      }
      try {
        // Use 'admin' command — 'say' no longer returns a response as of game update March 2026.
        // Lead with </> to close default yellow, then <CL> for Discord-blue styling.
        const result = await req.srv.rcon.send(`admin </><CL>${safe}`);

        // Log to DB immediately so the web panel chat feed picks it up on next refresh
        // (don't rely on fetchchat polling — there's a race condition)
        if (req.srv.db) {
          try {
            req.srv.db.chatLog.insertChat({
              type: 'panel_to_game',
              playerName: '',
              message: safe,
              direction: 'outbound',
              discordUser: req.session.user?.displayName || 'Panel',
              isAdmin: true,
            });
          } catch (_) {}
        }

        res.json({ ok: true, result });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    // ── API: Get RCON player list (online status) ──
    app.get('/api/online', requireTier('survivor'), async (req, res) => {
      // Serve from background-polled player cache — instant response
      const cached = this._getCached('online', req.srv.serverId, 30000) as Record<string, unknown> | null;
      if (cached) return res.json({ players: cached });
      try {
        const list = await req.srv.getPlayerList();
        this._setCache('online', req.srv.serverId, list);
        res.json({ players: list });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
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
      const cached = this._getCached('landing', 'global', 30000) as Record<string, unknown> | null;
      if (cached) return res.json(cached);
      // First request before background poller has run — build on demand
      try {
        const rconTimeout = (promise: Promise<unknown>) =>
          Promise.race([
            promise,
            new Promise((_, rej) =>
              setTimeout(() => {
                rej(new Error('RCON timeout'));
              }, 5000),
            ),
          ]);
        await this._buildLandingData(rconTimeout);
        const built = this._getCached('landing', 'global', 30000) as Record<string, unknown> | null;
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

    // Plugin-registered routes
    for (const plugin of this._plugins) {
      if (typeof plugin.registerRoutes === 'function') {
        try {
          (
            plugin.registerRoutes as (
              app: typeof this._app,
              helpers: { rateLimit: typeof rateLimit; requireTier: typeof requireTier },
            ) => void
          )(app, { rateLimit, requireTier });
        } catch (err: unknown) {
          console.error(`[WEB MAP] Plugin ${plugin.name as string} route registration failed:`, errMsg(err));
        }
      }
    }

    // ═══════════════════════════════════════════════════════
    // Panel API routes — server management, activity, chat, RCON console, settings
    // ═══════════════════════════════════════════════════════

    // ── Status: Module status ──
    app.get('/api/status/modules', requireTier('admin'), (_req, res) => {
      res.json({ modules: this._moduleStatus || {} });
    });

    // ── Panel: Server status (RCON info + resources) — served from background cache ──
    app.get('/api/panel/status', requireTier('survivor'), async (req, res) => {
      const srv = req.srv;
      // Serve from background-polled cache — instant response
      const cached = this._getCached('status', srv.serverId, 30000) as Record<string, unknown> | null;
      if (cached) return res.json(cached);
      // Fallback: build on demand if background poller hasn't run yet
      try {
        const rconTimeout = (promise: Promise<unknown>) =>
          Promise.race([
            promise,
            new Promise((_, rej) =>
              setTimeout(() => {
                rej(new Error('RCON timeout'));
              }, 5000),
            ),
          ]);
        await this._buildStatusCache(srv, rconTimeout);
        const built = this._getCached('status', srv.serverId, 30000) as Record<string, unknown> | null;
        if (built) return res.json(built);
      } catch {
        /* build failed */
      }
      res.json({ serverState: 'unknown', onlineCount: 0, timezone: srv.config.botTimezone || 'UTC' });
    });

    // ── Panel: Quick stats — served from background cache ──
    app.get('/api/panel/stats', requireTier('survivor'), async (req, res) => {
      const srv = req.srv;
      // Serve from background-polled cache — instant response
      const cached = this._getCached('stats', srv.serverId, 30000) as Record<string, unknown> | null;
      if (cached) return res.json(cached);
      // Fallback: build on demand if background poller hasn't run yet
      try {
        const rconTimeout = (promise: Promise<unknown>) =>
          Promise.race([
            promise,
            new Promise((_, rej) =>
              setTimeout(() => {
                rej(new Error('RCON timeout'));
              }, 5000),
            ),
          ]);
        await this._buildStatsCache(srv, rconTimeout);
        const built = this._getCached('stats', srv.serverId, 30000) as Record<string, unknown> | null;
        if (built) return res.json(built);
      } catch {
        /* build failed */
      }
      res.json({ totalPlayers: 0, onlinePlayers: 0, eventsToday: 0, chatsToday: 0 });
    });

    // ── Panel: Server capabilities — tells the client what this server has ──
    app.get('/api/panel/capabilities', requireTier('survivor'), (req, res) => {
      const srv = req.srv;
      const cached = this._getCached('caps', srv.serverId, 30000) as Record<string, unknown> | null;
      if (cached) return res.json(cached);

      const caps: Record<string, unknown> = {
        db: !!srv.db,
        rcon: !!srv.rcon,
        scheduler: !!srv.scheduler?.isActive(),
        saveService: srv.isPrimary ? !!this._saveService : !!srv.db,
        resources: srv.isPrimary && !!serverResources,
        hasPlugin: this._plugins.some((p: Record<string, unknown>) => {
          // Check if this plugin is associated with this server
          if (srv.isPrimary) return false; // plugins are typically non-primary
          return !!p.name;
        }),
        isPrimary: srv.isPrimary,
        serverId: srv.serverId,
        serverName: srv.config.serverName || '',
      };
      // Check if this is the hzmod-enabled server
      for (const plugin of this._plugins) {
        if (plugin.name === 'hzmod') {
          // hzmod is registered with a serverId — only show on that server's dashboard
          const pluginSrv = plugin.serverId;
          if (!pluginSrv) {
            caps.hzmod = true;
            break;
          } // no serverId set → show everywhere
          if (pluginSrv === srv.serverId) {
            caps.hzmod = true;
          } // matches this server
          break;
        }
      }
      this._setCache('caps', srv.serverId, caps);
      res.json(caps);
    });

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
            const attributedName = this._resolveServerPlayerName(srv, out.steam_id);
            if (attributedName) out.attributed_name = attributedName;
          }
          if (!out.actor_name && out.steam_id && (!out.actor || actorIsSteamId)) {
            const actorName = this._resolveServerPlayerName(srv, out.steam_id);
            if (actorName) out.actor_name = actorName;
          } else if (!out.actor_name && out.actor) {
            const actorName = this._resolveServerPlayerName(srv, out.actor);
            if (actorName) out.actor_name = actorName;
          }
          if (!out.target_name && out.target_steam_id) {
            const targetName = this._resolveServerPlayerName(srv, out.target_steam_id);
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
          actor: this._resolveServerPlayerName(srv, p.steam_id) ?? p.steam_id,
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
    app.get('/api/panel/mapdata', requireTier('survivor'), rateLimit(10000, 10), (req, res) => {
      const srv = req.srv;
      if (!srv.db) return res.json({ structures: [], vehicles: [], containers: [], companions: [], deadBodies: [] });

      const layers = ((req.query.layers as string) || 'all').split(',');
      const showAll = layers.includes('all');
      const result: Record<string, unknown> = {};

      try {
        if (showAll || layers.includes('structures')) {
          const rows = srv.db.worldObject.getPositionedStructures() as StructureRow[];
          result.structures = rows.map((r: StructureRow) => {
            const [lat, lng] = this._worldToLeaflet(r.pos_x, r.pos_y);
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
            const [lat, lng] = this._worldToLeaflet(r.pos_x, r.pos_y);
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
            const [lat, lng] = this._worldToLeaflet(r.pos_x, r.pos_y);
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
            const [lat, lng] = this._worldToLeaflet(r.pos_x, r.pos_y);
            return { id: r.id, type: r.type, owner: r.owner_steam_id, lat, lng, health: r.health };
          });
        }

        if (showAll || layers.includes('deadBodies')) {
          const rows = srv.db.worldObject.getPositionedDeadBodies() as DeadBodyRow[];
          result.deadBodies = rows.map((r: DeadBodyRow) => {
            const [lat, lng] = this._worldToLeaflet(r.pos_x, r.pos_y);
            return { name: r.actor_name, lat, lng };
          });
        }

        if (showAll || layers.includes('quests')) {
          // SAFETY: getPositionedQuests() returns DbRow[] (Record<string, unknown>); single `as QuestRow[]` fails TS2352, runtime shape is SELECT * from quests
          const rows = srv.db.quest.getPositionedQuests() as unknown as QuestRow[];
          result.quests = rows.map((r: QuestRow) => {
            const [lat, lng] = this._worldToLeaflet(r.pos_x, r.pos_y);
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
        const wantAI =
          showAll || layers.includes('zombies') || layers.includes('animals') || layers.includes('bandits');
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
                const [lat, lng] = this._worldToLeaflet(r.pos_x, r.pos_y);
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

    registerItemsRoutes(app, this);

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
            const resolvedName = this._resolveServerPlayerName(srv, sid);
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

    registerChatOpsRoutes(app, this);
    registerBackupsSettingsRoutes(app, this);
    registerSchedulerRoutes(app, this);
    registerBotConfigRoutes(app, this);
    registerWelcomeFileRoutes(app, this);
    registerAnticheatRoutes(app, this);

    // ══════════════════════════════════════════════════════════════════
    //  Multi-Server Management API — fleet-wide CRUD, lifecycle, discovery
    // ══════════════════════════════════════════════════════════════════
    // NOTE: discovery MUST register before crud so /servers/discover and
    // /servers/test-connection match before the /servers/:id param route.
    registerServersDiscoveryRoutes(app, this);
    registerServersCrudRoutes(app, this);

    registerServersActionsRoutes(app, this);
    registerTimelineRoutes(app, this);
  }

  _addErrorHandler(): void {
    // Global error handler — catch unhandled errors in routes

    this._app.use(
      (
        err: unknown,
        _req: import('express').Request,
        res: import('express').Response,
        _next: import('express').NextFunction,
      ) => {
        console.error('[WEB MAP] Unhandled route error:', errMsg(err));
        if (!res.headersSent) {
          sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500);
        }
      },
    );
  }

  /**
   * Background polling — proactively builds cached responses for all endpoints.
   * Runs every 15s so client requests are always served from cache instantly.
   * All RCON calls for multiple servers run in parallel.
   */
  _startBackgroundPolling(): void {
    const POLL_INTERVAL = 15000;
    const RCON_TIMEOUT = 5000;
    const rconTimeout = (promise: Promise<unknown>) =>
      Promise.race([
        promise,
        new Promise((_, rej) =>
          setTimeout(() => {
            rej(new Error('RCON timeout'));
          }, RCON_TIMEOUT),
        ),
      ]);

    const poll = async (): Promise<void> => {
      try {
        // ── Build landing data (all servers in parallel) ──
        await this._buildLandingData(rconTimeout);

        // ── Build per-server status + stats caches ──
        const serverIds = ['primary'];
        const additional = this._loadServerList();
        for (const s of additional) serverIds.push(s.id);

        const statusPromises = serverIds.map(async (id) => {
          try {
            const srv = this._resolveServer(id === 'primary' ? '' : id);
            if (!srv) return;
            await this._buildStatusCache(srv, rconTimeout);
            await this._buildStatsCache(srv, rconTimeout);
          } catch {
            /* non-critical — individual server poll failure */
          }
        });
        await Promise.all(statusPromises);
      } catch (err: unknown) {
        console.error('[WEB MAP] Background poll error:', errMsg(err));
      }
    };

    // Initial poll (immediate, don't await — let server start)
    void poll();
    this._pollTimer = setInterval(() => void poll(), POLL_INTERVAL);
    this._pollTimer.unref();
    console.log(`[WEB MAP] Background polling started (every ${String(POLL_INTERVAL / 1000)}s)`);
  }

  /** Build and cache the landing page data. All RCON calls parallelised. */
  async _buildLandingData(rconTimeout: (p: Promise<unknown>) => Promise<unknown>): Promise<void> {
    const result: Record<string, unknown> & { primary: Record<string, unknown>; servers: Record<string, unknown>[] } = {
      primary: {
        name: config.serverName || 'HumanitZ Server',
        host: config.publicHost || '',
        gamePort: config.gamePort || '',
        status: 'unknown',
        onlineCount: 0,
        maxPlayers: null,
        totalPlayers: 0,
        gameDay: null,
        season: null,
        gameTime: null,
        timezone: config.botTimezone || 'UTC',
      },
      servers: [],
      schedule: null,
    };

    // Gather all RCON promises in parallel
    const additional = this._loadServerList();
    const primaryRcon = (async () => {
      try {
        const [infoRaw, listRaw] = await Promise.all([rconTimeout(_getServerInfo()), rconTimeout(_getPlayerList())]);
        const info = infoRaw as import('../rcon/server-info.js').ServerInfo | undefined;
        const list = listRaw as import('../rcon/server-info.js').PlayerList | undefined;
        if (info) {
          result.primary.status = 'online';
          result.primary.maxPlayers = info.maxPlayers || null;
          result.primary.gameDay = info.day || null;
          if (info.season) result.primary.season = info.season;
          if (info.name) result.primary.rconName = info.name;
          if (info.time) result.primary.gameTime = info.time;
        }
        const playerArr = list?.players || (Array.isArray(list) ? list : []);
        result.primary.onlineCount = playerArr.length;
      } catch {
        result.primary.status = 'offline';
      }
    })();

    const serverRcons = additional.map(async (s: Record<string, unknown>) => {
      const dir = this._getServerDataDir(s.id as string);
      if (!dir) return null;
      const serverInfo: Record<string, unknown> = {
        id: s.id,
        name: s.name || s.id,
        host: s.publicHost || s.host || config.publicHost || '',
        gamePort: s.gamePort || '',
        status: 'unknown',
        onlineCount: 0,
        totalPlayers: 0,
      };

      const srv = this._resolveServer(s.id as string);
      if (srv) {
        try {
          const [infoRaw, listRaw] = await Promise.all([
            rconTimeout(srv.getServerInfo()),
            rconTimeout(srv.getPlayerList()),
          ]);
          const info = infoRaw as import('../rcon/server-info.js').ServerInfo | undefined;
          const list = listRaw as import('../rcon/server-info.js').PlayerList | undefined;
          if (info) {
            serverInfo.status = 'online';
            serverInfo.maxPlayers = info.maxPlayers || null;
            serverInfo.gameDay = info.day || null;
            if (info.season) serverInfo.season = info.season;
            if (info.name) serverInfo.rconName = info.name;
            if (info.time) serverInfo.gameTime = info.time;
          }
          const playerArr = list?.players || (Array.isArray(list) ? list : []);
          serverInfo.onlineCount = playerArr.length;
        } catch {
          serverInfo.status = 'offline';
        }
      }

      // DB/file enrichment (fast, no RCON)
      if (srv?.db) {
        try {
          const cnt = srv.db.player.countAllPlayers();
          if (cnt) serverInfo.totalPlayers = cnt;
          if (!serverInfo.maxPlayers) {
            const settings = srv.db.botState.getStateJSON('server_settings', null) as Record<
              string,
              string | undefined
            > | null;
            if (settings) {
              if (settings.MaxPlayers) serverInfo.maxPlayers = parseInt(settings.MaxPlayers, 10) || null;
              if (settings.DaysPerSeason) serverInfo.daysPerSeason = parseInt(settings.DaysPerSeason, 10) || 28;
            }
          }
          if (!serverInfo.gameDay) {
            const ws = srv.db.worldState.getAllWorldState();
            if (ws.day) serverInfo.gameDay = ws.day;
            if (!serverInfo.season && ws.season) serverInfo.season = ws.season;
          }
        } catch {
          /* DB unavailable */
        }
      }
      if (!serverInfo.totalPlayers) {
        try {
          const saveData = this._parseSaveDataForServer(dir);
          serverInfo.totalPlayers = saveData.size || 0;
        } catch {
          /* non-critical */
        }
      }
      if (!serverInfo.gameDay) {
        const cacheFile = path.join(dir, 'save-cache.json');
        try {
          if (fs.existsSync(cacheFile)) {
            const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as { worldState?: { daysPassed?: unknown } };
            if (cache.worldState?.daysPassed != null) serverInfo.gameDay = cache.worldState.daysPassed;
            if (serverInfo.status === 'unknown') {
              const age = Date.now() - fs.statSync(cacheFile).mtimeMs;
              serverInfo.status = age < 600_000 ? 'online' : 'stale';
            }
          }
        } catch {
          /* non-critical */
        }
      }
      if (srv?.scheduler?.isActive()) {
        try {
          serverInfo.schedule = srv.scheduler.getStatus();
        } catch {
          /* scheduler unavailable */
        }
      }
      if (srv?.db) {
        try {
          const settings = srv.db.botState.getStateJSON('server_settings', null) as Record<
            string,
            string | undefined
          > | null;
          if (settings) serverInfo.settings = _extractLandingSettings(settings);
        } catch {
          /* non-critical */
        }
      }
      if (!serverInfo.settings) {
        try {
          const settingsFile = path.join(dir, 'server-settings.json');
          if (fs.existsSync(settingsFile))
            serverInfo.settings = _extractLandingSettings(
              JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, string | undefined>,
            );
        } catch {
          /* non-critical */
        }
      }
      if (srv) {
        const mods: string[] = [];
        if (srv.rcon.connected) mods.push('rcon');
        if (srv.db) mods.push('db');
        const inst = this._multiServerManager?.getInstance(s.id as string);
        if (inst?.saveService || inst?.hasSftp) mods.push('sftp');
        if (inst?.isModuleActive('serverScheduler') || srv.scheduler?.isActive()) mods.push('schedule');
        if (inst?.hasModule('logWatcher')) mods.push('logs');
        if (inst?.hasModule('chatRelay')) mods.push('chat');
        if (inst?.hasAvailableModule('anticheat')) mods.push('anticheat');
        if (
          this._plugins.some(
            (p: Record<string, unknown>) =>
              p.name === 'hzmod' && (p.serverId === s.id || (!p.serverId && s.id === 'vps_dev')),
          )
        )
          mods.push('hzmod');
        serverInfo.modules = mods;
      }
      return serverInfo;
    });

    // Run ALL RCON calls in parallel
    const [, ...serverResults] = await Promise.all([primaryRcon, ...serverRcons]);
    for (const si of serverResults) {
      if (si) result.servers.push(si);
    }

    // Non-RCON enrichment for primary (fast)
    if (this._db) {
      try {
        const cnt = this._db.player.countAllPlayers();
        if (cnt) result.primary.totalPlayers = cnt;
      } catch {
        /* db unavailable */
      }
    }
    if (!result.primary.totalPlayers) {
      const players = this._parseSaveData();
      result.primary.totalPlayers = players.size;
    }
    if (this._db) {
      try {
        if (!result.primary.maxPlayers) {
          const settings = this._db.botState.getStateJSON('server_settings', null) as Record<
            string,
            string | undefined
          > | null;
          if (settings) {
            if (settings.MaxPlayers) result.primary.maxPlayers = parseInt(settings.MaxPlayers, 10) || null;
            if (settings.DaysPerSeason) result.primary.daysPerSeason = parseInt(settings.DaysPerSeason, 10) || 28;
          }
        }
        const ws = this._db.worldState.getAllWorldState();
        if (!result.primary.gameDay && ws.day) result.primary.gameDay = ws.day;
        if (!result.primary.season && ws.season) result.primary.season = ws.season;
      } catch {
        /* db unavailable */
      }
    }
    if (!result.primary.maxPlayers) {
      try {
        const settingsFile = path.join(DATA_DIR, 'server-settings.json');
        if (fs.existsSync(settingsFile)) {
          const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, string | undefined>;
          if (settings.MaxPlayers) result.primary.maxPlayers = parseInt(settings.MaxPlayers, 10) || null;
        }
      } catch {
        /* ignore */
      }
    }
    if (!result.primary.gameDay) {
      try {
        const cachePath = path.join(DATA_DIR, 'save-cache.json');
        if (fs.existsSync(cachePath)) {
          const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { worldState?: { daysPassed?: unknown } };
          if (cache.worldState?.daysPassed != null) result.primary.gameDay = cache.worldState.daysPassed;
        }
      } catch {
        /* save-cache unavailable */
      }
    }
    if (this._db) {
      try {
        const settings = this._db.botState.getStateJSON('server_settings', null) as Record<
          string,
          string | undefined
        > | null;
        if (settings) result.primary.settings = _extractLandingSettings(settings);
      } catch {
        /* non-critical */
      }
    }
    if (!result.primary.settings) {
      try {
        const settingsFile = path.join(DATA_DIR, 'server-settings.json');
        if (fs.existsSync(settingsFile))
          result.primary.settings = _extractLandingSettings(
            JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, string | undefined>,
          );
      } catch {
        /* non-critical */
      }
    }
    if (this._scheduler && this._scheduler.isActive()) {
      try {
        result.schedule = this._scheduler.getStatus();
      } catch {
        /* scheduler unavailable */
      }
    }
    {
      const mods: string[] = [];
      if (rcon.connected) mods.push('rcon');
      if (this._db) mods.push('db');
      if (this._saveService) mods.push('sftp');
      if (this._scheduler && this._scheduler.isActive()) mods.push('schedule');
      if (this._plugins.some((p: Record<string, unknown>) => p.name === 'hzmod')) mods.push('hzmod');
      result.primary.modules = mods;
    }
    result.primary.discordInvite = config.discordInviteLink || '';
    for (const plugin of this._plugins) {
      if (typeof plugin.getLandingData === 'function') {
        try {
          Object.assign(result, (plugin.getLandingData as () => Record<string, unknown> | null | undefined)() ?? {});
        } catch {
          /* plugin error */
        }
      }
    }
    this._setCache('landing', 'global', result);
  }

  /** Build and cache status data for a single server. */
  async _buildStatusCache(srv: ServerContext, rconTimeout: (p: Promise<unknown>) => Promise<unknown>): Promise<void> {
    const result: Record<string, unknown> = {
      serverState: 'unknown',
      uptime: null,
      maxPlayers: null,
      onlineCount: 0,
      fps: null,
      gameDay: null,
      season: null,
      gameTime: null,
      timezone: srv.config.botTimezone || 'UTC',
      resources: null,
    };
    try {
      const [infoRaw, listRaw] = await Promise.all([
        rconTimeout(srv.getServerInfo()),
        rconTimeout(srv.getPlayerList()),
      ]);
      const info = infoRaw as import('../rcon/server-info.js').ServerInfo | undefined;
      const list = listRaw as import('../rcon/server-info.js').PlayerList | undefined;
      if (info) {
        result.serverState = 'running';
        result.fps = info.fps || null;
        result.gameDay = info.day || null;
        result.maxPlayers = info.maxPlayers || null;
        if (info.season) result.season = info.season;
        if (info.time) result.gameTime = info.time;
      }
      const playerArr = list?.players || (Array.isArray(list) ? list : []);
      result.onlineCount = playerArr.length;
      // Also cache the player list for /api/online
      this._setCache('online', srv.serverId, list);
    } catch {
      result.serverState = 'offline';
    }
    if (!result.maxPlayers) {
      try {
        const settingsFile = path.join(srv.dataDir, 'server-settings.json');
        if (fs.existsSync(settingsFile)) {
          const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, string | undefined>;
          if (settings.MaxPlayers) result.maxPlayers = parseInt(settings.MaxPlayers, 10) || null;
        }
      } catch {
        /* ignore */
      }
    }
    if (srv.isPrimary) {
      try {
        const resources = await serverResources.getResources();
        if (resources) {
          result.resources = {
            cpu: resources.cpu,
            memPercent: resources.memPercent,
            memFormatted:
              resources.memUsed != null && resources.memTotal != null
                ? `${formatBytes(resources.memUsed)} / ${formatBytes(resources.memTotal)}`
                : null,
            diskPercent: resources.diskPercent,
            diskFormatted:
              resources.diskUsed != null && resources.diskTotal != null
                ? `${formatBytes(resources.diskUsed)} / ${formatBytes(resources.diskTotal)}`
                : null,
            stale: resources.stale === true,
            cacheAgeMs: typeof resources.cacheAgeMs === 'number' ? resources.cacheAgeMs : null,
          };
          if (resources.uptime != null) result.uptime = formatUptime(resources.uptime);
        }
      } catch {
        /* resources unavailable */
      }
    }
    if (!result.gameDay) {
      try {
        const cachePath = path.join(srv.dataDir, 'save-cache.json');
        if (fs.existsSync(cachePath)) {
          const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { worldState?: { daysPassed?: unknown } };
          if (cache.worldState?.daysPassed != null) result.gameDay = cache.worldState.daysPassed;
        }
      } catch {
        /* save-cache unavailable */
      }
    }
    if (srv.db) {
      try {
        const ws = srv.db.worldState.getAllWorldState();
        if (!result.gameDay && ws.day) result.gameDay = ws.day;
        if (!result.season && ws.season) result.season = ws.season;
      } catch {
        /* db unavailable */
      }
    }
    try {
      const settingsFile = path.join(srv.dataDir, 'server-settings.json');
      if (fs.existsSync(settingsFile)) {
        const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, string | undefined>;
        if (settings.DaysPerSeason) result.daysPerSeason = parseInt(settings.DaysPerSeason, 10) || 28;
      }
    } catch {
      /* ignore */
    }
    if (!result.daysPerSeason && srv.db) {
      try {
        const s = srv.db.botState.getStateJSON('server_settings', null) as Record<string, string | undefined> | null;
        if (s) {
          if (s.DaysPerSeason) result.daysPerSeason = parseInt(s.DaysPerSeason, 10) || 28;
        }
      } catch {
        /* db unavailable */
      }
    }
    this._setCache('status', srv.serverId, result);
  }

  /** Build and cache stats data for a single server. */
  async _buildStatsCache(srv: ServerContext, rconTimeout: (p: Promise<unknown>) => Promise<unknown>): Promise<void> {
    const result: Record<string, unknown> = { totalPlayers: 0, onlinePlayers: 0, eventsToday: 0, chatsToday: 0 };
    const players = srv.isPrimary ? this._parseSaveData() : this._parseSaveDataForServer(srv.dataDir);
    result.totalPlayers = players.size;
    if (!result.totalPlayers && srv.db) {
      try {
        const cnt = srv.db.player.countAllPlayers();
        if (cnt) result.totalPlayers = cnt;
      } catch {
        /* db unavailable */
      }
    }
    // Use status cache for online count (already built)
    const statusCache = this._getCached('status', srv.serverId, 30000) as Record<string, unknown> | null;
    if (statusCache) {
      result.onlinePlayers = statusCache.onlineCount || 0;
    } else {
      try {
        const listRaw = await rconTimeout(srv.getPlayerList());
        const list = listRaw as import('../rcon/server-info.js').PlayerList | undefined;
        const playerArr = list?.players || (Array.isArray(listRaw) ? listRaw : []);
        result.onlinePlayers = (playerArr as unknown[]).length;
      } catch {
        /* RCON unavailable */
      }
    }
    if (srv.db) {
      try {
        const tz = srv.config.botTimezone || 'UTC';
        const nowStr = new Date().toLocaleDateString('en-CA', { timeZone: tz });
        const todayMidnight = new Date(`${nowStr}T00:00:00`);
        const tzDate = new Date(todayMidnight.toLocaleString('en-US', { timeZone: 'UTC' }));
        const localDate = new Date(todayMidnight.toLocaleString('en-US', { timeZone: tz }));
        const offsetMs = tzDate.getTime() - localDate.getTime();
        const todayIso = new Date(todayMidnight.getTime() + offsetMs).toISOString();
        result.eventsToday = srv.db.activityLog.countActivitySince(todayIso);
        result.chatsToday = srv.db.chatLog.countChatSince(todayIso);
      } catch {
        /* db unavailable */
      }
    }
    this._setCache('stats', srv.serverId, result);
  }

  start(): Promise<void> {
    this._addErrorHandler();
    return new Promise((resolve, reject) => {
      this._server = this._app.listen(this._port, () => {
        console.log(`[WEB MAP] Interactive map running at http://localhost:${this._port}`);
        this._startBackgroundPolling();
        resolve();
      });
      this._server.on('error', (err: Error) => {
        console.error('[WEB MAP] Server error:', errMsg(err));
        reject(err);
      });
    });
  }

  /** Stop the server. */
  stop(): void {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._server) {
      this._server.close();
      this._server = null;
      console.log('[WEB MAP] Server stopped');
    }
  }
}

export default WebMapServer;
export { WebMapServer };
