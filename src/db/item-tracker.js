/**
 * Item Tracker — reconciles save snapshots against the DB to track item movements.
 *
 * ## Dual-track system: Unique items vs Fungible groups
 *
 * Items with unique fingerprints (weapons with specific durability, items with
 * attachments, etc.) are tracked as individual *instances* in `item_instances`.
 * When a unique item moves from container A to player B, we detect the movement
 * and record chain-of-custody.
 *
 * Fungible items — multiple items sharing the same fingerprint at the same
 * location (e.g. 3 stacks of Nails all at durability 1.0) — are tracked as
 * counted *groups* in `item_groups`. Each group is keyed by
 * (fingerprint, location_type, location_id, location_slot). When the count
 * decreases at location A and increases at location B for the same fingerprint,
 * we detect a group transfer and record it.
 *
 * When an item leaves a group, it gets its own instance if it moves to a
 * location where no matching group exists. When it arrives at a location that
 * already has a matching group, it assimilates (group quantity increases).
 *
 * @module item-tracker
 */

const { normalizeInventory } = require('./item-fingerprint');

/**
 * Full reconciliation pass — compares current save state against DB.
 *
 * @param {import('./database')} db - Database instance
 * @param {object} snapshot - Parsed save data
 * @param {Function} [nameResolver] - (steamId) => playerName
 * @returns {{ matched: number, created: number, moved: number, lost: number, groups: { matched: number, created: number, adjusted: number, transferred: number, lost: number } }}
 */
function reconcileItems(db, snapshot, nameResolver) {
  const stats = {
    matched: 0,
    created: 0,
    moved: 0,
    lost: 0,
    groups: { matched: 0, created: 0, adjusted: 0, transferred: 0, lost: 0 },
  };

  // ── Collect all items from the current snapshot ──
  const currentItems = [];

  // Players
  if (snapshot.players) {
    for (const [steamId, data] of snapshot.players) {
      const slots = [
        ['inventory', data.inventory],
        ['equipment', data.equipment],
        ['quick_slots', data.quickSlots],
        ['backpack', data.backpackItems],
      ];
      for (const [slotName, items] of slots) {
        if (!items || items.length === 0) continue;
        _addLocationItems(currentItems, normalizeInventory(items), 'player', steamId, slotName, data);
      }
    }
  }

  // Containers
  if (snapshot.containers) {
    for (const c of snapshot.containers) {
      if (c.items?.length) {
        _addLocationItems(
          currentItems,
          normalizeInventory(c.items),
          'container',
          c.actorName || c.name || '',
          'items',
          c,
        );
      }
    }
  }

  // Vehicles
  if (snapshot.vehicles) {
    for (const v of snapshot.vehicles) {
      const slots = [
        ['inventory', v.inventory],
        ['trunk', v.trunkItems],
      ];
      for (const [slotName, items] of slots) {
        if (!items || items.length === 0) continue;
        _addLocationItems(currentItems, normalizeInventory(items), 'vehicle', v.actorName || v.name || '', slotName, v);
      }
    }
  }

  // Horses
  if (snapshot.horses) {
    for (const h of snapshot.horses) {
      if (h.saddleItems?.length) {
        _addLocationItems(
          currentItems,
          normalizeInventory(h.saddleItems),
          'horse',
          h.actorName || h.name || '',
          'saddle',
          h,
        );
      }
    }
  }

  // Structures (storage boxes, etc.)
  if (snapshot.structures) {
    for (const s of snapshot.structures) {
      if (s.inventory?.length) {
        _addLocationItems(
          currentItems,
          normalizeInventory(s.inventory),
          'structure',
          s.actorName || s.name || '',
          'items',
          s,
        );
      }
    }
  }

  // World drops (LOD pickups, backpacks, global containers)
  const ws = snapshot.worldState || {};
  if (ws.lodPickups) {
    for (const p of ws.lodPickups) {
      if (!p.item || p.item === 'None') continue;
      const posId = `pickup_${Math.round(p.x)}_${Math.round(p.y)}_${Math.round(p.z)}`;
      const normalized = normalizeInventory([p]);
      _addLocationItems(currentItems, normalized, 'world_drop', posId, 'ground', p);
    }
  }
  if (ws.droppedBackpacks) {
    for (const bp of ws.droppedBackpacks) {
      if (!bp.items?.length) continue;
      const posId = `backpack_${Math.round(bp.x)}_${Math.round(bp.y)}_${Math.round(bp.z)}`;
      _addLocationItems(currentItems, normalizeInventory(bp.items), 'backpack', posId, 'items', bp);
    }
  }
  if (ws.globalContainers) {
    for (const gc of ws.globalContainers) {
      if (!gc.items?.length) continue;
      _addLocationItems(
        currentItems,
        normalizeInventory(gc.items),
        'global_container',
        gc.actorName || '',
        'items',
        gc,
      );
    }
  }

  // ── Classify items: unique vs fungible ──
  // Build location-keyed groups: { locationKey → { fingerprint → [items] } }
  const locationGroups = new Map();
  for (const item of currentItems) {
    const locKey = `${item.locationType}|${item.locationId}|${item.locationSlot}`;
    if (!locationGroups.has(locKey)) locationGroups.set(locKey, new Map());
    const fpMap = locationGroups.get(locKey);
    if (!fpMap.has(item.fingerprint)) fpMap.set(item.fingerprint, []);
    fpMap.get(item.fingerprint).push(item);
  }

  // Separate into unique items (1 per fingerprint per location) and fungible groups (>1)
  const uniqueItems = [];
  const fungibleGroups = [];

  for (const [, fpMap] of locationGroups) {
    for (const [fingerprint, items] of fpMap) {
      if (items.length === 1) {
        uniqueItems.push(items[0]);
      } else {
        // Multiple identical items at same location = fungible group
        fungibleGroups.push({
          fingerprint,
          items,
          locationType: items[0].locationType,
          locationId: items[0].locationId,
          locationSlot: items[0].locationSlot,
          x: items[0].x,
          y: items[0].y,
          z: items[0].z,
          quantity: items.length,
          representative: items[0],
        });
      }
    }
  }

  // ── Phase 1: Reconcile unique items (individual instance tracking) ──
  _reconcileUniqueItems(db, uniqueItems, snapshot, nameResolver, stats);

  // ── Phase 2: Reconcile fungible groups ──
  _reconcileFungibleGroups(db, fungibleGroups, snapshot, nameResolver, stats);

  return stats;
}

