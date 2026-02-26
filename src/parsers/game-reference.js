/**
 * Game reference module — seeds all static game data into SQLite.
 *
 * Sources:
 *   - game-data-extract.js (dynamic extraction from game-tables-raw.json)
 *   - game-data.js (hand-curated data + re-exports from extract)
 *
 * Tables populated (schema v11):
 *   - game_items              (718 items)
 *   - game_professions        (12 professions)
 *   - game_afflictions        (20 afflictions)
 *   - game_skills             (35 skills)
 *   - game_challenges         (32 challenges/stats)
 *   - game_loading_tips       (26 tips)
 *   - game_server_setting_defs
 *   - game_recipes            (154 recipes)
 *   - game_lore               (12 lore entries)
 *   - game_quests             (18 quests)
 *   - game_spawn_locations    (10 spawn locations)
 *   - game_buildings          (122 buildings)
 *   - game_loot_pools / game_loot_pool_items (68 loot tables)
 *   - game_vehicles_ref       (27 vehicles)
 *   - game_animals            (6 animals)
 *   - game_crops              (6 crops)
 *   - game_car_upgrades       (23 upgrades)
 *   - game_ammo_types         (8 ammo types)
 *   - game_repair_data        (57 repair entries)
 *   - game_furniture          (21 furniture)
 *   - game_traps              (6 traps)
 *   - game_sprays             (8 sprays)
 */

const {
  AFFLICTION_MAP,
  AFFLICTION_DETAILS,
  PROFESSION_DETAILS,
  CHALLENGES,
  CHALLENGE_DESCRIPTIONS,
  LOADING_TIPS,
  SKILL_EFFECTS,
  SKILL_DETAILS,
  SERVER_SETTING_DESCRIPTIONS,
  ITEM_DATABASE,
  CRAFTING_RECIPES,
  LORE_ENTRIES,
  QUEST_DATA,
  SPAWN_LOCATIONS,
  BUILDINGS,
  LOOT_TABLES,
  VEHICLES,
  ANIMALS,
  CROP_DATA,
  CAR_UPGRADES,
  AMMO_DAMAGE,
  REPAIR_RECIPES,
  FURNITURE_DROPS,
  TRAPS,
  SPRAYS,
} = require('./game-data');

// ─── Seed all game reference data ──────────────────────────────────────────

/**
 * Seed all game reference data into the database.
 * Safe to call multiple times — uses INSERT OR REPLACE.
 *
 * @param {import('../db/database')} db - Initialised HumanitZDB instance
 */
function seed(db) {
  // Core reference tables
  seedItems(db);
  seedProfessions(db);
  seedAfflictions(db);
  seedSkills(db);
  seedChallenges(db);
  seedLoadingTips(db);
  seedServerSettingDefs(db);
  seedRecipes(db);
  seedLore(db);
  seedQuests(db);
  seedSpawnLocations(db);

  // New v11 reference tables
  seedBuildings(db);
  seedLootPools(db);
  seedVehicles(db);
  seedAnimals(db);
  seedCrops(db);
  seedCarUpgrades(db);
  seedAmmoTypes(db);
  seedRepairData(db);
  seedFurniture(db);
  seedTraps(db);
  seedSprays(db);

  db._setMeta('game_ref_seeded', new Date().toISOString());
  console.log('[GameRef] All game reference data seeded (22 tables)');
}

// ─── Items (game_items — 718 entries) ───────────────────────────────────────

function seedItems(db) {
  // Extract ITEMS already have the exact shape seedGameItems expects
  const items = Object.values(ITEM_DATABASE);
  db.seedGameItems(items);
}

// ─── Professions ────────────────────────────────────────────────────────────

function seedProfessions(db) {
  let PERK_MAP;
  try { PERK_MAP = require('./save-parser').PERK_MAP; } catch { PERK_MAP = {}; }

  // Build enum_value → name reverse map
  const enumToName = {};
  for (const [enumVal, name] of Object.entries(PERK_MAP)) {
    enumToName[name] = enumVal;
  }

  const professions = Object.entries(PROFESSION_DETAILS).map(([name, info]) => ({
    id: name,
    enumValue: enumToName[name] || '',
    enumIndex: _enumIndex(enumToName[name]),
    perk: info.perk || '',
    description: info.description || '',
    affliction: info.affliction || '',
    skills: info.unlockedSkills || [],
  }));

  db.seedGameProfessions(professions);
}

