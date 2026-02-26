'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  game-data-extract.js — Dynamic extraction from game-tables-raw.json
//
//  Reads the full 22 MB extraction once at module load, cleans UE4 hashed
//  field names, resolves enum values to human-readable names, and exports
//  structured data for every useful table.  All other modules import from
//  here instead of maintaining static copies.
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

// ── Load raw data ──────────────────────────────────────────────────────────

const RAW_PATH = path.join(__dirname, '..', 'data', 'game-tables-raw.json');

let RAW;
try {
  RAW = JSON.parse(fs.readFileSync(RAW_PATH, 'utf8'));
} catch {
  console.warn('[game-data-extract] game-tables-raw.json not found — exports will be empty');
  RAW = {};
}

// ── Key-cleaning helpers ───────────────────────────────────────────────────

/**
 * UE4 exports field names like `FieldName_N_HEXHASH`.
 * This regex extracts just the clean portion.
 */
const HASH_RE = /^(.+?)_\d+_[A-F0-9]{20,}$/i;

/** Strip UE4 hash suffix from a single key. */
function cleanKey(key) {
  const m = key.match(HASH_RE);
  return m ? m[1] : key;
}

/** Recursively clean all keys in an object/array. */
function deepClean(val) {
  if (val === null || val === undefined) return val;
  if (Array.isArray(val)) return val.map(deepClean);
  if (typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      out[cleanKey(k)] = deepClean(v);
    }
    return out;
  }
  return val;
}

/** Clean only top-level keys of a row (fast path for flat tables). */
function cleanRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[cleanKey(k)] = v;
  }
  return out;
}

// ── Enum resolution ────────────────────────────────────────────────────────

