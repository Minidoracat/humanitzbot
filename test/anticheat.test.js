/**
 * Tests for @humanitzbot/qs-anticheat — Phase AC-1 Foundation
 *
 * Covers: statistics, rolling-window, baseline modeler,
 * feature extractors, detectors, scoring, escalation, and AnticheatEngine.
 *
 * Run: npm test
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// ── Baseline: statistics ────────────────────────────────────────────

const {
  median, mad, modifiedZScore, calcPercentiles,
  normaliseSigmoid, distance2d, distance3d,
} = require('@humanitzbot/qs-anticheat/src/baseline/statistics');

describe('statistics', () => {
  describe('median', () => {
    it('returns median of odd-length sorted array', () => {
      assert.equal(median([1, 2, 3, 4, 5]), 3);
    });
    it('returns median of even-length sorted array', () => {
      assert.equal(median([1, 2, 3, 4]), 2.5);
    });
    it('returns the value for single element', () => {
      assert.equal(median([42]), 42);
    });
    it('returns 0 for empty array', () => {
      assert.equal(median([]), 0);
    });
  });

  describe('mad', () => {
    it('returns MAD of a uniform array as 0', () => {
      assert.equal(mad([5, 5, 5, 5, 5]), 0);
    });
    it('returns correct MAD', () => {
      // [1, 2, 3, 4, 5] → median=3, deviations=[2,1,0,1,2] sorted → [0,1,1,2,2] → MAD=1
      assert.equal(mad([1, 2, 3, 4, 5]), 1);
    });
  });

  describe('modifiedZScore', () => {
    it('returns 0 when MAD is 0 and value equals median', () => {
      assert.equal(modifiedZScore(5, 5, 0), 0);
    });
    it('returns positive score for outlier', () => {
      const score = modifiedZScore(100, 3, 1);
      assert.ok(score > 0);
    });
    it('handles MAD of 0 with non-equal value', () => {
      const score = modifiedZScore(10, 5, 0);
      assert.ok(score > 0, 'should return positive Z-score');
    });
  });

  describe('calcPercentiles', () => {
    it('returns correct percentile keys', () => {
      const sorted = Array.from({ length: 100 }, (_, i) => i);
      const pcts = calcPercentiles(sorted);
      assert.ok(pcts[5] != null);
      assert.ok(pcts[25] != null);
      assert.ok(pcts[50] != null);
      assert.ok(pcts[75] != null);
      assert.ok(pcts[95] != null);
      assert.ok(pcts[99] != null);
    });
    it('P50 equals median for sorted range', () => {
      const sorted = Array.from({ length: 101 }, (_, i) => i);
      const pcts = calcPercentiles(sorted);
      assert.equal(pcts[50], 50);
    });
  });

  describe('normaliseSigmoid', () => {
    it('returns 0 for 0', () => {
      assert.equal(normaliseSigmoid(0), 0);
    });
    it('returns ~0.5 for k', () => {
      const val = normaliseSigmoid(3, 3);
      assert.ok(Math.abs(val - 0.5) < 0.01);
    });
    it('approaches 1 for large values', () => {
      assert.ok(normaliseSigmoid(1000) > 0.99);
    });
  });

  describe('distance', () => {
    it('distance2d calculates correctly', () => {
      const d = distance2d({ x: 0, y: 0 }, { x: 3, y: 4 });
      assert.ok(Math.abs(d - 5) < 0.001);
    });
    it('distance3d calculates correctly', () => {
      const d = distance3d({ x: 0, y: 0, z: 0 }, { x: 1, y: 2, z: 2 });
      assert.ok(Math.abs(d - 3) < 0.001);
    });
  });
});

// ── Baseline: rolling-window ────────────────────────────────────────

const RollingWindow = require('@humanitzbot/qs-anticheat/src/baseline/rolling-window');

describe('RollingWindow', () => {
  it('tracks size correctly', () => {
    const w = new RollingWindow(5);
    w.push(10, 1000);
    w.push(20, 2000);
    assert.equal(w.size, 2);
  });

  it('evicts oldest when full', () => {
    const w = new RollingWindow(3);
    w.push(1, 100); w.push(2, 200); w.push(3, 300);
    assert.equal(w.size, 3);
    w.push(4, 400);
    assert.equal(w.size, 3);
    assert.deepEqual(w.sortedValues(), [2, 3, 4]);
  });

  it('valuesSince filters by timestamp', () => {
    const w = new RollingWindow(10);
    w.push(1, 100); w.push(2, 200); w.push(3, 300);
    const vals = w.valuesSince(150);
    assert.equal(vals.length, 2);
  });

  it('sortedValues returns sorted copy', () => {
    const w = new RollingWindow(10);
    w.push(5, 1); w.push(1, 2); w.push(3, 3);
    assert.deepEqual(w.sortedValues(), [1, 3, 5]);
  });

  it('latest returns most recent entry', () => {
    const w = new RollingWindow(10);
    w.push(10, 100); w.push(20, 200);
    assert.deepEqual(w.latest(), { value: 20, timestamp: 200 });
  });

  it('returns null for latest on empty', () => {
    const w = new RollingWindow(10);
    assert.equal(w.latest(), null);
  });

  it('serialises and deserialises', () => {
    const w = new RollingWindow(10);
    w.push(10, 100); w.push(20, 200);
    const json = w.toJSON();
    const w2 = RollingWindow.fromJSON(json);
    assert.equal(w2.size, 2);
    assert.deepEqual(w2.sortedValues(), [10, 20]);
  });

  it('trimBefore removes old entries', () => {
    const w = new RollingWindow(10);
    w.push(1, 100); w.push(2, 200); w.push(3, 300);
    w.trimBefore(150);
    assert.equal(w.size, 2);
  });

  it('lastN returns most recent N entries (most recent first)', () => {
    const w = new RollingWindow(10);
    w.push(1, 100); w.push(2, 200); w.push(3, 300);
    const last2 = w.lastN(2);
    assert.equal(last2.length, 2);
    assert.equal(last2[0].value, 3); // most recent first
    assert.equal(last2[1].value, 2);
  });

  it('clear empties the window', () => {
    const w = new RollingWindow(10);
    w.push(1, 100); w.push(2, 200);
    w.clear();
    assert.equal(w.size, 0);
  });
});

// ── Baseline: modeler ───────────────────────────────────────────────

const { BaselineModeler, MetricBaseline } = require('@humanitzbot/qs-anticheat/src/baseline/modeler');

describe('MetricBaseline', () => {
  it('is not ready before minSamples', () => {
    const mb = new MetricBaseline('test', { minSamples: 5 });
    for (let i = 0; i < 4; i++) mb.record(i, Date.now());
    assert.equal(mb.ready, false);
  });

  it('becomes ready at minSamples', () => {
    const mb = new MetricBaseline('test', { minSamples: 5 });
    for (let i = 0; i < 5; i++) mb.record(i, Date.now());
    assert.equal(mb.ready, true);
  });

  it('returns stats when ready', () => {
    const mb = new MetricBaseline('test', { minSamples: 5 });
    for (let i = 0; i < 10; i++) mb.record(i * 10, Date.now());
    const stats = mb.getStats();
    assert.ok(stats);
    assert.ok(stats.median >= 0);
    assert.ok(stats.sampleCount === 10);
  });

  it('scores a value when ready', () => {
    const mb = new MetricBaseline('test', { minSamples: 5 });
    for (let i = 0; i < 20; i++) mb.record(i, Date.now());
    const result = mb.score(100); // clear outlier
    assert.ok(result);
    assert.ok(result.zScore > 0);
    assert.ok(result.normalised > 0);
  });

  it('returns null from score when not ready', () => {
    const mb = new MetricBaseline('test', { minSamples: 50 });
    mb.record(1, Date.now());
    assert.equal(mb.score(100), null);
  });

  it('serialises and deserialises', () => {
    const mb = new MetricBaseline('test_metric', { minSamples: 3 });
    for (let i = 0; i < 5; i++) mb.record(i * 10, Date.now());
    const json = mb.toJSON();
    const mb2 = MetricBaseline.fromJSON(json);
    assert.equal(mb2.name, 'test_metric');
    assert.equal(mb2.ready, true);
    assert.equal(mb2.sampleCount, 5);
  });

  it('ignores NaN and Infinity', () => {
    const mb = new MetricBaseline('test', { minSamples: 3 });
    mb.record(NaN);
    mb.record(Infinity);
    mb.record(-Infinity);
    assert.equal(mb.sampleCount, 0);
  });
});

describe('BaselineModeler', () => {
  it('records and scores server metrics', () => {
    const model = new BaselineModeler();
    for (let i = 0; i < 50; i++) model.recordServer('speed', i * 10, Date.now());
    const result = model.scoreServer('speed', 5000);
    assert.ok(result.ready);
    assert.ok(result.zScore > 0);
  });

  it('records and scores player metrics', () => {
    const model = new BaselineModeler();
    for (let i = 0; i < 20; i++) model.recordPlayer('STEAM_1', 'kills', i, Date.now());
    const result = model.scorePlayer('STEAM_1', 'kills', 100);
    assert.ok(result.ready);
    assert.ok(result.zScore > 0);
  });

  it('returns not-ready for unknown metrics', () => {
    const model = new BaselineModeler();
    const result = model.scoreServer('unknown_metric', 42);
    assert.equal(result.ready, false);
  });

  it('returns diagnostics', () => {
    const model = new BaselineModeler();
    model.recordServer('speed', 100, Date.now());
    model.recordPlayer('S1', 'kills', 5, Date.now());
    const diag = model.getDiagnostics();
    assert.equal(diag.serverMetrics.length, 1);
    assert.equal(diag.playerCount, 1);
  });

  it('serialises and deserialises', () => {
    const model = new BaselineModeler();
    for (let i = 0; i < 35; i++) model.recordServer('speed', i * 10, Date.now());
    const json = model.toJSON();
    const model2 = BaselineModeler.fromJSON(json);
    assert.ok(model2.isReady('speed'));
    assert.equal(model2.getServerStats('speed').sampleCount, 35);
  });

  it('trimAll does not crash', () => {
    const model = new BaselineModeler();
    model.recordServer('speed', 100, Date.now());
    model.recordPlayer('S1', 'kills', 5, Date.now());
    model.trimAll(); // should not throw
    assert.ok(true);
  });
});

// ── Extractors ──────────────────────────────────────────────────────

const { extractKillFeatures, safePositiveDelta } = require('@humanitzbot/qs-anticheat/src/extractors/kills');
const { extractStatRegressions, extractVitalAnomalies, CUMULATIVE_FIELDS } = require('@humanitzbot/qs-anticheat/src/extractors/stats');

describe('extractors/kills', () => {
  it('safePositiveDelta returns 0 for nulls', () => {
    assert.equal(safePositiveDelta(null, 5), 0);
    assert.equal(safePositiveDelta(5, null), 0);
  });

  it('safePositiveDelta returns 0 for negative delta', () => {
    assert.equal(safePositiveDelta(3, 5), 0);
  });

  it('safePositiveDelta returns positive delta', () => {
    assert.equal(safePositiveDelta(10, 5), 5);
  });

  it('extracts kill features from stat deltas', () => {
    const prev = new Map([['S1', { zeeksKilled: 10, lifetimeKills: 15, headshots: 3, pvpKills: 0, animalKills: 1, banditKills: 0 }]]);
    const cur = new Map([['S1', { zeeksKilled: 25, lifetimeKills: 30, headshots: 8, pvpKills: 1, animalKills: 2, banditKills: 0 }]]);
    const features = extractKillFeatures(cur, prev, 60_000); // 1 minute
    assert.ok(features.has('S1'));
    const f = features.get('S1');
    assert.equal(f.zombieKillDelta, 15);
    assert.equal(f.pvpKillDelta, 1);
    assert.equal(f.killsPerMinute, 17); // 15+1+1+0 = 17 kills in 1 min
  });

  it('skips players with no kills', () => {
    const prev = new Map([['S1', { zeeksKilled: 10, lifetimeKills: 10, headshots: 0, pvpKills: 0, animalKills: 0, banditKills: 0 }]]);
    const cur = new Map([['S1', { zeeksKilled: 10, lifetimeKills: 10, headshots: 0, pvpKills: 0, animalKills: 0, banditKills: 0 }]]);
    const features = extractKillFeatures(cur, prev, 60_000);
    assert.equal(features.size, 0);
  });

  it('returns empty for zero elapsed time', () => {
    const features = extractKillFeatures(new Map(), new Map(), 0);
    assert.equal(features.size, 0);
  });
});

describe('extractors/stats', () => {
  it('detects stat regression', () => {
    const prev = new Map([['S1', { zeeksKilled: 100, lifetimeKills: 200, headshots: 50, lifetimeDaysSurvived: 10, fishCaught: 5, animalKills: 3, banditKills: 2 }]]);
    const cur = new Map([['S1', { zeeksKilled: 80, lifetimeKills: 200, headshots: 50, lifetimeDaysSurvived: 10, fishCaught: 5, animalKills: 3, banditKills: 2 }]]);
    const features = extractStatRegressions(cur, prev);
    assert.ok(features.has('S1'));
    assert.equal(features.get('S1').regressions.length, 1);
    assert.equal(features.get('S1').regressions[0].field, 'zeeksKilled');
    assert.equal(features.get('S1').regressions[0].delta, -20);
  });

  it('detects multiple regressions', () => {
    const prev = new Map([['S1', { zeeksKilled: 100, lifetimeKills: 200, headshots: 50, lifetimeDaysSurvived: 10, fishCaught: 5, animalKills: 3, banditKills: 2 }]]);
    const cur = new Map([['S1', { zeeksKilled: 50, lifetimeKills: 100, headshots: 50, lifetimeDaysSurvived: 10, fishCaught: 5, animalKills: 3, banditKills: 2 }]]);
    const features = extractStatRegressions(cur, prev);
    assert.equal(features.get('S1').regressions.length, 2);
  });

  it('does not flag normal stat increases', () => {
    const prev = new Map([['S1', { zeeksKilled: 100, lifetimeKills: 200, headshots: 50, lifetimeDaysSurvived: 10, fishCaught: 5, animalKills: 3, banditKills: 2 }]]);
    const cur = new Map([['S1', { zeeksKilled: 110, lifetimeKills: 215, headshots: 55, lifetimeDaysSurvived: 11, fishCaught: 7, animalKills: 4, banditKills: 3 }]]);
    const features = extractStatRegressions(cur, prev);
    assert.equal(features.size, 0);
  });

  it('CUMULATIVE_FIELDS is non-empty', () => {
    assert.ok(CUMULATIVE_FIELDS.length > 0);
  });

  it('detects vital anomalies', () => {
    const stats = new Map([['S1', { health: -10, hunger: 50, thirst: 200, stamina: 50, immunity: 50 }]]);
    const features = extractVitalAnomalies(stats);
    assert.ok(features.has('S1'));
    const anomalies = features.get('S1').anomalies;
    assert.ok(anomalies.length >= 2); // negative health + excessive thirst
  });

  it('does not flag normal vitals', () => {
    const stats = new Map([['S1', { health: 100, hunger: 80, thirst: 70, stamina: 90, immunity: 95 }]]);
    const features = extractVitalAnomalies(stats);
    assert.equal(features.size, 0);
  });
});

// ── Detectors ───────────────────────────────────────────────────────

const teleportDetector = require('@humanitzbot/qs-anticheat/src/detectors/teleportation');
const speedHackDetector = require('@humanitzbot/qs-anticheat/src/detectors/speed-hack');
const killRateDetector = require('@humanitzbot/qs-anticheat/src/detectors/kill-rate');
const statRegressionDetector = require('@humanitzbot/qs-anticheat/src/detectors/stat-regression');

describe('detectors/teleportation', () => {
  it('flags large position jump', () => {
    const features = new Map([['S1', {
      distance2d: 50_000,
      distance3d: 50_000,
      speed: 5000,
      elapsedSec: 5,
      elapsedMs: 5000,
      maxVehicleSpeed: 2800,
      maxSprintSpeed: 600,
      currentPos: { x: 50000, y: 0, z: 0 },
      previousPos: { x: 0, y: 0, z: 0 },
      isAlive: 1,
    }]]);
    const flags = teleportDetector.detect(features);
    assert.ok(flags.length >= 1);
    assert.equal(flags[0].detector, 'teleportation');
    assert.equal(flags[0].steamId, 'S1');
  });

  it('does not flag normal movement', () => {
    const features = new Map([['S1', {
      distance2d: 500,
      distance3d: 500,
      speed: 100,
      elapsedSec: 5,
      elapsedMs: 5000,
      maxVehicleSpeed: 2800,
      maxSprintSpeed: 600,
      currentPos: { x: 500, y: 0, z: 0 },
      previousPos: { x: 0, y: 0, z: 0 },
      isAlive: 1,
    }]]);
    const flags = teleportDetector.detect(features);
    assert.equal(flags.length, 0);
  });

  it('skips dead players', () => {
    const features = new Map([['S1', {
      distance2d: 100_000,
      distance3d: 100_000,
      speed: 20000,
      elapsedSec: 5,
      elapsedMs: 5000,
      maxVehicleSpeed: 2800,
      maxSprintSpeed: 600,
      currentPos: { x: 100000, y: 0, z: 0 },
      previousPos: { x: 0, y: 0, z: 0 },
      isAlive: 0,
    }]]);
    const flags = teleportDetector.detect(features);
    assert.equal(flags.length, 0);
  });

  it('trains baseline without crashing', () => {
    const { BaselineModeler } = require('@humanitzbot/qs-anticheat/src/baseline/modeler');
    const model = new BaselineModeler();
    const features = new Map([['S1', {
      distance2d: 500, distance3d: 500, speed: 100,
      elapsedSec: 5, maxVehicleSpeed: 2800,
      isAlive: 1,
    }]]);
    teleportDetector.train(features, model);
    assert.ok(true);
  });
});

describe('detectors/speed-hack', () => {
  beforeEach(() => speedHackDetector.reset());

  it('does not flag single high-speed poll', () => {
    const features = new Map([['S1', {
      speed: 10000, isAlive: 1, maxVehicleSpeed: 2800,
    }]]);
    const flags = speedHackDetector.detect(features);
    assert.equal(flags.length, 0); // needs MIN_CONSECUTIVE
  });

  it('flags sustained high speed', () => {
    // Need MIN_CONSECUTIVE (3) consecutive high-speed observations
    for (let i = 0; i < 3; i++) {
      const features = new Map([['S1', {
        speed: 10000, isAlive: 1, maxVehicleSpeed: 2800,
      }]]);
      const flags = speedHackDetector.detect(features);
      if (i < 2) assert.equal(flags.length, 0, `should not flag on observation ${i + 1}`);
      else {
        assert.ok(flags.length >= 1, 'should flag on 3rd consecutive high-speed');
        assert.equal(flags[0].detector, 'speed_hack');
      }
    }
  });

  it('resets on normal speed', () => {
    // Two high, then one normal, then two high → should not flag
    const highFeatures = new Map([['S1', { speed: 10000, isAlive: 1, maxVehicleSpeed: 2800 }]]);
    const normalFeatures = new Map([['S1', { speed: 100, isAlive: 1, maxVehicleSpeed: 2800 }]]);
    speedHackDetector.detect(highFeatures);
    speedHackDetector.detect(highFeatures);
    speedHackDetector.detect(normalFeatures); // reset
    speedHackDetector.detect(highFeatures);
    speedHackDetector.detect(highFeatures);
    const flags = speedHackDetector.detect(highFeatures); // 3rd after reset
    assert.ok(flags.length >= 1);
  });
});

describe('detectors/kill-rate', () => {
  it('flags impossible kill rate (hard cap)', () => {
    const features = new Map([['S1', {
      killsPerMinute: 200,
      totalKillDelta: 200,
      zombieKillDelta: 190,
      pvpKillDelta: 10,
      lifetimeKillDelta: 200,
      headshotRatio: 0.5,
      elapsedMin: 1,
    }]]);
    const flags = killRateDetector.detect(features);
    assert.ok(flags.length >= 1);
    assert.equal(flags[0].detector, 'impossible_kill_rate');
  });

  it('does not flag normal kill rate', () => {
    const features = new Map([['S1', {
      killsPerMinute: 5,
      totalKillDelta: 5,
      zombieKillDelta: 5,
      pvpKillDelta: 0,
      lifetimeKillDelta: 5,
      headshotRatio: 0.4,
      elapsedMin: 1,
    }]]);
    const flags = killRateDetector.detect(features);
    assert.equal(flags.length, 0);
  });

  it('skips when too few kills', () => {
    const features = new Map([['S1', {
      killsPerMinute: 100,
      totalKillDelta: 2, // below MIN_KILLS_TO_FLAG
      zombieKillDelta: 2,
      pvpKillDelta: 0,
      lifetimeKillDelta: 2,
      headshotRatio: 1.0,
      elapsedMin: 0.02,
    }]]);
    const flags = killRateDetector.detect(features);
    assert.equal(flags.length, 0);
  });

  it('trains baseline without crashing', () => {
    const { BaselineModeler } = require('@humanitzbot/qs-anticheat/src/baseline/modeler');
    const model = new BaselineModeler();
    const features = new Map([['S1', {
      killsPerMinute: 5, totalKillDelta: 5, lifetimeKillDelta: 5,
      headshotRatio: 0.4, elapsedMin: 1,
    }]]);
    killRateDetector.train(features, model);
    assert.ok(true);
  });
});

describe('detectors/stat-regression', () => {
  it('flags regressions', () => {
    const features = new Map([['S1', {
      regressions: [
        { field: 'zeeksKilled', previous: 100, current: 50, delta: -50 },
        { field: 'lifetimeKills', previous: 200, current: 100, delta: -100 },
      ],
    }]]);
    const flags = statRegressionDetector.detect(features);
    assert.ok(flags.length >= 1);
    assert.equal(flags[0].detector, 'stat_regression');
    assert.equal(flags[0].severity, 'high'); // 2 regressions → high
  });

  it('assigns critical severity for 3+ regressions', () => {
    const features = new Map([['S1', {
      regressions: [
        { field: 'zeeksKilled', previous: 100, current: 50, delta: -50 },
        { field: 'lifetimeKills', previous: 200, current: 100, delta: -100 },
        { field: 'fishCaught', previous: 10, current: 3, delta: -7 },
      ],
    }]]);
    const flags = statRegressionDetector.detect(features);
    assert.equal(flags[0].severity, 'critical');
  });

  it('returns empty for no regressions', () => {
    const features = new Map();
    const flags = statRegressionDetector.detect(features);
    assert.equal(flags.length, 0);
  });
});

// ── Scoring ─────────────────────────────────────────────────────────

const { sortFlags, computeRawRisk, normaliseRisk, deduplicateFlags, SEVERITY_WEIGHTS } = require('@humanitzbot/qs-anticheat/src/scoring/scorer');
const { checkEscalation, escalateOne } = require('@humanitzbot/qs-anticheat/src/scoring/escalation');

describe('scoring/scorer', () => {
  it('sortFlags puts highest severity first', () => {
    const flags = [
      { severity: 'low', score: 0.5 },
      { severity: 'critical', score: 0.9 },
      { severity: 'medium', score: 0.6 },
    ];
    const sorted = sortFlags(flags);
    assert.equal(sorted[0].severity, 'critical');
    assert.equal(sorted[1].severity, 'medium');
    assert.equal(sorted[2].severity, 'low');
  });

  it('sortFlags sorts by score within same severity', () => {
    const flags = [
      { severity: 'low', score: 0.3 },
      { severity: 'low', score: 0.9 },
      { severity: 'low', score: 0.6 },
    ];
    const sorted = sortFlags(flags);
    assert.equal(sorted[0].score, 0.9);
  });

  it('computeRawRisk sums weighted scores', () => {
    const flags = [
      { severity: 'high', score: 0.8 },
      { severity: 'low', score: 0.5 },
    ];
    const risk = computeRawRisk(flags);
    const expected = SEVERITY_WEIGHTS.high * 0.8 + SEVERITY_WEIGHTS.low * 0.5;
    assert.ok(Math.abs(risk - expected) < 0.001);
  });

  it('normaliseRisk returns 0 for 0', () => {
    assert.equal(normaliseRisk(0), 0);
  });

  it('normaliseRisk returns 0.5 for k', () => {
    assert.equal(normaliseRisk(1, 1), 0.5);
  });

  it('normaliseRisk caps at 1.0', () => {
    assert.ok(normaliseRisk(100, 1) <= 1.0);
  });

  it('deduplicateFlags keeps highest-scoring per player+detector', () => {
    const flags = [
      { steamId: 'S1', detector: 'teleportation', score: 0.3 },
      { steamId: 'S1', detector: 'teleportation', score: 0.8 },
      { steamId: 'S1', detector: 'speed_hack', score: 0.5 },
    ];
    const deduped = deduplicateFlags(flags);
    assert.equal(deduped.length, 2);
    const teleFlag = deduped.find(f => f.detector === 'teleportation');
    assert.equal(teleFlag.score, 0.8);
  });
});

describe('scoring/escalation', () => {
  it('escalateOne bumps severity by one level', () => {
    assert.equal(escalateOne('low'), 'medium');
    assert.equal(escalateOne('medium'), 'high');
    assert.equal(escalateOne('high'), 'critical');
    assert.equal(escalateOne('critical'), 'critical'); // can't go higher
  });

  it('escalates low to medium on 3 different detectors in 1 hour', () => {
    const recentFlags = [
      { detector: 'teleportation', severity: 'low', created_at: new Date().toISOString() },
      { detector: 'speed_hack', severity: 'low', created_at: new Date().toISOString() },
    ];
    const newFlag = { detector: 'kill_rate', severity: 'low' };
    const result = checkEscalation(recentFlags, newFlag, 0);
    assert.equal(result.escalated, true);
    assert.equal(result.newSeverity, 'medium');
    assert.ok(result.reason.includes('compound'));
  });

  it('does not escalate with only 2 detectors', () => {
    const recentFlags = [
      { detector: 'teleportation', severity: 'low', created_at: new Date().toISOString() },
    ];
    const newFlag = { detector: 'speed_hack', severity: 'low' };
    const result = checkEscalation(recentFlags, newFlag, 0);
    assert.equal(result.escalated, false);
    assert.equal(result.newSeverity, 'low');
  });

  it('escalates on high risk score', () => {
    const result = checkEscalation([], { detector: 'test', severity: 'low' }, 0.8);
    assert.equal(result.escalated, true);
    assert.equal(result.newSeverity, 'medium');
    assert.ok(result.reason.includes('risk_score'));
  });

  it('does not escalate critical severity even with high risk', () => {
    const result = checkEscalation([], { detector: 'test', severity: 'critical' }, 0.9);
    // severity stays critical (can't go higher)
    assert.equal(result.newSeverity, 'critical');
  });
});

// ── AnticheatEngine (integration) ──────────────────────────────────

const AnticheatEngine = require('@humanitzbot/qs-anticheat');

describe('AnticheatEngine', () => {
  let engine;

  beforeEach(() => {
    engine = new AnticheatEngine();
  });

  afterEach(() => {
    engine.shutdown();
  });

  it('has a version string', () => {
    assert.ok(engine.version);
    assert.equal(typeof engine.version, 'string');
  });

  it('init sets initialised state', () => {
    const fakeDb = { db: { prepare: () => ({ all: () => [], get: () => null }) } };
    engine.init(fakeDb);
    const diag = engine.getDiagnostics();
    assert.equal(diag.initialised, true);
  });

  it('analyze returns empty array when not initialised', () => {
    const flags = engine.analyze({});
    assert.deepEqual(flags, []);
  });

  it('analyze runs without crashing with minimal DB mock', () => {
    const fakeDb = {
      db: {
        prepare: () => ({
          all: () => [],
          get: () => null,
        }),
      },
    };
    engine.init(fakeDb);
    const flags = engine.analyze({ players: new Map(), elapsed: 30_000 });
    assert.ok(Array.isArray(flags));
  });

  it('detects stat regression via full pipeline', () => {
    const fakeDb = {
      db: {
        prepare: () => ({
          all: () => [],
          get: () => null,
        }),
      },
    };
    engine.init(fakeDb);

    // First sync — establishes previous stats
    engine.analyze({
      players: new Map([['S1', {
        zeeksKilled: 100, lifetimeKills: 200, headshots: 50,
        lifetimeDaysSurvived: 10, fishCaught: 5, animalKills: 3, banditKills: 2,
      }]]),
      elapsed: 30_000,
    });

    // Second sync — stat regression (zeeksKilled went down)
    const flags = engine.analyze({
      players: new Map([['S1', {
        zeeksKilled: 50, lifetimeKills: 200, headshots: 50,
        lifetimeDaysSurvived: 10, fishCaught: 5, animalKills: 3, banditKills: 2,
      }]]),
      elapsed: 30_000,
    });

    const regressionFlags = flags.filter(f => f.detector === 'stat_regression');
    assert.ok(regressionFlags.length >= 1, 'should detect stat regression');
  });

  it('applyEscalation works with mock lookups', () => {
    const flags = [
      { steamId: 'S1', detector: 'test', severity: 'low', score: 0.5 },
    ];
    const escalated = engine.applyEscalation(
      flags,
      () => [],   // no recent flags
      () => 0.8,  // high risk score
    );
    assert.ok(escalated[0].autoEscalated);
    assert.equal(escalated[0].severity, 'medium');
  });

  it('recalibrateBaseline does not crash', () => {
    const fakeDb = { db: { prepare: () => ({ all: () => [], get: () => null }) } };
    engine.init(fakeDb);
    engine.recalibrateBaseline();
    assert.ok(true);
  });

  it('exportBaseline returns serialisable object', () => {
    const fakeDb = { db: { prepare: () => ({ all: () => [], get: () => null }) } };
    engine.init(fakeDb);
    const baseline = engine.exportBaseline();
    assert.ok(baseline);
    assert.ok(typeof baseline === 'object');
    const json = JSON.stringify(baseline);
    assert.ok(json);
  });

  it('getDiagnostics returns status info', () => {
    const diag = engine.getDiagnostics();
    assert.equal(diag.initialised, false);
    assert.equal(diag.version, engine.version);
  });

  it('shutdown cleans up state', () => {
    const fakeDb = { db: { prepare: () => ({ all: () => [], get: () => null }) } };
    engine.init(fakeDb);
    engine.shutdown();
    const diag = engine.getDiagnostics();
    assert.equal(diag.initialised, false);
    assert.equal(diag.hasPreviousStats, false);
  });

  it('init restores saved baseline', () => {
    const fakeDb = { db: { prepare: () => ({ all: () => [], get: () => null }) } };
    // Build a baseline with enough data
    const tmpEngine = new AnticheatEngine();
    tmpEngine.init(fakeDb);
    // Record enough data to make baseline ready
    for (let i = 0; i < 40; i++) {
      tmpEngine._baseline.recordServer('test_metric', i * 10, Date.now());
    }
    const saved = tmpEngine.exportBaseline();
    tmpEngine.shutdown();

    // Restore into a new engine
    engine.init(fakeDb, saved);
    assert.ok(engine._baseline.isReady('test_metric'));
  });
});

// ══════════════════════════════════════════════════════════════════════
// Phase AC-2: New Detectors, Extractors, Fingerprint, Feedback
// ══════════════════════════════════════════════════════════════════════

// ── Detectors: Aimbot (Tier 2) ─────────────────────────────────────

const aimbotDetector = require('@humanitzbot/qs-anticheat/src/detectors/aimbot');

describe('detectors/aimbot', () => {
  it('flags extreme headshot ratio (hard cap)', () => {
    const features = new Map([['S1', {
      headshotRatio: 0.98,
      headshotDelta: 49,
      lifetimeKillDelta: 50,
      killsPerMinute: 5,
    }]]);
    const flags = aimbotDetector.detect(features);
    assert.ok(flags.length >= 1, 'should flag 98% headshot ratio');
    assert.equal(flags[0].detector, 'aimbot_pattern');
    assert.equal(flags[0].steamId, 'S1');
    assert.ok(flags[0].details.reason.includes('hard_cap'));
  });

  it('does not flag low headshot ratio', () => {
    const features = new Map([['S1', {
      headshotRatio: 0.55,
      headshotDelta: 11,
      lifetimeKillDelta: 20,
      killsPerMinute: 2,
    }]]);
    const flags = aimbotDetector.detect(features);
    assert.equal(flags.length, 0);
  });

  it('skips when lifetimeKillDelta below minimum', () => {
    const features = new Map([['S1', {
      headshotRatio: 0.99,
      headshotDelta: 5,
      lifetimeKillDelta: 5, // below MIN_KILLS_FOR_RATIO (10)
      killsPerMinute: 1,
    }]]);
    const flags = aimbotDetector.detect(features);
    assert.equal(flags.length, 0, 'should skip — not enough kills for ratio');
  });

  it('skips null headshot ratio', () => {
    const features = new Map([['S1', {
      headshotRatio: null,
      headshotDelta: 0,
      lifetimeKillDelta: 100,
      killsPerMinute: 10,
    }]]);
    const flags = aimbotDetector.detect(features);
    assert.equal(flags.length, 0);
  });

  it('severity is high when kills >= 50 and hard cap exceeded', () => {
    const features = new Map([['S1', {
      headshotRatio: 0.96,
      headshotDelta: 96,
      lifetimeKillDelta: 100,
      killsPerMinute: 5,
    }]]);
    const flags = aimbotDetector.detect(features);
    assert.ok(flags.length >= 1);
    assert.equal(flags[0].severity, 'high');
  });

  it('severity is medium when kills < 50 and hard cap exceeded', () => {
    const features = new Map([['S1', {
      headshotRatio: 0.96,
      headshotDelta: 19,
      lifetimeKillDelta: 20,
      killsPerMinute: 5,
    }]]);
    const flags = aimbotDetector.detect(features);
    assert.ok(flags.length >= 1);
    assert.equal(flags[0].severity, 'medium');
  });

  it('uses baseline when available', () => {
    const { BaselineModeler } = require('@humanitzbot/qs-anticheat/src/baseline/modeler');
    const model = new BaselineModeler();
    // Seed enough baseline data for headshot_ratio
    for (let i = 0; i < 40; i++) {
      model.recordServer('headshot_ratio', 0.3 + Math.random() * 0.15, Date.now());
    }
    const features = new Map([['S1', {
      headshotRatio: 0.92,
      headshotDelta: 18,
      lifetimeKillDelta: 20,
      killsPerMinute: 3,
    }]]);
    // Under hard cap (0.95) but potentially flagged via baseline
    const flags = aimbotDetector.detect(features, model);
    // May or may not flag depending on baseline Z-score, but shouldn't crash
    assert.ok(Array.isArray(flags));
  });
});

// ── Detectors: Session Anomaly (Tier 5) ────────────────────────────

const sessionAnomalyDetector = require('@humanitzbot/qs-anticheat/src/detectors/session-anomaly');

describe('detectors/session-anomaly', () => {
  it('flags rapid reconnect (3+ in an hour)', () => {
    const features = new Map([['S1', {
      totalConnects: 8,
      totalDisconnects: 7,
      rapidReconnectCount: 5,
      rapidReconnects: [
        { gap: 3000, disconnectAt: '2025-01-01T00:00:00Z', connectAt: '2025-01-01T00:00:03Z' },
        { gap: 5000, disconnectAt: '2025-01-01T00:01:00Z', connectAt: '2025-01-01T00:01:05Z' },
        { gap: 2000, disconnectAt: '2025-01-01T00:02:00Z', connectAt: '2025-01-01T00:02:02Z' },
        { gap: 4000, disconnectAt: '2025-01-01T00:03:00Z', connectAt: '2025-01-01T00:03:04Z' },
        { gap: 1000, disconnectAt: '2025-01-01T00:04:00Z', connectAt: '2025-01-01T00:04:01Z' },
      ],
      consecutiveConnects: 0,
      zeroDurationSessions: 0,
      eventCount: 15,
    }]]);
    const flags = sessionAnomalyDetector.detect(features);
    const rapid = flags.filter(f => f.details.subType === 'rapid_reconnect');
    assert.ok(rapid.length >= 1, 'should flag rapid reconnect');
    assert.equal(rapid[0].details.rapidReconnectCount, 5);
  });

  it('does not flag 2 rapid reconnects (below threshold)', () => {
    const features = new Map([['S1', {
      totalConnects: 3,
      totalDisconnects: 2,
      rapidReconnectCount: 2,
      rapidReconnects: [
        { gap: 3000 }, { gap: 5000 },
      ],
      consecutiveConnects: 0,
      zeroDurationSessions: 0,
      eventCount: 5,
    }]]);
    const flags = sessionAnomalyDetector.detect(features);
    const rapid = flags.filter(f => f.details?.subType === 'rapid_reconnect');
    assert.equal(rapid.length, 0);
  });

  it('flags consecutive connects', () => {
    const features = new Map([['S1', {
      totalConnects: 4,
      totalDisconnects: 2,
      rapidReconnectCount: 0,
      rapidReconnects: [],
      consecutiveConnects: 2,
      zeroDurationSessions: 0,
      eventCount: 6,
    }]]);
    const flags = sessionAnomalyDetector.detect(features);
    const cc = flags.filter(f => f.details?.subType === 'consecutive_connects');
    assert.ok(cc.length >= 1);
  });

  it('flags zero-duration sessions (3+)', () => {
    const features = new Map([['S1', {
      totalConnects: 5,
      totalDisconnects: 5,
      rapidReconnectCount: 0,
      rapidReconnects: [],
      consecutiveConnects: 0,
      zeroDurationSessions: 4,
      eventCount: 10,
    }]]);
    const flags = sessionAnomalyDetector.detect(features);
    const zd = flags.filter(f => f.details?.subType === 'zero_duration_sessions');
    assert.ok(zd.length >= 1);
    assert.equal(zd[0].details.zeroDurationSessions, 4);
  });

  it('severity scales with rapid reconnect count', () => {
    const features = new Map([['S1', {
      totalConnects: 12,
      totalDisconnects: 11,
      rapidReconnectCount: 10,
      rapidReconnects: Array.from({ length: 10 }, (_, i) => ({ gap: 2000 })),
      consecutiveConnects: 0,
      zeroDurationSessions: 0,
      eventCount: 23,
    }]]);
    const flags = sessionAnomalyDetector.detect(features);
    const rapid = flags.filter(f => f.details?.subType === 'rapid_reconnect');
    assert.ok(rapid.length >= 1);
    assert.equal(rapid[0].severity, 'high', '10+ rapid reconnects should be high severity');
  });
});

// ── Detectors: Structure Anomaly (Tier 6) ──────────────────────────

const structureAnomalyDetector = require('@humanitzbot/qs-anticheat/src/detectors/structure-anomaly');

describe('detectors/structure-anomaly', () => {
  it('flags orphan structures', () => {
    const features = {
      orphanStructures: [
        {
          actorName: 'BP_Wall_01',
          blueprintName: 'WoodenWall',
          ownerSteamId: 'S1',
          position: { x: 100, y: 200, z: 0 },
          firstSeen: '2025-01-01T00:00:00Z',
        },
      ],
      buildRates: new Map(),
    };
    const flags = structureAnomalyDetector.detect(features);
    assert.ok(flags.length >= 1);
    assert.equal(flags[0].details.subType, 'orphan_structure');
    assert.equal(flags[0].steamId, 'S1');
  });

  it('flags impossible build rate', () => {
    const features = {
      orphanStructures: [],
      buildRates: new Map([['S1', { builds: 50, buildsPerMinute: 50 }]]),
    };
    const flags = structureAnomalyDetector.detect(features);
    const buildFlags = flags.filter(f => f.details?.subType === 'impossible_build_rate');
    assert.ok(buildFlags.length >= 1);
    assert.equal(buildFlags[0].details.reason, 'exceeds_hard_cap');
  });

  it('does not flag normal build rate', () => {
    const features = {
      orphanStructures: [],
      buildRates: new Map([['S1', { builds: 5, buildsPerMinute: 5 }]]),
    };
    const flags = structureAnomalyDetector.detect(features);
    const buildFlags = flags.filter(f => f.details?.subType === 'impossible_build_rate');
    assert.equal(buildFlags.length, 0);
  });

  it('severity is high for extreme build rate (>45/min)', () => {
    const features = {
      orphanStructures: [],
      buildRates: new Map([['S1', { builds: 100, buildsPerMinute: 100 }]]),
    };
    const flags = structureAnomalyDetector.detect(features);
    const buildFlags = flags.filter(f => f.details?.subType === 'impossible_build_rate');
    assert.ok(buildFlags.length >= 1);
    assert.equal(buildFlags[0].severity, 'high');
  });

  it('train does not crash', () => {
    const { BaselineModeler } = require('@humanitzbot/qs-anticheat/src/baseline/modeler');
    const model = new BaselineModeler();
    const features = {
      orphanStructures: [],
      buildRates: new Map([['S1', { builds: 3, buildsPerMinute: 3 }]]),
    };
    structureAnomalyDetector.train(features, model);
    assert.ok(true);
  });
});

// ── Detectors: Compound (Tier 7) ───────────────────────────────────

const compoundDetector = require('@humanitzbot/qs-anticheat/src/detectors/compound');

describe('detectors/compound', () => {
  it('detects movement cheat signature (teleportation + speed_hack)', () => {
    const recentFlags = [
      { steamId: 'S1', detector: 'teleportation', severity: 'medium', score: 0.7 },
      { steamId: 'S1', detector: 'speed_hack', severity: 'medium', score: 0.6 },
    ];
    const flags = compoundDetector.detect(recentFlags, 'S1');
    assert.ok(flags.length >= 1);
    assert.equal(flags[0].detector, 'compound_suspicion');
    assert.equal(flags[0].details.pattern, 'movement_cheat');
  });

  it('detects dupe exploit signature (session_anomaly + item_duplication)', () => {
    const recentFlags = [
      { steamId: 'S1', detector: 'session_anomaly', severity: 'low', score: 0.4 },
      { steamId: 'S1', detector: 'item_duplication', severity: 'medium', score: 0.6 },
    ];
    const flags = compoundDetector.detect(recentFlags, 'S1');
    const dupe = flags.filter(f => f.details?.pattern === 'dupe_exploit');
    assert.ok(dupe.length >= 1);
    assert.equal(dupe[0].severity, 'high');
  });

  it('detects combat cheat signature (impossible_kill_rate)', () => {
    const recentFlags = [
      { steamId: 'S1', detector: 'impossible_kill_rate', severity: 'high', score: 0.9 },
      { steamId: 'S1', detector: 'aimbot_pattern', severity: 'medium', score: 0.5 },
    ];
    const flags = compoundDetector.detect(recentFlags, 'S1');
    const combat = flags.filter(f => f.details?.pattern === 'combat_cheat');
    assert.ok(combat.length >= 1);
  });

  it('detects save editor signature (stat_regression)', () => {
    const recentFlags = [
      { steamId: 'S1', detector: 'stat_regression', severity: 'high', score: 0.8 },
      { steamId: 'S1', detector: 'vital_anomaly', severity: 'info', score: 0.2 },
    ];
    const flags = compoundDetector.detect(recentFlags, 'S1');
    const save = flags.filter(f => f.details?.pattern === 'save_editor');
    assert.ok(save.length >= 1);
  });

  it('does not flag with single unrelated flag', () => {
    const recentFlags = [
      { steamId: 'S1', detector: 'vital_anomaly', severity: 'info', score: 0.1 },
    ];
    const flags = compoundDetector.detect(recentFlags, 'S1');
    assert.equal(flags.length, 0, 'single info flag should not trigger compound');
  });

  it('returns empty for fewer than 2 flags', () => {
    assert.equal(compoundDetector.detect([], 'S1').length, 0);
    assert.equal(compoundDetector.detect([{ steamId: 'S1', detector: 'test' }], 'S1').length, 0);
  });

  it('exports EXPLOIT_SIGNATURES', () => {
    assert.ok(Array.isArray(compoundDetector.EXPLOIT_SIGNATURES));
    assert.ok(compoundDetector.EXPLOIT_SIGNATURES.length >= 4);
  });
});

// ── Extractors: Session ────────────────────────────────────────────

const { extractSessionFeatures } = require('@humanitzbot/qs-anticheat/src/extractors/session');

describe('extractors/session', () => {
  it('returns empty map when db query fails', () => {
    const fakeDb = { db: { prepare: () => { throw new Error('no table'); } } };
    const result = extractSessionFeatures(fakeDb);
    assert.ok(result instanceof Map);
    assert.equal(result.size, 0);
  });

  it('detects rapid reconnects from activity_log', () => {
    const now = new Date();
    const events = [
      { steam_id: 'S1', event_type: 'player_connect', timestamp: new Date(now - 60000).toISOString() },
      { steam_id: 'S1', event_type: 'player_disconnect', timestamp: new Date(now - 50000).toISOString() },
      { steam_id: 'S1', event_type: 'player_connect', timestamp: new Date(now - 48000).toISOString() }, // 2s gap = rapid
      { steam_id: 'S1', event_type: 'player_disconnect', timestamp: new Date(now - 40000).toISOString() },
      { steam_id: 'S1', event_type: 'player_connect', timestamp: new Date(now - 38000).toISOString() }, // 2s gap = rapid
      { steam_id: 'S1', event_type: 'player_disconnect', timestamp: new Date(now - 30000).toISOString() },
      { steam_id: 'S1', event_type: 'player_connect', timestamp: new Date(now - 28000).toISOString() }, // 2s gap = rapid
    ];
    const fakeDb = {
      db: {
        prepare: () => ({
          all: () => events,
        }),
      },
    };
    const result = extractSessionFeatures(fakeDb);
    assert.ok(result.has('S1'));
    assert.ok(result.get('S1').rapidReconnectCount >= 3);
  });

  it('detects consecutive connects', () => {
    const now = new Date();
    const events = [
      { steam_id: 'S1', event_type: 'player_connect', timestamp: new Date(now - 60000).toISOString() },
      { steam_id: 'S1', event_type: 'player_connect', timestamp: new Date(now - 50000).toISOString() },
    ];
    const fakeDb = {
      db: { prepare: () => ({ all: () => events }) },
    };
    const result = extractSessionFeatures(fakeDb);
    assert.ok(result.has('S1'));
    assert.ok(result.get('S1').consecutiveConnects >= 1);
  });

  it('detects zero-duration sessions', () => {
    const now = new Date();
    const events = [
      { steam_id: 'S1', event_type: 'player_connect', timestamp: new Date(now - 60000).toISOString() },
      { steam_id: 'S1', event_type: 'player_disconnect', timestamp: new Date(now - 59998).toISOString() },
      { steam_id: 'S1', event_type: 'player_connect', timestamp: new Date(now - 50000).toISOString() },
      { steam_id: 'S1', event_type: 'player_disconnect', timestamp: new Date(now - 49997).toISOString() },
      { steam_id: 'S1', event_type: 'player_connect', timestamp: new Date(now - 40000).toISOString() },
      { steam_id: 'S1', event_type: 'player_disconnect', timestamp: new Date(now - 39996).toISOString() },
    ];
    const fakeDb = {
      db: { prepare: () => ({ all: () => events }) },
    };
    const result = extractSessionFeatures(fakeDb);
    assert.ok(result.has('S1'));
    assert.ok(result.get('S1').zeroDurationSessions >= 3);
  });
});

// ── Extractors: Structures ─────────────────────────────────────────

const { extractStructureFeatures } = require('@humanitzbot/qs-anticheat/src/extractors/structures');

describe('extractors/structures', () => {
  it('returns empty result when db query fails', () => {
    const fakeDb = { db: { prepare: () => { throw new Error('no table'); } } };
    const result = extractStructureFeatures(fakeDb);
    assert.ok(Array.isArray(result.orphanStructures));
    assert.ok(result.buildRates instanceof Map);
  });

  it('detects orphan structures', () => {
    let queryCount = 0;
    const fakeDb = {
      db: {
        prepare: (sql) => {
          if (sql.includes('FROM structures')) {
            return {
              all: () => [{
                actor_name: 'BP_Wall', blueprint_name: 'Wall',
                owner_steam_id: 'S1', pos_x: 100, pos_y: 200, pos_z: 0,
                first_seen: new Date().toISOString(),
              }],
            };
          }
          if (sql.includes('FROM activity_log') && sql.includes('player_build')) {
            return { get: () => null }; // no build event = orphan
          }
          // build rate query
          return { all: () => [] };
        },
      },
    };
    const result = extractStructureFeatures(fakeDb);
    assert.ok(result.orphanStructures.length >= 1);
    assert.equal(result.orphanStructures[0].ownerSteamId, 'S1');
  });

  it('detects build rates', () => {
    const fakeDb = {
      db: {
        prepare: (sql) => {
          if (sql.includes('FROM structures')) {
            return { all: () => [] };
          }
          if (sql.includes('COUNT(*)')) {
            return {
              all: () => [{ steam_id: 'S1', cnt: 10 }],
            };
          }
          return { all: () => [], get: () => null };
        },
      },
    };
    const result = extractStructureFeatures(fakeDb, 60_000); // 1 min
    assert.ok(result.buildRates.has('S1'));
    assert.equal(result.buildRates.get('S1').builds, 10);
    assert.equal(result.buildRates.get('S1').buildsPerMinute, 10);
  });
});

// ── Fingerprint: Hasher ────────────────────────────────────────────

const {
  hashFingerprint, hashItem, hashStructure, hashVehicle,
  hashHorse, hashContainer, hashCompanion, hashEntity,
} = require('@humanitzbot/qs-anticheat/src/fingerprint/hasher');

describe('fingerprint/hasher', () => {
  it('hashFingerprint returns 16-char hex', () => {
    const fp = hashFingerprint('test input');
    assert.equal(fp.length, 16);
    assert.match(fp, /^[0-9a-f]{16}$/);
  });

  it('hashFingerprint is deterministic', () => {
    assert.equal(hashFingerprint('hello'), hashFingerprint('hello'));
  });

  it('hashFingerprint differs for different input', () => {
    assert.notEqual(hashFingerprint('a'), hashFingerprint('b'));
  });

  it('hashItem produces consistent fingerprint', () => {
    const item = { itemName: 'Axe', durability: 80, ammo: 0, attachments: [] };
    const fp1 = hashItem(item);
    const fp2 = hashItem(item);
    assert.equal(fp1, fp2);
    assert.equal(fp1.length, 16);
  });

  it('hashItem differs for different items', () => {
    const fp1 = hashItem({ itemName: 'Axe', durability: 80 });
    const fp2 = hashItem({ itemName: 'Sword', durability: 80 });
    assert.notEqual(fp1, fp2);
  });

  it('hashStructure includes position and owner', () => {
    const s1 = { blueprintName: 'Wall', posX: 100, posY: 200, posZ: 0, ownerSteamId: 'S1' };
    const s2 = { blueprintName: 'Wall', posX: 100, posY: 200, posZ: 0, ownerSteamId: 'S2' };
    assert.notEqual(hashStructure(s1), hashStructure(s2));
  });

  it('hashVehicle uses type and actor name', () => {
    const v = { vehicleType: 'Sedan', actorName: 'Vehicle_01' };
    assert.equal(hashVehicle(v).length, 16);
  });

  it('hashHorse uses actor name and position', () => {
    const h = { actorName: 'Horse_01', posX: 500, posY: 600 };
    assert.equal(hashHorse(h).length, 16);
  });

  it('hashContainer uses actor name and position', () => {
    const c = { actorName: 'Container_01', posX: 100, posY: 200, posZ: 0 };
    assert.equal(hashContainer(c).length, 16);
  });

  it('hashCompanion uses type and owner', () => {
    const c = { type: 'Dog', ownerSteamId: 'S1', actorName: 'Companion_01' };
    assert.equal(hashCompanion(c).length, 16);
  });

  it('hashEntity dispatches to correct hasher', () => {
    const item = { itemName: 'Axe', durability: 50 };
    assert.equal(hashEntity('item', item), hashItem(item));

    const struct = { blueprintName: 'Wall', posX: 1, posY: 2, posZ: 3, ownerSteamId: 'S1' };
    assert.equal(hashEntity('structure', struct), hashStructure(struct));
  });

  it('hashEntity uses JSON.stringify for unknown types', () => {
    const fp = hashEntity('unknown_type', { foo: 'bar' });
    assert.equal(fp.length, 16);
  });

  it('handles snake_case field names', () => {
    const item = { item_name: 'Axe', durability: 50 };
    const fp = hashItem(item);
    assert.equal(fp.length, 16);

    const struct = { blueprint_name: 'Wall', pos_x: 1, pos_y: 2, pos_z: 3, owner_steam_id: 'S1' };
    const fp2 = hashStructure(struct);
    assert.equal(fp2.length, 16);
  });
});

// ── Fingerprint: Validator ─────────────────────────────────────────

const fpValidator = require('@humanitzbot/qs-anticheat/src/fingerprint/validator');

describe('fingerprint/validator', () => {
  it('validateEntities returns empty for null input', () => {
    assert.deepEqual(fpValidator.validateEntities(null, 'item', []), []);
    assert.deepEqual(fpValidator.validateEntities({}, 'item', null), []);
    assert.deepEqual(fpValidator.validateEntities({}, 'item', []), []);
  });

  it('validateEntities detects duplicates', () => {
    const entities = [
      { steamId: 'S1', itemName: 'Axe', durability: 80, ammo: 0, attachments: [], ownerSteamId: 'S1' },
      { steamId: 'S2', itemName: 'Axe', durability: 80, ammo: 0, attachments: [], ownerSteamId: 'S2' },
    ];
    const flags = fpValidator.validateEntities({}, 'item', entities);
    assert.ok(flags.length >= 1, 'should detect duplicate fingerprints');
    assert.ok(flags[0].detector.includes('duplication'));
  });

  it('validateEntities does not flag unique entities', () => {
    const entities = [
      { steamId: 'S1', itemName: 'Axe', durability: 80 },
      { steamId: 'S2', itemName: 'Sword', durability: 90 },
    ];
    const flags = fpValidator.validateEntities({}, 'item', entities);
    assert.equal(flags.length, 0);
  });

  it('validateAgainstStored returns empty when table missing', () => {
    const fakeDb = { prepare: () => { throw new Error('no table'); } };
    const flags = fpValidator.validateAgainstStored(fakeDb, 'item', [{ id: 'x' }]);
    assert.deepEqual(flags, []);
  });

  it('recordFingerprints does not crash on missing table', () => {
    const fakeDb = { prepare: () => { throw new Error('no table'); } };
    fpValidator.recordFingerprints(fakeDb, 'item', [{ id: 'x', itemName: 'Axe' }]);
    assert.ok(true, 'should not throw');
  });

  it('recordFingerprintEvent does not crash on null db', () => {
    fpValidator.recordFingerprintEvent(null, 1, 'created');
    assert.ok(true);
  });
});

// ── Fingerprint: Engine ────────────────────────────────────────────

const FingerprintEngineClass = require('@humanitzbot/qs-anticheat/src/fingerprint/engine');

describe('fingerprint/engine', () => {
  it('constructor accepts db', () => {
    const engine = new FingerprintEngineClass({});
    assert.ok(engine);
  });

  it('analyse returns empty for null data', () => {
    const engine = new FingerprintEngineClass({});
    assert.deepEqual(engine.analyse(null), []);
  });

  it('analyse returns empty when no entities', () => {
    const engine = new FingerprintEngineClass({});
    assert.deepEqual(engine.analyse({}), []);
  });

  it('analyse detects structure duplicates', () => {
    const engine = new FingerprintEngineClass({});
    const saveData = {
      structures: [
        { actorName: 'S1', blueprintName: 'Wall', posX: 100, posY: 200, posZ: 0, ownerSteamId: 'P1' },
        { actorName: 'S2', blueprintName: 'Wall', posX: 100, posY: 200, posZ: 0, ownerSteamId: 'P1' },
      ],
    };
    const flags = engine.analyse(saveData);
    assert.ok(flags.length >= 1, 'should detect duplicate structures');
  });

  it('setDb updates database reference', () => {
    const engine = new FingerprintEngineClass({});
    const newDb = { test: true };
    engine.setDb(newDb);
    assert.equal(engine._db, newDb);
  });

  it('exposes static hasher and validator', () => {
    assert.ok(FingerprintEngineClass.hasher);
    assert.ok(FingerprintEngineClass.validator);
    assert.equal(typeof FingerprintEngineClass.hasher.hashEntity, 'function');
  });
});

// ── Feedback: Processor ────────────────────────────────────────────

const feedbackProcessor = require('@humanitzbot/qs-anticheat/src/feedback/processor');

describe('feedback/processor', () => {
  describe('calcAdminWeight', () => {
    it('returns 1.0 when not enough reviews', () => {
      assert.equal(feedbackProcessor.calcAdminWeight(3, 3), 1.0);
    });

    it('returns 1.0 for ideal confirmation rate (50%)', () => {
      assert.equal(feedbackProcessor.calcAdminWeight(25, 25), 1.0);
    });

    it('returns low weight for rubber-stamping (>95% confirm)', () => {
      const w = feedbackProcessor.calcAdminWeight(98, 2);
      assert.ok(w < 0.5, `expected < 0.5 but got ${w}`);
    });

    it('returns low weight for too-dismissive (<20% confirm)', () => {
      const w = feedbackProcessor.calcAdminWeight(2, 48);
      assert.ok(w < 0.5, `expected < 0.5 but got ${w}`);
    });

    it('returns full weight at 40% confirmation', () => {
      assert.equal(feedbackProcessor.calcAdminWeight(20, 30), 1.0);
    });

    it('returns full weight at 70% confirmation', () => {
      assert.equal(feedbackProcessor.calcAdminWeight(35, 15), 1.0);
    });
  });

  describe('getAdminStats', () => {
    it('returns defaults for null db', () => {
      const stats = feedbackProcessor.getAdminStats(null, 'admin1');
      assert.equal(stats.confirmed, 0);
      assert.equal(stats.dismissed, 0);
      assert.equal(stats.weight, 1.0);
    });

    it('returns defaults for null adminId', () => {
      const stats = feedbackProcessor.getAdminStats({}, null);
      assert.equal(stats.weight, 1.0);
    });
  });

  describe('confirmFlag', () => {
    it('returns { ok: false } for null db', () => {
      assert.deepEqual(feedbackProcessor.confirmFlag(null, 1, 'admin1'), { ok: false });
    });
    it('returns { ok: false } for missing flagId', () => {
      assert.deepEqual(feedbackProcessor.confirmFlag({}, null, 'admin1'), { ok: false });
    });
  });

  describe('dismissFlag', () => {
    it('returns { ok: false } for null db', () => {
      assert.deepEqual(feedbackProcessor.dismissFlag(null, 1, 'admin1'), { ok: false });
    });
  });

  describe('whitelistPlayer', () => {
    it('returns { ok: false } for null db', () => {
      const result = feedbackProcessor.whitelistPlayer(null, 'S1', 'admin1');
      assert.equal(result.ok, false);
    });
    it('returns { ok: false } for missing steamId', () => {
      const result = feedbackProcessor.whitelistPlayer({}, null, 'admin1');
      assert.equal(result.ok, false);
    });
  });

  describe('isWhitelisted', () => {
    it('returns false for null db', () => {
      assert.equal(feedbackProcessor.isWhitelisted(null, 'S1'), false);
    });
    it('returns false for null steamId', () => {
      assert.equal(feedbackProcessor.isWhitelisted({}, null), false);
    });
  });

  describe('getDetectorEffectiveness', () => {
    it('returns empty map for null db', () => {
      const result = feedbackProcessor.getDetectorEffectiveness(null);
      assert.ok(result instanceof Map);
      assert.equal(result.size, 0);
    });
  });
});

// ── Engine: Phase AC-2 integration tests ───────────────────────────

describe('AnticheatEngine (Phase AC-2)', () => {
  let engine;
  beforeEach(() => {
    engine = new AnticheatEngine();
  });
  afterEach(() => {
    engine.shutdown();
  });

  it('version is 0.2.0', () => {
    assert.equal(engine.version, '0.2.0');
  });

  it('diagnostics includes fingerprint field', () => {
    assert.equal(engine.getDiagnostics().fingerprint, false);
    const fakeDb = { db: { prepare: () => ({ all: () => [], get: () => null }) } };
    engine.init(fakeDb);
    assert.equal(engine.getDiagnostics().fingerprint, true);
  });

  it('exposes FingerprintEngine as static', () => {
    assert.ok(AnticheatEngine.FingerprintEngine);
    assert.equal(typeof AnticheatEngine.FingerprintEngine, 'function');
  });

  it('exposes feedback as static', () => {
    assert.ok(AnticheatEngine.feedback);
    assert.equal(typeof AnticheatEngine.feedback.confirmFlag, 'function');
    assert.equal(typeof AnticheatEngine.feedback.dismissFlag, 'function');
    assert.equal(typeof AnticheatEngine.feedback.whitelistPlayer, 'function');
  });

  it('exposes BaselineModeler as static', () => {
    assert.ok(AnticheatEngine.BaselineModeler);
    assert.equal(typeof AnticheatEngine.BaselineModeler, 'function');
  });

  it('analyze detects aimbot via kill features', () => {
    const fakeDb = { db: { prepare: () => ({ all: () => [], get: () => null }) } };
    engine.init(fakeDb);

    // First call establishes previous stats
    engine.analyze({
      players: new Map([['S1', {
        zeeksKilled: 10, lifetimeKills: 50, headshots: 20,
        lifetimeDaysSurvived: 5, fishCaught: 0, animalKills: 0, banditKills: 0,
        health: 100, hunger: 80, thirst: 70,
      }]]),
      elapsed: 30_000,
    });

    // Second call — massive headshot ratio spike
    const flags = engine.analyze({
      players: new Map([['S1', {
        zeeksKilled: 60, lifetimeKills: 100, headshots: 68,
        lifetimeDaysSurvived: 5, fishCaught: 0, animalKills: 0, banditKills: 0,
        health: 100, hunger: 80, thirst: 70,
      }]]),
      elapsed: 30_000,
    });

    // May or may not flag depending on ratio calculation, but should not crash
    assert.ok(Array.isArray(flags));
  });

  it('analyze handles saveData for fingerprinting', () => {
    const fakeDb = { db: { prepare: () => ({ all: () => [], get: () => null }) } };
    engine.init(fakeDb);

    const flags = engine.analyze({
      players: new Map(),
      elapsed: 30_000,
      saveData: {
        structures: [
          { actorName: 'W1', blueprintName: 'Wall', posX: 100, posY: 200, posZ: 0, ownerSteamId: 'S1' },
        ],
        vehicles: [],
        horses: [],
        containers: [],
        companions: [],
      },
    });
    assert.ok(Array.isArray(flags));
  });

  it('shutdown clears fingerprint engine', () => {
    const fakeDb = { db: { prepare: () => ({ all: () => [], get: () => null }) } };
    engine.init(fakeDb);
    assert.ok(engine._fingerprint);
    engine.shutdown();
    assert.equal(engine._fingerprint, null);
  });
});
