/**
 * Typed DB row + query-param shapes for the web-map server and its route
 * modules. These mirror the CREATE TABLE schemas in db/schema.ts and the
 * shapes returned by better-sqlite3 .get() / .all(). Pure types — no runtime.
 *
 * Extracted from web-map/server.ts (P1-1 god-file split). Definitions are
 * verbatim; only `export` was added.
 */

/** Row shape returned by better-sqlite3 .get() / .all() */
export type DbRow = Record<string, unknown>;

// ── Typed DB row interfaces (match CREATE TABLE schemas in db/schema.ts) ──

export interface StructureRow {
  id: number;
  actor_class: string;
  display_name: string;
  owner_steam_id: string;
  pos_x: number;
  pos_y: number;
  pos_z: number;
  current_health: number;
  max_health: number;
  upgrade_level: number;
  inventory: string;
  attached_to_trailer: number;
  no_spawn: number;
  extra_data: string;
}

export interface VehicleRow {
  id: number;
  class: string;
  display_name: string;
  pos_x: number;
  pos_y: number;
  pos_z: number;
  health: number;
  max_health: number;
  fuel: number;
  inventory: string;
  upgrades: string;
  extra: string;
}

export interface ContainerRow {
  actor_name: string;
  items: string;
  quick_slots: string;
  locked: number;
  does_spawn_loot: number;
  alarm_off: number;
  crafting_content: string;
  pos_x: number;
  pos_y: number;
  pos_z: number;
  extra: string;
}

export interface CompanionRow {
  id: number;
  type: string;
  actor_name: string;
  owner_steam_id: string;
  pos_x: number;
  pos_y: number;
  pos_z: number;
  health: number;
  extra: string;
}

export interface DeadBodyRow {
  actor_name: string;
  pos_x: number;
  pos_y: number;
  pos_z: number;
}

export interface QuestRow {
  id: string;
  type: string;
  state: string;
  time: string;
  items: string;
  pos_x: number;
  pos_y: number;
  pos_z: number;
  updated_at: string;
}

export interface ActivityRow {
  id: number;
  type: string;
  category: string;
  actor: string;
  actor_name: string;
  item: string;
  amount: number;
  details: string;
  pos_x: number;
  pos_y: number;
  pos_z: number;
  created_at: string;
  steam_id?: string;
  attributed_name?: string;
  target_steam_id?: string;
  target_name?: string;
}

export type ActivityRangePreset = 'today' | 'yesterday' | '7d' | '30d' | 'all' | 'custom';

export type ActivityRange = {
  preset: ActivityRangePreset;
  timezone: string;
  from: string;
  to: string;
  dateFrom: string;
  dateTo: string;
};

export interface ItemInstanceRow {
  id: number;
  fingerprint: string;
  item: string;
  durability: number;
  ammo: number;
  attachments: string | string[];
  cap: number;
  max_dur: number;
  location_type: string;
  location_id: string;
  location_slot: string;
  pos_x: number;
  pos_y: number;
  pos_z: number;
  amount: number;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface ItemGroupRow {
  id: number;
  fingerprint: string;
  item: string;
  durability: number;
  ammo: number;
  attachments: string | string[];
  cap: number;
  max_dur: number;
  location_type: string;
  location_id: string;
  location_slot: string;
  pos_x: number;
  pos_y: number;
  pos_z: number;
  quantity: number;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface ItemMovementRow {
  id: number;
  instance_id: number;
  item: string;
  from_type: string;
  from_id: string;
  from_slot: string;
  to_type: string;
  to_id: string;
  to_slot: string;
  amount: number;
  attributed_steam_id: string;
  attributed_name: string;
  pos_x: number;
  pos_y: number;
  pos_z: number;
  created_at: string;
}

export interface ItemLocationSummaryRow {
  type: string;
  id: string;
  instanceCount: number;
  groupCount: number;
  totalItems: number;
}

export type ItemListView = 'all' | 'instances' | 'groups';

export interface DeathCauseRow {
  id: number;
  victim_name: string;
  victim_steam_id: string;
  cause_type: string;
  cause_name: string;
  cause_raw: string;
  damage_total: number;
  pos_x: number | null;
  pos_y: number | null;
  pos_z: number | null;
  created_at: string;
}

export interface ChatRow {
  id: number;
  type: string;
  player_name: string;
  steam_id: string;
  message: string;
  direction: string;
  discord_user: string;
  is_admin: number;
  created_at: string;
}

export interface EnvEntry {
  type: 'section' | 'keyval' | 'commented' | 'empty';
  label?: string;
  key?: string;
  value?: string;
}
