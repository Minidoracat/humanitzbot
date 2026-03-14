/**
 * Panel Channel  unified admin dashboard.
 *
 * Single message with stacked Components v2 containers showing bot,
 * primary server, and managed servers. A view selector switches which
 * controls are active. Admin-only channel. Requires PANEL_CHANNEL_ID.
 */

const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');
const config = require('../config');
const panelApi = require('../server/panel-api');
const SftpClient = require('ssh2-sftp-client');
const { formatBytes, formatUptime } = require('../server/server-resources');
const { blockBar: _progressBar } = require('../server/server-display');
const { BTN, SELECT, ENV_CATEGORIES, GAME_SETTINGS_CATEGORIES } = require('./panel-constants');
const { buildDiagnostics } = require('./panel-diagnostics');
const { cleanOwnMessages } = require('./discord-utils');

//  State colour map 
const STATE_DISPLAY = {
  running:  { emoji: '🟢', label: 'Running',  color: 0x2ecc71 },
  starting: { emoji: '🟡', label: 'Starting', color: 0xf1c40f },
  stopping: { emoji: '🟠', label: 'Stopping', color: 0xe67e22 },
  offline:  { emoji: '🔴', label: 'Offline',  color: 0xe74c3c },
};

function _stateInfo(state) {
  return STATE_DISPLAY[state] || { emoji: '⚪', label: state || 'Unknown', color: 0x95a5a6 };
}

//  .env file helpers (shared via panel-env.js) 
const {
  getEnvValue: _getEnvValue,
  writeEnvValues: _writeEnvValues,
  applyLiveConfig: _applyLiveConfig,
  getCachedSettings: _getCachedSettings,
} = require('./panel-env');

/** Format milliseconds as "2d 5h 12m" */
function _formatBotUptime(ms) {
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${mins}m`);
  return parts.join(' ');
}

/**
 * Discord modal titles are limited to 45 chars.
 * Trim defensively so category labels can never crash interaction handlers.
 */
function _modalTitle(title, max = 45) {
  const text = String(title ?? '');
  if (text.length <= max) return text;
  const suffix = '...';
  const keep = Math.max(1, max - suffix.length);
  let base = text.slice(0, keep);
  // Avoid leaving a dangling high surrogate at the end.
  const last = base.charCodeAt(base.length - 1);
  if (last >= 0xD800 && last <= 0xDBFF) base = base.slice(0, -1);
  return `${base}${suffix}`;
}

// Components v2 helpers
const COMPONENTS_V2_FLAG = MessageFlags.IsComponentsV2 ?? (1 << 15);
const MAX_V2_COMPONENTS = 40;
const V2 = {
  ACTION_ROW: 1,
  TEXT_DISPLAY: 10,
  CONTAINER: 17,
};

function _toComponentJSON(component) {
  return typeof component?.toJSON === 'function' ? component.toJSON() : component;
}

function _textDisplay(content) {
  return { type: V2.TEXT_DISPLAY, content: String(content ?? '') };
}

function _container(textBlocks = [], rows = [], accentColor = null) {
  const components = [];
  for (const block of textBlocks) {
    if (!block) continue;
    components.push(_textDisplay(block));
  }
  for (const row of rows) {
    if (!row) continue;
    components.push(_toComponentJSON(row));
  }
  const c = { type: V2.CONTAINER, components };
  if (accentColor != null) c.accent_color = accentColor;
  return c;
}

function _componentsKey(components = []) {
  return JSON.stringify(components.map(c => _toComponentJSON(c)));
}

function _countComponents(components = []) {
  let total = 0;
  const stack = [...components];
  while (stack.length > 0) {
    const next = stack.pop();
    if (!next || typeof next !== 'object') continue;
    total += 1;
    if (Array.isArray(next.components)) {
      for (const child of next.components) stack.push(child);
    }
    if (next.accessory && typeof next.accessory === 'object') {
      stack.push(next.accessory);
    }
  }
  return total;
}

function _errorSummary(err) {
  const parts = [];
  if (err?.message) parts.push(err.message);
  if (err?.code) parts.push(`code=${err.code}`);
  const rawMessage = err?.rawError?.message;
  if (rawMessage) parts.push(`api=${rawMessage}`);
  if (err?.rawError?.errors) {
    try { parts.push(JSON.stringify(err.rawError.errors)); } catch {}
  }
  return parts.join(' | ');
}

function _diagnosticToMarkdown(diagnosticLike) {
  const raw = typeof diagnosticLike?.toJSON === 'function'
    ? diagnosticLike.toJSON()
    : (diagnosticLike?.data || diagnosticLike || {});

  const parts = [];
  if (raw.title) parts.push(`## ${raw.title}`);
  if (raw.description) parts.push(raw.description);
  if (Array.isArray(raw.fields)) {
    for (const f of raw.fields) {
      if (!f) continue;
      const name = f.name || 'Section';
      const value = f.value || '-';
      parts.push(`### ${name}\n${value}`);
    }
  }
  if (raw.footer?.text) parts.push(`-# ${raw.footer.text}`);
  const text = parts.join('\n\n').trim();
  if (!text) return 'No diagnostic details.';
  return text.length > 3900 ? `${text.slice(0, 3897)}...` : text;
}

// 
// PanelChannel class
// 

class PanelChannel {

  /**
   * @param {import('discord.js').Client} client
   * @param {object} opts
   * @param {object} opts.moduleStatus - reference to the moduleStatus object from index.js
   * @param {Date}   opts.startedAt    - bot startup timestamp
   */
  constructor(client, { moduleStatus = {}, startedAt = new Date(), multiServerManager = null, db = null, saveService = null, logWatcher = null } = {}) {
    this.client = client;
    this.channel = null;
    this.panelMessage = null;  // single unified panel message
    this.botMessage = null;    // alias kept for interaction handler compat (points to panelMessage)
    this._serverMessages = new Map(); // serverId  Discord message (kept for compat, unused in unified mode)
    this._lastServerKeys = new Map(); // serverId  content hash
    this.interval = null;
    this.updateIntervalMs = parseInt(config.serverStatusInterval, 10) || 30000;
    this._lastBotKey = null;
    this._lastPanelKey = null;
    this._lastState = null;
    this._backupLimit = null;
    this._activeView = 'bot'; // 'bot' | 'server' | serverId
    this.moduleStatus = moduleStatus;
    this.startedAt = startedAt;
    this.multiServerManager = multiServerManager;
    this._db = db;
    this._saveService = saveService;
    this._logWatcher = logWatcher;
    this._pendingServers = new Map(); // userId  { ...partial server config, _createdAt }
    // Setup wizard state (when config.needsSetup is true)
    this._setupWizard = null; // { profile, rcon: {host,port,password}, sftp: {host,port,user,password}, channels: {...}, step }
    // Clean up stale pending entries every 5 minutes
    this._pendingCleanupTimer = setInterval(() => {
      const cutoff = Date.now() - 10 * 60 * 1000; // 10-min TTL
      for (const [uid, data] of this._pendingServers) {
        if ((data._createdAt || 0) < cutoff) this._pendingServers.delete(uid);
      }
    }, 5 * 60 * 1000);
  }

  /** Whether SFTP credentials are configured (needed for game settings editor). */
  get _hasSftp() {
    return !!(config.ftpHost && config.ftpUser && (config.ftpPassword || config.ftpPrivateKeyPath));
  }

  /**
   * Check admin permission (synchronous). Returns true if admin, false if not.
   * Caller must handle defer/reply themselves.
   * Usage: `if (!this._isAdmin(interaction)) { await interaction.editReply(' Admin only'); return; }`
   */
  _isAdmin(interaction) {
    return interaction.member?.permissions?.has(PermissionFlagsBits.Administrator) || false;
  }

