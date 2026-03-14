'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  game-data-extract.js — Dynamic extraction from game-tables-raw.json
//
//  Reads the full 22 MB extraction once at module load, cleans UE4 hashed
//  field names, resolves enum values to human-readable names, and exports
//  structured data for every useful table. Profession and clan-rank enums
//  delegate to save-parser.js as the single source of truth.
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

// ── Load raw data ──────────────────────────────────────────────────────────

const RAW_PATH = path.join(__dirname, '..', '..', 'data', 'game-tables-raw.json');

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

// ── Adapter: shared enums from save-parser (single source of truth) ────────

/**
 * Project a prefixed enum map (e.g. 'Enum_Professions::NewEnumerator0' → 'Unemployed')
 * into the unprefixed format used by ENUM_MAPS ('NewEnumerator0' → 'Unemployed').
 * Optionally fills Reserved placeholder slots for unused enum indices.
 */
function _projectEnum(prefixedMap, reservedSlots) {
  const map = {};
  for (const [key, value] of Object.entries(prefixedMap)) {
    const idx = key.indexOf('::');
    if (idx !== -1) map[key.substring(idx + 2)] = value;
  }
  for (const slot of reservedSlots) {
    const k = `NewEnumerator${slot}`;
    if (!map[k]) map[k] = 'Reserved';
  }
  return map;
}

// Load save-parser enum maps; fall back to empty objects if unavailable
let _saveParserEnums;
try {
  const sp = require('./save-parser');
  _saveParserEnums = { PERK_MAP: sp.PERK_MAP, CLAN_RANK_MAP: sp.CLAN_RANK_MAP };
} catch (err) {
  if (err.code !== 'MODULE_NOT_FOUND') {
    console.warn('[game-data-extract] save-parser load error:', err.message);
  }
  _saveParserEnums = { PERK_MAP: {}, CLAN_RANK_MAP: {} };
}

// ── Enum resolution ────────────────────────────────────────────────────────

/** All enum maps — display names for every UE4 enum value.
 *  Cross-referenced against actual DT_ItemDatabase, DT_Buildings, DT_CraftingData,
 *  DT_Professions, DT_Skills, DT_CarUpgrades usage — not guessed.
 *  Note: Enum_Professions and E_ClanRank are derived from save-parser
 *  (PERK_MAP / CLAN_RANK_MAP) and are not independently maintained here. */
