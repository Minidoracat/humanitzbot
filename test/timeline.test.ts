/**
 * Tests for the Timeline system — schema v10 tables, DB CRUD, SnapshotService.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import _database from '../src/db/database.js';
const HumanitZDB = _database as any;

import _snapshot_service from '../src/tracking/snapshot-service.js';
const SnapshotService = _snapshot_service as any;

import * as _schema from '../src/db/schema.js';
const { SCHEMA_VERSION, ALL_TABLES } = _schema as any;

let db: typeof HumanitZDB;

before(() => {
  db = new HumanitZDB({ memory: true, label: 'TimelineTest' });
  db.init();
});

after(() => {
  if (db) db.close();
});

describe('Schema v11 — Timeline tables', () => {
  it('schema version is 28', () => {
    assert.equal(SCHEMA_VERSION, 28);
  });

  it('ALL_TABLES includes timeline table definitions', () => {
    const allSql = ALL_TABLES.join('\n');
    const expected = [
      'timeline_snapshots',
      'timeline_players',
      'timeline_ai',
      'timeline_vehicles',
      'timeline_structures',
      'timeline_houses',
      'timeline_companions',
      'timeline_backpacks',
      'death_causes',
    ];
    for (const t of expected) {
      assert.ok(allSql.includes(t), `ALL_TABLES SQL should include ${t}`);
    }
  });

  it('creates all timeline tables in DB', () => {
    const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const names = tables.map((t: { name: string }) => t.name);
    assert.ok(names.includes('timeline_snapshots'));
    assert.ok(names.includes('timeline_players'));
    assert.ok(names.includes('timeline_ai'));
    assert.ok(names.includes('timeline_vehicles'));
    assert.ok(names.includes('timeline_structures'));
    assert.ok(names.includes('timeline_houses'));
    assert.ok(names.includes('timeline_companions'));
    assert.ok(names.includes('timeline_backpacks'));
    assert.ok(names.includes('death_causes'));
  });

  it('creates indexes on timeline tables', () => {
    const indexes = db.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_tl_%'").all();
    const names = indexes.map((i: { name: string }) => i.name);
    assert.ok(names.includes('idx_tl_snap_created'));
    assert.ok(names.includes('idx_tl_snap_day'));
    assert.ok(names.includes('idx_tl_players_snap'));
    // v26：單欄 steam_id 索引汰換為複合 (steam_id, snapshot_id) —— delta 重建查詢
    // 需要 index-only scan，trails 查詢用其 prefix。
    assert.ok(names.includes('idx_tl_players_steam_snap'));
    assert.ok(!names.includes('idx_tl_players_steam'));
    assert.ok(names.includes('idx_tl_ai_snap'));
    assert.ok(names.includes('idx_tl_vehicles_snap'));
    assert.ok(names.includes('idx_tl_structures_snap'));
    // idx_tl_structures_owner intentionally dropped in v25 (pure write amplification on
    // the multi-million-row timeline_structures table; timeline reads only by snapshot_id).
    assert.ok(!names.includes('idx_tl_structures_owner'));
    // idx_tl_ai_type / idx_tl_ai_cat / idx_tl_houses_uid intentionally dropped in v26
    // (verified unused — timeline reads only by snapshot_id).
    assert.ok(!names.includes('idx_tl_ai_type'));
    assert.ok(!names.includes('idx_tl_ai_cat'));
    assert.ok(!names.includes('idx_tl_houses_uid'));
  });
});

describe('DB — insertTimelineSnapshot + queries', () => {
  let snapId: number;
  const snapshotCount = () =>
    (db.db.prepare('SELECT COUNT(*) AS count FROM timeline_snapshots').get() as { count: number }).count;

  it('inserts a timeline snapshot with entities', () => {
    snapId = db.timeline.insertTimelineSnapshot({
      snapshot: {
        gameDay: 42,
        gameTime: 14.5,
        playerCount: 2,
        onlineCount: 1,
        aiCount: 3,
        structureCount: 1,
        vehicleCount: 1,
        containerCount: 0,
        worldItemCount: 10,
        weatherType: 'Rain',
        season: 'Summer',
        airdropActive: true,
        airdropX: 1000,
        airdropY: 2000,
        airdropAiAlive: 2,
        summary: { gameDifficulty: 'hard' },
      },
      players: [
        {
          steamId: '76561198000000001',
          name: 'Alice',
          online: 1,
          x: 100,
          y: 200,
          z: 50,
          health: 90,
          maxHealth: 100,
          hunger: 70,
          thirst: 60,
          infection: 0,
          stamina: 80,
          level: 5,
          zeeksKilled: 42,
          daysSurvived: 10,
          lifetimeKills: 100,
        },
        {
          steamId: '76561198000000002',
          name: 'Bob',
          online: 0,
          x: 300,
          y: 400,
          z: 55,
          health: 50,
          maxHealth: 100,
          hunger: 40,
          thirst: 30,
          infection: 5,
          stamina: 60,
          level: 3,
          zeeksKilled: 20,
          daysSurvived: 5,
          lifetimeKills: 50,
        },
      ],
      ai: [
        { aiType: 'ZombieDefault', category: 'zombie', displayName: 'Zombie', nodeUid: 'n1', x: 500, y: 600, z: 10 },
        { aiType: 'AnimalWold', category: 'animal', displayName: 'Wolf', nodeUid: 'n2', x: 700, y: 800, z: 15 },
        {
          aiType: 'BanditPistol',
          category: 'bandit',
          displayName: 'Bandit (Pistol)',
          nodeUid: 'n3',
          x: 900,
          y: 100,
          z: 20,
        },
      ],
      vehicles: [
        {
          class: 'BP_Sedan_C',
          displayName: 'Sedan',
          x: 1100,
          y: 1200,
          z: 5,
          health: 800,
          maxHealth: 1000,
          fuel: 15.5,
          itemCount: 3,
        },
      ],
      structures: [
        {
          actorClass: 'BP_WoodWall_C',
          displayName: 'Wood Wall',
          ownerSteamId: '76561198000000001',
          x: 150,
          y: 250,
          z: 50,
          currentHealth: 200,
          maxHealth: 500,
          upgradeLevel: 1,
        },
      ],
      houses: [
        {
          uid: 'house_001',
          name: 'Ranch House',
          windowsOpen: 2,
          windowsTotal: 4,
          doorsOpen: 1,
          doorsLocked: 0,
          doorsTotal: 3,
          destroyedFurniture: 1,
          hasGenerator: true,
          sleepers: 0,
          clean: 1,
          x: null,
          y: null,
        },
      ],
      companions: [
        {
          entityType: 'dog',
          actorName: 'BP_Dog_C',
          displayName: 'Dog',
          ownerSteamId: '76561198000000001',
          x: 110,
          y: 210,
          z: 50,
          health: 80,
          extra: { stamina: 50 },
        },
      ],
      backpacks: [{ class: 'BP_Backpack_C', x: 500, y: 500, z: 10, itemCount: 5, items: [{ item: 'Axe', amount: 1 }] }],
    });

    assert.ok(typeof snapId === 'number');
    assert.ok(snapId > 0);
  });

  it('rolls back the snapshot row when a child insert fails', () => {
    const before = snapshotCount();

    assert.throws(
      () =>
        db.timeline.insertTimelineSnapshot({
          snapshot: { gameDay: 99, playerCount: 1 },
          players: [{ name: 'MissingSteamId' }],
        }),
      /NOT NULL constraint failed: timeline_players\.steam_id/,
    );

    assert.equal(snapshotCount(), before);
  });

  it('getTimelineSnapshots returns snapshot metadata', () => {
    const snaps = db.timeline.getTimelineSnapshots(10);
    assert.ok(snaps.length >= 1);
    const s = snaps[0];
    assert.equal(s.game_day, 42);
    assert.equal(s.weather_type, 'Rain');
    assert.equal(s.season, 'Summer');
    assert.equal(s.player_count, 2);
    assert.equal(s.online_count, 1);
    assert.equal(s.ai_count, 3);
    assert.equal(s.airdrop_active, 1);
    assert.ok(typeof s.summary === 'object'); // parsed from JSON
    assert.equal(s.summary.gameDifficulty, 'hard');
  });

  it('getTimelineSnapshotFull returns all entities', () => {
    const full = db.timeline.getTimelineSnapshotFull(snapId);
    assert.ok(full);
    assert.ok(full.snapshot);
    assert.equal(full.snapshot.id, snapId);
    assert.equal(full.players.length, 2);
    assert.equal(full.ai.length, 3);
    assert.equal(full.vehicles.length, 1);
    assert.equal(full.structures.length, 1);
    assert.equal(full.houses.length, 1);
    assert.equal(full.companions.length, 1);
    assert.equal(full.backpacks.length, 1);
  });

  it('getTimelineSnapshotFull player data is correct', () => {
    const full = db.timeline.getTimelineSnapshotFull(snapId);
    const alice = full.players.find((p: { name: string }) => p.name === 'Alice');
    assert.ok(alice);
    assert.equal(alice.steam_id, '76561198000000001');
    assert.equal(alice.online, 1);
    assert.equal(alice.pos_x, 100);
    assert.equal(alice.pos_y, 200);
    assert.equal(alice.health, 90);
    assert.equal(alice.level, 5);
    assert.equal(alice.zeeks_killed, 42);
  });

  it('getTimelineSnapshotFull AI data is correct', () => {
    const full = db.timeline.getTimelineSnapshotFull(snapId);
    const wolf = full.ai.find((a: { ai_type: string }) => a.ai_type === 'AnimalWold');
    assert.ok(wolf);
    assert.equal(wolf.category, 'animal');
    assert.equal(wolf.display_name, 'Wolf');
    assert.equal(wolf.pos_x, 700);
  });

  it('getTimelineSnapshotFull vehicle data is correct', () => {
    const full = db.timeline.getTimelineSnapshotFull(snapId);
    assert.equal(full.vehicles[0].display_name, 'Sedan');
    assert.equal(full.vehicles[0].fuel, 15.5);
    assert.equal(full.vehicles[0].item_count, 3);
  });

  it('getTimelineSnapshotFull structure data is correct', () => {
    const full = db.timeline.getTimelineSnapshotFull(snapId);
    assert.equal(full.structures[0].display_name, 'Wood Wall');
    assert.equal(full.structures[0].owner_steam_id, '76561198000000001');
    assert.equal(full.structures[0].upgrade_level, 1);
  });

  it('getTimelineSnapshotFull house data is correct', () => {
    const full = db.timeline.getTimelineSnapshotFull(snapId);
    assert.equal(full.houses[0].uid, 'house_001');
    assert.equal(full.houses[0].windows_open, 2);
    assert.equal(full.houses[0].has_generator, 1);
  });

  it('getTimelineSnapshotFull companion data is correct', () => {
    const full = db.timeline.getTimelineSnapshotFull(snapId);
    assert.equal(full.companions[0].entity_type, 'dog');
    assert.equal(full.companions[0].owner_steam_id, '76561198000000001');
  });

  it('getTimelineSnapshotFull backpack data is correct', () => {
    const full = db.timeline.getTimelineSnapshotFull(snapId);
    assert.equal(full.backpacks[0].item_count, 5);
    assert.ok(Array.isArray(full.backpacks[0].items_summary)); // parsed from JSON
  });

  it('getTimelineBounds returns correct bounds', () => {
    const bounds = db.timeline.getTimelineBounds();
    assert.ok(bounds);
    assert.ok(bounds.earliest);
    assert.ok(bounds.latest);
    assert.ok(bounds.count >= 1);
  });

  it('getTimelineSnapshotRange returns snapshots in range', () => {
    db.timeline.getTimelineBounds();
    const snaps = db.timeline.getTimelineSnapshotRange('2000-01-01', '2100-01-01');
    assert.ok(snaps.length >= 1);
  });

  it('getTimelineSnapshotFull returns null for missing ID', () => {
    const result = db.timeline.getTimelineSnapshotFull(999999);
    assert.equal(result, null);
  });
});

describe('DB — Player position history', () => {
  it('getPlayerPositionHistory returns player trail', () => {
    const trail = db.timeline.getPlayerPositionHistory('76561198000000001', '2000-01-01', '2100-01-01');
    assert.ok(trail.length >= 1);
    assert.equal(trail[0].pos_x, 100);
    assert.equal(trail[0].pos_y, 200);
    assert.ok(trail[0].created_at);
  });

  it('getPlayerPositionHistory returns empty for unknown player', () => {
    const trail = db.timeline.getPlayerPositionHistory('0000000000000000', '2000-01-01', '2100-01-01');
    assert.equal(trail.length, 0);
  });
});

describe('DB — AI population history', () => {
  it('getAIPopulationHistory returns population data', () => {
    const pop = db.timeline.getAIPopulationHistory('2000-01-01', '2100-01-01');
    assert.ok(pop.length >= 1);
    assert.equal(pop[0].ai_count, 3);
    assert.equal(pop[0].zombies, 1);
    assert.equal(pop[0].animals, 1);
    assert.equal(pop[0].bandits, 1);
  });
});

describe('DB — Death causes', () => {
  it('inserts a death cause', () => {
    db.deathCause.insertDeathCause({
      victimName: 'Alice',
      victimSteamId: '76561198000000001',
      causeType: 'zombie',
      causeName: 'Runner',
      causeRaw: 'BP_ZombieRunner_C',
      damageTotal: 45.5,
      x: 100,
      y: 200,
      z: 50,
    });
    // Should not throw
  });

  it('inserts a PvP death cause', () => {
    db.deathCause.insertDeathCause({
      victimName: 'Bob',
      victimSteamId: '76561198000000002',
      causeType: 'player',
      causeName: 'Alice',
      causeRaw: 'BP_Player_C',
      damageTotal: 80,
      x: 300,
      y: 400,
      z: 55,
    });
  });

  it('getDeathCauses returns recent deaths', () => {
    const deaths = db.deathCause.getDeathCauses(10);
    assert.ok(deaths.length >= 2);
    assert.equal(deaths[0].victim_name, 'Bob'); // most recent first
    assert.equal(deaths[0].cause_type, 'player');
    assert.equal(deaths[0].cause_name, 'Alice');
  });

  it('getDeathCausesByPlayer filters by player name', () => {
    const deaths = db.deathCause.getDeathCausesByPlayer('Alice', 10);
    assert.ok(deaths.length >= 1);
    assert.equal(deaths[0].victim_name, 'Alice');
    assert.equal(deaths[0].cause_name, 'Runner');
  });

  it('getDeathCausesByPlayer filters by steam ID', () => {
    const deaths = db.deathCause.getDeathCausesByPlayer('76561198000000002', 10);
    assert.ok(deaths.length >= 1);
    assert.equal(deaths[0].victim_name, 'Bob');
  });

  it('getDeathCauseStats returns aggregated stats', () => {
    const stats = db.deathCause.getDeathCauseStats();
    assert.ok(stats.length >= 2);
    const zombieStat = stats.find((s: { cause_type: string }) => s.cause_type === 'zombie');
    assert.ok(zombieStat);
    assert.equal(zombieStat.cause_name, 'Runner');
    assert.equal(zombieStat.count, 1);
  });

  it('getDeathCausesSince returns deaths after timestamp', () => {
    const deaths = db.deathCause.getDeathCausesSince('2000-01-01');
    assert.ok(deaths.length >= 2);
  });
});

describe('DB — purgeOldTimeline', () => {
  it('purgeOldTimeline does not delete recent data', async () => {
    const result = await db.timeline.purgeOldTimeline('-1 second');
    // Should delete everything (all are older than 1 second ago), but it uses
    // datetime('now', ...) so recent inserts may or may not be affected.
    // At minimum, it shouldn't crash
    assert.ok(typeof result.changes === 'number');
  });

  it('is reference-aware: keeps an old keyframe still referenced by a retained snapshot', async () => {
    const tl = db.timeline;
    const struct = {
      actorClass: 'BP_Wall',
      ownerSteamId: 'S1',
      x: 1,
      y: 1,
      z: 1,
      currentHealth: 100,
      maxHealth: 100,
      upgradeLevel: 0,
    };
    const kf = tl.insertTimelineSnapshot({ snapshot: { gameDay: 1, structuresStateHash: 'rh' }, structures: [struct] });
    const ref = tl.insertTimelineSnapshot({
      snapshot: { gameDay: 1, structuresStateHash: 'rh', structuresRefSnapshotId: kf },
      structures: [],
    });
    const orphanOld = tl.insertTimelineSnapshot({ snapshot: { gameDay: 1 }, structures: [] });
    // Age the keyframe + an unreferenced snapshot past the window; keep the ref snapshot recent.
    db.db
      .prepare("UPDATE timeline_snapshots SET created_at = datetime('now','-30 days') WHERE id IN (?, ?)")
      .run(kf, orphanOld);
    await tl.purgeOldTimeline('-7 days');
    const exists = (id: number) => !!db.db.prepare('SELECT 1 FROM timeline_snapshots WHERE id = ?').get(id);
    assert.ok(exists(kf), 'referenced keyframe must survive even though it is past the window');
    assert.ok(!exists(orphanOld), 'unreferenced old snapshot must be pruned');
    assert.ok(exists(ref), 'retained ref snapshot must remain and still resolve its structures');
    assert.equal(tl.getTimelineSnapshotFull(ref).structures.length, 1);
    // Once the referrer ages out too, the keyframe is freed on a later pass.
    db.db.prepare("UPDATE timeline_snapshots SET created_at = datetime('now','-30 days') WHERE id = ?").run(ref);
    await tl.purgeOldTimeline('-7 days');
    assert.ok(!exists(kf) && !exists(ref), 'keyframe freed once no retained snapshot references it');
  });

  it('is reference-aware for v26 backpacks/houses keyframes too', async () => {
    const tl = db.timeline;
    const kf = tl.insertTimelineSnapshot({
      snapshot: { gameDay: 3, backpacksStateHash: 'bh', housesStateHash: 'hh' },
      backpacks: [{ class: 'BP_Backpack_C', x: 1, y: 2, z: 3, itemCount: 1, items: [] }],
      houses: [{ uid: 'h1', name: 'House' }],
    });
    const ref = tl.insertTimelineSnapshot({
      snapshot: {
        gameDay: 3,
        backpacksStateHash: 'bh',
        backpacksRefSnapshotId: kf,
        housesStateHash: 'hh',
        housesRefSnapshotId: kf,
      },
      backpacks: [],
      houses: [],
    });
    db.db.prepare("UPDATE timeline_snapshots SET created_at = datetime('now','-30 days') WHERE id = ?").run(kf);
    await tl.purgeOldTimeline('-7 days');
    const exists = (id: number) => !!db.db.prepare('SELECT 1 FROM timeline_snapshots WHERE id = ?').get(id);
    assert.ok(exists(kf), 'backpacks/houses-referenced keyframe must survive the window');
    assert.equal(tl.getTimelineSnapshotFull(ref).backpacks.length, 1);
    assert.equal(tl.getTimelineSnapshotFull(ref).houses.length, 1);
    // 清場：讓 referrer 也老化，keyframe 在下一輪被釋放
    db.db.prepare("UPDATE timeline_snapshots SET created_at = datetime('now','-30 days') WHERE id = ?").run(ref);
    await tl.purgeOldTimeline('-7 days');
    assert.ok(!exists(kf) && !exists(ref));
  });

  it('keeps the newest pre-cutoff players keyframe as the reconstruction base for retained snapshots', async () => {
    const tl = db.timeline;
    const player = (name: string, over: Record<string, unknown> = {}) => ({
      steamId: `sid-${name}`,
      name,
      x: 1,
      y: 1,
      z: 0,
      health: 100,
      ...over,
    });
    const kOld0 = tl.insertTimelineSnapshot({
      snapshot: { gameDay: 60, playersKeyframe: 1 },
      players: [player('Old')],
    });
    const kOld1 = tl.insertTimelineSnapshot({
      snapshot: { gameDay: 61, playersKeyframe: 1 },
      players: [player('A'), player('B')],
    });
    const dOld = tl.insertTimelineSnapshot({ snapshot: { gameDay: 61 }, players: [] });
    const dNew = tl.insertTimelineSnapshot({
      snapshot: { gameDay: 62 },
      players: [player('A', { x: 42 })],
    });
    db.db.prepare("UPDATE timeline_snapshots SET created_at = datetime('now','-40 days') WHERE id = ?").run(kOld0);
    db.db
      .prepare("UPDATE timeline_snapshots SET created_at = datetime('now','-20 days') WHERE id IN (?, ?)")
      .run(kOld1, dOld);

    await tl.purgeOldTimeline('-7 days');

    const exists = (id: number) => !!db.db.prepare('SELECT 1 FROM timeline_snapshots WHERE id = ?').get(id);
    assert.ok(exists(kOld1), 'newest pre-cutoff players keyframe must survive (reconstruction base)');
    assert.ok(!exists(kOld0), 'older keyframes are NOT protected — only the newest pre-cutoff one');
    assert.ok(!exists(dOld), 'old delta snapshots are purged normally');
    assert.ok(exists(dNew));
    // codex probe 2 場景：保留中的 snapshot 重建仍完整（基準沒被 purge 掉）
    const roster = tl.getTimelineSnapshotFull(dNew).players as Array<{ name: string; pos_x: number }>;
    assert.equal(roster.length, 2, 'retained snapshot must reconstruct the full roster from the protected keyframe');
    assert.equal(roster.find((p) => p.name === 'A')?.pos_x, 42, 'delta overlay still applies');
    assert.equal(roster.find((p) => p.name === 'B')?.pos_x, 1, 'keyframe-only player survives the purge');

    // 保護會前移：更新的 keyframe 落到 cutoff 之外後，舊基準下一輪釋放
    const kNewer = tl.insertTimelineSnapshot({
      snapshot: { gameDay: 63, playersKeyframe: 1 },
      players: [player('A', { x: 42 }), player('B')],
    });
    db.db.prepare("UPDATE timeline_snapshots SET created_at = datetime('now','-10 days') WHERE id = ?").run(kNewer);
    await tl.purgeOldTimeline('-7 days');
    assert.ok(!exists(kOld1), 'once a newer pre-cutoff keyframe exists the old base is freed');
    assert.ok(exists(kNewer), 'the protection rolls forward to the newest pre-cutoff keyframe');
    // 清場：讓後續測試不受本測試的保護 keyframe 影響
    db.db.prepare('DELETE FROM timeline_snapshots WHERE id IN (?, ?)').run(kNewer, dNew);
  });

  it('normalizes a non-finite/zero batchSize instead of looping forever, and handles 0 pending rows', async () => {
    const tl = db.timeline;
    const ids = [
      tl.insertTimelineSnapshot({ snapshot: { gameDay: 70 } }),
      tl.insertTimelineSnapshot({ snapshot: { gameDay: 71 } }),
    ];
    db.db
      .prepare(`UPDATE timeline_snapshots SET created_at = datetime('now','-30 days') WHERE id IN (?, ?)`)
      .run(...ids);
    // batchSize=0 會讓「changes < batchSize」永不成立 —— 必須正規化成預設值並終止
    const result = await tl.purgeOldTimeline('-7 days', 0);
    assert.ok(result.changes >= 2, 'zero batchSize must be normalized and still purge');
    // 0 待刪列：立即回傳 changes=0
    const empty = await tl.purgeOldTimeline('-7 days', NaN);
    assert.equal(empty.changes, 0);
  });

  it('deletes everything when the row count is an exact multiple of batchSize', async () => {
    const tl = db.timeline;
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) ids.push(tl.insertTimelineSnapshot({ snapshot: { gameDay: 80 + i } }));
    db.db
      .prepare(
        `UPDATE timeline_snapshots SET created_at = datetime('now','-30 days') WHERE id IN (${ids.map(() => '?').join(',')})`,
      )
      .run(...ids);
    const result = await tl.purgeOldTimeline('-7 days', 3); // 6 列 → 3+3+0 三批
    assert.equal(result.changes, 6);
    const remaining = db.db
      .prepare(`SELECT COUNT(*) AS c FROM timeline_snapshots WHERE id IN (${ids.map(() => '?').join(',')})`)
      .get(...ids) as { c: number };
    assert.equal(remaining.c, 0);
  });

  it('deletes in batches until done and returns the total (batchSize < rows to purge)', async () => {
    const tl = db.timeline;
    const ids: number[] = [];
    for (let i = 0; i < 7; i++) ids.push(tl.insertTimelineSnapshot({ snapshot: { gameDay: 50 + i } }));
    db.db
      .prepare(
        `UPDATE timeline_snapshots SET created_at = datetime('now','-30 days') WHERE id IN (${ids.map(() => '?').join(',')})`,
      )
      .run(...ids);
    const result = await tl.purgeOldTimeline('-7 days', 3); // 7 列 → 3+3+1 三批
    assert.ok(result.changes >= 7, `all aged snapshots purged across batches (got ${String(result.changes)})`);
    const remaining = db.db
      .prepare(`SELECT COUNT(*) AS c FROM timeline_snapshots WHERE id IN (${ids.map(() => '?').join(',')})`)
      .get(...ids) as { c: number };
    assert.equal(remaining.c, 0, 'batched purge must delete everything past the window');
  });
});

describe('SnapshotService', () => {
  let service: typeof SnapshotService;
  let serviceDb: typeof HumanitZDB;

  before(() => {
    serviceDb = new HumanitZDB({ memory: true, label: 'SnapTest' });
    serviceDb.init();
    // minIntervalSeconds: 0 — this suite records multiple snapshots back-to-back
    service = new SnapshotService(serviceDb, { retentionDays: 7, minIntervalSeconds: 0 });
  });

  after(() => {
    if (serviceDb) serviceDb.close();
  });

  it('records a snapshot from save-like data', () => {
    const saveData = {
      players: new Map([
        [
          '76561198000000001',
          {
            name: 'TestPlayer',
            steamId: '76561198000000001',
            x: 150000,
            y: -200000,
            z: 100,
            health: 85,
            maxHealth: 100,
            hunger: 60,
            thirst: 50,
            infection: 0,
            stamina: 90,
            level: 7,
            zeeksKilled: 55,
            daysSurvived: 15,
            lifetimeKills: 120,
          },
        ],
      ]),
      worldState: {
        totalDaysElapsed: 45,
        timeOfDay: { day: 45, time: 10.5 },
        aiSpawns: [
          { type: 'ZombieDefault', category: 'zombie', x: 160000, y: -190000, z: 50, nodeUid: 'a1' },
          { type: 'AnimalWold', category: 'animal', x: 170000, y: -180000, z: 55, nodeUid: 'a2' },
        ],
        houses: [
          {
            uid: 'h1',
            name: 'House 1',
            windowsOpen: 1,
            windowsTotal: 3,
            doorsOpen: 0,
            doorsTotal: 2,
            doorsLocked: 1,
            destroyedFurniture: 0,
            hasGenerator: false,
          },
        ],
        droppedBackpacks: [
          { class: 'BP_Backpack_C', x: 155000, y: -195000, z: 80, items: [{ item: 'Axe', amount: 1 }] },
        ],
      },
      vehicles: [
        {
          class: 'BP_Van_C',
          displayName: 'Van',
          x: 140000,
          y: -210000,
          z: 60,
          health: 500,
          maxHealth: 1000,
          fuel: 20,
          inventory: ['item1', 'item2'],
        },
      ],
      structures: [
        {
          actorClass: 'BP_WoodFloor_C',
          displayName: 'Wood Floor',
          ownerSteamId: '76561198000000001',
          x: 152000,
          y: -198000,
          z: 100,
          currentHealth: 300,
          maxHealth: 500,
          upgradeLevel: 2,
        },
      ],
      companions: [
        {
          type: 'dog',
          actorName: 'BP_Dog_C',
          ownerSteamId: '76561198000000001',
          x: 151000,
          y: -199000,
          z: 100,
          health: 90,
          extra: {},
        },
      ],
      horses: [
        {
          actorName: 'BP_Horse_C',
          horseName: 'Spirit',
          ownerSteamId: '76561198000000001',
          x: 153000,
          y: -197000,
          z: 100,
          health: 100,
          energy: 80,
          stamina: 70,
        },
      ],
    };

    const snapId = service.recordSnapshot(saveData, { onlinePlayers: new Set(['testplayer']) });
    assert.ok(typeof snapId === 'number');
    assert.ok(snapId > 0);
    assert.equal(service.snapshotCount, 1);
    assert.equal(service.lastSnapshotId, snapId);
  });

  it('stored snapshot has correct metadata', () => {
    const snaps = serviceDb.timeline.getTimelineSnapshots(1);
    assert.equal(snaps.length, 1);
    const s = snaps[0];
    assert.equal(s.game_day, 45);
    assert.equal(s.player_count, 1);
    assert.equal(s.ai_count, 2);
    assert.equal(s.vehicle_count, 1);
    assert.equal(s.structure_count, 1);
    assert.equal(s.season, 'Summer'); // day 45 → (45 % 120) / 30 = 1 → Summer
  });

  it('stored snapshot has correct entity data', () => {
    const full = serviceDb.timeline.getTimelineSnapshotFull(service.lastSnapshotId);
    assert.ok(full);
    assert.equal(full.players.length, 1);
    assert.equal(full.players[0].name, 'TestPlayer');
    assert.equal(full.ai.length, 2);
    assert.equal(full.vehicles.length, 1);
    assert.equal(full.vehicles[0].display_name, 'Van');
    assert.equal(full.structures.length, 1);
    assert.equal(full.companions.length, 2); // 1 companion + 1 horse
    assert.equal(full.backpacks.length, 1);
    assert.equal(full.houses.length, 1);
  });

  it('horse is stored as companion with entity_type=horse', () => {
    const full = serviceDb.timeline.getTimelineSnapshotFull(service.lastSnapshotId);
    const horse = full.companions.find((c: { entity_type: string }) => c.entity_type === 'horse');
    assert.ok(horse);
    assert.equal(horse.display_name, 'Spirit');
  });

  it('AI display names are resolved', () => {
    const full = serviceDb.timeline.getTimelineSnapshotFull(service.lastSnapshotId);
    const zombie = full.ai.find((a: { ai_type: string }) => a.ai_type === 'ZombieDefault');
    assert.ok(zombie);
    assert.equal(zombie.display_name, 'Zombie');
    assert.equal(zombie.category, 'zombie');

    const wolf = full.ai.find((a: { ai_type: string }) => a.ai_type === 'AnimalWold');
    assert.ok(wolf);
    assert.equal(wolf.display_name, 'Wolf');
    assert.equal(wolf.category, 'animal');
  });

  it('handles empty save data without crashing', () => {
    const snapId = service.recordSnapshot({});
    // Should return a snapshot ID (empty but valid)
    assert.ok(typeof snapId === 'number');
  });

  it('handles null DB gracefully', () => {
    const nullService = new SnapshotService(null);
    const result = nullService.recordSnapshot({ players: new Map() });
    assert.equal(result, null);
  });

  it('handles null saveData gracefully', () => {
    const result = service.recordSnapshot(null);
    assert.equal(result, null);
  });

  it('classifies AI categories correctly', () => {
    // Test internal method
    assert.equal(service._classifyAICategory('ZombieDefault'), 'zombie');
    assert.equal(service._classifyAICategory('ZombieRunner'), 'zombie');
    assert.equal(service._classifyAICategory('AnimalWold'), 'animal');
    assert.equal(service._classifyAICategory('AnimalBear'), 'animal');
    assert.equal(service._classifyAICategory('BanditPistol'), 'bandit');
    assert.equal(service._classifyAICategory('BanditRifle'), 'bandit');
    assert.equal(service._classifyAICategory('AnimalZDog'), 'zombie'); // zombie animal = zombie
    assert.equal(service._classifyAICategory(null), 'unknown');
  });

  it('resolves seasons from day count', () => {
    assert.equal(service._resolveSeason({ totalDaysElapsed: 0 }), 'Spring'); // 0-29
    assert.equal(service._resolveSeason({ totalDaysElapsed: 15 }), 'Spring');
    assert.equal(service._resolveSeason({ totalDaysElapsed: 30 }), 'Summer'); // 30-59
    assert.equal(service._resolveSeason({ totalDaysElapsed: 60 }), 'Autumn'); // 60-89
    assert.equal(service._resolveSeason({ totalDaysElapsed: 90 }), 'Winter'); // 90-119
    assert.equal(service._resolveSeason({ totalDaysElapsed: 120 }), 'Spring'); // cycles
  });
});

describe('SnapshotService throttling', () => {
  let throttleDb: typeof HumanitZDB;

  const makeSaveData = () => ({
    players: new Map([['76561198000000001', { name: 'TestPlayer', steamId: '76561198000000001' }]]),
    worldState: { totalDaysElapsed: 1, timeOfDay: { day: 1, time: 8 } },
  });

  const snapshotCount = () =>
    (throttleDb.db.prepare('SELECT COUNT(*) AS count FROM timeline_snapshots').get() as { count: number }).count;

  before(() => {
    throttleDb = new HumanitZDB({ memory: true, label: 'ThrottleTest' });
    throttleDb.init();
  });

  after(() => {
    if (throttleDb) throttleDb.close();
  });

  it('skips snapshots recorded within the minimum interval', () => {
    const svc = new SnapshotService(throttleDb, { minIntervalSeconds: 300 });
    const before = snapshotCount();

    const first = svc.recordSnapshot(makeSaveData());
    assert.ok(typeof first === 'number' && first > 0);

    const second = svc.recordSnapshot(makeSaveData());
    assert.equal(second, null);
    assert.equal(svc.snapshotCount, 1);
    assert.equal(snapshotCount(), before + 1);
  });

  it('records again once the interval has elapsed', () => {
    const svc = new SnapshotService(throttleDb, { minIntervalSeconds: 300 });
    const first = svc.recordSnapshot(makeSaveData());
    assert.ok(typeof first === 'number' && first > 0);

    // Backdate the last-snapshot timestamp past the interval
    svc._lastSnapshotAt = Date.now() - 301_000;

    const second = svc.recordSnapshot(makeSaveData());
    assert.ok(typeof second === 'number' && second > 0);
    assert.equal(svc.snapshotCount, 2);
  });

  it('minIntervalSeconds: 0 disables throttling', () => {
    const svc = new SnapshotService(throttleDb, { minIntervalSeconds: 0 });
    const first = svc.recordSnapshot(makeSaveData());
    const second = svc.recordSnapshot(makeSaveData());
    assert.ok(typeof first === 'number' && first > 0);
    assert.ok(typeof second === 'number' && second > 0);
    assert.equal(svc.snapshotCount, 2);
  });

  it('force bypasses the throttle', () => {
    const svc = new SnapshotService(throttleDb, { minIntervalSeconds: 300 });
    const first = svc.recordSnapshot(makeSaveData());
    assert.ok(typeof first === 'number' && first > 0);

    const forced = svc.recordSnapshot(makeSaveData(), { force: true });
    assert.ok(typeof forced === 'number' && forced > 0);
    assert.equal(svc.snapshotCount, 2);
  });

  it('defaults to config.timelineSnapshotMinInterval (300s)', () => {
    // TIMELINE_SNAPSHOT_MIN_INTERVAL is unset in .env.test → config default 300
    const svc = new SnapshotService(throttleDb);
    assert.equal(svc._minIntervalMs, 300_000);
  });

  it('throttled call does not update the last-snapshot timestamp', () => {
    const svc = new SnapshotService(throttleDb, { minIntervalSeconds: 300 });
    svc.recordSnapshot(makeSaveData());
    const lastAt = svc._lastSnapshotAt;
    assert.ok(typeof lastAt === 'number');

    svc.recordSnapshot(makeSaveData());
    assert.equal(svc._lastSnapshotAt, lastAt);
  });
});

// Guards the round-1 fix: a zombie flood must not starve animals/bandits off the map, and
// the result is bounded per category + whitelisted. A revert to a plain LIMIT fails here.
describe('Timeline AI map cap (per-category, whitelist, NULL filter)', () => {
  let aiSnap: number;
  before(() => {
    db.db.prepare('INSERT INTO timeline_snapshots (game_day) VALUES (999)').run();
    aiSnap = (db.db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;
    const ins = db.db.prepare(
      'INSERT INTO timeline_ai (snapshot_id, ai_type, category, pos_x, pos_y) VALUES (?, ?, ?, ?, ?)',
    );
    for (let i = 0; i < 1000; i++) ins.run(aiSnap, 'Zombie', 'zombie', 10 + i, 20);
    for (let i = 0; i < 5; i++) ins.run(aiSnap, 'Deer', 'animal', 100 + i, 200);
    for (let i = 0; i < 3; i++) ins.run(aiSnap, 'Bandit', 'bandit', 300 + i, 400);
    ins.run(aiSnap, 'Zombie', 'zombie', null, 20); // NULL pos_x — must be filtered out
    ins.run(aiSnap, 'Animal', 'animal', 50, null); // NULL pos_y — must be filtered out too
    ins.run(aiSnap, 'Boss', 'boss', 500, 600); // unknown category — excluded by the whitelist
  });

  it('caps zombies at 700, keeps animals/bandits, drops NULL-pos and unknown category', () => {
    const rows = db.timeline.getTimelineAIForMap(aiSnap) as Array<{
      category: string;
      pos_x: number | null;
      pos_y: number | null;
    }>;
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.category] = (counts[r.category] || 0) + 1;
    assert.equal(counts.zombie, 700); // per-category cap — not the full 1000, not starved to 0
    assert.equal(counts.animal, 5); // small layers fully preserved (the NULL-pos_y one is dropped)
    assert.equal(counts.bandit, 3);
    assert.equal(counts.boss, undefined); // whitelist excludes categories the map doesn't render
    assert.ok(
      rows.every((r) => r.pos_x !== null && r.pos_y !== null),
      'rows missing either coordinate must be excluded before ranking',
    );
  });
});

describe('timeline structure fan-out dedup (v25)', () => {
  const mkStruct = (over: Record<string, unknown> = {}) => ({
    actorClass: 'BP_Wall',
    displayName: 'Wall',
    ownerSteamId: 'S1',
    x: 1,
    y: 2,
    z: 3,
    currentHealth: 100,
    maxHealth: 100,
    upgradeLevel: 0,
    ...over,
  });

  it('a ref snapshot stores no structure rows but resolves them from the keyframe', () => {
    const tl = db.timeline;
    const kf = tl.insertTimelineSnapshot({
      snapshot: { gameDay: 1, structuresStateHash: 'hashA' },
      structures: [mkStruct(), mkStruct({ actorClass: 'BP_Door', x: 4, upgradeLevel: 1 })],
    });
    const ref = tl.insertTimelineSnapshot({
      snapshot: { gameDay: 1, structuresStateHash: 'hashA', structuresRefSnapshotId: kf },
      structures: [], // deduped: reference the keyframe instead of re-storing
    });
    // The ref snapshot wrote none of its own structure rows.
    const ownRows = db.db.prepare('SELECT COUNT(*) AS c FROM timeline_structures WHERE snapshot_id = ?').get(ref) as {
      c: number;
    };
    assert.equal(ownRows.c, 0);
    // But the read path resolves structures from the referenced keyframe.
    assert.equal(tl.getTimelineSnapshotFull(ref).structures.length, 2);
    // The keyframe itself still returns its own structures.
    assert.equal(tl.getTimelineSnapshotFull(kf).structures.length, 2);
  });

  it('a dangling ref (keyframe structures pruned) degrades to [] instead of erroring', () => {
    const tl = db.timeline;
    const kf = tl.insertTimelineSnapshot({
      snapshot: { gameDay: 2, structuresStateHash: 'hashB' },
      structures: [mkStruct({ actorClass: 'BP_Floor', ownerSteamId: 'S2' })],
    });
    const ref = tl.insertTimelineSnapshot({
      snapshot: { gameDay: 2, structuresStateHash: 'hashB', structuresRefSnapshotId: kf },
      structures: [],
    });
    // Simulate retention pruning the keyframe's structure rows out from under the ref.
    db.db.prepare('DELETE FROM timeline_structures WHERE snapshot_id = ?').run(kf);
    assert.deepEqual(tl.getTimelineSnapshotFull(ref).structures, []);
  });
});

// Producer-side coverage: drives SnapshotService.recordSnapshot() so the keyframe/ref
// decision state machine (hash, unchanged-vs-cadence, restart reset, order-independence)
// is exercised end-to-end — not just the repository read path with hand-built rows.
describe('timeline structure dedup — producer (SnapshotService)', () => {
  let pdb: typeof HumanitZDB;
  before(() => {
    pdb = new HumanitZDB({ memory: true, label: 'DedupProducer' });
    pdb.init();
  });
  after(() => {
    if (pdb) pdb.close();
  });

  const struct = (over: Record<string, unknown> = {}) => ({
    actorClass: 'BP_Wall',
    ownerSteamId: 'S1',
    x: 1,
    y: 2,
    z: 3,
    currentHealth: 100,
    maxHealth: 100,
    upgradeLevel: 0,
    ...over,
  });
  const save = (structures: Array<Record<string, unknown>>) => ({
    players: new Map(),
    worldState: { totalDaysElapsed: 1, timeOfDay: { day: 1, time: 8 } },
    structures,
  });
  const ownRows = (id: number) =>
    (pdb.db.prepare('SELECT COUNT(*) AS c FROM timeline_structures WHERE snapshot_id = ?').get(id) as { c: number }).c;
  const refOf = (id: number) =>
    (
      pdb.db.prepare('SELECT structures_ref_snapshot_id AS r FROM timeline_snapshots WHERE id = ?').get(id) as {
        r: number | null;
      }
    ).r;

  it('first tick writes a full keyframe; an identical next tick references it with zero own rows', () => {
    const svc = new SnapshotService(pdb, { minIntervalSeconds: 0 });
    const set = [struct(), struct({ actorClass: 'BP_Door', x: 9, upgradeLevel: 1 })];
    const k = svc.recordSnapshot(save(set)) as number;
    assert.equal(ownRows(k), 2, 'keyframe stores its own structure rows');
    assert.equal(refOf(k), null, 'keyframe has no ref');
    const r = svc.recordSnapshot(save(set.map((s) => ({ ...s })))) as number; // identical content
    assert.equal(ownRows(r), 0, 'ref tick stores no structure rows');
    assert.equal(refOf(r), k, 'ref tick points at the keyframe');
    assert.equal(pdb.timeline.getTimelineSnapshotFull(r).structures.length, 2, 'read resolves via the ref');
  });

  it('a content change forces a fresh keyframe', () => {
    const svc = new SnapshotService(pdb, { minIntervalSeconds: 0 });
    svc.recordSnapshot(save([struct()])); // initial keyframe
    const k2 = svc.recordSnapshot(save([struct({ currentHealth: 50 })])) as number; // health changed
    assert.equal(refOf(k2), null, 'changed structures must write a new keyframe, not a ref');
    assert.ok(ownRows(k2) > 0);
  });

  it('forces a keyframe within KEYFRAME_EVERY even when structures are unchanged', () => {
    const svc = new SnapshotService(pdb, { minIntervalSeconds: 0 });
    const ids: number[] = [];
    for (let i = 0; i < 15; i++) ids.push(svc.recordSnapshot(save([struct()])) as number);
    const keyframes = ids.filter((id) => refOf(id) === null).length;
    assert.ok(keyframes >= 2, `expected a forced keyframe within the cadence; got ${String(keyframes)} in 15 ticks`);
  });

  it('is order-independent: the same structure set in a different order does NOT force a keyframe', () => {
    const svc = new SnapshotService(pdb, { minIntervalSeconds: 0 });
    const a = struct({ actorClass: 'BP_A', x: 1 });
    const b = struct({ actorClass: 'BP_B', x: 2 });
    const k = svc.recordSnapshot(save([a, b])) as number;
    const r = svc.recordSnapshot(save([b, a])) as number; // same set, reversed
    assert.equal(refOf(r), k, 'reordered identical set should reference the keyframe');
    assert.equal(ownRows(r), 0);
  });

  it('writes a fresh keyframe on the first tick after a restart (in-memory state reset)', () => {
    const set = [struct()];
    const svc1 = new SnapshotService(pdb, { minIntervalSeconds: 0 });
    svc1.recordSnapshot(save(set));
    // New service instance == process restart: keyframe state is not persisted in memory.
    const svc2 = new SnapshotService(pdb, { minIntervalSeconds: 0 });
    const first = svc2.recordSnapshot(save(set.map((s) => ({ ...s })))) as number;
    assert.equal(refOf(first), null, 'first tick after restart must be a self-contained keyframe');
    assert.ok(ownRows(first) > 0);
  });
});

// v26：backpacks / houses 套用與 structures 相同的 hash-ref dedup —— 針對各自的
// keyframe/ref 決策與讀路徑解析做 producer-side 驗證。
describe('timeline backpacks/houses dedup — producer (v26)', () => {
  let pdb: typeof HumanitZDB;
  before(() => {
    pdb = new HumanitZDB({ memory: true, label: 'DedupBH' });
    pdb.init();
  });
  after(() => {
    if (pdb) pdb.close();
  });

  const save = (backpacks: Array<Record<string, unknown>>, houses: Array<Record<string, unknown>>) => ({
    players: new Map(),
    worldState: { totalDaysElapsed: 1, timeOfDay: { day: 1, time: 8 }, droppedBackpacks: backpacks, houses },
  });
  const bp = (over: Record<string, unknown> = {}) => ({
    class: 'BP_Backpack_C',
    x: 1,
    y: 2,
    z: 3,
    items: [{ item: 'Axe', amount: 1 }],
    ...over,
  });
  const house = (over: Record<string, unknown> = {}) => ({
    uid: 'h1',
    name: 'House',
    windowsOpen: 1,
    windowsTotal: 3,
    doorsOpen: 0,
    doorsTotal: 2,
    doorsLocked: 1,
    destroyedFurniture: 0,
    hasGenerator: false,
    ...over,
  });
  const ownRows = (table: string, id: number) =>
    (pdb.db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE snapshot_id = ?`).get(id) as { c: number }).c;
  const refsOf = (id: number) =>
    pdb.db
      .prepare(
        'SELECT backpacks_ref_snapshot_id AS b, houses_ref_snapshot_id AS h FROM timeline_snapshots WHERE id = ?',
      )
      .get(id) as { b: number | null; h: number | null };

  it('identical backpacks+houses on the next tick reference the keyframe with zero own rows', () => {
    const svc = new SnapshotService(pdb, { minIntervalSeconds: 0 });
    const k = svc.recordSnapshot(save([bp()], [house()])) as number;
    assert.equal(ownRows('timeline_backpacks', k), 1);
    assert.equal(ownRows('timeline_houses', k), 1);
    assert.deepEqual(refsOf(k), { b: null, h: null });

    const r = svc.recordSnapshot(save([bp()], [house()])) as number;
    assert.equal(ownRows('timeline_backpacks', r), 0, 'ref tick stores no backpack rows');
    assert.equal(ownRows('timeline_houses', r), 0, 'ref tick stores no house rows');
    assert.deepEqual(refsOf(r), { b: k, h: k });
    // 讀路徑跟著 ref 解析
    const full = pdb.timeline.getTimelineSnapshotFull(r);
    assert.equal(full.backpacks.length, 1);
    assert.equal(full.houses.length, 1);
    assert.equal(full.houses[0].uid, 'h1');
  });

  it('a change in one kind busts only that kind (independent keyframe state)', () => {
    const svc = new SnapshotService(pdb, { minIntervalSeconds: 0 });
    const k = svc.recordSnapshot(save([bp()], [house()])) as number;
    // 背包內容變（撿走一件），房屋不變 → backpacks 寫新 keyframe、houses 仍 ref
    const r = svc.recordSnapshot(save([bp({ items: [] })], [house()])) as number;
    const refs = refsOf(r);
    assert.equal(refs.b, null, 'changed backpacks must write a fresh keyframe');
    assert.ok(ownRows('timeline_backpacks', r) === 1);
    assert.equal(refs.h, k, 'unchanged houses still reference the keyframe');
    assert.equal(ownRows('timeline_houses', r), 0);
  });

  // _hashHouses 假覆蓋防護：任一持久化欄位（這裡挑 floatData 派生的 clean）變動都必須 bust dedup。
  it('a single-field house change (clean) busts the houses dedup', () => {
    const svc = new SnapshotService(pdb, { minIntervalSeconds: 0 });
    const k = svc.recordSnapshot(save([bp()], [house({ floatData: { Clean: 1 } })])) as number;
    const r = svc.recordSnapshot(save([bp()], [house({ floatData: { Clean: 0 } })])) as number;
    const refs = refsOf(r);
    assert.equal(refs.h, null, 'a one-field house change must write a fresh houses keyframe');
    assert.equal(ownRows('timeline_houses', r), 1);
    assert.equal(refs.b, k, 'unchanged backpacks still reference the keyframe');
  });

  // 比照 structures 既有測試：keyframe 子表列被 prune 掉時 degrade 到 []，不丟例外。
  it('dangling backpacks/houses refs degrade to [] instead of erroring', () => {
    const svc = new SnapshotService(pdb, { minIntervalSeconds: 0 });
    const k = svc.recordSnapshot(save([bp()], [house()])) as number;
    const r = svc.recordSnapshot(save([bp()], [house()])) as number;
    assert.deepEqual(refsOf(r), { b: k, h: k });
    pdb.db.prepare('DELETE FROM timeline_backpacks WHERE snapshot_id = ?').run(k);
    pdb.db.prepare('DELETE FROM timeline_houses WHERE snapshot_id = ?').run(k);
    const full = pdb.timeline.getTimelineSnapshotFull(r);
    assert.deepEqual(full.backpacks, []);
    assert.deepEqual(full.houses, []);
  });
});

// v26：timeline_players delta 寫入 —— 只寫 online / 狀態有變的玩家；
// getTimelineSnapshotFull 用 latest-row-<=snapshot 重建全名冊。
describe('timeline players delta — producer + reconstruction (v26)', () => {
  let pdb: typeof HumanitZDB;
  before(() => {
    pdb = new HumanitZDB({ memory: true, label: 'PlayersDelta' });
    pdb.init();
  });
  after(() => {
    if (pdb) pdb.close();
  });

  const alice = (over: Record<string, unknown> = {}) => ({
    steamId: 'S1',
    name: 'Alice',
    x: 1,
    y: 2,
    z: 3,
    health: 100,
    ...over,
  });
  const bob = (over: Record<string, unknown> = {}) => ({
    steamId: 'S2',
    name: 'Bob',
    x: 10,
    y: 20,
    z: 30,
    health: 80,
    ...over,
  });
  const save = (players: Array<Record<string, unknown>>) => ({
    players: new Map(players.map((p) => [p.steamId as string, p])),
    worldState: { totalDaysElapsed: 1, timeOfDay: { day: 1, time: 8 } },
  });
  const ownRows = (id: number) =>
    (pdb.db.prepare('SELECT COUNT(*) AS c FROM timeline_players WHERE snapshot_id = ?').get(id) as { c: number }).c;

  it('first tick writes the full roster; unchanged offline players are skipped on later ticks', () => {
    const svc = new SnapshotService(pdb, { minIntervalSeconds: 0 });
    const t1 = svc.recordSnapshot(save([alice(), bob()])) as number;
    assert.equal(ownRows(t1), 2, 'restart keyframe writes every player');

    const t2 = svc.recordSnapshot(save([alice(), bob()])) as number;
    assert.equal(ownRows(t2), 0, 'nothing changed and nobody online → zero player rows');
    // 重建：全名冊仍完整，資料來自各玩家最近一列
    const full = pdb.timeline.getTimelineSnapshotFull(t2);
    assert.equal(full.players.length, 2);
    const a = full.players.find((p: { steam_id: string }) => p.steam_id === 'S1');
    assert.equal(a.pos_x, 1);
    assert.equal(a.health, 100);
  });

  it('online players are always written; an offline state change also writes a row', () => {
    const svc = new SnapshotService(pdb, { minIntervalSeconds: 0 });
    svc.recordSnapshot(save([alice(), bob()]));
    // Alice online（連兩 tick，狀態不變也要寫 —— online 玩家逐 tick 留軌跡）
    const t2 = svc.recordSnapshot(save([alice(), bob()]), { onlinePlayers: new Set(['alice']) }) as number;
    const t3 = svc.recordSnapshot(save([alice(), bob()]), { onlinePlayers: new Set(['alice']) }) as number;
    assert.equal(ownRows(t2), 1);
    assert.equal(ownRows(t3), 1, 'online player written every tick even when unchanged');
    // Bob 離線但位置變了 → 也要寫
    const t4 = svc.recordSnapshot(save([alice(), bob({ x: 99 })]), { onlinePlayers: new Set(['alice']) }) as number;
    assert.equal(ownRows(t4), 2, 'offline position change must write a row');
    const full = pdb.timeline.getTimelineSnapshotFull(t4);
    const b = full.players.find((p: { steam_id: string }) => p.steam_id === 'S2');
    assert.equal(b.pos_x, 99);
    // 歷史 snapshot 的重建不受之後的變動影響（時間旅行正確性）
    const full3 = pdb.timeline.getTimelineSnapshotFull(t3);
    const b3 = full3.players.find((p: { steam_id: string }) => p.steam_id === 'S2');
    assert.equal(b3.pos_x, 10, 'reconstruction at t3 must show the pre-move position');
  });

  it('forces a full-roster keyframe within KEYFRAME_EVERY ticks', () => {
    const svc = new SnapshotService(pdb, { minIntervalSeconds: 0 });
    const ids: number[] = [];
    for (let i = 0; i < 14; i++) ids.push(svc.recordSnapshot(save([alice(), bob()])) as number);
    const fullWrites = ids.filter((id) => ownRows(id) === 2).length;
    assert.ok(fullWrites >= 2, `expected a forced player keyframe within the cadence; got ${String(fullWrites)}`);
  });

  it('a new service instance (restart) writes the full roster again', () => {
    const svc1 = new SnapshotService(pdb, { minIntervalSeconds: 0 });
    svc1.recordSnapshot(save([alice(), bob()]));
    const svc2 = new SnapshotService(pdb, { minIntervalSeconds: 0 });
    const first = svc2.recordSnapshot(save([alice(), bob()])) as number;
    assert.equal(ownRows(first), 2, 'first tick after restart must write every player');
  });

  it('trails (getPlayerPositionHistory) still work across delta gaps', () => {
    const svc = new SnapshotService(pdb, { minIntervalSeconds: 0 });
    svc.recordSnapshot(save([alice(), bob()]));
    svc.recordSnapshot(save([alice(), bob()])); // delta gap：無列
    svc.recordSnapshot(save([alice({ x: 5 }), bob()]));
    const trail = pdb.timeline.getPlayerPositionHistory('S2', '2000-01-01', '2100-01-01');
    assert.ok(trail.length >= 1, 'stationary offline player still has keyframe rows in the trail');
  });

  // 生產形狀（v26 實測）：save-cache 的 player value 物件沒有頂層 steamId 欄位，
  // steamId 只存在於 Map 的 key —— 寫入端必須把 key 帶進列，否則 steam_id 全空。
  it('production shape: Map key becomes steam_id when the value object has no steamId field', () => {
    const svc = new SnapshotService(pdb, { minIntervalSeconds: 0 });
    const snapId = svc.recordSnapshot({
      players: new Map([
        ['76561198000000777', { name: 'Prod', x: 1, y: 2, z: 3, health: 100 }],
        ['76561198000000778', { name: 'Prod2', x: 4, y: 5, z: 6, health: 90 }],
      ]),
      worldState: { totalDaysElapsed: 1, timeOfDay: { day: 1, time: 8 } },
    }) as number;
    const rows = pdb.db
      .prepare('SELECT steam_id, name FROM timeline_players WHERE snapshot_id = ? ORDER BY steam_id')
      .all(snapId) as Array<{ steam_id: string; name: string }>;
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.steam_id, '76561198000000777');
    assert.equal(rows[1]?.steam_id, '76561198000000778');
  });

  // _playerSig 假覆蓋防護：離線玩家任一持久化欄位變動都必須寫新列。
  it('an offline hunger change and an offline lifetimeKills change each write a delta row', () => {
    const svc = new SnapshotService(pdb, { minIntervalSeconds: 0 });
    svc.recordSnapshot(save([alice({ hunger: 50, lifetimeKills: 10 }), bob()])); // keyframe
    const t2 = svc.recordSnapshot(save([alice({ hunger: 40, lifetimeKills: 10 }), bob()])) as number;
    assert.equal(ownRows(t2), 1, 'offline hunger change must write a row');
    const t3 = svc.recordSnapshot(save([alice({ hunger: 40, lifetimeKills: 11 }), bob()])) as number;
    assert.equal(ownRows(t3), 1, 'offline lifetimeKills change must write a row');
    const row = pdb.db.prepare('SELECT hunger, lifetime_kills FROM timeline_players WHERE snapshot_id = ?').get(t3) as {
      hunger: number;
      lifetime_kills: number;
    };
    assert.equal(row.hunger, 40);
    assert.equal(row.lifetime_kills, 11);
  });

  // wiped 玩家：從存檔移除後，下一個 keyframe 起不再出現 —— 幽靈窗 ≤ 一個 keyframe 週期。
  it('a wiped player disappears from reconstruction at the next keyframe (bounded ghost window)', () => {
    const svc = new SnapshotService(pdb, { minIntervalSeconds: 0 });
    const ids: number[] = [];
    ids.push(svc.recordSnapshot(save([alice(), bob()])) as number); // t1 keyframe（雙人）
    // t2 起 bob 被 wipe；持續 tick 直到 cadence 逼出下一個 keyframe（KEYFRAME_EVERY=12）
    for (let i = 0; i < 13; i++) ids.push(svc.recordSnapshot(save([alice()])) as number);
    const keyframes = pdb.db
      .prepare(
        `SELECT id FROM timeline_snapshots WHERE players_keyframe = 1 AND id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
      )
      .all(...ids) as Array<{ id: number }>;
    assert.ok(keyframes.length >= 2, 'cadence must force a second keyframe');
    const secondKf = keyframes[1]?.id as number;
    // keyframe 之前的 delta snapshot：bob 仍是幽靈（凍結於最後狀態）
    const ghostSnap = ids[ids.indexOf(secondKf) - 1];
    const ghostRoster = pdb.timeline.getTimelineSnapshotFull(ghostSnap).players;
    assert.ok(
      ghostRoster.some((p: { steam_id: string }) => p.steam_id === 'S2'),
      'before the next keyframe the wiped player is still visible (known bounded window)',
    );
    // keyframe 起：bob 消失
    const roster = pdb.timeline.getTimelineSnapshotFull(secondKf).players;
    assert.equal(roster.length, 1, 'wiped player must be gone from the keyframe roster onward');
    assert.equal(roster[0].steam_id, 'S1');
    // keyframe 之後的 delta snapshot 也乾淨
    const after = ids[ids.indexOf(secondKf) + 1];
    if (after !== undefined) {
      const rosterAfter = pdb.timeline.getTimelineSnapshotFull(after).players;
      assert.ok(!rosterAfter.some((p: { steam_id: string }) => p.steam_id === 'S2'));
    }
  });
});

// 生產 legacy 相容（v26）：既有 769k 列 steam_id 全空（寫入端 bug，v26 起修復），
// migration 把歷史 snapshot 全標 keyframe。重建的識別鍵是 steam_id || name ——
// legacy 列靠 name overlay、新列靠 steamId，跨 keyframe 混合資料重建必須正確。
describe('timeline players delta — legacy empty steam_id reconstruction (v26)', () => {
  let ldb: typeof HumanitZDB;
  before(() => {
    ldb = new HumanitZDB({ memory: true, label: 'LegacyPlayers' });
    ldb.init();
  });
  after(() => {
    if (ldb) ldb.close();
  });

  it('legacy rows (steam_id="") overlay by name; post-fix rows overlay by steamId', () => {
    const tl = ldb.timeline;
    // Legacy 世界：全量 snapshot（migration 回填 → playersKeyframe: 1），steam_id 全空
    const l1 = tl.insertTimelineSnapshot({
      snapshot: { gameDay: 1, playersKeyframe: 1 },
      players: [
        { steamId: '', name: 'Alice', x: 1, y: 1, z: 0, health: 100 },
        { steamId: '', name: 'Bob', x: 2, y: 2, z: 0, health: 90 },
      ],
    });
    const l2 = tl.insertTimelineSnapshot({
      snapshot: { gameDay: 1, playersKeyframe: 1 },
      players: [
        { steamId: '', name: 'Alice', x: 5, y: 5, z: 0, health: 80 },
        { steamId: '', name: 'Bob', x: 2, y: 2, z: 0, health: 90 },
      ],
    });
    // legacy snapshot 重建：K = 自己（都是 keyframe），名冊不塌縮成單一玩家
    const full1 = tl.getTimelineSnapshotFull(l1);
    assert.equal(full1.players.length, 2, 'legacy snapshot roster must not collapse despite empty steam_id');
    const full2 = tl.getTimelineSnapshotFull(l2);
    assert.equal(full2.players.length, 2);
    const a2 = full2.players.find((p: { name: string }) => p.name === 'Alice');
    assert.equal(a2.pos_x, 5, 'latest legacy keyframe wins for the same name');

    // v26 修復後：新 keyframe 帶真實 steamId + 之後的 delta —— 跨 keyframe 重建正確
    const k = tl.insertTimelineSnapshot({
      snapshot: { gameDay: 2, playersKeyframe: 1 },
      players: [
        { steamId: '76561198000000001', name: 'Alice', x: 7, y: 7, z: 0, health: 70 },
        { steamId: '76561198000000002', name: 'Bob', x: 8, y: 8, z: 0, health: 60 },
      ],
    });
    const d = tl.insertTimelineSnapshot({
      snapshot: { gameDay: 2, playersKeyframe: 0 },
      players: [{ steamId: '76561198000000001', name: 'Alice', x: 9, y: 9, z: 0, health: 65 }],
    });
    const fullD = tl.getTimelineSnapshotFull(d);
    assert.equal(fullD.players.length, 2, 'keyframe roster + delta overlay = full roster');
    const aD = fullD.players.find((p: { steam_id: string }) => p.steam_id === '76561198000000001');
    assert.equal(aD.pos_x, 9, 'delta row overlays the keyframe row');
    const bD = fullD.players.find((p: { steam_id: string }) => p.steam_id === '76561198000000002');
    assert.equal(bD.pos_x, 8, 'player without a delta row keeps the keyframe state');
    // 新 keyframe 斷開 legacy 混合資料：不會撈回 l1/l2 的 name-keyed 列
    assert.ok(
      fullD.players.every((p: { steam_id: string }) => p.steam_id !== ''),
      'reconstruction after the fix must not mix in pre-keyframe legacy rows',
    );
    void k;
  });
});

describe('SnapshotService prune reentrancy (v26)', () => {
  it('_pruneOldData skips while a previous batched purge is still in flight', async () => {
    let calls = 0;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stubDb = {
      timeline: {
        purgeOldTimeline: async () => {
          calls++;
          await gate;
          return { changes: 0 };
        },
      },
    };
    const svc = new SnapshotService(stubDb, { minIntervalSeconds: 0, retentionDays: 7 });
    const first = svc._pruneOldData();
    void svc._pruneOldData(); // 前一輪未完成 → 不重入
    assert.equal(calls, 1, 'second call must be skipped while the first is in flight');
    (release as unknown as () => void)();
    await first;
    await svc._pruneOldData(); // 完成後可再進入
    assert.equal(calls, 2);
  });

  it('_pruneOldData swallows purge errors (fire-and-forget must never reject)', async () => {
    const stubDb = {
      timeline: {
        purgeOldTimeline: () => Promise.reject(new Error('boom')),
      },
    };
    const svc = new SnapshotService(stubDb, { minIntervalSeconds: 0, retentionDays: 7 });
    await svc._pruneOldData(); // 不得 throw / reject
    assert.equal(svc._pruneInFlight, false, 'in-flight flag must be reset after a failure');
  });
});
