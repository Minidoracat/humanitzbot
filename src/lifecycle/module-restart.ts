/**
 * Module-restart lifecycle — start/stop the three runtime-toggleable modules
 * (Status Channels, Server Status, Player Stats), their per-module reconfigure
 * registration, the serialized restart queues, and the feature-toggle restart
 * handlers. Extracted verbatim from src/index.ts (P1-1b god-file split); the
 * only change is module state is threaded through the explicit `ctx` parameter.
 *
 * Load-bearing details preserved exactly:
 * - restart-queue reassignments stay on `ctx.*RestartQueue` (serialization is
 *   type-invisible — dropping `ctx.` would silently break toggle ordering);
 * - the rollback `if (ctx.x === nextX) ctx.x = undefined` identity checks guard
 *   against a concurrent restart swapping the instance mid-start;
 * - reconfigure callbacks read `ctx.x?.reconfigure` live (the current instance),
 *   never a frozen snapshot.
 */
import type { Client } from 'discord.js';
import config, { setConfigValue } from '../config/index.js';
import StatusChannels from '../modules/status-channels.js';
import ServerStatus from '../modules/server-status.js';
import PlayerStatsChannel from '../modules/player-stats-channel.js';
import panelApi from '../server/panel-api.js';
import { hasSftp, coerceRuntimeBoolean } from '../runtime/helpers.js';
import { errMsg } from '../utils/error.js';
import type { AppContext } from '../runtime/app-context.js';

const STATUS_CHANNELS_RUNTIME_OWNER = 'module:status-channels';
const SERVER_STATUS_RUNTIME_OWNER = 'module:server-status';
const PLAYER_STATS_RUNTIME_OWNER = 'module:player-stats';

export function setStatus(ctx: AppContext, name: string, status: string): void {
  ctx.moduleStatus[name] = status;
  if (ctx.botStatusManager) ctx.botStatusManager.refreshNow().catch(() => {});
}

function enqueueStatusChannelsRestart(ctx: AppContext, operation: () => Promise<void>): Promise<void> {
  const next = ctx.statusChannelsRestartQueue.catch(() => undefined).then(operation);
  ctx.statusChannelsRestartQueue = next.catch(() => undefined);
  return next;
}

function enqueueServerStatusRestart(ctx: AppContext, operation: () => Promise<void>): Promise<void> {
  const next = ctx.serverStatusRestartQueue.catch(() => undefined).then(operation);
  ctx.serverStatusRestartQueue = next.catch(() => undefined);
  return next;
}

function enqueuePlayerStatsRestart(ctx: AppContext, operation: () => Promise<void>): Promise<void> {
  const next = ctx.playerStatsRestartQueue.catch(() => undefined).then(operation);
  ctx.playerStatsRestartQueue = next.catch(() => undefined);
  return next;
}

export function scheduleDiscordDisplayRefresh(ctx: AppContext): void {
  if (ctx.displayRefreshTimer) return;

  ctx.displayRefreshTimer = setTimeout(() => {
    ctx.displayRefreshTimer = undefined;
    if (ctx.serverStatus) {
      void ctx.serverStatus._update().catch((err: unknown) => {
        console.warn('[BOT] Failed to refresh server status after display config change:', errMsg(err));
      });
    }
    if (ctx.playerStatsChannel) {
      void ctx.playerStatsChannel._updateEmbed().catch((err: unknown) => {
        console.warn('[BOT] Failed to refresh player stats after display config change:', errMsg(err));
      });
    }
  }, 0);
}

export async function startStatusChannelsModule(ctx: AppContext, readyClient: Client): Promise<void> {
  if (ctx.statusChannelsStartPromise) return ctx.statusChannelsStartPromise;
  if (ctx.statusChannels) return;

  ctx.statusChannelsStartPromise = (async () => {
    const categoryHint = config.serverName;
    const nextStatusChannels = new StatusChannels(readyClient, { categoryName: categoryHint });
    ctx.statusChannels = nextStatusChannels;
    try {
      await nextStatusChannels.start();
    } catch (err) {
      if (ctx.statusChannels === nextStatusChannels) ctx.statusChannels = undefined;
      throw err;
    }
    ctx.runtimeConfigApplier.registerModuleReconfigure(
      'STATUS_CHANNEL_INTERVAL',
      ({ value }) => {
        ctx.statusChannels?.reconfigure({ statusChannelInterval: value });
      },
      { ownerId: STATUS_CHANNELS_RUNTIME_OWNER },
    );
    setStatus(ctx, 'Status Channels', '🟢 Active');
  })();

  try {
    await ctx.statusChannelsStartPromise;
  } finally {
    ctx.statusChannelsStartPromise = null;
  }
}

async function stopStatusChannelsModule(ctx: AppContext): Promise<void> {
  if (ctx.statusChannelsStartPromise) await ctx.statusChannelsStartPromise.catch(() => undefined);
  await ctx.runtimeConfigApplier.cleanupOwner(STATUS_CHANNELS_RUNTIME_OWNER);
  if (ctx.statusChannels) {
    ctx.statusChannels.stop();
    ctx.statusChannels = undefined;
  }
  setStatus(ctx, 'Status Channels', '⚫ Disabled');
}

