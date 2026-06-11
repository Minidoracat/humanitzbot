/**
 * Tests for the locale-aware item display-name layer:
 *   - locales/<lng>/items.json alignment & key safety across en / zh-TW / zh-CN
 *   - resolveItemName resolution chain (locale → en → cleanItemName fallback)
 *   - case-insensitive lookups for save-file casing drift ('12g', 'Gasmask2')
 *   - glossary consistency for shared word roots
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';

import { resolveItemName, resolveItemArray, resolveItemId, normalizeItemLocale } from '../src/i18n/item-names.js';

import * as _i18n from '../src/i18n/index.js';
const { t } = _i18n as any;

const LOCALES = ['en', 'zh-TW', 'zh-CN'] as const;

function loadItems(lng: string): Record<string, string> {
  const filePath = path.join(__dirname, '..', 'locales', lng, 'items.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

describe('locales items.json data', () => {
  const data: Record<(typeof LOCALES)[number], Record<string, string>> = {
    en: loadItems('en'),
    'zh-TW': loadItems('zh-TW'),
    'zh-CN': loadItems('zh-CN'),
  };

  it('keys are aligned across all three locales', () => {
    const enKeys = Object.keys(data.en).sort();
    for (const lng of ['zh-TW', 'zh-CN'] as const) {
      const keys = Object.keys(data[lng]).sort();
      assert.deepEqual(
        keys,
        enKeys,
        `${lng}/items.json keys diverge from en/items.json (en=${enKeys.length}, ${lng}=${keys.length})`,
      );
    }
  });

  it('has no empty values in any locale', () => {
    for (const lng of LOCALES) {
      const empties = Object.entries(data[lng])
        .filter(([, v]) => typeof v !== 'string' || v.trim() === '')
        .map(([k]) => k);
      assert.equal(empties.length, 0, `${lng}/items.json empty values: ${empties.slice(0, 5).join(', ')}`);
    }
  });

  it('keys never contain i18next separators (. or :)', () => {
    // src/i18n/index.ts registers 'items' as a namespace without overriding
    // keySeparator — ids containing '.'/':' would become unreachable via t().
    const bad = Object.keys(data.en).filter((k) => k.includes('.') || k.includes(':'));
    assert.equal(bad.length, 0, `item ids with separator chars: ${bad.slice(0, 5).join(', ')}`);
  });

  it('keys never collide case-insensitively (lowercase index is lossless)', () => {
    const seen = new Map<string, string>();
    for (const key of Object.keys(data.en)) {
      const lower = key.toLowerCase();
      assert.equal(seen.has(lower), false, `case-insensitive collision: '${key}' vs '${seen.get(lower)}'`);
      seen.set(lower, key);
    }
  });

  it('keeps display names unique per locale, modulo known variant pairs', () => {
    // resolveItemId reverse lookups are first-wins on duplicate labels, so new
    // collisions silently bias lookups — keep them explicit. These pairs are
    // genuine game variants sharing one human label.
    const allowedDuplicateIds = new Set(['BrownPantsShortPockets', 'Canteen1']);
    for (const lng of LOCALES) {
      const seen = new Map<string, string>();
      for (const [id, displayName] of Object.entries(data[lng])) {
        const lower = displayName.toLowerCase();
        const prev = seen.get(lower);
        if (prev !== undefined && !allowedDuplicateIds.has(id)) {
          assert.fail(`${lng}: duplicate display name '${displayName}' for ids '${id}' and '${prev}'`);
        }
        if (prev === undefined) seen.set(lower, id);
      }
    }
  });

  it('keeps shared glossary roots consistent across entries', () => {
    const rules: Array<[RegExp, string, string]> = [
      [/Shells\b/, '霰彈', '霰弹'],
      [/Shotgun\b/, '霰彈槍', '霰弹枪'],
      [/Suppressor\b/, '滅音器', '消音器'],
      [/Walkie/, '無線電對講機', '无线电对讲机'],
      [/^Duct Tape/, '大力膠帶', '强力胶带'],
      [/Screwdriver\b/, '螺絲起子', '螺丝刀'],
    ];
    for (const [enPattern, twTerm, cnTerm] of rules) {
      for (const [id, enName] of Object.entries(data.en)) {
        if (!enPattern.test(enName)) continue;
        const tw = data['zh-TW'][id] || '';
        const cn = data['zh-CN'][id] || '';
        assert.ok(tw.includes(twTerm), `zh-TW '${id}' (${enName}) should contain '${twTerm}', got '${tw}'`);
        assert.ok(cn.includes(cnTerm), `zh-CN '${id}' (${enName}) should contain '${cnTerm}', got '${cn}'`);
      }
    }
  });
});

describe('resolveItemName', () => {
  it('resolves exact ids per locale', () => {
    assert.equal(resolveItemName('12G', 'en'), '12 Gauge Shells');
    assert.equal(resolveItemName('12G', 'zh-TW'), '12 鉛徑霰彈');
    assert.equal(resolveItemName('12G', 'zh-CN'), '12 号口径霰弹');
  });

  it('matches save-file casing drift case-insensitively (audit case: 12g)', () => {
    assert.equal(resolveItemName('12g', 'zh-TW'), '12 鉛徑霰彈');
    assert.equal(resolveItemName('12g', 'en'), '12 Gauge Shells');
  });

  it('matches Gasmask2 → Advanced Gas Mask (audit case, no digit mangling)', () => {
    assert.equal(resolveItemName('Gasmask2', 'en'), 'Advanced Gas Mask');
    assert.equal(resolveItemName('Gasmask2', 'zh-TW'), '進階防毒面具');
    assert.equal(resolveItemName('GASMASK2', 'zh-CN'), '高级防毒面具');
  });

  it('falls back to en for unsupported locales', () => {
    assert.equal(resolveItemName('12G', 'fr'), '12 Gauge Shells');
    assert.equal(resolveItemName('12G'), '12 Gauge Shells');
    assert.equal(resolveItemName('12G', null), '12 Gauge Shells');
  });

  it('accepts common locale aliases', () => {
    assert.equal(resolveItemName('12G', 'zh-Hant'), '12 鉛徑霰彈');
    assert.equal(resolveItemName('12G', 'zh'), '12 号口径霰弹');
    assert.equal(resolveItemName('12G', 'en-US'), '12 Gauge Shells');
  });

  it('falls back to cleanItemName heuristics for unknown ids', () => {
    assert.equal(resolveItemName('BP_WoodenWall_C', 'zh-TW'), 'Wooden Wall');
    assert.equal(resolveItemName('SomeUnknownThing', 'zh-CN'), 'Some Unknown Thing');
  });

  it('returns Unknown for null/empty input', () => {
    assert.equal(resolveItemName(null, 'zh-TW'), 'Unknown');
    assert.equal(resolveItemName('', 'en'), 'Unknown');
    assert.equal(resolveItemName(undefined, 'zh-CN'), 'Unknown');
  });

  it('strips trailing duplicate-marker digits before falling back', () => {
    // 'Bandage3' is not a table id; the resolver retries as 'Bandage'.
    assert.equal(resolveItemName('Bandage3', 'zh-TW'), '繃帶');
    assert.equal(resolveItemName('Bandage3', 'en'), 'Bandage');
  });

  it('strips trailing numeric instance ids before lookup', () => {
    assert.equal(resolveItemName('Bandage_123456', 'zh-TW'), '繃帶');
  });
});

describe('resolveItemArray', () => {
  it('resolves strings and object items, filtering hex GUIDs', () => {
    const input = ['12g', 'abcdef0123456789abcdef0123456789', { item: 'GasMask2', amount: 2 }];
    const out = resolveItemArray(input, 'zh-TW');
    assert.deepEqual(out, ['12 鉛徑霰彈', { item: '進階防毒面具', amount: 2 }]);
  });

  it('returns [] for non-array input', () => {
    assert.deepEqual(resolveItemArray(null as unknown as unknown[], 'en'), []);
  });
});

describe('normalizeItemLocale', () => {
  it('normalizes supported locales, aliases, and garbage', () => {
    assert.equal(normalizeItemLocale('zh-TW'), 'zh-TW');
    assert.equal(normalizeItemLocale(' zh-CN '), 'zh-CN');
    assert.equal(normalizeItemLocale('zh-Hant-TW'), 'zh-TW');
    assert.equal(normalizeItemLocale('zh-Hans'), 'zh-CN');
    assert.equal(normalizeItemLocale('ja'), 'en');
    assert.equal(normalizeItemLocale(undefined), 'en');
  });
});

describe('items i18next namespace', () => {
  it('is registered and reachable via t()', () => {
    assert.equal(t('items:WalkieTalkie', 'zh-TW'), '無線電對講機');
    assert.equal(t('items:WalkieTalkie', 'zh-CN'), '无线电对讲机');
    assert.equal(t('items:12G', 'en'), '12 Gauge Shells');
  });
});

describe('resolveItemId (reverse lookup)', () => {
  it('resolves localized display labels back to the canonical raw id', () => {
    assert.equal(resolveItemId('無線電對講機'), 'WalkieTalkie');
    assert.equal(resolveItemId('无线电对讲机'), 'WalkieTalkie');
    assert.equal(resolveItemId('12 Gauge Shells'), '12G');
  });

  it('accepts raw ids in any casing and round-trips display names', () => {
    assert.equal(resolveItemId('walkietalkie'), 'WalkieTalkie');
    assert.equal(resolveItemId('12g'), '12G');
    // Round-trips return the canonical items.json id casing ('GasMask2'),
    // which may differ from save-file drift ('Gasmask2') — DB lookups that
    // consume this value go through a COLLATE NOCASE query.
    for (const id of ['GasMask2', 'ScrapMetal', 'Bandage']) {
      for (const lng of LOCALES) {
        const roundTripped = resolveItemId(resolveItemName(id, lng));
        assert.equal(roundTripped?.toLowerCase(), id.toLowerCase(), `${id} should round-trip via ${lng}`);
      }
    }
  });

  it('returns null for unknown labels and non-strings', () => {
    assert.equal(resolveItemId('definitely-not-an-item-label'), null);
    assert.equal(resolveItemId(''), null);
    assert.equal(resolveItemId(null), null);
    assert.equal(resolveItemId(42), null);
  });
});
