/**
 * loadCommands — discover and register slash commands from src/commands/ (and
 * its immediate subdirectories) into ctx.slashCommands. Extracted verbatim from
 * src/index.ts (P1-1b god-file split); the only change is the commands-root path
 * now resolves through `..` because this file lives under src/bootstrap/.
 *
 * Note: the `.js` filter is intentional — it matches the compiled dist/ output.
 * Under tsx (source .ts) no files match, so dev runs register zero commands
 * (preserved pre-existing behavior).
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDirname } from '../utils/paths.js';
import type { AppContext } from '../runtime/app-context.js';
import type { SlashCommand } from '../runtime/app-types.js';

const __dirname = getDirname(import.meta.url);

export async function loadCommands(ctx: AppContext): Promise<void> {
  const commandsPath = path.join(__dirname, '..', 'commands');
  const commandFiles = fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'));

  for (const file of commandFiles) {
    const command = (await import(path.join(commandsPath, file))) as Partial<SlashCommand> & {
      default?: Partial<SlashCommand>;
    };
    const cmd = command.default ?? command;
    if (cmd.data && cmd.execute) {
      ctx.slashCommands.set(cmd.data.name, cmd as SlashCommand);
      console.log(`[BOT] Loaded command: /${cmd.data.name}`);
    }
  }

  // Also load commands from subdirectories (e.g. src/commands/howyagarn/)
  for (const entry of fs.readdirSync(commandsPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const subDir = path.join(commandsPath, entry.name);
    const subFiles = fs.readdirSync(subDir).filter((f) => f.endsWith('.js'));
    for (const file of subFiles) {
      const command = (await import(path.join(subDir, file))) as Partial<SlashCommand> & {
        default?: Partial<SlashCommand>;
      };
      const cmd = command.default ?? command;
      if (cmd.data && cmd.execute) {
        ctx.slashCommands.set(cmd.data.name, cmd as SlashCommand);
        console.log(`[BOT] Loaded command: /${cmd.data.name} (${entry.name})`);
      }
    }
  }
}
