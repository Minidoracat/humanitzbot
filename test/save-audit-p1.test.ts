import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import HumanitZDB from '../src/db/database.js';
import { SCHEMA_VERSION } from '../src/db/schema.js';
import { normalizePlayerHorses } from '../src/parsers/save-parser.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Raw GVAS property array for one horse, as produced by agent v4 caches. */
function makeRawGvasHorse(name = '殺戮戰神') {
  return [
    { name: 'Class', type: 'ObjectProperty', raw: 'Class_2_902791154FF7', value: 'None' },
    {
      name: 'SoftClass',
      type: 'SoftObjectProperty',
      raw: 'SoftClass_29_C3CEBC7241',
      value: '/Game/TSS_Game/KaiWorldEffects/Horse/BP_Horse_Child3.BP_Horse_Child3_C',
    },
    {
      name: 'Transform',
      type: 'StructProperty',
      raw: 'Transform_6_DEDB30C84D',
      value: {
        translation: { x: 70235.71875, y: -356085.34375, z: 5685.46435546875 },
        rotation: { x: 0, y: 0, z: -0.62, w: 0.79 },
        scale: { x: 1, y: 1, z: 1 },
      },
      structType: 'Transform',
    },
    { name: 'Health', type: 'FloatProperty', raw: 'Health_9_D1AB96EB', value: 800 },
    { name: 'Energy', type: 'FloatProperty', raw: 'Energy_11_AB0790EF', value: 90.119 },
    { name: 'Stamina', type: 'FloatProperty', raw: 'Stamina_13_AAAA', value: 1 },
    { name: 'Owner', type: 'StrProperty', raw: 'Owner_15', value: '76561197962470657_+_|0002320d6d3a4a4e' },
    { name: 'Saddle', type: 'IntProperty', raw: 'Saddle_17', value: 4 },
    {
      name: 'Inventory',
      type: 'ArrayProperty',
      raw: 'Inventory_19',
      value: [{ item: 'Hay', amount: 10, durability: 100, weight: 0.2 }],
    },
    { name: 'HorseName', type: 'StrProperty', raw: 'HorseName_21', value: name },
  ];
}

function makeStructuredQuest(overrides: Record<string, unknown> = {}) {
  return {
    id: '8f968b6873170a4f9dddf951d01a3ec3',
    type: '',
    state: '',
    data: {},
    time: { TradeSpawn: '2023-08-23T10:53:41.400Z' },
    items: [
      { item: '357', amount: 73, durability: 74.03 },
      { item: '22ammo', amount: 52, durability: 91.66 },
    ],
    x: 12345.5,
    y: -67890.25,
    z: 100,
    ...overrides,
  };
}

// ── normalizePlayerHorses (P1-3) ────────────────────────────────────────────

describe('normalizePlayerHorses', () => {
  it('converts raw agent-v4 GVAS property arrays to structured horses', () => {
    const horses = normalizePlayerHorses([makeRawGvasHorse()]);
    assert.equal(horses.length, 1);
    const h = horses[0];
    assert.ok(h);
    assert.equal(h.name, '殺戮戰神');
    assert.equal(h.class, '/Game/TSS_Game/KaiWorldEffects/Horse/BP_Horse_Child3.BP_Horse_Child3_C');
    assert.equal(h.health, 800);
    assert.equal(h.energy, 90.119);
    assert.equal(h.stamina, 1);
    assert.equal(h.saddle, 4);
    assert.equal(h.ownerSteamId, '76561197962470657');
    assert.equal(h.x, 70235.71875);
    assert.equal(h.y, -356085.34375);
    assert.equal(h.inventory.length, 1);
    assert.ok(h.displayName.length > 0);
  });

  it('passes through already-structured horses unchanged', () => {
    const structured = [{ name: 'Pony', class: 'BP_Horse_C', health: 500, x: 1, y: 2, z: 3 }];
    const result = normalizePlayerHorses(structured);
    assert.equal(result, structured as never);
  });

  it('returns an empty array for non-array and empty input', () => {
    assert.deepEqual(normalizePlayerHorses(undefined), []);
    assert.deepEqual(normalizePlayerHorses(null), []);
    assert.deepEqual(normalizePlayerHorses('nope'), []);
    assert.deepEqual(normalizePlayerHorses([]), []);
  });

  it('handles multiple raw horses', () => {
    const horses = normalizePlayerHorses([makeRawGvasHorse('Alpha'), makeRawGvasHorse('Beta')]);
    assert.deepEqual(
      horses.map((h) => h.name),
      ['Alpha', 'Beta'],
    );
  });
});

// ── DB-backed checks (schema v24, quests + save_last_login) ────────────────

