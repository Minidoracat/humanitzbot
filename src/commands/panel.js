const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const panelApi = require('../server/panel-api');
const { formatBytes, formatUptime } = require('../server/server-resources');

// ── State colour map ────────────────────────────────────────
const STATE_DISPLAY = {
  running:  { emoji: '🟢', label: 'Running',  color: 0x2ecc71 },
  starting: { emoji: '🟡', label: 'Starting', color: 0xf1c40f },
  stopping: { emoji: '🟠', label: 'Stopping', color: 0xe67e22 },
  offline:  { emoji: '🔴', label: 'Offline',  color: 0xe74c3c },
};

function _stateInfo(state) {
  return STATE_DISPLAY[state] || { emoji: '⚪', label: state || 'Unknown', color: 0x95a5a6 };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('qspanel')
    .setDescription('Server admin panel — power, console, backups, status (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

    // ── /qspanel status ─────────────────────────────────────
    .addSubcommand(sub => sub
      .setName('status')
      .setDescription('Server power state, resources, and host details')
    )

    // ── /qspanel start ──────────────────────────────────────
    .addSubcommand(sub => sub
      .setName('start')
      .setDescription('Start the game server')
    )

    // ── /qspanel stop ───────────────────────────────────────
    .addSubcommand(sub => sub
      .setName('stop')
      .setDescription('Gracefully stop the game server')
    )

    // ── /qspanel restart ────────────────────────────────────
    .addSubcommand(sub => sub
      .setName('restart')
      .setDescription('Restart the game server')
    )

    // ── /qspanel kill ───────────────────────────────────────
    .addSubcommand(sub => sub
      .setName('kill')
      .setDescription('Force-kill the game server process (emergency only)')
    )

    // ── /qspanel console ────────────────────────────────────
    .addSubcommand(sub => sub
      .setName('console')
      .setDescription('Send a console command via the hosting panel')
      .addStringOption(opt => opt
        .setName('command')
        .setDescription('The console command to send')
        .setRequired(true)
      )
    )

    // ── /qspanel backups ────────────────────────────────────
    .addSubcommand(sub => sub
      .setName('backups')
      .setDescription('List server backups')
    )

    // ── /qspanel backup-create ──────────────────────────────
    .addSubcommand(sub => sub
      .setName('backup-create')
      .setDescription('Create a new server backup')
      .addStringOption(opt => opt
        .setName('name')
        .setDescription('Backup name (optional — auto-generated if empty)')
        .setRequired(false)
      )
    )

    // ── /qspanel backup-delete ──────────────────────────────
    .addSubcommand(sub => sub
      .setName('backup-delete')
      .setDescription('Delete a server backup by its UUID')
      .addStringOption(opt => opt
        .setName('uuid')
        .setDescription('The backup UUID to delete')
        .setRequired(true)
      )
    )

    // ── /qspanel schedules ──────────────────────────────────
    .addSubcommand(sub => sub
      .setName('schedules')
      .setDescription('List panel schedules (auto-restart, etc.)')
    ),

  async execute(interaction) {
    // Gate: panel must be configured
    if (!panelApi.available) {
      await interaction.reply({
        content: '❌ Panel API is not configured. Set `PANEL_SERVER_URL` and `PANEL_API_KEY` in your `.env` file.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case 'status':   return _status(interaction);
      case 'start':    return _power(interaction, 'start');
      case 'stop':     return _power(interaction, 'stop');
      case 'restart':  return _power(interaction, 'restart');
      case 'kill':     return _power(interaction, 'kill');
      case 'console':  return _console(interaction);
      case 'backups':  return _backups(interaction);
      case 'backup-create': return _backupCreate(interaction);
      case 'backup-delete': return _backupDelete(interaction);
      case 'schedules':     return _schedules(interaction);
      default:
        await interaction.reply({ content: `❌ Unknown subcommand: ${sub}`, flags: MessageFlags.Ephemeral });
    }
  },
};

// ── /panel status ───────────────────────────────────────────

async function _status(interaction) {
  await interaction.deferReply();

  try {
    const [resources, details] = await Promise.all([
      panelApi.getResources(),
      panelApi.getServerDetails(),
    ]);

    const si = _stateInfo(resources.state);
    const embed = new EmbedBuilder()
      .setTitle('🖥️ Server Panel')
      .setColor(si.color)
      .setTimestamp();

    // State + name
    const name = details.name || 'Game Server';
    embed.setDescription(`**${name}**\n${si.emoji} **${si.label}**`);

    // Resources
    const resParts = [];
    if (resources.cpu != null) resParts.push(`🖥️ CPU: **${resources.cpu}%**`);
    if (resources.memUsed != null && resources.memTotal != null) {
      resParts.push(`🧠 RAM: **${formatBytes(resources.memUsed)}** / ${formatBytes(resources.memTotal)} (${resources.memPercent ?? '?'}%)`);
    }
    if (resources.diskUsed != null && resources.diskTotal != null) {
      resParts.push(`💾 Disk: **${formatBytes(resources.diskUsed)}** / ${formatBytes(resources.diskTotal)} (${resources.diskPercent ?? '?'}%)`);
    }
    if (resources.uptime != null) {
      const up = formatUptime(resources.uptime);
      if (up) resParts.push(`⏱️ Uptime: **${up}**`);
    }
    if (resParts.length > 0) {
      embed.addFields({ name: '📊 Resources', value: resParts.join('\n') });
    }

    // Limits
    const limits = details.limits || {};
    const limitParts = [];
    if (limits.memory) limitParts.push(`RAM: ${limits.memory} MB`);
    if (limits.disk) limitParts.push(`Disk: ${limits.disk === 0 ? 'Unlimited' : `${limits.disk} MB`}`);
    if (limits.cpu) limitParts.push(`CPU: ${limits.cpu}%`);
    if (limitParts.length > 0) {
      embed.addFields({ name: '📋 Plan Limits', value: limitParts.join('  ·  '), inline: true });
    }

    // Feature limits
    const fl = details.feature_limits || {};
    const fParts = [];
    if (fl.databases != null) fParts.push(`Databases: ${fl.databases}`);
    if (fl.allocations != null) fParts.push(`Ports: ${fl.allocations}`);
    if (fl.backups != null) fParts.push(`Backups: ${fl.backups}`);
    if (fParts.length > 0) {
      embed.addFields({ name: '🔧 Features', value: fParts.join('  ·  '), inline: true });
    }

    // Node info
    if (details.node) {
      embed.addFields({ name: '🌐 Node', value: details.node, inline: true });
    }

    embed.setFooter({ text: 'Panel API · Pterodactyl' });

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('[CMD:panel:status]', err.message);
    await interaction.editReply({ content: `❌ Failed to fetch server status: ${err.message}` });
  }
}

// ── /panel start|stop|restart|kill ──────────────────────────

async function _power(interaction, signal) {
  await interaction.deferReply();

  const labels = {
    start:   { verb: 'Starting', emoji: '🟢', color: 0x2ecc71 },
    stop:    { verb: 'Stopping', emoji: '🔴', color: 0xe74c3c },
    restart: { verb: 'Restarting', emoji: '🔄', color: 0xf39c12 },
    kill:    { verb: 'Killing', emoji: '💀', color: 0xe74c3c },
  };
  const l = labels[signal];

  try {
    await panelApi.sendPowerAction(signal);

    const embed = new EmbedBuilder()
      .setTitle(`${l.emoji} ${l.verb} Server`)
      .setDescription(`Power signal \`${signal}\` sent successfully.\nThe server may take a moment to respond.`)
      .setColor(l.color)
      .setFooter({ text: `Requested by ${interaction.user.tag}` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error(`[CMD:panel:${signal}]`, err.message);
    await interaction.editReply({ content: `❌ Power action \`${signal}\` failed: ${err.message}` });
  }
}

// ── /panel console ──────────────────────────────────────────

async function _console(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const command = interaction.options.getString('command');

  try {
    await panelApi.sendCommand(command);

    const embed = new EmbedBuilder()
      .setTitle('🖥️ Console Command Sent')
      .setDescription(`\`\`\`\n${command}\n\`\`\`\n*Note: Panel console is fire-and-forget — no response is returned. Use \`/rcon\` for commands that need a response.*`)
      .setColor(0x3498db)
      .setFooter({ text: `Sent by ${interaction.user.tag}` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('[CMD:panel:console]', err.message);
    await interaction.editReply({ content: `❌ Console command failed: ${err.message}` });
  }
}

// ── /panel backups ──────────────────────────────────────────

async function _backups(interaction) {
  await interaction.deferReply();

  try {
    const backups = await panelApi.listBackups();

    const embed = new EmbedBuilder()
      .setTitle('💾 Server Backups')
      .setColor(0x3498db)
      .setTimestamp();

    if (backups.length === 0) {
      embed.setDescription('No backups found.');
    } else {
      const lines = backups.map((b, i) => {
        const status = b.is_successful ? '✅' : '❌';
        const lock = b.is_locked ? ' 🔒' : '';
        const size = formatBytes(b.bytes);
        const date = b.completed_at
          ? new Date(b.completed_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
          : 'In progress...';
        return `${status}${lock} **${b.name || `Backup ${i + 1}`}** — ${size}\n> ${date}\n> \`${b.uuid}\``;
      });
      embed.setDescription(lines.join('\n\n'));
    }

    embed.setFooter({ text: `${backups.length} backup(s) · Panel API` });

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('[CMD:panel:backups]', err.message);
    await interaction.editReply({ content: `❌ Failed to list backups: ${err.message}` });
  }
}

// ── /panel backup-create ────────────────────────────────────

async function _backupCreate(interaction) {
  await interaction.deferReply();

  const name = interaction.options.getString('name') || '';

  try {
    const backup = await panelApi.createBackup(name);

    const embed = new EmbedBuilder()
      .setTitle('💾 Backup Created')
      .setDescription(`**${backup.name || 'New Backup'}**\nUUID: \`${backup.uuid || 'pending'}\`\n\nThe backup is being created. It may take a few minutes to complete.`)
      .setColor(0x2ecc71)
      .setFooter({ text: `Requested by ${interaction.user.tag}` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('[CMD:panel:backup-create]', err.message);
    // Common error: backup limit reached
    const msg = err.message.includes('409') || err.message.includes('limit')
      ? `❌ Backup limit reached. Delete an existing backup first, or upgrade your plan.`
      : `❌ Failed to create backup: ${err.message}`;
    await interaction.editReply({ content: msg });
  }
}

// ── /panel backup-delete ────────────────────────────────────

async function _backupDelete(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const uuid = interaction.options.getString('uuid');

  try {
    await panelApi.deleteBackup(uuid);

    await interaction.editReply({
      content: `✅ Backup \`${uuid}\` deleted.`,
    });
  } catch (err) {
    console.error('[CMD:panel:backup-delete]', err.message);
    await interaction.editReply({ content: `❌ Failed to delete backup: ${err.message}` });
  }
}

// ── /panel schedules ────────────────────────────────────────

async function _schedules(interaction) {
  await interaction.deferReply();

  try {
    const schedules = await panelApi.listSchedules();

    const embed = new EmbedBuilder()
      .setTitle('📅 Panel Schedules')
      .setColor(0x3498db)
      .setTimestamp();

    if (schedules.length === 0) {
      embed.setDescription('No schedules configured.\nUse your hosting panel to create schedules (auto-restart, backups, etc.).');
    } else {
      const lines = schedules.map(s => {
        const active = s.is_active ? '🟢' : '⚫';
        const onlineOnly = s.only_when_online ? ' (online only)' : '';
        const cron = `${s.cron?.minute ?? '*'} ${s.cron?.hour ?? '*'} ${s.cron?.day_of_month ?? '*'} ${s.cron?.month ?? '*'} ${s.cron?.day_of_week ?? '*'}`;
        const lastRun = s.last_run_at
          ? new Date(s.last_run_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
          : 'Never';
        const nextRun = s.next_run_at
          ? new Date(s.next_run_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
          : '--';
        return `${active} **${s.name}**${onlineOnly}\n> Cron: \`${cron}\` · Last: ${lastRun} · Next: ${nextRun}`;
      });
      embed.setDescription(lines.join('\n\n'));
    }

    embed.setFooter({ text: `${schedules.length} schedule(s) · Panel API` });

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('[CMD:panel:schedules]', err.message);
    await interaction.editReply({ content: `❌ Failed to list schedules: ${err.message}` });
  }
}
