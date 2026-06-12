/**
 * Tests for localized item search (save-audit P2 follow-up): searchItemIds
 * reverse lookup + the item-repository page queries that consume matchedIds,
 * so a panel search for '繃帶' finds rows stored under the raw id 'Bandage'.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import HumanitZDB from '../src/db/database.js';
import { searchItemIds } from '../src/i18n/item-names.js';

describe('searchItemIds', () => {
  it('matches zh-TW display-name substrings to raw ids', () => {
    const ids = searchItemIds('繃帶');
    assert.ok(ids.includes('Bandage'), `expected Bandage in ${JSON.stringify(ids)}`);
    assert.ok(ids.includes('BandageAnti'), 'substring match should also hit 消毒繃帶');
  });

  it('matches English display-name substrings case-insensitively', () => {
    const ids = searchItemIds('BANDAGE');
    assert.ok(ids.includes('Bandage'));
  });

  it('returns empty for blank or non-string input', () => {
    assert.deepEqual(searchItemIds(''), []);
    assert.deepEqual(searchItemIds('   '), []);
    assert.deepEqual(searchItemIds(undefined), []);
    assert.deepEqual(searchItemIds(123), []);
  });

  it('caps broad queries at the documented limit', () => {
    // Single-letter query matches a large share of the item table
    assert.ok(searchItemIds('a').length <= 200);
  });

  it('returns canonical raw ids (original casing)', () => {
    // Exact ids, not a casing heuristic — some table ids are legitimately
    // all-lowercase ('12g'), so asserting the known results is more precise.
    assert.deepEqual(searchItemIds('繃帶').sort(), ['Bandage', 'BandageAnti']);
  });
});

describe('item page search with matchedIds', () => {
  let db: HumanitZDB;

  beforeEach(() => {
    db = new HumanitZDB({ memory: true, label: 'ItemSearchTest' });
    db.init();
    db.item.createItemInstance({
      fingerprint: 'fp-bandage-1',
      item: 'Bandage',
      durability: 100,
      locationType: 'player',
      locationId: '76561198000000001',
    });
    db.item.createItemInstance({
      fingerprint: 'fp-rifle-1',
      item: 'AR15',
      durability: 90,
      locationType: 'container',
      locationId: 'Container_1',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('finds raw-id rows via localized matchedIds even when the raw LIKE misses', () => {
    // '繃帶' never appears in the item column — only the reverse lookup hits
    const rows = db.item.getActiveItemInstancesPage({
      search: '繃帶',
      matchedIds: searchItemIds('繃帶'),
    }) as Array<{ item: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.item, 'Bandage');
  });

  it('keeps plain raw-id substring search working without matchedIds', () => {
    const rows = db.item.getActiveItemInstancesPage({ search: 'AR15' }) as Array<{ item: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.item, 'AR15');
  });

  it('scopes localized search to a location', () => {
    const hit = db.item.getActiveItemInstancesPage({
      search: '繃帶',
      matchedIds: searchItemIds('繃帶'),
      locationType: 'player',
      locationId: '76561198000000001',
    }) as Array<{ item: string }>;
    assert.equal(hit.length, 1);

    const miss = db.item.getActiveItemInstancesPage({
      search: '繃帶',
      matchedIds: searchItemIds('繃帶'),
      locationType: 'container',
      locationId: 'Container_1',
    });
    assert.equal(miss.length, 0);
  });

  it('matches save-file casing variants case-insensitively (12g vs 12G)', () => {
    // 16% of live distinct items drift from the locale table's casing
    // ('12g' vs '12G') — the IN branch must compare NOCASE to reach them.
    db.item.createItemInstance({
      fingerprint: 'fp-shell-1',
      item: '12g',
      durability: 100,
      locationType: 'container',
      locationId: 'Container_3',
    });
    const ids = searchItemIds('鉛徑霰彈');
    assert.ok(ids.includes('12G'), `expected canonical 12G in ${JSON.stringify(ids)}`);
    const rows = db.item.getActiveItemInstancesPage({
      search: '鉛徑霰彈',
      matchedIds: ids,
    }) as Array<{ item: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.item, '12g');
  });

  it('group search accepts matchedIds the same way', () => {
    db.item.upsertItemGroup({
      fingerprint: 'fp-bandage-group',
      item: 'Bandage',
      locationType: 'container',
      locationId: 'Container_2',
      quantity: 5,
    });
    const rows = db.item.getActiveItemGroupsPage({
      search: '繃帶',
      matchedIds: searchItemIds('繃帶'),
    }) as Array<{ item: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.item, 'Bandage');
  });
});
