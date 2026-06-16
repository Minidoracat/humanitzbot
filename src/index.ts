import { Client, GatewayIntentBits, Events, REST, Routes, EmbedBuilder } from 'discord.js';
import type { ThreadChannel } from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import { getDirname } from './utils/paths.js';

const __dirname = getDirname(import.meta.url);

// ── Structured logging system ──────────────────────────────
// Initializes the global logger with console (human-readable) + file (JSON) transports.
// All modules using createLogger() automatically write to both outputs.
import { initLogger, shutdownLogger } from './logger/logger.js';
import { createLogger } from './utils/log.js';
import { errMsg } from './utils/error.js';
initLogger();

import config from './config/index.js';
import { setConfigValue } from './config/index.js';
import { hasSftp, _formatUptime } from './runtime/helpers.js';
import { createAppContext } from './runtime/app-context.js';
import { loadOptionalModules } from './bootstrap/optional-modules.js';
import { loadCommands } from './bootstrap/load-commands.js';
import { handleInteraction } from './handlers/interaction.js';
import {
  setStatus,
  scheduleDiscordDisplayRefresh,
  startStatusChannelsModule,
  startServerStatusModule,
  startPlayerStatsModule,
  registerFeatureToggleRestartHandlers,
} from './lifecycle/module-restart.js';
import { reconfigureHzmodRuntime } from './lifecycle/hzmod-runtime.js';
import type { HowyagarnPlayer, ServerDef, SaveSyncResult } from './runtime/app-types.js';
import rcon from './rcon/rcon.js';
import { getServerInfo, getPlayerList, sendAdminMessage } from './rcon/server-info.js';
import ChatRelay from './modules/chat-relay.js';
import PlayerPresenceTracker from './modules/player-presence.js';
import AutoMessages from './modules/auto-messages.js';
import LogWatcher, { type LogEventEntry } from './modules/log-watcher.js';
import playtime from './tracking/playtime-tracker.js';
import playerStats from './tracking/player-stats.js';
import PvpScheduler from './modules/pvp-scheduler.js';
import ServerScheduler from './modules/server-scheduler.js';
import panelApi from './server/panel-api.js';
import serverResources from './server/server-resources.js';
import MultiServerManager from './server/multi-server.js';
import { postAdminAlert } from './utils/admin-alert.js';
import ActivityLog from './modules/activity-log.js';
import MilestoneTracker from './modules/milestone-tracker.js';
import RecapService from './modules/recap-service.js';
import HumanitZDB from './db/database.js';
import SaveService from './parsers/save-service.js';
import { seed as seedGameReference } from './parsers/game-reference.js';
import { writeAgent } from './parsers/agent-builder.js';
import WebMapServer from './web-map/server.js';
import { planWebPanelStartup } from './web-map/startup-plan.js';
import SnapshotService from './tracking/snapshot-service.js';
import StdinConsole from './stdin-console.js';
import { createBotStatusManager } from './utils/status.js';
import { needsSync, syncEnv, getVersion, getExampleVersion } from './env-sync.js';
import ConfigRepository from './db/config-repository.js';
import { migrateEnvToDb, migrateServersJsonToDb, migrateDisplaySettings } from './db/config-migration.js';
import { registerSaveServiceRuntimeHandlers } from './config/save-service-runtime.js';
import { registerCoreConnectionRuntimeHandlers } from './config/core-connection-runtime.js';
import { registerDisplayRuntimeHandlers } from './config/display-runtime.js';
import { registerExternalSourceRuntimeHandlers } from './config/external-source-runtime.js';
import { createHzmodIpc } from './config/hzmod-source-runtime.js';
import { loadServers, createServerConfig } from './server/multi-server.js';
import BotControlService from './server/bot-control.js';
import { rebuildThreads } from './commands/threads.js';
import {
  backupCriticalBotStateKeys,
  backupFirstRunKeys,
  cleanupBackupKeys,
  FIRST_RUN_TRANSIENT_KEYS,
} from './db/bot-state-backup.js';
import { attachBotStateListeners } from './state/bot-state-listeners.js';

// ── Create Discord client ───────────────────────────────────
const intents: GatewayIntentBits[] = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
// Privileged intents — only request when needed (must be enabled in Developer Portal)
// MessageContent (privileged) is fixed at the IDENTIFY handshake (Client
// construction), but a chat/admin channel may only arrive later via DB-backed
// config hydration in ClientReady — so we can't reliably tell here whether the
// outbound Discord → game bridge will run. Request it whenever ChatRelay is
// enabled. (A headless, DB-only deployment that never bridges still needs the
// intent enabled in the Developer Portal — a cost of the single ENABLE_CHAT_RELAY
// toggle covering both RCON chat polling and the Discord bridge.)
if (config.enableChatRelay) {
  intents.push(GatewayIntentBits.MessageContent);
}
if (config.adminRoleIds.length > 0) {
  intents.push(GatewayIntentBits.GuildMembers); // needed for ADMIN_ROLE_IDS resolution
}
const client = new Client({ intents });

// AppContext — the single mutable, by-reference state object threaded through
// every extracted entry-point unit (see runtime/app-context.ts). Built right
// after the client so the privileged-intent handshake stays a top-level side
// effect that runs before any state is touched.
const ctx = createAppContext(client);

// ── Handle interactions ─────────────────────────────────────
client.on(Events.InteractionCreate, (interaction) => {
  void handleInteraction(ctx, interaction);
});

