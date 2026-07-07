/**
 * Self-service "me" routes — data about the signed-in user's own linked
 * player (requires a Steam↔Discord link in user_links).
 *
 * 綁定狀態每請求現查 user_links（評審定案：不進 session，解綁立即生效）。
 */
import type { Express, Response } from 'express';
import type { WebMapRouteContext } from '../types/route-context.js';
import { requireTier } from '../auth.js';
import type { HmzRequest } from '../auth.js';
import { rateLimit } from '../rate-limit.js';
import { API_ERRORS, sendError } from '../api-errors.js';
import { vehicleBelongsTo } from '../route-helpers.js';
import { normalizePlayerHorses } from '../../parsers/save-parser.js';
import { cleanName as cleanActorName, cleanItemName } from '../../parsers/ue4-names.js';
import type { VehicleRow, CompanionRow } from '../types/db-rows.js';

/**
 * 解析呼叫者的 Steam 綁定；未綁定 / 故障時直接回應錯誤並回 null。
 * 錯誤三分類（DB 故障不可偽裝成 STEAM_NOT_LINKED）：
 *   repo 不可用（_db null / getter throw）→ 503；查詢例外 → 500；
 *   查詢成功但無 row → 409 STEAM_NOT_LINKED
 */
function _resolveLinkedSteamIdOrRespond(req: unknown, res: Response, ctx: WebMapRouteContext): string | null {
  const user = (req as HmzRequest).session.user;
  if (!user) {
    // requireTier 已擋 public —— 這裡只是型別/防禦保險
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  let repo;
  try {
    repo = ctx._db?.userLinks ?? null;
  } catch (err: unknown) {
    // getter 在 DB 未 init 時 throw —— 記下來，否則 503 的來源無從辨識
    console.warn('[WEB MAP] /api/me userLinks repo unavailable:', err instanceof Error ? err.message : String(err));
    repo = null;
  }
  if (!repo) {
    sendError(res, API_ERRORS.NO_DATABASE, 503);
    return null;
  }
  let link;
  try {
    link = repo.getByDiscordId(user.userId);
  } catch (err: unknown) {
    console.error('[WEB MAP] /api/me user_links query failed:', err instanceof Error ? err.message : String(err));
    sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500);
    return null;
  }
  if (!link) {
    res.status(409).json({ error: 'STEAM_NOT_LINKED' });
    return null;
  }
  return link.steam_id as string;
}

export function registerMeRoutes(app: Express, ctx: WebMapRouteContext): void {
  // ── API: 自己的玩家概要（需 survivor 以上 + 已綁定 Steam） ──
  app.get('/api/me/player', requireTier('survivor'), rateLimit(10000, 20), (req, res) => {
    const steamId = _resolveLinkedSteamIdOrRespond(req, res, ctx);
    if (!steamId) return;

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

  // ── API: 自己的載具 / 馬 / 夥伴座標（玩家地圖視圖；owner == 自己） ──
  // 世界物件全集是 griefing 敏感情報（/api/panel/mapdata 鎖 mod），這裡只回
  // server 端以 owner == 呼叫者 steamId 過濾後的子集 —— 不開放 query 挑人。
  app.get('/api/me/mapdata', requireTier('survivor'), rateLimit(10000, 20), (req, res) => {
    const steamId = _resolveLinkedSteamIdOrRespond(req, res, ctx);
    if (!steamId) return;

    const srv = req.srv;
    // partial: 任一資料源部分失敗（回空陣列）時設 true，讓前端能區分
    // 「我沒有載具」vs「載具查詢炸了」，而非把 partial failure 當空集合。
    const result: {
      server: string;
      steamId: string;
      partial: boolean;
      vehicles: Array<Record<string, unknown>>;
      horses: Array<Record<string, unknown>>;
      companions: Array<Record<string, unknown>>;
    } = { server: srv.serverId, steamId, partial: false, vehicles: [], horses: [], companions: [] };

    // 我的載具：owner 存在 vehicles.extra 的車鑰匙綁定字串裡。SQL LIKE 粗篩
    // 後仍以 vehicleBelongsTo 精確驗證（防更長 id 同尾碼誤匹配 + 多把鑰匙）。
    if (srv.db) {
      try {
        const rows = srv.db.worldObject.getPositionedVehiclesByOwnerKey(steamId) as Array<
          VehicleRow & { extra?: string }
        >;
        for (const r of rows) {
          if (!vehicleBelongsTo(r.extra, steamId)) continue;
          const [lat, lng] = ctx._worldToLeaflet(r.pos_x, r.pos_y);
          result.vehicles.push({
            id: r.id,
            name: r.display_name || cleanActorName(r.class),
            lat,
            lng,
            health: r.health,
            maxHealth: r.max_health,
            fuel: Math.round(r.fuel * 10) / 10,
          });
        }
      } catch (err: unknown) {
        result.partial = true;
        console.warn('[WEB MAP] /api/me/mapdata vehicles failed:', err instanceof Error ? err.message : String(err));
      }

      // 我的夥伴（狗等）：companions.owner_steam_id == 自己
      try {
        const rows = srv.db.worldObject.getPositionedCompanions() as CompanionRow[];
        for (const r of rows) {
          if (r.owner_steam_id !== steamId) continue;
          const [lat, lng] = ctx._worldToLeaflet(r.pos_x, r.pos_y);
          result.companions.push({ id: r.id, type: r.type, lat, lng, health: r.health });
        }
      } catch (err: unknown) {
        result.partial = true;
        console.warn('[WEB MAP] /api/me/mapdata companions failed:', err instanceof Error ? err.message : String(err));
      }
    }

    // 我的馬：馴養馬的權威來源是自己玩家列的 horses JSON（world_horses 是野馬）。
    // 與 /api/players 同資料源（save cache，時效與 DB 世界物件略不同步：DB 是 sync
    // 後、save cache 是最近一次 parse）—— 兩者都是自己的東西，可接受。
    try {
      const players = srv.isPrimary ? ctx._parseSaveData() : ctx._parseSaveDataForServer(srv.dataDir);
      const own = players.get(steamId) as Record<string, unknown> | undefined;
      const horses = normalizePlayerHorses(own?.horses);
      for (const h of horses) {
        if (h.ownerSteamId && h.ownerSteamId !== steamId) continue;
        if (h.x == null || h.y == null || (h.x === 0 && h.y === 0 && (h.z ?? 0) === 0)) continue;
        const [lat, lng] = ctx._worldToLeaflet(h.x, h.y);
        result.horses.push({
          name: h.name || cleanItemName(h.displayName || h.class) || 'Horse',
          lat,
          lng,
          health: h.health,
          maxHealth: h.maxHealth,
        });
      }
    } catch (err: unknown) {
      result.partial = true;
      console.warn('[WEB MAP] /api/me/mapdata horses failed:', err instanceof Error ? err.message : String(err));
    }

    res.json(result);
  });
}