  /**
   * @deprecated Use _isAdmin() + manual editReply instead. This causes interaction timeout issues.
   * Check admin permission. Returns true if admin, false (with ephemeral reply) if not.
   * Usage: `if (!await this._requireAdmin(interaction, 'edit config')) return true;`
   */
  async _requireAdmin(interaction, action) {
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: `[ERR] Only administrators can ${action}.`, flags: MessageFlags.Ephemeral });
      return false;
    }
    return true;
  }

  async start() {
    console.log('[PANEL CH] Module starting...');

    if (!config.panelChannelId) {
      console.log('[PANEL CH] No PANEL_CHANNEL_ID set, skipping.');
      return;
    }

    try {
      this.channel = await this.client.channels.fetch(config.panelChannelId);
      if (!this.channel) {
        console.error('[PANEL CH] Channel not found! Check PANEL_CHANNEL_ID.');
        return;
      }

      //  Setup wizard mode 
      if (config.needsSetup) {
        console.log('[PANEL CH] RCON not configured - launching setup wizard');
        await this._cleanOwnMessages();
        await this._startSetupWizard();
        return;
      }

      const features = [];
      features.push('bot controls');
      features.push('env editor');
      if (this._hasSftp && config.enableGameSettingsEditor) features.push('game settings (SFTP)');
      if (panelApi.available) features.push('server panel (API)');
      if (this.multiServerManager) {
        const count = this.multiServerManager.getAllServers().length;
        if (count > 0) features.push(`${count} managed server(s)`);
      }
      console.log(`[PANEL CH] Posting unified panel in #${this.channel.name} - ${features.join(', ')} (every ${this.updateIntervalMs / 1000}s)`);
      await this._cleanOwnMessages();
      await this._cleanStalePanelMessages();

      //  Single unified message with Components v2 containers 
      const { components } = await this._buildUnifiedPanel();
      try {
        this.panelMessage = await this.channel.send({ flags: COMPONENTS_V2_FLAG, components });
      } catch (sendErr) {
        console.error('[PANEL CH] Initial publish failed:', _errorSummary(sendErr));
        // Minimal fallback so the panel is always visible after restart.
        this.panelMessage = await this.channel.send({
          flags: COMPONENTS_V2_FLAG,
          components: [_container(['Panel started, but the full layout was rejected by Discord. Check logs.'], [], 0xe67e22)],
        });
      }
      this.botMessage = this.panelMessage; // alias for interaction handler compat
      await this._cleanStalePanelMessages(this.panelMessage.id);

      // Persist message ID
      this._saveMessageIds();

      // First real update
      await this._update(true);

      // Refresh loop
      this.interval = setInterval(() => this._update(), this.updateIntervalMs);
    } catch (err) {
      console.error('[PANEL CH] Failed to start:', _errorSummary(err));
    }
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this._pendingCleanupTimer) {
      clearInterval(this._pendingCleanupTimer);
      this._pendingCleanupTimer = null;
    }
  }
  // 
  // Interaction router
  // 

  async handleInteraction(interaction) {
    //  Setup wizard interactions 
    if (this._setupWizard !== null) {
      return this._handleSetupInteraction(interaction);
    }

    //  Buttons 
    if (interaction.isButton()) {
      const id = interaction.customId;
      if ([BTN.START, BTN.STOP, BTN.RESTART, BTN.BACKUP, BTN.KILL].includes(id)) {
        return this._handlePowerButton(interaction, id);
      }
      if (id === BTN.BOT_RESTART) {
        return this._handleBotRestart(interaction);
      }
      if (id === BTN.NUKE) {
        return this._handleNukeButton(interaction);
      }
      if (id === BTN.REIMPORT) {
        return this._handleReimportButton(interaction);
      }
      if (id === BTN.DIAGNOSTICS) {
        return this._handleDiagnosticsButton(interaction);
      }
      if (id === BTN.ENV_SYNC) {
        return this._handleEnvSyncButton(interaction);
      }
      if (id === BTN.WELCOME_EDIT) {
        return this._handleWelcomeEditButton(interaction);
      }
      if (id === 'panel_welcome_open_modal') {
        return this._handleWelcomeOpenModal(interaction);
      }
      if (id === BTN.BROADCASTS) {
        return this._handleBroadcastsButton(interaction);
      }
      if (id === 'panel_broadcasts_open_modal') {
        return this._handleBroadcastsOpenModal(interaction);
      }
      if (id === BTN.ADD_SERVER) {
        return this._handleAddServerButton(interaction);
      }
      if (id.startsWith('panel_srv_')) {
        return this._handleServerAction(interaction, id);
      }
      if (id.startsWith('panel_add_sftp:')) {
        return this._handleAddSftpButton(interaction, id);
      }
      if (id.startsWith('panel_add_step2:')) {
        return this._handleAddServerStep2Button(interaction, id);
      }
      return false;
    }

    //  Select menus 
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === SELECT.VIEW) {
        return this._handleViewSelect(interaction);
      }
      if (interaction.customId === SELECT.ACTIONS_BOT) {
        return this._handleBotActionsSelect(interaction);
      }
      if (interaction.customId === SELECT.ACTIONS_SERVER) {
        return this._handleServerActionsSelect(interaction);
      }
      if (interaction.customId === SELECT.ACTIONS_MANAGED) {
        return this._handleManagedActionsSelect(interaction);
      }
      if (interaction.customId === SELECT.ENV || interaction.customId === SELECT.ENV2) {
        return this._handleEnvSelect(interaction);
      }
      if (interaction.customId === SELECT.SETTINGS) {
        return this._handleGameSettingsSelect(interaction);
      }
      if (interaction.customId.startsWith('panel_srv_settings:')) {
        return this._handleSrvGameSettingsSelect(interaction);
      }
      return false;
    }

    //  Modals 
    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith('panel_env_modal:')) {
        return this._handleEnvModal(interaction);
      }
      if (interaction.customId === 'panel_nuke_confirm') {
        return this._handleNukeConfirmModal(interaction);
      }
      if (interaction.customId.startsWith('panel_game_modal:')) {
        return this._handleGameSettingsModal(interaction);
      }
      if (interaction.customId === 'panel_welcome_modal') {
        return this._handleWelcomeModal(interaction);
      }
      if (interaction.customId === 'panel_broadcasts_modal') {
        return this._handleBroadcastsModal(interaction);
      }
      if (interaction.customId === 'panel_add_modal_step1') {
        return this._handleAddServerStep1Modal(interaction);
      }
      if (interaction.customId.startsWith('panel_add_modal_step2:')) {
        return this._handleAddServerStep2Modal(interaction);
      }
      if (interaction.customId.startsWith('panel_add_sftp_modal:')) {
        return this._handleAddSftpModal(interaction);
      }
      if (interaction.customId.startsWith('panel_srv_edit_modal:')) {
        return this._handleEditServerModal(interaction);
      }
      if (interaction.customId.startsWith('panel_srv_channels_modal:')) {
        return this._handleEditChannelsModal(interaction);
      }
      if (interaction.customId.startsWith('panel_srv_sftp_modal:')) {
        return this._handleEditSftpModal(interaction);
      }
      if (interaction.customId.startsWith('panel_srv_game_modal:')) {
        return this._handleSrvGameSettingsModal(interaction);
      }
      if (interaction.customId.startsWith('panel_srv_welcome_modal:')) {
        return this._handleSrvWelcomeModal(interaction);
      }
      if (interaction.customId.startsWith('panel_srv_automsg_modal:')) {
        return this._handleSrvAutoMsgModal(interaction);
      }
      return false;
    }

    return false;
  }

  async _handleBotActionsSelect(interaction) {
    const action = interaction.values?.[0];
    switch (action) {
      case 'diagnostics':
        return this._handleDiagnosticsButton(interaction);
      case 'env_sync':
        return this._handleEnvSyncButton(interaction);
      case 'add_server':
        return this._handleAddServerButton(interaction);
      case 'restart_bot':
        return this._handleBotRestart(interaction);
      case 'reimport':
        return this._handleReimportButton(interaction);
      case 'factory_reset':
        return this._handleNukeButton(interaction);
      default:
        await interaction.reply({ content: '[ERR] Unknown action.', flags: MessageFlags.Ephemeral });
        return true;
    }
  }

  async _handleServerActionsSelect(interaction) {
    const action = interaction.values?.[0];
    switch (action) {
      case 'start':
        return this._handlePowerButton(interaction, BTN.START);
      case 'stop':
        return this._handlePowerButton(interaction, BTN.STOP);
      case 'restart':
        return this._handlePowerButton(interaction, BTN.RESTART);
      case 'backup':
        return this._handlePowerButton(interaction, BTN.BACKUP);
      case 'kill':
        return this._handlePowerButton(interaction, BTN.KILL);
      case 'welcome':
        return this._handleWelcomeEditButton(interaction);
      case 'broadcasts':
        return this._handleBroadcastsButton(interaction);
      default:
        await interaction.reply({ content: '[ERR] Unknown action.', flags: MessageFlags.Ephemeral });
        return true;
    }
  }

  async _handleManagedActionsSelect(interaction) {
    const raw = interaction.values?.[0] || '';
    const sep = raw.indexOf(':');
    if (sep <= 0 || sep === raw.length - 1) {
      await interaction.reply({ content: '[ERR] Invalid action.', flags: MessageFlags.Ephemeral });
      return true;
    }
    const action = raw.slice(0, sep);
    const serverId = raw.slice(sep + 1);
    const allowed = new Set(['start', 'stop', 'restart', 'edit', 'remove', 'channels', 'sftp', 'welcome', 'automsg']);
    if (!allowed.has(action)) {
      await interaction.reply({ content: '[ERR] Unknown action.', flags: MessageFlags.Ephemeral });
      return true;
    }
    return this._handleServerAction(interaction, `panel_srv_${action}:${serverId}`);
  }

  // 
  // Button handlers
  // 

  async _handlePowerButton(interaction, id) {
    // Defer immediately to prevent token expiry
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!this._isAdmin(interaction)) {
      await interaction.editReply('[ERR] Only administrators can use panel controls.');
      return true;
    }

    if (!panelApi.available) {
      await interaction.editReply('[ERR] Panel API is not configured. Power controls require PANEL_SERVER_URL and PANEL_API_KEY.');
      return true;
    }

    try {
      switch (id) {
        case BTN.START:
          await panelApi.sendPowerAction('start');
          await interaction.editReply('[OK] **Start** signal sent. The server is booting up...');
          break;
        case BTN.STOP:
          await panelApi.sendPowerAction('stop');
          await interaction.editReply('[OK] **Stop** signal sent. The server is shutting down gracefully...');
          break;
        case BTN.RESTART:
          await panelApi.sendPowerAction('restart');
          await interaction.editReply('[OK] **Restart** signal sent. The server will restart shortly...');
          break;
        case BTN.KILL:
          await panelApi.sendPowerAction('kill');
          await interaction.editReply('[WARN] **Kill** signal sent. The server process was forcefully terminated.');
          break;
        case BTN.BACKUP:
          await panelApi.createBackup();
          await interaction.editReply('[OK] **Backup** creation started. It will appear in the panel shortly.');
          break;
      }
      setTimeout(() => this._update(true), 3000);
    } catch (err) {
      await interaction.editReply(`[ERR] Action failed: ${err.message}`);
    }

    return true;
  }

  async _handleBotRestart(interaction) {
    if (!await this._requireAdmin(interaction, 'restart the bot')) return true;

    await interaction.reply({
      content: '[RESTART] Restarting bot... The process will exit and your process manager should restart it.',
      flags: MessageFlags.Ephemeral,
    });

    // Let Discord deliver the reply before exiting
    setTimeout(() => process.exit(0), 1500);
    return true;
  }

  async _handleNukeButton(interaction) {
    if (!await this._requireAdmin(interaction, 'factory reset the bot')) return true;

    // Confirmation modal  user must type "NUKE" to proceed
    const modal = new ModalBuilder()
      .setCustomId('panel_nuke_confirm')
      .setTitle('[WARN] Factory Reset - Confirm');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('confirm')
          .setLabel('Type NUKE to confirm (deletes ALL bot data)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('NUKE')
          .setRequired(true)
          .setMinLength(4)
          .setMaxLength(4)
      )
    );

    await interaction.showModal(modal);
    return true;
  }

  async _handleNukeConfirmModal(interaction) {
    if (!await this._requireAdmin(interaction, 'factory reset the bot')) return true;

    const confirm = interaction.fields.getTextInputValue('confirm').trim().toUpperCase();
    if (confirm !== 'NUKE') {
      await interaction.reply({ content: '[ERR] Factory reset cancelled - you must type `NUKE` exactly.', flags: MessageFlags.Ephemeral });
      return true;
    }

    // Set NUKE_BOT=true in .env and restart
    _writeEnvValues({ NUKE_BOT: 'true' });
    await interaction.reply({
      content: '[NUKE] **Factory Reset initiated.** The bot will restart, wipe all Discord messages and local data, then rebuild from server logs.\n\nThis may take a minute...',
      flags: MessageFlags.Ephemeral,
    });

    setTimeout(() => process.exit(0), 1500);
    return true;
  }

  async _handleReimportButton(interaction) {
    if (!await this._requireAdmin(interaction, 're-import data')) return true;

    // Set FIRST_RUN=true and restart  re-downloads logs and rebuilds stats
    _writeEnvValues({ FIRST_RUN: 'true' });
    await interaction.reply({
      content: '[IMPORT] **Re-Import started.** The bot will restart and re-download server logs to rebuild player stats and playtime data.\n\nExisting Discord messages are preserved - only local data is refreshed.',
      flags: MessageFlags.Ephemeral,
    });

    setTimeout(() => process.exit(0), 1500);
    return true;
  }

  // 
  // Diagnostics  delegates to panel-diagnostics.js
  // 

  async _handleDiagnosticsButton(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!this._isAdmin(interaction)) {
      await interaction.editReply({
        flags: COMPONENTS_V2_FLAG,
        content: null,
        embeds: [],
        components: [_container(['[ERR] Only administrators can view diagnostics.'], [], 0xe74c3c)],
      });
      return true;
    }

    const diagnosticData = await buildDiagnostics({
      client: this.client,
      db: this._db,
      saveService: this._saveService,
      logWatcher: this._logWatcher,
      moduleStatus: this.moduleStatus,
      startedAt: this.startedAt,
      hasSftp: this._hasSftp,
    });

    const components = (diagnosticData || []).map(e => _container([_diagnosticToMarkdown(e)], [], 0x5865f2));
    if (components.length === 0) {
      components.push(_container(['No diagnostic details.'], [], 0x5865f2));
    }

    await interaction.editReply({
      flags: COMPONENTS_V2_FLAG,
      content: null,
      embeds: [],
      components,
    });
    return true;
  }


  // 
  // View selector handler
  // 

  async _handleViewSelect(interaction) {
    const selected = interaction.values[0];
    // Map 'srv_xxx'  'xxx' for managed server views
    this._activeView = selected.startsWith('srv_') ? selected.slice(4) : selected;
    // Rebuild panel with new view and update the message
    try {
      await interaction.deferUpdate();
      await this._update(true);
    } catch (err) {
      console.error('[PANEL CH] View switch error:', err.message);
    }
    return true;
  }

  // 
  // Select menu  modal handlers
  // 

  async _handleEnvSelect(interaction) {
    if (!await this._requireAdmin(interaction, 'edit bot config')) return true;

    const categoryId = interaction.values[0];
    const category = ENV_CATEGORIES.find(c => c.id === categoryId);
    if (!category) {
      await interaction.reply({ content: '[ERR] Unknown category.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const restartTag = category.restart ? ' ( Bot Restart)' : ' ( Live)';
    const modal = new ModalBuilder()
      .setCustomId(`panel_env_modal:${categoryId}`)
      .setTitle(_modalTitle(`Edit: ${category.label}${restartTag}`));

    for (const field of category.fields) {
      const style = field.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short;
      const input = new TextInputBuilder()
        .setCustomId(field.env)
        .setLabel(field.label)
        .setStyle(style)
        .setRequired(false);

      if (field.sensitive) {
        const current = _getEnvValue(field);
        input.setPlaceholder(current ? 'Leave empty to keep current' : 'Enter value');
        input.setValue('');
      } else {
        input.setValue(_getEnvValue(field));
      }

      modal.addComponents(new ActionRowBuilder().addComponents(input));
    }

    await interaction.showModal(modal);
    return true;
  }

  async _handleGameSettingsSelect(interaction) {
    if (!await this._requireAdmin(interaction, 'edit server settings')) return true;

    if (!this._hasSftp) {
      await interaction.reply({ content: '[ERR] SFTP credentials not configured. Game settings require FTP_HOST, FTP_USER, and FTP_PASSWORD.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const categoryId = interaction.values[0];
    const category = GAME_SETTINGS_CATEGORIES.find(c => c.id === categoryId);
    if (!category) {
      await interaction.reply({ content: '[ERR] Unknown category.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const cached = _getCachedSettings(this._db);

    const modal = new ModalBuilder()
      .setCustomId(`panel_game_modal:${categoryId}`)
      .setTitle(_modalTitle(`Server: ${category.label} ( Server Restart)`));

    for (const setting of category.settings) {
      const currentValue = cached[setting.ini] != null ? String(cached[setting.ini]) : '';
      const input = new TextInputBuilder()
        .setCustomId(setting.ini)
        .setLabel(setting.label)
        .setStyle(TextInputStyle.Short)
        .setValue(currentValue)
        .setRequired(false);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
    }

    await interaction.showModal(modal);
    return true;
  }

  // 
  // Modal submit handlers
  // 

  async _handleEnvModal(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    if (!this._isAdmin(interaction)) {
      await interaction.editReply('[ERR] Only administrators can edit bot config.');
      return true;
    }

    const categoryId = interaction.customId.replace('panel_env_modal:', '');
    const category = ENV_CATEGORIES.find(c => c.id === categoryId);
    if (!category) {
      await interaction.editReply('[ERR] Unknown category.');
      return true;
    }

    try {
      const updates = {};
      const dbUpdates = {};
      const changes = [];

      for (const field of category.fields) {
        const newValue = interaction.fields.getTextInputValue(field.env);

        // Skip empty sensitive fields  keep current value unchanged
        if (field.sensitive && newValue === '') continue;

        const oldValue = _getEnvValue(field);

        if (newValue !== oldValue) {
          const displayOld = field.sensitive ? '' : (oldValue || '(empty)');
          const displayNew = field.sensitive ? '' : (newValue || '(empty)');
          changes.push(`**${field.label}:** \`${displayOld}\`  \`${displayNew}\``);

          if (!category.restart) {
            // Live-apply display settings  save to DB, not .env
            _applyLiveConfig(field, newValue);
            if (field.cfg) dbUpdates[field.cfg] = config[field.cfg];
          } else {
            // Restart-required settings  write to .env
            updates[field.env] = newValue;
          }
        }
      }

      if (changes.length === 0) {
        await interaction.editReply('[INFO] No changes detected.');
        return true;
      }

      // Persist restart-required changes to .env
      if (Object.keys(updates).length > 0) {
        _writeEnvValues(updates);
      }
      // Persist display settings to DB
      if (Object.keys(dbUpdates).length > 0) {
        config.saveDisplaySettings(this._db, dbUpdates);
      }

      let msg = `[OK] **${category.label}** updated:\n${changes.join('\n')}`;
      if (category.restart) {
        msg += '\n\n[WARN] **Restart the bot** for these changes to take effect.';
      } else {
        msg += '\n\n Changes applied immediately.';
      }

      await interaction.editReply(msg);

      // Refresh panel containers to show changes
      if (!category.restart) {
        setTimeout(() => this._update(true), 1000);
      }
    } catch (err) {
      await interaction.editReply(`[ERR] Failed to save: ${err.message}`);
    }

    return true;
  }

  async _handleGameSettingsModal(interaction) {
    if (!await this._requireAdmin(interaction, 'edit server settings')) return true;

    if (!this._hasSftp) {
      await interaction.reply({ content: '[ERR] SFTP credentials not configured.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const categoryId = interaction.customId.replace('panel_game_modal:', '');
    const category = GAME_SETTINGS_CATEGORIES.find(c => c.id === categoryId);
    if (!category) {
      await interaction.reply({ content: '[ERR] Unknown category.', flags: MessageFlags.Ephemeral });
      return true;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      // Read fresh INI content via SFTP (panel file API is blocked on some hosts)
      const settingsPath = config.ftpSettingsPath;
      const sftp = new SftpClient();
      await sftp.connect({
        host: config.ftpHost,
        port: config.ftpPort,
        username: config.ftpUser,
        password: config.ftpPassword,
      });

      let content;
      try {
        content = (await sftp.get(settingsPath)).toString('utf8');
      } catch (readErr) {
        await sftp.end().catch(() => {});
        throw new Error(`Could not read settings file: ${readErr.message}`);
      }

      const changes = [];
      const cached = _getCachedSettings(this._db);

      for (const setting of category.settings) {
        const newValue = interaction.fields.getTextInputValue(setting.ini).trim();
        const oldValue = cached[setting.ini] != null ? String(cached[setting.ini]) : '';

        if (newValue !== oldValue) {
          // Regex-replace in raw INI text to preserve comments/formatting
          const regex = new RegExp(`^(${setting.ini}\\s*=\\s*).*$`, 'm');
          if (regex.test(content)) {
            content = content.replace(regex, `$1${newValue}`);
          }
          changes.push(`**${setting.label}:** \`${oldValue || '?'}\`  \`${newValue}\``);
          cached[setting.ini] = newValue;
        }
      }

      if (changes.length === 0) {
        await sftp.end().catch(() => {});
        await interaction.editReply('[INFO] No changes detected.');
        return true;
      }

      // Write modified INI back via SFTP
      await sftp.put(Buffer.from(content, 'utf8'), settingsPath);
      await sftp.end().catch(() => {});

      // Update local cache so subsequent reads are fresh
      if (this._db) try { this._db.setStateJSON('server_settings', cached); } catch (_) {}

      let msg = `[OK] **${category.label}** updated:\n${changes.join('\n')}`;
      msg += '\n\n[WARN] **Restart the server** for these changes to take effect.';

      await interaction.editReply(msg);
    } catch (err) {
      await interaction.editReply(`[ERR] Failed to save: ${err.message}`);
    }

    return true;
  }

  // 
  // .env synchronization
  // 

  async _handleEnvSyncButton(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    if (!this._isAdmin(interaction)) {
      await interaction.editReply('[ERR] Only administrators can sync .env configuration.');
      return true;
    }

    const { needsSync, syncEnv, getVersion, getExampleVersion } = require('../env-sync');

    if (!needsSync()) {
      await interaction.editReply('[OK] Your `.env` is already up to date with `.env.example`.');
      return true;
    }

    try {
      const currentVer = getVersion();
      const targetVer = getExampleVersion();
      const result = syncEnv();

      const changes = [];
      if (result.added > 0) changes.push(`${result.added} new key(s) added`);
      if (result.deprecated > 0) changes.push(`${result.deprecated} deprecated key(s) commented out`);

      await interaction.editReply(
        `[OK] **.env synchronized!**\n\n` +
        `**Schema:** v${currentVer} -> v${targetVer}\n` +
        `**Changes:** ${changes.join(', ')}\n\n` +
        `A backup was saved to \`data/backups/\`\n\n` +
        `[WARN] **Restart the bot** to apply new configuration keys.`
      );

      // Refresh panel to update action menu state
      setTimeout(() => this._update(true), 2000);
    } catch (err) {
      await interaction.editReply(`[ERR] Failed to sync .env: ${err.message}`);
    }

    return true;
  }

  // 
  // Welcome message editor
  // 

  async _handleWelcomeEditButton(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    if (!this._isAdmin(interaction)) {
      await interaction.editReply('[ERR] Only administrators can edit the welcome message.');
      return true;
    }

    if (!this._hasSftp) {
      await interaction.editReply('[ERR] SFTP credentials not configured.');
      return true;
    }

    // Read current WelcomeMessage.txt from server
    let currentContent = '';
    try {
      const sftp = new SftpClient();
      await sftp.connect({
        host: config.ftpHost,
        port: config.ftpPort,
        username: config.ftpUser,
        password: config.ftpPassword,
      });
      currentContent = (await sftp.get(config.ftpWelcomePath)).toString('utf8');
      await sftp.end().catch(() => {});
    } catch (err) {
      // File may not exist yet  that's fine, start with empty
      currentContent = '';
    }

    // Discord modals can't be shown after deferReply  use a message with a button instead
    const helpText = [
      '** Welcome Message Editor**',
      '',
      'Click **Open Editor** below to edit your `WelcomeMessage.txt`.',
      'This is the popup players see when they join your server.',
      '',
      '**Color Tags** (game rich text):',
      '`<PN>text</>`  Red',
      '`<PR>text</>`  Green',
      '`<SP>text</>`  Ember/Orange',
      '`<FO>text</>`  Gray',
      '`<CL>text</>`  Blue',
      '',
      '**Placeholders** (auto-replaced):',
      '`{server_name}`  Server name from settings',
      '`{day}`  Current in-game day',
      '`{season}`  Current season',
      '`{weather}`  Current weather',
      '`{pvp_schedule}`  PvP schedule times',
      '`{discord_link}`  Your Discord invite link',
      '',
      '**Tip:** Leave the message blank and save to restore the default auto-generated welcome with leaderboards.',
      '',
      `Current length: ${currentContent.length} chars`,
    ].join('\n');

    // Store current content for the modal
    this._pendingWelcome = { userId: interaction.user.id, content: currentContent };

    const openBtn = new ButtonBuilder()
      .setCustomId('panel_welcome_open_modal')
      .setLabel('Open Editor')
      .setStyle(ButtonStyle.Primary);

    await interaction.editReply({
      content: helpText,
      components: [new ActionRowBuilder().addComponents(openBtn)],
    });
    return true;
  }

  async _handleWelcomeOpenModal(interaction) {
    if (!await this._requireAdmin(interaction, 'edit the welcome message')) return true;

    const pending = this._pendingWelcome;
    // Truncate to Discord's 4000-char modal value limit
    const currentValue = (pending?.content || '').slice(0, 4000);

    const modal = new ModalBuilder()
      .setCustomId('panel_welcome_modal')
      .setTitle('Welcome Message ( Live)');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('welcome_content')
          .setLabel('Message content (blank = auto-generated)')
          .setStyle(TextInputStyle.Paragraph)
          .setValue(currentValue)
          .setRequired(false)
          .setMaxLength(4000)
      ),
    );

    await interaction.showModal(modal);
    return true;
  }

  async _handleWelcomeModal(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    if (!this._isAdmin(interaction)) {
      await interaction.editReply('[ERR] Only administrators can edit the welcome message.');
      return true;
    }

    const newContent = interaction.fields.getTextInputValue('welcome_content');

    try {
      if (newContent.trim()) {
        // Write custom content directly via SFTP
        const sftp = new SftpClient();
        await sftp.connect({
          host: config.ftpHost,
          port: config.ftpPort,
          username: config.ftpUser,
          password: config.ftpPassword,
        });
        await sftp.put(Buffer.from(newContent, 'utf8'), config.ftpWelcomePath);
        await sftp.end().catch(() => {});

        // Also save as WELCOME_FILE_LINES in .env so it persists across restarts
        _writeEnvValues({ WELCOME_FILE_LINES: newContent.split('\n').join('|') });

        await interaction.editReply(
          `[OK] **Welcome message updated!** (${newContent.length} chars)\n` +
          `Written to server via SFTP and saved to .env.\n` +
          `Players will see this on their next join.`
        );
      } else {
        // Clear custom  revert to auto-generated
        _writeEnvValues({ WELCOME_FILE_LINES: '' });
        config.welcomeFileLines = [];

        // Regenerate and write default content
        const { buildWelcomeContent } = require('./auto-messages');
        const autoContent = await buildWelcomeContent();

        const sftp = new SftpClient();
        await sftp.connect({
          host: config.ftpHost,
          port: config.ftpPort,
          username: config.ftpUser,
          password: config.ftpPassword,
        });
        await sftp.put(Buffer.from(autoContent, 'utf8'), config.ftpWelcomePath);
        await sftp.end().catch(() => {});

        await interaction.editReply(
          '[OK] **Welcome message reset to auto-generated default!**\n' +
          'The welcome popup will now show leaderboards, server info, and stats.\n' +
          'Cleared WELCOME_FILE_LINES in .env.'
        );
      }
    } catch (err) {
      await interaction.editReply(`[ERR] Failed to save: ${err.message}`);
    }

    return true;
  }

  // 
  // Broadcast messages editor
  // 

  async _handleBroadcastsButton(interaction) {
    if (!await this._requireAdmin(interaction, 'edit broadcasts')) return true;

    const linkText = config.autoMsgLinkText || '';
    const promoText = config.autoMsgPromoText || '';

    const helpText = [
      '** Broadcast Message Editor**',
      '',
      'Edit the periodic RCON messages sent to in-game chat.',
      'Leave a field blank to use the built-in default message.',
      '',
      '**Current defaults:**',
      '- **Link:** `Join our Discord! <your link>`',
      '- **Promo:** `Have any issues...? Join our Discord: <your link>`',
      '',
      '**Placeholders** (auto-replaced):',
      '`{server_name}`  Server name',
      '`{day}`  In-game day    `{season}`  Season',
      '`{weather}`  Weather    `{pvp_schedule}`  PvP times',
      '`{discord_link}`  Your Discord invite link',
      '',
      '**Note:** These are plain-text RCON messages.',
      'Color tags (`<PN>`, `<PR>`, etc.) only work in WelcomeMessage.txt.',
      '',
      `Link: ${linkText ? `\`${linkText.slice(0, 80)}${linkText.length > 80 ? '...' : ''}\`` : '*(default)*'}`,
      `Promo: ${promoText ? `\`${promoText.slice(0, 80)}${promoText.length > 80 ? '...' : ''}\`` : '*(default)*'}`,
    ].join('\n');

    this._pendingBroadcasts = { userId: interaction.user.id, linkText, promoText };

    const openBtn = new ButtonBuilder()
      .setCustomId('panel_broadcasts_open_modal')
      .setLabel('Open Editor')
      .setStyle(ButtonStyle.Primary);

    await interaction.reply({
      content: helpText,
      components: [new ActionRowBuilder().addComponents(openBtn)],
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  async _handleBroadcastsOpenModal(interaction) {
    if (!await this._requireAdmin(interaction, 'edit broadcasts')) return true;

    const pending = this._pendingBroadcasts;
    const linkVal = (pending?.linkText || '').slice(0, 4000);
    const promoVal = (pending?.promoText || '').slice(0, 4000);

    const modal = new ModalBuilder()
      .setCustomId('panel_broadcasts_modal')
      .setTitle('Edit Broadcasts ( Bot Restart)');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('link_text')
          .setLabel('Discord Link Broadcast (blank = default)')
          .setStyle(TextInputStyle.Paragraph)
          .setValue(linkVal)
          .setRequired(false)
          .setMaxLength(4000)
          .setPlaceholder('Join our Discord! {discord_link}')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('promo_text')
          .setLabel('Promo Broadcast (blank = default)')
          .setStyle(TextInputStyle.Paragraph)
          .setValue(promoVal)
          .setRequired(false)
          .setMaxLength(4000)
          .setPlaceholder('Have any issues? Join our Discord: {discord_link}')
      ),
    );

    await interaction.showModal(modal);
    return true;
  }

  async _handleBroadcastsModal(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    if (!this._isAdmin(interaction)) {
      await interaction.editReply('[ERR] Only administrators can edit broadcasts.');
      return true;
    }

    const linkText = interaction.fields.getTextInputValue('link_text').trim();
    const promoText = interaction.fields.getTextInputValue('promo_text').trim();

    try {
      const updates = {};
      if (linkText !== (config.autoMsgLinkText || '')) {
        updates.AUTO_MSG_LINK_TEXT = linkText;
        config.autoMsgLinkText = linkText;
      }
      if (promoText !== (config.autoMsgPromoText || '')) {
        updates.AUTO_MSG_PROMO_TEXT = promoText;
        config.autoMsgPromoText = promoText;
      }

      if (Object.keys(updates).length > 0) {
        _writeEnvValues(updates);
        const parts = [];
        if ('AUTO_MSG_LINK_TEXT' in updates) parts.push(`Link: ${linkText || '*(default)*'}`);
        if ('AUTO_MSG_PROMO_TEXT' in updates) parts.push(`Promo: ${promoText || '*(default)*'}`);
        await interaction.editReply(
          `[OK] **Broadcast messages updated!**\n${parts.join('\n')}\n` +
          `Saved to .env. Restart bot to apply changes.`
        );
      } else {
        await interaction.editReply('[INFO] No changes detected.');
      }
    } catch (err) {
      await interaction.editReply(`[ERR] Failed to save: ${err.message}`);
    }

    return true;
  }

  // 
  // Update loop
  // 

  async _cleanOwnMessages() {
    const ids = this._loadMessageIds();
    const savedIds = [ids.panelBot, ids.panelServer].filter(Boolean);
    if (ids.servers) {
      for (const msgId of Object.values(ids.servers)) {
        if (msgId) savedIds.push(msgId);
      }
    }
    await cleanOwnMessages(this.channel, this.client, { savedIds, label: 'PANEL CH' });
  }

  _isPanelMessage(message) {
    if (!message) return false;
    const controlIds = new Set([...Object.values(BTN), ...Object.values(SELECT)]);
    const markers = [
      'control center',
      'bot controls',
      'primary server',
      'primary server panel',
      'managed server',
      'panel api',
    ];

    // Legacy embeds/content (non-components-v2) can still be old panel messages.
    const messageContent = String(message.content || '').toLowerCase();
    if (markers.some(m => messageContent.includes(m))) return true;
    if (Array.isArray(message.embeds) && message.embeds.length > 0) {
      for (const e of message.embeds) {
        const title = String(e?.title || '').toLowerCase();
        const desc = String(e?.description || '').toLowerCase();
        if (markers.some(m => title.includes(m) || desc.includes(m))) return true;
      }
    }

    if (!Array.isArray(message.components) || message.components.length === 0) return false;
    const stack = [...message.components];
    while (stack.length > 0) {
      const c = stack.pop();
      if (!c || typeof c !== 'object') continue;
      const customId = c.customId || c.custom_id;
      if (typeof customId === 'string' && (customId.startsWith('panel_') || controlIds.has(customId))) {
        return true;
      }
      const content = String(c.content || c.data?.content || '').toLowerCase();
      if (markers.some(m => content.includes(m))) {
        return true;
      }
      const children = c.components || c.data?.components;
      if (Array.isArray(children)) stack.push(...children);
      const accessory = c.accessory || c.data?.accessory;
      if (accessory && typeof accessory === 'object') stack.push(accessory);
    }
    return false;
  }

  async _cleanStalePanelMessages(keepId = null) {
    try {
      if (!this.channel || !this.client?.user) return;
      const messages = await this.channel.messages.fetch({ limit: 100 });
      const stale = messages.filter(m =>
        m.author?.id === this.client.user.id &&
        m.id !== keepId &&
        this._isPanelMessage(m)
      );
      for (const [, msg] of stale) {
        try { await msg.delete(); } catch {}
      }
      if (stale.size > 0) {
        console.log(`[PANEL CH] Removed ${stale.size} stale panel message(s)`);
      }
    } catch (err) {
      console.log('[PANEL CH] Stale cleanup skipped:', err.message);
    }
  }

  _loadMessageIds() {
    try {
      if (this._db) {
        return {
          panelBot: this._db.getState('msg_id_panel_bot') || null,
          panelServer: this._db.getState('msg_id_panel_server') || null,
          servers: this._db.getStateJSON('msg_id_panel_servers', {}),
        };
      }
    } catch {}
    return { panelBot: null, panelServer: null, servers: {} };
  }

  _saveMessageIds() {
    try {
      if (this._db && this.panelMessage) {
        this._db.setState('msg_id_panel_bot', this.panelMessage.id);
        // Unified panel mode: clear deprecated split-panel IDs.
        this._db.setState('msg_id_panel_server', '');
        this._db.setStateJSON('msg_id_panel_servers', {});
      }
    } catch {}
  }

  async _update(force = false) {
    try {
      if (!this.panelMessage) return;

      const { components } = await this._buildUnifiedPanel();
      const contentKey = _componentsKey(components);

      if (force || contentKey !== this._lastBotKey) {
        this._lastBotKey = contentKey;
        try {
          await this.panelMessage.edit({ components });
        } catch (editErr) {
          if (editErr.code === 10008 || editErr.message?.includes('Unknown Message')) {
            console.log('[PANEL CH] Panel message deleted, re-creating...');
            try {
              this.panelMessage = await this.channel.send({ flags: COMPONENTS_V2_FLAG, components });
            } catch (sendErr) {
              console.error('[PANEL CH] Re-create failed:', _errorSummary(sendErr));
              this.panelMessage = await this.channel.send({
                flags: COMPONENTS_V2_FLAG,
                components: [_container(['Panel update failed - layout rejected by Discord.'], [], 0xe74c3c)],
              });
            }
            this.botMessage = this.panelMessage;
            this._saveMessageIds();
            await this._cleanStalePanelMessages(this.panelMessage.id);
          } else throw editErr;
        }
      }
    } catch (err) {
      console.error('[PANEL CH] Update error:', _errorSummary(err));
    }
  }

  /**
   * Build the unified panel as Components v2 containers.
   * Returns { components: object[] }
   */
  async _buildUnifiedPanel() {
    const components = [];
    const view = this._activeView || 'bot';
    const managedServers = this.multiServerManager?.getAllServers() || [];

    // Build controls first and inject them directly into Bot Controls container.
    const controlRows = this._buildViewComponents(view, managedServers);

    //  Container 1: Bot overview (always) 
    components.push(this._buildBotContainer(controlRows, view));

    //  Container 2: Primary server 
    let resources = null, details = null, backups = null, schedules = null;
    if (panelApi.available) {
      try {
        [resources, details, backups, schedules] = await Promise.all([
          panelApi.getResources().catch(() => null),
          panelApi.getServerDetails().catch(() => ({})),
          panelApi.listBackups().catch(() => []),
          panelApi.listSchedules().catch(() => []),
        ]);
        const state = resources?.state || 'offline';
        this._lastState = state;
        this._backupLimit = details?.feature_limits?.backups ?? null;
        components.push(this._buildServerContainer(resources, details, backups, schedules));
      } catch {
        // Panel API failed  skip server container
      }
    }

    //  Containers 3+: Managed servers 
    let omittedManaged = 0;
    for (const serverDef of managedServers) {
      const instance = this.multiServerManager.getInstance(serverDef.id);
      const serverContainer = this._buildManagedServerContainer(serverDef, instance);
      const nextCount = _countComponents([...components, serverContainer]);
      if (nextCount > MAX_V2_COMPONENTS) {
        omittedManaged++;
        continue;
      }
      components.push(serverContainer);
    }

    if (omittedManaged > 0) {
      const omittedNotice = _container(
        [`Additional managed server containers omitted: **${omittedManaged}** (Discord limit: ${MAX_V2_COMPONENTS} components/message).`],
        [],
        0xe67e22
      );
      if (_countComponents([...components, omittedNotice]) <= MAX_V2_COMPONENTS) {
        components.push(omittedNotice);
      }
    }

    return { components };
  }

  /**
   * Build action rows for the currently selected view.
   * Row 1 is always the view selector. Rows 2-5 depend on the view.
   */
  _buildViewComponents(view, managedServers = []) {
    const rows = [];

    //  Row 1: View selector 
    const viewOptions = [
      { label: 'Bot Controls', value: 'bot', default: view === 'bot' },
    ];
    if (panelApi.available) {
      viewOptions.push({ label: 'Primary Server', value: 'server', default: view === 'server' });
    } else if (this._hasSftp) {
      viewOptions.push({ label: 'Server Tools', value: 'server', default: view === 'server' });
    }
    for (const s of managedServers) {
      viewOptions.push({
        label: s.name || s.id,
        value: `srv_${s.id}`,
        default: view === s.id,
      });
    }
    // Only show view selector if there's more than one option
    if (viewOptions.length > 1) {
      const viewSelect = new StringSelectMenuBuilder()
        .setCustomId(SELECT.VIEW)
        .setPlaceholder('Select panel view...')
        .addOptions(viewOptions);
      rows.push(new ActionRowBuilder().addComponents(viewSelect));
    }

    //  Rows 2-5: View-specific controls 
    const maxRemaining = 5 - rows.length;
    let viewRows = [];

    if (view === 'bot') {
      viewRows = this._buildBotComponents();
    } else if (view === 'server') {
      if (panelApi.available) {
        viewRows = this._buildServerComponents(this._lastState || 'offline');
      } else if (this._hasSftp) {
        viewRows = this._buildSftpOnlyServerComponents();
      }
    } else {
      // Managed server view
      const serverDef = managedServers.find(s => s.id === view);
      if (serverDef) {
        const instance = this.multiServerManager?.getInstance(serverDef.id);
        viewRows = this._buildManagedServerComponents(serverDef.id, instance?.running || false);
      }
    }

    // Trim to fit within Discord's 5 row limit
    for (let i = 0; i < Math.min(viewRows.length, maxRemaining); i++) {
      rows.push(viewRows[i]);
    }

    return rows;
  }

  /**
   * Build components for SFTP-only server view (no panel API).
   */
  _buildSftpOnlyServerComponents() {
    const rows = [];
    const actionOptions = [];
    if (config.enableWelcomeFile) {
      actionOptions.push({
        label: 'Welcome Message',
        description: 'Edit WelcomeMessage.txt',
        value: 'welcome',
      });
    }
    if (config.enableAutoMessages) {
      actionOptions.push({
        label: 'Broadcasts',
        description: 'Edit automatic broadcast messages',
        value: 'broadcasts',
      });
    }
    if (actionOptions.length > 0) {
      const actionSelect = new StringSelectMenuBuilder()
        .setCustomId(SELECT.ACTIONS_SERVER)
        .setPlaceholder('Server actions...')
        .addOptions(actionOptions);
      rows.push(new ActionRowBuilder().addComponents(actionSelect));
    }
    if (config.enableGameSettingsEditor) {
      const settingsSelect = new StringSelectMenuBuilder()
        .setCustomId(SELECT.SETTINGS)
        .setPlaceholder('Edit game server settings...')
        .addOptions(
          GAME_SETTINGS_CATEGORIES.map(c => ({
            label: c.label,
            value: c.id,
          }))
        );
      rows.push(new ActionRowBuilder().addComponents(settingsSelect));
    }
    return rows;
  }

  // 
  // Container builders
  // 

  /**
   * Build control container for the currently selected view.
   */
  _buildControlsContainer(view, rows = []) {
    const labels = {
      bot: 'Bot Controls',
      server: panelApi.available ? 'Primary Server' : 'Server Tools',
    };
    const viewLabel = labels[view] || `Managed Server: ${view}`;
    return _container(
      [
        '## Control Center',
        `Active view: **${viewLabel}**\nUse the menus below to manage the bot and servers.`,
      ],
      rows,
      0x5865f2
    );
  }

  /**
   * Build container for a managed (additional) server.
   * @param {object} serverDef - Server definition from servers.json
   * @param {object|undefined} instance - Running ServerInstance (or undefined)
   */
  _buildManagedServerContainer(serverDef, instance) {
    const running = instance?.running || false;
    const statusIcon = running ? '[RUN]' : '[OFF]';
    const statusText = running ? 'Running' : 'Stopped';

    const blocks = [
      `## Managed Server: ${serverDef.name || serverDef.id}`,
      [
        `${statusIcon} **${statusText}**`,
        `RCON: \`${serverDef.rcon?.host || '?'}:${serverDef.rcon?.port || 14541}\``,
        `Game Port: \`${serverDef.gamePort || 14242}\``,
        serverDef.sftp?.host
          ? `SFTP: \`${serverDef.sftp.host}:${serverDef.sftp.port || 22}\``
          : 'SFTP: Inherited from primary',
        `-# Server ID: ${serverDef.id}`,
      ].join('\n'),
    ];

    const ch = serverDef.channels || {};
    const channelLines = [];
    if (ch.serverStatus) channelLines.push(`Status: <#${ch.serverStatus}>`);
    if (ch.playerStats) channelLines.push(`Stats: <#${ch.playerStats}>`);
    if (ch.log) channelLines.push(`Log: <#${ch.log}>`);
    if (ch.chat) channelLines.push(`Chat: <#${ch.chat}>`);
    if (ch.admin) channelLines.push(`Admin: <#${ch.admin}>`);
    blocks.push(`### Channels\n${channelLines.length > 0 ? channelLines.join('\n') : 'None configured'}`);

    if (instance) {
      const status = instance.getStatus();
      const modLines = status.modules?.length > 0 ? status.modules.join('\n') : 'None';
      blocks.push(`### Modules\n${modLines}`);
    } else {
      blocks.push('### Modules\nNot running');
    }

    const am = serverDef.autoMessages || {};
    const cfg = instance?.config || {};
    const amLines = [];
    const welcomeMsg  = am.enableWelcomeMsg  ?? cfg.enableWelcomeMsg  ?? true;
    const welcomeFile = am.enableWelcomeFile ?? cfg.enableWelcomeFile ?? true;
    const linkBcast   = am.enableAutoMsgLink ?? cfg.enableAutoMsgLink ?? true;
    const promoBcast  = am.enableAutoMsgPromo ?? cfg.enableAutoMsgPromo ?? true;
    amLines.push(`RCON Welcome: ${welcomeMsg ? 'ON' : 'OFF'}`);
    amLines.push(`Welcome File: ${welcomeFile ? 'ON' : 'OFF'}`);
    amLines.push(`Link Broadcast: ${linkBcast ? 'ON' : 'OFF'}`);
    amLines.push(`Promo Broadcast: ${promoBcast ? 'ON' : 'OFF'}`);
    if (am.linkText) amLines.push(`Link: \`${am.linkText.slice(0, 40)}${am.linkText.length > 40 ? '...' : ''}\``);
    if (am.promoText) amLines.push(`Promo: \`${am.promoText.slice(0, 40)}${am.promoText.length > 40 ? '...' : ''}\``);
    if (am.discordLink) amLines.push(`Discord: \`${am.discordLink.slice(0, 40)}\``);
    blocks.push(`### Auto Messages\n${amLines.join('\n')}`);

    return _container(blocks, [], running ? 0x57f287 : 0xed4245);
  }

  /**
   * Build action-row controls for a managed server view.
   * @param {string} serverId
   * @param {boolean} running
   */
  _buildManagedServerComponents(serverId, running) {
    const actionOptions = [];
    if (running) {
      actionOptions.push(
        { label: 'Stop', description: 'Stop this managed server', value: `stop:${serverId}` },
        { label: 'Restart', description: 'Restart this managed server', value: `restart:${serverId}` },
      );
    } else {
      actionOptions.push({ label: 'Start', description: 'Start this managed server', value: `start:${serverId}` });
    }
    actionOptions.push(
      { label: 'Edit Connection', description: 'Edit RCON and game port settings', value: `edit:${serverId}` },
      { label: 'Edit Channels', description: 'Update Discord channel IDs', value: `channels:${serverId}` },
      { label: 'Edit SFTP', description: 'Update SFTP host and credentials', value: `sftp:${serverId}` },
      { label: 'Welcome Message', description: 'Edit this server welcome popup', value: `welcome:${serverId}` },
      { label: 'Auto Messages', description: 'Edit this server auto-messages', value: `automsg:${serverId}` },
      { label: 'Remove Server', description: 'Remove this managed server', value: `remove:${serverId}` },
    );

    const actionSelect = new StringSelectMenuBuilder()
      .setCustomId(SELECT.ACTIONS_MANAGED)
      .setPlaceholder('Managed server actions...')
      .addOptions(actionOptions);

    // Game settings dropdown (row 3)  uses server's SFTP
    const serverDef = this.multiServerManager?.getAllServers().find(s => s.id === serverId);
    const hasSftp = !!(serverDef?.sftp?.host || config.ftpHost);
    const rows = [new ActionRowBuilder().addComponents(actionSelect)];
    if (hasSftp) {
      const settingsSelect = new StringSelectMenuBuilder()
        .setCustomId(`panel_srv_settings:${serverId}`)
        .setPlaceholder('Edit game server settings...')
        .addOptions(
          GAME_SETTINGS_CATEGORIES.map(c => ({
            label: c.label,
            value: c.id,
          }))
        );
      rows.push(new ActionRowBuilder().addComponents(settingsSelect));
    }

    return rows;
  }

  _buildBotContainer(rows = [], view = 'bot') {
    const upMs = Date.now() - this.startedAt.getTime();
    const username = this.client.user?.tag || 'Bot';

    const infoLines = [
      '## Bot Controls',
      `**${username}**`,
      `Status: Online | Uptime: ${_formatBotUptime(upMs)}`,
      `Timezone: \`${config.botTimezone}\``,
    ];

    const caps = [];
    if (panelApi.available) caps.push('Panel API');
    if (this._hasSftp) caps.push('SFTP');
    if (caps.length > 0 && caps.length < 2) {
      infoLines.push(`Capabilities: ${caps.join(' | ')}`);
    }

    const statusLines = [];
    let skippedCount = 0;
    for (const [name, status] of Object.entries(this.moduleStatus)) {
      const raw = String(status || '').trim();
      const text = raw.toLowerCase();
      const ok = raw.startsWith('🟢') ||
        text.includes('ok') ||
        text.includes('active') ||
        text.includes('enabled') ||
        text.includes('running') ||
        text.includes('online');
      const off = raw.startsWith('⚫') ||
        raw.startsWith('🔴') ||
        text.includes('off') ||
        text.includes('disabled') ||
        text.includes('stopped') ||
        text.includes('offline');
      const icon = ok ? '🟢' : off ? '⚫' : '🟡';
      statusLines.push(`${icon} ${name}`);
      if (icon === '🟡') skippedCount++;
    }
    if (statusLines.length > 0) {
      let value = statusLines.join('\n');
      if (skippedCount > 0) {
        value += `\n-# ${skippedCount} module(s) need attention - tap **Diagnostics** in Control Center`;
      }
      infoLines.push(`### Modules\n${value}`);
    }

    infoLines.push([
      '### Quick Actions',
      '-# **Restart Bot** - Restart the bot process (brief downtime)',
      '-# **Factory Reset** - Wipe all data and re-build from scratch',
      '-# **Re-Import** - Re-download server files and rebuild stats',
      '-# **System Diagnostics** - Live connectivity probes, module health, suggestions',
    ].join('\n'));

    const viewLabels = {
      bot: 'Bot Controls',
      server: panelApi.available ? 'Primary Server' : 'Server Tools',
    };
    const viewLabel = viewLabels[view] || `Managed Server: ${view}`;
    infoLines.push(`### Control Center\nActive view: **${viewLabel}**`);

    return _container(infoLines, rows, 0x5865f2);
  }

  _buildBotComponents() {
    //  Select 1: Core & module settings 
    const coreCategories = ENV_CATEGORIES.filter(c => c.group === 1);
    const coreSelect = new StringSelectMenuBuilder()
      .setCustomId(SELECT.ENV)
      .setPlaceholder('Core & module settings...')
      .addOptions(
        coreCategories.map(c => ({
          label: c.label,
          description: c.description,
          value: c.id,
        }))
      );

    //  Select 2: Display & schedule settings 
    const displayCategories = ENV_CATEGORIES.filter(c => c.group === 2);
    const displaySelect = new StringSelectMenuBuilder()
      .setCustomId(SELECT.ENV2)
      .setPlaceholder('Display & schedule settings...')
      .addOptions(
        displayCategories.map(c => ({
          label: c.label,
          description: c.description,
          value: c.id,
        }))
      );

    const { needsSync } = require('../env-sync');
    const actionOptions = [
      { label: 'System Diagnostics', description: 'Run live health checks', value: 'diagnostics' },
      {
        label: needsSync() ? 'Sync .env' : 'Env Synced',
        description: needsSync() ? 'Apply pending env schema changes' : 'No pending env changes',
        value: 'env_sync',
      },
    ];
    if (this.multiServerManager) {
      actionOptions.push({
        label: 'Add Server',
        description: 'Add a new managed game server',
        value: 'add_server',
      });
    }
    actionOptions.push(
      { label: 'Restart Bot', description: 'Restart the bot process', value: 'restart_bot' },
      { label: 'Re-Import Data', description: 'Rebuild local data from server files', value: 'reimport' },
      { label: 'Factory Reset', description: 'Wipe local data and rebuild from scratch', value: 'factory_reset' },
    );

    const actionsSelect = new StringSelectMenuBuilder()
      .setCustomId(SELECT.ACTIONS_BOT)
      .setPlaceholder('Quick actions...')
      .addOptions(actionOptions);

    const rows = [
      new ActionRowBuilder().addComponents(coreSelect),
      new ActionRowBuilder().addComponents(displaySelect),
      new ActionRowBuilder().addComponents(actionsSelect),
    ];

    return rows;
  }

  _buildServerComponents(state) {
    const isRunning = state === 'running';
    const isOff = state === 'offline';
    const isTransitioning = state === 'starting' || state === 'stopping';

    const actionOptions = [];
    if (!isRunning && !isTransitioning) {
      actionOptions.push({ label: 'Start', description: 'Start the game server', value: 'start' });
    }
    if (!isOff && !isTransitioning) {
      actionOptions.push(
        { label: 'Stop', description: 'Stop the game server gracefully', value: 'stop' },
        { label: 'Restart', description: 'Restart the game server', value: 'restart' },
      );
    }
    if (this._backupLimit !== 0) {
      actionOptions.push({ label: 'Backup', description: 'Create a new backup', value: 'backup' });
    }
    if (!isOff) {
      actionOptions.push({ label: 'Kill', description: 'Force kill the server process', value: 'kill' });
    }
    if (this._hasSftp && config.enableWelcomeFile) {
      actionOptions.push({ label: 'Welcome Message', description: 'Edit WelcomeMessage.txt', value: 'welcome' });
    }
    if (config.enableAutoMessages) {
      actionOptions.push({ label: 'Broadcasts', description: 'Edit auto broadcast messages', value: 'broadcasts' });
    }

    const rows = [];
    if (actionOptions.length > 0) {
      const actionSelect = new StringSelectMenuBuilder()
        .setCustomId(SELECT.ACTIONS_SERVER)
        .setPlaceholder('Server actions...')
        .addOptions(actionOptions);
      rows.push(new ActionRowBuilder().addComponents(actionSelect));
    }

    // Game settings dropdown if SFTP is configured and editor is enabled
    if (this._hasSftp && config.enableGameSettingsEditor) {
      const settingsSelect = new StringSelectMenuBuilder()
        .setCustomId(SELECT.SETTINGS)
        .setPlaceholder('Edit game server settings...')
        .addOptions(
          GAME_SETTINGS_CATEGORIES.map(c => ({
            label: c.label,
            value: c.id,
          }))
        );
      rows.push(new ActionRowBuilder().addComponents(settingsSelect));
    }

    return rows;
  }

  _buildServerContainer(resources, details, backups, schedules) {
    const state = resources?.state || 'offline';
    const si = _stateInfo(state);

    const name = details?.name || 'Game Server';
    const desc = details?.description || '';
    let header = `## Primary Server Panel\n**${name}**\n${si.emoji} **${si.label}**`;
    if (desc) header += `\n*${desc}*`;

    const blocks = [header, '-# Panel API - Auto-updating - Controls require Administrator'];

    if (resources && state === 'running') {
      const lines = [];

      if (resources.cpu != null) {
        const cpuLimit = details?.limits?.cpu || 100;
        const cpuRatio = Math.min(resources.cpu / cpuLimit, 1);
        lines.push(`CPU: ${_progressBar(cpuRatio)} **${resources.cpu}%** / ${cpuLimit}%`);
      }

      if (resources.memUsed != null && resources.memTotal != null) {
        const memRatio = resources.memTotal > 0 ? resources.memUsed / resources.memTotal : 0;
        lines.push(`RAM: ${_progressBar(memRatio)} **${formatBytes(resources.memUsed)}** / ${formatBytes(resources.memTotal)}`);
      }

      if (resources.diskUsed != null && resources.diskTotal != null) {
        const diskRatio = resources.diskTotal > 0 ? resources.diskUsed / resources.diskTotal : 0;
        lines.push(`Disk: ${_progressBar(diskRatio)} **${formatBytes(resources.diskUsed)}** / ${formatBytes(resources.diskTotal)}`);
      }

      if (resources.uptime != null) {
        const up = formatUptime(resources.uptime);
        if (up) lines.push(`Uptime: ${up}`);
      }

      if (lines.length > 0) blocks.push(`### Live Resources\n${lines.join('\n')}`);
    } else if (state !== 'running') {
      blocks.push('### Resources\n*Server is not running*');
    }

    const allocs = details?.relationships?.allocations?.data || [];
    if (allocs.length > 0) {
      const allocLines = allocs.map(a => {
        const attr = a.attributes || a;
        const primary = attr.is_default ? ' (default)' : '';
        const alias = attr.alias ? ` (${attr.alias})` : '';
        const notes = attr.notes ? ` - ${attr.notes}` : '';
        return `\`${attr.ip}:${attr.port}\`${alias}${primary}${notes}`;
      });
      blocks.push(`### Allocations\n${allocLines.join('\n')}`);
    }

    if (details?.node) {
      blocks.push(`### Node\n${details.node}`);
    }

    const limits = details?.limits || {};
    const fl = details?.feature_limits || {};
    const planParts = [];
    if (limits.memory) planParts.push(`RAM: ${limits.memory} MB`);
    if (limits.disk != null) planParts.push(`Disk: ${limits.disk === 0 ? 'unlimited' : `${limits.disk} MB`}`);
    if (limits.cpu) planParts.push(`CPU: ${limits.cpu}%`);
    if (fl.backups != null) planParts.push(`Backups: ${fl.backups}`);
    if (fl.databases != null) planParts.push(`DBs: ${fl.databases}`);
    if (fl.allocations != null) planParts.push(`Ports: ${fl.allocations}`);
    if (planParts.length > 0) {
      blocks.push(`### Plan\n${planParts.join('    ')}`);
    }

    if (backups && backups.length > 0) {
      const sorted = [...backups]
        .filter(b => b.completed_at)
        .sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at));
      const successCount = backups.filter(b => b.is_successful).length;
      const totalSize = backups.reduce((sum, b) => sum + (b.bytes || 0), 0);
      const maxBackups = fl.backups || '?';

      const backupLines = sorted.slice(0, 5).map((b, i) => {
        const icon = b.is_successful ? '[OK]' : '[ERR]';
        const locked = b.is_locked ? ' [LOCKED]' : '';
        const date = new Date(b.completed_at).toLocaleDateString('en-GB', {
          day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
          timeZone: config.botTimezone,
        });
        return `${icon} **${b.name || `Backup ${i + 1}`}**${locked}\n ${formatBytes(b.bytes || 0)} - ${date}`;
      });

      const headerLine = `${successCount}/${maxBackups} slots - ${formatBytes(totalSize)} total`;
      blocks.push(`### Backups (${headerLine})\n${backupLines.join('\n') || 'None'}`);
    } else {
      blocks.push('### Backups\nNo backups yet. Use **Server Actions -> Backup** to create one.');
    }

    if (schedules && schedules.length > 0) {
      const activeCount = schedules.filter(s => s.is_active).length;
      const scheduleLines = schedules.slice(0, 8).map(s => {
        const active = s.is_active ? '[ACTIVE]' : '[OFF]';
        const onlyOnline = s.only_when_online ? ' [ONLINE ONLY]' : '';
        let next = '--';
        if (s.next_run_at) {
          const nextDate = new Date(s.next_run_at);
          const now = new Date();
          const diffMs = nextDate - now;
          if (diffMs > 0 && diffMs < 86400000) {
            const diffMins = Math.floor(diffMs / 60000);
            const diffHrs = Math.floor(diffMins / 60);
            const remMins = diffMins % 60;
            next = diffHrs > 0 ? `in ${diffHrs}h ${remMins}m` : `in ${diffMins}m`;
          } else {
            next = nextDate.toLocaleDateString('en-GB', {
              day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
              timeZone: config.botTimezone,
            });
          }
        }
        return `${active} **${s.name}**${onlyOnline} - ${next}`;
      });
      blocks.push(`### Schedules (${activeCount}/${schedules.length} active)\n${scheduleLines.join('\n')}`);
    }

    blocks.push([
      '### Commands',
      '`/qspanel console <cmd>` - Run a console command',
      '`/qspanel schedules` - View all schedules',
      '`/qspanel backup-delete` - Remove a backup',
    ].join('\n'));

    return _container(blocks, [], si.color);
  }
}

//  Setup wizard (extracted to panel-setup-wizard.js) 
Object.assign(PanelChannel.prototype, require('./panel-setup-wizard'));

//  Multi-server handlers (extracted to panel-multi-server.js) 
Object.assign(PanelChannel.prototype, require('./panel-multi-server'));

// Export custom IDs for the interaction handler
PanelChannel.BTN = BTN;
PanelChannel.SELECT = SELECT;
PanelChannel.ENV_CATEGORIES = ENV_CATEGORIES;
PanelChannel.GAME_SETTINGS_CATEGORIES = GAME_SETTINGS_CATEGORIES;

module.exports = PanelChannel;