client.once(Events.ClientReady, (readyClient) => {
  void (async () => {
    console.log(`[BOT] Logged in as ${readyClient.user.tag}`);
    console.log(`[BOT] Serving guild: ${config.guildId}`);

    // Auto-sync .env with .env.example on startup
    try {
      if (needsSync()) {
        const currentVersion = getVersion();
        const exampleVersion = getExampleVersion();
        console.log(`[BOT] .env schema outdated (v${currentVersion} → v${exampleVersion}), syncing...`);
        const result = syncEnv() as ReturnType<typeof syncEnv> & { backupPath?: string };
        console.log(
          `[BOT] .env synced: ${result.added} added, ${result.deprecated} deprecated, ${result.updated} updated`,
        );
        if (result.backupPath) {
          console.log(`[BOT] Backup saved: ${result.backupPath}`);
        }
      }
    } catch (err: unknown) {
      console.error('[BOT] .env auto-sync failed:', errMsg(err));
    }

    // Auto-deploy slash commands on startup
    try {
      const rest = new REST({ version: '10' }).setToken(config.discordToken ?? '');
      const commandData = [...ctx.slashCommands.values()].map((c) => c.data.toJSON());
      await rest.put(Routes.applicationGuildCommands(config.clientId ?? '', config.guildId ?? ''), {
        body: commandData,
      });
      console.log(`[BOT] Registered ${commandData.length} slash commands with Discord`);
    } catch (err: unknown) {
      console.error('[BOT] Failed to register slash commands:', errMsg(err));
    }

    console.log('[BOT] Ready!');

    // Initialize SQLite database + seed game reference data
    ctx.db = new HumanitZDB();
    ctx.db.init();
    // ctx.db.init() guarantees ctx.db.db is non-null, but the type includes null
    seedGameReference(ctx.db);

    // Stage 6: attach bot_state event listeners (before any bot_state reads)
    attachBotStateListeners(createLogger('bot-state'), ctx.db);

    // Stage 4: TTL cleanup — remove backup rows older than 7 days
    cleanupBackupKeys(ctx.db);

    // ── One-time config migration (.env + servers.json → config_documents) ──
    ctx.configRepo = new ConfigRepository(ctx.db);

    if (!ctx.db.botState.getState('config_migration_done')) {
      try {
        // 1. Migrate .env values → DB (read from process.env, NOT the file —
        //    env-sync may have already commented out non-bootstrap keys)
        const envResult = migrateEnvToDb(process.env, ctx.configRepo);

        // 2. Migrate servers.json → DB (if exists)
        let serverCount = 0;
        const serversPath = path.join(__dirname, '..', 'data', 'servers.json');
        if (fs.existsSync(serversPath)) {
          try {
            const serverDefs: unknown = JSON.parse(fs.readFileSync(serversPath, 'utf8'));
            if (Array.isArray(serverDefs)) {
              serverCount = migrateServersJsonToDb(serverDefs as Array<Record<string, unknown>>, ctx.configRepo);
            }
          } catch (parseErr: unknown) {
            console.error('[BOT] CRITICAL: servers.json migration failed:', errMsg(parseErr));
            throw parseErr; // Prevent marking migration as done
          }
        }

        // 3. Migrate display_settings → DB
        const displayCount = migrateDisplaySettings(ctx.db, ctx.configRepo);

        // Mark migration as done
        ctx.db.botState.setState('config_migration_done', 'true');
        console.log(
          `[BOT] Config migrated to DB: ${envResult.appKeys} app, ${envResult.serverKeys} server, ${serverCount} managed servers, ${displayCount} display settings`,
        );
      } catch (err: unknown) {
        console.error('[BOT] Config migration failed:', errMsg(err));
        // Non-fatal — continue with .env
      }
    }

    // Stage 2b: canary backup — one-shot idempotent, before any schema validation
    backupCriticalBotStateKeys(ctx.db);

    config.hydrate(ctx.configRepo);
    config.loadDisplayOverrides(ctx.db); // Legacy no-op — kept for backward compat
    panelApi.invalidateConfig();
    ctx.runtimeConfigApplier.registerConnectionReconnect('PANEL_SERVER_URL', ({ cfgKey, value }) => {
      setConfigValue(config, cfgKey, value);
      panelApi.invalidateConfig();
    });
    ctx.runtimeConfigApplier.registerConnectionReconnect('PANEL_API_KEY', ({ cfgKey, value }) => {
      setConfigValue(config, cfgKey, value);
      panelApi.invalidateConfig();
    });
    ctx.runtimeConfigApplier.registerModuleReconfigure('STATUS_CACHE_TTL', ({ cfgKey, value }) => {
      const parsed = typeof value === 'number' ? value : typeof value === 'string' ? parseInt(value, 10) : Number.NaN;
      setConfigValue(
        config,
        cfgKey,
        Math.max(Number.isFinite(parsed) ? Math.trunc(parsed) : config.statusCacheTtl, 10_000),
      );
    });
    ctx.runtimeConfigApplier.registerModuleReconfigure('RESOURCE_CACHE_TTL', ({ cfgKey, value }) => {
      const nextTtl = serverResources.reconfigure({ resourceCacheTtl: value });
      if (nextTtl !== null) setConfigValue(config, cfgKey, nextTtl);
    });
    ctx.unregisterCoreConnectionRuntimeHandlers = registerCoreConnectionRuntimeHandlers({
      runtimeConfigApplier: ctx.runtimeConfigApplier,
      config,
      rcon,
      getSaveService: () => ctx.saveService,
      getLogWatcher: () => ctx.logWatcher,
    });
    ctx.unregisterDisplayRuntimeHandlers = registerDisplayRuntimeHandlers({
      runtimeConfigApplier: ctx.runtimeConfigApplier,
      config,
      onApplied: () => {
        scheduleDiscordDisplayRefresh(ctx);
      },
    });
    ctx.unregisterExternalSourceRuntimeHandlers = registerExternalSourceRuntimeHandlers({
      runtimeConfigApplier: ctx.runtimeConfigApplier,
      config,
      getSaveService: () => ctx.saveService,
      reconfigureHzmod: (next, previous) => {
        reconfigureHzmodRuntime(ctx, next, previous);
      },
    });
    registerFeatureToggleRestartHandlers(ctx, readyClient);

    console.log('[BOT] SQLite database initialised');

    // Initialize playtime tracker (must be before AutoMessages)
    if (config.enablePlaytime) {
      playtime.init();
    }

    // Initialize player stats tracker (must be before LogWatcher)
    playerStats.init();

    // Wire DB into singletons for unified identity + stats syncing
    playerStats.setDb(ctx.db);
    playtime.setDb(ctx.db);

    // Periodic flush of active playtime sessions to DB (crash protection)
    ctx.playtimeFlushTimer = setInterval(() => {
      try {
        playtime.flushActiveSessions();
      } catch {
        // ignore
      }
    }, 60000);

    // Connect to RCON (non-fatal — auto-reconnect handles recovery)
    if (!config.needsSetup) {
      try {
        await rcon.connect();
      } catch (err: unknown) {
        console.warn(`[BOT] Initial RCON connection failed: ${errMsg(err)} — will auto-reconnect`);
      }
    } else {
      console.log('[BOT] RCON not configured — skipping initial connection');
    }

    // ── RCON lifecycle events — log game server restarts ──
    rcon.on('disconnect', ({ reason }: { reason: string }) => {
      console.log(`[BOT] Game server disconnected: ${reason}`);
      if (ctx.botStatusManager) ctx.botStatusManager.refreshNow().catch(() => {});
      if (ctx.logWatcher) {
        const embed = new EmbedBuilder()
          .setDescription('🟡 Game server disconnected — RCON connection lost')
          .setColor(0xf39c12)
          .setTimestamp();
        ctx.logWatcher.sendToThread(embed).catch(() => {});
      }
    });
    rcon.on('reconnect', ({ downtime }: { downtime?: number }) => {
      const downtimeStr = downtime ? _formatUptime(downtime) : 'unknown';
      console.log(`[BOT] Game server reconnected (downtime: ${downtimeStr})`);
      if (ctx.botStatusManager) ctx.botStatusManager.refreshNow().catch(() => {});
      if (ctx.logWatcher) {
        const embed = new EmbedBuilder()
          .setDescription(`🟢 Game server reconnected (downtime: ${downtimeStr})`)
          .setColor(0x2ecc71)
          .setTimestamp();
        ctx.logWatcher.sendToThread(embed).catch(() => {});
      }
    });

    // Bot profile status (presence/activity) — rotates live players + feature highlights
    ctx.botStatusManager = createBotStatusManager(readyClient, {
      refreshMs: parseInt(process.env['BOT_PROFILE_STATUS_INTERVAL'] ?? '', 10) || 30000,
      getHasSftp: () => hasSftp(),
      getPanelAvailable: () => panelApi.available,
      getWebMapEnabled: () => !!parseInt(process.env['WEB_MAP_PORT'] ?? '', 10),
      getModuleStatus: () => ctx.moduleStatus,
    });
    ctx.botStatusManager.start();

    // Generate/update the standalone agent script so it's always fresh
    try {
      writeAgent();
    } catch (err: unknown) {
      console.warn('[BOT] Could not generate humanitz-agent.js:', errMsg(err));
    }

    // ── Web panel — start EARLY so it's reachable while modules initialise ──
    const webPanelPlan = planWebPanelStartup(process.env, config);
    if (webPanelPlan.action === 'disabled') {
      setStatus(ctx, 'WebMap', '⚫ Disabled (no WEB_MAP_PORT)');
      console.log('[BOT] Web panel disabled — set WEB_MAP_PORT in .env to enable');
    } else {
      const { port, mode } = webPanelPlan;
      try {
        if (mode === 'landingOnly') {
          console.log('[BOT] Web panel starting without OAuth — landing page only (login disabled)');
          console.log('[BOT] Set DISCORD_OAUTH_SECRET + WEB_MAP_CALLBACK_URL in .env to enable login');
        }
        // Assign the module-level variable only after start() succeeds, so a failed
        // start doesn't leave a half-initialised server reachable to shutdown handlers.
        const server = new WebMapServer(readyClient, {
          db: ctx.db,
          configRepo: ctx.configRepo,
          runtimeConfigApplier: ctx.runtimeConfigApplier,
        });
        await server.start();
        ctx.webMapServer = server;
        const suffix = mode === 'oauth' ? '' : ' (no auth)';
        setStatus(ctx, 'WebMap', `🟢 Running on http://localhost:${port}${suffix}`);
        console.log(`[BOT] Web panel started: http://localhost:${port}`);
      } catch (err: unknown) {
        setStatus(ctx, 'WebMap', `⚠️ Failed to start: ${errMsg(err)}`);
        console.error('[BOT] Web panel failed to start:', errMsg(err));
      }
    }

    // ── Wipe saved message IDs on FIRST_RUN ──
    //    Forces each module to re-create its embed from scratch.
    if (config.firstRun) {
      const dataDir = path.join(__dirname, '..', 'data');
      // Clear bot_state keys that hold transient/session data (ctx.db is guaranteed set above)
      {
        // PR2: central contract lives in bot-state-backup.ts so tests can assert
        // that FIRST_RUN clears kill_tracker / weekly_baseline / recap_service
        // but does not clear backfilled milestones.
        const transientKeys = FIRST_RUN_TRANSIENT_KEYS;
        // Stage 4: backup transient keys before deletion (idempotent)
        backupFirstRunKeys(ctx.db, transientKeys);
        for (const key of transientKeys) {
          try {
            ctx.db.botState.deleteState(key);
          } catch {
            // ignore
          }
        }
        console.log('[BOT] Cleared bot_state transient keys (FIRST_RUN)');
      }
      // Also clear legacy JSON files
      const msgIdFile = path.join(dataDir, 'message-ids.json');
      if (fs.existsSync(msgIdFile)) {
        fs.unlinkSync(msgIdFile);
        console.log('[BOT] Cleared message-ids.json (FIRST_RUN)');
      }
      const transientFiles = ['log-offsets.json', 'day-counts.json', 'pvp-kills.json', 'welcome-stats.json'];
      for (const f of transientFiles) {
        const fp = path.join(dataDir, f);
        if (fs.existsSync(fp)) {
          fs.unlinkSync(fp);
          console.log(`[BOT] Cleared ${f}`);
        }
      }
      // Also clear per-server message IDs and orphaned server data directories
      const serversDir = path.join(dataDir, 'servers');
      if (fs.existsSync(serversDir)) {
        const knownIds = new Set(loadServers().map((s: { id: string }) => s.id));
        for (const entry of fs.readdirSync(serversDir)) {
          const dir = path.join(serversDir, entry);
          const fp = path.join(dir, 'message-ids.json');
          if (fs.existsSync(fp)) {
            fs.unlinkSync(fp);
          }
          if (!knownIds.has(entry) && fs.statSync(dir).isDirectory()) {
            fs.rmSync(dir, { recursive: true, force: true });
            console.log(`[BOT] Removed orphaned server data: ${entry}`);
          } else {
            for (const f of transientFiles) {
              const sfp = path.join(dir, f);
              if (fs.existsSync(sfp)) {
                fs.unlinkSync(sfp);
              }
            }
          }
        }
      }
    }

    // ── NUKE_BOT: factory reset — wipe all bot content from Discord ──
    //    Cleans every configured channel BEFORE modules start, so all
    //    threads and embeds are recreated fresh in the correct order.
    if (config.nukeBot) {
      // Immediately clear NUKE_BOT in .env FIRST to prevent infinite nuke loops
      // if anything crashes during the wipe/rebuild process.
      try {
        const envPath = path.join(__dirname, '..', '.env');
        let envContent = fs.readFileSync(envPath, 'utf8');
        envContent = envContent.replace(/^NUKE_BOT\s*=\s*true$/m, 'NUKE_BOT=false');
        envContent = envContent.replace(/^NUKE_THREADS\s*=\s*true$/m, 'NUKE_THREADS=false');
        envContent = envContent.replace(/^FIRST_RUN\s*=\s*true$/m, 'FIRST_RUN=false');
        fs.writeFileSync(envPath, envContent, 'utf8');
        console.log('[NUKE] NUKE_BOT set to false in .env (prevents repeat nuke on crash)');
      } catch (err: unknown) {
        console.warn('[NUKE] Could not update .env:', errMsg(err));
      }

      console.log('[NUKE] Wiping all bot content from Discord channels...');
      const channelsToClean = new Set<string>();
      // Primary server channels
      if (config.logChannelId) channelsToClean.add(config.logChannelId);
      if (config.adminChannelId) channelsToClean.add(config.adminChannelId);
      if (config.chatChannelId) channelsToClean.add(config.chatChannelId);
      if (config.serverStatusChannelId) channelsToClean.add(config.serverStatusChannelId);
      if (config.playerStatsChannelId) channelsToClean.add(config.playerStatsChannelId);

      if (config.activityLogChannelId) channelsToClean.add(config.activityLogChannelId);
      // Additional server channels (including any from removed servers still in servers.json)
      const servers = loadServers() as Array<{ channels?: Record<string, string | undefined> }>;
      for (const sd of servers) {
        // Keys must match ServerDef.channels (server/multi-server.ts) and the
        // dashboard's ENV_TO_SERVERDEF mapping (web-map/server.ts):
        // ctx.serverStatus / playerStats / chat / log / admin / ctx.activityLog.
        // The previous status/stats/panel keys never exist in servers.json, so a
        // managed server's status-embed and player-stats channels were silently
        // skipped on factory reset.
        if (sd.channels?.['log']) channelsToClean.add(sd.channels['log']);
        if (sd.channels?.['chat']) channelsToClean.add(sd.channels['chat']);
        if (sd.channels?.['admin']) channelsToClean.add(sd.channels['admin']);
        if (sd.channels?.['ctx.serverStatus']) channelsToClean.add(sd.channels['ctx.serverStatus']);
        if (sd.channels?.['playerStats']) channelsToClean.add(sd.channels['playerStats']);
        if (sd.channels?.['ctx.activityLog']) channelsToClean.add(sd.channels['ctx.activityLog']);
      }

      const botId = readyClient.user.id;
      for (const channelId of channelsToClean) {
        await _nukeChannel(readyClient, channelId, botId);
      }
      console.log(`[NUKE] Cleaned ${channelsToClean.size} channel(s)`);
    }

    // ── Start modules with dependency checks ──────────────────

    // Status Channels — voice channel dashboard
    if (config.enableStatusChannels) {
      await startStatusChannelsModule(ctx, readyClient);
    } else {
      setStatus(ctx, 'Status Channels', '⚫ Disabled');
      console.log('[BOT] Status channels disabled via ENABLE_STATUS_CHANNELS=false');
    }

    // Server Status — live embed in a text channel
    if (config.enableServerStatus) {
      await startServerStatusModule(ctx, readyClient);
    } else {
      setStatus(ctx, 'Server Status', '⚫ Disabled');
      console.log('[BOT] Server status embed disabled via ENABLE_SERVER_STATUS=false');
    }

    // Log Watcher — SFTP log parsing + daily activity threads
    // Started BEFORE Chat Relay so activity thread appears first in channel
    if (config.enableLogWatcher) {
      if (!hasSftp()) {
        setStatus(ctx, 'Log Watcher', '🟡 Skipped (SFTP credentials not set)');
        console.log('[BOT] Log watcher skipped — SFTP_HOST/SFTP_USER/SFTP_PASSWORD not configured');
      } else {
        // Start even without LOG_CHANNEL_ID — the module self-selects headless
        // mode (DB writes only, no Discord posting) so log_*/death_causes data is
        // still collected for the web panel. Mirrors the multi-server path.
        ctx.logWatcher = new LogWatcher(readyClient, {
          db: ctx.db,
          dataDir: path.resolve(__dirname, '..'),
          panelApi: panelApi.available ? panelApi : null,
        });
        await ctx.logWatcher.start();
        const _logWatcher = ctx.logWatcher;
        if (ctx.logWatcher.interval) {
          ctx.runtimeConfigApplier.registerModuleReconfigure('LOG_POLL_INTERVAL', ({ value }) => {
            _logWatcher.reconfigure({ logPollInterval: value });
          });
        }
        ctx.runtimeConfigApplier.registerModuleReconfigure('ENABLE_PVP_KILL_FEED', ({ value }) => {
          _logWatcher.reconfigure({ enablePvpKillFeed: value });
        });
        ctx.runtimeConfigApplier.registerModuleReconfigure('PVP_KILL_WINDOW', ({ value }) => {
          _logWatcher.reconfigure({ pvpKillWindow: value });
        });
        ctx.runtimeConfigApplier.registerModuleReconfigure('ENABLE_DEATH_LOOP_DETECTION', ({ value }) => {
          _logWatcher.reconfigure({ enableDeathLoopDetection: value });
        });
        ctx.runtimeConfigApplier.registerModuleReconfigure('DEATH_LOOP_THRESHOLD', ({ value }) => {
          _logWatcher.reconfigure({ deathLoopThreshold: value });
        });
        ctx.runtimeConfigApplier.registerModuleReconfigure('DEATH_LOOP_WINDOW', ({ value }) => {
          _logWatcher.reconfigure({ deathLoopWindow: value });
        });
        // interval is only set once start() got past validation/connection, so
        // a missing interval means start() bailed (no SFTP, placeholder host,
        // channel not found, …) and the collector isn't actually running.
        setStatus(
          ctx,
          'Log Watcher',
          ctx.logWatcher.interval
            ? ctx.logWatcher.isHeadless
              ? '🟢 Active (headless, DB-only)'
              : '🟢 Active'
            : '⚠️ Failed to start',
        );
      }
    } else {
      setStatus(ctx, 'Log Watcher', '⚫ Disabled');
      console.log('[BOT] Log watcher disabled via ENABLE_LOG_WATCHER=false');
    }

    // Chat Relay — bidirectional chat bridge
    if (config.enableChatRelay) {
      // Always create the relay when enabled. It polls RCON for chat — writing
      // chat_log even headless (no Discord channel) — and pauses polling quietly
      // until RCON is configured, so RCON set up later via the dashboard starts
      // working without a restart. The module self-selects headless when no
      // CHAT_CHANNEL_ID/ADMIN_CHANNEL_ID is set.
      ctx.chatRelay = new ChatRelay(readyClient, { db: ctx.db });
      const _chatRelay = ctx.chatRelay;
      if (config.nukeBot) _chatRelay.setNukeActive(true);
      // Coordinate day-rollover ordering only with a LogWatcher that actually
      // posts a daily thread (started + non-headless). A headless OR bailed-start
      // watcher never creates a daily thread or fires the rollover callback, so
      // making ChatRelay await it would strand its own daily-thread rollover
      // (it would post to the parent channel after midnight instead).
      if (ctx.logWatcher?.postsDailyThread) {
        _chatRelay.setAwaitActivityThread(true);
        ctx.logWatcher.setDayRolloverCallback(async () => {
          try {
            await _chatRelay.createDailyThread();
          } catch (e: unknown) {
            console.warn('[BOT] Day-rollover chat thread error:', errMsg(e));
          }
        });
      }
      await ctx.chatRelay.start();
      if (_chatRelay.healthy) {
        ctx.runtimeConfigApplier.registerModuleReconfigure('CHAT_POLL_INTERVAL', ({ value }) => {
          _chatRelay.reconfigure({ chatPollInterval: value });
        });
      }
      // healthy goes false if start() failed (e.g. channel fetch threw); don't
      // show green for a relay that isn't actually running.
      setStatus(
        ctx,
        'Chat Relay',
        _chatRelay.healthy
          ? _chatRelay.isHeadless
            ? '🟢 Active (headless, DB-only)'
            : '🟢 Active'
          : '⚠️ Failed to start',
      );
    } else {
      setStatus(ctx, 'Chat Relay', '⚫ Disabled');
      console.log('[BOT] Chat relay disabled via ENABLE_CHAT_RELAY=false');
    }

    // Player Presence Tracker — infrastructure (always-on: peak/unique stats, join/leave events)
    ctx.presenceTracker = new PlayerPresenceTracker({
      config,
      db: ctx.db,
      playtime,
      getPlayerList,
      label: 'PRESENCE',
    });
    try {
      await ctx.presenceTracker.start();
      ctx.runtimeConfigApplier.registerModuleReconfigure('AUTO_MSG_JOIN_CHECK', ({ value }) => {
        ctx.presenceTracker?.reconfigure({ autoMsgJoinCheckInterval: value });
      });
    } catch (err: unknown) {
      console.error('[PRESENCE] Failed to start player presence tracker:', errMsg(err));
    }

    // Auto-Messages — periodic broadcasts + join welcome
    const hasAnyAutoMsg = config.enableAutoMsgLink || config.enableAutoMsgPromo || config.enableWelcomeMsg;
    if (hasAnyAutoMsg) {
      ctx.autoMessages = new AutoMessages({
        config,
        presenceTracker: ctx.presenceTracker,
        playtime,
        playerStats,
        getServerInfo,
        sendAdminMessage,
        db: ctx.db,
        label: 'AUTO MSG',
      });
      // Note: start() is synchronous; if it ever returns Promise, callers must await
      ctx.autoMessages.start();
      const _autoMessages = ctx.autoMessages;
      ctx.runtimeConfigApplier.registerModuleReconfigure('DISCORD_INVITE_LINK', ({ value }) => {
        _autoMessages.reconfigure({ discordInviteLink: value });
      });
      ctx.runtimeConfigApplier.registerModuleReconfigure('AUTO_MSG_LINK_TEXT', ({ value }) => {
        _autoMessages.reconfigure({ autoMsgLinkText: value });
      });
      ctx.runtimeConfigApplier.registerModuleReconfigure('AUTO_MSG_PROMO_TEXT', ({ value }) => {
        _autoMessages.reconfigure({ autoMsgPromoText: value });
      });
      ctx.runtimeConfigApplier.registerModuleReconfigure('ENABLE_AUTO_MSG_LINK', ({ value }) => {
        _autoMessages.reconfigure({ enableAutoMsgLink: value });
      });
      ctx.runtimeConfigApplier.registerModuleReconfigure('ENABLE_AUTO_MSG_PROMO', ({ value }) => {
        _autoMessages.reconfigure({ enableAutoMsgPromo: value });
      });
      ctx.runtimeConfigApplier.registerModuleReconfigure('ENABLE_WELCOME_MSG', ({ value }) => {
        _autoMessages.reconfigure({ enableWelcomeMsg: value });
      });
      ctx.runtimeConfigApplier.registerModuleReconfigure('AUTO_MSG_LINK_INTERVAL', ({ value }) => {
        _autoMessages.reconfigure({ autoMsgLinkInterval: value });
      });
      ctx.runtimeConfigApplier.registerModuleReconfigure('AUTO_MSG_PROMO_INTERVAL', ({ value }) => {
        _autoMessages.reconfigure({ autoMsgPromoInterval: value });
      });
      setStatus(ctx, 'Auto-Messages', '🟢 Active');
    } else {
      setStatus(ctx, 'Auto-Messages', '⚫ Disabled');
      console.log('[AUTO MSG] All message features disabled — skipping');
    }

    // Kill Feed — sub-feature of Log Watcher
    if (config.enableKillFeed) {
      if (!ctx.logWatcher) {
        setStatus(ctx, 'Kill Feed', '🟡 Skipped (requires Log Watcher)');
      } else {
        setStatus(ctx, 'Kill Feed', '🟢 Active');
      }
    } else {
      setStatus(ctx, 'Kill Feed', '⚫ Disabled');
    }

    // PvP Kill Feed — sub-feature of Log Watcher
    if (config.enablePvpKillFeed) {
      if (!ctx.logWatcher) {
        setStatus(ctx, 'PvP Kill Feed', '🟡 Skipped (requires Log Watcher)');
      } else {
        setStatus(ctx, 'PvP Kill Feed', '🟢 Active');
      }
    } else {
      setStatus(ctx, 'PvP Kill Feed', '⚫ Disabled');
    }

    // Save Service — save-file polling → SQLite sync (SFTP, Panel API, or agent)
    if (hasSftp() || panelApi.available) {
      ctx.saveService = new SaveService(ctx.db, {
        sftpConfig: hasSftp() ? config.sftpConnectConfig() : undefined,
        savePath: config.sftpSavePath,
        clanSavePath: config.sftpSavePath.replace(/SaveList\/.*$/, 'Save_ClanData.sav'),
        pollInterval: config.getEffectiveSavePollInterval(),
        agentMode: config.agentMode as 'agent' | 'auto' | 'direct' | undefined,
        agentNodePath: config.agentNodePath,
        agentRemoteDir: config.agentRemoteDir,
        agentCachePath: config.agentCachePath,
        agentIdMapPath: config.sftpIdMapPath,
        agentTimeout: config.agentTimeout,
        agentTrigger: config.agentTrigger as 'auto' | 'ssh' | 'rcon' | 'panel' | 'none' | undefined,
        agentPanelCommand: config.agentPanelCommand,
        agentPanelDelay: config.agentPanelDelay,

        panelApi: panelApi.available ? panelApi : undefined,
      });
      ctx.saveService.on('sync', (result: SaveSyncResult) => {
        console.log(
          `[BOT] Save sync: ${result.playerCount} players, ${result.structureCount} structures (${result.mode}, ${result.elapsed}ms)`,
        );
        // save-cache.json is now written inside SaveService._syncParsedData()
      });
      ctx.saveService.on('error', (err: unknown) => {
        console.error('[BOT] Save service error:', errMsg(err));
      });
      await ctx.saveService.start();
      ctx.unregisterSaveServiceRuntimeHandlers = registerSaveServiceRuntimeHandlers({
        runtimeConfigApplier: ctx.runtimeConfigApplier,
        saveService: ctx.saveService,
        getConfig: () => config,
      });
      if (ctx.webMapServer) ctx.webMapServer.setSaveService(ctx.saveService);
      const saveSource = hasSftp() ? '' : ' via Panel API';

      setStatus(ctx, 'Save Service', `🟢 Active (${ctx.saveService.getSyncMode()} mode${saveSource})`);

      // ── Snapshot Service — timeline recording on every save sync ──
      ctx.snapshotService = new SnapshotService(ctx.db, {
        retentionDays: parseInt(process.env['TIMELINE_RETENTION_DAYS'] ?? '', 10) || 14,
        trackStructures: process.env['TIMELINE_TRACK_STRUCTURES'] !== 'false',
        trackHouses: process.env['TIMELINE_TRACK_HOUSES'] !== 'false',
        trackBackpacks: process.env['TIMELINE_TRACK_BACKPACKS'] !== 'false',
      });
      ctx.saveService.on('sync', (result: SaveSyncResult) => {
        void (async () => {
          if (!(result.parsed as unknown)) return;
          try {
            // Build online player set from RCON if available
            const onlinePlayers = new Set<string>();
            try {
              const list = await getPlayerList();
              // getPlayerList returns loosely typed data — defensive runtime access
              const raw = list as unknown as Record<string, unknown>; // SAFETY: getPlayerList returns loosely typed data
              const arr: unknown[] = Array.isArray(raw.players)
                ? raw.players
                : Array.isArray(list)
                  ? (list as unknown[])
                  : [];
              for (const p of arr) {
                const player = p as Record<string, unknown>;
                if (typeof player.name === 'string') onlinePlayers.add(player.name.toLowerCase());
              }
            } catch {
              /* RCON unavailable — online player set will be empty for this snapshot */
            }

            const _snapshot = ctx.snapshotService;
            if (_snapshot) {
              _snapshot.recordSnapshot(
                {
                  players: result.parsed.players,
                  worldState: result.worldState,
                  vehicles: result.parsed.vehicles,
                  structures: result.parsed.structures,
                  containers: result.parsed.containers,
                  companions: result.parsed.companions,
                  horses: result.parsed.horses,
                } as Parameters<InstanceType<typeof SnapshotService>['recordSnapshot']>[0],
                { onlinePlayers },
              );
            }
          } catch (err: unknown) {
            console.error('[BOT] Snapshot recording error:', errMsg(err));
          }
        })();
      });
      setStatus(ctx, 'Timeline', '🟢 Active');
    } else {
      setStatus(ctx, 'Save Service', '🟡 Skipped (no SFTP credentials or Panel API)');
      setStatus(ctx, 'Timeline', '🟡 Skipped (requires Save Service)');
    }

    // Activity Log — save-file change tracking feed
    if (config.enableActivityLog) {
      if (!ctx.saveService) {
        setStatus(ctx, 'Activity Log', '🟡 Skipped (requires Save Service)');
      } else {
        // Always hand ActivityLog the LogWatcher so it can attribute container
        // access (getRecentContainerAccess) even when the watcher is headless.
        // ActivityLog decides its own posting target: the daily thread when the
        // watcher is non-headless, otherwise its ACTIVITY_LOG_CHANNEL_ID/ADMIN.
        ctx.activityLog = new ActivityLog(readyClient, {
          db: ctx.db,
          saveService: ctx.saveService,
          logWatcher: ctx.logWatcher,
        });
        await ctx.activityLog.start();
        setStatus(ctx, 'Activity Log', '🟢 Active');
      }
    } else {
      setStatus(ctx, 'Activity Log', '⚫ Disabled');
    }

    // Milestone Tracker — player achievement announcements
    if (config.enableMilestones) {
      ctx.milestoneTracker = new MilestoneTracker(readyClient, { db: ctx.db, logWatcher: ctx.logWatcher, config });
      const _milestone = ctx.milestoneTracker;
      // Check milestones on every save sync
      if (ctx.saveService) {
        ctx.saveService.on('sync', (result: SaveSyncResult) => {
          _milestone.check(result).catch((checkErr: unknown) => {
            console.error('[BOT] Milestone check error:', errMsg(checkErr));
          });
        });
      }
      // Wire death events from LogWatcher to reset survival streaks
      if (ctx.logWatcher) {
        ctx.logWatcher.wrapOnDeath((orig) => (playerName, timestamp) => {
          orig(playerName, timestamp);
          const steamId = playerStats.getSteamId(playerName);
          if (steamId) _milestone.onPlayerDeath(steamId);
        });
      }
      setStatus(ctx, 'Milestones', '🟢 Active');
    } else {
      setStatus(ctx, 'Milestones', '⚫ Disabled');
      console.log('[BOT] Milestones disabled via ENABLE_MILESTONES=false');
    }

    // Recap Service — daily/weekly summary embeds
    if (config.enableRecaps) {
      ctx.recapService = new RecapService(readyClient, { db: ctx.db, logWatcher: ctx.logWatcher, config, playtime });
      const _recap = ctx.recapService;
      // Chain into the LogWatcher day-rollover callback — only meaningful for a
      // watcher that posts a daily thread (started + non-headless); a headless
      // or bailed-start watcher never fires the rollover.
      if (ctx.logWatcher?.postsDailyThread) {
        const prevCb = ctx.logWatcher.getDayRolloverCallback();
        ctx.logWatcher.setDayRolloverCallback(async () => {
          if (typeof prevCb === 'function') await prevCb();
          const yesterday: string = _recap.getYesterday();
          await _recap.onDayRollover(yesterday);
        });
      }
      setStatus(ctx, 'Recaps', '🟢 Active');
    } else {
      setStatus(ctx, 'Recaps', '⚫ Disabled');
      console.log('[BOT] Recaps disabled via ENABLE_RECAPS=false');
    }

    // Anticheat — observation-only anomaly detection (optional private package)
    if (config.enableAnticheat && ctx.optional.AnticheatIntegration) {
      ctx.anticheatIntegration = new ctx.optional.AnticheatIntegration({
        db: ctx.db,
        config,
        logWatcher: ctx.logWatcher,
      });
      await ctx.anticheatIntegration.start();
      const _anticheat = ctx.anticheatIntegration;
      if (_anticheat.available) {
        // Wire into save sync for real-time analysis
        if (ctx.saveService) {
          ctx.saveService.on('sync', (result: SaveSyncResult) => {
            _anticheat.onSaveSync(result).catch((syncErr: unknown) => {
              console.error('[BOT] Anticheat save sync error:', errMsg(syncErr));
            });
          });
        }
        ctx.runtimeConfigApplier.registerModuleReconfigure('ANTICHEAT_ANALYZE_INTERVAL', ({ value }) => {
          _anticheat.reconfigure({ anticheatAnalyzeInterval: value });
        });
        ctx.runtimeConfigApplier.registerModuleReconfigure('ANTICHEAT_BASELINE_INTERVAL', ({ value }) => {
          _anticheat.reconfigure({ anticheatBaselineInterval: value });
        });
        setStatus(ctx, 'Anticheat', '🟢 Active');
      } else {
        setStatus(ctx, 'Anticheat', '🟡 Package not installed');
      }
    } else {
      setStatus(ctx, 'Anticheat', '⚫ Disabled');
    }

    // HOWYAGARN MMO — faction PvP / territory control system
    if (config.enableHowyagarn) {
      if (!ctx.optional.HowyagarnManager) {
        setStatus(ctx, 'HOWYAGARN', '🟡 Skipped (module not installed)');
      } else {
        try {
          // Create shared IPC client for engine communication
          ctx.hzmodIpc = createHzmodIpc(config.hzmodSocketPath, ctx.optional.HzmodIpcClient) ?? undefined;

          ctx.howyagarnManager = new ctx.optional.HowyagarnManager({
            db: ctx.db,
            client: readyClient,
            rcon,
            chatRelay: ctx.chatRelay,
            config,
            ipc: ctx.hzmodIpc ?? null,
          });
          ctx.howyagarnManager.init();
          const _howyagarn = ctx.howyagarnManager;

          // Wire save-sync events
          if (ctx.saveService) {
            ctx.saveService.on('sync', (result: SaveSyncResult) => {
              try {
                if (!(result.parsed as unknown)) return;
                const players: HowyagarnPlayer[] = [];
                const playerMap: Map<string, Record<string, unknown>> = result.parsed.players instanceof Map
                  ? result.parsed.players
                  : new Map(Object.entries(result.parsed.players));
                for (const [steamId, pData] of playerMap) {
                  players.push({
                    steamId,
                    name: (pData['name'] ?? pData['playerName'] ?? '') as string,
                    x: (pData['posX'] ?? pData['x'] ?? 0) as number,
                    y: (pData['posY'] ?? pData['y'] ?? 0) as number,
                    deltaZeeksKilled: (pData['deltaZeeksKilled'] ?? 0) as number,
                    deltaNpcKills: (pData['deltaNpcKills'] ?? 0) as number,
                    deltaAnimalKills: (pData['deltaAnimalKills'] ?? 0) as number,
                    deltaFishCaught: (pData['deltaFishCaught'] ?? 0) as number,
                    deltaDaysSurvived: (pData['deltaDaysSurvived'] ?? 0) as number,
                  });
                }
                const structures: unknown[] = Array.isArray(result.parsed.structures) ? result.parsed.structures : [];
                _howyagarn.onSaveSync({ players, structures });
              } catch (err: unknown) {
                console.error('[BOT] HOWYAGARN save sync error:', errMsg(err));
              }
            });
          }

          // Wire log events (PvP deaths, builds, looting)
          if (ctx.logWatcher) {
            ctx.logWatcher.wrapLogEvent((orig) => (entry: LogEventEntry) => {
              orig(entry);
              try {
                _howyagarn.onLogEvent(entry.type, entry);
              } catch (err: unknown) {
                console.error('[BOT] ctx.howyagarnManager.onLogEvent error:', errMsg(err));
              }
              if (
                entry.type === 'player_connect' &&
                typeof entry.steamId === 'string' &&
                typeof entry.actorName === 'string'
              ) {
                try {
                  _howyagarn.onPlayerConnect(entry.steamId, entry.actorName);
                } catch (err: unknown) {
                  console.error('[BOT] ctx.howyagarnManager.onPlayerConnect error:', errMsg(err));
                }
              }
            });
          }

          setStatus(ctx, 'HOWYAGARN', '🟢 Active');
          console.log('[BOT] HOWYAGARN MMO system active');
        } catch (err: unknown) {
          setStatus(ctx, 'HOWYAGARN', `⚠️ Failed: ${errMsg(err)}`);
          console.error('[BOT] HOWYAGARN init failed:', errMsg(err));
        }
      }
    } else {
      setStatus(ctx, 'HOWYAGARN', '⚫ Disabled');
    }

    // Player Stats — DB-first reads (SaveService populates DB, PSC reads it)
    if (config.enablePlayerStats) {
      await startPlayerStatsModule(ctx, readyClient);
    } else {
      setStatus(ctx, 'Player Stats', '⚫ Disabled');
      console.log('[BOT] Player stats disabled via ENABLE_PLAYER_STATS=false');
    }

    // PvP Scheduler — SFTP-based PvP toggling on a schedule
    if (config.enablePvpScheduler) {
      if (!hasSftp()) {
        setStatus(ctx, 'PvP Scheduler', '🟡 Skipped (SFTP credentials not set)');
        console.log('[BOT] PvP scheduler skipped — SFTP_HOST/SFTP_USER/SFTP_PASSWORD not configured');
      } else if (isNaN(config.pvpStartMinutes) || isNaN(config.pvpEndMinutes)) {
        setStatus(ctx, 'PvP Scheduler', '🟡 Skipped (PVP_START_TIME/PVP_END_TIME not set)');
        console.log('[BOT] PvP scheduler skipped — PVP_START_TIME/PVP_END_TIME not configured');
      } else {
        ctx.pvpScheduler = new PvpScheduler(readyClient, ctx.logWatcher ?? null);
        await ctx.pvpScheduler.start();
        setStatus(ctx, 'PvP Scheduler', '🟢 Active');
        if (!ctx.logWatcher) {
          setStatus(ctx, 'PvP Scheduler', '🟢 Active (activity log announcements unavailable — Log Watcher off)');
        }
      }
    } else {
      setStatus(ctx, 'PvP Scheduler', '⚫ Disabled');
      console.log('[BOT] PvP scheduler disabled via ENABLE_PVP_SCHEDULER=false');
    }

    // Server Scheduler — timed restarts with dynamic difficulty profiles
    if (config.enableServerScheduler) {
      if (!hasSftp()) {
        setStatus(ctx, 'Server Scheduler', '🟡 Skipped (SFTP credentials not set)');
        console.log('[BOT] Server scheduler skipped — SFTP_HOST/SFTP_USER/SFTP_PASSWORD not configured');
      } else {
        ctx.serverScheduler = new ServerScheduler(readyClient, ctx.logWatcher ?? null);
        await ctx.serverScheduler.start();
        if (ctx.webMapServer) ctx.webMapServer.setScheduler(ctx.serverScheduler);
        const status = ctx.serverScheduler.getStatus();
        const profileInfo = status.profiles.length > 1 ? ` (${status.profiles.join(' → ')})` : '';
        setStatus(ctx, 'Server Scheduler', `🟢 Active — ${status.restartTimes.join(', ')}${profileInfo}`);
      }
    } else {
      setStatus(ctx, 'Server Scheduler', '⚫ Disabled');
      console.log('[BOT] Server scheduler disabled via ENABLE_SERVER_SCHEDULER=false');
    }

    // ── Multi-server manager (independent of Panel) ──────────
    ctx.multiServerManager = new MultiServerManager(readyClient, { configRepo: ctx.configRepo });
    await ctx.multiServerManager.startAll();
    if (ctx.webMapServer) {
      ctx.webMapServer.setMultiServerManager(ctx.multiServerManager);
      // Register hzmod web plugin now that ctx.multiServerManager is available
      if (ctx.optional.hzmodWebPlugin) {
        try {
          ctx.hzmodPlugin = ctx.optional.hzmodWebPlugin.register(ctx.webMapServer, config, {
            ipc: ctx.hzmodIpc ?? null,
          });
          // Pass ctx.optional.HowyagarnManager to web plugin for MMO API endpoints
          if (ctx.howyagarnManager) ctx.optional.hzmodWebPlugin.setManager(ctx.howyagarnManager);
        } catch (err: unknown) {
          console.error('[BOT] hzmod plugin registration failed:', errMsg(err));
        }
      }
    }

    // ── BotControlService (used by both Panel and Web) ───────
    const botControl = new BotControlService({ exit: (code: number) => process.exit(code) });
    if (ctx.webMapServer) ctx.webMapServer.setBotControl(botControl);
    if (ctx.webMapServer) ctx.webMapServer.setModuleStatus(ctx.moduleStatus);

    // ── Panel API status (/qspanel command) ─────────────────────
    if (panelApi.available) {
      setStatus(ctx, 'Panel', '🟢 Active (/qspanel command)');
      console.log('[BOT] Panel API available — /qspanel command active');
    } else {
      setStatus(ctx, 'Panel', '🟡 Skipped (no PANEL_SERVER_URL/PANEL_API_KEY)');
    }

    // ── Stdin console (for headless hosts like Bisect) ──────────
    if (config.enableStdinConsole) {
      ctx.stdinConsole = new StdinConsole({ db: ctx.db, writable: config.stdinConsoleWritable });
      ctx.stdinConsole.start();
      setStatus(ctx, 'Console', '🟢 Active (stdin)');
      console.log(`[BOT] Stdin console active${config.stdinConsoleWritable ? ' (writable)' : ' (read-only)'}`);
    }

    // ── Write running flag + clean old lifecycle embeds + post online notification ──
    try {
      try {
        ctx.db.botState.setStateJSON('bot_running', { startedAt: ctx.startedAt.toISOString() });
      } catch {
        // ignore
      }

      // Clean previous lifecycle embeds from admin alert channels
      let alertIds: string[] = config.adminAlertChannelIds;
      if (typeof alertIds === 'string') {
        alertIds = (alertIds as string)
          .split(',')
          .map((s: string) => s.trim())
          .filter(Boolean);
      }
      if (!alertIds.length) alertIds = config.adminChannelId ? [config.adminChannelId] : [];
      const botUserId = readyClient.user.id;
      for (const chId of alertIds) {
        try {
          const ch = await readyClient.channels.fetch(chId).catch(() => null);
          if (!ch || !('messages' in ch)) continue;
          const textCh = ch;
          const messages = await textCh.messages.fetch({ limit: 30 });
          const toDelete = messages.filter((m) => {
            return (
              m.author.id === botUserId &&
              m.embeds.length > 0 &&
              m.embeds.some((e) => e.title === '🔴 Bot Offline' || e.title === '🟢 Bot Online')
            );
          });
          if (toDelete.size > 0) {
            try {
              if ('bulkDelete' in textCh) await (textCh as import('discord.js').TextChannel).bulkDelete(toDelete, true);
            } catch {
              for (const msg of toDelete.values()) {
                await msg.delete().catch(() => {});
              }
            }
          }
        } catch (cleanErr: unknown) {
          console.warn(`[BOT] Could not clean lifecycle embeds in ${chId}:`, errMsg(cleanErr));
        }
      }

      const onlineEmbed = new EmbedBuilder()
        .setTitle('🟢 Bot Online')
        .setDescription(`Started at ${ctx.startedAt.toISOString()}`)
        .setColor(0x2ecc71)
        .setTimestamp();
      await postAdminAlert(readyClient, onlineEmbed, {
        adminAlertChannelIds: config.adminAlertChannelIds,
        fallbackChannelId: config.adminChannelId,
      });
    } catch (err: unknown) {
      console.error('[BOT] Failed to post online notification:', errMsg(err));
    }

    // ── NUKE_BOT phase 2: rebuild activity threads from log history ──
    if (config.nukeBot) {
      console.log('[NUKE] Rebuilding activity threads from log history...');
      try {
        // Primary server
        const result = await rebuildThreads(readyClient);
        if (result.error) {
          console.error('[NUKE] Thread rebuild failed:', result.error);
        } else {
          console.log(
            `[NUKE] Thread rebuild: ${result.created} created, ${result.deleted} replaced, ${result.preserved} preserved, ${result.cleaned} cleaned`,
          );
        }
        // Additional servers

        const additionalServers = loadServers() as ServerDef[];
        for (const serverDef of additionalServers) {
          const label: string = serverDef.name ?? serverDef.id;
          if (!serverDef.channels?.['log']) {
            console.log('[NUKE] Skipping %s thread rebuild (no log channel)', label);
            continue;
          }

          const serverConfig = createServerConfig(serverDef) as unknown;
          console.log('[NUKE] Rebuilding threads for %s...', label);

          const srvResult = await rebuildThreads(
            readyClient,
            null,
            serverConfig as Parameters<typeof rebuildThreads>[2],
          );
          if (srvResult.error) {
            console.error('[NUKE] Thread rebuild for %s failed:', label, srvResult.error);
          } else {
            console.log(
              `[NUKE] ${label}: ${String(srvResult.created)} created, ${String(srvResult.deleted)} replaced, ${String(srvResult.preserved)} preserved, ${String(srvResult.cleaned)} cleaned`,
            );
          }
        }
      } catch (err: unknown) {
        console.error('[NUKE] Thread rebuild error:', errMsg(err));
      }

      // Reset thread caches so modules pick up the newly rebuilt threads
      // Clear nuke suppression first so thread creation works normally again
      if (ctx.logWatcher) {
        ctx.logWatcher.setNukeActive(false);
        ctx.logWatcher.resetThreadCache();
        // Send the startup notification that was deferred during nuke
        const thread = await ctx.logWatcher.getOrCreateDailyThread();
        const startEmbed = new EmbedBuilder()
          .setDescription('Log watcher connected. Monitoring game server activity.')
          .setColor(0x3498db)
          .setTimestamp();
        await thread?.send({ embeds: [startEmbed] }).catch(() => {});
        console.log('[NUKE] LogWatcher thread cache reset');
      }
      if (ctx.chatRelay) {
        ctx.chatRelay.setNukeActive(false);
        ctx.chatRelay.resetThreadCache();
        // Re-create chat thread so it appears after rebuilt activity threads
        await ctx.chatRelay.getOrCreateChatThread().catch((e: unknown) => {
          console.warn('[NUKE] Could not re-create chat thread:', errMsg(e));
        });
        console.log('[NUKE] ChatRelay thread cache reset + recreated');
      }
      for (const [, instance] of ctx.multiServerManager.getInstances()) {
        const lw = instance.getLogWatcher();
        if (lw) {
          lw.setNukeActive(false);
          lw.resetThreadCache();
          console.log(`[NUKE] ${instance.name || instance.id} LogWatcher thread cache reset`);
        }
        const cr = instance.getChatRelay();
        if (cr) {
          cr.setNukeActive(false);
          cr.resetThreadCache();
          await cr.getOrCreateChatThread().catch(() => {});
          console.log(`[NUKE] ${instance.name || instance.id} ChatRelay thread cache reset + recreated`);
        }
      }

      // NUKE_BOT was already set to false at the start of the nuke process
      console.log('[NUKE] Factory reset complete!');
    }

    // Auto-set FIRST_RUN=false after successful startup
    if (config.firstRun && !config.nukeBot) {
      try {
        const envPath = path.join(__dirname, '..', '.env');
        let envContent = fs.readFileSync(envPath, 'utf8');
        envContent = envContent.replace(/^FIRST_RUN\s*=\s*true$/m, 'FIRST_RUN=false');
        fs.writeFileSync(envPath, envContent, 'utf8');
        console.log('[BOT] FIRST_RUN set back to false in .env');
      } catch {
        console.warn('[BOT] Could not update .env — please manually set FIRST_RUN=false');
      }
    }

    console.log('[BOT] Ready!');
  })();
});

