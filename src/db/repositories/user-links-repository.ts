import type Database from 'better-sqlite3';
import { BaseRepository } from './base-repository.js';
import { type DbRow } from './db-utils.js';

/** LIKE 萬用字元跳脫（與 activity-log-repository 同語意）。 */
function _escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&');
}

/** 與 DB CHECK 值域同步（schema.ts / database.ts v27 migration）。 */
export type VerifiedVia = 'steam_openid' | 'admin_manual';

export interface UserLinkAuditEntry {
  action: 'bind' | 'unbind' | 'admin_bind' | 'admin_unbind';
  discordUserId?: string;
  steamId?: string;
  actorId?: string;
  actorTier?: string;
  isTestSession?: boolean;
  reason?: string;
  ip?: string;
}

/**
 * UserLinksRepository — Steam↔Discord 帳號 1:1 綁定 + 操作稽核。
 *
 * 衝突語意（評審定案）：insertLink 是純 INSERT —— 同 discord 再綁爆
 * PRIMARY KEY、同 steam 被綁爆 UNIQUE，一律讓 SQLite constraint 錯誤
 * 往上拋，由呼叫端轉譯為 409。禁止 INSERT OR REPLACE / upsert。
 */
export class UserLinksRepository extends BaseRepository {
  declare private _stmts: {
    getByDiscordId: Database.Statement;
    getBySteamId: Database.Statement;
    insertLink: Database.Statement;
    deleteByDiscordId: Database.Statement;
    insertAudit: Database.Statement;
    listLinks: Database.Statement;
    countLinks: Database.Statement;
    listLinksSearch: Database.Statement;
    countLinksSearch: Database.Statement;
    getAuditFor: Database.Statement;
    countAuditFor: Database.Statement;
    updateSteamProfile: Database.Statement;
    touchSteamProfile: Database.Statement;
  };