/**
 * Reconcile unique items (items that have a unique fingerprint at their location).
 * Uses the classic 4-pass approach: exact match → fingerprint match → create → mark lost.
 */
function _reconcileUniqueItems(db, currentItems, snapshot, nameResolver, stats) {
  // Load all active (non-lost) instances from DB, indexed by fingerprint
  const existing = db.getActiveItemInstances();
  const existingByFP = new Map();
  for (const inst of existing) {
    // Skip instances that belong to a group (managed by group reconciliation)
    if (inst.group_id) continue;
    if (!existingByFP.has(inst.fingerprint)) existingByFP.set(inst.fingerprint, []);
    existingByFP.get(inst.fingerprint).push(inst);
  }

  // Pass 1: exact location + fingerprint match (item is still where it was)
  for (const ci of currentItems) {
    const candidates = existingByFP.get(ci.fingerprint);
    if (!candidates) continue;

    const exact = candidates.find(
      (c) =>
        !c._matched &&
        c.location_type === ci.locationType &&
        c.location_id === ci.locationId &&
        c.location_slot === ci.locationSlot,
    );
    if (exact) {
      exact._matched = true;
      ci._matchedInstanceId = exact.id;
      ci._matchType = 'exact';
      db.touchItemInstance(exact.id);
      stats.matched++;
    }
  }

  // Pass 2: fingerprint match (item moved)
  for (const ci of currentItems) {
    if (ci._matchedInstanceId) continue;

    const candidates = existingByFP.get(ci.fingerprint);
    if (!candidates) continue;

    const moved = candidates.find((c) => !c._matched);
    if (moved) {
      moved._matched = true;
      ci._matchedInstanceId = moved.id;
      ci._matchType = 'moved';

      const attribution = _attributeMovement(ci, moved, snapshot, nameResolver);
      db.moveItemInstance(
        moved.id,
        {
          locationType: ci.locationType,
          locationId: ci.locationId,
          locationSlot: ci.locationSlot,
          x: ci.x,
          y: ci.y,
          z: ci.z,
          amount: ci.amount,
          groupId: null,
        },
        attribution,
        'move',
      );

      stats.moved++;
    }
  }

  // Pass 3: create new instances for unmatched items
  for (const ci of currentItems) {
    if (ci._matchedInstanceId) continue;

    const id = db.createItemInstance({
      fingerprint: ci.fingerprint,
      item: ci.item,
      durability: ci.durability,
      ammo: ci.ammo,
      attachments: ci.attachments,
      cap: ci.cap,
      maxDur: ci.maxDur,
      locationType: ci.locationType,
      locationId: ci.locationId,
      locationSlot: ci.locationSlot,
      x: ci.x,
      y: ci.y,
      z: ci.z,
      amount: ci.amount,
      groupId: null,
    });
    ci._matchedInstanceId = id;
    stats.created++;
  }

  // Pass 4: mark unmatched existing instances as lost
  for (const candidates of existingByFP.values()) {
    for (const inst of candidates) {
      if (!inst._matched) {
        db.markItemLost(inst.id);
        stats.lost++;
      }
    }
  }
}

