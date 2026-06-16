/**
 * Server CRUD routes: list servers with live status, create a managed server,
 * and get/update/delete a single managed server (passwords masked).
 *
 * Behavior-preserving extraction from web-map/server.ts (P1-1 god-file split).
 * Handlers are verbatim; only `this.` -> `ctx.` (and the local `configRepo` ->
 * `ctx._configRepo`) was applied.
 */
import type { Express } from 'express';
import type { WebMapRouteContext } from '../types/route-context.js';
import config from '../../config/index.js';
import rcon from '../../rcon/rcon.js';
import { requireTier } from '../auth.js';
import { rateLimit } from '../rate-limit.js';
import { API_ERRORS, sendError, sendOk } from '../api-errors.js';
import { safeError } from '../route-helpers.js';
import { _maskServerDef } from '../serverdef-repo.js';
import { errMsg } from '../../utils/error.js';

export function registerServersCrudRoutes(app: Express, ctx: WebMapRouteContext): void {
  /** GET /api/panel/servers — List all servers with status */
  app.get('/api/panel/servers', requireTier('admin'), rateLimit(10000, 10), (_req, res) => {
    try {
      const servers = [];

      // ── Primary server ──
      const primaryInfo = {
        id: 'primary',
        name: config.serverName || 'Primary Server',
        isPrimary: true,
        enabled: true,
        status: rcon.connected ? 'running' : 'offline',
        players: { current: 0, max: null },
        rcon: { host: config.rconHost || null, port: config.rconPort || null, connected: rcon.connected },
        sftp: { host: config.sftpHost || null, configured: !!(config.sftpHost && config.sftpUser) },
        lastSync: (() => {
          const ss = ctx._saveService;
          if (!ss) return null;
          const ssStats = ss.stats;
          const t = ssStats.lastMtime as number | null;
          return t ? new Date(t).toISOString() : (ssStats.syncCount as number) > 0 ? new Date().toISOString() : null;
        })(),
        modules: [],
      };
      const primaryStatusCache = ctx._getCached('status', 'primary', 30000) as Record<string, unknown> | null;
      if (primaryStatusCache) {
        primaryInfo.status = (primaryStatusCache.serverState as string) || 'unknown';
        primaryInfo.players.current = (primaryStatusCache.onlineCount as number) || 0;
        (primaryInfo as Record<string, unknown>).players = {
          ...((primaryInfo as Record<string, unknown>).players as Record<string, unknown>),
          max: (primaryStatusCache.maxPlayers as number) || null,
        };
      }
      const primaryMods: string[] = [];
      if (rcon.connected) primaryMods.push('rcon');
      if (ctx._db) primaryMods.push('db');
      if (ctx._saveService) primaryMods.push('sftp');
      if (ctx._scheduler?.isActive()) primaryMods.push('schedule');
      (primaryInfo as Record<string, unknown>).modules = primaryMods;
      servers.push(primaryInfo);

      // ── Managed servers ──
      const managed = ctx._loadServerList();
      const statuses: Record<string, unknown>[] = ctx._multiServerManager?.getStatuses() || [];
      const statusMap = new Map(statuses.map((s) => [s.id as string, s]));

      for (const def of managed) {
        const st = statusMap.get(def.id);
        const inst = ctx._multiServerManager?.getInstance(def.id);
        const info: Record<string, unknown> = {
          id: def.id,
          name: def.name || def.id,
          isPrimary: false,
          enabled: def.enabled !== false,
          status: st?.running ? 'running' : 'stopped',
          players: { current: 0, max: null },
          rcon: {
            host: (def.rcon as Record<string, unknown> | undefined)?.host || null,
            port: (def.rcon as Record<string, unknown> | undefined)?.port || null,
            connected: !!(inst?.rcon && inst.rcon.connected),
          },
          sftp: {
            host: (def.sftp as Record<string, unknown> | undefined)?.host || null,
            configured: !!(
              (def.sftp as Record<string, unknown> | undefined)?.host &&
              (def.sftp as Record<string, unknown> | undefined)?.user
            ),
          },
          lastSync: null,
          modules: [] as string[],
        };
        const srvCache = ctx._getCached('status', def.id, 30000) as Record<string, unknown> | null;
        if (srvCache) {
          if (srvCache.serverState === 'running') info.status = 'running';
          (info.players as Record<string, unknown>).current = srvCache.onlineCount || 0;
          (info.players as Record<string, unknown>).max = srvCache.maxPlayers || null;
        }
        const mods: string[] = [];
        if (inst?.rcon && inst.rcon.connected) mods.push('rcon');
        if (inst?.db) mods.push('db');
        if (inst?.saveService || inst?.hasSftp) mods.push('sftp');
        if (inst?.isModuleActive('serverScheduler')) mods.push('schedule');
        if (inst?.hasModule('logWatcher')) mods.push('logs');
        if (inst?.hasModule('chatRelay')) mods.push('chat');
        info.modules = mods;
        servers.push(info);
      }

      sendOk(res, { servers });
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });
  /** POST /api/panel/servers — Create a new managed server */
  app.post('/api/panel/servers', requireTier('admin'), rateLimit(10000, 5), async (req, res) => {
    try {
      const {
        name,
        rcon: rconCfg,
        sftp,
        channels,
        enabled,
        startImmediately,
      } = req.body as {
        name?: string;
        rcon?: { host: string; port: number; password: string };
        sftp?: { host?: string; port?: number; user?: string; password?: string; privateKeyPath?: string };
        channels?: unknown;
        enabled?: boolean;
        startImmediately?: boolean;
      };
      if (!name || typeof name !== 'string' || !name.trim()) {
        sendError(res, API_ERRORS.MISSING_SERVER_NAME, 400);
        return;
      }
      if (!rconCfg || !rconCfg.host || !rconCfg.port || !rconCfg.password) {
        sendError(res, API_ERRORS.MISSING_RCON_CONFIG, 400);
        return;
      }

      // Check name uniqueness
      const existing = ctx._loadServerList();
      if (existing.some((s: { name?: string }) => s.name === name.trim())) {
        sendError(res, API_ERRORS.SERVER_NAME_EXISTS, 409);
        return;
      }

      const id = 'srv_' + Date.now().toString(36);
      const serverDef: Record<string, unknown> = {
        id,
        name: name.trim(),
        enabled: enabled !== false,
        rcon: {
          host: rconCfg.host,
          port: rconCfg.port || 27015,
          password: rconCfg.password,
        },
      };
      if (sftp) {
        serverDef.sftp = {
          host: sftp.host || '',
          port: Number(sftp.port) || 22,
          user: sftp.user || '',
          ...(sftp.password ? { password: sftp.password } : {}),
          ...(sftp.privateKeyPath ? { privateKeyPath: sftp.privateKeyPath } : {}),
        };
      }
      if (channels && typeof channels === 'object') serverDef.channels = channels;

      if (startImmediately && ctx._multiServerManager) {
        await ctx._multiServerManager.addServer(serverDef as Parameters<typeof ctx._multiServerManager.addServer>[0]);
      } else if (ctx._configRepo) {
        ctx._configRepo.set(`server:${id}`, serverDef);
      }

      res.status(201).json({ ok: true, server: { id, name: serverDef.name, status: 'stopped' } });
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });
  /** GET /api/panel/servers/:id — Get server detail (passwords masked) */
  app.get('/api/panel/servers/:id', requireTier('admin'), rateLimit(10000, 10), (req, res) => {
    try {
      const id = req.params.id as string;

      if (id === 'primary') {
        const def: Record<string, unknown> = {
          id: 'primary',
          name: config.serverName || 'Primary Server',
          isPrimary: true,
          enabled: true,
          rcon: {
            host: config.rconHost || '',
            port: config.rconPort || 27015,
            password: { hasValue: !!config.rconPassword },
          },
          sftp: {
            host: config.sftpHost || '',
            port: config.sftpPort || 22,
            user: config.sftpUser || '',
            password: { hasValue: !!config.sftpPassword },
            privateKeyPath: { hasValue: !!config.sftpPrivateKeyPath },
          },
          paths: {
            logPath: config.sftpLogPath || '',
            connectLogPath: config.sftpConnectLogPath || '',
            idMapPath: config.sftpIdMapPath || '',
            savePath: config.sftpSavePath || '',
            settingsPath: config.sftpSettingsPath || '',
            welcomePath: config.sftpWelcomePath || '',
          },
          botTimezone: config.botTimezone || 'UTC',
          logTimezone: config.logTimezone || 'UTC',
        };
        const statusCache = ctx._getCached('status', 'primary', 30000) as Record<string, unknown> | null;
        if (statusCache) {
          def.status = statusCache.serverState || 'unknown';
          def.players = { current: statusCache.onlineCount || 0, max: statusCache.maxPlayers || null };
        } else {
          def.status = rcon.connected ? 'running' : 'offline';
          def.players = { current: 0, max: null };
        }
        sendOk(res, { server: def });
        return;
      }

      // Managed server
      const raw = ctx._configRepo?.get(`server:${id}`);
      if (!raw) {
        sendError(res, API_ERRORS.SERVER_NOT_FOUND, 404);
        return;
      }

      const masked = _maskServerDef(raw);
      const inst = ctx._multiServerManager?.getInstance(id);
      masked.status = inst?.running ? 'running' : 'stopped';
      const srvCache = ctx._getCached('status', id, 30000) as Record<string, unknown> | null;
      if (srvCache) {
        masked.players = { current: srvCache.onlineCount || 0, max: srvCache.maxPlayers || null };
      } else {
        masked.players = { current: 0, max: null };
      }

      sendOk(res, { server: masked });
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });

  /** PATCH /api/panel/servers/:id — Update server settings (partial) */
  app.patch('/api/panel/servers/:id', requireTier('admin'), rateLimit(10000, 5), async (req, res) => {
    try {
      const id = req.params.id as string;
      const updates = req.body as Record<string, unknown> | null;
      if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
        sendError(res, API_ERRORS.MISSING_CHANGES_OBJECT, 400);
        return;
      }

      if (id === 'primary') {
        if (ctx._configRepo) {
          const patch: Record<string, unknown> = { ...updates };
          // Empty-string sensitive fields = "keep existing"
          if (patch.rcon) {
            const rcon = { ...(patch.rcon as Record<string, unknown>) };
            if (rcon.password === '') delete rcon.password;
            patch.rcon = rcon;
          }
          if (patch.sftp) {
            const sftp = { ...(patch.sftp as Record<string, unknown>) };
            if (sftp.password === '') delete sftp.password;
            if (sftp.privateKeyPath === '') delete sftp.privateKeyPath;
            patch.sftp = sftp;
          }
          ctx._configRepo.update('server:primary', patch);
        }
        const restartRequired = !!(updates.rcon || updates.sftp || updates.paths);
        sendOk(res, { restartRequired });
        return;
      }

      // Managed server
      if (!ctx._configRepo) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500);
        return;
      }
      const existing: Record<string, unknown> = ctx._configRepo.get(`server:${id}`) ?? {};
      if (!Object.keys(existing).length) {
        sendError(res, API_ERRORS.SERVER_NOT_FOUND, 404);
        return;
      }

      // Deep-merge sub-objects; empty-string sensitive fields = keep existing
      const patch: Record<string, unknown> = { ...updates };
      if (patch.rcon) {
        const existRcon = (existing.rcon as Record<string, unknown> | undefined) ?? {};
        const rcon: Record<string, unknown> = { ...existRcon, ...(patch.rcon as Record<string, unknown>) };
        if (rcon.password === '') rcon.password = existRcon.password ?? '';
        patch.rcon = rcon;
      }
      if (patch.sftp) {
        const existSftp = (existing.sftp as Record<string, unknown> | undefined) ?? {};
        const sftp: Record<string, unknown> = { ...existSftp, ...(patch.sftp as Record<string, unknown>) };
        if (sftp.password === '') sftp.password = existSftp.password ?? '';
        if (sftp.privateKeyPath === '') sftp.privateKeyPath = existSftp.privateKeyPath ?? '';
        patch.sftp = sftp;
      }
      if (patch.panel) {
        const existPanel = (existing.panel as Record<string, unknown> | undefined) ?? {};
        const panel: Record<string, unknown> = { ...existPanel, ...(patch.panel as Record<string, unknown>) };
        if (panel.apiKey === '') panel.apiKey = existPanel.apiKey ?? '';
        patch.panel = panel;
      }
      if (patch.channels) {
        patch.channels = {
          ...(existing.channels ?? {}),
          ...(patch.channels as Record<string, unknown>),
        };
      }
      if (patch.paths) {
        patch.paths = {
          ...(existing.paths ?? {}),
          ...(patch.paths as Record<string, unknown>),
        };
      }

      ctx._configRepo.update(`server:${id}`, patch);

      // Hot-reload running instance if applicable
      if (ctx._multiServerManager?.getInstance(id)?.running) {
        try {
          await ctx._multiServerManager.updateServer(id, patch);
        } catch (hotReloadErr: unknown) {
          console.warn('[WebMap] Hot-reload for server %s failed, will apply on next start:', id, errMsg(hotReloadErr));
        }
      }

      const restartRequired = !!(updates.rcon || updates.sftp || updates.paths);
      sendOk(res, { restartRequired });
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });

  /** DELETE /api/panel/servers/:id — Remove a managed server */
  app.delete('/api/panel/servers/:id', requireTier('admin'), rateLimit(10000, 3), async (req, res) => {
    try {
      const id = req.params.id as string;
      if (id === 'primary') {
        sendError(res, API_ERRORS.CANNOT_DELETE_PRIMARY, 403);
        return;
      }
      if (req.query.confirm !== 'true') {
        sendError(res, API_ERRORS.CONFIRM_REQUIRED, 400);
        return;
      }

      if (ctx._configRepo) {
        const existing = ctx._configRepo.get(`server:${id}`);
        if (!existing) {
          sendError(res, API_ERRORS.SERVER_NOT_FOUND, 404);
          return;
        }
      }

      if (ctx._multiServerManager) {
        try {
          await ctx._multiServerManager.removeServer(id);
        } catch (removeErr: unknown) {
          console.warn('[WebMap] removeServer(%s) cleanup warning:', id, errMsg(removeErr));
        }
      }
      if (ctx._configRepo) {
        ctx._configRepo.delete(`server:${id}`);
      }

      sendOk(res);
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });
}
