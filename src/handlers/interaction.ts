/**
 * Discord interaction handler — routes player-stats select menus and slash
 * commands. Extracted verbatim from the inline `client.on(InteractionCreate)`
 * body in src/index.ts (P1-1b god-file split); the only change is module state
 * is read via the passed `ctx` and the select-menu helper now takes `ctx`.
 *
 * index.ts keeps a thin sync wrapper that fires this and discards the promise:
 *   client.on(Events.InteractionCreate, (i) => { void handleInteraction(ctx, i); });
 */
import { EmbedBuilder, MessageFlags } from 'discord.js';
import type { Interaction } from 'discord.js';
import { isAdminView } from '../runtime/helpers.js';
import type { AppContext } from '../runtime/app-context.js';
import type PlayerStatsChannel from '../modules/player-stats-channel.js';

/** Find a multi-server PlayerStatsChannel by server ID (used for select menu routing). */
function _findMultiServerPlayerStatsChannelById(ctx: AppContext, serverId: string): PlayerStatsChannel | null {
  if (!ctx.multiServerManager) return null;
  const instance = ctx.multiServerManager.getInstance(serverId);
  if (!instance) return null;
  return instance.getPlayerStatsChannel();
}

export async function handleInteraction(ctx: AppContext, interaction: Interaction): Promise<void> {
  // ── Persistent select menu on the player-stats channel ──
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('playerstats_player_select')) {
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === 10062 || code === 40060) {
        console.log('[BOT] Player select interaction expired, ignoring');
        return;
      }
      throw err;
    }

    const serverId = interaction.customId.split(':')[1] ?? '';
    const psc = serverId ? _findMultiServerPlayerStatsChannelById(ctx, serverId) : ctx.playerStatsChannel;
    if (!psc) {
      await interaction.editReply({ content: 'Player stats module is currently disabled.' });
      return;
    }

    const selectedId = interaction.values[0] ?? '';
    const isAdmin = isAdminView(interaction.inCachedGuild() ? interaction.member : null);

    const embed: EmbedBuilder = (
      psc as unknown as { buildFullPlayerEmbed: (id: string, opts: { isAdmin: boolean }) => EmbedBuilder }
    ) // SAFETY: buildFullPlayerEmbed injected via mixin at runtime
      .buildFullPlayerEmbed(selectedId, { isAdmin });
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── Clan select menu on the player-stats channel ──
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('playerstats_clan_select')) {
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === 10062 || code === 40060) {
        console.log('[BOT] Clan select interaction expired, ignoring');
        return;
      }
      throw err;
    }

    const serverId = interaction.customId.split(':')[1] ?? '';
    const psc = serverId ? _findMultiServerPlayerStatsChannelById(ctx, serverId) : ctx.playerStatsChannel;
    if (!psc) {
      await interaction.editReply({ content: 'Player stats module is currently disabled.' });
      return;
    }

    const clanName = (interaction.values[0] ?? '').replace(/^clan:/, '');
    const isAdmin = isAdminView(interaction.inCachedGuild() ? interaction.member : null);

    const embed: EmbedBuilder = (
      psc as unknown as { buildClanEmbed: (name: string, opts: { isAdmin: boolean }) => EmbedBuilder }
    ) // SAFETY: buildClanEmbed injected via mixin at runtime
      .buildClanEmbed(clanName, { isAdmin });
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── Slash commands ──
  if (!interaction.isChatInputCommand()) return;

  const command = ctx.slashCommands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`[BOT] Error in /${interaction.commandName}:`, err);
    const replyOpts = {
      content: '❌ Something went wrong running that command.',
      flags: MessageFlags.Ephemeral,
    } as const;
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(replyOpts);
    } else {
      await interaction.reply(replyOpts);
    }
  }
}
