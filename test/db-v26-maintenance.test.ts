/**
 * Tests for the v25→v26 schema migration + startup schema completeness repair.
 *
 * v26 內容：
 *   - 順序防護：先確保 idx_activity_recent_dedupe、再 DROP idx_activity_source
 *   - DROP 14 個查證無用索引
 *   - DROP 10 張從未使用的 hmz_* 表
 *   - players DROP COLUMN name_history / kill_tracker
 *   - timeline_snapshots 加 backpacks/houses hash-ref dedup 四欄（Stage C）
 *   - timeline_snapshots 加 players_keyframe 欄 + 既有 snapshot 回填 1（delta 重建基準）
 *   - idx_tl_players_steam 汰換為複合 idx_tl_players_steam_snap（trails 查詢）
 *   - migration 失敗時 ROLLBACK + 關閉 handle（init() 可重試）
 *   - 每次啟動冪等套用 schema.ts 全部 DDL + ADDITIVE_COLUMNS 欄位級修復（drift 修復）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import _database from '../src/db/database.js';
import { SCHEMA_VERSION } from '../src/db/schema.js';
const HumanitZDB = _database as any;

const DROPPED_INDEXES = [
  'idx_activity_source',
  'idx_activity_item',
  'idx_item_inst_active',
  'idx_item_grp_active',
  'idx_item_inst_group',
  'idx_item_mov_item',
  'idx_tl_ai_type',
  'idx_tl_ai_cat',
  'idx_tl_houses_uid',
  'idx_chat_type',
  'idx_chat_steam',
  'idx_chat_player',
  'idx_world_drops_item',
  'idx_world_drops_pos',
  // v26 Stage C：單欄索引由複合 idx_tl_players_steam_snap 取代
  'idx_tl_players_steam',
];

const V26_SNAPSHOT_COLUMNS = [
  'backpacks_state_hash',
  'backpacks_ref_snapshot_id',
  'houses_state_hash',
  'houses_ref_snapshot_id',
  'players_keyframe',
];

const DROPPED_HMZ_TABLES = [
  'hmz_players',
  'hmz_factions',
  'hmz_bounties',
  'hmz_quests',
  'hmz_quest_progress',
  'hmz_territories',
  'hmz_transactions',
  'hmz_wipes',
  'hmz_events',
  'hmz_event_scores',
];

function objectNames(db: any, type: 'table' | 'index'): Set<string> {
  const rows = db.db
    .prepare("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%'")
    .all(type) as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function playerColumns(db: any): Set<string> {
  const rows = db.db.prepare('PRAGMA table_info(players)').all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function snapshotColumns(db: any): Set<string> {
  const rows = db.db.prepare('PRAGMA table_info(timeline_snapshots)').all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

/**
 * 把一顆全新（v26 schema）DB 改造成 v25 世界的樣子：
 * 兩個 DEPRECATED 欄位、14 個舊索引、10 張 hmz_* 表都在，
 * 且模擬漂移的生產 DB —— idx_activity_recent_dedupe 缺失。
 */
function seedV25State(db: any): void {
  db.db.exec(`
    ALTER TABLE players ADD COLUMN name_history TEXT DEFAULT '[]';
    ALTER TABLE players ADD COLUMN kill_tracker TEXT DEFAULT '{}';

    CREATE INDEX IF NOT EXISTS idx_activity_source ON activity_log(source);
    CREATE INDEX IF NOT EXISTS idx_activity_item ON activity_log(item);
    CREATE INDEX IF NOT EXISTS idx_item_inst_active ON item_instances(lost);
    CREATE INDEX IF NOT EXISTS idx_item_grp_active ON item_groups(lost);
    CREATE INDEX IF NOT EXISTS idx_item_inst_group ON item_instances(group_id);
    CREATE INDEX IF NOT EXISTS idx_item_mov_item ON item_movements(item);
    CREATE INDEX IF NOT EXISTS idx_tl_ai_type ON timeline_ai(ai_type);
    CREATE INDEX IF NOT EXISTS idx_tl_ai_cat ON timeline_ai(category);
    CREATE INDEX IF NOT EXISTS idx_tl_houses_uid ON timeline_houses(uid);
    CREATE INDEX IF NOT EXISTS idx_chat_type ON chat_log(type);
    CREATE INDEX IF NOT EXISTS idx_chat_steam ON chat_log(steam_id);
    CREATE INDEX IF NOT EXISTS idx_chat_player ON chat_log(player_name);
    CREATE INDEX IF NOT EXISTS idx_world_drops_item ON world_drops(item);
    CREATE INDEX IF NOT EXISTS idx_world_drops_pos ON world_drops(pos_x, pos_y);

    CREATE TABLE IF NOT EXISTS hmz_factions (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS hmz_players (steam_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS hmz_territories (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS hmz_quests (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS hmz_quest_progress (id INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS hmz_bounties (id INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS hmz_transactions (id INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS hmz_events (id INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS hmz_event_scores (id INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS hmz_wipes (id TEXT PRIMARY KEY);

    DROP INDEX IF EXISTS idx_activity_recent_dedupe;

    ALTER TABLE timeline_snapshots DROP COLUMN backpacks_state_hash;
    ALTER TABLE timeline_snapshots DROP COLUMN backpacks_ref_snapshot_id;
    ALTER TABLE timeline_snapshots DROP COLUMN houses_state_hash;
    ALTER TABLE timeline_snapshots DROP COLUMN houses_ref_snapshot_id;
    ALTER TABLE timeline_snapshots DROP COLUMN players_keyframe;

    DROP INDEX IF EXISTS idx_tl_players_steam_snap;
    CREATE INDEX IF NOT EXISTS idx_tl_players_steam ON timeline_players(steam_id);
  `);
  db._setMeta('schema_version', '25');
}

