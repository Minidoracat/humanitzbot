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
import { parseSave } from '../parsers/save-parser.js';
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
  safeUnknownString,
  _extractLandingSettings,
  _cleanInventorySlots,
  createRconTimeout,
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
import { registerDbRoutes } from './routes/db.routes.js';
import { registerActivityRoutes } from './routes/activity.routes.js';
import { registerMapdataRoutes } from './routes/mapdata.routes.js';
import { registerPlayersRoutes } from './routes/players.routes.js';
import { registerMeRoutes } from './routes/me.routes.js';
import { registerAdminActionsRoutes } from './routes/admin-actions.routes.js';
import { registerCalibrationRoutes } from './routes/calibration.routes.js';
import { registerStatusRoutes } from './routes/status.routes.js';
import { registerPublicRoutes } from './routes/public.routes.js';

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
          // Steam 頭像 CDN（steam profile sync）—— 與 steam-profile.ts 的 AVATAR_HOST_RE
          // 保持同一組 host（Steam 在這些 avatars.* CDN 間輪替）。
          "img-src 'self' https://cdn.discordapp.com https://avatars.steamstatic.com https://avatars.akamai.steamstatic.com https://avatars.cloudflare.steamstatic.com https://avatars.fastly.steamstatic.com data: blob:",
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
    // userLinks getter 在 DB 未 init 時會 throw —— 正常啟動流程 DB 先於 web map
    // init，這裡的 try 只是防禦（不讓 web map 因 DB 掛掉整個 crash）。
    let userLinksRepo;
    try {
      userLinksRepo = this._db?.userLinks;
    } catch {
      userLinksRepo = undefined;
    }
    const authMiddleware = setupAuth(app, this._client, { db: this._db?.db, userLinks: userLinksRepo });
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
    app.use(
      express.static(PUBLIC_DIR, {
        dotfiles: 'deny',
        setHeaders: (res, filePath) => {
          // Content-hashed assets (e.g. map_color.<hash>.webp) never change for a
          // given name — cache them forever so the basemap costs zero bandwidth on
          // repeat visits. The hash in the filename busts the cache on re-render.
          if (/\.[0-9a-f]{8}\.\w+$/.test(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      }),
    );
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

    // ── Pre-plugin core routes ──
    // These register BEFORE the plugin loop, exactly as on main (where
    // /api/servers, /api/landing, the player + calibration + admin routes all
    // preceded the plugin registration boundary). Order among them is
    // behavior-neutral (no overlapping paths); the plugin boundary is what
    // determines Express first-match precedence for plugin-registered routes.
    registerPublicRoutes(app, this);
    registerCalibrationRoutes(app, this);
    registerPlayersRoutes(app, this);
    registerMeRoutes(app, this);
    registerAdminActionsRoutes(app, this);

    // Plugin-registered routes — boundary preserved from main: plugins register
    // after the pre-plugin core routes above and before /api/status/modules and
    // the panel status/activity/... routes below.
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

    // ── Post-plugin routes ──
    registerStatusRoutes(app, this);
    registerActivityRoutes(app, this);
    registerDbRoutes(app, this);
    registerMapdataRoutes(app, this);
    registerItemsRoutes(app, this);

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
        req: import('express').Request,
        res: import('express').Response,
        _next: import('express').NextFunction,
      ) => {
        // 只記 path（不含 query，避免洩漏 OAuth code/state 等敏感參數）並剝 CR/LF 防 log forging
        const safePath = req.path.replace(/[\r\n\t]+/g, ' ');
        console.error(`[WEB MAP] Unhandled route error: ${req.method} ${safePath} —`, errMsg(err));
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
    const rconTimeout = createRconTimeout(RCON_TIMEOUT);

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
