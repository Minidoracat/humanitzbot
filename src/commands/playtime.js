const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const playtime = require('../tracking/playtime-tracker');
const config = require('../config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('playtime')
    .setDescription('Show playtime leaderboard or look up a player')
    .addStringOption(option =>
      option
        .setName('player')
        .setDescription('Player name to look up (leave empty for leaderboard)')
        .setRequired(false)
    ),

  async execute(interaction) {
    await interaction.deferReply();

    try {
      const search = interaction.options.getString('player');

      if (search) {
        // Look up a specific player by name (partial match)
        const leaderboard = playtime.getLeaderboard();
        const match = leaderboard.find(
          e => e.name.toLowerCase() === search.toLowerCase()
        ) || leaderboard.find(
          e => e.name.toLowerCase().includes(search.toLowerCase())
        );

        if (!match) {
          await interaction.editReply(`No playtime data found for **${search}**.`);
          return;
        }

        const embed = new EmbedBuilder()
          .setTitle(`⏱️ ${match.name}'s Playtime`)
          .setColor(0x9b59b6)
          .addFields(
            { name: 'Total Playtime', value: match.totalFormatted, inline: true },
            { name: 'Sessions', value: `${match.sessions}`, inline: true },
            { name: 'Steam ID', value: require('../config').isAdminView(interaction.member) ? `\`${match.id}\`` : `\`${match.id.slice(0, 8)}···\``, inline: false },
          )
          .setFooter({ text: `Tracking since ${new Date(playtime.getTrackingSince()).toLocaleDateString('en-GB', { timeZone: config.botTimezone })}` })
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
      } else {
        // Show leaderboard
        const leaderboard = playtime.getLeaderboard();

        const embed = new EmbedBuilder()
          .setTitle('⏱️ Playtime Leaderboard')
          .setColor(0x9b59b6)
          .setFooter({ text: `Tracking since ${new Date(playtime.getTrackingSince()).toLocaleDateString('en-GB', { timeZone: config.botTimezone })}` })
          .setTimestamp();

        if (leaderboard.length === 0) {
          embed.setDescription('No playtime data recorded yet.');
        } else {
          const top = leaderboard.slice(0, 20);
          const lines = top.map((entry, i) => {
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `\`${i + 1}.\``;
            return `${medal} **${entry.name}** — ${entry.totalFormatted} (${entry.sessions} session${entry.sessions !== 1 ? 's' : ''})`;
          });

          embed.setDescription(lines.join('\n'));

          if (leaderboard.length > 20) {
            embed.addFields({ name: '\u200b', value: `*…and ${leaderboard.length - 20} more*` });
          }
        }

        await interaction.editReply({ embeds: [embed] });
      }
    } catch (err) {
      console.error('[CMD:playtime]', err.message);
      await interaction.editReply('❌ Failed to retrieve playtime data.');
    }
  },
};