  protected _prepareStatements(): void {
    // listLinks 的 LEFT JOIN players 只為顯示遊戲名 —— 綁定不要求 players 已有該 steam_id。
    const listSelect = `
      SELECT ul.discord_user_id, ul.steam_id, ul.verified_via, ul.created_by, ul.created_at,
             ul.steam_persona, ul.steam_avatar,
             p.name AS player_name
      FROM user_links ul
      LEFT JOIN players p ON p.steam_id = ul.steam_id
    `;
    const searchWhere = `
      WHERE (ul.discord_user_id LIKE ? ESCAPE '\\'
             OR ul.steam_id LIKE ? ESCAPE '\\'
             OR p.name LIKE ? ESCAPE '\\')
    `;
    this._stmts = {
      getByDiscordId: this._handle.prepare('SELECT * FROM user_links WHERE discord_user_id = ?'),
      getBySteamId: this._handle.prepare('SELECT * FROM user_links WHERE steam_id = ?'),
      insertLink: this._handle.prepare(
        'INSERT INTO user_links (discord_user_id, steam_id, verified_via, created_by) VALUES (?, ?, ?, ?)',
      ),
      deleteByDiscordId: this._handle.prepare('DELETE FROM user_links WHERE discord_user_id = ?'),
      insertAudit: this._handle.prepare(`
        INSERT INTO user_link_audit (action, discord_user_id, steam_id, actor_id, actor_tier, is_test_session, reason, ip)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),
      listLinks: this._handle.prepare(`${listSelect} ORDER BY ul.created_at DESC, ul.discord_user_id LIMIT ? OFFSET ?`),
      countLinks: this._handle.prepare('SELECT COUNT(*) AS count FROM user_links'),
      listLinksSearch: this._handle.prepare(
        `${listSelect} ${searchWhere} ORDER BY ul.created_at DESC, ul.discord_user_id LIMIT ? OFFSET ?`,
      ),
      countLinksSearch: this._handle.prepare(`SELECT COUNT(*) AS count FROM (${listSelect} ${searchWhere})`),
      getAuditFor: this._handle.prepare(
        'SELECT * FROM user_link_audit WHERE discord_user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
      ),
      countAuditFor: this._handle.prepare('SELECT COUNT(*) AS count FROM user_link_audit WHERE discord_user_id = ?'),
      // WHERE 綁 steam_id：fetch 是 fire-and-forget，回應落地時使用者可能已
      // unlink→relink 成別的 Steam 帳號（DELETE+INSERT，PK 相同）——stale 回應
      // 必須變 no-op，否則會把舊帳號的 persona/avatar 寫進新綁定並抑制其
      // 首次 sync 24h。COALESCE：partial profile（如 avatar host 不在 allowlist）
      // 不得用 null 清掉既有快取。
      updateSteamProfile: this._handle.prepare(`
        UPDATE user_links SET
          steam_persona = COALESCE(?, steam_persona),
          steam_avatar = COALESCE(?, steam_avatar),
          steam_profile_updated_at = datetime('now')
        WHERE discord_user_id = ? AND steam_id = ?
      `),
      touchSteamProfile: this._handle.prepare(
        "UPDATE user_links SET steam_profile_updated_at = datetime('now') WHERE discord_user_id = ? AND steam_id = ?",
      ),
    };
  }

  /** Get the link for a Discord user, or undefined. */
  getByDiscordId(discordUserId: string): DbRow | undefined {
    return this._stmts.getByDiscordId.get(discordUserId) as DbRow | undefined;
  }

  /** Get the link holding a Steam ID, or undefined. */
  getBySteamId(steamId: string): DbRow | undefined {
    return this._stmts.getBySteamId.get(steamId) as DbRow | undefined;
  }

  /**
   * Create a link. Pure INSERT — throws SqliteError (SQLITE_CONSTRAINT_*) when the
   * Discord user already has a link (PK) or the Steam ID is already bound (UNIQUE).
   * Callers translate that to HTTP 409.
   */
  insertLink(link: { discordUserId: string; steamId: string; verifiedVia?: VerifiedVia; createdBy: string }) {
    return this._stmts.insertLink.run(
      link.discordUserId,
      link.steamId,
      link.verifiedVia || 'steam_openid',
      link.createdBy,
    );
  }

  /** Delete the link for a Discord user. Returns true when a row was removed. */
  deleteByDiscordId(discordUserId: string): boolean {
    return this._stmts.deleteByDiscordId.run(discordUserId).changes > 0;
  }

  /**
   * link + audit 原子寫入 —— audit 失敗整筆 rollback，杜絕「狀態已變但無
   * 稽核」的半套狀態。constraint 錯誤照樣往上拋（呼叫端轉譯 409）。
   */
  bindWithAudit(
    link: { discordUserId: string; steamId: string; verifiedVia?: VerifiedVia; createdBy: string },
    audit: UserLinkAuditEntry,
  ): void {
    this._handle.transaction(() => {
      this.insertLink(link);
      this.insertAudit(audit);
    })();
  }

  /**
   * 「清掉同 discord 既有綁定 + 重綁 + audit」原子執行 —— 目前僅 /auth/test-login
   * 的 e2e 重跑路徑使用。insertLink 若因 steamId 被他人綁走而爆 UNIQUE，整筆
   * rollback（既有綁定不會被半途刪掉）。一般綁定禁止 replace 語意，勿在
   * 非 test 路徑使用。
   */
  replaceLinkWithAudit(
    link: { discordUserId: string; steamId: string; verifiedVia?: VerifiedVia; createdBy: string },
    audit: UserLinkAuditEntry,
  ): void {
    this._handle.transaction(() => {
      this._stmts.deleteByDiscordId.run(link.discordUserId);
      this.insertLink(link);
      this.insertAudit(audit);
    })();
  }

  /**
   * delete + audit 原子執行。以 delete 的 changes 判斷：0 列（無綁定）時
   * 不寫 audit 並回 null（呼叫端 404 / unlinked:false），否則回被解綁的
   * steamId。row 內的 steam_id 於同一 transaction 讀取，杜絕 get→delete
   * 之間的 TOCTOU 幽靈 audit。audit.steamId 由本方法填入。
   */
  unbindWithAudit(discordUserId: string, audit: UserLinkAuditEntry): string | null {
    return this._handle.transaction((): string | null => {
      const row = this._stmts.getByDiscordId.get(discordUserId) as DbRow | undefined;
      if (!row) return null;
      // 防禦性檢查（非防競態）：better-sqlite3 同步 + 單進程，SELECT 與 DELETE 間
      // 不可能有並發寫入，此分支實務上不可達；留著是零成本的 defense-in-depth。
      if (this._stmts.deleteByDiscordId.run(discordUserId).changes === 0) return null;
      this.insertAudit({ ...audit, steamId: row.steam_id as string });
      return row.steam_id as string;
    })();
  }

  /**
   * 寫入 Steam 個人資料快取（抓取成功時）。steamId 須為該次 fetch 所針對的
   * Steam ID —— 無綁定列或使用者已改綁其他帳號（stale fetch）時 no-op。
   * null 欄位保留既有快取（COALESCE），不視為清除。
   */
  updateSteamProfile(discordUserId: string, steamId: string, persona: string | null, avatar: string | null): boolean {
    return this._stmts.updateSteamProfile.run(persona, avatar, discordUserId, steamId).changes > 0;
  }

  /** 只更新最近抓取時間（抓取失敗時）—— 保留舊 persona/avatar，並避免 retry 風暴。stale fetch 同樣 no-op。 */
  touchSteamProfile(discordUserId: string, steamId: string): boolean {
    return this._stmts.touchSteamProfile.run(discordUserId, steamId).changes > 0;
  }

  /** Append a bind/unbind audit record. */
  insertAudit(entry: UserLinkAuditEntry) {
    return this._stmts.insertAudit.run(
      entry.action,
      entry.discordUserId || '',
      entry.steamId || '',
      entry.actorId || '',
      entry.actorTier || '',
      entry.isTestSession ? 1 : 0,
      entry.reason || '',
      entry.ip || '',
    );
  }

  /**
   * List links with pagination and optional text search
   * (Discord ID / Steam ID / in-game player name).
   */
  listLinks(options: { limit?: number; offset?: number; query?: string } = {}): { rows: DbRow[]; total: number } {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const query = (options.query ?? '').trim();
    if (!query) {
      return {
        rows: this._stmts.listLinks.all(limit, offset) as DbRow[],
        total: ((this._stmts.countLinks.get() as DbRow).count as number) || 0,
      };
    }
    const like = `%${_escapeLike(query)}%`;
    return {
      rows: this._stmts.listLinksSearch.all(like, like, like, limit, offset) as DbRow[],
      total: ((this._stmts.countLinksSearch.get(like, like, like) as DbRow).count as number) || 0,
    };
  }

  /** Paginated audit trail for a Discord user (newest first). */
  getAuditFor(discordUserId: string, limit = 50, offset = 0): { rows: DbRow[]; total: number } {
    return {
      rows: this._stmts.getAuditFor.all(discordUserId, limit, offset) as DbRow[],
      total: ((this._stmts.countAuditFor.get(discordUserId) as DbRow).count as number) || 0,
    };
  }
}