describe('Schema v26 — maintenance migration', () => {
  it('drops unused indexes, hmz_* tables, and deprecated player columns on v25→v26', () => {
    const db = new HumanitZDB({ memory: true, label: 'V26Migrate' });
    db.init();
    try {
      seedV25State(db);
      // 前置確認：v25 世界已就緒
      assert.ok(objectNames(db, 'index').has('idx_activity_source'));
      assert.ok(objectNames(db, 'table').has('hmz_factions'));
      assert.ok(playerColumns(db).has('name_history'));
      assert.ok(!objectNames(db, 'index').has('idx_activity_recent_dedupe'));

      db._applySchema();

      assert.equal(db._getMeta('schema_version'), String(SCHEMA_VERSION));
      const indexes = objectNames(db, 'index');
      for (const name of DROPPED_INDEXES) {
        assert.ok(!indexes.has(name), `${name} should be dropped by v26`);
      }
      assert.ok(indexes.has('idx_activity_recent_dedupe'), 'dedupe index must be (re)created');
      const tables = objectNames(db, 'table');
      for (const name of DROPPED_HMZ_TABLES) {
        assert.ok(!tables.has(name), `${name} should be dropped by v26`);
      }
      const cols = playerColumns(db);
      assert.ok(!cols.has('name_history'), 'players.name_history should be dropped');
      assert.ok(!cols.has('kill_tracker'), 'players.kill_tracker should be dropped');
      assert.ok(cols.has('name'), 'players core columns must survive');
      // Stage C：backpacks/houses dedup 欄位 + players 複合索引
      const snapCols = snapshotColumns(db);
      for (const col of V26_SNAPSHOT_COLUMNS) {
        assert.ok(snapCols.has(col), `timeline_snapshots.${col} must be added by v26`);
      }
      assert.ok(indexes.has('idx_tl_players_steam_snap'), 'composite players index must be created');
    } finally {
      db.close();
    }
  });

  it('backfills players_keyframe=1 on every pre-existing snapshot (legacy full writes are keyframes)', () => {
    const db = new HumanitZDB({ memory: true, label: 'V26KfBackfill' });
    db.init();
    try {
      seedV25State(db);
      // v25 世界的既有 snapshot（舊制全量寫入）
      db.db.prepare('INSERT INTO timeline_snapshots (game_day) VALUES (1), (2), (3)').run();

      db._applySchema();

      const rows = db.db.prepare('SELECT players_keyframe AS k FROM timeline_snapshots').all() as Array<{
        k: number;
      }>;
      assert.equal(rows.length, 3);
      assert.ok(
        rows.every((r) => r.k === 1),
        'all pre-v26 snapshots must be marked as players keyframes',
      );

      // 重跑防護：migration 再跑一次（duplicate column 路徑）不得把 delta snapshot 誤標回 1
      db.timeline.insertTimelineSnapshot({ snapshot: { gameDay: 4, playersKeyframe: false } });
      db._setMeta('schema_version', '25');
      db._applySchema();
      const delta = db.db.prepare('SELECT players_keyframe AS k FROM timeline_snapshots WHERE game_day = 4').get() as {
        k: number;
      };
      assert.equal(delta.k, 0, 'a re-run must not re-backfill delta snapshots to keyframe');
    } finally {
      db.close();
    }
  });

  it('hasRecentActivity uses idx_activity_recent_dedupe after the migration drops idx_activity_source', () => {
    const db = new HumanitZDB({ memory: true, label: 'V26Plan' });
    db.init();
    try {
      seedV25State(db);
      db._applySchema();

      // 與 ActivityLogRepository.hasRecentActivity 相同形狀的查詢
      const plan = db.db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT 1 FROM activity_log
           WHERE type = ? AND steam_id = ? AND source = ?
             AND ((created_at >= ? AND created_at <= ?) OR (created_at >= ? AND created_at <= ?))
           ORDER BY created_at DESC, id DESC
           LIMIT 1`,
        )
        .all('a', 'b', 'c', 'd', 'e', 'f', 'g') as Array<{ detail: string }>;
      assert.ok(
        plan.some((row) => row.detail.includes('idx_activity_recent_dedupe')),
        `query plan should use idx_activity_recent_dedupe, got: ${plan.map((r) => r.detail).join(' | ')}`,
      );

      // 行為煙霧測試：dedupe 查詢在只剩 dedupe 索引時仍正確
      const steamId = '76561198000000042';
      db.activityLog.insertActivitiesAt([
        {
          type: 'player_connect',
          category: 'session',
          actor: steamId,
          actorName: 'Alice',
          steamId,
          source: 'log',
          createdAt: '2026-06-01 12:00:00',
        },
      ]);
      assert.equal(
        db.activityLog.hasRecentActivity('player_connect', steamId, 'log', 60_000, new Date('2026-06-01T12:00:30Z')),
        true,
      );
    } finally {
      db.close();
    }
  });

  it('player upsert paths still work after the DROP COLUMNs', () => {
    const db = new HumanitZDB({ memory: true, label: 'V26Upsert' });
    db.init();
    try {
      seedV25State(db);
      db._applySchema();

      const steamId = '76561198000000043';
      db.player.upsertFullPlaytime(steamId, {
        name: 'Alice',
        totalMs: 61_000,
        sessions: 1,
        firstSeen: '2026-06-01 10:00:00',
        lastLogin: '2026-06-01 10:00:00',
        lastSeen: '2026-06-01 10:01:01',
      });
      db.player.upsertFullLogStats(steamId, { name: 'Alice', deaths: 2 });
      const row = db.db
        .prepare('SELECT name, playtime_seconds, log_deaths FROM players WHERE steam_id = ?')
        .get(steamId) as { name: string; playtime_seconds: number; log_deaths: number };
      assert.equal(row.name, 'Alice');
      assert.equal(row.playtime_seconds, 61);
      assert.equal(row.log_deaths, 2);
    } finally {
      db.close();
    }
  });

  it('is idempotent when re-run against an already-cleaned DB (version forced back to 25)', () => {
    const db = new HumanitZDB({ memory: true, label: 'V26Rerun' });
    db.init();
    try {
      seedV25State(db);
      db._applySchema();
      assert.equal(db._getMeta('schema_version'), String(SCHEMA_VERSION));

      // 重跑：欄位/索引/表都已移除，migration 不得丟例外
      db._setMeta('schema_version', '25');
      db._applySchema();
      assert.equal(db._getMeta('schema_version'), String(SCHEMA_VERSION));
      assert.ok(!playerColumns(db).has('name_history'));
    } finally {
      db.close();
    }
  });

  it('rolls back the whole migration and closes the handle when a step fails, then succeeds on retry', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'humanitz-v26-rollback-'));
    const dbPath = path.join(tempDir, 'humanitz.db');
    let db: any = null;
    try {
      db = new HumanitZDB({ dbPath, label: 'V26Rollback' });
      db.init();
      seedV25State(db);
      // 毒藥：kill_tracker 上掛一個索引，讓 DROP COLUMN kill_tracker 失敗
      // （此時 dedupe 索引已建、14 索引已 DROP、name_history 已 DROP —— 全部都要被回滾）
      db.db.exec('CREATE INDEX idx_poison_kt ON players(kill_tracker)');
      db.close();

      db = new HumanitZDB({ dbPath, label: 'V26Rollback' });
      assert.throws(() => db.init(), /no such column|kill_tracker/i);
      assert.equal(db.db, null, 'handle must be closed after a failed migration');

      // 檢查回滾結果：版本仍 25，migration 中途的變更全數復原。
      // 直接開 raw handle 檢查，避免 init() 又觸發 migration。
      const raw = new Database(dbPath, { readonly: true });
      try {
        const version = raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
          value: string;
        };
        assert.equal(version.value, '25', 'schema_version must not advance on failure');
        const indexes = new Set(
          (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map(
            (row) => row.name,
          ),
        );
        assert.ok(indexes.has('idx_activity_source'), 'dropped index must be restored by ROLLBACK');
        assert.ok(!indexes.has('idx_activity_recent_dedupe'), 'mid-migration index creation must be rolled back');
        const cols = new Set(
          (raw.prepare('PRAGMA table_info(players)').all() as Array<{ name: string }>).map((row) => row.name),
        );
        assert.ok(cols.has('name_history'), 'mid-migration DROP COLUMN must be rolled back');
        assert.ok(cols.has('kill_tracker'));
      } finally {
        raw.close();
      }

      // 排除毒藥後重試：init() 必須走乾淨路徑完成 migration
      const fixer = new Database(dbPath);
      fixer.exec('DROP INDEX idx_poison_kt');
      fixer.close();

      db = new HumanitZDB({ dbPath, label: 'V26RollbackRetry' });
      db.init();
      assert.equal(db._getMeta('schema_version'), String(SCHEMA_VERSION));
      assert.ok(!playerColumns(db).has('kill_tracker'));
    } finally {
      if (db) db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('Schema completeness repair (startup drift healing)', () => {
  it('recreates missing tables and indexes on the next _applySchema pass', () => {
    const db = new HumanitZDB({ memory: true, label: 'DriftRepair' });
    db.init();
    try {
      db.db.exec('DROP TABLE world_drops; DROP INDEX idx_players_name;');
      assert.ok(!objectNames(db, 'table').has('world_drops'));
      assert.ok(!objectNames(db, 'index').has('idx_players_name'));

      // 版本相同（v26 == v26）也要修復 —— 這是永久性 drift 防護
      db._applySchema();

      assert.ok(objectNames(db, 'table').has('world_drops'), 'missing table must be recreated');
      assert.ok(objectNames(db, 'index').has('idx_players_name'), 'missing index must be recreated');
    } finally {
      db.close();
    }
  });

  it('restores migration-added columns dropped from an existing table (column-level repair)', () => {
    const db = new HumanitZDB({ memory: true, label: 'DriftColumnRepair' });
    db.init();
    try {
      // codex probe 場景：手動 DROP 掉 migration 加的欄位 —— 舊的 completeness
      // repair 只比對 table/index 名稱，補不回欄位。
      db.db.exec(`
        ALTER TABLE timeline_snapshots DROP COLUMN structures_state_hash;
        ALTER TABLE players DROP COLUMN save_last_login;
        ALTER TABLE quests DROP COLUMN pos_z;
      `);
      assert.ok(!snapshotColumns(db).has('structures_state_hash'));

      db._applySchema();

      assert.ok(snapshotColumns(db).has('structures_state_hash'), 'dropped snapshot column must be restored');
      assert.ok(playerColumns(db).has('save_last_login'), 'dropped players column must be restored');
      const questCols = new Set(
        (db.db.prepare('PRAGMA table_info(quests)').all() as Array<{ name: string }>).map((row) => row.name),
      );
      assert.ok(questCols.has('pos_z'), 'dropped quests column must be restored');
    } finally {
      db.close();
    }
  });

  it('does not resurrect objects that were removed from schema.ts (v26-dropped indexes stay dropped)', () => {
    const db = new HumanitZDB({ memory: true, label: 'DriftNoResurrect' });
    db.init();
    try {
      db._applySchema();
      const indexes = objectNames(db, 'index');
      for (const name of DROPPED_INDEXES) {
        assert.ok(!indexes.has(name), `${name} must not be recreated by the completeness pass`);
      }
      const tables = objectNames(db, 'table');
      for (const name of DROPPED_HMZ_TABLES) {
        assert.ok(!tables.has(name), `${name} must not be recreated by the completeness pass`);
      }
    } finally {
      db.close();
    }
  });
});

describe('Runtime PRAGMA tuning (v26 Stage B)', () => {
  it('sets journal_size_limit and analysis_limit on init', () => {
    const db = new HumanitZDB({ memory: true, label: 'PragmaTuning' });
    db.init();
    try {
      // 64 MiB：讓 checkpoint 後截斷 -wal（生產實測曾膨脹到 1.9GB）
      assert.equal(db.db.pragma('journal_size_limit', { simple: true }), 67108864);
      // PRAGMA optimize / ANALYZE 掃描上限，維持毫秒級
      assert.equal(db.db.pragma('analysis_limit', { simple: true }), 1000);
    } finally {
      db.close();
    }
  });

  it('optimize() is a no-op before init and runs after init', () => {
    const db = new HumanitZDB({ memory: true, label: 'PragmaOptimize' });
    db.optimize(); // 未開啟時不得丟例外
    db.init();
    try {
      db.optimize(); // 開啟後可正常執行（PRAGMA optimize）
    } finally {
      db.close(); // close() 內部也會再跑一次 optimize
    }
  });
});