/** All enum maps — authoritative display names for every UE4 enum value. */
const ENUM_MAPS = {
  // Item types (24 values)
  'E_ItemTypes': {
    'NewEnumerator0': 'Misc',
    'NewEnumerator2': 'Melee',
    'NewEnumerator3': 'Pistol',
    'NewEnumerator4': 'Ranged',
    'NewEnumerator5': 'Medical',
    'NewEnumerator6': 'Drink',
    'NewEnumerator7': 'Food',
    'NewEnumerator8': 'Consumable',
    'NewEnumerator9': 'Resource',
    'NewEnumerator10': 'Tool',
    'NewEnumerator11': 'Utility',
    'NewEnumerator12': 'Ammo',
    'NewEnumerator13': 'Equipment',
    'NewEnumerator14': 'Material',
    'NewEnumerator15': 'Trinket',
    'NewEnumerator16': 'Repair',
    'NewEnumerator18': 'Armor',
    'NewEnumerator19': 'Power',
    'NewEnumerator20': 'VehiclePart',
    'NewEnumerator21': 'Throwable',
    'NewEnumerator22': 'Treatment',
    'NewEnumerator23': 'Trap',
    'NewEnumerator24': 'Attachment',
    'NewEnumerator25': 'SkillBook',
  },

  // Item specific sub-types (11 values)
  'E_SpecificType': {
    'NewEnumerator0': 'None',
    'NewEnumerator1': 'Rifle',
    'NewEnumerator2': 'Shotgun',
    'NewEnumerator3': 'SMG',
    'NewEnumerator4': 'Bow',
    'NewEnumerator7': 'Crossbow',
    'NewEnumerator8': 'Battery',
    'NewEnumerator9': 'Fuel',
    'NewEnumerator11': 'Scope',
    'NewEnumerator13': 'Backpack',
    'NewEnumerator14': 'Sling',
  },

  // Clothing/wear position (8 values)
  'E_ClothingPosition': {
    'NewEnumerator0': 'None',
    'NewEnumerator1': 'Head',
    'NewEnumerator3': 'Body',
    'NewEnumerator4': 'Legs',
    'NewEnumerator5': 'Feet',
    'NewEnumerator6': 'Hands',
    'NewEnumerator7': 'Face',
    'NewEnumerator8': 'Back',
  },

  // Build categories (6 values)
  'E_BuildCategory': {
    'NewEnumerator0': 'Crafting',
    'NewEnumerator1': 'Structure',
    'NewEnumerator2': 'Farming',
    'NewEnumerator3': 'Storage',
    'NewEnumerator4': 'Power',
    'NewEnumerator5': 'Defence',
  },

  // Crafting stations (14 values)
  'E_CraftingStation': {
    'NewEnumerator0': 'Inventory',
    'NewEnumerator1': 'Campfire',
    'NewEnumerator3': 'Workbench',
    'NewEnumerator4': 'Chemistry Station',
    'NewEnumerator5': 'Cooking Stove',
    'NewEnumerator6': 'Melee Bench',
    'NewEnumerator7': 'Weapons Bench',
    'NewEnumerator8': 'Ammo Bench',
    'NewEnumerator9': 'Table Saw',
    'NewEnumerator10': 'Furnace',
    'NewEnumerator11': 'Fat Converter',
    'NewEnumerator12': 'Tailoring Bench',
    'NewEnumerator13': 'Tanning Rack',
    'NewEnumerator14': 'Cement Mixer',
  },

  // Resource types for building costs (40 values)
  'E_ResourceType': {
    'NewEnumerator0': 'Wood',
    'NewEnumerator1': 'Metal',
    'NewEnumerator2': 'Nails',
    'NewEnumerator3': 'Rope',
    'NewEnumerator4': 'Tape',
    'NewEnumerator5': 'Fabric',
    'NewEnumerator6': 'Stone',
    'NewEnumerator8': 'Clay',
    'NewEnumerator9': 'Cement',
    'NewEnumerator10': 'Glass',
    'NewEnumerator11': 'Electronics',
    'NewEnumerator13': 'Wire',
    'NewEnumerator14': 'Pipe',
    'NewEnumerator15': 'Fuel',
    'NewEnumerator16': 'Battery',
    'NewEnumerator17': 'Lightbulb',
    'NewEnumerator18': 'Brick',
    'NewEnumerator20': 'Plank',
    'NewEnumerator21': 'Glue',
    'NewEnumerator22': 'Scrap Metal',
    'NewEnumerator23': 'Barbed Wire',
    'NewEnumerator24': 'Tarp',
    'NewEnumerator25': 'Sand',
    'NewEnumerator26': 'Concrete',
    'NewEnumerator27': 'Leather',
    'NewEnumerator28': 'Paint',
    'NewEnumerator29': 'Rubber',
    'NewEnumerator30': 'Plastic',
    'NewEnumerator31': 'Springs',
    'NewEnumerator32': 'Gears',
    'NewEnumerator33': 'Bolts',
    'NewEnumerator34': 'Hinges',
    'NewEnumerator35': 'Chain',
    'NewEnumerator36': 'Copper Wire',
    'NewEnumerator37': 'Solar Panel',
    'NewEnumerator38': 'Circuit Board',
    'NewEnumerator39': 'Motor',
    'NewEnumerator40': 'Turbine',
    'E_MAX': 'MAX',
  },

  // Car upgrade types (7 values)
  'E_CarUpgradeTypes': {
    'NewEnumerator0': 'Armor Plating',
    'NewEnumerator1': 'Bull Bar',
    'NewEnumerator4': 'Storage',
    'NewEnumerator5': 'Tire',
    'NewEnumerator7': 'Engine',
    'NewEnumerator8': 'Suspension',
    'NewEnumerator9': 'Exhaust',
  },

  // Animal types (6 values)
  'Enum_AnimalType': {
    'NewEnumerator0': 'Bear',
    'NewEnumerator1': 'Wolf',
    'NewEnumerator2': 'Deer',
    'NewEnumerator3': 'Rabbit',
    'NewEnumerator4': 'Chicken',
    'NewEnumerator5': 'Pig',
  },

  // Professions (14 values — from DT_Professions + items/recipes)
  'Enum_Professions': {
    'NewEnumerator0': 'Unemployed',
    'NewEnumerator1': 'Mechanic',
    'NewEnumerator2': 'Boxer',
    'NewEnumerator3': 'Farmer',
    'NewEnumerator6': 'Outdoorsman',
    'NewEnumerator7': 'Chemist',
    'NewEnumerator9': 'EMT',
    'NewEnumerator10': 'Thief',
    'NewEnumerator12': 'Fire Fighter',
    'NewEnumerator13': 'Car Salesman',
    'NewEnumerator14': 'Electrical Engineer',
    'NewEnumerator15': 'Military Veteran',
    'NewEnumerator16': 'Chef',
    'NewEnumerator17': 'Builder',
  },

  // Skill categories (3 in-game + 2 reserved)
  'Enum_SkillCategories': {
    'NewEnumerator0': 'Combat',
    'NewEnumerator1': 'Survival',
    'NewEnumerator2': 'Stealth',
    'NewEnumerator3': 'Crafting',
    'NewEnumerator4': 'Social',
  },

  // Skill book types
  'Enum_SkillBookType': {
    'NewEnumerator0': 'Recipe',
    'NewEnumerator1': 'Skill',
  },

  // Stat/challenge categories
  'E_StatCat': {
    'NewEnumerator0': 'Objective',
    'NewEnumerator1': 'Combat',
    'NewEnumerator2': 'Quest',
  },

  // Mini-quest requirement types
  'E_MiniRequired': {
    'NewEnumerator0': 'Item',
    'NewEnumerator1': 'Kill',
  },
};

/**
 * Resolve a UE4 enum string like "E_ItemTypes::NewEnumerator3" to its display name.
 * Returns the raw value if no mapping is found.
 */
function resolveEnum(value) {
  if (typeof value !== 'string') return value;
  const idx = value.indexOf('::');
  if (idx === -1) return value;
  const prefix = value.substring(0, idx);
  const suffix = value.substring(idx + 2);
  const map = ENUM_MAPS[prefix];
  return map?.[suffix] ?? value;
}

