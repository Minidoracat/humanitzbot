import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const cjsRequire = createRequire(__filename);
const LogWatcher = cjsRequire('../src/modules/log-watcher').default;
const ChatRelay = cjsRequire('../src/modules/chat-relay').default;

// Track instances so we always clear any polling timers a test creates.
type Timer = ReturnType<typeof setInterval>;
type Timed = { interval?: Timer | null; _midnightCheckInterval?: Timer | null; _pollTimer?: Timer | null };
const timers = new Set<Timed>();
function track<T extends Timed>(m: T): T {
  timers.add(m);
  return m;
}
afterEach(() => {
  for (const m of timers) {
    if (m.interval) clearInterval(m.interval);
    if (m._midnightCheckInterval) clearInterval(m._midnightCheckInterval);
    if (m._pollTimer) clearInterval(m._pollTimer);
  }
  timers.clear();
});

const mockClient = (onFetch?: () => unknown) => ({
  on: () => {},
  user: { id: '1' },
  channels: { fetch: async () => (onFetch ? onFetch() : null) },
});

function logConfig(over: Record<string, unknown> = {}) {
  return {
    getToday: () => '2026-01-01',
    getDateLabel: () => '01 Jan 2026',
    useActivityThreads: true,
    logPollInterval: 600000,
    sftpHost: 'x',
    sftpPort: 22,
    sftpUser: 'x',
    sftpPassword: 'x',
    sftpLogPath: '/test',
    sftpConnectLogPath: '/test',
    serverName: '',
    addAdminMembers: async () => {},
    ...over,
  };
}

