import type Database from 'better-sqlite3';
import { BaseRepository } from './base-repository.js';
import { type DbRow } from './db-utils.js';
import { yieldToEventLoop } from '../../utils/async.js';

export class TimelineRepository extends BaseRepository {
  declare private _stmts: {
    insertTimelineSnapshot: Database.Statement;
    getTimelineSnapshots: Database.Statement;
    getTimelineSnapshotRange: Database.Statement;
    getTimelineSnapshotById: Database.Statement;
    getLatestTimelineSnapshotId: Database.Statement;
    getTimelineSnapshotCount: Database.Statement;
    purgeOldTimelineBatch: Database.Statement;
    getTimelineSnapshotBounds: Database.Statement;
    insertTimelinePlayer: Database.Statement;
    insertTimelineAI: Database.Statement;
    insertTimelineVehicle: Database.Statement;
    insertTimelineStructure: Database.Statement;
    insertTimelineHouse: Database.Statement;
    insertTimelineCompanion: Database.Statement;
    insertTimelineBackpack: Database.Statement;
    getTimelinePlayersKeyframe: Database.Statement;
    getTimelinePlayersRange: Database.Statement;
    getTimelineAI: Database.Statement;
    getTimelineAIForMap: Database.Statement;
    getTimelineVehicles: Database.Statement;
    getTimelineStructures: Database.Statement;
    getTimelineHouses: Database.Statement;
    getTimelineCompanions: Database.Statement;
    getTimelineBackpacks: Database.Statement;
    getPlayerPositionHistory: Database.Statement;
    getAIPopulationHistory: Database.Statement;
  };