// ── Table accessors ────────────────────────────────────────────────────────

function getTable(name) {
  return RAW[name]?.rows ?? {};
}

function getTableCleaned(name) {
  const rows = getTable(name);
  const out = {};
  for (const [id, row] of Object.entries(rows)) {
    out[id] = deepClean(row);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
//  ITEMS — DT_ItemDatabase (718 items, ~35 gameplay fields each)
// ═══════════════════════════════════════════════════════════════════════════

function extractItems() {
  const raw = getTable('DT_ItemDatabase');
  const items = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = cleanRow(row);

    // Clean nested structs
    const attachments = c.SupportedAttachments ? deepClean(c.SupportedAttachments) : null;
    const itemsInside = c.ItemsInside ? deepClean(c.ItemsInside) : null;
    const skillBookData = c.SkillBookData ? deepClean(c.SkillBookData) : null;
    const customImage = c.CustomImage ? deepClean(c.CustomImage) : null;

    items[id] = {
      id,
      name: c.Name || id,
      description: c.Desc || '',
      // Types (enum-resolved)
      type: resolveEnum(c.Type),
      typeRaw: c.Type || '',
      specificType: resolveEnum(c.SpecificType),
      wearPosition: resolveEnum(c.WearOnCharacter),
      buildResource: resolveEnum(c.BuildResource),
      // Core stats
      chanceToSpawn: c.ChanceToSpawn ?? 0,
      durabilityLoss: c.DurabilityLoss ?? 0,
      armorProtection: c.ArmorProtectionValue ?? 0,
      maxStackSize: c.MaxStackSize ?? 1,
      canStack: c.CanStack ?? false,
      itemSize: c.ItemSize ?? 1,
      weight: c.Weight ?? 0,
      // Values (healing, damage, etc.)
      firstValue: c.FirstValue ?? 0,
      secondItemType: resolveEnum(c.SecondItemType),
      secondValue: c.SecondValue ?? 0,
      // Economy
      valueToTrader: c.ValueToTrader ?? 0,
      valueForPlayer: c.ValueForPlayer ?? 0,
      // Decay
      doesDecay: c.DoesDecay ?? false,
      decayPerDay: c.DecayPerDay ?? 0,
      onlyDecayIfOpened: c.OnlyDecayIfOpened ?? false,
      // Clothing stats
      warmthValue: c.WarmthValue ?? 0,
      infectionProtection: c.InfectionProtection ?? 0,
      clothingRainMod: c.ClothingRainModifier ?? 0,
      clothingSnowMod: c.ClothingSnowModifier ?? 0,
      summerCoolValue: c.SummerCoolValue ?? 0,
      // Flags
      isSkillBook: c.IsSkillBook ?? false,
      noPocket: c.NoPocket ?? false,
      excludeFromVendor: c.ExcludeFromVendor ?? false,
      excludeFromAI: c.ExcludeFromAI ?? false,
      useAsFertilizer: c.UseAsFertilizer ?? false,
      closeBackpackOnUse: c.CloseBackpackOnUse ?? false,
      // Misc
      state: c.State ?? '',
      randCapacity: c.RandCapacity ?? 0,
      randAtt: c.RandAtt ?? false,
      tag: c.Tag || '',
      openItem: c.OpenItem || '',
      bodyAttachSocket: c.BodyAttachSocket || '',
      // Complex nested data
      supportedAttachments: attachments,
      itemsInside: itemsInside,
      skillBookData: skillBookData,
      customImage: customImage,
    };
  }
  return items;
}

// ═══════════════════════════════════════════════════════════════════════════
//  LOOT TABLES — 68 INV_* tables
// ═══════════════════════════════════════════════════════════════════════════

function extractLootTables() {
  const tables = {};
  for (const tableName of Object.keys(RAW)) {
    if (!tableName.startsWith('INV_')) continue;
    const raw = getTable(tableName);
    const items = {};
    for (const [itemId, row] of Object.entries(raw)) {
      const c = cleanRow(row);
      items[itemId] = {
        name: c.Name || itemId,
        chanceToSpawn: c.ChanceToSpawn ?? 0,
        type: resolveEnum(c.Type),
        maxStackSize: c.MaxStackSize ?? 1,
      };
    }
    tables[tableName] = {
      name: tableName,
      itemCount: Object.keys(items).length,
      items,
    };
  }
  return tables;
}

// ═══════════════════════════════════════════════════════════════════════════
//  BUILDINGS — DT_Buildings (122 entries)
// ═══════════════════════════════════════════════════════════════════════════

function extractBuildings() {
  const raw = getTable('DT_Buildings');
  const buildings = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = cleanRow(row);

    // Parse required resources
    const resources = [];
    if (Array.isArray(c.RequiredResources)) {
      for (const res of c.RequiredResources) {
        const rc = deepClean(res);
        resources.push({
          type: resolveEnum(rc.ResourceType),
          typeRaw: rc.ResourceType || '',
          amount: rc.Amount ?? 0,
        });
      }
    }

    // Parse upgrades
    const upgrades = [];
    if (Array.isArray(c.Upgrades)) {
      for (const upg of c.Upgrades) {
        const uc = deepClean(upg);
        const upgResources = [];
        if (Array.isArray(uc.RequiredResources)) {
          for (const res of uc.RequiredResources) {
            upgResources.push({
              type: resolveEnum(res.ResourceType),
              amount: res.Amount ?? 0,
            });
          }
        }
        upgrades.push({
          health: uc.NewHealth ?? 0,
          resources: upgResources,
        });
      }
    }

    buildings[id] = {
      id,
      name: c.BuildingName || id,
      description: c.Description || '',
      category: resolveEnum(c.Category),
      categoryRaw: c.Category || '',
      health: c.FinishedBuildingHealth ?? 0,
      showInBuildMenu: c.ShowInBuildMenu ?? false,
      requiresBuildTool: c.RequiresBuildTool ?? false,
      moveableAfterPlacement: c.MoveableAfterPlacement ?? false,
      learnedBuilding: c.LearnedBuilding ?? false,
      placementOnLandscapeOnly: c.PlacementOnLandscapeOnly ?? false,
      placementInWaterOnly: c.PlacementInWaterOnly ?? false,
      placementOnStructureOnly: c.PlacementOnStructureOnly ?? false,
      wallPlacement: c['WallPlacement?'] ?? false,
      requireFoundation: c['RequireFoundation?'] ?? false,
      requireAllFoundations: c['RequireAllFoundations?'] ?? false,
      allowSnapToggle: c.AllowSnapToggle ?? false,
      checkGeoCollision: c.CheckGeoCollision ?? false,
      wallDistance: c.WallDistance ?? 0,
      forwardDistance: c.ForwardDistance ?? 0,
      xpMultiplier: c.XPMultiplier ?? 1,
      resources,
      upgrades,
    };
  }
  return buildings;
}

