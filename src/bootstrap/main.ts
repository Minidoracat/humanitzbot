/**
 * main — the bottom boot IIFE: load optional modules + slash commands, run the
 * NUKE_BOT data-file wipe and FIRST_RUN/NUKE setup import, then client.login
 * with the disallowed-intents diagnostic. Extracted verbatim from src/index.ts
 * (P1-1b god-file split); the body is byte-for-byte identical, with __dirname
 * rebased to src/ so the data/setup.js paths resolve exactly as before. The
 * await ordering (NUKE wipe before login) is load-bearing and preserved.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDirname } from '../utils/paths.js';
import { createLogger } from '../utils/log.js';
import { errMsg } from '../utils/error.js';
import config from '../config/index.js';
import { loadOptionalModules } from './optional-modules.js';
import { loadCommands } from './load-commands.js';
import type { AppContext } from '../runtime/app-context.js';

const __dirname = path.join(getDirname(import.meta.url), '..');

export async function main(ctx: AppContext): Promise<void> {
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
}