// ── Lifecycle embed cleanup ─────────────────────────────────

// ── Graceful shutdown ───────────────────────────────────────
async function shutdown(reason = 'Manual shutdown'): Promise<void> {
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

process.on('SIGINT', () => {
  void shutdown('SIGINT received');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM received');
});
process.on('uncaughtException', (err: Error & { code?: number }) => {
  console.error('[BOT] Uncaught exception:', err);

  // Discord API errors that are safe to ignore (don't crash)
  const recoverableCodes = [
    10062, // Unknown interaction (expired token — user clicked stale button/menu)
    10008, // Unknown Message (message was deleted)
    40060, // Interaction already acknowledged
  ];
  if (err.code && recoverableCodes.includes(err.code)) {
    console.log(`[BOT] Recoverable Discord error ${err.code} — continuing`);
    return; // do NOT crash
  }

  // Post to admin channel before shutting down
  void _postErrorEmbed('Uncaught Exception', err).finally(() => {
    shutdown(`Uncaught exception: ${err.message}`).catch(() => process.exit(1));
  });
});
process.on('unhandledRejection', (reason) => {
  console.error('[BOT] Unhandled rejection:', reason);
  void _postErrorEmbed('Unhandled Rejection', reason);
  // Log but don't crash — unhandled rejections are often recoverable
});

/**
 * Post a hard-error embed to admin alert channels for visibility.
 * Silently ignores failures (client may not be ready yet).
 */
async function _postErrorEmbed(title: string, err: unknown): Promise<void> {
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

// ── Login ───────────────────────────────────────────────────

/**
 * Delete all bot-authored threads and messages from a channel.
 * Used by NUKE_BOT to factory-reset Discord state before modules start.
 */
async function _nukeChannel(discordClient: Client, channelId: string, botId: string | undefined): Promise<void> {
  try {
    const ch = await discordClient.channels.fetch(channelId).catch(() => null);
    if (!ch) return;

    // Handle bot-authored threads (active + archived)
    // Delete ALL bot threads for a clean slate during nuke.
    if ('threads' in ch) {
      const textCh = ch as import('discord.js').TextChannel;
      const active = await textCh.threads.fetchActive().catch(() => ({ threads: new Map<string, ThreadChannel>() }));
      const archived = await textCh.threads
        .fetchArchived({ limit: 100 })
        .catch(() => ({ threads: new Map<string, ThreadChannel>() }));
      const allThreads: ThreadChannel[] = [...active.threads.values(), ...archived.threads.values()];
      for (const thread of allThreads) {
        if (thread.ownerId !== botId) continue;
        await thread.delete('NUKE_BOT factory reset').catch(() => {});
        const chName = 'name' in ch ? String((ch as { name: unknown }).name) : channelId;
        console.log(`[NUKE] Deleted thread "${thread.name}" from #${chName}`);
      }
    }

    // Delete bot-authored messages (scan up to 1000)
    if (!('messages' in ch)) return;
    const textCh = ch;
    let lastId: string | undefined;
    let deleted = 0;
    for (let page = 0; page < 10; page++) {
      const opts: { limit: number; before?: string } = { limit: 100 };
      if (lastId) opts.before = lastId;
      const batch = await textCh.messages.fetch(opts).catch(() => null);
      if (!batch || batch.size === 0) break;
      const lastMsg = batch.last();
      if (lastMsg) lastId = lastMsg.id;
      for (const [, msg] of batch) {
        if (msg.author.id !== botId) continue;
        await msg.delete().catch(() => {});
        deleted++;
      }
      if (batch.size < 100) break;
    }
    const chName = 'name' in ch ? String((ch as { name: unknown }).name) : channelId;
    if (deleted > 0) console.log(`[NUKE] Deleted ${deleted} message(s) from #${chName}`);
  } catch (err: unknown) {
    console.warn(`[NUKE] Could not clean channel ${channelId}:`, errMsg(err));
  }
}

void (async () => {
  // Load optional modules and slash commands (async import() requires async context)
  await loadOptionalModules(ctx);
  await loadCommands(ctx);

  // NUKE_BOT implies FIRST_RUN — wipe local data files first, then re-import
  // Log raw .env value for debugging — track unexpected NUKE_BOT=true
  const _nukeLog = createLogger(null, 'NUKE-AUDIT');
  _nukeLog.info(
    `STARTUP: NUKE_BOT=${String(process.env['NUKE_BOT'])}, config.nukeBot=${String(config.nukeBot)}, NUKE_THREADS=${String(process.env['NUKE_THREADS'])}`,
  );
  if (config.nukeBot) {
    console.log('[NUKE] NUKE_BOT=true — factory reset starting...');
    const dataDir = path.join(__dirname, '..', 'data');
    // Wipe all transient data files (preserves map-calibration.json)
    const filesToWipe = [
      'message-ids.json',
      'player-stats.json',
      'playtime.json',
      'welcome-stats.json',
      'server-settings.json',
      'log-offsets.json',
      'day-counts.json',
      'pvp-kills.json',
      'humanitz.db',
      'humanitz.db-wal',
      'humanitz.db-shm',
      'kill-tracker.json',
      'player-locations.json',
      'map-image.png',
      'save-cache.json',
      'weekly-baseline.json',
    ];
    for (const f of filesToWipe) {
      const fp = path.join(dataDir, f);
      if (fs.existsSync(fp)) {
        fs.unlinkSync(fp);
        console.log(`[NUKE] Deleted ${f}`);
      }
    }
    // Wipe per-server data directories
    const serversDir = path.join(dataDir, 'servers');
    if (fs.existsSync(serversDir)) {
      fs.rmSync(serversDir, { recursive: true, force: true });
      console.log('[NUKE] Deleted servers/ directory');
    }
    // Wipe removed-server configs (servers.json)
    const serversJson = path.join(dataDir, 'servers.json');
    if (fs.existsSync(serversJson)) {
      fs.unlinkSync(serversJson);
      console.log('[NUKE] Deleted servers.json');
    }
  }

  // Run setup/import if FIRST_RUN=true or NUKE_BOT=true
  if (config.firstRun || config.nukeBot) {
    console.log(`[BOT] ${config.nukeBot ? 'NUKE_BOT' : 'FIRST_RUN'}=true — running data import...`);
    const setupPath = path.join(__dirname, '..', 'setup.js');
    try {
      fs.accessSync(setupPath);
    } catch {
      console.error(`[BOT] setup.js not found at: ${setupPath}`);
      console.error('[BOT] Upload setup.js to the root of your bot folder (next to package.json).');
      console.error('[BOT] Continuing with existing data files...');
    }
    try {
      const { main: runSetup } = (await import(setupPath)) as { main: () => Promise<void> };
      await runSetup();
      console.log('[BOT] Data import complete.');
    } catch (err: unknown) {
      console.error('[BOT] Setup failed:', errMsg(err));
      console.error('[BOT] Continuing with existing/empty data files...');
    }
  }
  ctx.client.login(config.discordToken).catch((rawErr: unknown) => {
    const err = rawErr as Error & { code?: number };
    if (/disallowed intents/i.test(err.message) || err.code === 4014) {
      const requested: string[] = [];
      if (config.enableChatRelay) requested.push('Message Content (ENABLE_CHAT_RELAY=true)');
      if (config.adminRoleIds.length > 0) requested.push('Server Members (ADMIN_ROLE_IDS set)');
      console.error('');
      console.error('══════════════════════════════════════════════════════════');
      console.error('  Discord rejected the bot — "disallowed intents"');
      console.error('');
      console.error('  Your bot is requesting privileged intents that must be');
      console.error('  enabled in the Discord Developer Portal:');
      console.error('    https://discord.com/developers/applications');
      console.error('');
      console.error('  Go to: Your Application → Bot → Privileged Gateway Intents');
      if (requested.length > 0) {
        console.error('  Enable:');
        requested.forEach((r) => {
          console.error('    ✦ ' + r);
        });
      } else {
        console.error('  Enable: Message Content Intent');
      }
      console.error('');
      console.error('  Or disable the feature that needs it:');
      console.error('    • Set ENABLE_CHAT_RELAY=false in .env to skip Message Content');
      console.error('    • Remove ADMIN_ROLE_IDS from .env to skip Server Members');
      console.error('══════════════════════════════════════════════════════════');
      console.error('');
    } else {
      console.error('[BOT] Login failed:', err.message);
    }
    process.exit(1);
  });
})();