// ═══════════════════════════════════════════════════════════════════════════
//  CRAFTING RECIPES — DT_CraftingData
// ═══════════════════════════════════════════════════════════════════════════

/** Extract item ref from CraftedIItem/RequiredItems nested struct. */
function parseItemRef(struct) {
  if (!struct) return null;
  const c = deepClean(struct);
  const dt = c.Item;
  return {
    itemId: dt?.RowName || '',
    amount: c.Amount ?? 0,
    durability: c.Durability ?? 0,
    ammo: c.Ammo ?? 0,
    weight: c.Weight ?? 0,
    capacity: c.Cap ?? 0,
  };
}

function extractRecipes() {
  const raw = getTable('DT_CraftingData');
  const recipes = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = deepClean(row);

    const ingredients = [];
    if (Array.isArray(c.RequiredItems)) {
      for (const req of c.RequiredItems) {
        const parsed = parseItemRef(req);
        if (parsed && parsed.itemId && parsed.itemId !== 'Empty' && parsed.itemId !== 'None') {
          ingredients.push(parsed);
        }
      }
    }

    const craftedItem = parseItemRef(c.CraftedIItem);
    const alsoGive = parseItemRef(c.AlsoGiveItem);
    const alsoGiveArr = [];
    if (Array.isArray(c.AlsoGiveArr)) {
      for (const item of c.AlsoGiveArr) {
        const p = parseItemRef(item);
        if (p && p.itemId && p.itemId !== 'Empty' && p.itemId !== 'None') alsoGiveArr.push(p);
      }
    }

    recipes[id] = {
      id,
      name: c.RecipeName || id,
      description: c.RecipeDescription || '',
      station: resolveEnum(c.CraftingStation),
      stationRaw: c.CraftingStation || '',
      recipeType: resolveEnum(c.RecipeType),
      craftTime: c.CraftTime ?? 0,
      profession: resolveEnum(c.Profession),
      professionRaw: c.Profession || '',
      requiresRecipe: c.RequiresRecipe ?? false,
      hidden: c['Hidden?'] ?? false,
      inventorySearchOnly: c.InventorySearchOnly ?? false,
      xpMultiplier: c.XPMultiplier ?? 1,
      maxItemsDisplayed: c.MaxItemsDisplayed ?? 1,
      useAny: c['UseAny?'] ?? false,
      copyCapacity: c['CopyCapacity?'] ?? false,
      noSpoiled: c['NoSpoiled?'] ?? false,
      ignoreMeleeCheck: c.IgnoreMeleeCheck ?? false,
      overrideName: c.OverrideName || '',
      overrideDescription: c.OverrideDescription || '',
      craftedItem,
      alsoGiveItem: (alsoGive && alsoGive.itemId && alsoGive.itemId !== 'Empty' && alsoGive.itemId !== 'None') ? alsoGive : null,
      alsoGiveArr: alsoGiveArr.length > 0 ? alsoGiveArr : null,
      ingredients,
    };
  }
  return recipes;
}