function chatConfig(over: Record<string, unknown> = {}) {
  return {
    getToday: () => '2026-01-01',
    getDateLabel: () => '01 Jan 2026',
    useChatThreads: true,
    chatPollInterval: 600000,
    serverName: '',
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  LogWatcher headless mode (deployments without LOG_CHANNEL_ID — DB-only)
// ─────────────────────────────────────────────────────────────────────────────
describe('LogWatcher headless mode (no log/admin channel)', () => {
  it('start() selects headless, never fetches a channel, but still polls for DB writes', async () => {
    let fetchCalls = 0;
    const client = mockClient(() => {
      fetchCalls++;
      return null;
    });
    const lw = track(new LogWatcher(client, { config: logConfig({ logChannelId: '', adminChannelId: '' }) }));
    // Avoid real SFTP/network in start() and the poll loop.
    lw._initSize = async () => {};
    lw._poll = async () => {};

    await lw.start();

    assert.strictEqual(lw.isHeadless, true, 'should run headless when no channel configured');
    assert.strictEqual(fetchCalls, 0, 'headless must not fetch a Discord channel');
    assert.ok(lw.interval, 'polling interval should still run so log_*/death_causes data is collected');
  });

  it('non-headless when a log channel is configured', async () => {
    const channel = { id: '123', name: 'log', send: async () => ({}) };
    const lw = track(
      new LogWatcher(
        mockClient(() => channel),
        { config: logConfig({ logChannelId: '123' }) },
      ),
    );
    lw._initSize = async () => {};
    lw._poll = async () => {};
    // Skip the daily-thread bootstrap (network) — only the headless decision matters here.
    lw._getOrCreateDailyThread = async () => null;

    await lw.start();

    assert.strictEqual(lw.isHeadless, false, 'should not be headless when a channel is set');
  });

  it('non-headless when only an admin channel is configured (the module falls back to it)', async () => {
    const channel = { id: '456', name: 'admin', send: async () => ({}) };
    const lw = track(
      new LogWatcher(
        mockClient(() => channel),
        { config: logConfig({ logChannelId: '', adminChannelId: '456' }) },
      ),
    );
    lw._initSize = async () => {};
    lw._poll = async () => {};
    lw._getOrCreateDailyThread = async () => null;

    await lw.start();

    assert.strictEqual(lw.isHeadless, false, 'admin-channel-only config should run non-headless');
  });

  it('headless _getOrCreateDailyThread returns null and never fires the day-rollover callback', async () => {
    const lw = track(new LogWatcher(mockClient(), { config: logConfig() }));
    lw._headless = true;
    lw._dailyDate = '2025-12-31'; // differs from getToday() → would roll over if not headless

    let callbackFired = 0;
    lw.setDayRolloverCallback(async () => {
      callbackFired++;
    });

    const thread = await lw._getOrCreateDailyThread();

    assert.strictEqual(thread, null, 'no daily thread in headless');
    assert.strictEqual(callbackFired, 0, 'day-rollover callback (recap/chat) must not fire in headless');
  });

  it('headless _sendToThread is a no-op and does not throw', async () => {
    const lw = track(new LogWatcher(mockClient(), { config: logConfig() }));
    lw._headless = true;
    const result = await lw._sendToThread({});
    assert.strictEqual(result, undefined, 'headless sendToThread should post nothing');
  });

  it('headless start() sets a day baseline and schedules the midnight rollover check', async () => {
    const saved: Array<{ k: string; v: unknown }> = [];
    const db = {
      botState: { setStateJSON: (k: string, v: unknown) => saved.push({ k, v }), getStateJSON: () => null },
    };
    const lw = track(new LogWatcher(mockClient(), { config: logConfig({ logChannelId: '', adminChannelId: '' }), db }));
    lw._initSize = async () => {};
    lw._poll = async () => {};

    await lw.start();

    assert.strictEqual(lw.isHeadless, true);
    assert.ok(lw._dailyDate, 'headless start should establish a baseline _dailyDate');
    assert.ok(lw._midnightCheckInterval, 'headless should schedule the midnight rollover check');
  });

  it('headless day rollover resets counts without posting a summary or firing the callback', async () => {
    const saved: Array<{ k: string; v: unknown }> = [];
    const db = {
      botState: { setStateJSON: (k: string, v: unknown) => saved.push({ k, v }), getStateJSON: () => null },
    };
    const lw = track(new LogWatcher(mockClient(), { config: logConfig(), db }));
    lw._headless = true;
    lw._dailyDate = '2025-12-31'; // stale vs getToday() → 2026-01-01
    lw._dayCounts = { ...lw._dayCounts, deaths: 5, connects: 3 };
    lw._dayCountsDirty = true;

    let summaryPosted = 0;
    let callbackFired = 0;
    lw._postDailySummary = async () => {
      summaryPosted++;
    };
    lw.setDayRolloverCallback(async () => {
      callbackFired++;
    });

    await lw._checkDayRollover();

    assert.strictEqual(lw._dailyDate, '2026-01-01', 'date advances to today');
    assert.strictEqual(lw._dayCounts.deaths, 0, 'counts reset on rollover');
    assert.strictEqual(lw._dayCounts.connects, 0, 'counts reset on rollover');
    assert.strictEqual(summaryPosted, 0, 'no daily summary is posted in headless');
    assert.strictEqual(callbackFired, 0, 'rollover callback must not fire in headless');
    assert.ok(
      saved.some((s) => s.k === 'day_counts'),
      'reset counts are persisted',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  ChatRelay headless mode (deployments without CHAT_CHANNEL_ID — DB-only)
// ─────────────────────────────────────────────────────────────────────────────
describe('ChatRelay headless mode (no chat/admin channel)', () => {
  it('start() selects headless, never fetches a channel, but still polls RCON for DB writes', async () => {
    let fetchCalls = 0;
    const client = mockClient(() => {
      fetchCalls++;
      return null;
    });
    const cr = track(new ChatRelay(client, { config: chatConfig({ chatChannelId: '', adminChannelId: '' }) }));
    cr._pollChat = async () => {}; // avoid real RCON/network in the poll loop

    await cr.start();

    assert.strictEqual(cr.isHeadless, true, 'should run headless when no channel configured');
    assert.strictEqual(fetchCalls, 0, 'headless must not fetch a Discord channel');
    assert.ok(cr._pollTimer, 'polling timer should still run so chat_log data is collected');
  });

  it('isHeadless reflects the headless flag', () => {
    const cr = track(new ChatRelay(mockClient(), { config: chatConfig() }));
    assert.strictEqual(cr.isHeadless, false);
    cr._headless = true;
    assert.strictEqual(cr.isHeadless, true);
  });

  it('headless _getOrCreateChatThread returns null', async () => {
    const cr = track(new ChatRelay(mockClient(), { config: chatConfig() }));
    cr._headless = true;
    const thread = await cr._getOrCreateChatThread();
    assert.strictEqual(thread, null, 'no chat thread in headless');
  });

  it('still persists chat_log to the DB while headless', () => {
    const inserted: unknown[] = [];
    const db = { chatLog: { insertChat: (e: unknown) => inserted.push(e) } };
    const cr = track(new ChatRelay(mockClient(), { config: chatConfig(), db }));
    cr._headless = true;

    cr._logChat({
      type: 'chat',
      playerName: 'Tester',
      message: 'hello',
      direction: 'inbound',
      isAdmin: false,
    });

    assert.strictEqual(inserted.length, 1, 'chat entry should be written to chat_log even with no Discord channel');
  });

  it('_pollChat polls fetchchat when an RCON host is configured (lets the transport auto-connect), even headless', async () => {
    const sent: string[] = [];
    const rcon = {
      send: async (cmd: string) => {
        sent.push(cmd);
        return '';
      },
    };
    const cr = track(new ChatRelay(mockClient(), { config: chatConfig({ rconHost: 'host' }), rcon }));
    cr._headless = true;

    await cr._pollChat();

    // Host-only gate (no password/connection check): send() drives RconManager's
    // lazy auto-connect (works for TCP and panel RCON); failures are caught quietly.
    assert.ok(sent.includes('fetchchat'), 'should poll fetchchat once an RCON host is configured');
  });

  it('_pollChat skips quietly when no RCON host is configured (first-run setup, no localhost spam)', async () => {
    const sent: string[] = [];
    const rcon = {
      send: async (cmd: string) => {
        sent.push(cmd);
        return '';
      },
    };
    const cr = track(new ChatRelay(mockClient(), { config: chatConfig(), rcon })); // no rconHost
    cr._headless = true;

    await cr._pollChat();

    assert.strictEqual(sent.length, 0, 'must not poll until an RCON host is configured (avoid localhost error spam)');
  });

  it('_pollChat skips the documented placeholder hosts (your_… and your.game.server.ip)', async () => {
    for (const placeholder of ['your.game.server.ip', 'your_rcon_host']) {
      const sent: string[] = [];
      const rcon = {
        send: async (cmd: string) => {
          sent.push(cmd);
          return '';
        },
      };
      const cr = track(new ChatRelay(mockClient(), { config: chatConfig({ rconHost: placeholder }), rcon }));
      cr._headless = true;

      await cr._pollChat();

      assert.strictEqual(sent.length, 0, `must not poll against placeholder host "${placeholder}"`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  ActivityLog with a headless LogWatcher (attribution kept, posting falls back)
// ─────────────────────────────────────────────────────────────────────────────
describe('ActivityLog headless LogWatcher handling', () => {
  const ActivityLog = cjsRequire('../src/modules/activity-log').default;
  const watcher = (over: Record<string, unknown> = {}) => ({
    isHeadless: false,
    interval: 1, // started successfully (truthy poll-interval handle)
    sendToThread: async () => {},
    getRecentContainerAccess: () => null,
    ...over,
  });

  it('_canPostViaLogWatcher requires a started, non-headless watcher', () => {
    const headless = new ActivityLog(mockClient(), { logWatcher: watcher({ isHeadless: true }) });
    const live = new ActivityLog(mockClient(), { logWatcher: watcher({ isHeadless: false }) });
    const failedStart = new ActivityLog(mockClient(), { logWatcher: watcher({ isHeadless: false, interval: null }) });
    const none = new ActivityLog(mockClient(), {});

    assert.strictEqual(headless._canPostViaLogWatcher(), false, 'headless watcher cannot post to a thread');
    assert.strictEqual(live._canPostViaLogWatcher(), true, 'started non-headless watcher posts to its daily thread');
    assert.strictEqual(failedStart._canPostViaLogWatcher(), false, 'a watcher whose start() bailed cannot post');
    assert.strictEqual(none._canPostViaLogWatcher(), false, 'no watcher → use own channel');
  });

  it('still holds the headless watcher reference for container attribution', () => {
    const lw = watcher({ isHeadless: true });
    const al = new ActivityLog(mockClient(), { logWatcher: lw });
    // The watcher is retained (not nulled) so getRecentContainerAccess stays available.
    assert.strictEqual(al._logWatcher, lw, 'headless watcher is kept for attribution');
  });

  it('resolves the fallback channel from injected per-server config, not the global singleton', async () => {
    let fetchedId: string | null = null;
    const client = {
      on: () => {},
      user: { id: '1' },
      channels: {
        fetch: async (id: string) => {
          fetchedId = id;
          return { id, name: 'srv2-activity', send: async () => {} };
        },
      },
    };
    const al = new ActivityLog(client, {
      logWatcher: watcher({ isHeadless: true }), // headless → must use own channel
      config: { activityLogChannelId: 'srv2-chan', adminChannelId: '' },
    });

    await al.start();

    assert.strictEqual(fetchedId, 'srv2-chan', 'must resolve the per-server activity channel, not a global one');
  });

  it('does not latch _started when startup fails, so a later retry can still come up', async () => {
    // No watcher and no fallback channel → start() bails before doing anything.
    const al = new ActivityLog(mockClient(), { config: { activityLogChannelId: '', adminChannelId: '' } });

    await al.start();

    assert.strictEqual(al._started, false, 'a failed start must not latch _started true');
  });
});
