import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { pvpScheduleLabel } from '../src/modules/auto-messages-content.js';

type AnyCfg = Parameters<typeof pvpScheduleLabel>[0];
const cfg = (overrides: Record<string, unknown>) => overrides as unknown as AnyCfg;

// ── pvpScheduleLabel ─────────────────────────────────────────────────────────

describe('pvpScheduleLabel', () => {
  const base = {
    enablePvpScheduler: true,
    pvpStartMinutes: 1080, // 18:00
    pvpEndMinutes: 1320, // 22:00
    pvpDays: null,
    botTimezone: 'UTC',
  };

  it('renders a window for an enabled schedule with distinct start/end', () => {
    const out = pvpScheduleLabel(cfg({ ...base }));
    assert.match(out, /PvP Schedule: 18:00.22:00 UTC/);
  });

  it('prefixes the active day labels when pvpDays is set', () => {
    const out = pvpScheduleLabel(cfg({ ...base, pvpDays: new Set([1, 3, 5]) }));
    assert.match(out, /Mon, Wed, Fri/);
  });

  it('returns empty when PvP scheduling is disabled', () => {
    assert.equal(pvpScheduleLabel(cfg({ ...base, enablePvpScheduler: false })), '');
  });

  it('returns empty when the times are unset (NaN)', () => {
    assert.equal(pvpScheduleLabel(cfg({ ...base, pvpStartMinutes: NaN, pvpEndMinutes: NaN })), '');
  });

  it('returns empty for a zero-width window so an inherited-but-untimed managed server is not advertised', () => {
    // A managed server inheriting the primary's enablePvpScheduler=true but
    // setting no times of its own has pvpStartMinutes/End = 0 (createServerConfig
    // uses `?? 0`). start===end means the scheduler never runs, so the label must
    // not advertise "00:00–00:00".
    assert.equal(pvpScheduleLabel(cfg({ ...base, pvpStartMinutes: 0, pvpEndMinutes: 0 })), '');
  });
});
