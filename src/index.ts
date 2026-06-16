import { Client, GatewayIntentBits, Events } from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import { getDirname } from './utils/paths.js';

const __dirname = getDirname(import.meta.url);

// ── Structured logging system ──────────────────────────────
// Initializes the global logger with console (human-readable) + file (JSON) transports.
// All modules using createLogger() automatically write to both outputs.
import { initLogger } from './logger/logger.js';
import { createLogger } from './utils/log.js';
import { errMsg } from './utils/error.js';
initLogger();

import config from './config/index.js';
import { createAppContext } from './runtime/app-context.js';
import { loadOptionalModules } from './bootstrap/optional-modules.js';
import { loadCommands } from './bootstrap/load-commands.js';
import { handleInteraction } from './handlers/interaction.js';
import { shutdown, _postErrorEmbed } from './lifecycle/shutdown.js';
import { runReady } from './bootstrap/ready.js';

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
  runReady(ctx, readyClient);
});

// ── Lifecycle embed cleanup ─────────────────────────────────

// ── Graceful shutdown ───────────────────────────────────────

process.on('SIGINT', () => {
  void shutdown(ctx, 'SIGINT received');
});
process.on('SIGTERM', () => {
  void shutdown(ctx, 'SIGTERM received');
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
  void _postErrorEmbed(ctx, 'Uncaught Exception', err).finally(() => {
    shutdown(ctx, `Uncaught exception: ${err.message}`).catch(() => process.exit(1));
  });
});
process.on('unhandledRejection', (reason) => {
  console.error('[BOT] Unhandled rejection:', reason);
  void _postErrorEmbed(ctx, 'Unhandled Rejection', reason);
  // Log but don't crash — unhandled rejections are often recoverable
});

// ── Login ───────────────────────────────────────────────────

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
