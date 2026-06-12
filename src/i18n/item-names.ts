/**
 * Locale-aware game item display-name resolution.
 *
 * locales/<lng>/items.json holds a flat map of DT_ItemDatabase row ids (in
 * their original casing) → curated display names for that language. Save
 * files reference the same ids with inconsistent casing ('12g' vs '12G',
 * 'Gasmask2' vs 'GasMask2'), so every lookup is case-insensitive via a
 * lowercase index built once per locale at module load.
 *
 * Resolution chain (per resolveItemName):
 *   1. items namespace for the requested locale (case-insensitive)
 *   2. items namespace for 'en' (case-insensitive)
 *   3. retry 1–2 with the id's trailing duplicate-marker digit stripped
 *      ('Bandage3' → 'Bandage'), mirroring cleanItemName's heuristic
 *   4. cleanItemName(id) fallback (memoized) — heuristic English cleanup
 */
import path from 'node:path';
import fs from 'node:fs';
import { cleanItemNameCached, isHexGuid } from '../parsers/ue4-names.js';
import { getDirname } from '../utils/paths.js';

const __dirname = getDirname(import.meta.url);

const LOCALES_DIR = path.join(__dirname, '../../locales');
const SUPPORTED_LANGS = ['en', 'zh-TW', 'zh-CN'] as const;
type SupportedLang = (typeof SUPPORTED_LANGS)[number];

const ITEM_NAME_INDEX: Record<SupportedLang, Map<string, string>> = {
  en: new Map(),
  'zh-TW': new Map(),
  'zh-CN': new Map(),
};

// Reverse index: lowercased display name (any locale) → canonical raw item id.
// Lets the panel resolve localized labels coming back from the frontend
// (e.g. /api/panel/items/lookup click paths) into the raw ids stored in the
// item tracking DB. First entry wins on collisions (variant items sharing a
// display name), which matches the heuristic nature of name-based lookup.
const ITEM_ID_BY_NAME = new Map<string, string>();
// Also accept raw ids in any casing as input to the reverse lookup.
const ITEM_ID_BY_LOWER_ID = new Map<string, string>();

