/**
 * Tests for the v26→v27 schema migration + UserLinksRepository.
 *
 * v27 內容：
 *   - user_links：Steam↔Discord 1:1 綁定（discord PK、steam UNIQUE，不另建索引）
 *   - user_link_audit：綁定操作稽核（discord/steam 各一索引）
 *   - insertLink 純 INSERT —— 衝突讓 SQLite constraint 爆錯，呼叫端轉譯 409
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import _database from '../src/db/database.js';
const HumanitZDB = _database as any;

function objectNames(db: any, type: 'table' | 'index'): Set<string> {
  const rows = db.db
    .prepare("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%'")
    .all(type) as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

/** 把一顆全新（v27 schema）DB 改造成 v26 世界：兩張綁定表與索引不存在。 */
function seedV26State(db: any): void {
  db.db.exec(`
    DROP INDEX IF EXISTS idx_user_link_audit_discord;
    DROP INDEX IF EXISTS idx_user_link_audit_steam;
    DROP TABLE IF EXISTS user_link_audit;
    DROP TABLE IF EXISTS user_links;
  `);
  db._setMeta('schema_version', '26');
}

describe('Schema v27 — user_links migration', () => {
  it('creates user_links + user_link_audit (with indexes) on v26→v27', () => {
    const db = new HumanitZDB({ memory: true, label: 'V27Migrate' });
    db.init();
    try {
      seedV26State(db);
      assert.ok(!objectNames(db, 'table').has('user_links'));

      db._applySchema();

      assert.equal(db._getMeta('schema_version'), '27');
      const tables = objectNames(db, 'table');
      assert.ok(tables.has('user_links'), 'user_links must be created by v27');
      assert.ok(tables.has('user_link_audit'), 'user_link_audit must be created by v27');
      const indexes = objectNames(db, 'index');
      assert.ok(indexes.has('idx_user_link_audit_discord'));
      assert.ok(indexes.has('idx_user_link_audit_steam'));
      // steam_id 的唯一性靠 UNIQUE 自帶的 autoindex —— 不得另建具名索引（寫入放大）。
      for (const name of indexes) {
        assert.ok(!/user_links/.test(name), `no named index expected on user_links, found ${name}`);
      }
    } finally {
      db.close();
    }
  });

  it('is idempotent when re-run against an already-migrated DB (version forced back to 26)', () => {
    const db = new HumanitZDB({ memory: true, label: 'V27Rerun' });
    db.init();
    try {
      assert.equal(db._getMeta('schema_version'), '27');
      db.userLinks.insertLink({ discordUserId: 'd1', steamId: 's1', createdBy: 'd1' });
      db._setMeta('schema_version', '26');
      db._applySchema();
      assert.equal(db._getMeta('schema_version'), '27');
      // IF NOT EXISTS：既有資料不得被重跑清掉
      assert.equal(db.userLinks.getByDiscordId('d1')?.steam_id, 's1');
    } finally {
      db.close();
    }
  });
});

