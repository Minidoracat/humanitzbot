/**
 * Item fingerprint utilities — generates unique-ish identities for item instances.
 *
 * Items in HumanitZ save files have several properties that, combined, create a
 * near-unique fingerprint for tracking individual instances across locations:
 *
 *   - item (RowName)       — the item type, e.g. "AK47"
 *   - durability (float)   — current durability, high-precision float
 *   - ammo (int)           — loaded ammo count (weapons only)
 *   - attachments (array)  — attached mods/scopes
 *   - cap (float)          — container capacity (bottles, etc.)
 *   - maxDur (float)       — max durability (may differ from item default after repair)
 *
 * The durability float alone has enough precision (~6 decimal digits) that two
 * AK-47s at 0.847623 and 0.847624 are distinguishable. Combined with ammo and
 * attachments, collisions are extremely rare in practice.
 *
 * Stackable items (amount > 1) with identical durability WILL collide — that's
 * correct behaviour. Nails x50 at durability 1.0 is fungible; we track the stack.
 *
 * @module item-fingerprint
 */

const crypto = require('crypto');

/**
 * Generate a fingerprint hash for an item instance.
 *
 * @param {object} item - Item data from save parser
 * @param {string} item.item - Item name (RowName)
 * @param {number} [item.durability=0] - Current durability
 * @param {number} [item.ammo=0] - Loaded ammo
 * @param {Array}  [item.attachments=[]] - Attached mods
 * @param {number} [item.cap=0] - Container capacity
 * @param {number} [item.maxDur=0] - Max durability
 * @returns {string} 12-character hex fingerprint
 */
function generateFingerprint(item) {
  if (!item || !item.item) return '';

  // Build deterministic string from all distinguishing properties
  const parts = [
    item.item,
    _normFloat(item.durability),
    String(item.ammo || 0),
    _normAttachments(item.attachments),
    _normFloat(item.cap),
    _normFloat(item.maxDur),
  ];

  const raw = parts.join('|');
  return crypto.createHash('md5').update(raw).digest('hex').slice(0, 12);
}

/**
 * Normalize a float to a consistent string representation.
 * Rounds to 6 decimal places to avoid floating point drift between parses.
 */
function _normFloat(val) {
  if (!val && val !== 0) return '0';
  return Number(val).toFixed(6);
}

/**
 * Normalize attachments array to a consistent sorted string.
 */
function _normAttachments(attachments) {
  if (!attachments || !Array.isArray(attachments) || attachments.length === 0) return '';
  return attachments.slice().sort().join(',');
}

/**
 * Extract fingerprint-relevant fields from a raw inventory slot.
 * Works with both agent output ({item, durability, ammo, ...}) and
 * raw save-parser output (array of property objects).
 *
 * @param {object|Array} slot - Inventory slot data
 * @returns {object} Normalized item data with fingerprint
 */
function normalizeSlot(slot) {
  if (!slot) return null;

  // Already in clean format (from agent or post-processing)
  if (typeof slot.item === 'string') {
    if (!slot.item || slot.item === 'None' || slot.item === 'Empty') return null;
    return {
      item: slot.item,
      amount: slot.amount || 1,
      durability: slot.durability || 0,
      ammo: slot.ammo || 0,
      attachments: slot.attachments || [],
      cap: slot.cap || 0,
      maxDur: slot.maxDur || 0,
      weight: slot.weight || 0,
      wetness: slot.wetness || 0,
      fingerprint: generateFingerprint(slot),
    };
  }

  // Raw save-parser format: array of property objects [{name, value}, ...]
  if (Array.isArray(slot)) {
    const parsed = {
      item: '',
      amount: 0,
      durability: 0,
      ammo: 0,
      attachments: [],
      cap: 0,
      maxDur: 0,
      weight: 0,
      wetness: 0,
    };
    for (const prop of slot) {
      if (prop.name === 'Item' && prop.children) {
        for (const c of prop.children) {
          if (c.name === 'RowName') parsed.item = c.value || '';
        }
      }
      if (prop.name === 'Amount') parsed.amount = prop.value || 0;
      if (prop.name === 'Durability') parsed.durability = prop.value || 0;
      if (prop.name === 'Ammo') parsed.ammo = prop.value || 0;
      if (prop.name === 'Attachments' && Array.isArray(prop.value)) parsed.attachments = prop.value;
      if (prop.name === 'Cap') parsed.cap = prop.value || 0;
      if (prop.name === 'MaxDur') parsed.maxDur = prop.value || 0;
      if (prop.name === 'Weight') parsed.weight = prop.value || 0;
      if (prop.name === 'Wetness') parsed.wetness = prop.value || 0;
    }
    if (!parsed.item || parsed.item === 'None' || parsed.item === 'Empty') return null;
    parsed.fingerprint = generateFingerprint(parsed);
    return parsed;
  }

  return null;
}

/**
 * Normalize a full inventory array (from any source) into clean fingerprinted items.
 *
 * @param {Array} items - Array of inventory slots (agent or raw format)
 * @returns {Array<object>} Array of normalized items with fingerprints
 */
function normalizeInventory(items) {
  if (!items || !Array.isArray(items)) return [];
  const result = [];
  for (const slot of items) {
    const normalized = normalizeSlot(slot);
    if (normalized) result.push(normalized);
  }
  return result;
}

/**
 * Build a fingerprint → item map for fast lookup during reconciliation.
 *
 * @param {Array<object>} items - Normalized items with fingerprints
 * @returns {Map<string, Array<object>>} fingerprint → [items]
 */
function buildFingerprintMap(items) {
  const map = new Map();
  for (const item of items) {
    if (!item.fingerprint) continue;
    if (!map.has(item.fingerprint)) map.set(item.fingerprint, []);
    map.get(item.fingerprint).push(item);
  }
  return map;
}

module.exports = {
  generateFingerprint,
  normalizeSlot,
  normalizeInventory,
  buildFingerprintMap,
};