for (const lng of SUPPORTED_LANGS) {
  try {
    const filePath = path.join(LOCALES_DIR, lng, 'items.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, string>;
    const index = ITEM_NAME_INDEX[lng];
    for (const [id, name] of Object.entries(data)) {
      if (typeof name !== 'string' || !name) continue;
      const lower = id.toLowerCase();
      // First entry wins on (unexpected) case-insensitive collisions.
      if (!index.has(lower)) index.set(lower, name);
      if (!ITEM_ID_BY_LOWER_ID.has(lower)) ITEM_ID_BY_LOWER_ID.set(lower, id);
      const nameLower = name.toLowerCase();
      if (!ITEM_ID_BY_NAME.has(nameLower)) ITEM_ID_BY_NAME.set(nameLower, id);
    }
  } catch {
    // Missing/corrupt locale file → resolution falls through to 'en'/cleanItemName.
  }
}

/**
 * Normalize an arbitrary locale string to a supported language, falling back
 * to 'en'. Accepts common aliases ('zh-Hant' → 'zh-TW', 'zh'/'zh-Hans' → 'zh-CN').
 */
function normalizeItemLocale(locale?: string | null): SupportedLang {
  const raw = typeof locale === 'string' ? locale.trim() : '';
  if (!raw) return 'en';
  if ((SUPPORTED_LANGS as readonly string[]).includes(raw)) return raw as SupportedLang;
  const lower = raw.toLowerCase();
  if (lower === 'zh-tw' || lower.startsWith('zh-hant')) return 'zh-TW';
  if (lower === 'zh-cn' || lower.startsWith('zh-hans') || lower === 'zh') return 'zh-CN';
  if (lower === 'en' || lower.startsWith('en-')) return 'en';
  return 'en';
}

function lookupLocalizedName(lowerId: string, lng: SupportedLang): string | undefined {
  return ITEM_NAME_INDEX[lng].get(lowerId) ?? (lng !== 'en' ? ITEM_NAME_INDEX.en.get(lowerId) : undefined);
}

/**
 * Resolve a raw item id to its localized display name.
 * Unknown ids fall back to the heuristic English cleaner (cleanItemName), so
 * this is always safe to call on item-shaped values.
 */
function resolveItemName(rawId: unknown, locale?: string | null): string {
  if (rawId == null || rawId === '') return cleanItemNameCached(rawId);
  const str =
    typeof rawId === 'string' ? rawId : typeof rawId === 'number' || typeof rawId === 'boolean' ? String(rawId) : '';
  if (!str) return cleanItemNameCached(rawId);
  const lng = normalizeItemLocale(locale);

  let key = str.trim().toLowerCase();
  const direct = lookupLocalizedName(key, lng);
  if (direct) return direct;

  // Mirror cleanItemName's pre-table normalization: full asset paths and
  // trailing 5+ digit numeric instance ids.
  if (key.includes('/')) key = key.slice(key.lastIndexOf('/') + 1).replace(/\.uasset$/, '');
  key = key.replace(/_\d{5,}$/, '');
  const normalized = lookupLocalizedName(key, lng);
  if (normalized) return normalized;

  // Trailing duplicate-marker digit ('bandage3' → 'bandage'); table-backed
  // ids that legitimately end in a digit ('12g', 'gasmask2') hit above first.
  const deduped = key.replace(/([a-z])\d$/, '$1');
  if (deduped !== key) {
    const dedupedName = lookupLocalizedName(deduped, lng);
    if (dedupedName) return dedupedName;
  }

  return cleanItemNameCached(str);
}

interface ItemObject {
  item?: string;
  name?: string;
  [key: string]: unknown;
}

/**
 * Locale-aware counterpart of cleanItemArray — removes hex GUIDs and resolves
 * item names. Mirrors cleanItemArray's shape handling exactly.
 */
function resolveItemArray(items: unknown[], locale?: string | null): unknown[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      if (typeof item === 'string') {
        if (isHexGuid(item)) return null;
        return resolveItemName(item, locale);
      }
      if (item && typeof item === 'object') {
        const obj = item as ItemObject;
        const name = obj.item ?? obj.name ?? '';
        if (isHexGuid(name)) return null;
        return { ...obj, item: resolveItemName(name, locale) };
      }
      return item;
    })
    .filter(Boolean);
}

/**
 * Reverse-resolve a display label (any supported locale) or arbitrarily-cased
 * raw id back to the canonical raw item id stored in save data / the item
 * tracking DB. Returns null when the label is unknown.
 */
function resolveItemId(label: unknown): string | null {
  if (typeof label !== 'string') return null;
  const key = label.trim().toLowerCase();
  if (!key) return null;
  return ITEM_ID_BY_LOWER_ID.get(key) ?? ITEM_ID_BY_NAME.get(key) ?? null;
}

// Hard cap on reverse-search results: a broad query ('a' matches most
// English display names) can return a large share of the item locale table;
// the SQL IN list stays bounded. Exported for tests.
export const SEARCH_ITEM_IDS_LIMIT = 200;

/**
 * Substring counterpart of resolveItemId for search boxes: returns the raw
 * item ids whose display name (any supported locale) contains the query,
 * case-insensitively. Lets a panel search for '繃帶' or 'antiseptic' find
 * rows stored under raw ids ('Bandage', 'BandageAnti') that plain `item LIKE`
 * matching would never reach. Raw-id substring matching is left to the
 * caller's existing `item LIKE` SQL.
 */
function searchItemIds(query: unknown): string[] {
  if (typeof query !== 'string') return [];
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const ids = new Set<string>();
  for (const lng of SUPPORTED_LANGS) {
    for (const [lowerId, name] of ITEM_NAME_INDEX[lng]) {
      if (!name.toLowerCase().includes(needle)) continue;
      const canonical = ITEM_ID_BY_LOWER_ID.get(lowerId);
      if (canonical) ids.add(canonical);
      if (ids.size >= SEARCH_ITEM_IDS_LIMIT) return Array.from(ids);
    }
  }
  return Array.from(ids);
}

export { resolveItemName, resolveItemArray, resolveItemId, searchItemIds, normalizeItemLocale };