const ENUM_MAPS = {
  // Item types (25 values — verified against DT_ItemDatabase Type field)
  E_ItemTypes: {
    NewEnumerator0: 'Misc', // 357, 556, 762 (default/unset)
    NewEnumerator2: 'Melee', // NailedBat, SledgeHammer, Axe
    NewEnumerator3: 'Pistol', // 1911, Pistol, DesertEagle
    NewEnumerator4: 'Ranged', // Bow, PumpShotgun, AK47
    NewEnumerator5: 'Medical', // Bandage, BottlePainkillers, MedKit
    NewEnumerator6: 'Drink', // Apple, Water, EnergyDrink
    NewEnumerator7: 'Food', // Apple, PorknBeans, RawMeat
    NewEnumerator8: 'Consumable', // Water, EnergyDrink, Whisky
    NewEnumerator9: 'Resource', // Wrench, CarBattery, ScrapMetal
    NewEnumerator10: 'Tool', // LockPick, CoffeeBag, BowlDogFood
    NewEnumerator11: 'Utility', // RepairKit, FuelCan, EmptyFuelCan
    NewEnumerator12: 'Ammo', // 357, 556, 762 (ammo variant)
    NewEnumerator13: 'Equipment', // Compass
    NewEnumerator14: 'Material', // Log, CarUpgradeBumper_L1
    NewEnumerator15: 'Trinket', // PocketWatch
    NewEnumerator16: 'Repair', // GunRepair
    NewEnumerator17: 'Key', // (reserved enum slot)
    NewEnumerator18: 'Armor', // MilitaryVest, GasMask, PoliceVest
    NewEnumerator19: 'Power', // Battery, PowerBattery
    NewEnumerator20: 'VehiclePart', // Jack
    NewEnumerator21: 'Throwable', // Fireworks
    NewEnumerator22: 'Treatment', // Treatment
    NewEnumerator23: 'Trap', // Mine, BasicDiyMine, BearTrap
    NewEnumerator24: 'Attachment', // GasFilter, Heatpack
    NewEnumerator25: 'SkillBook', // SBookElectricity, SBookApocWeapons
  },

  // Item specific sub-types (15 values — verified against DT_ItemDatabase SpecificType field)
  E_SpecificType: {
    NewEnumerator0: 'Vehicle Part', // CarBattery, FuelPump, FanBelt, StarterMotor
    NewEnumerator1: 'Energy Drink', // EnergyDrink, EnergyDrink2
    NewEnumerator2: 'Alcohol', // Whisky, Beer, Mead, Vodka
    NewEnumerator3: 'Blunt', // NailedBat, SledgeHammer, Hammer, Shovel
    NewEnumerator4: 'Blade', // Axe, Knife, SawBladeBat, Hatchet
    NewEnumerator5: 'None', // (unused)
    NewEnumerator6: 'None', // (unused)
    NewEnumerator7: 'Vegetable', // Rice, TomatoSoup, Carrot, Potato
    NewEnumerator8: 'Fruit', // Apple
    NewEnumerator9: 'Medicine', // MedKit, PainKillers, WaterTabs
    NewEnumerator10: 'None', // (unused)
    NewEnumerator11: 'Dirty Water', // DirtyWater
    NewEnumerator12: 'None', // (unused)
    NewEnumerator13: 'None', // 357, 556, 762, 1911 (default)
    NewEnumerator14: 'Meat', // PorknBeans, RawMeat, Tuna, CookedMeat
  },

  // Clothing/wear position (8 values)
  E_ClothingPosition: {
    NewEnumerator0: 'None',
    NewEnumerator1: 'Head',
    NewEnumerator3: 'Body',
    NewEnumerator4: 'Legs',
    NewEnumerator5: 'Feet',
    NewEnumerator6: 'Hands',
    NewEnumerator7: 'Face',
    NewEnumerator8: 'Back',
  },

  // Build categories (6 values — verified against DT_Buildings Category field)
  E_BuildCategory: {
    NewEnumerator0: 'Crafting', // Campfire, ChemistryStation, WorkbenchLVL1
    NewEnumerator1: 'Structure', // WoodFloor, LogWall, MetalBarbWall
    NewEnumerator2: 'Farming', // FarmPlot, CropBed, CropPlot, SpawnPoint
    NewEnumerator3: 'Storage', // StorageContainer, WeaponsCrate, CupboardStorage
    NewEnumerator4: 'Power', // Generator, LampPost, ChainlinkFenceElectrified
    NewEnumerator5: 'Defence', // BarbDefence, Stakes, SimpleTrap, FishingTrap
  },

  // Crafting stations (15 values — verified against DT_CraftingData CraftingStation field)
  E_CraftingStation: {
    NewEnumerator0: 'Inventory', // NewRow, WoodBow, Bait
    NewEnumerator1: 'Campfire', // Arrow, FireArrow, CrossBowBolt
    NewEnumerator2: 'Distiller', // (no recipes currently use this)
    NewEnumerator3: 'Cooking Stove', // CabbageSoup, CarrotStew, MeatCarrotStew
    NewEnumerator4: 'Workbench', // Water, Canteen1, CookedMeat
    NewEnumerator5: 'Chemistry Station', // Treatment, MedKit, PainKillers
    NewEnumerator6: 'Fat Converter', // FuelCan, Whisky, Mead
    NewEnumerator7: 'Melee Bench', // BrassCasing, IronRefined
    NewEnumerator8: 'Ammo Bench', // 357, 556, 762
    NewEnumerator9: 'Table Saw', // Oil
    NewEnumerator10: 'Furnace', // Axe, Hammer, Knife
    NewEnumerator11: 'Tanning Rack', // HideBearDried, HideWolfDried
    NewEnumerator12: 'Tailoring Bench', // DeerskinShirt, DeerskinPants
    NewEnumerator13: 'Salting Table', // SaltedMeat, SaltedPerch, SaltedPIke
    NewEnumerator14: 'Cement Mixer', // Cement
  },

  // Resource types for crafting/building costs (42 values — verified against actual item names)
  E_ResourceType: {
    NewEnumerator0: 'Wood', // Wood
    NewEnumerator1: 'Rock', // Rock
    NewEnumerator2: 'Ammo', // 357, 556, 762
    NewEnumerator3: 'Scrap Metal', // ScrapMetal
    NewEnumerator4: 'Rope', // Rope
    NewEnumerator5: 'Log', // Log
    NewEnumerator6: 'Nails', // Nails
    NewEnumerator8: 'Sticks', // Sticks
    NewEnumerator9: 'Tarp', // Tarp
    NewEnumerator10: 'Car Battery', // CarBattery
    NewEnumerator11: 'Electronics', // Electronics
    NewEnumerator13: 'Sheet Metal', // SheetMetal
    NewEnumerator14: 'Oil', // Oil
    NewEnumerator15: 'Fuel Can', // FuelCan
    NewEnumerator16: 'Barb Wire', // Barbwire
    NewEnumerator17: 'Electrical Cable', // ElectricalCable
    NewEnumerator18: 'Empty Jar', // EmptyJar
    NewEnumerator20: 'Cement', // Cement
    NewEnumerator21: 'Refined Iron', // IronRefined
    NewEnumerator22: 'Hose', // Hose
    NewEnumerator23: 'Funnel', // Funnel
    NewEnumerator24: 'Gun Parts', // Gunparts
    NewEnumerator25: 'Pollen Trap', // PollenTrap
    NewEnumerator26: 'Microphone', // Microphone
    NewEnumerator27: 'Generator Engine', // GennyEngine
    NewEnumerator28: 'Thermostat', // Thermostat, Rod, Reel
    NewEnumerator29: 'Compressor', // Compressor
    NewEnumerator30: 'Element', // Element
    NewEnumerator31: 'Jump Leads', // JumpLeads
    NewEnumerator32: 'Battery Charger', // BatteryCharger
    NewEnumerator33: 'Water Barrel', // WaterBarrel, Heater
    NewEnumerator34: 'Bear Hide', // HideBearDried
    NewEnumerator35: 'Wolf Hide', // HideWolfDried
    NewEnumerator36: 'Deer Hide', // HideDeerDried
    NewEnumerator37: 'Alarm Clock', // AlarmClock
    NewEnumerator38: 'Grenade', // Grenade
    NewEnumerator39: 'Thread', // Thread
    NewEnumerator40: 'Pump Shotgun', // PumpShotgun
    NewEnumerator41: 'Reserved', // (unused)
  },

  // Car upgrade types (11 values — verified against DT_CarUpgrades Type field)
  E_CarUpgradeTypes: {
    NewEnumerator0: 'Front Bumper', // CarUpgradeBumper_L1-L3
    NewEnumerator1: 'Rear Bumper', // CarUpgradeRear_L1-L3
    NewEnumerator2: 'Reserved', // (unused)
    NewEnumerator3: 'Reserved', // (unused)
    NewEnumerator4: 'Storage', // CarUpgradeStorage_L1-L3
    NewEnumerator5: 'Wheels', // CarTire, BadCarTire, CarUpgradeWheels_L1-L3
    NewEnumerator6: 'Reserved', // (unused)
    NewEnumerator7: 'Window Left', // CarUpgradeWindowL_L1-L3
    NewEnumerator8: 'Window Right', // CarUpgradeWindowR_L1-L3
    NewEnumerator9: 'Windshield', // CarUpgradeWindshield_L1-L3
    NewEnumerator10: 'Reserved', // (unused)
  },

  // Animal types (6 values)
  Enum_AnimalType: {
    NewEnumerator0: 'Bear',
    NewEnumerator1: 'Wolf',
    NewEnumerator2: 'Deer',
    NewEnumerator3: 'Rabbit',
    NewEnumerator4: 'Chicken',
    NewEnumerator5: 'Pig',
  },

  // Professions — derived from save-parser PERK_MAP (12 active + 5 Reserved slots)
  Enum_Professions: _projectEnum(_saveParserEnums.PERK_MAP, [4, 5, 6, 7, 8]),

  // Skill categories (3 values — verified against DT_Skills Category field cross-ref)
  Enum_SkillCategories: {
    NewEnumerator0: 'Survival', // Sprinter, Athlete, MasterChef, DeepPockets, LumberJack, etc.
    NewEnumerator1: 'Crafting', // LockPicker, BirdWatcher, Resourceful, BaseDefence, HACKER, etc.
    NewEnumerator2: 'Combat', // Fighter, Homerun, BladeMaster, SteadyAim, BowMan, RifleMan, etc.
  },

  // Skill book types
  Enum_SkillBookType: {
    NewEnumerator0: 'Recipe',
    NewEnumerator1: 'Skill',
  },

  // Stat/challenge categories (4 values — verified against DT_StatConfig/DT_Statistics)
  E_StatCat: {
    NewEnumerator0: 'Objective', // PowerPlant, RadioTower, etc.
    NewEnumerator1: 'Combat', // Kill milestones, headshots, etc.
    NewEnumerator2: 'Quest', // FirstQuest, 5Quests, 10Quests
    NewEnumerator3: 'Survival', // Fishing, crafting, exploration
  },

  // Mini-quest requirement types
  E_MiniRequired: {
    NewEnumerator0: 'Item',
    NewEnumerator1: 'Kill',
  },

  // Clan ranks — derived from save-parser CLAN_RANK_MAP
  E_ClanRank: _projectEnum(_saveParserEnums.CLAN_RANK_MAP, []),

  // Dog commands (6 values)
  E_DogCommand: {
    NewEnumerator0: 'Follow',
    NewEnumerator1: 'Stay',
    NewEnumerator2: 'Attack',
    NewEnumerator3: 'Guard',
    NewEnumerator4: 'Patrol',
    NewEnumerator5: 'Dismiss',
  },

  // Quest status (4 values)
  E_QuestStatus: {
    NewEnumerator0: 'Available',
    NewEnumerator1: 'Active',
    NewEnumerator2: 'Complete',
    NewEnumerator3: 'Failed',
  },

  // Character start perks / professions (9 values)
  Enum_CharacterStartPerk: {
    NewEnumerator0: 'None',
    NewEnumerator1: 'Strong',
    NewEnumerator2: 'Fast',
    NewEnumerator3: 'Quiet',
    NewEnumerator4: 'Tough',
    NewEnumerator5: 'Smart',
    NewEnumerator6: 'Lucky',
    NewEnumerator7: 'Resourceful',
    NewEnumerator8: 'Hardy',
  },

  // Inventory slot types (10 values)
  E_InvSlotType: {
    NewEnumerator0: 'Equipment',
    NewEnumerator1: 'Quickslot',
    NewEnumerator2: 'Pocket',
    NewEnumerator3: 'Backpack',
    NewEnumerator4: 'Container',
    NewEnumerator5: 'Ground',
    NewEnumerator6: 'Vehicle',
    NewEnumerator7: 'Hotbar',
    NewEnumerator8: 'Clothing',
    NewEnumerator9: 'Trade',
  },

  // Container slot sizes (4 values)
  E_ContainerSlots: {
    NewEnumerator0: 'Medium',
    NewEnumerator1: 'Large',
    NewEnumerator2: 'Small',
    NewEnumerator3: 'Extra Large',
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
      alsoGiveItem:
        alsoGive && alsoGive.itemId && alsoGive.itemId !== 'Empty' && alsoGive.itemId !== 'None' ? alsoGive : null,
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
        ? c.StartingItems.map(parseItemRef).filter((r) => r && r.itemId && r.itemId !== 'None' && r.itemId !== 'Empty')
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
//  STAT CONFIG / CHALLENGES — DT_StatConfig (67 detailed challenge definitions)
// ═══════════════════════════════════════════════════════════════════════════

function extractStatConfig() {
  const raw = getTable('DT_StatConfig');
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
  get ITEMS() {
    return cached('items', extractItems);
  },
  get ITEM_NAMES() {
    return cached('itemNames', () => buildItemNames(module.exports.ITEMS));
  },
  get LOOT_TABLES() {
    return cached('lootTables', extractLootTables);
  },
  get BUILDINGS() {
    return cached('buildings', extractBuildings);
  },
  get BUILDING_NAMES() {
    return cached('buildingNames', () => buildBuildingNames(module.exports.BUILDINGS));
  },
  get RECIPES() {
    return cached('recipes', extractRecipes);
  },
  get SKILLS() {
    return cached('skills', extractSkills);
  },
  get PROFESSIONS() {
    return cached('professions', extractProfessions);
  },
  get STATISTICS() {
    return cached('statistics', extractStatistics);
  },
  get STAT_CONFIG() {
    return cached('statConfig', extractStatConfig);
  },
  get CROPS() {
    return cached('crops', extractCrops);
  },
  get VEHICLES() {
    return cached('vehicles', extractVehicles);
  },
  get VEHICLE_NAMES() {
    return cached('vehicleNames', () => buildVehicleNames(module.exports.VEHICLES));
  },
  get CAR_UPGRADES() {
    return cached('carUpgrades', extractCarUpgrades);
  },
  get AMMO_DAMAGE() {
    return cached('ammoDamage', extractAmmoDamage);
  },
  get REPAIR_DATA() {
    return cached('repairData', extractRepairData);
  },
  get FURNITURE() {
    return cached('furniture', extractFurniture);
  },
  get TRAPS() {
    return cached('traps', extractTraps);
  },
  get ANIMALS() {
    return cached('animals', extractAnimals);
  },
  get XP_DATA() {
    return cached('xpData', extractXpData);
  },
  get SPAWN_LOCATIONS() {
    return cached('spawnLocations', extractSpawnLocations);
  },
  get LORE() {
    return cached('lore', extractLore);
  },
  get QUESTS() {
    return cached('quests', extractQuests);
  },
  get AFFLICTIONS() {
    return cached('afflictions', extractAfflictions);
  },
  get LOADING_TIPS() {
    return cached('loadingTips', extractLoadingTips);
  },
  get SPRAYS() {
    return cached('sprays', extractSprays);
  },
  get FOLIAGE() {
    return cached('foliage', extractFoliage);
  },
  get CHARACTERS() {
    return cached('characters', extractCharacterCreator);
  },

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

module.exports._test = { _projectEnum };
