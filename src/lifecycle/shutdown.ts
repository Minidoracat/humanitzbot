/**
 * Graceful shutdown + hard-error reporting. Extracted verbatim from
 * src/index.ts (P1-1b god-file split); module state is threaded through ctx and
 * the bot client is read as ctx.client. The stop ordering is load-bearing
 * (modules first, then DB close before any async work so the WAL is
 * checkpointed before a --watch respawn opens it) and is preserved exactly.
 */
import { EmbedBuilder } from 'discord.js';
import config from '../config/index.js';
import rcon from '../rcon/rcon.js';
import playtime from '../tracking/playtime-tracker.js';
import playerStats from '../tracking/player-stats.js';
import { postAdminAlert } from '../utils/admin-alert.js';
import { shutdownLogger } from '../logger/logger.js';
import { errMsg } from '../utils/error.js';
import { _formatUptime } from '../runtime/helpers.js';
import type { AppContext } from '../runtime/app-context.js';

export async function shutdown(ctx: AppContext, reason = 'Manual shutdown'): Promise<void> {
  if (ctx.shuttingDown) return; // prevent double-shutdown
  ctx.shuttingDown = true;
  console.log('\n[BOT] Shutting down...');

  // Stop all modules FIRST (some need DB for final persist)
  if (ctx.chatRelay) ctx.chatRelay.stop();
  if (ctx.statusChannels) ctx.statusChannels.stop();
  if (ctx.serverStatus) ctx.serverStatus.stop();
  if (ctx.autoMessages) ctx.autoMessages.stop();
  if (ctx.presenceTracker) ctx.presenceTracker.stop();
  if (ctx.pvpScheduler) ctx.pvpScheduler.stop();
  if (ctx.serverScheduler) ctx.serverScheduler.stop();
  if (ctx.webMapServer) ctx.webMapServer.stop();
  if (ctx.hzmodPlugin?.ipcClient) ctx.hzmodPlugin.ipcClient.destroy();
  if (ctx.hzmodIpc) ctx.hzmodIpc.destroy();
  if (ctx.logWatcher) ctx.logWatcher.stop();
  if (ctx.playerStatsChannel) ctx.playerStatsChannel.stop();
  if (ctx.activityLog) ctx.activityLog.stop();
  if (ctx.anticheatIntegration) await ctx.anticheatIntegration.stop();
  if (ctx.howyagarnManager) ctx.howyagarnManager.shutdown();
  if (ctx.displayRefreshTimer) {
    clearTimeout(ctx.displayRefreshTimer);
    ctx.displayRefreshTimer = undefined;
  }
  if (ctx.unregisterCoreConnectionRuntimeHandlers) {
    ctx.unregisterCoreConnectionRuntimeHandlers();
    ctx.unregisterCoreConnectionRuntimeHandlers = undefined;
  }
  if (ctx.unregisterSaveServiceRuntimeHandlers) {
    ctx.unregisterSaveServiceRuntimeHandlers();
    ctx.unregisterSaveServiceRuntimeHandlers = undefined;
  }
  if (ctx.unregisterExternalSourceRuntimeHandlers) {
    ctx.unregisterExternalSourceRuntimeHandlers();
    ctx.unregisterExternalSourceRuntimeHandlers = undefined;
  }
  if (ctx.unregisterDisplayRuntimeHandlers) {
    ctx.unregisterDisplayRuntimeHandlers();
    ctx.unregisterDisplayRuntimeHandlers = undefined;
  }
  if (ctx.saveService) ctx.saveService.stop();
  if (ctx.multiServerManager) await ctx.multiServerManager.stopAll();
  if (ctx.stdinConsole) ctx.stdinConsole.stop();
  if (ctx.botStatusManager) ctx.botStatusManager.stop();
  playerStats.stop();
  if (ctx.playtimeFlushTimer) clearInterval(ctx.playtimeFlushTimer);
  playtime.stop();

  // Close DB immediately after modules stop — before any async work.
  // node --watch sends SIGTERM and may spawn a new process quickly;
  // closing DB here ensures WAL is checkpointed before the new process opens it.
  if (ctx.db) {
    try {
      ctx.db.botState.deleteState('bot_running');
    } catch (err: unknown) {
      console.warn('[BOT] Could not clear bot_running flag:', errMsg(err));
    }
    ctx.db.close();
  }

  // Post offline notification to admin alert channels (best-effort; DB is already closed above)
  try {
    const uptime = _formatUptime(Date.now() - ctx.startedAt.getTime());
    const activeCount = Object.values(ctx.moduleStatus).filter((s) => s.startsWith('🟢')).length;
    const totalCount = Object.keys(ctx.moduleStatus).length;

    const embed = new EmbedBuilder()
      .setTitle('🔴 Bot Offline')
      .setDescription(reason)
      .addFields(
        { name: 'Uptime', value: uptime, inline: true },
        { name: 'Modules', value: `${activeCount}/${totalCount} active`, inline: true },
      )
      .setColor(0xe74c3c)
      .setTimestamp();

    await Promise.race([
      postAdminAlert(ctx.client, embed, {
        adminAlertChannelIds: config.adminAlertChannelIds,
        fallbackChannelId: config.adminChannelId,
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]);
  } catch (err: unknown) {
    console.error('[BOT] Failed to post offline notification:', errMsg(err));
  }

  rcon.disconnect();
  shutdownLogger();
  void ctx.client.destroy();
  process.exit(0);
}

/**
 * Post a hard-error embed to admin alert channels for visibility.
 * Silently ignores failures (client may not be ready yet).
 */
export async function _postErrorEmbed(ctx: AppContext, title: string, err: unknown): Promise<void> {
  if (!ctx.client.isReady()) return;
  try {
    const raw = err instanceof Error ? (err.stack?.slice(0, 1000) ?? err.message) : String(err).slice(0, 1000);
    const embed = new EmbedBuilder()
      .setTitle(`\uD83D\uDD25 ${title}`)
      .setDescription(`\`\`\`\n${raw}\n\`\`\``)
      .setColor(0xff0000)
      .setTimestamp();
    await postAdminAlert(ctx.client, embed, {
      adminAlertChannelIds: config.adminAlertChannelIds,
      fallbackChannelId: config.adminChannelId,
    });
  } catch (embedErr: unknown) {
    console.warn('[BOT] Failed to post error embed:', errMsg(embedErr));
  }
}