/**
 * Reconcile fungible groups — items with duplicate fingerprints at the same location.
 *
 * Strategy:
 *   1. For each current group, find/create a DB group at the same location
 *   2. Compare quantities: stable, increased (merge), decreased (split)
 *   3. Cross-reference decreases at one location with increases at another
 *      for the same fingerprint → transfer event
 */
function _reconcileFungibleGroups(db, currentGroups, snapshot, nameResolver, stats) {
  // Load all active groups, indexed by fingerprint
  const existingGroups = db.getActiveItemGroups();
  const existingByFP = new Map();
  for (const g of existingGroups) {
    if (!existingByFP.has(g.fingerprint)) existingByFP.set(g.fingerprint, []);
    existingByFP.get(g.fingerprint).push(g);
  }

  // Track delta changes per fingerprint for cross-referencing transfers
  const deltas = new Map();

  // ── Match current groups to existing groups ──
  for (const cg of currentGroups) {
    const rep = cg.representative;
    const existingList = existingByFP.get(cg.fingerprint) || [];

    // Find exact location match
    const exact = existingList.find(
      (g) =>
        !g._matched &&
        g.location_type === cg.locationType &&
        g.location_id === cg.locationId &&
        g.location_slot === cg.locationSlot,
    );

    if (exact) {
      exact._matched = true;
      cg._matchedGroupId = exact.id;

      const oldQty = exact.quantity;
      const newQty = cg.quantity;

      if (oldQty === newQty) {
        // Stable — just touch
        db.touchItemGroup(exact.id);
        stats.groups.matched++;
      } else {
        // Quantity changed — update and track delta
        db.updateItemGroupQuantity(exact.id, newQty);
        stats.groups.adjusted++;

        if (!deltas.has(cg.fingerprint)) deltas.set(cg.fingerprint, { increases: [], decreases: [] });
        const delta = deltas.get(cg.fingerprint);
        if (newQty > oldQty) {
          delta.increases.push({
            groupId: exact.id,
            amount: newQty - oldQty,
            locationType: cg.locationType,
            locationId: cg.locationId,
            locationSlot: cg.locationSlot,
            x: cg.x,
            y: cg.y,
            z: cg.z,
          });
        } else {
          delta.decreases.push({
            groupId: exact.id,
            amount: oldQty - newQty,
            locationType: cg.locationType,
            locationId: cg.locationId,
            locationSlot: cg.locationSlot,
            x: cg.x,
            y: cg.y,
            z: cg.z,
          });
        }
      }
    } else {
      // New group at this location
      const { id } = db.upsertItemGroup({
        fingerprint: cg.fingerprint,
        item: rep.item,
        durability: rep.durability,
        ammo: rep.ammo,
        attachments: rep.attachments,
        cap: rep.cap,
        maxDur: rep.maxDur,
        locationType: cg.locationType,
        locationId: cg.locationId,
        locationSlot: cg.locationSlot,
        x: cg.x,
        y: cg.y,
        z: cg.z,
        quantity: cg.quantity,
        stackSize: rep.amount || 1,
      });
      cg._matchedGroupId = id;
      stats.groups.created++;

      // Track as increase for transfer cross-referencing
      if (!deltas.has(cg.fingerprint)) deltas.set(cg.fingerprint, { increases: [], decreases: [] });
      deltas.get(cg.fingerprint).increases.push({
        groupId: id,
        amount: cg.quantity,
        locationType: cg.locationType,
        locationId: cg.locationId,
        locationSlot: cg.locationSlot,
        x: cg.x,
        y: cg.y,
        z: cg.z,
      });
    }
  }

  // ── Mark unmatched existing groups as lost and track as decrease ──
  for (const [fp, groups] of existingByFP) {
    for (const g of groups) {
      if (!g._matched) {
        db.markItemGroupLost(g.id);
        stats.groups.lost++;

        if (!deltas.has(fp)) deltas.set(fp, { increases: [], decreases: [] });
        deltas.get(fp).decreases.push({
          groupId: g.id,
          amount: g.quantity,
          locationType: g.location_type,
          locationId: g.location_id,
          locationSlot: g.location_slot,
          x: g.pos_x,
          y: g.pos_y,
          z: g.pos_z,
        });
      }
    }
  }

  // ── Cross-reference deltas to detect transfers ──
  for (const [fingerprint, delta] of deltas) {
    if (delta.decreases.length === 0 || delta.increases.length === 0) continue;

    // Match decreases to increases (greedy: largest transfers first)
    const decreases = delta.decreases.slice().sort((a, b) => b.amount - a.amount);
    const increases = delta.increases.slice().sort((a, b) => b.amount - a.amount);

    for (const dec of decreases) {
      let remaining = dec.amount;
      for (const inc of increases) {
        if (remaining <= 0) break;
        if (inc.amount <= 0) continue;

        const transferred = Math.min(remaining, inc.amount);
        remaining -= transferred;
        inc.amount -= transferred;

        // Determine who moved it
        const fakeCurrentItem = {
          locationType: inc.locationType,
          locationId: inc.locationId,
          x: inc.x,
          y: inc.y,
          z: inc.z,
        };
        const fakeOldInstance = { location_type: dec.locationType, location_id: dec.locationId };
        const attribution = _attributeMovement(fakeCurrentItem, fakeOldInstance, snapshot, nameResolver);

        // Resolve item name from existing group or fingerprint
        const srcGroup = db.getItemGroup(dec.groupId);
        const itemName = srcGroup?.item || fingerprint;

        db.recordGroupMovement({
          groupId: inc.groupId,
          moveType: 'group_transfer',
          item: itemName,
          from: { type: dec.locationType, id: dec.locationId, slot: dec.locationSlot },
          to: { type: inc.locationType, id: inc.locationId, slot: inc.locationSlot },
          amount: transferred,
          attribution,
          pos: { x: inc.x, y: inc.y, z: inc.z },
        });
        stats.groups.transferred++;
      }
    }
  }
}

