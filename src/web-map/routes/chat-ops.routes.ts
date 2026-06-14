/**
 * Chat + operations routes: chat log read, RCON command execution (sanitized +
 * blocklisted), snapshot refresh (force save + re-poll), and server power
 * controls (Pterodactyl API with Docker CLI fallback).
 *
 * Behavior-preserving extraction from web-map/server.ts (P1-1 god-file split).
 * Handlers are verbatim; only `this.` -> `ctx.` was applied.
 */
import type { Express } from 'express';
import type { WebMapRouteContext } from '../types/route-context.js';
import path from 'path';
import { requireTier } from '../auth.js';
import { rateLimit } from '../rate-limit.js';
import { API_ERRORS, sendError, sendOk } from '../api-errors.js';
import { safeError, stripControlChars } from '../route-helpers.js';
import type { ChatRow } from '../types/db-rows.js';

export function registerChatOpsRoutes(app: Express, ctx: WebMapRouteContext): void {
  // ── Panel: Chat log from DB ──
  app.get('/api/panel/chat', requireTier('survivor'), (req, res) => {
    const srv = req.srv;
    if (!srv.db) return res.json({ messages: [] });

    const limit = Math.min(parseInt((req.query.limit as string) || '', 10) || 100, 1000);
    const search = ((req.query.search as string) || '').trim();

    try {
      let messages: ChatRow[];
      if (search) {
        messages = srv.db.chatLog.searchChat(search, limit) as ChatRow[];
      } else {
        messages = srv.db.chatLog.getRecentChat(limit) as ChatRow[];
      }
      res.json({ messages });
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });

  // ── Panel: RCON command execution ──
  app.post('/api/panel/rcon', requireTier('admin'), rateLimit(10000, 10), async (req, res) => {
    const { command } = req.body as { command?: string };
    if (!command || typeof command !== 'string') {
      sendError(res, API_ERRORS.MISSING_COMMAND, 400);
      return;
    }
    if (command.length > 500) {
      sendError(res, API_ERRORS.COMMAND_TOO_LONG, 400);
      return;
    }

    // Sanitize: strip control chars and newlines to prevent RCON protocol injection
    const sanitized = stripControlChars(command)
      .replace(/[\r\n]+/g, ' ')
      .trim();
    if (!sanitized) {
      sendError(res, API_ERRORS.COMMAND_EMPTY_AFTER_SANITIZATION, 400);
      return;
    }

    // Safety: block dangerous commands by first word (consolidated blocklist)
    const cmdWord = sanitized.toLowerCase().split(/\s+/)[0];
    const BLOCKED_RCON = new Set([
      'exit',
      'quit',
      'shutdown',
      'destroyall',
      'destroy_all',
      'wipe',
      'reset',
      'restartnow',
      'quickrestart',
      'cancelrestart',
    ]);
    if (cmdWord && BLOCKED_RCON.has(cmdWord)) {
      sendError(res, API_ERRORS.COMMAND_BLOCKED_FOR_SAFETY, 403, cmdWord);
      return;
    }

    try {
      const response = await req.srv.rcon.send(sanitized);
      res.json({ ok: true, response });
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });

  // POST /api/panel/refresh-snapshot — Force game save + re-poll save file + record fresh snapshot
  app.post('/api/panel/refresh-snapshot', requireTier('mod'), rateLimit(30000, 2), async (req, res) => {
    if (!ctx._saveService) {
      sendError(res, API_ERRORS.SAVE_SERVICE_NOT_AVAILABLE, 503);
      return;
    }

    try {
      // Step 1: Tell the game server to save
      try {
        await req.srv.rcon.send('save');
      } catch {
        /* RCON may not be connected — continue anyway, save file may still be recent */
      }

      // Step 2: Wait briefly for the save to flush to disk
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Step 3: Force save service to re-poll (downloads .sav, parses, syncs DB, emits 'sync' → snapshot recorded)
      await ctx._saveService._poll(true);

      sendOk(res, { message: 'Snapshot refreshed' });
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });

  // ── Panel: Server power controls ──
  // Supports Docker CLI (VPS), Pterodactyl API, or SSH-based controls
  app.post('/api/panel/power', requireTier('admin'), rateLimit(30000, 3), async (req, res) => {
    const { action } = req.body as { action?: string };
    const valid = ['start', 'stop', 'restart', 'backup', 'kill'];
    if (!action || !valid.includes(action)) {
      sendError(res, API_ERRORS.INVALID_ACTION, 400, action);
      return;
    }

    // Try Pterodactyl API first (per-server or primary singleton)
    const srvPanelApi = req.srv.panelApi;
    if (srvPanelApi && srvPanelApi.available) {
      try {
        if (action === 'backup') {
          await srvPanelApi.createBackup();
          sendOk(res, { message: 'Backup initiated via panel API' });
          return;
        }
        await srvPanelApi.sendPowerAction(action);
        sendOk(res, { message: `Server ${action} sent via panel API` });
        return;
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
        return;
      }
    }

    // Fall back to Docker CLI (VPS setup)
    const { execFile } = await import('child_process');
    // Use server-specific container name, fall back to env
    const dockerContainer = (req.srv.config.dockerContainer || process.env.DOCKER_CONTAINER || 'hzserver').replace(
      /[^a-zA-Z0-9_.-]/g,
      '',
    );

    if (action === 'backup') {
      const backupDir = path.join(req.srv.dataDir, 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
      execFile(
        'docker',
        ['cp', `${dockerContainer}:/home/steam/hzserver/serverfiles/HumanitZServer/Saved`, backupDir],
        { timeout: 30000 },
        (err: Error | null) => {
          if (err) {
            sendError(res, API_ERRORS.BACKUP_FAILED, 500);
            return;
          }
          sendOk(res, { message: 'Backup created' });
        },
      );
      return;
    }

    execFile(
      'docker',
      [action, dockerContainer],
      { timeout: 30000 },
      (err: Error | null, _stdout: string, _stderr: string) => {
        if (err) {
          sendError(res, API_ERRORS.DOCKER_COMMAND_FAILED, 500);
          return;
        }
        sendOk(res, { message: `Server ${action} executed` });
      },
    );
  });
}