export async function startServerStatusModule(ctx: AppContext, readyClient: Client): Promise<void> {
  if (ctx.serverStatus) return;
  if (ctx.serverStatusStartPromise) return ctx.serverStatusStartPromise;

  ctx.serverStatusStartPromise = (async () => {
    if (!config.serverStatusChannelId) {
      setStatus(ctx, 'Server Status', '🟡 Skipped (SERVER_STATUS_CHANNEL_ID not set)');
      console.log('[BOT] Server status skipped — SERVER_STATUS_CHANNEL_ID not configured');
      return;
    }

    const nextServerStatus = new ServerStatus(readyClient, { db: ctx.db });
    ctx.serverStatus = nextServerStatus;
    try {
      await nextServerStatus.start();
    } catch (err) {
      if (ctx.serverStatus === nextServerStatus) ctx.serverStatus = undefined;
      throw err;
    }
    ctx.runtimeConfigApplier.registerModuleReconfigure(
      'SERVER_STATUS_INTERVAL',
      ({ value }) => {
        ctx.serverStatus?.reconfigure({ serverStatusInterval: value });
      },
      { ownerId: SERVER_STATUS_RUNTIME_OWNER },
    );
    setStatus(ctx, 'Server Status', '🟢 Active');
  })();

  try {
    await ctx.serverStatusStartPromise;
  } finally {
    ctx.serverStatusStartPromise = null;
  }
}

async function stopServerStatusModule(ctx: AppContext): Promise<void> {
  if (ctx.serverStatusStartPromise) await ctx.serverStatusStartPromise.catch(() => undefined);
  await ctx.runtimeConfigApplier.cleanupOwner(SERVER_STATUS_RUNTIME_OWNER);
  if (ctx.serverStatus) {
    ctx.serverStatus.stop();
    ctx.serverStatus = undefined;
  }
  setStatus(ctx, 'Server Status', '⚫ Disabled');
}

export async function startPlayerStatsModule(ctx: AppContext, readyClient: Client): Promise<void> {
  if (ctx.playerStatsChannel) return;
  if (ctx.playerStatsStartPromise) return ctx.playerStatsStartPromise;

  ctx.playerStatsStartPromise = (async () => {
    if (!hasSftp() && !panelApi.available) {
      setStatus(ctx, 'Player Stats', '🟡 Skipped (no SFTP, Panel API, or database)');
      console.log('[BOT] Player stats skipped — no SFTP, Panel API, or database available');
      return;
    }

    if (!config.playerStatsChannelId) {
      setStatus(ctx, 'Player Stats', '🟡 Skipped (PLAYER_STATS_CHANNEL_ID not set)');
      console.log('[BOT] Player stats skipped — PLAYER_STATS_CHANNEL_ID not configured');
      return;
    }

    const nextPlayerStatsChannel = new PlayerStatsChannel(readyClient, ctx.logWatcher, {
      db: ctx.db,
      panelApi: panelApi.available ? panelApi : null,
    });
    ctx.playerStatsChannel = nextPlayerStatsChannel;
    try {
      await nextPlayerStatsChannel.start();
    } catch (err) {
      if (ctx.playerStatsChannel === nextPlayerStatsChannel) ctx.playerStatsChannel = undefined;
      throw err;
    }
    const mode = 'DB-first';
    setStatus(ctx, 'Player Stats', `🟢 Active (${mode})`);
    if (!ctx.logWatcher) {
      setStatus(ctx, 'Player Stats', `🟢 Active (${mode}, kill/survival feed unavailable — Log Watcher off)`);
    }
  })();

  try {
    await ctx.playerStatsStartPromise;
  } finally {
    ctx.playerStatsStartPromise = null;
  }
}

async function stopPlayerStatsModule(ctx: AppContext): Promise<void> {
  if (ctx.playerStatsStartPromise) await ctx.playerStatsStartPromise.catch(() => undefined);
  await ctx.runtimeConfigApplier.cleanupOwner(PLAYER_STATS_RUNTIME_OWNER);
  if (ctx.playerStatsChannel) {
    ctx.playerStatsChannel.stop();
    ctx.playerStatsChannel = undefined;
  }
  setStatus(ctx, 'Player Stats', '⚫ Disabled');
}

export function registerFeatureToggleRestartHandlers(ctx: AppContext, readyClient: Client): void {
  ctx.runtimeConfigApplier.registerModuleRestart('ENABLE_STATUS_CHANNELS', async ({ cfgKey, value }) => {
    const enabled = coerceRuntimeBoolean(value);
    await enqueueStatusChannelsRestart(ctx, async () => {
      if (enabled) {
        await startStatusChannelsModule(ctx, readyClient);
      } else {
        await stopStatusChannelsModule(ctx);
      }
      setConfigValue(config, cfgKey, enabled);
    });
  });

  ctx.runtimeConfigApplier.registerModuleRestart('ENABLE_SERVER_STATUS', async ({ cfgKey, value }) => {
    const enabled = coerceRuntimeBoolean(value);
    await enqueueServerStatusRestart(ctx, async () => {
      if (enabled) {
        await startServerStatusModule(ctx, readyClient);
      } else {
        await stopServerStatusModule(ctx);
      }
      setConfigValue(config, cfgKey, enabled);
    });
  });

  ctx.runtimeConfigApplier.registerModuleRestart('ENABLE_PLAYER_STATS', async ({ cfgKey, value }) => {
    const enabled = coerceRuntimeBoolean(value);
    await enqueuePlayerStatsRestart(ctx, async () => {
      if (enabled) {
        await startPlayerStatsModule(ctx, readyClient);
      } else {
        await stopPlayerStatsModule(ctx);
      }
      setConfigValue(config, cfgKey, enabled);
    });
  });
}
