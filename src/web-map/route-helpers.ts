/**
 * Pure, stateless helper functions shared by the web-map server and its route
 * modules: activity date/range math, locale resolution, query-param parsing,
 * error sanitization, and the landing-settings projection.
 *
 * Extracted verbatim from web-map/server.ts (P1-1 god-file split). This file
 * lives at the same directory depth as server.ts, so all import specifiers are
 * the originals. No instance/`this` state — everything here is a pure function.
 */

import { _tzOffsetMs } from '../config/index.js';
import { resolveItemName, normalizeItemLocale } from '../i18n/item-names.js';
import { parseDbTimestampUtc } from '../db/timestamp.js';
import { errMsg } from '../utils/error.js';
import { sendError } from './api-errors.js';
import type { ActivityRange, ActivityRangePreset, ItemListView } from './types/db-rows.js';

export function _activityDateKey(date: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const y = parts.find((p) => p.type === 'year')?.value ?? '';
    const m = parts.find((p) => p.type === 'month')?.value ?? '';
    const d = parts.find((p) => p.type === 'day')?.value ?? '';
    if (y && m && d) return `${y}-${m}-${d}`;
  } catch {
    /* invalid timezone fallback below */
  }
  return date.toISOString().slice(0, 10);
}

export function _addActivityDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function _activitySqlUtcStart(dateKey: string, timezone: string): string {
  const asUtc = new Date(`${dateKey}T00:00:00Z`);
  if (Number.isNaN(asUtc.getTime())) return '';
  try {
    const offset1 = _tzOffsetMs(asUtc, timezone);
    const corrected = new Date(asUtc.getTime() - offset1);
    const offset2 = _tzOffsetMs(corrected, timezone);
    const utc = offset2 === offset1 ? corrected : new Date(asUtc.getTime() - offset2);
    return utc.toISOString().slice(0, 19).replace('T', ' ');
  } catch {
    return asUtc.toISOString().slice(0, 19).replace('T', ' ');
  }
}

export function _activityBucketOffsetMinutes(timezone: string): number {
  try {
    return Math.round(_tzOffsetMs(new Date(), timezone || 'UTC') / 60000);
  } catch {
    return 0;
  }
}

// Event types whose `actor`/`actor_name` columns hold raw UE4 entity names
// (containers, structures, vehicles, horses…) rather than player names.
// Historical activity_log rows store those raw names — they are cleaned at the
// API boundary instead of rewriting millions of DB rows.
export const ENTITY_ACTOR_EVENT_PREFIXES = [
  'container_',
  'structure_',
  'vehicle_',
  'horse_',
  'building_',
  'raid_',
  'clan_building_',
  'airdrop_',
  'world_',
];