// ═══════════════════════════════════════════════════════════════════════════
//  SKILLS — DT_Skills
// ═══════════════════════════════════════════════════════════════════════════

function extractSkills() {
  const raw = getTable('DT_Skills');
  const skills = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = deepClean(row);

    // Parse PerkModifier for gameplay effects
    const perk = c.PerkModifier || {};
    const effects = {
      fuelPercentage: perk.FuelPercentage ?? 1,
      repairPercentage: perk.RepairPercentage ?? 1,
      chargePercentage: perk.ChargePercentage ?? 1,
      chancePercentage: perk.ChancePercentage ?? 1,
      timePercentage: perk.TimePercentage ?? 1,
      weightPercentage: perk.WeightPercentage ?? 1,
      projectileDamagePercentage: perk.ProjectileDamagePercentage ?? 1,
      meleeDamagePercentage: perk.MeleeDamagePercentage ?? 1,
      explosiveDamagePercentage: perk.ExplosiveDamagePercentage ?? 1,
      fistsDamagePercentage: perk.FistsDamagePercentage ?? 0,
      zoomPercentage: perk.ZoomPercentage ?? 0,
      enabled: perk.Enable ?? false,
      time: perk.Time ?? 0,
      amountSingle: perk.AmountSingle ?? 0,
      amountDecimal: perk.AmountDecimal ?? 0,
    };

    // Parse attribute modifiers
    const attributeModifiers = [];
    if (Array.isArray(perk.AttributeModifiers)) {
      for (const mod of perk.AttributeModifiers) {
        attributeModifiers.push({
          conditions: mod.Conditions || [],
          gainMultiplier: mod.GainMultiplier ?? 0,
          drainMultiplier: mod.DrainMultiplier ?? 0,
          valueModifier: mod.ValueModifier ?? 0,
          isPercentage: mod.ValueIsPercentage ?? true,
        });
      }
    }

    // Parse skill modifiers (complex — targets, conditions, general/attribute mods)
    const skillModifiers = [];
    if (Array.isArray(c.SkillModifiers)) {
      for (const sm of c.SkillModifiers) {
        const generalMods = [];
        if (Array.isArray(sm.ModifiersGeneral)) {
          for (const gm of sm.ModifiersGeneral) {
            generalMods.push({
              effect: gm.Effect || [],
              value: gm.Value ?? 0,
              isPercentage: gm.IsPercentage ?? false,
            });
          }
        }
        const attrMods = [];
        if (Array.isArray(sm.ModifiersAttributes)) {
          for (const am of sm.ModifiersAttributes) {
            attrMods.push({
              conditions: am.Conditions || [],
              gainMultiplier: am.GainMultiplier ?? 0,
              drainMultiplier: am.DrainMultiplier ?? 0,
              valueModifier: am.ValueModifier ?? 0,
              isPercentage: am.ValueIsPercentage ?? true,
            });
          }
        }
        skillModifiers.push({
          targetClassifications: sm.TargetClassifications || [],
          conditions: sm.Conditions || [],
          generalModifiers: generalMods,
          attributeModifiers: attrMods,
        });
      }
    }

    skills[id] = {
      id,
      name: c.Name || id,
      description: c.Description || '',
      category: resolveEnum(c.Category),
      categoryRaw: c.Category || '',
      cost: c.Cost ?? 0,
      levelUnlock: c.LevelUnlock ?? 0,
      tier: c.Tier ?? 0,
      column: c.Column ?? 0,
      effects,
      attributeModifiers,
      skillModifiers,
    };
  }
  return skills;
}

// ═══════════════════════════════════════════════════════════════════════════
//  PROFESSIONS — DT_Professions (12 entries)
// ═══════════════════════════════════════════════════════════════════════════

function extractProfessions() {
  const raw = getTable('DT_Professions');
  const professions = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = deepClean(row);
    professions[id] = {
      id,
      name: c.Name || id,
      description: c.Description || '',
      startingItems: Array.isArray(c.StartingItems)
        ? c.StartingItems.map(parseItemRef).filter(r => r && r.itemId && r.itemId !== 'None' && r.itemId !== 'Empty')
        : [],
      passivePerks: c.PassivePerks || [],
    };
  }
  return professions;
}

// ═══════════════════════════════════════════════════════════════════════════
//  STATISTICS / CHALLENGES — DT_Statistics
// ═══════════════════════════════════════════════════════════════════════════

function extractStatistics() {
  const raw = getTable('DT_Statistics');
  const stats = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = cleanRow(row);
    stats[id] = {
      id,
      guid: c.ID || '',
      category: resolveEnum(c.Category),
      categoryRaw: c.Category || '',
      name: c.Name || id,
      description: c.Descriptionn || c.Description || '',
      progressMin: c.Progress?.x ?? 0,
      progressMax: c.Progress?.y ?? 1,
      xp: c.XP ?? 0,
      skillPoint: c.SkillPoint ?? 0,
    };
  }
  return stats;
}

