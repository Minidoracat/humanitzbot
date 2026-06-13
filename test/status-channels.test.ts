import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';

import _status_channels from '../src/modules/status-channels.js';
const StatusChannels = _status_channels as any;

import * as _factories from './helpers/factories.js';
const { mockClient, mockConfig } = _factories as any;

function config(overrides: Record<string, unknown> = {}) {
  return mockConfig({
    guildId: 'guild-1',
    statusChannelInterval: 60_000,
    ...overrides,
  });
}

describe('StatusChannels runtime reconfigure', () => {
  it('resets the active update timer exactly once when STATUS_CHANNEL_INTERVAL changes', () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const scheduled: Array<{ handle: ReturnType<typeof setInterval>; delay?: number }> = [];
    const cleared: Array<ReturnType<typeof setInterval>> = [];
    const oldHandle = { id: 'old' } as unknown as ReturnType<typeof setInterval>;

    globalThis.setInterval = ((handler: (...args: unknown[]) => void, delay?: number) => {
      const handle = { handler, delay } as unknown as ReturnType<typeof setInterval>;
      scheduled.push({ handle, delay });
      return handle;
    }) as typeof setInterval;
    globalThis.clearInterval = ((handle: ReturnType<typeof setInterval>) => {
      cleared.push(handle);
    }) as typeof clearInterval;

    try {
      const cfg = config({ statusChannelInterval: 60_000 });
      const statusChannels = new StatusChannels(mockClient(), { config: cfg });
      statusChannels.interval = oldHandle;
      statusChannels.updateIntervalMs = 60_000;

      statusChannels.reconfigure({ statusChannelInterval: 120_000 });

      assert.equal(statusChannels.updateIntervalMs, 120_000);
      assert.equal(cfg.statusChannelInterval, 120_000);
      assert.deepEqual(cleared, [oldHandle]);
      assert.equal(scheduled.length, 1);
      assert.equal(scheduled[0]?.delay, 120_000);

      statusChannels.reconfigure({ statusChannelInterval: 120_000 });

      assert.equal(scheduled.length, 1);
      assert.equal(cleared.length, 1);

      statusChannels.stop();

      assert.equal(statusChannels.interval, null);
      assert.equal(cleared.length, 2);
      const [scheduledTimer] = scheduled;
      assert.ok(scheduledTimer);
      assert.equal(cleared[1], scheduledTimer.handle);
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  it('keeps STATUS_CHANNEL_INTERVAL at or above the Discord-safe minimum', () => {
    const statusChannels = new StatusChannels(mockClient(), { config: config({ statusChannelInterval: 1_000 }) });

    assert.equal(statusChannels.updateIntervalMs, 60_000);
  });
});

describe('StatusChannels scoped channel discovery (multi-server)', () => {
  const spec = { key: 'players', template: '\u{1F465} Players: {value}' };

  // A guild whose ONLY "👥 Players:" voice channel lives in a DIFFERENT server's
  // category (cat-other), while this server's own category (cat-mine) is empty.
  function guildWithOutsideVoiceOnly() {
    const channels = [
      { type: ChannelType.GuildCategory, id: 'cat-mine', name: '\u{1F4CA} srv2' },
      { type: ChannelType.GuildVoice, id: 'voice-primary', name: '\u{1F465} Players: 5', parentId: 'cat-other' },
    ];
    return { channels: { cache: { find: (fn: (c: unknown) => boolean) => channels.find(fn) } } };
  }

  it('scoped instance does NOT grab a voice channel outside its own category', () => {
    const sc = new StatusChannels(mockClient(), { config: config(), categoryName: '\u{1F4CA} srv2', scoped: true });
    sc.guild = guildWithOutsideVoiceOnly();

    sc._findChannel(spec);

    assert.strictEqual(sc.channels.size, 0, "scoped server must not borrow another server's status channel");
  });

  it('non-scoped (single-server) still falls back to a guild-wide match', () => {
    const sc = new StatusChannels(mockClient(), { config: config(), categoryName: '\u{1F4CA} srv2', scoped: false });
    sc.guild = guildWithOutsideVoiceOnly();

    sc._findChannel(spec);

    assert.strictEqual(sc.channels.size, 1, 'single-server fallback should still resolve the channel');
  });
});