function _enumIndex(enumValue) {
  if (!enumValue) return 0;
  const m = enumValue.match(/(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

// ─── Afflictions ────────────────────────────────────────────────────────────

function seedAfflictions(db) {
  const detailsByName = {};
  for (const [, detail] of Object.entries(AFFLICTION_DETAILS)) {
    detailsByName[detail.name] = detail;
  }

  const afflictions = AFFLICTION_MAP.map((name, idx) => ({
    idx,
    name,
    description: detailsByName[name]?.description || '',
    icon: '',
  }));
  db.seedGameAfflictions(afflictions);
}

// ─── Skills ─────────────────────────────────────────────────────────────────

function seedSkills(db) {
  const detailsByName = {};
  for (const [, detail] of Object.entries(SKILL_DETAILS)) {
    detailsByName[detail.name.toUpperCase()] = detail;
  }

  const skills = Object.entries(SKILL_EFFECTS).map(([id, effect]) => {
    const detail = detailsByName[id] || {};
    return {
      id,
      name: detail.name || id.charAt(0).toUpperCase() + id.slice(1).toLowerCase().replace(/_/g, ' '),
      description: detail.description || '',
      effect,
      category: detail.category?.toLowerCase() || _inferSkillCategory(id),
      icon: '',
    };
  });
  db.seedGameSkills(skills);
}

function _inferSkillCategory(skillId) {
  const combat = ['CALLUSED', 'SPRINTER', 'WRESTLER', 'VITAL SHOT', 'REDEYE', 'RELOADER', 'MAG FLIP', 'CONTROLLED BREATHING'];
  const survival = ['BANDOLEER', 'HEALTHY GUT', 'INFECTION TREATMENT', 'BEAST OF BURDEN'];
  const stealth = ['SPEED STEALTH', 'DEEP POCKETS', 'LIGHTFOOT', 'HACKER'];
  const crafting = ['CARPENTRY', 'METAL WORKING', 'RING MY BELL'];
  const social = ['CHARISMA', 'HAGGLER'];

  if (combat.includes(skillId)) return 'combat';
  if (survival.includes(skillId)) return 'survival';
  if (stealth.includes(skillId)) return 'stealth';
  if (crafting.includes(skillId)) return 'crafting';
  if (social.includes(skillId)) return 'social';
  return 'general';
}

// ─── Challenges ─────────────────────────────────────────────────────────────

function seedChallenges(db) {
  const merged = [];

  for (const ch of CHALLENGES) {
    merged.push({
      id: ch.id,
      name: ch.name,
      description: ch.description,
      saveField: '',
      target: 0,
    });
  }

  for (const [field, info] of Object.entries(CHALLENGE_DESCRIPTIONS)) {
    const existing = merged.find(m => m.name === info.name);
    if (existing) {
      existing.saveField = field;
      existing.target = info.target || 0;
      if (info.desc && !existing.description) existing.description = info.desc;
    } else {
      merged.push({
        id: field,
        name: info.name,
        description: info.desc || '',
        saveField: field,
        target: info.target || 0,
      });
    }
  }

  db.seedGameChallenges(merged);
}

// ─── Loading tips ───────────────────────────────────────────────────────────

function seedLoadingTips(db) {
  const categorized = LOADING_TIPS.map(text => {
    let category = 'general';
    if (/RMB|LMB|press|toggle|click|key|ctrl|shift|spacebar|hot key|button/i.test(text)) category = 'controls';
    else if (/health|thirst|hunger|stamina|infection|vital/i.test(text)) category = 'vitals';
    else if (/inventory|weapon|slot|backpack|carry/i.test(text)) category = 'inventory';
    else if (/fish|reel|tension|bait/i.test(text)) category = 'fishing';
    else if (/build|craft|station|structure|workbench/i.test(text)) category = 'crafting';
    else if (/vehicle|car|trunk|stall|horn|headlight/i.test(text)) category = 'vehicles';
    else if (/zeek|zombie|spawn/i.test(text)) category = 'combat';
    return { text, category };
  });
  db.seedLoadingTips(categorized);
}

// ─── Server setting definitions ─────────────────────────────────────────────

function seedServerSettingDefs(db) {
  const settings = Object.entries(SERVER_SETTING_DESCRIPTIONS).map(([key, label]) => ({
    key,
    label,
    description: '',
    type: _inferSettingType(key),
    defaultVal: '',
    options: [],
  }));
  db.seedGameServerSettingDefs(settings);
}

function _inferSettingType(key) {
  if (/enabled|fire|anywhere|position|drop/i.test(key)) return 'bool';
  if (/max|time|drain|multiplier|population|difficulty/i.test(key)) return 'float';
  if (/mode|level/i.test(key)) return 'enum';
  if (/name/i.test(key)) return 'string';
  return 'string';
}

// ─── Recipes (game_recipes — 154 entries) ───────────────────────────────────

function seedRecipes(db) {
  const recipes = Object.values(CRAFTING_RECIPES);
  db.seedGameRecipes(recipes);
}

// ─── Lore (game_lore — 12 entries) ──────────────────────────────────────────

function seedLore(db) {
  const lore = Object.values(LORE_ENTRIES);
  db.seedGameLore(lore);
}

// ─── Quests (game_quests — 18 entries) ──────────────────────────────────────

function seedQuests(db) {
  const quests = Object.values(QUEST_DATA);
  db.seedGameQuests(quests);
}

// ─── Spawn locations (game_spawn_locations — 10 entries) ────────────────────

function seedSpawnLocations(db) {
  const spawns = Object.values(SPAWN_LOCATIONS);
  db.seedGameSpawnLocations(spawns);
}

// ─── Buildings (game_buildings — 122 entries) ───────────────────────────────

function seedBuildings(db) {
  const buildings = Object.values(BUILDINGS);
  db.seedGameBuildings(buildings);
}

// ─── Loot pools (game_loot_pools + game_loot_pool_items — 68 tables) ───────

function seedLootPools(db) {
  db.seedGameLootPools(LOOT_TABLES);
}

// ─── Vehicles (game_vehicles_ref — 27 entries) ─────────────────────────────

function seedVehicles(db) {
  const vehicles = Object.entries(VEHICLES).map(([id, v]) => ({
    id,
    name: v.name || id,
  }));
  db.seedGameVehiclesRef(vehicles);
}

// ─── Animals (game_animals — 6 entries) ─────────────────────────────────────

function seedAnimals(db) {
  const animals = Object.values(ANIMALS);
  db.seedGameAnimals(animals);
}

// ─── Crops (game_crops — 6 entries) ─────────────────────────────────────────

function seedCrops(db) {
  const crops = Object.values(CROP_DATA);
  db.seedGameCrops(crops);
}

// ─── Car upgrades (game_car_upgrades — 23 entries) ──────────────────────────

function seedCarUpgrades(db) {
  const upgrades = Object.values(CAR_UPGRADES);
  db.seedGameCarUpgrades(upgrades);
}

// ─── Ammo types (game_ammo_types — 8 entries) ───────────────────────────────

function seedAmmoTypes(db) {
  const ammo = Object.values(AMMO_DAMAGE);
  db.seedGameAmmoTypes(ammo);
}

// ─── Repair data (game_repair_data — 57 entries) ────────────────────────────

function seedRepairData(db) {
  const repairs = Object.values(REPAIR_RECIPES);
  db.seedGameRepairData(repairs);
}

// ─── Furniture (game_furniture — 21 entries) ─────────────────────────────────

function seedFurniture(db) {
  const furniture = Object.values(FURNITURE_DROPS);
  db.seedGameFurniture(furniture);
}

// ─── Traps (game_traps — 6 entries) ─────────────────────────────────────────

function seedTraps(db) {
  const traps = Object.values(TRAPS);
  db.seedGameTraps(traps);
}

// ─── Sprays (game_sprays — 8 entries) ───────────────────────────────────────

function seedSprays(db) {
  const sprays = Object.values(SPRAYS);
  db.seedGameSprays(sprays);
}

module.exports = { seed };