export function _hasEntityActor(eventType: string): boolean {
  for (const prefix of ENTITY_ACTOR_EVENT_PREFIXES) {
    if (eventType.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Attach a human-readable `displayName` next to the raw `item` id on item
 * tracking rows. The raw id stays untouched — the frontend uses it for
 * tooltips, fingerprint tracking, and LIKE-based search. The label is
 * locale-aware: pass the locale resolved by _requestLocale(req).
 */
export function _withItemDisplayName<T extends { item?: string | null }>(
  row: T,
  locale?: string,
): T & { displayName?: string } {
  if (!row.item) return row;
  return { ...row, displayName: resolveItemName(row.item, locale) };
}

/**
 * Resolve the display locale for an API request. The panel frontend appends
 * `lang=<i18next language>` to API calls (see apiUrl in panel-core.js and
 * fetchPlayersQuick in app.js); direct API consumers can use the
 * Accept-Language header instead. Falls back to English.
 */
export function _requestLocale(req: { query?: Record<string, unknown>; headers?: Record<string, unknown> }): string {
  const q = req.query?.lang;
  if (typeof q === 'string' && q.trim()) return normalizeItemLocale(q);
  const acceptLanguage = req.headers?.['accept-language'];
  if (typeof acceptLanguage === 'string' && acceptLanguage) {
    for (const part of acceptLanguage.split(',')) {
      const tag = (part.split(';')[0] || '').trim().toLowerCase();
      if (!tag) continue;
      if (tag === 'zh-tw' || tag.startsWith('zh-hant')) return 'zh-TW';
      if (tag === 'zh-cn' || tag.startsWith('zh-hans') || tag === 'zh') return 'zh-CN';
      if (tag === 'en' || tag.startsWith('en-')) return 'en';
    }
  }
  return 'en';
}

export function _activityQueryString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function _resolveActivityRange(query: Record<string, unknown>, timezone: string): ActivityRange {
  const safeTz = timezone || 'UTC';
  const today = _activityDateKey(new Date(), safeTz);
  const requested = _activityQueryString(query.range).toLowerCase();
  const rawFrom = _activityQueryString(query.from);
  const rawTo = _activityQueryString(query.to);
  const hasCustomDate = /^\d{4}-\d{2}-\d{2}$/.test(rawFrom) || /^\d{4}-\d{2}-\d{2}$/.test(rawTo);
  const preset: ActivityRangePreset = ['today', 'yesterday', '7d', '30d', 'all', 'custom'].includes(requested)
    ? (requested as ActivityRangePreset)
    : hasCustomDate
      ? 'custom'
      : 'today';

  if (preset === 'all') return { preset, timezone: safeTz, from: '', to: '', dateFrom: '', dateTo: '' };

  let from = today;
  let to = today;
  if (preset === 'yesterday') {
    from = _addActivityDays(today, -1);
    to = from;
  } else if (preset === '7d') {
    from = _addActivityDays(today, -6);
  } else if (preset === '30d') {
    from = _addActivityDays(today, -29);
  } else if (preset === 'custom') {
    from = /^\d{4}-\d{2}-\d{2}$/.test(rawFrom) ? rawFrom : /^\d{4}-\d{2}-\d{2}$/.test(rawTo) ? rawTo : today;
    to = /^\d{4}-\d{2}-\d{2}$/.test(rawTo) ? rawTo : from;
    if (to < from) to = from;
  }

  return {
    preset,
    timezone: safeTz,
    from,
    to,
    dateFrom: _activitySqlUtcStart(from, safeTz),
    dateTo: _activitySqlUtcStart(_addActivityDays(to, 1), safeTz),
  };
}

export function _queryString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : '';
  return '';
}

/**
 * Resolve the first parseable timestamp to an ISO UTC string. Accepts both the
 * cache's ISO form and the DB's canonical 'YYYY-MM-DD HH:MM:SS' (UTC) form, so
 * browser-side `new Date()` never parses a zone-less string as local time.
 */
export function _isoTimestamp(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    const parsed = parseDbTimestampUtc(candidate);
    if (parsed) return parsed.toISOString();
  }
  return null;
}

export function _parseBoundedPositiveInt(value: unknown, defaultValue: number, max: number): number {
  const parsed = parseInt(_queryString(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.min(parsed, max);
}

export function _parseNonNegativeInt(value: unknown): number {
  const parsed = parseInt(_queryString(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed;
}

export function _parseItemListView(value: unknown): ItemListView {
  const view = _queryString(value);
  if (view === 'instances' || view === 'groups') return view;
  return 'all';
}

/** Sanitize error messages for client responses — strip file paths and stack traces */
export function safeError(err: unknown): string {
  const msg = err ? errMsg(err) : 'Internal server error';
  // Strip absolute paths
  return msg.replace(/\/[\w/.-]+/g, '[path]').substring(0, 200);
}

export function stripControlChars(value: unknown): string {
  const input = safeUnknownString(value);
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) {
      continue;
    }
    out += input[i] ?? '';
  }
  return out;
}

export function safeUnknownString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'function') return value.toString();
  return JSON.stringify(value);
}

export function sendErrorWithData(
  res: import('express').Response,
  code: string,
  data: Record<string, unknown>,
  status = 400,
  details?: string,
): void {
  const originalJson = res.json.bind(res);
  res.json = ((payload: unknown) => {
    res.json = originalJson;
    return originalJson({ ...(payload as Record<string, unknown>), ...data });
  }) as typeof res.json;
  sendError(res, code, status, details);
}

/**
 * Extract a curated subset of server settings for the landing page info panel.
 * Keeps the response small — only settings that make sense to display publicly.
 * @param {object} ss — Full server_settings object from bot_state
 * @returns {object} Curated settings for frontend rendering
 */
export function _extractLandingSettings(ss: Record<string, string | undefined> | null): Record<string, unknown> | null {
  if (!ss) return null;
  const n = (k: string, fb: number) => {
    const v = parseFloat(ss[k] ?? '');
    return isNaN(v) ? fb : v;
  };
  const i = (k: string, fb: number) => {
    const v = parseInt(ss[k] ?? '', 10);
    return isNaN(v) ? fb : v;
  };
  return {
    // PvP & death
    pvp: i('PVP', 0),
    onDeath: i('OnDeath', 1),
    friendlyFire: i('FriendlyFire', 0),
    // Difficulty
    zombieHealth: i('ZombieDiffHealth', 2),
    zombieSpeed: i('ZombieDiffSpeed', 2),
    zombieDamage: i('ZombieDiffDamage', 2),
    zombieAmount: n('ZombieAmountMulti', 1),
    banditHealth: i('HumanDiffHealth', 2),
    banditDamage: i('HumanDiffDamage', 2),
    banditAmount: n('HumanAmountMulti', 1),
    aiEvents: i('AIEvent', 2),
    // Loot
    rarityFood: i('RarityFood', 2),
    rarityDrink: i('RarityDrink', 2),
    rarityMelee: i('RarityMelee', 2),
    rarityRanged: i('RarityRanged', 2),
    rarityAmmo: i('RarityAmmo', 2),
    rarityArmor: i('RarityArmor', 2),
    rarityResources: i('RarityResources', 2),
    // World
    xpMultiplier: n('XpMultiplier', 1),
    dayLength: i('DayLength', 40),
    nightLength: i('NightLength', 20),
    daysPerSeason: i('DaysPerSeason', 28),
    startSeason: i('StartSeason', 3),
    // Features
    lootRespawn: i('LootRespawn', 1),
    airDrops: i('AirDrop', 1),
    dogCompanion: i('DogEnabled', 1),
    weaponBreak: i('WeaponBreak', 1),
    foodDecay: n('FoodDecay', 1),
    buildingDecay: i('BuildingDecay', 14),
    maxVehicles: i('MaxVehiclePerPlayer', 2),
    // Enriched world stats (injected by save-service)
    worldStructures: i('hmz_totalStructures', 0) || undefined,
    worldVehicles: i('hmz_totalVehicles', 0) || undefined,
    worldCompanions: i('hmz_totalCompanions', 0) || undefined,
    totalKills: i('hmz_totalKills', 0) || undefined,
  };
}