// ═══════════════════════════════════════════════════════════════════════════
//  CROPS — DT_CropData
// ═══════════════════════════════════════════════════════════════════════════

function extractCrops() {
  const raw = getTable('DT_CropData');
  const crops = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = deepClean(row);
    crops[id] = {
      id,
      seedItemId: id,
      cropId: c.ID ?? 0,
      growthTimeDays: c.GrowthTimeDays ?? 0,
      growSeasons: c.GrowSeasons || [],
      gridColumns: c.ColRow?.x ?? 1,
      gridRows: c.ColRow?.y ?? 1,
      spacingX: c.Spacing?.x ?? 0,
      spacingY: c.Spacing?.y ?? 0,
      stageCount: Array.isArray(c.Stages) ? c.Stages.length : 0,
      harvestResult: c.HarvestResult || '',
      harvestCount: c.Count ?? 0,
    };
  }
  return crops;
}

// ═══════════════════════════════════════════════════════════════════════════
//  VEHICLES — DT_VehicleSpawn (27 entries)
// ═══════════════════════════════════════════════════════════════════════════

function extractVehicles() {
  const raw = getTable('DT_VehicleSpawn');
  const vehicles = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = cleanRow(row);
    vehicles[id] = {
      id,
      name: c.VehicleName || id,
    };
  }
  return vehicles;
}

// ═══════════════════════════════════════════════════════════════════════════
//  CAR UPGRADES — DT_CarUpgrades (23 entries)
// ═══════════════════════════════════════════════════════════════════════════

function extractCarUpgrades() {
  const raw = getTable('DT_CarUpgrades');
  const upgrades = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = deepClean(row);

    // Parse craft cost
    const craftCost = [];
    if (Array.isArray(c.CraftCost)) {
      for (const cost of c.CraftCost) {
        craftCost.push({
          type: resolveEnum(cost.ResourceType),
          amount: cost.Amount ?? 0,
        });
      }
    }

    upgrades[id] = {
      id,
      type: resolveEnum(c.Type),
      typeRaw: c.Type || '',
      level: c.Level ?? 0,
      socket: c.Socket || '',
      toolDurabilityLost: c.ToolInHandDurLost ?? 0,
      craftTimeMinutes: c.CraftTimeMinutes ?? 0,
      health: c.Health ?? 0,
      craftCost,
    };
  }
  return upgrades;
}

// ═══════════════════════════════════════════════════════════════════════════
//  AMMO DAMAGE — DT_AmmoDamage
// ═══════════════════════════════════════════════════════════════════════════

function extractAmmoDamage() {
  const raw = getTable('DT_AmmoDamage');
  const ammo = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = cleanRow(row);
    ammo[id] = {
      id,
      damage: c.DamageValue ?? 0,
      headshotMultiplier: c.HeadshotMultiplier ?? 1,
      range: c.Range ?? 0,
      penetration: c.Penetration ?? 0,
    };
  }
  return ammo;
}

// ═══════════════════════════════════════════════════════════════════════════
//  REPAIR — DT_RepairData
// ═══════════════════════════════════════════════════════════════════════════

function extractRepairData() {
  const raw = getTable('DT_RepairData');
  const repairs = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = deepClean(row);

    const extraResources = [];
    if (Array.isArray(c.Extra)) {
      for (const ex of c.Extra) {
        extraResources.push({
          type: resolveEnum(ex.ResourceType),
          amount: ex.Amount ?? 0,
        });
      }
    }

    repairs[id] = {
      id,
      buildingId: id,
      resourceType: resolveEnum(c.Resource),
      resourceTypeRaw: c.Resource || '',
      amount: c.Amount ?? 0,
      healthToAdd: c.HealthToAdd ?? 0,
      isRepairable: c.IsRepairable ?? true,
      extraResources,
    };
  }
  return repairs;
}

// ═══════════════════════════════════════════════════════════════════════════
//  FURNITURE DROPS — DT_FurnitureDamage (21 entries)
// ═══════════════════════════════════════════════════════════════════════════

function extractFurniture() {
  const raw = getTable('DT_FurnitureDamage');
  const furniture = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = deepClean(row);

    const dropResources = [];
    if (Array.isArray(c.DropResources)) {
      for (const dr of c.DropResources) {
        dropResources.push({
          itemId: dr.ItemID || '',
          min: dr.Min ?? 0,
          max: dr.Max ?? 0,
        });
      }
    }

    furniture[id] = {
      id,
      name: id,
      meshCount: Array.isArray(c.Meshes) ? c.Meshes.length : 0,
      dropResources,
    };
  }
  return furniture;
}

// ═══════════════════════════════════════════════════════════════════════════
//  TRAPS — DT_TrapSettings
// ═══════════════════════════════════════════════════════════════════════════