  protected _prepareStatements(): void {
    this._stmts = {
      // ── Timeline snapshots ──
      insertTimelineSnapshot: this._handle.prepare(`
        INSERT INTO timeline_snapshots (game_day, game_time, player_count, online_count,
          ai_count, structure_count, vehicle_count, container_count, world_item_count,
          weather_type, season, airdrop_active, airdrop_x, airdrop_y, airdrop_ai_alive, summary,
          structures_state_hash, structures_ref_snapshot_id,
          backpacks_state_hash, backpacks_ref_snapshot_id, houses_state_hash, houses_ref_snapshot_id,
          players_keyframe)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      getTimelineSnapshots: this._handle.prepare('SELECT * FROM timeline_snapshots ORDER BY created_at DESC LIMIT ?'),
      getTimelineSnapshotRange: this._handle.prepare(
        'SELECT * FROM timeline_snapshots WHERE created_at BETWEEN ? AND ? ORDER BY created_at ASC',
      ),
      getTimelineSnapshotById: this._handle.prepare('SELECT * FROM timeline_snapshots WHERE id = ?'),
      getLatestTimelineSnapshotId: this._handle.prepare(
        'SELECT id FROM timeline_snapshots ORDER BY created_at DESC LIMIT 1',
      ),
      getTimelineSnapshotCount: this._handle.prepare('SELECT COUNT(*) as count FROM timeline_snapshots'),
      // Reference-aware prune: delete snapshots past the retention window EXCEPT any keyframe
      // still referenced by a snapshot that is itself being retained (fan-out dedup — v25
      // structures, v26 backpacks/houses). Without this, a keyframe — always the oldest row
      // in its run — would be pruned first and leave retained ref snapshots resolving to [].
      // The keyframe is freed on a later pass once all its referrers have aged out.
      // v26：改分批（LIMIT 子查詢；DELETE...LIMIT 需編譯旗標、id IN (...) 寫法無此依賴），
      // 停機補跑時單刀 DELETE + 7 張子表 ON DELETE CASCADE 可達數十秒同步阻塞。
      // Players 基準保護：另保留「created_at < cutoff 的最新 players_keyframe=1
      // snapshot」—— 它是最舊保留區（第一個保留 keyframe 之前的 snapshot）重建
      // 全名冊的基準；缺了它那段重建會回傳 []。被保護的 keyframe 是舊區的
      // MAX，分批迴圈中不會被刪、每批重算結果穩定；等更新的 keyframe 落到
      // cutoff 之外時保護自動前移、舊的下一輪釋放。
      // 參數：cutoff ×5（外層 + 三個 ref 子查詢 + players keyframe 保護）+ batch limit。
      purgeOldTimelineBatch: this._handle.prepare(
        'DELETE FROM timeline_snapshots WHERE id IN (' +
          "SELECT id FROM timeline_snapshots WHERE created_at < datetime('now', ?) " +
          'AND id NOT IN (' +
          'SELECT structures_ref_snapshot_id FROM timeline_snapshots ' +
          "WHERE structures_ref_snapshot_id IS NOT NULL AND created_at >= datetime('now', ?) " +
          'UNION SELECT backpacks_ref_snapshot_id FROM timeline_snapshots ' +
          "WHERE backpacks_ref_snapshot_id IS NOT NULL AND created_at >= datetime('now', ?) " +
          'UNION SELECT houses_ref_snapshot_id FROM timeline_snapshots ' +
          "WHERE houses_ref_snapshot_id IS NOT NULL AND created_at >= datetime('now', ?)" +
          ') AND id <> COALESCE((' +
          'SELECT id FROM timeline_snapshots WHERE players_keyframe = 1 ' +
          "AND created_at < datetime('now', ?) ORDER BY created_at DESC, id DESC LIMIT 1" +
          '), -1) LIMIT ?)',
      ),
      getTimelineSnapshotBounds: this._handle.prepare(
        'SELECT MIN(created_at) as earliest, MAX(created_at) as latest, COUNT(*) as count FROM timeline_snapshots',
      ),

      // ── Timeline entity inserts (bulk via transactions) ──
      insertTimelinePlayer: this._handle.prepare(`
        INSERT INTO timeline_players (snapshot_id, steam_id, name, online, pos_x, pos_y, pos_z,
          health, max_health, hunger, thirst, infection, stamina, level, zeeks_killed, days_survived, lifetime_kills)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertTimelineAI: this._handle.prepare(`
        INSERT INTO timeline_ai (snapshot_id, ai_type, category, display_name, node_uid, pos_x, pos_y, pos_z)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertTimelineVehicle: this._handle.prepare(`
        INSERT INTO timeline_vehicles (snapshot_id, class, display_name, pos_x, pos_y, pos_z, health, max_health, fuel, item_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertTimelineStructure: this._handle.prepare(`
        INSERT INTO timeline_structures (snapshot_id, actor_class, display_name, owner_steam_id, pos_x, pos_y, pos_z, current_health, max_health, upgrade_level)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertTimelineHouse: this._handle.prepare(`
        INSERT INTO timeline_houses (snapshot_id, uid, name, windows_open, windows_total, doors_open, doors_locked, doors_total, destroyed_furniture, has_generator, sleepers, clean, pos_x, pos_y)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertTimelineCompanion: this._handle.prepare(`
        INSERT INTO timeline_companions (snapshot_id, entity_type, actor_name, display_name, owner_steam_id, pos_x, pos_y, pos_z, health, extra)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertTimelineBackpack: this._handle.prepare(`
        INSERT INTO timeline_backpacks (snapshot_id, class, pos_x, pos_y, pos_z, item_count, items_summary)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `),

      // ── Timeline queries (for time-scroll API) ──
      // Players delta 寫入（v26）：keyframe tick（players_keyframe=1）寫全名冊，
      // 其餘 tick 只寫 online / 狀態有變的玩家。重建「snapshot T 當下全名冊」=
      // 找 T 以內最新 keyframe K（PK 反向掃描，回看 ≤ KEYFRAME_EVERY 個 snapshot）
      // + 讀 [K, T] 的列（idx_tl_players_snap 範圍掃描，EQP 實證）在 JS 做
      // overlay（後蓋前）—— 成本 O(名冊 + ≤12 tick delta)，取代舊的 O(全歷史)
      // GROUP BY 聚合（生產實測 184ms 同步阻塞）。詳見 _timelinePlayersAsOf。
      getTimelinePlayersKeyframe: this._handle.prepare(
        'SELECT id FROM timeline_snapshots WHERE id <= ? AND players_keyframe = 1 ORDER BY id DESC LIMIT 1',
      ),
      getTimelinePlayersRange: this._handle.prepare(
        'SELECT * FROM timeline_players WHERE snapshot_id >= ? AND snapshot_id <= ? ORDER BY snapshot_id ASC, id ASC',
      ),
      getTimelineAI: this._handle.prepare('SELECT * FROM timeline_ai WHERE snapshot_id = ?'),
      // Cap AI markers PER CATEGORY so a flood of zombies can't starve animals/bandits off
      // the map. A plain LIMIT applied before the client-side category split would let the
      // first 2000 (mostly zombies) hide whole layers; ~700 each keeps every layer present.
      // The category whitelist bounds the payload at the DB layer (only the 3 layers the map
      // renders) so an unexpected category can't balloon the result.
      getTimelineAIForMap: this._handle.prepare(
        'SELECT ai_type, category, display_name, pos_x, pos_y FROM (' +
          'SELECT ai_type, category, display_name, pos_x, pos_y, ' +
          'ROW_NUMBER() OVER (PARTITION BY category ORDER BY id) AS rn ' +
          "FROM timeline_ai WHERE snapshot_id = ? AND pos_x IS NOT NULL AND pos_y IS NOT NULL AND category IN ('zombie', 'animal', 'bandit')" +
          ') WHERE rn <= 700',
      ),
      getTimelineVehicles: this._handle.prepare('SELECT * FROM timeline_vehicles WHERE snapshot_id = ?'),
      getTimelineStructures: this._handle.prepare('SELECT * FROM timeline_structures WHERE snapshot_id = ?'),
      getTimelineHouses: this._handle.prepare('SELECT * FROM timeline_houses WHERE snapshot_id = ?'),
      getTimelineCompanions: this._handle.prepare('SELECT * FROM timeline_companions WHERE snapshot_id = ?'),
      getTimelineBackpacks: this._handle.prepare('SELECT * FROM timeline_backpacks WHERE snapshot_id = ?'),

      // Player position history (for trails/heatmaps)
      getPlayerPositionHistory: this._handle.prepare(`
        SELECT tp.pos_x, tp.pos_y, tp.pos_z, tp.health, tp.online, ts.created_at, ts.game_day
        FROM timeline_players tp
        JOIN timeline_snapshots ts ON tp.snapshot_id = ts.id
        WHERE tp.steam_id = ? AND ts.created_at BETWEEN ? AND ?
        ORDER BY ts.created_at ASC
      `),

      // AI population summary over time
      getAIPopulationHistory: this._handle.prepare(`
        SELECT ts.id, ts.created_at, ts.game_day, ts.ai_count,
          (SELECT COUNT(*) FROM timeline_ai WHERE snapshot_id = ts.id AND category = 'zombie') as zombies,
          (SELECT COUNT(*) FROM timeline_ai WHERE snapshot_id = ts.id AND category = 'animal') as animals,
          (SELECT COUNT(*) FROM timeline_ai WHERE snapshot_id = ts.id AND category = 'bandit') as bandits
        FROM timeline_snapshots ts
        WHERE ts.created_at BETWEEN ? AND ?
        ORDER BY ts.created_at ASC
      `),
    };
  }

  /**
   * Record a complete world snapshot (one timeline tick).
   * The snapshot row and all entity arrays are written inside a single transaction for consistency.
   *
   * @param {object} data
   * @param {object} data.snapshot - { gameDay, gameTime, playerCount, onlineCount, aiCount, ... }
   * @param {Array}  data.players  - [{ steamId, name, online, x, y, z, health, ... }]
   * @param {Array}  data.ai       - [{ aiType, category, displayName, nodeUid, x, y, z }]
   * @param {Array}  data.vehicles - [{ class, displayName, x, y, z, health, ... }]
   * @param {Array}  data.structures - [{ actorClass, displayName, ownerSteamId, ... }]
   * @param {Array}  data.houses   - [{ uid, name, windowsOpen, ... }]
   * @param {Array}  data.companions - [{ entityType, actorName, ... }]
   * @param {Array}  data.backpacks - [{ class, x, y, z, itemCount, items }]
   * @returns {number} The snapshot ID
   */
  insertTimelineSnapshot(data: Record<string, unknown>): number {
    const tx = this._handle.transaction(() => {
      const s = (data.snapshot || {}) as Record<string, unknown>;
      const result = this._stmts.insertTimelineSnapshot.run(
        s.gameDay || 0,
        s.gameTime || 0,
        s.playerCount || 0,
        s.onlineCount || 0,
        s.aiCount || 0,
        s.structureCount || 0,
        s.vehicleCount || 0,
        s.containerCount || 0,
        s.worldItemCount || 0,
        s.weatherType || '',
        s.season || '',
        s.airdropActive ? 1 : 0,
        s.airdropX ?? null,
        s.airdropY ?? null,
        s.airdropAiAlive || 0,
        JSON.stringify(s.summary || {}),
        s.structuresStateHash ?? null,
        s.structuresRefSnapshotId ?? null,
        s.backpacksStateHash ?? null,
        s.backpacksRefSnapshotId ?? null,
        s.housesStateHash ?? null,
        s.housesRefSnapshotId ?? null,
        s.playersKeyframe ? 1 : 0,
      );
      const snapId = result.lastInsertRowid;

      // Players
      if (data.players) {
        for (const p of data.players as Array<Record<string, unknown>>) {
          this._stmts.insertTimelinePlayer.run(
            snapId,
            p.steamId,
            p.name || '',
            p.online ? 1 : 0,
            p.x ?? null,
            p.y ?? null,
            p.z ?? null,
            p.health || 0,
            p.maxHealth || 100,
            p.hunger || 0,
            p.thirst || 0,
            p.infection || 0,
            p.stamina || 0,
            p.level || 0,
            p.zeeksKilled || 0,
            p.daysSurvived || 0,
            p.lifetimeKills || 0,
          );
        }
      }

      // AI spawns
      if (data.ai) {
        for (const a of data.ai as Array<Record<string, unknown>>) {
          this._stmts.insertTimelineAI.run(
            snapId,
            a.aiType,
            a.category || '',
            a.displayName || '',
            a.nodeUid || '',
            a.x ?? null,
            a.y ?? null,
            a.z ?? null,
          );
        }
      }

      // Vehicles
      if (data.vehicles) {
        for (const v of data.vehicles as Array<Record<string, unknown>>) {
          this._stmts.insertTimelineVehicle.run(
            snapId,
            v.class,
            v.displayName || '',
            v.x ?? null,
            v.y ?? null,
            v.z ?? null,
            v.health || 0,
            v.maxHealth || 0,
            v.fuel || 0,
            v.itemCount || 0,
          );
        }
      }

      // Structures
      if (data.structures) {
        for (const st of data.structures as Array<Record<string, unknown>>) {
          this._stmts.insertTimelineStructure.run(
            snapId,
            st.actorClass,
            st.displayName || '',
            st.ownerSteamId || '',
            st.x ?? null,
            st.y ?? null,
            st.z ?? null,
            st.currentHealth || 0,
            st.maxHealth || 0,
            st.upgradeLevel || 0,
          );
        }
      }

      // Houses
      if (data.houses) {
        for (const h of data.houses as Array<Record<string, unknown>>) {
          this._stmts.insertTimelineHouse.run(
            snapId,
            h.uid,
            h.name || '',
            h.windowsOpen || 0,
            h.windowsTotal || 0,
            h.doorsOpen || 0,
            h.doorsLocked || 0,
            h.doorsTotal || 0,
            h.destroyedFurniture || 0,
            h.hasGenerator ? 1 : 0,
            h.sleepers || 0,
            h.clean || 0,
            h.x ?? null,
            h.y ?? null,
          );
        }
      }

      // Companions + horses
      if (data.companions) {
        for (const c of data.companions as Array<Record<string, unknown>>) {
          this._stmts.insertTimelineCompanion.run(
            snapId,
            c.entityType,
            c.actorName || '',
            c.displayName || '',
            c.ownerSteamId || '',
            c.x ?? null,
            c.y ?? null,
            c.z ?? null,
            c.health || 0,
            JSON.stringify(c.extra || {}),
          );
        }
      }

      // Dropped backpacks
      if (data.backpacks) {
        for (const b of data.backpacks as Array<Record<string, unknown>>) {
          this._stmts.insertTimelineBackpack.run(
            snapId,
            b.class || '',
            b.x ?? null,
            b.y ?? null,
            b.z ?? null,
            b.itemCount || 0,
            JSON.stringify(b.items || []),
          );
        }
      }

      return Number(snapId);
    });

    return tx();
  }

  /** Get recent timeline snapshots (metadata only). */
  getTimelineSnapshots(limit = 50): DbRow[] {
    return (this._stmts.getTimelineSnapshots.all(limit) as DbRow[]).map((r) => {
      if (r.summary && typeof r.summary === 'string')
        try {
          r.summary = JSON.parse(r.summary) as unknown;
        } catch {
          /* */
        }
      return r;
    });
  }

  /** Get timeline snapshots in a date range. */
  getTimelineSnapshotRange(from: string, to: string): DbRow[] {
    return (this._stmts.getTimelineSnapshotRange.all(from, to) as DbRow[]).map((r) => {
      if (r.summary && typeof r.summary === 'string')
        try {
          r.summary = JSON.parse(r.summary) as unknown;
        } catch {
          /* */
        }
      return r;
    });
  }

  /** Get full snapshot data by ID (all entities). */
  getTimelineSnapshotFull(snapshotId: number) {
    const snap = this._stmts.getTimelineSnapshotById.get(snapshotId) as DbRow | undefined;
    if (!snap) return null;
    if (snap.summary)
      try {
        snap.summary = JSON.parse(snap.summary as string);
      } catch {
        /* */
      }
    // Fan-out dedup (v25 structures, v26 backpacks/houses): if this snapshot's entity set was
    // unchanged from a prior keyframe, the *_ref_snapshot_id points at that keyframe — read
    // the rows from there. Graceful: if the keyframe was already pruned by retention, the
    // query just returns [] (the snapshot shows no rows rather than erroring).
    const structuresSnapId = (snap.structures_ref_snapshot_id as number | null) ?? snapshotId;
    const backpacksSnapId = (snap.backpacks_ref_snapshot_id as number | null) ?? snapshotId;
    const housesSnapId = (snap.houses_ref_snapshot_id as number | null) ?? snapshotId;
    return {
      snapshot: snap,
      // Players delta（v26）：keyframe 全名冊 + delta overlay 重建（見 _timelinePlayersAsOf）
      players: this._timelinePlayersAsOf(snapshotId),
      ai: this._stmts.getTimelineAI.all(snapshotId),
      vehicles: this._stmts.getTimelineVehicles.all(snapshotId),
      structures: this._stmts.getTimelineStructures.all(structuresSnapId),
      houses: this._stmts.getTimelineHouses.all(housesSnapId),
      companions: this._stmts.getTimelineCompanions.all(snapshotId),

      backpacks: (this._stmts.getTimelineBackpacks.all(backpacksSnapId) as DbRow[]).map((b) => {
        if (b.items_summary && typeof b.items_summary === 'string')
          try {
            b.items_summary = JSON.parse(b.items_summary) as unknown;
          } catch {
            /* */
          }
        return b;
      }),
    };
  }

  /**
   * 重建 snapshot T 當下的玩家全名冊（v26 players delta）。
   *
   * K = T 以內最新的 players_keyframe=1 snapshot（全名冊寫入）；讀 [K, T] 的
   * timeline_players 列按 snapshot_id 升冪做 overlay（後蓋前）。識別鍵與寫入端
   * SnapshotService._playerKey 同一把：steam_id 非空取 steam_id，否則取 name
   * （生產 legacy 列 steam_id 全空 —— 截至 v26 分析時 760k 列 —— 靠 name 相容）。
   *
   * 已知邊界（deliberate）：wiped 玩家（被 admin 從存檔移除）在 K 之後的 delta
   * 不會再出現，但 K 的名冊仍含他 —— 幽靈窗至多一個 keyframe 週期
   * （KEYFRAME_EVERY=12 tick ≈ 1hr），下一個 keyframe 起消失。
   *
   * 防禦 fallback：找不到 K（理論上不會 —— migration 把歷史 snapshot 全標
   * keyframe、重啟第一 tick 必寫 keyframe、purge 保護最舊基準）時退回只讀
   * snapshot 自身的列。
   */
  private _timelinePlayersAsOf(snapshotId: number): DbRow[] {
    const kf = this._stmts.getTimelinePlayersKeyframe.get(snapshotId) as { id?: number } | undefined;
    const fromId = kf?.id ?? snapshotId;
    const rows = this._stmts.getTimelinePlayersRange.all(fromId, snapshotId) as DbRow[];
    const byKey = new Map<string, DbRow>();
    for (const r of rows) byKey.set((r.steam_id as string) || (r.name as string) || '', r);
    return [...byKey.values()];
  }

  getLatestTimelineSnapshotId(): number | null {
    const row = this._stmts.getLatestTimelineSnapshotId.get() as { id?: number } | undefined;
    return row?.id ?? null;
  }

  getTimelineAIForMap(snapshotId: number) {
    return this._stmts.getTimelineAIForMap.all(snapshotId);
  }

  /** Get timeline bounds (earliest, latest, count). */
  getTimelineBounds() {
    return this._stmts.getTimelineSnapshotBounds.get();
  }

  /** Get player position history for trails. */
  getPlayerPositionHistory(steamId: string, from: string, to: string) {
    return this._stmts.getPlayerPositionHistory.all(steamId, from, to);
  }

  /** Get AI population history for charts. */
  getAIPopulationHistory(from: string, to: string) {
    return this._stmts.getAIPopulationHistory.all(from, to);
  }

  /**
   * Purge old timeline data (default: keep 7 days). Keeps keyframes still referenced by a
   * retained snapshot (structures/backpacks/houses dedup refs).
   *
   * v26：分批刪除（每批預設 500 個 snapshot），批間讓出 event loop —— 停機補跑時
   * 單刀 DELETE + 7 張子表 ON DELETE CASCADE 實測可同步阻塞數十秒。
   * 回傳 { changes: 總刪除 snapshot 數 }，維持舊呼叫端的 result.changes 形狀。
   */
  async purgeOldTimeline(olderThan: string = '-7 days', batchSize: number = 500): Promise<{ changes: number }> {
    // batchSize 防護：0 / 負數 / NaN / Infinity 會讓「changes < batchSize」永不成立 → 無限迴圈
    const batch = Number.isFinite(batchSize) && Math.trunc(batchSize) > 0 ? Math.trunc(batchSize) : 500;
    let total = 0;
    for (;;) {
      // shutdown 競態：批間讓出 event loop 時 close() 可能已跑完 —— 靜默停止而非丟例外
      if (!this._handle.open) break;
      const { changes } = this._stmts.purgeOldTimelineBatch.run(
        olderThan,
        olderThan,
        olderThan,
        olderThan,
        olderThan,
        batch,
      );
      total += changes;
      if (changes < batch) break;
      await yieldToEventLoop();
    }
    return { changes: total };
  }
}
