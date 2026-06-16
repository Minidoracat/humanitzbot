/**
 * Server action routes: per-server lifecycle control (start/stop/restart),
 * per-server auto-messages config (read/write), and global bot-actions
 * (restart/reimport/factory-reset/env-sync).
 *
 * Behavior-preserving extraction from web-map/server.ts (P1-1 god-file split).
 * Handlers are verbatim; only `this.` -> `ctx.` (and the local `configRepo` ->
 * `ctx._configRepo`) was applied.
 */
import type { Express } from 'express';
import type { WebMapRouteContext } from '../types/route-context.js';
import { requireTier } from '../auth.js';
import { rateLimit } from '../rate-limit.js';
import { API_ERRORS, sendError, sendOk } from '../api-errors.js';
import { safeError } from '../route-helpers.js';

export function registerServersActionsRoutes(app: Express, ctx: WebMapRouteContext): void {
  /** POST /api/panel/servers/:id/actions/:action — Lifecycle control (start/stop/restart) */
  app.post('/api/panel/servers/:id/actions/:action', requireTier('admin'), rateLimit(10000, 5), async (req, res) => {
    try {
      const id = req.params.id as string;
      const action = req.params.action as string;
      if (id === 'primary') {
        sendError(res, API_ERRORS.CANNOT_CONTROL_PRIMARY, 400);
        return;
      }
      if (!['start', 'stop', 'restart'].includes(action)) {
        sendError(res, API_ERRORS.INVALID_LIFECYCLE_ACTION, 400);
        return;
      }
      if (!ctx._multiServerManager) {
        sendError(res, API_ERRORS.MULTI_SERVER_NOT_AVAILABLE, 500);
        return;
      }

      // Verify server definition exists
      const def = ctx._configRepo?.get(`server:${id}`);
      if (!def) {
        sendError(res, API_ERRORS.SERVER_NOT_FOUND, 404);
        return;
      }

      const inst = ctx._multiServerManager.getInstance(id);

      if (action === 'start') {
        if (inst?.running) {
          sendError(res, API_ERRORS.SERVER_ALREADY_IN_STATE, 409);
          return;
        }
        await ctx._multiServerManager.startServer(id);
        sendOk(res, { status: 'running' });
        return;
      }

      if (action === 'stop') {
        if (!inst?.running) {
          sendError(res, API_ERRORS.SERVER_ALREADY_IN_STATE, 409);
          return;
        }
        await ctx._multiServerManager.stopServer(id);
        sendOk(res, { status: 'stopped' });
        return;
      }

      // restart
      if (inst?.running) {
        await ctx._multiServerManager.stopServer(id);
      }
      await ctx._multiServerManager.startServer(id);
      sendOk(res, { status: 'running' });
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });
  // ── Panel: Per-Server Auto-Messages ──
  /** GET /api/panel/servers/:id/auto-messages — Read auto-messages config for a server */
  app.get('/api/panel/servers/:id/auto-messages', requireTier('admin'), rateLimit(10000, 10), (req, res) => {
    try {
      const id = req.params.id as string;
      const defaults = {
        enableWelcomeMsg: true,
        enableWelcomeFile: false,
        enableAutoMsgLink: true,
        enableAutoMsgPromo: true,
        linkText: '',
        promoText: '',
        discordLink: '',
      };
      if (!ctx._configRepo) {
        sendError(res, API_ERRORS.NO_DATABASE, 503, 'Config database not available');
        return;
      }
      const scope = `server:${id}`;
      if (id !== 'primary' && !ctx._configRepo.get(scope)) {
        sendError(res, API_ERRORS.SERVER_NOT_FOUND, 404);
        return;
      }
      const serverData = ctx._configRepo.get(scope) || {};
      const stored = serverData.autoMessages || null;
      const data = Object.assign({}, defaults, stored || {});
      sendOk(res, data);
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });

  /** POST /api/panel/servers/:id/auto-messages — Save auto-messages config for a server */
  app.post('/api/panel/servers/:id/auto-messages', requireTier('admin'), rateLimit(10000, 5), (req, res) => {
    try {
      const id = req.params.id as string;
      const {
        enableWelcomeMsg,
        enableWelcomeFile,
        enableAutoMsgLink,
        enableAutoMsgPromo,
        linkText,
        promoText,
        discordLink,
      } = req.body as {
        enableWelcomeMsg?: unknown;
        enableWelcomeFile?: unknown;
        enableAutoMsgLink?: unknown;
        enableAutoMsgPromo?: unknown;
        linkText?: unknown;
        promoText?: unknown;
        discordLink?: unknown;
      };

      const data = {
        enableWelcomeMsg: !!enableWelcomeMsg,
        enableWelcomeFile: !!enableWelcomeFile,
        enableAutoMsgLink: !!enableAutoMsgLink,
        enableAutoMsgPromo: !!enableAutoMsgPromo,
        linkText: typeof linkText === 'string' ? linkText.trim() : '',
        promoText: typeof promoText === 'string' ? promoText.trim() : '',
        discordLink: typeof discordLink === 'string' ? discordLink.trim() : '',
      };

      if (!ctx._configRepo) {
        sendError(res, API_ERRORS.NO_DATABASE, 503, 'Config database not available');
        return;
      }
      const scope = `server:${id}`;
      if (id !== 'primary' && !ctx._configRepo.get(scope)) {
        sendError(res, API_ERRORS.SERVER_NOT_FOUND, 404);
        return;
      }
      ctx._configRepo.update(scope, { autoMessages: data });
      sendOk(res, { saved: true, requiresRestart: true });
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });
  // ── Panel: Bot actions (restart, reimport, factory reset, env sync) ──
  /** POST /api/panel/bot-actions/:action — Bot lifecycle control */
  app.post('/api/panel/bot-actions/:action', requireTier('admin'), rateLimit(30000, 3), (req, res) => {
    try {
      const action = req.params.action as string;
      const validActions = ['restart', 'reimport', 'factory_reset', 'env_sync'];
      if (!validActions.includes(action)) {
        sendError(res, API_ERRORS.INVALID_BOT_ACTION, 400);
        return;
      }
      if (!ctx._botControl) {
        sendError(res, API_ERRORS.BOT_CONTROL_NOT_AVAILABLE, 500);
        return;
      }

      const meta = { source: 'web', user: req.session.username || 'unknown' };
      let result;

      switch (action) {
        case 'restart':
          result = ctx._botControl.restart(meta);
          break;
        case 'reimport':
          result = ctx._botControl.reimport(meta);
          break;
        case 'factory_reset': {
          const { confirm } = req.body as { confirm?: string };
          if (confirm !== 'NUKE') {
            sendError(res, API_ERRORS.CONFIRM_NUKE_REQUIRED, 400);
            return;
          }
          result = ctx._botControl.factoryReset(meta);
          break;
        }
        case 'env_sync':
          result = ctx._botControl.envSync();
          break;
      }

      sendOk(res, result as unknown as Record<string, unknown>); // SAFETY: botControl methods return plain objects compatible with Record
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'BOT_ACTION_PENDING') {
        sendError(res, API_ERRORS.BOT_ACTION_PENDING, 409);
        return;
      }
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });
}
