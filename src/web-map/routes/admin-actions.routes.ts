/**
 * Admin action routes: kick & ban a player by Steam ID, broadcast an
 * in-game RCON message (sanitized + logged to the chat feed), and
 * Steam↔Discord link management (list / manual bind / unbind + audit).
 *
 * Kick/ban/message handlers are a behavior-preserving extraction from
 * web-map/server.ts (P1-1 god-file split); link management was added later.
 */
import type { Express } from 'express';
import type { WebMapRouteContext } from '../types/route-context.js';
import type { UserLinksRepository } from '../../db/repositories/user-links-repository.js';
import { requireTier } from '../auth.js';
import type { HmzRequest } from '../auth.js';
import { rateLimit } from '../rate-limit.js';
import { API_ERRORS, sendError } from '../api-errors.js';
import { safeError, stripControlChars } from '../route-helpers.js';
import { isValidSteamId64 } from '../steam-openid.js';

/** user_links repository（DB 未接 / 未 init 時回 null，路由回 503）。 */
function _userLinks(ctx: WebMapRouteContext): UserLinksRepository | null {
  try {
    return ctx._db ? ctx._db.userLinks : null;
  } catch {
    return null;
  }
}

/** better-sqlite3 constraint 錯誤（user_links PK/UNIQUE 衝突 → 409）。 */
function _isConstraintError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT');
}

export function registerAdminActionsRoutes(app: Express, ctx: WebMapRouteContext): void {
  // ── API: Admin action — kick ──
  app.post('/api/admin/kick', requireTier('mod'), rateLimit(5000, 5), async (req, res) => {
    const { steamId } = req.body as { steamId?: string };
    if (!steamId || typeof steamId !== 'string') {
      sendError(res, API_ERRORS.MISSING_STEAM_ID, 400);
      return;
    }
    // Validate steam ID format
    if (!isValidSteamId64(steamId)) {
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
    if (!isValidSteamId64(steamId)) {
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

  // ══ Steam↔Discord 綁定管理（admin） ══
  // 面板管理 UI 為後續工作 —— 目前僅 API。

  // ── API: List links (paginated + optional search) ──
  app.get('/api/admin/links', requireTier('admin'), rateLimit(5000, 20), (req, res) => {
    const links = _userLinks(ctx);
    if (!links) {
      sendError(res, API_ERRORS.NO_DATABASE, 503);
      return;
    }
    const query = typeof req.query.query === 'string' ? req.query.query : '';
    const pageRaw = typeof req.query.page === 'string' ? req.query.page : '1';
    const page = Math.max(1, Number.parseInt(pageRaw, 10) || 1);
    const pageSize = 50;
    const { rows, total } = links.listLinks({ query, limit: pageSize, offset: (page - 1) * pageSize });
    res.json({ ok: true, rows, total, page, pageSize });
  });

  // ── API: Manual bind (admin) ──
  app.post('/api/admin/links', requireTier('admin'), rateLimit(5000, 10), (req, res) => {
    const links = _userLinks(ctx);
    if (!links) {
      sendError(res, API_ERRORS.NO_DATABASE, 503);
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const discordUserId = body.discordUserId;
    const steamId = body.steamId;
    // Discord snowflake：17–20 位數字
    if (typeof discordUserId !== 'string' || !/^\d{17,20}$/.test(discordUserId)) {
      res.status(400).json({ ok: false, error: 'INVALID_DISCORD_USER_ID' });
      return;
    }
    if (typeof steamId !== 'string' || !isValidSteamId64(steamId)) {
      sendError(res, API_ERRORS.INVALID_STEAM_ID_FORMAT, 400);
      return;
    }
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason) {
      res.status(400).json({ ok: false, error: 'REASON_REQUIRED' });
      return;
    }
    const actor = (req as HmzRequest).session.user;
    try {
      // 純 INSERT + audit 同 transaction —— 兩側任一已綁爆 constraint 轉譯
      // 409；audit 失敗整筆 rollback。
      links.bindWithAudit(
        { discordUserId, steamId, verifiedVia: 'admin_manual', createdBy: actor?.userId ?? '' },
        {
          action: 'admin_bind',
          discordUserId,
          steamId,
          actorId: actor?.userId,
          actorTier: actor?.tier,
          isTestSession: actor?.isTestSession,
          reason,
          ip: req.ip,
        },
      );
    } catch (err: unknown) {
      if (_isConstraintError(err)) {
        res.status(409).json({ ok: false, error: 'ALREADY_LINKED' });
        return;
      }
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      return;
    }
    res.json({ ok: true });
  });

  // ── API: Unbind (admin) ──
  app.delete('/api/admin/links/:discordUserId', requireTier('admin'), rateLimit(5000, 10), (req, res) => {
    const links = _userLinks(ctx);
    if (!links) {
      sendError(res, API_ERRORS.NO_DATABASE, 503);
      return;
    }
    const discordUserId = String(req.params.discordUserId ?? '');
    // 與 POST 對齊：Discord snowflake 17–20 位數字
    if (!/^\d{17,20}$/.test(discordUserId)) {
      res.status(400).json({ ok: false, error: 'INVALID_DISCORD_USER_ID' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason) {
      res.status(400).json({ ok: false, error: 'REASON_REQUIRED' });
      return;
    }
    const actor = (req as HmzRequest).session.user;
    // delete + audit 同 transaction；delete 0 列（含 get→delete 間被他人搶先
    // 解綁的 TOCTOU）不寫 audit → 404，杜絕幽靈 audit
    const removedSteamId = links.unbindWithAudit(discordUserId, {
      action: 'admin_unbind',
      discordUserId,
      actorId: actor?.userId,
      actorTier: actor?.tier,
      isTestSession: actor?.isTestSession,
      reason,
      ip: req.ip,
    });
    if (removedSteamId === null) {
      res.status(404).json({ ok: false, error: 'LINK_NOT_FOUND' });
      return;
    }
    res.json({ ok: true });
  });
}
