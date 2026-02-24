/**
 * Shared UE4 actor/blueprint name cleaning utilities.
 *
 * Raw UE4 names look like:
 *   "Door_GEN_VARIABLE_BP_LockedMetalShutter_C_CAT_2147206852"
 *   "ChildActor_GEN_VARIABLE_BP_VehicleStorage_C_CAT_2147253396"
 *   "Storage_GEN_VARIABLE_BP_WoodCrate_C_2147261242"
 *   "BuildContainer_147"
 *   "BP_WoodWall_C_12345"
 *   "/Game/BuildingSystem/Blueprints/Buildings/BP_WoodWall.BP_WoodWall_C"
 *
 * All converge to a single `cleanName()` function that produces human-readable
 * labels: "Locked Metal Shutter", "Vehicle Storage", "Wood Crate", "Wood Wall"
 *
 * @module ue4-names
 */

// ─── Common container aliases ────────────────────────────────────────────────
// These fire first to catch well-known patterns before generic cleanup.
const CONTAINER_ALIASES = [
  [/VehicleStorage/i, 'Vehicle Storage'],
  [/CupboardContainer/i, 'Cupboard'],
  [/StorageContainer/i, 'Storage Container'],
  [/Fridge/i, 'Fridge'],
  [/^Barrel$/i, 'Barrel'],
  [/GunLocker/i, 'Gun Locker'],
  [/WoodCrate/i, 'Wood Crate'],
  [/MetalCrate/i, 'Metal Crate'],
  [/^BuildContainer(?:_\d+)?$/i, 'Container'],
];

/**
 * Clean a raw UE4 actor name, blueprint path, or item name into a readable label.
 *
 * Handles all known patterns:
 *   - Full blueprint paths:  /Game/.../BP_Name.BP_Name_C
 *   - Actor instances:       Door_GEN_VARIABLE_BP_LockedMetalShutter_C_CAT_2147206852
 *   - Storage actors:        ChildActor_GEN_VARIABLE_BP_VehicleStorage_C_2147253396
 *   - Build containers:      BuildContainer_147
 *   - Simple blueprints:     BP_WoodWall_C_12345
 *   - Already clean names:   "Wood Wall"
 *
 * @param {string} raw - The raw UE4 name
 * @returns {string} Human-readable label
 */
function cleanName(raw) {
  if (!raw) return 'Unknown';
  let name = String(raw);

  // BuildContainer → Container (catch early before CamelCase-only path)
  if (/^BuildContainer(?:_\d+)?$/i.test(name)) return 'Container';

  // Already clean (no underscores, no BP_ prefix, has spaces) — return as-is
  if (!name.includes('_') && !name.startsWith('BP_')) {
    // But still CamelCase-split: "LockedMetalShutter" → "Locked Metal Shutter"
    if (/[a-z][A-Z]/.test(name)) {
      return name.replace(/([a-z])([A-Z])/g, '$1 $2').trim();
    }
    return name;
  }

  // Full blueprint path: /Game/.../BP_WoodWall.BP_WoodWall_C
  const pathMatch = name.match(/BP_([^.]+?)(?:_C)?$/);
  if (name.includes('/') && pathMatch) {
    name = pathMatch[1];
  } else {
    // Strip trailing instance IDs:  _C_CAT_2147206852, _C_2147206852
    name = name.replace(/_C_(?:CAT_)?\d+$/, '');
    name = name.replace(/_C_\d+$/, '');
    // Strip trailing _C suffix
    name = name.replace(/_C$/, '');
  }

  // Strip GEN_VARIABLE noise (can appear after any prefix or standalone)
  // "Door_GEN_VARIABLE_BP_LockedMetalShutter" → "LockedMetalShutter"
  // "ChildActor_GEN_VARIABLE_BP_VehicleStorage" → "VehicleStorage"
  name = name.replace(/^.*?_GEN_VARIABLE_(?:BP_)?/, '');

  // Strip leading prefixes that survived
  name = name.replace(/^(?:ChildActor|Storage|Door|Window|Lamp|Light|Prop|Deco)_/i, '');
  name = name.replace(/^BP_/, '');

  // BuildContainer_NNN → Container
  if (/^BuildContainer(?:_\d+)?$/i.test(name)) return 'Container';

  // Strip trailing numeric ID: _12345
  name = name.replace(/_\d+$/, '');

  // Check container aliases on the cleaned intermediate
  for (const [pattern, alias] of CONTAINER_ALIASES) {
    if (pattern.test(name)) return alias;
  }

  // Underscores → spaces
  name = name.replace(/_/g, ' ');

  // CamelCase → spaced: "LockedMetalShutter" → "Locked Metal Shutter"
  name = name.replace(/([a-z])([A-Z])/g, '$1 $2');

  // Collapse multiple spaces
  name = name.replace(/\s{2,}/g, ' ').trim();

  return name || raw;
}

/**
 * Clean a raw item name from save data.
 * Items names are typically simpler: "BP_ItemName_C" or "ItemName".
 *
 * @param {string} raw
 * @returns {string}
 */
function cleanItemName(raw) {
  if (!raw) return 'Unknown';
  let name = String(raw);

  // Full path: strip to last segment
  if (name.includes('/')) {
    const seg = name.split('/').pop() || name;
    name = seg.replace(/\.[^.]+$/, ''); // strip .ClassName extension
  }

  // Strip BP_ prefix and _C suffix
  name = name.replace(/^BP_/, '').replace(/_C$/, '');

  // Underscores → spaces, CamelCase → spaced
  name = name.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');

  return name.trim() || raw;
}

module.exports = { cleanName, cleanItemName, CONTAINER_ALIASES };
