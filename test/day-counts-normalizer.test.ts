/**
 * P2-5 — unit tests for normalizeDayCounts (bot_state day_counts read-side guard).
 *
 * The two readers (log-watcher.ts, log-watcher-threads.ts) do arithmetic on the
 * counts values — `(counts[k] ?? 0) + 1` and `reduce((s, v) => s + v)`. A
 * non-number value would corrupt the day's totals via string concatenation, so
 * the normalizer must coerce every count to a finite number on read.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDayCountsDefault, normalizeDayCounts } from '../src/state/bot-state-schemas.js';

describe('normalizeDayCounts', () => {
  it('passes a valid object through with no issues', () => {
    const { shape, issues } = normalizeDayCounts({ date: '2026-06-20', counts: { connects: 3, deaths: 1 } });
    assert.deepEqual(issues, []);
    assert.equal(shape.date, '2026-06-20');
    assert.equal(shape.counts.connects, 3);
    assert.equal(shape.counts.deaths, 1);
    // known keys are always present (the readers merge over a full default)
    assert.equal(shape.counts.pvpKills, 0);
  });

  it('coerces a string count to the default number and records the issue (anti string-concat)', () => {
    const { shape, issues } = normalizeDayCounts({ date: '2026-06-20', counts: { deaths: '5' } });
    assert.equal(typeof shape.counts.deaths, 'number', 'string count must not survive');
    assert.equal(shape.counts.deaths, 0);
    assert.ok(issues.some((i) => i.includes('counts[deaths]')));
    // the whole point: arithmetic on the normalized value stays numeric
    assert.equal(shape.counts.deaths + 1, 1);
  });

  it('drops non-finite numbers (NaN / Infinity)', () => {
    const { shape, issues } = normalizeDayCounts({ counts: { deaths: Infinity, builds: NaN } });
    assert.equal(shape.counts.deaths, 0);
    assert.equal(shape.counts.builds, 0);
    assert.equal(issues.filter((i) => i.includes('finite number')).length, 2);
  });

  it('preserves custom (non-canonical) numeric event keys', () => {
    const { shape, issues } = normalizeDayCounts({ counts: { customEvent: 7 } });
    assert.equal(shape.counts.customEvent, 7);
    assert.deepEqual(issues, []);
  });

  it('substitutes null for a non-string date', () => {
    const { shape, issues } = normalizeDayCounts({ date: 12345, counts: {} });
    assert.equal(shape.date, null);
    assert.ok(issues.some((i) => i.includes('root.date')));
  });

  it('returns a full default when root is not an object', () => {
    const { shape, issues } = normalizeDayCounts(null);
    assert.deepEqual(shape, makeDayCountsDefault());
    assert.ok(issues.includes('root: expected object'));
  });

  it('substitutes defaults when counts is not an object', () => {
    const { shape, issues } = normalizeDayCounts({ date: null, counts: 'oops' });
    assert.equal(shape.counts.connects, 0);
    assert.ok(issues.some((i) => i.includes('root.counts: expected object')));
  });

  it('makeDayCountsDefault returns independent instances (no shared mutation)', () => {
    const a = makeDayCountsDefault();
    a.counts.connects = 99;
    const b = makeDayCountsDefault();
    assert.equal(b.counts.connects, 0);
  });
});
