import { Client, GatewayIntentBits, Events } from 'discord.js';

// ── Structured logging system ──────────────────────────────
// Initializes the global logger with console (human-readable) + file (JSON) transports.
// All modules using createLogger() automatically write to both outputs.
// initLogger() must run before any module's createLogger() import side effect.
import { initLogger } from './logger/logger.js';
initLogger();

import config from './config/index.js';
import { createAppContext } from './runtime/app-context.js';
import { handleInteraction } from './handlers/interaction.js';
import { shutdown, _postErrorEmbed } from './lifecycle/shutdown.js';
import { runReady } from './bootstrap/ready.js';
import { main } from './bootstrap/main.js';

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

void main(ctx);
