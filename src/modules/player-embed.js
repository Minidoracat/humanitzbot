const { EmbedBuilder } = require('discord.js');
const _defaultPlaytime = require('../tracking/playtime-tracker');
const _defaultConfig = require('../config');

/**
 * Build a log-based player stats embed.
 * @param {object} stats       Player stats record
 * @param {object} [options]
 * @param {boolean} [options.isAdmin]
 * @param {object} [options.playtime]  Custom PlaytimeTracker instance
 * @param {object} [options.config]    Custom config object
 */
function buildPlayerEmbed(stats, { isAdmin = false, playtime, config } = {}) {
  const pt_inst = playtime || _defaultPlaytime;
  const cfg = config || _defaultConfig;

  const embed = new EmbedBuilder()
    .setTitle(stats.name)
    .setColor(0x9b59b6)
    .setTimestamp();

  // Get playtime data if available
  const pt = pt_inst.getPlaytime(stats.id);

  // ── Header description (playtime, sessions, last active) ──
  const descParts = [];
  if (pt) descParts.push(`⏱️ ${pt.totalFormatted} · ${pt.sessions} session${pt.sessions !== 1 ? 's' : ''}`);
  if (stats.lastEvent) {
    const lastDate = new Date(stats.lastEvent);
    const dateStr = `${lastDate.toLocaleDateString('en-GB', { timeZone: cfg.botTimezone })} ${lastDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: cfg.botTimezone })}`;
    descParts.push(`Last seen: ${dateStr}`);
  }
  if (stats.nameHistory && stats.nameHistory.length > 0) {
    descParts.push(`*aka ${stats.nameHistory.map(h => h.name).join(', ')}*`);
  }
  if (descParts.length > 0) embed.setDescription(descParts.join('\n'));

  // ── Combat Stats (combined) ──
  const dmgEntries = Object.entries(stats.damageTaken);
  const dmgTotal = dmgEntries.reduce((s, [, c]) => s + c, 0);
  const killEntries = Object.entries(stats.killedBy || {});

  const combatLines = [`💀 Deaths: **${stats.deaths}** · 🩸 Hits Taken: **${dmgTotal}**`];

  if (dmgEntries.length > 0) {
    const dmgSorted = dmgEntries.sort((a, b) => b[1] - a[1]);
    const dmgLines = dmgSorted.slice(0, 5).map(([src, count]) => `${src}: **${count}**`);
    if (dmgEntries.length > 5) dmgLines.push(`*+${dmgEntries.length - 5} more*`);
    combatLines.push(`\n**Damage Breakdown**\n${dmgLines.join('\n')}`);
  }

  if (killEntries.length > 0) {
    const killSorted = killEntries.sort((a, b) => b[1] - a[1]);
    const killLines = killSorted.slice(0, 5).map(([src, count]) => `${src}: **${count}**`);
    if (killEntries.length > 5) killLines.push(`*+${killEntries.length - 5} more*`);
    combatLines.push(`\n**Killed By**\n${killLines.join('\n')}`);
  }

  embed.addFields({ name: '⚔️ Combat', value: combatLines.join('\n') });

  // ── Base Activity (building + raids + looting) ──
  const baseParts = [];
  const buildEntries = Object.entries(stats.buildItems);
  if (buildEntries.length > 0) {
    const topBuilds = buildEntries.sort((a, b) => b[1] - a[1]).slice(0, 4);
    const buildStr = topBuilds.map(([item, count]) => `${item} x${count}`).join(', ');
    const moreStr = buildEntries.length > 4 ? ` +${buildEntries.length - 4} more` : '';
    baseParts.push(`🏗️ **${stats.builds} placed** — ${buildStr}${moreStr}`);
  } else if (stats.builds > 0) {
    baseParts.push(`🏗️ **${stats.builds}** placed`);
  }

  if (cfg.canShow('showRaidStats', isAdmin)) {
    const raidParts = [];
    if (stats.raidsOut > 0) raidParts.push(`Attacked: **${stats.raidsOut}**`);
    if (stats.destroyedOut > 0) raidParts.push(`Destroyed: **${stats.destroyedOut}**`);
    if (stats.raidsIn > 0) raidParts.push(`Raided: **${stats.raidsIn}**`);
    if (raidParts.length > 0) baseParts.push(`⚒️ ${raidParts.join(' · ')}`);
  }

  if (stats.containersLooted > 0) baseParts.push(`📦 **${stats.containersLooted}** containers looted`);

  if (baseParts.length > 0) embed.addFields({ name: '🏠 Base Activity', value: baseParts.join('\n') });

  // ── Connections + Anti-Cheat ──
  if (cfg.canShow('showConnections', isAdmin)) {
    const connParts = [];
    if (stats.connects !== undefined && stats.connects > 0) connParts.push(`In: **${stats.connects}**`);
    if (stats.disconnects !== undefined && stats.disconnects > 0) connParts.push(`Out: **${stats.disconnects}**`);
    if (stats.adminAccess !== undefined && stats.adminAccess > 0) connParts.push(`Admin: **${stats.adminAccess}**`);
    if (connParts.length > 0) embed.addFields({ name: '🔗 Connections', value: connParts.join(' · '), inline: true });
  }

  if (isAdmin && stats.cheatFlags && stats.cheatFlags.length > 0) {
    const flagLines = stats.cheatFlags.slice(-5).map(f => {
      const d = new Date(f.timestamp);
      const dateStr = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: cfg.botTimezone });
      return `${dateStr} — \`${f.type}\``;
    });
    if (stats.cheatFlags.length > 5) flagLines.unshift(`*Showing last 5 of ${stats.cheatFlags.length} flags*`);
    embed.addFields({ name: '🚩 Anti-Cheat Flags', value: flagLines.join('\n') });
  }

  return embed;
}

module.exports = { buildPlayerEmbed };