/**
 * Add items from a normalised inventory to the current items list,
 * tagging each with its location metadata.
 */
function _addLocationItems(currentItems, items, locationType, locationId, locationSlot, entity) {
  for (const item of items) {
    currentItems.push({
      ...item,
      locationType,
      locationId,
      locationSlot,
      x: entity.x ?? entity.pos_x ?? null,
      y: entity.y ?? entity.pos_y ?? null,
      z: entity.z ?? entity.pos_z ?? null,
    });
  }
}

/**
 * Try to attribute a detected movement to a specific player.
 *
 * Heuristics:
 *   - If the item moved TO a player, that player took/picked it up
 *   - If the item moved FROM a player, that player dropped/deposited it
 *   - If between two non-player locations, check for nearby players
 */
function _attributeMovement(currentItem, oldInstance, snapshot, nameResolver) {
  // Moving TO a player
  if (currentItem.locationType === 'player') {
    const name = nameResolver ? nameResolver(currentItem.locationId) : currentItem.locationId;
    return { steamId: currentItem.locationId, name };
  }

  // Moving FROM a player
  if (oldInstance.location_type === 'player') {
    const name = nameResolver ? nameResolver(oldInstance.location_id) : oldInstance.location_id;
    return { steamId: oldInstance.location_id, name };
  }

  // Between non-player locations — try proximity matching
  if (snapshot.players && currentItem.x != null) {
    const MAX_DIST_SQ = 5000 * 5000; // ~50m
    let bestPlayer = null;
    let bestDistSq = MAX_DIST_SQ;

    for (const [steamId, data] of snapshot.players) {
      if (data.x == null) continue;
      const dx = currentItem.x - (data.x || 0);
      const dy = currentItem.y - (data.y || 0);
      const distSq = dx * dx + dy * dy;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestPlayer = steamId;
      }
    }

    if (bestPlayer) {
      const name = nameResolver ? nameResolver(bestPlayer) : bestPlayer;
      return { steamId: bestPlayer, name };
    }
  }

  return null;
}

module.exports = { reconcileItems };
