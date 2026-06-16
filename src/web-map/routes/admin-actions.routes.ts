/**
 * Admin action routes: kick & ban a player by Steam ID, and broadcast an
 * in-game RCON message (sanitized + logged to the chat feed).
 *
 * Behavior-preserving extraction from web-map/server.ts (P1-1 god-file split).
 * Handlers are verbatim; only `this.` -> `ctx.` was applied.
 */
import type { Express } from 'express';
import type { WebMapRouteContext } from '../types/route-context.js';
import { requireTier } from '../auth.js';
import { rateLimit } from '../rate-limit.js';
import { API_ERRORS, sendError } from '../api-errors.js';
import { safeError, stripControlChars } from '../route-helpers.js';

export function registerAdminActionsRoutes(app: Express, _ctx: WebMapRouteContext): void {
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
}
