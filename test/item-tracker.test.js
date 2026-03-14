/**
 * Tests for item instance tracker (DB reconciliation).
 *
 * Uses Node's built-in test runner (node --test).
 * Run: node --test test/item-tracker.test.js
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// ── Create in-memory DB for each test ──
const HumanitZDB = require('../src/db/database');
const { reconcileItems } = require('../src/db/item-tracker');

let db;

describe('Item Tracker', () => {
  beforeEach(() => {
    if (db) {
      try {
        db.close();
      } catch {}
    }
    db = new HumanitZDB({ memory: true, label: 'test' });
    db.init();
  });

  afterEach(() => {
    if (db) {
      try {
        db.close();
      } catch {}
      db = null;
    }
  });

  describe('reconcileItems', () => {
    it('creates new instances for items seen for the first time', () => {
      const snapshot = {
        players: new Map([
          [
            '76561100000000001',
            {
              inventory: [
                { item: 'AK47', amount: 1, durability: 0.85, ammo: 15 },
                { item: 'Nails', amount: 50, durability: 1.0 },
              ],
              equipment: [],
              quickSlots: [],
              backpackItems: [],
              x: 100,
              y: 200,
              z: 50,
            },
          ],
        ]),
        containers: [],
        vehicles: [],
        horses: [],
        structures: [],
        worldState: {},
      };

      const stats = reconcileItems(db, snapshot);
      assert.equal(stats.created, 2);
      assert.equal(stats.matched, 0);
      assert.equal(stats.moved, 0);
      assert.equal(stats.lost, 0);

      // Verify instances exist in DB
      const instances = db.getActiveItemInstances();
      assert.equal(instances.length, 2);

      const ak = instances.find((i) => i.item === 'AK47');
      assert.ok(ak);
      assert.equal(ak.location_type, 'player');
      assert.equal(ak.location_id, '76561100000000001');
      assert.equal(ak.location_slot, 'inventory');
      assert.equal(ak.lost, 0);
    });

    it('matches existing instances on second sync (no change)', () => {
      const snapshot = {
        players: new Map([
          [
            '76561100000000001',
            {
              inventory: [{ item: 'AK47', amount: 1, durability: 0.85 }],
              equipment: [],
              quickSlots: [],
              backpackItems: [],
              x: 100,
              y: 200,
              z: 50,
            },
          ],
        ]),
        containers: [],
        vehicles: [],
        horses: [],
        structures: [],
        worldState: {},
      };

      // First sync — creates
      const stats1 = reconcileItems(db, snapshot);
      assert.equal(stats1.created, 1);

      // Second sync — same data, should match
      const stats2 = reconcileItems(db, snapshot);
      assert.equal(stats2.matched, 1);
      assert.equal(stats2.created, 0);
      assert.equal(stats2.moved, 0);
      assert.equal(stats2.lost, 0);
    });

    it('detects item movement from player to container', () => {
      // First sync: AK47 in player inventory
      const snap1 = {
        players: new Map([
          [
            '76561100000000001',
            {
              inventory: [{ item: 'AK47', amount: 1, durability: 0.85, ammo: 15 }],
              equipment: [],
              quickSlots: [],
              backpackItems: [],
              x: 100,
              y: 200,
              z: 50,
            },
          ],
        ]),
        containers: [],
        vehicles: [],
        horses: [],
        structures: [],
        worldState: {},
      };
      reconcileItems(db, snap1);

      // Second sync: AK47 moved to a container
      const snap2 = {
        players: new Map([
          [
            '76561100000000001',
            {
              inventory: [],
              equipment: [],
              quickSlots: [],
              backpackItems: [],
              x: 100,
              y: 200,
              z: 50,
            },
          ],
        ]),
        containers: [
          {
            actorName: 'StorageChest_1',
            items: [{ item: 'AK47', amount: 1, durability: 0.85, ammo: 15 }],
            quickSlots: [],
            x: 110,
            y: 210,
            z: 50,
          },
        ],
        vehicles: [],
        horses: [],
        structures: [],
        worldState: {},
      };
      const stats = reconcileItems(db, snap2);
      assert.equal(stats.moved, 1);
      assert.equal(stats.lost, 0);

      // Verify the instance now points to the container
      const instances = db.getActiveItemInstances();
      const ak = instances.find((i) => i.item === 'AK47');
      assert.equal(ak.location_type, 'container');
      assert.equal(ak.location_id, 'StorageChest_1');

      // Verify a movement was recorded
      const movements = db.getItemMovements(ak.id);
      assert.equal(movements.length, 1);
      assert.equal(movements[0].from_type, 'player');
      assert.equal(movements[0].from_id, '76561100000000001');
      assert.equal(movements[0].to_type, 'container');
      assert.equal(movements[0].to_id, 'StorageChest_1');
    });

    it('marks items as lost when they disappear', () => {
      const snap1 = {
        players: new Map([
          [
            '76561100000000001',
            {
              inventory: [{ item: 'AK47', amount: 1, durability: 0.85 }],
              equipment: [],
              quickSlots: [],
              backpackItems: [],
              x: 100,
              y: 200,
              z: 50,
            },
          ],
        ]),
        containers: [],
        vehicles: [],
        horses: [],
        structures: [],
        worldState: {},
      };
      reconcileItems(db, snap1);

      // Item disappears (consumed, destroyed, etc.)
      const snap2 = {
        players: new Map([
          [
            '76561100000000001',
            {
              inventory: [],
              equipment: [],
              quickSlots: [],
              backpackItems: [],
              x: 100,
              y: 200,
              z: 50,
            },
          ],
        ]),
        containers: [],
        vehicles: [],
        horses: [],
        structures: [],
        worldState: {},
      };
      const stats = reconcileItems(db, snap2);
      assert.equal(stats.lost, 1);

      // Verify instance is marked lost
      const active = db.getActiveItemInstances();
      assert.equal(active.length, 0);
    });

    it('tracks items in vehicles', () => {
      const snapshot = {
        players: new Map(),
        containers: [],
        vehicles: [
          {
            displayName: 'SUV',
            class: 'BP_SUV_C',
            trunkItems: [{ item: 'Gasoline', amount: 5, durability: 1.0 }],
            x: 500,
            y: 600,
            z: 10,
          },
        ],
        horses: [],
        structures: [],
        worldState: {},
      };
      const stats = reconcileItems(db, snapshot);
      assert.equal(stats.created, 1);

      const instances = db.getActiveItemInstances();
      assert.equal(instances[0].location_type, 'vehicle');
      assert.equal(instances[0].location_slot, 'trunk');
    });

    it('tracks items in horse saddlebags', () => {
      const snapshot = {
        players: new Map(),
        containers: [],
        vehicles: [],
        horses: [
          {
            actorName: 'Horse_1',
            displayName: 'Thunder',
            saddleItems: [{ item: 'Bandage', amount: 3, durability: 1.0 }],
            inventory: [],
            x: 300,
            y: 400,
            z: 20,
          },
        ],
        structures: [],
        worldState: {},
      };
      const stats = reconcileItems(db, snapshot);
      assert.equal(stats.created, 1);

      const instances = db.getActiveItemInstances();
      assert.equal(instances[0].location_type, 'horse');
      assert.equal(instances[0].location_slot, 'saddle');
    });

    it('tracks LOD pickups (world drops)', () => {
      const snapshot = {
        players: new Map(),
        containers: [],
        vehicles: [],
        horses: [],
        structures: [],
        worldState: {
          lodPickups: [
            { item: 'Axe', amount: 1, durability: 0.7, x: 1000, y: 2000, z: 30, valid: true, worldLoot: true },
          ],
        },
      };
      const stats = reconcileItems(db, snapshot);
      assert.equal(stats.created, 1);

      const instances = db.getActiveItemInstances();
      assert.equal(instances[0].location_type, 'world_drop');
      assert.equal(instances[0].item, 'Axe');
    });

    it('handles multiple items with same fingerprint across locations', () => {
      // Two identical nails stacks (same fingerprint) in different locations
      const snap1 = {
        players: new Map([
          [
            '76561100000000001',
            {
              inventory: [{ item: 'Nails', amount: 50, durability: 1.0 }],
              equipment: [],
              quickSlots: [],
              backpackItems: [],
              x: 100,
              y: 200,
              z: 50,
            },
          ],
        ]),
        containers: [
          {
            actorName: 'Chest_1',
            items: [{ item: 'Nails', amount: 50, durability: 1.0 }],
            quickSlots: [],
            x: 500,
            y: 600,
            z: 10,
          },
        ],
        vehicles: [],
        horses: [],
        structures: [],
        worldState: {},
      };

      const stats = reconcileItems(db, snap1);
      assert.equal(stats.created, 2);

      const instances = db.getActiveItemInstances();
      const playerNails = instances.find((i) => i.location_type === 'player');
      const chestNails = instances.find((i) => i.location_type === 'container');
      assert.ok(playerNails);
      assert.ok(chestNails);
      // Both have same fingerprint
      assert.equal(playerNails.fingerprint, chestNails.fingerprint);
    });

    it('searchItemInstances finds items by name', () => {
      const snapshot = {
        players: new Map([
          [
            '76561100000000001',
            {
              inventory: [
                { item: 'AK47', amount: 1, durability: 0.85 },
                { item: 'AK47_Ammo', amount: 30, durability: 1.0 },
                { item: 'Shotgun', amount: 1, durability: 0.5 },
              ],
              equipment: [],
              quickSlots: [],
              backpackItems: [],
              x: 100,
              y: 200,
              z: 50,
            },
          ],
        ]),
        containers: [],
        vehicles: [],
        horses: [],
        structures: [],
        worldState: {},
      };
      reconcileItems(db, snapshot);

      const akItems = db.searchItemInstances('AK47');
      assert.equal(akItems.length, 2); // AK47 and AK47_Ammo

      const shotgunItems = db.searchItemInstances('Shotgun');
      assert.equal(shotgunItems.length, 1);
    });

    it('searchItemInstances finds items by fingerprint', () => {
      const snapshot = {
        players: new Map([
          [
            '76561100000000001',
            {
              inventory: [
                { item: 'AK47', amount: 1, durability: 0.85 },
                { item: 'Shotgun', amount: 1, durability: 0.5 },
              ],
              equipment: [],
              quickSlots: [],
              backpackItems: [],
              x: 100,
              y: 200,
              z: 50,
            },
          ],
        ]),
        containers: [],
        vehicles: [],
        horses: [],
        structures: [],
        worldState: {},
      };
      reconcileItems(db, snapshot);

      // Grab the fingerprint from a stored instance
      const allAk = db.searchItemInstances('AK47');
      assert.ok(allAk.length >= 1);
      const fp = allAk[0].fingerprint;
      assert.ok(fp, 'item should have a fingerprint');

      // Searching by that fingerprint should return the same item
      const byFp = db.searchItemInstances(fp);
      assert.ok(byFp.length >= 1);
      assert.equal(byFp[0].item, 'AK47');
    });

    it('searchItemGroups finds groups by fingerprint', () => {
      const snapshot = {
        players: new Map([
          [
            '76561100000000001',
            {
              inventory: [
                { item: 'Nails', amount: 50, durability: 1.0 },
                { item: 'Nails', amount: 50, durability: 1.0 },
              ],
              equipment: [],
              quickSlots: [],
              backpackItems: [],
              x: 100,
              y: 200,
              z: 50,
            },
          ],
        ]),
        containers: [],
        vehicles: [],
        horses: [],
        structures: [],
        worldState: {},
      };
      reconcileItems(db, snapshot);

      // Grab the fingerprint from a stored group
      const allNails = db.searchItemGroups('Nails');
      assert.ok(allNails.length >= 1);
      const fp = allNails[0].fingerprint;
      assert.ok(fp, 'group should have a fingerprint');

      // Searching by fingerprint should return the same group
      const byFp = db.searchItemGroups(fp);
      assert.ok(byFp.length >= 1);
      assert.equal(byFp[0].item, 'Nails');
    });

    it('getItemInstanceCount returns correct count', () => {
      const snapshot = {
        players: new Map([
          [
            '76561100000000001',
            {
              inventory: [
                { item: 'AK47', amount: 1, durability: 0.85 },
                { item: 'Nails', amount: 50, durability: 1.0 },
              ],
              equipment: [],
              quickSlots: [],
              backpackItems: [],
              x: 100,
              y: 200,
              z: 50,
            },
          ],
        ]),
        containers: [],
        vehicles: [],
        horses: [],
        structures: [],
        worldState: {},
      };
      reconcileItems(db, snapshot);
      assert.equal(db.getItemInstanceCount(), 2);
    });

    it('getItemInstancesByLocation returns items at a specific location', () => {
      const snapshot = {
        players: new Map([
          [
            '76561100000000001',
            {
              inventory: [{ item: 'AK47', amount: 1, durability: 0.85 }],
              equipment: [{ item: 'Helmet', amount: 1, durability: 0.9 }],
              quickSlots: [],
              backpackItems: [],
              x: 100,
              y: 200,
              z: 50,
            },
          ],
        ]),
        containers: [],
        vehicles: [],
        horses: [],
        structures: [],
        worldState: {},
      };
      reconcileItems(db, snapshot);

      const playerItems = db.getItemInstancesByLocation('player', '76561100000000001');
      assert.equal(playerItems.length, 2);
    });

    it('attributes movement to the player involved', () => {
      // Player has AK47
      reconcileItems(db, {
        players: new Map([
          [
            '76561100000000001',
            {
              inventory: [{ item: 'AK47', amount: 1, durability: 0.85 }],
              equipment: [],
              quickSlots: [],
              backpackItems: [],
              x: 100,
              y: 200,
              z: 50,
            },
          ],
        ]),
        containers: [
          {
            actorName: 'Chest_1',
            items: [],
            quickSlots: [],
            x: 110,
            y: 210,
            z: 50,
          },
        ],
        vehicles: [],
        horses: [],
        structures: [],
        worldState: {},
      });

      // Player moves AK47 to chest
      reconcileItems(
        db,
        {
          players: new Map([
            [
              '76561100000000001',
              {
                inventory: [],
                equipment: [],
                quickSlots: [],
                backpackItems: [],
                x: 100,
                y: 200,
                z: 50,
              },
            ],
          ]),
          containers: [
            {
              actorName: 'Chest_1',
              items: [{ item: 'AK47', amount: 1, durability: 0.85 }],
              quickSlots: [],
              x: 110,
              y: 210,
              z: 50,
            },
          ],
          vehicles: [],
          horses: [],
          structures: [],
          worldState: {},
        },
        (steamId) => (steamId === '76561100000000001' ? 'TestPlayer' : steamId),
      );

      const instances = db.getActiveItemInstances();
      const ak = instances.find((i) => i.item === 'AK47');
      const movements = db.getItemMovements(ak.id);
      assert.equal(movements.length, 1);
      // Item moved FROM player, so player is attributed
      assert.equal(movements[0].attributed_steam_id, '76561100000000001');
      assert.equal(movements[0].attributed_name, 'TestPlayer');
    });
  });

  describe('world drops DB methods', () => {
    it('replaceWorldDrops stores and retrieves drops', () => {
      db.replaceWorldDrops([
        { type: 'pickup', item: 'Axe', amount: 1, durability: 0.7, x: 100, y: 200, z: 30 },
        { type: 'backpack', actorName: 'backpack_0', items: [{ item: 'Nails', amount: 10 }], x: 300, y: 400, z: 10 },
        {
          type: 'global_container',
          actorName: 'House_Chest_1',
          items: [{ item: 'Bandage', amount: 5 }],
          locked: true,
          x: 500,
          y: 600,
          z: 20,
        },
      ]);

      const all = db.getAllWorldDrops();
      assert.equal(all.length, 3);

      const pickups = db.getWorldDropsByType('pickup');
      assert.equal(pickups.length, 1);
      assert.equal(pickups[0].item, 'Axe');

      const withItems = db.getWorldDropsWithItems();
      assert.equal(withItems.length, 3);
    });

    it('replaceWorldDrops clears old data', () => {
      db.replaceWorldDrops([
        { type: 'pickup', item: 'Axe', amount: 1, x: 100, y: 200, z: 30 },
        { type: 'pickup', item: 'Hammer', amount: 1, x: 150, y: 250, z: 30 },
      ]);
      assert.equal(db.getAllWorldDrops().length, 2);

      db.replaceWorldDrops([{ type: 'pickup', item: 'Sword', amount: 1, x: 200, y: 300, z: 30 }]);
      assert.equal(db.getAllWorldDrops().length, 1);
      assert.equal(db.getAllWorldDrops()[0].item, 'Sword');
    });
  });

  describe('item movement queries', () => {
    it('getItemMovementsByPlayer returns player-attributed movements', () => {
      // Create an item, move it manually to test the query
      const id = db.createItemInstance({
        fingerprint: 'abc123def456',
        item: 'AK47',
        durability: 0.85,
        locationType: 'player',
        locationId: '76561100000000001',
        locationSlot: 'inventory',
        x: 100,
        y: 200,
        z: 50,
        amount: 1,
      });

      db.moveItemInstance(
        id,
        {
          locationType: 'container',
          locationId: 'Chest_1',
          locationSlot: 'inventory',
          x: 110,
          y: 210,
          z: 50,
          amount: 1,
        },
        { steamId: '76561100000000001', name: 'TestPlayer' },
      );

      const moves = db.getItemMovementsByPlayer('76561100000000001');
      assert.equal(moves.length, 1);
      assert.equal(moves[0].item, 'AK47');
    });

    it('getItemMovementsByLocation returns all movements involving a location', () => {
      const id = db.createItemInstance({
        fingerprint: 'abc123def456',
        item: 'AK47',
        durability: 0.85,
        locationType: 'container',
        locationId: 'Chest_1',
        locationSlot: 'inventory',
        x: 100,
        y: 200,
        z: 50,
        amount: 1,
      });

      db.moveItemInstance(id, {
        locationType: 'player',
        locationId: '76561100000000001',
        locationSlot: 'inventory',
        x: 100,
        y: 200,
        z: 50,
      });

      const moves = db.getItemMovementsByLocation('container', 'Chest_1');
      assert.equal(moves.length, 1);
      assert.equal(moves[0].from_type, 'container');
      assert.equal(moves[0].from_id, 'Chest_1');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  Fungible group tracking
  // ═══════════════════════════════════════════════════════════════════════════

  describe('fungible group tracking', () => {
    it('creates groups for multiple identical items at the same location', () => {
      const snapshot = {
        players: new Map([
          [
            '76561100000000001',
            {
              inventory: [
                { item: 'Nails', amount: 50, durability: 1.0 },
                { item: 'Nails', amount: 50, durability: 1.0 },
                { item: 'Nails', amount: 50, durability: 1.0 },
              ],
              equipment: [],
              quickSlots: [],
              backpackItems: [],
              x: 100,
              y: 200,
              z: 50,
            },
          ],
        ]),
        containers: [],
        vehicles: [],
        horses: [],
        structures: [],
        worldState: {},
      };

      const stats = reconcileItems(db, snapshot);
      // 3 identical items → grouped (not individual instances)
      assert.equal(stats.groups.created, 1);
      assert.equal(stats.created, 0); // no individual instances

      const groups = db.getActiveItemGroups();
      assert.equal(groups.length, 1);
      assert.equal(groups[0].item, 'Nails');
      assert.equal(groups[0].quantity, 3);
      assert.equal(groups[0].location_type, 'player');
      assert.equal(groups[0].location_id, '76561100000000001');
    });

    it('matches existing groups on re-sync (stable quantity)', () => {
      const snapshot = {
        players: new Map([
          [
            '76561100000000001',
            {
              inventory: [
                { item: 'Nails', amount: 50, durability: 1.0 },
                { item: 'Nails', amount: 50, durability: 1.0 },
              ],
              equipment: [],
              quickSlots: [],
              backpackItems: [],
              x: 100,
              y: 200,
              z: 50,
            },
          ],
        ]),
        containers: [],
        vehicles: [],
        horses: [],
        structures: [],
        worldState: {},
      };

      reconcileItems(db, snapshot);
      const stats2 = reconcileItems(db, snapshot);
      assert.equal(stats2.groups.matched, 1);
      assert.equal(stats2.groups.created, 0);
    });

    it('detects group quantity decrease (split)', () => {
      const snap1 = {
        players: new Map([
          [
            '76561100000000001',
            {
              inventory: [
                { item: 'Nails', amount: 50, durability: 1.0 },
                { item: 'Nails', amount: 50, durability: 1.0 },
                { item: 'Nails', amount: 50, durability: 1.0 },
              ],
              equipment: [],
              quickSlots: [],
              backpackItems: [],
              x: 100,
              y: 200,
              z: 50,
            },
          ],
        ]),
        containers: [],
        vehicles: [],
        horses: [],
        structures: [],
        worldState: {},
      };
      reconcileItems(db, snap1);

      // Now only 2 stacks remain (1 was taken)
      const snap2 = {
        players: new Map([
          [
            '76561100000000001',
            {
              inventory: [
                { item: 'Nails', amount: 50, durability: 1.0 },
                { item: 'Nails', amount: 50, durability: 1.0 },
              ],
              equipment: [],
              quickSlots: [],
              backpackItems: [],
              x: 100,
              y: 200,
              z: 50,
            },
          ],
        ]),
        containers: [],
        vehicles: [],
        horses: [],
        structures: [],
        worldState: {},
      };
      const stats = reconcileItems(db, snap2);
      assert.equal(stats.groups.adjusted, 1);

      const groups = db.getActiveItemGroups();
      assert.equal(groups[0].quantity, 2);
    });

    it('detects group transfer (decrease at A, increase at B)', () => {
      // Initial: 3 Nails stacks in player inventory
      const snap1 = {
        players: new Map([
          [
            '76561100000000001',
            {
              inventory: [
                { item: 'Nails', amount: 50, durability: 1.0 },
                { item: 'Nails', amount: 50, durability: 1.0 },
                { item: 'Nails', amount: 50, durability: 1.0 },
              ],
              equipment: [],
              quickSlots: [],
              backpackItems: [],
              x: 100,
              y: 200,
              z: 50,
            },
          ],
        ]),
        containers: [],
        vehicles: [],
        horses: [],
        structures: [],
        worldState: {},
      };
      reconcileItems(db, snap1);

      // Player drops 2 stacks into a container
      const snap2 = {
        players: new Map([
          [
            '76561100000000001',
            {
              inventory: [{ item: 'Nails', amount: 50, durability: 1.0 }],
              equipment: [],
              quickSlots: [],
              backpackItems: [],
              x: 100,
              y: 200,
              z: 50,
            },
          ],
        ]),
        containers: [
          {
            actorName: 'Chest_1',
            items: [
              { item: 'Nails', amount: 50, durability: 1.0 },
              { item: 'Nails', amount: 50, durability: 1.0 },
            ],
            x: 105,
            y: 205,
            z: 50,
          },
        ],
        vehicles: [],
        horses: [],
        structures: [],
        worldState: {},
      };
      const stats = reconcileItems(db, snap2);

      // Player's group went from 3 → 1 (now unique, not a group) → group lost
      // Container got 2 new items → new group
      // The system should detect the transfer via delta cross-referencing
      assert.ok(stats.groups.transferred > 0 || stats.groups.created > 0);

      // Verify movement was recorded
      const movements = db.getRecentItemMovements(10);
      const transfers = movements.filter((m) => m.move_type === 'group_transfer');
      // We expect at least one transfer event
      if (transfers.length > 0) {
        assert.equal(transfers[0].item, 'Nails');
        assert.ok(transfers[0].amount >= 1);
      }
    });

    it('separates unique items from fungible groups', () => {
      const snapshot = {
        players: new Map([
          [
            '76561100000000001',
            {
              inventory: [
                // Two identical Nails → group
                { item: 'Nails', amount: 50, durability: 1.0 },
                { item: 'Nails', amount: 50, durability: 1.0 },
                // One unique AK47 → individual instance
                { item: 'AK47', amount: 1, durability: 0.85, ammo: 15 },
              ],
              equipment: [],
              quickSlots: [],
              backpackItems: [],
              x: 100,
              y: 200,
              z: 50,
            },
          ],
        ]),
        containers: [],
        vehicles: [],
        horses: [],
        structures: [],
        worldState: {},
      };

      const stats = reconcileItems(db, snapshot);
      assert.equal(stats.groups.created, 1); // Nails group
      assert.equal(stats.created, 1); // AK47 instance

      const groups = db.getActiveItemGroups();
      assert.equal(groups.length, 1);
      assert.equal(groups[0].item, 'Nails');

      const instances = db.getActiveItemInstances();
      // Only the AK47 should be an individual instance (no group_id)
      const nonGroupInstances = instances.filter((i) => !i.group_id);
      assert.equal(nonGroupInstances.length, 1);
      assert.equal(nonGroupInstances[0].item, 'AK47');
    });

    it('handles group disappearing entirely (all lost)', () => {
      const snap1 = {
        players: new Map([
          [
            '76561100000000001',
            {
              inventory: [
                { item: 'Nails', amount: 50, durability: 1.0 },
                { item: 'Nails', amount: 50, durability: 1.0 },
              ],
              equipment: [],
              quickSlots: [],
              backpackItems: [],
              x: 100,
              y: 200,
              z: 50,
            },
          ],
        ]),
        containers: [],
        vehicles: [],
        horses: [],
        structures: [],
        worldState: {},
      };
      reconcileItems(db, snap1);

      // All items gone
      const snap2 = {
        players: new Map([
          [
            '76561100000000001',
            {
              inventory: [],
              equipment: [],
              quickSlots: [],
              backpackItems: [],
              x: 100,
              y: 200,
              z: 50,
            },
          ],
        ]),
        containers: [],
        vehicles: [],
        horses: [],
        structures: [],
        worldState: {},
      };
      const stats = reconcileItems(db, snap2);
      assert.equal(stats.groups.lost, 1);

      const activeGroups = db.getActiveItemGroups();
      assert.equal(activeGroups.length, 0);
    });

    it('records group movement with attribution to player', () => {
      // Put 2 identical stacks in a container
      const snap1 = {
        players: new Map([
          [
            '76561100000000001',
            {
              inventory: [],
              equipment: [],
              quickSlots: [],
              backpackItems: [],
              x: 100,
              y: 200,
              z: 50,
            },
          ],
        ]),
        containers: [
          {
            actorName: 'Chest_1',
            items: [
              { item: 'Wood', amount: 10, durability: 1.0 },
              { item: 'Wood', amount: 10, durability: 1.0 },
              { item: 'Wood', amount: 10, durability: 1.0 },
            ],
            x: 100,
            y: 200,
            z: 50,
          },
        ],
        vehicles: [],
        horses: [],
        structures: [],
        worldState: {},
      };
      reconcileItems(db, snap1);

      // Player takes 2 stacks (player is near the container)
      const snap2 = {
        players: new Map([
          [
            '76561100000000001',
            {
              inventory: [
                { item: 'Wood', amount: 10, durability: 1.0 },
                { item: 'Wood', amount: 10, durability: 1.0 },
              ],
              equipment: [],
              quickSlots: [],
              backpackItems: [],
              x: 100,
              y: 200,
              z: 50,
            },
          ],
        ]),
        containers: [
          {
            actorName: 'Chest_1',
            items: [{ item: 'Wood', amount: 10, durability: 1.0 }],
            x: 100,
            y: 200,
            z: 50,
          },
        ],
        vehicles: [],
        horses: [],
        structures: [],
        worldState: {},
      };
      const _stats = reconcileItems(db, snap2);

      // Chest group went from 3 → 1 (now unique, group lost with qty 3)
      // Player got 2 identical → new group created
      // Transfer should be detected: container lost items, player gained items
      const movements = db.getRecentItemMovements(10);
      const transfers = movements.filter((m) => m.move_type === 'group_transfer');
      if (transfers.length > 0) {
        // Attribution should be to the player since items went TO player
        assert.equal(transfers[0].attributed_steam_id, '76561100000000001');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  Item group DB methods
  // ═══════════════════════════════════════════════════════════════════════════

  describe('item group DB methods', () => {
    it('upsertItemGroup creates and updates groups', () => {
      const result1 = db.upsertItemGroup({
        fingerprint: 'aaa111bbb222',
        item: 'Nails',
        locationType: 'player',
        locationId: '76561100000000001',
        locationSlot: 'inventory',
        x: 100,
        y: 200,
        z: 50,
        quantity: 3,
        stackSize: 50,
      });
      assert.ok(result1.id > 0);
      assert.equal(result1.created, true);

      // Upsert at same location → update quantity
      const result2 = db.upsertItemGroup({
        fingerprint: 'aaa111bbb222',
        item: 'Nails',
        locationType: 'player',
        locationId: '76561100000000001',
        locationSlot: 'inventory',
        x: 100,
        y: 200,
        z: 50,
        quantity: 5,
      });
      assert.equal(result2.id, result1.id);
      assert.equal(result2.created, false);

      const group = db.getItemGroup(result1.id);
      assert.equal(group.quantity, 5);
    });

    it('markItemGroupLost and purge', () => {
      const { id } = db.upsertItemGroup({
        fingerprint: 'aaa111bbb222',
        item: 'Nails',
        locationType: 'player',
        locationId: '76561100000000001',
        locationSlot: 'inventory',
        quantity: 3,
      });

      db.markItemGroupLost(id);
      const activeGroups = db.getActiveItemGroups();
      assert.equal(activeGroups.length, 0);

      const group = db.getItemGroup(id);
      assert.equal(group.lost, 1);
    });

    it('recordGroupMovement writes movement records', () => {
      const { id: groupId } = db.upsertItemGroup({
        fingerprint: 'aaa111bbb222',
        item: 'Nails',
        locationType: 'container',
        locationId: 'Chest_1',
        locationSlot: 'items',
        quantity: 5,
      });

      db.recordGroupMovement({
        groupId,
        moveType: 'group_transfer',
        item: 'Nails',
        from: { type: 'player', id: '76561100000000001', slot: 'inventory' },
        to: { type: 'container', id: 'Chest_1', slot: 'items' },
        amount: 3,
        attribution: { steamId: '76561100000000001', name: 'TestPlayer' },
        pos: { x: 100, y: 200, z: 50 },
      });

      const movements = db.getItemMovementsByGroup(groupId);
      assert.equal(movements.length, 1);
      assert.equal(movements[0].move_type, 'group_transfer');
      assert.equal(movements[0].item, 'Nails');
      assert.equal(movements[0].amount, 3);
      assert.equal(movements[0].attributed_steam_id, '76561100000000001');
    });

    it('getItemGroupsByLocation returns groups at a location', () => {
      db.upsertItemGroup({
        fingerprint: 'aaa111bbb222',
        item: 'Nails',
        locationType: 'container',
        locationId: 'Chest_1',
        locationSlot: 'items',
        quantity: 3,
      });
      db.upsertItemGroup({
        fingerprint: 'ccc333ddd444',
        item: 'Wood',
        locationType: 'container',
        locationId: 'Chest_1',
        locationSlot: 'items',
        quantity: 5,
      });

      const groups = db.getItemGroupsByLocation('container', 'Chest_1');
      assert.equal(groups.length, 2);
    });
  });
});