describe('save-audit P1 DB integration', () => {
  let db: HumanitZDB;

  beforeEach(() => {
    db = new HumanitZDB({ memory: true, label: 'SaveAuditP1Test' });
    db.init();
  });

  afterEach(() => {
    db.close();
  });

  describe('quests structured columns (P1-1)', () => {
    it('persists time/items/position through innerReplaceQuests', () => {
      db.quest.replaceQuests([makeStructuredQuest()]);

      const row = db.rawQuery('SELECT * FROM quests', [], { ctx: 'test:quests' });
      assert.equal(row.length, 1);
      const q = row[0];
      assert.ok(q);
      assert.equal(q.id, '8f968b6873170a4f9dddf951d01a3ec3');
      assert.deepEqual(JSON.parse(q.time as string), { TradeSpawn: '2023-08-23T10:53:41.400Z' });
      assert.equal((JSON.parse(q.items as string) as unknown[]).length, 2);
      assert.equal(q.pos_x, 12345.5);
      assert.equal(q.pos_y, -67890.25);
      assert.equal(q.pos_z, 100);
    });

    it('defaults missing time/items/position to empty values (older agent caches)', () => {
      db.quest.replaceQuests([{ id: 'guid-only', type: '', state: '', data: {} }]);

      const q = db.rawQuery('SELECT * FROM quests', [], { ctx: 'test:quests' })[0];
      assert.ok(q);
      assert.equal(q.time, '{}');
      assert.equal(q.items, '[]');
      assert.equal(q.pos_x, null);
      assert.equal(q.pos_y, null);
      assert.equal(q.pos_z, null);
    });

    it('getPositionedQuests only returns quests with real coordinates', () => {
      db.quest.replaceQuests([
        makeStructuredQuest(),
        { id: 'no-pos', type: '', state: '', data: {} },
        // (0,0) placeholder transform — most world quests in real saves
        makeStructuredQuest({ id: 'zero-pos', x: 0, y: 0, z: 0 }),
      ]);

      const rows = db.quest.getPositionedQuests();
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.id, '8f968b6873170a4f9dddf951d01a3ec3');
    });
  });

  describe('players.save_last_login (P1-2)', () => {
    it('maps lastLogin from save data into save_last_login', () => {
      db.player.upsertPlayer('76561197962470657', {
        name: 'Tester',
        lastLogin: '2026-06-08T22:17:04.980Z',
      });

      const row = db.rawQuery('SELECT save_last_login FROM players WHERE steam_id = ?', ['76561197962470657'], {
        ctx: 'test:lastlogin',
      })[0];
      assert.ok(row);
      // normalizeDbTimestampUtc canonicalizes to 'YYYY-MM-DD HH:MM:SS'
      assert.equal(row.save_last_login, '2026-06-08 22:17:04');
    });

    it('keeps the previous save_last_login when a later sync omits lastLogin', () => {
      db.player.upsertPlayer('76561197962470657', {
        name: 'Tester',
        lastLogin: '2026-06-08T22:17:04.980Z',
      });
      db.player.upsertPlayer('76561197962470657', { name: 'Tester' });

      const row = db.rawQuery('SELECT save_last_login FROM players WHERE steam_id = ?', ['76561197962470657'], {
        ctx: 'test:lastlogin',
      })[0];
      assert.ok(row);
      assert.equal(row.save_last_login, '2026-06-08 22:17:04');
    });

    it('leaves save_last_login NULL when the save never provided one', () => {
      db.player.upsertPlayer('76561197962470657', { name: 'Tester' });

      const row = db.rawQuery('SELECT save_last_login FROM players WHERE steam_id = ?', ['76561197962470657'], {
        ctx: 'test:lastlogin',
      })[0];
      assert.ok(row);
      assert.equal(row.save_last_login, null);
    });
  });

  describe('schema v24 migration', () => {
    it('adds the v24 columns to a pre-v24 database', () => {
      const legacy = new HumanitZDB({ memory: true, label: 'SaveAuditP1MigrationTest' });
      legacy.init();
      const handle = (legacy as unknown as { _handle: import('better-sqlite3').Database })._handle;
      // Rebuild the quests table and players column in their v23 shape,
      // then re-run the migration path.
      handle.exec(`
        DROP TABLE quests;
        CREATE TABLE quests (
          id         TEXT PRIMARY KEY,
          type       TEXT DEFAULT '',
          state      TEXT DEFAULT '',
          data       TEXT DEFAULT '{}',
          updated_at TEXT DEFAULT (datetime('now'))
        );
        ALTER TABLE players DROP COLUMN save_last_login;
      `);
      handle.exec("UPDATE meta SET value = '23' WHERE key = 'schema_version'");
      (legacy as unknown as { _applySchema: () => void })._applySchema();

      const questCols = (handle.prepare('PRAGMA table_info(quests)').all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      for (const col of ['time', 'items', 'pos_x', 'pos_y', 'pos_z']) {
        assert.ok(questCols.includes(col), `quests.${col} missing after migration`);
      }
      const playerCols = (handle.prepare('PRAGMA table_info(players)').all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      assert.ok(playerCols.includes('save_last_login'), 'players.save_last_login missing after migration');
      const version = handle.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
        value: string;
      };
      assert.equal(version.value, String(SCHEMA_VERSION));
      legacy.close();
    });
  });
});