function extractTraps() {
  const raw = getTable('DT_TrapSettings');
  const traps = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = deepClean(row);
    const itemRef = c.ItemReference;

    traps[id] = {
      id,
      itemId: itemRef?.RowName || '',
      requiresWeapon: c.RequiresWeapon ?? false,
      requiresAmmo: c.RequiresAmmo ?? false,
      requiresItems: c.RequiresItems ?? false,
      requiredAmmoId: c.RequiredAmmo?.RowName || '',
      compatibleItemCount: Array.isArray(c.CompatibleItems) ? c.CompatibleItems.length : 0,
    };
  }
  return traps;
}

// ═══════════════════════════════════════════════════════════════════════════
//  ANIMALS — Animal_DT (6 entries)
// ═══════════════════════════════════════════════════════════════════════════

function extractAnimals() {
  const raw = getTable('Animal_DT');
  const animals = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = cleanRow(row);
    animals[id] = {
      id,
      name: id,
      type: resolveEnum(c.AnimalType),
      hideItemId: c.HideNameFromItemDT || '',
    };
  }
  return animals;
}

// ═══════════════════════════════════════════════════════════════════════════
//  XP — DT_XpData
// ═══════════════════════════════════════════════════════════════════════════

function extractXpData() {
  const raw = getTable('DT_XpData');
  const xp = [];
  for (const [id, row] of Object.entries(raw)) {
    const c = cleanRow(row);
    xp.push({
      id,
      category: c.XpCategory || '',
      gainMultiplier: c.XpGainMultiplier ?? 1,
    });
  }
  return xp;
}

// ═══════════════════════════════════════════════════════════════════════════
//  SPAWN LOCATIONS — DT_SpawnLocation
// ═══════════════════════════════════════════════════════════════════════════

function extractSpawnLocations() {
  const raw = getTable('DT_SpawnLocation');
  const locs = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = cleanRow(row);
    locs[id] = {
      id,
      name: c.Name || id,
      description: c.Description || '',
      map: c.Map || '',
    };
  }
  return locs;
}

// ═══════════════════════════════════════════════════════════════════════════
//  LORE — DT_LoreData
// ═══════════════════════════════════════════════════════════════════════════

function extractLore() {
  const raw = getTable('DT_LoreData');
  const lore = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = deepClean(row);
    lore[id] = {
      id,
      title: c.Title || id,
      text: c.Text || c.LoreText || '',
      category: c.Category || '',
      order: c.Order ?? 0,
    };
  }
  return lore;
}

// ═══════════════════════════════════════════════════════════════════════════
//  QUESTS — DT_MiniQuest
// ═══════════════════════════════════════════════════════════════════════════

function extractQuests() {
  const raw = getTable('DT_MiniQuest');
  const quests = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = deepClean(row);

    const requirements = [];
    if (Array.isArray(c.RequiredStuff)) {
      for (const req of c.RequiredStuff) {
        requirements.push({
          type: resolveEnum(req.Required),
          itemId: req.Item?.RowName || '',
          amount: req.Amount ?? 0,
        });
      }
    }

    const rewards = [];
    if (Array.isArray(c.Rewards)) {
      for (const rew of c.Rewards) {
        const parsed = parseItemRef(rew);
        if (parsed && parsed.itemId && parsed.itemId !== 'None' && parsed.itemId !== 'Empty') {
          rewards.push(parsed);
        }
      }
    }

    quests[id] = {
      id,
      name: c.QuestName || c.Name || id,
      description: c.QuestDescription || c.Description || '',
      xpReward: c.XPReward ?? 0,
      requirements,
      rewards,
    };
  }
  return quests;
}

// ═══════════════════════════════════════════════════════════════════════════
//  AFFLICTIONS — DT_Affliction
// ═══════════════════════════════════════════════════════════════════════════

function extractAfflictions() {
  const raw = getTable('DT_Affliction');
  const afflictions = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = deepClean(row);
    afflictions[id] = {
      id,
      name: c.Name || id,
      description: c.Description || '',
      treatment: c.Treatment || '',
      duration: c.Duration ?? 0,
      damagePerTick: c.DamagePerTick ?? 0,
    };
  }
  return afflictions;
}

// ═══════════════════════════════════════════════════════════════════════════
//  LOADING TIPS — DT_LoadingTips
// ═══════════════════════════════════════════════════════════════════════════

function extractLoadingTips() {
  const raw = getTable('DT_LoadingTips');
  const tips = [];
  for (const [id, row] of Object.entries(raw)) {
    const c = cleanRow(row);
    tips.push({
      id,
      text: c.Tip || c.Text || '',
    });
  }
  return tips;
}

// ═══════════════════════════════════════════════════════════════════════════
//  SPRAYS — DataTable_Sprays
// ═══════════════════════════════════════════════════════════════════════════

function extractSprays() {
  const raw = getTable('DataTable_Sprays');
  const sprays = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = cleanRow(row);
    sprays[id] = {
      id,
      name: c.SprayName || id,
      description: c.Description || '',
      color: c.Color || '',
    };
  }
  return sprays;
}