describe('UserLinksRepository', () => {
  it('enforces 1:1 — same discord re-bind hits PK, same steam re-bind hits UNIQUE', () => {
    const db = new HumanitZDB({ memory: true, label: 'V27Constraint' });
    db.init();
    try {
      db.userLinks.insertLink({ discordUserId: 'discord-1', steamId: '76561198000000001', createdBy: 'discord-1' });

      // 同 discord 再綁 → PRIMARY KEY 衝突
      assert.throws(
        () =>
          db.userLinks.insertLink({
            discordUserId: 'discord-1',
            steamId: '76561198000000002',
            createdBy: 'discord-1',
          }),
        /UNIQUE constraint failed: user_links\.discord_user_id/,
      );
      // 同 steam 被別人綁 → UNIQUE 衝突
      assert.throws(
        () =>
          db.userLinks.insertLink({
            discordUserId: 'discord-2',
            steamId: '76561198000000001',
            createdBy: 'discord-2',
          }),
        /UNIQUE constraint failed: user_links\.steam_id/,
      );

      const link = db.userLinks.getByDiscordId('discord-1');
      assert.equal(link?.steam_id, '76561198000000001');
      assert.equal(link?.verified_via, 'steam_openid');
      assert.equal(db.userLinks.getBySteamId('76561198000000001')?.discord_user_id, 'discord-1');

      // 解綁後同 steam 可重新綁定
      assert.equal(db.userLinks.deleteByDiscordId('discord-1'), true);
      assert.equal(db.userLinks.deleteByDiscordId('discord-1'), false);
      db.userLinks.insertLink({
        discordUserId: 'discord-2',
        steamId: '76561198000000001',
        verifiedVia: 'admin_manual',
        createdBy: 'admin-9',
      });
      assert.equal(db.userLinks.getBySteamId('76561198000000001')?.verified_via, 'admin_manual');
    } finally {
      db.close();
    }
  });

  it('appends audit records and pages them newest-first via getAuditFor', () => {
    const db = new HumanitZDB({ memory: true, label: 'V27Audit' });
    db.init();
    try {
      db.userLinks.insertAudit({ action: 'bind', discordUserId: 'd1', steamId: 's1', actorId: 'd1' });
      db.userLinks.insertAudit({
        action: 'admin_unbind',
        discordUserId: 'd1',
        steamId: 's1',
        actorId: 'admin-9',
        actorTier: 'admin',
        isTestSession: true,
        reason: 'cleanup',
        ip: '127.0.0.1',
      });
      db.userLinks.insertAudit({ action: 'bind', discordUserId: 'd2', steamId: 's2', actorId: 'd2' });

      const page1 = db.userLinks.getAuditFor('d1', 1, 0);
      assert.equal(page1.total, 2);
      assert.equal(page1.rows.length, 1);
      assert.equal(page1.rows[0].action, 'admin_unbind');
      assert.equal(page1.rows[0].actor_tier, 'admin');
      assert.equal(page1.rows[0].is_test_session, 1);
      assert.equal(page1.rows[0].reason, 'cleanup');
      assert.equal(page1.rows[0].ip, '127.0.0.1');

      const page2 = db.userLinks.getAuditFor('d1', 1, 1);
      assert.equal(page2.rows[0].action, 'bind');
      assert.equal(page2.rows[0].is_test_session, 0);
      assert.equal(db.userLinks.getAuditFor('d3').total, 0);
    } finally {
      db.close();
    }
  });

  it('bindWithAudit / unbindWithAudit are atomic — audit failure rolls back the link write', () => {
    const db = new HumanitZDB({ memory: true, label: 'V27Atomic' });
    db.init();
    try {
      // 毒藥 trigger：讓 audit insert 必定失敗
      const poison = () =>
        db.db.exec(
          "CREATE TRIGGER poison_audit BEFORE INSERT ON user_link_audit BEGIN SELECT RAISE(ABORT, 'audit poisoned'); END",
        );
      const unpoison = () => db.db.exec('DROP TRIGGER poison_audit');

      // bind：audit 失敗 → link 寫入 rollback
      poison();
      assert.throws(
        () =>
          db.userLinks.bindWithAudit(
            { discordUserId: 'd1', steamId: '76561198000000001', createdBy: 'd1' },
            { action: 'bind', discordUserId: 'd1', steamId: '76561198000000001', actorId: 'd1' },
          ),
        /audit poisoned/,
      );
      assert.equal(db.userLinks.getByDiscordId('d1'), undefined, 'link must be rolled back with the failed audit');
      unpoison();

      // 正常 bind：link + audit 都落地
      db.userLinks.bindWithAudit(
        { discordUserId: 'd1', steamId: '76561198000000001', createdBy: 'd1' },
        { action: 'bind', discordUserId: 'd1', steamId: '76561198000000001', actorId: 'd1' },
      );
      assert.equal(db.userLinks.getByDiscordId('d1')?.steam_id, '76561198000000001');
      assert.equal(db.userLinks.getAuditFor('d1').total, 1);

      // unbind：audit 失敗 → delete rollback，link 仍在
      poison();
      assert.throws(
        () => db.userLinks.unbindWithAudit('d1', { action: 'unbind', discordUserId: 'd1', actorId: 'd1' }),
        /audit poisoned/,
      );
      assert.equal(db.userLinks.getByDiscordId('d1')?.steam_id, '76561198000000001', 'delete must be rolled back');
      unpoison();

      // 正常 unbind：回傳被解綁的 steamId（由 repo 在同 tx 內讀取填入 audit）
      const removed = db.userLinks.unbindWithAudit('d1', { action: 'unbind', discordUserId: 'd1', actorId: 'd1' });
      assert.equal(removed, '76561198000000001');
      assert.equal(db.userLinks.getByDiscordId('d1'), undefined);
      const audit = db.userLinks.getAuditFor('d1');
      assert.equal(audit.total, 2);
      assert.equal(audit.rows[0].action, 'unbind');
      assert.equal(audit.rows[0].steam_id, '76561198000000001');

      // 無綁定可解 → null，且不得寫幽靈 audit
      const none = db.userLinks.unbindWithAudit('d1', { action: 'unbind', discordUserId: 'd1', actorId: 'd1' });
      assert.equal(none, null);
      assert.equal(db.userLinks.getAuditFor('d1').total, 2, 'no ghost audit for a no-op unbind');
    } finally {
      db.close();
    }
  });

  it('listLinks joins players.name, supports search and pagination', () => {
    const db = new HumanitZDB({ memory: true, label: 'V27List' });
    db.init();
    try {
      db.db.prepare('INSERT INTO players (steam_id, name) VALUES (?, ?)').run('76561198000000001', 'SurvivorAlice');
      db.userLinks.insertLink({ discordUserId: 'discord-1', steamId: '76561198000000001', createdBy: 'discord-1' });
      // players 沒有這顆 steam_id —— LEFT JOIN 下 player_name 應為 null
      db.userLinks.insertLink({ discordUserId: 'discord-2', steamId: '76561198000000002', createdBy: 'admin-9' });

      const all = db.userLinks.listLinks();
      assert.equal(all.total, 2);
      const byDiscord = new Map<string, any>(all.rows.map((row: any) => [row.discord_user_id, row]));
      assert.equal(byDiscord.get('discord-1').player_name, 'SurvivorAlice');
      assert.equal(byDiscord.get('discord-2').player_name, null);

      // query 搜尋：遊戲名 / steam id 皆可命中
      const byName = db.userLinks.listLinks({ query: 'alice' });
      assert.equal(byName.total, 1);
      assert.equal(byName.rows[0].discord_user_id, 'discord-1');
      const bySteam = db.userLinks.listLinks({ query: '76561198000000002' });
      assert.equal(bySteam.total, 1);
      assert.equal(bySteam.rows[0].discord_user_id, 'discord-2');
      // LIKE 萬用字元須被跳脫，不得整表命中
      assert.equal(db.userLinks.listLinks({ query: '%' }).total, 0);

      // 分頁：total 不受 limit 影響
      const paged = db.userLinks.listLinks({ limit: 1, offset: 0 });
      assert.equal(paged.rows.length, 1);
      assert.equal(paged.total, 2);
      assert.equal(db.userLinks.listLinks({ limit: 1, offset: 2 }).rows.length, 0);
    } finally {
      db.close();
    }
  });
});
