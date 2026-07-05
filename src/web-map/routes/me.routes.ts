/**
 * Self-service "me" routes — data about the signed-in user's own linked
 * player (requires a Steam↔Discord link in user_links).
 *
 * 綁定狀態每請求現查 user_links（評審定案：不進 session，解綁立即生效）。
 */
import type { Express } from 'express';
import type { WebMapRouteContext } from '../types/route-context.js';
import { requireTier } from '../auth.js';
import type { HmzRequest } from '../auth.js';
import { rateLimit } from '../rate-limit.js';
import { API_ERRORS, sendError } from '../api-errors.js';

export function registerMeRoutes(app: Express, ctx: WebMapRouteContext): void {
  // ── API: 自己的玩家概要（需 survivor 以上 + 已綁定 Steam） ──
  app.get('/api/me/player', requireTier('survivor'), rateLimit(10000, 20), (req, res) => {
    const user = (req as HmzRequest).session.user;
    if (!user) {
      // requireTier 已擋 public —— 這裡只是型別/防禦保險
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    // 錯誤三分類（DB 故障不可偽裝成 STEAM_NOT_LINKED）：
    //   repo 不可用（_db null / getter throw）→ 503；查詢例外 → 500；
    //   查詢成功但無 row → 409 STEAM_NOT_LINKED
    let repo;
    try {
      repo = ctx._db?.userLinks ?? null;
    } catch {
      repo = null;
    }
    if (!repo) {
      sendError(res, API_ERRORS.NO_DATABASE, 503);
      return;
    }
    let link;
    try {
      link = repo.getByDiscordId(user.userId);
    } catch (err: unknown) {
      console.error(
        '[WEB MAP] /api/me/player user_links query failed:',
        err instanceof Error ? err.message : String(err),
      );
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500);
      return;
    }
    if (!link) {
      res.status(409).json({ error: 'STEAM_NOT_LINKED' });
      return;
    }
    const steamId = link.steam_id as string;

    const srv = req.srv;
    const row = srv.db?.player.getPlayer(steamId) ?? null;
    let pt: { totalMs: number; lastSeen?: string | null } | null = null;
    try {
      pt = srv.playtime.getPlaytime(steamId);
    } catch {
      /* playtime unavailable */
    }

    // 安全欄位白名單（面板 players 分頁已對 survivor 公開的欄位子集）。
    // 刻意不含管理欄位（notes / 風險評分類）、inventory / snapshot、座標。
    const player = row
      ? {
          name: (row.name as string) || '',
          online: !!row.online,
          profession: (row.starting_perk as string) || 'Unknown',
          level: (row.level as number) || 0,
          expCurrent: (row.exp_current as number) || 0,
          expRequired: (row.exp_required as number) || 0,
          skillsPoint: (row.skills_point as number) || 0,
          daysSurvived: (row.days_survived as number) || 0,
          lifetimeDaysSurvived: (row.lifetime_days_survived as number) || 0,
          zeeksKilled: (row.zeeks_killed as number) || 0,
          headshots: (row.headshots as number) || 0,
          lifetimeKills: (row.lifetime_kills as number) || 0,
          timesBitten: (row.times_bitten as number) || 0,
          fishCaught: (row.fish_caught as number) || 0,
          health: (row.health as number | null) ?? 0,
          maxHealth: (row.max_health as number | null) ?? 0,
          firstSeen: (row.first_seen as string | null) ?? null,
          lastSeen: (row.last_seen as string | null) ?? null,
          totalPlaytime: pt ? Math.floor(pt.totalMs / 60000) : 0,
        }
      : null; // 已綁定但此伺服器沒有該玩家紀錄

    res.json({ server: srv.serverId, steamId, player });
  });
}