// ═══════════════════════════════════════════════════════════════════════════
//  FOLIAGE — DT_FoliageData
// ═══════════════════════════════════════════════════════════════════════════

function extractFoliage() {
  const raw = getTable('DT_FoliageData');
  const foliage = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = deepClean(row);

    const drops = [];
    if (Array.isArray(c.Drops)) {
      for (const drop of c.Drops) {
        drops.push({
          itemId: drop.ItemID || drop.Item?.RowName || '',
          chance: drop.Chance ?? drop.ChancePercentage ?? 100,
          min: drop.Min ?? 1,
          max: drop.Max ?? 1,
        });
      }
    }

    foliage[id] = {
      id,
      name: id,
      health: c.Health ?? 0,
      canChop: c.CanChop ?? false,
      canMine: c.CanMine ?? false,
      drops,
    };
  }
  return foliage;
}

// ═══════════════════════════════════════════════════════════════════════════
//  CHARACTER CREATOR — DT_CharacterCreator
// ═══════════════════════════════════════════════════════════════════════════

function extractCharacterCreator() {
  const raw = getTable('DT_CharacterCreator');
  const chars = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = deepClean(row);
    chars[id] = {
      id,
      name: c.Name || id,
      isMale: c['IsMale?'] ?? true,
    };
  }
  return chars;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Convenience: name lookups
// ═══════════════════════════════════════════════════════════════════════════

function buildItemNames(items) {
  const map = {};
  for (const [id, item] of Object.entries(items)) {
    map[id] = item.name;
  }
  return map;
}

function buildBuildingNames(buildings) {
  const map = {};
  for (const [id, b] of Object.entries(buildings)) {
    map[id] = b.name;
  }
  return map;
}

function buildVehicleNames(vehicles) {
  const map = {};
  for (const [id, v] of Object.entries(vehicles)) {
    map[id] = v.name || id;
  }
  return map;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Lazy-cached extraction — each table extracted once on first access
// ═══════════════════════════════════════════════════════════════════════════

const _cache = {};

function cached(key, fn) {
  if (!(key in _cache)) _cache[key] = fn();
  return _cache[key];
}

// ═══════════════════════════════════════════════════════════════════════════
//  Exports
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  // Utilities
  cleanKey,
  cleanRow,
  deepClean,
  resolveEnum,
  ENUM_MAPS,
  getTable,
  getTableCleaned,

  // Lazy-loaded game data (extracted on first access)
  get ITEMS()            { return cached('items', extractItems); },
  get ITEM_NAMES()       { return cached('itemNames', () => buildItemNames(module.exports.ITEMS)); },
  get LOOT_TABLES()      { return cached('lootTables', extractLootTables); },
  get BUILDINGS()        { return cached('buildings', extractBuildings); },
  get BUILDING_NAMES()   { return cached('buildingNames', () => buildBuildingNames(module.exports.BUILDINGS)); },
  get RECIPES()          { return cached('recipes', extractRecipes); },
  get SKILLS()           { return cached('skills', extractSkills); },
  get PROFESSIONS()      { return cached('professions', extractProfessions); },
  get STATISTICS()       { return cached('statistics', extractStatistics); },
  get CROPS()            { return cached('crops', extractCrops); },
  get VEHICLES()         { return cached('vehicles', extractVehicles); },
  get VEHICLE_NAMES()    { return cached('vehicleNames', () => buildVehicleNames(module.exports.VEHICLES)); },
  get CAR_UPGRADES()     { return cached('carUpgrades', extractCarUpgrades); },
  get AMMO_DAMAGE()      { return cached('ammoDamage', extractAmmoDamage); },
  get REPAIR_DATA()      { return cached('repairData', extractRepairData); },
  get FURNITURE()        { return cached('furniture', extractFurniture); },
  get TRAPS()            { return cached('traps', extractTraps); },
  get ANIMALS()          { return cached('animals', extractAnimals); },
  get XP_DATA()          { return cached('xpData', extractXpData); },
  get SPAWN_LOCATIONS()  { return cached('spawnLocations', extractSpawnLocations); },
  get LORE()             { return cached('lore', extractLore); },
  get QUESTS()           { return cached('quests', extractQuests); },
  get AFFLICTIONS()      { return cached('afflictions', extractAfflictions); },
  get LOADING_TIPS()     { return cached('loadingTips', extractLoadingTips); },
  get SPRAYS()           { return cached('sprays', extractSprays); },
  get FOLIAGE()          { return cached('foliage', extractFoliage); },
  get CHARACTERS()       { return cached('characters', extractCharacterCreator); },

  // Table counts for diagnostics
  get TABLE_SUMMARY() {
    return cached('summary', () => {
      const s = {};
      for (const [name, table] of Object.entries(RAW)) {
        s[name] = table.rowCount ?? Object.keys(table.rows || {}).length;
      }
      return s;
    });
  },
};
