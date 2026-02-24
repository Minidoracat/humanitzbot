const { Events, EmbedBuilder } = require('discord.js');
const _defaultConfig = require('./config');
const { addAdminMembers } = require('./config');
const _defaultRcon = require('./rcon');

// ── Chat line parsers ────────────────────────────────────────
// Player chat:   <PN>PlayerName:</>Message text
// Admin chat:    [Admin]<PN>PlayerName:</>Message text (admin players get this prefix)
const CHAT_RE = /^<PN>(.+?):<\/>(.+)$/;
// Player joined: Player Joined (<PN>PlayerName</>)
const JOIN_RE = /^Player Joined \(<PN>(.+?)<\/>\)$/;
// Player left:   Player Left (<PN>PlayerName</>)
const LEFT_RE = /^Player Left \(<PN>(.+?)<\/>\)$/;
// Player died:   Player Died (<PN>PlayerName</>)
const DIED_RE = /^Player Died \(<PN>(.+?)<\/>\)$/;
// Bot-generated admin broadcasts are prefixed with [Bot].
// Admin *player* messages have no [Bot] prefix (just "[Admin] Name: text" or "[Admin]<PN>Name:</>text").
const BOT_ADMIN_RE = /^\[Admin\]\s*\[Bot\]/;
// Plain chat fallback — admin player lines may lack <PN> tags
const PLAIN_CHAT_RE = /^([^:<>\n]{1,32}):\s*(.+)$/;
// Strip [Admin] prefix from admin player lines so the other regexes can match
function stripAdminPrefix(line) {
  return line.startsWith('[Admin]') ? line.replace(/^\[Admin\]\s*/, '') : line;
}

class ChatRelay {
  constructor(client, deps = {}) {
    this.client = client;
    this._config = deps.config || _defaultConfig;
    this._rcon = deps.rcon || _defaultRcon;
    this._label = deps.label || 'CHAT RELAY';
    this.adminChannel = null;
    this._lastLines = [];      // snapshot for diff
    this._pollTimer = null;
    this._chatThread = null;   // daily chat thread
    this._chatThreadDate = null;
    this._boundOnMessage = null; // stored listener ref for cleanup
    this._rolloverPending = false; // true = waiting for activity thread before creating chat thread
    this._rolloverFallback = null; // safety timer if LogWatcher callback never fires
    this._nukeActive = false;      // true during NUKE_BOT — suppresses thread creation
  }

  async start() {
    try {
      // ── Admin channel (home for threads + outbound bridge) ──
      const chatId = this._config.chatChannelId || this._config.adminChannelId;
      if (!chatId) {
        console.log(`[${this._label}] No ADMIN_CHANNEL_ID or CHAT_CHANNEL_ID configured, skipping chat relay.`);
        return;
      }
      this.adminChannel = await this.client.channels.fetch(chatId);
      if (!this.adminChannel) {
        console.error(`[${this._label}] Chat channel not found! Check ADMIN_CHANNEL_ID / CHAT_CHANNEL_ID.`);
        return;
      }

      console.log(`[${this._label}] Admin bridge: #${this.adminChannel.name} → server`);
      console.log(`[${this._label}] Chat relay:   server → ${this._config.useChatThreads ? 'daily thread in' : ''} #${this.adminChannel.name}`);

      // Clean old bot starter messages (keep the channel tidy across restarts)
      await this._cleanOldMessages();

      // Create / find today's chat thread (or use channel directly)
      // During NUKE_BOT, defer thread creation — nuke phase 2 will recreate it
      // after activity threads and Bot Online embed so it appears in the right order.
      if (!this._config.nukeBot) {
        await this._getOrCreateChatThread();
      }

      // Listen for outbound admin messages
      this._boundOnMessage = async (message) => {
        await this._onMessage(message);
      };
      this.client.on(Events.MessageCreate, this._boundOnMessage);

      // Start polling fetchchat
      const pollMs = this._config.chatPollInterval || 10000;
      this._pollTimer = setInterval(() => this._pollChat(), pollMs);
      console.log(`[${this._label}] Polling fetchchat every ${pollMs / 1000}s`);
    } catch (err) {
      console.error(`[${this._label}] Failed to start:`, err.message);
    }
  }

  stop() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    if (this._boundOnMessage) {
      this.client.removeListener(Events.MessageCreate, this._boundOnMessage);
      this._boundOnMessage = null;
    }
    console.log(`[${this._label}] Stopped.`);
  }

  /**
   * Delete old bot-posted starter messages (embeds without a thread) so the
   * channel stays clean across restarts. Keeps messages that have threads
   * attached (today's or historical).
   */
  async _cleanOldMessages() {
    // Only delete messages older than this process start to avoid wiping
    // sibling multi-server messages posted earlier in this same startup.
    const bootTime = Date.now() - process.uptime() * 1000;
    try {
      const messages = await this.adminChannel.messages.fetch({ limit: 20 });
      const botId = this.client.user.id;
      const botMessages = messages.filter(m =>
        m.author.id === botId && !m.hasThread && m.createdTimestamp < bootTime
      );
      if (botMessages.size > 0) {
        console.log(`[${this._label}] Cleaning ${botMessages.size} orphaned bot message(s)`);
        for (const [, msg] of botMessages) {
          try { await msg.delete(); } catch (_) {}
        }
      }
    } catch (err) {
      console.log(`[${this._label}] Could not clean old messages:`, err.message);
    }
  }

  /** Clear cached thread reference so it will be re-fetched on next send. */
  resetThreadCache() {
    this._chatThread = null;
    this._chatThreadDate = null;
    if (this._rolloverFallback) {
      clearTimeout(this._rolloverFallback);
      this._rolloverFallback = null;
    }
    this._rolloverPending = false;
  }

  /**
   * Called by LogWatcher's day-rollover callback to signal that the
   * activity thread has been created and it's safe to create the chat thread.
   */
  async createDailyThread() {
    this.resetThreadCache();
    return this._getOrCreateChatThread();
  }

  // ── Daily chat thread management ───────────────────────────

  async _getOrCreateChatThread() {
    // During nuke phase 1→2, suppress thread creation so rebuild controls ordering
    if (this._nukeActive) {
      return this.adminChannel;
    }

    // No-thread mode — post straight to the channel
    if (!this._config.useChatThreads) {
      this._chatThread = this.adminChannel;
      return this._chatThread;
    }

    const today = this._config.getToday(); // timezone-aware 'YYYY-MM-DD'

    // If waiting for LogWatcher to create activity thread first, use main channel
    if (this._rolloverPending) {
      return this.adminChannel;
    }

    // Already have today's thread
    if (this._chatThread && this._chatThreadDate === today) {
      return this._chatThread;
    }

    // Archive yesterday's thread if it's still open
    if (this._chatThread && this._chatThreadDate && this._chatThreadDate !== today) {
      try {
        if (!this._chatThread.archived && typeof this._chatThread.setArchived === 'function') {
          await this._chatThread.setArchived(true);
          console.log(`[${this._label}] Archived previous thread: ${this._chatThread.name}`);
        }
      } catch (e) {
        console.warn(`[${this._label}] Could not archive old thread:`, e.message);
      }
      this._chatThread = null;
      this._chatThreadDate = null;

      // If LogWatcher is managing thread ordering, defer creation
      // until the activity thread has been created first
      if (this._awaitActivityThread) {
        this._rolloverPending = true;
        // Safety fallback: create thread after 2 min if callback never fires
        this._rolloverFallback = setTimeout(() => {
          this._rolloverPending = false;
          this._rolloverFallback = null;
          console.log(`[${this._label}] Rollover fallback — creating chat thread now`);
        }, 120_000);
        return this.adminChannel;
      }
    }

    const dateLabel = this._config.getDateLabel();
    const serverSuffix = this._config.serverName ? ` [${this._config.serverName}]` : '';
    const threadName = `💬 Chat Log — ${dateLabel}${serverSuffix}`;

    try {
      // Check active threads
      const active = await this.adminChannel.threads.fetchActive();
      const existing = active.threads.find(t => t.name === threadName);
      if (existing) {
        this._chatThread = existing;
        this._chatThreadDate = today;
        console.log(`[${this._label}] Using existing thread: ${threadName}`);
        // Re-add admin members (they may have been removed if bot restarted)
        this._config.addAdminMembers(this._chatThread, this.adminChannel.guild).catch(() => {});
        return this._chatThread;
      }

      // Check archived threads (in case bot restarted mid-day)
      const archived = await this.adminChannel.threads.fetchArchived({ limit: 5 });
      const archivedMatch = archived.threads.find(t => t.name === threadName);
      if (archivedMatch) {
        await archivedMatch.setArchived(false);
        this._chatThread = archivedMatch;
        this._chatThreadDate = today;
        console.log(`[${this._label}] Unarchived existing thread: ${threadName}`);
        this._config.addAdminMembers(this._chatThread, this.adminChannel.guild).catch(() => {});
        return this._chatThread;
      }
    } catch (err) {
      console.warn(`[${this._label}] Could not search for threads:`, err.message);
    }

    // Create a new thread (from a starter message so it appears inline in the channel)
    try {
      const starterMsg = await this.adminChannel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle(`💬 Chat Log — ${dateLabel}${serverSuffix}`)
            .setDescription('All in-game chat messages for today are logged in this thread.')
            .setColor(0x3498db)
            .setTimestamp(),
        ],
      });
      this._chatThread = await starterMsg.startThread({
        name: threadName,
        autoArchiveDuration: 1440,
        reason: 'Daily chat log thread',
      });
      this._chatThreadDate = today;
      console.log(`[${this._label}] Created daily thread: ${threadName}`);

      // Auto-join admin users/roles so the thread stays visible for them
      this._config.addAdminMembers(this._chatThread, this.adminChannel.guild).catch(() => {});
    } catch (err) {
      console.error(`[${this._label}] Failed to create chat thread:`, err.message);
      // Fallback — use the main channel directly so messages aren't dropped
      this._chatThread = this.adminChannel;
      this._chatThreadDate = today;
    }

    return this._chatThread;
  }

  // ── Inbound: fetchchat → Discord thread ────────────────────

  async _pollChat() {
    try {
      const raw = await this._rcon.send('fetchchat');
      if (!raw || !raw.trim()) return;

      const currentLines = raw.split('\n').map(l => l.trim()).filter(Boolean);
      const newLines = this._diff(currentLines);
      this._lastLines = currentLines;

      if (newLines.length === 0) return;

      // Ensure we have today's thread
      const thread = await this._getOrCreateChatThread();

      for (const line of newLines) {
        const msg = this._formatLine(line);
        if (msg && thread) {
          await thread.send(msg);
        }

        // Check for !admin command (posts to main channel, not thread)
        await this._checkAdminCall(line);
      }
    } catch (err) {
      // Don't spam on RCON issues — the RCON module already logs
      if (!err.message.includes('not connected') && !err.message.includes('No response')) {
        console.error(`[${this._label}] Poll error:`, err.message);
      }
    }
  }

  _diff(currentLines) {
    if (this._lastLines.length === 0) {
      // First poll — don't replay the whole buffer
      return [];
    }

    // Find where the old snapshot ends in the new one
    // Walk backward through old lines to find the last matching line
    const lastOld = this._lastLines[this._lastLines.length - 1];
    let splitIdx = -1;

    // Search from end of current lines backwards for the last old line
    for (let i = currentLines.length - 1; i >= 0; i--) {
      if (currentLines[i] === lastOld) {
        // Verify the preceding lines match too (avoid false positives)
        let match = true;
        for (let j = 1; j <= Math.min(2, this._lastLines.length - 1); j++) {
          if (i - j < 0 || currentLines[i - j] !== this._lastLines[this._lastLines.length - 1 - j]) {
            match = false;
            break;
          }
        }
        if (match) {
          splitIdx = i;
          break;
        }
      }
    }

    if (splitIdx === -1) {
      // No overlap found — entire response is new (or buffer rotated)
      return currentLines;
    }

    return currentLines.slice(splitIdx + 1);
  }

  // ── !admin command detection ────────────────────────────────

  async _checkAdminCall(line) {
    // Strip [Admin] prefix so admin players' !admin commands are detected
    const cleaned = stripAdminPrefix(line);
    let m = CHAT_RE.exec(cleaned);
    if (!m) m = PLAIN_CHAT_RE.exec(cleaned);
    if (!m) return;

    const name = m[1].trim();
    const text = m[2].trim();

    // Match !admin with optional message
    const adminMatch = text.match(/^!admin\s*(.*)/i);
    if (!adminMatch) return;

    const reason = adminMatch[1] || 'No reason given';
    console.log(`[${this._label}] !admin call from ${name}: ${reason}`);

    // Alert in the daily chat thread (with @here so admins are notified)
    const embed = new EmbedBuilder()
      .setTitle('🚨 Admin Assistance Requested')
      .setColor(0xe74c3c)
      .addFields(
        { name: 'Player', value: name, inline: true },
        { name: 'Reason', value: reason, inline: true },
      )
      .setTimestamp();

    const payload = { content: '@here', embeds: [embed] };

    // Send to configured alert channels if set, otherwise default to chat thread/admin channel
    const hasExtraChannels = this._config.adminAlertChannelIds.length > 0;

    if (hasExtraChannels) {
      // Send only to the designated alert channels (one @here, not duplicated)
      for (const channelId of this._config.adminAlertChannelIds) {
        try {
          const ch = await this.client.channels.fetch(channelId);
          if (ch) await ch.send(payload);
        } catch (err) {
          console.error(`[${this._label}] Failed to send admin alert to ${channelId}:`, err.message);
        }
      }
    } else {
      // Default: send to chat thread or admin channel
      try {
        const thread = await this._getOrCreateChatThread();
        if (thread) {
          await thread.send(payload);
        } else {
          await this.adminChannel.send(payload);
        }
      } catch (err) {
        console.error(`[${this._label}] Failed to send admin alert:`, err.message);
      }
    }

    // Acknowledge in-game (plain text — no color needed for acknowledgements)
    try {
      await this._rcon.send(`admin [Bot] ${name}, your request has been sent to the admins. Join our Discord for faster help: ${this._config.discordInviteLink}`);
    } catch (_) {}
  }

  _formatLine(line) {
    // Skip bot-generated admin broadcasts (no <PN> tag = sent by us, not a player)
    if (BOT_ADMIN_RE.test(line)) return null;

    // Strip [Admin] prefix so admin players' messages match the regular regexes
    const cleaned = stripAdminPrefix(line);
    const isAdmin = cleaned !== line;

    // Player chat (game uses <PN> tags in fetchChat output)
    let m = CHAT_RE.exec(cleaned);
    if (!m) m = PLAIN_CHAT_RE.exec(cleaned); // admin players may lack <PN> tags
    if (m) {
      const name = m[1].trim();
      const text = this._sanitize(m[2].trim());
      const badge = isAdmin ? ' 🛡️' : '';
      return `💬 **${name}${badge}:** ${text}`;
    }

    // Player joined
    m = JOIN_RE.exec(cleaned);
    if (m) return `📥 **${m[1]}** joined the server`;

    // Player left
    m = LEFT_RE.exec(cleaned);
    if (m) return `📤 **${m[1]}** left the server`;

    // Player died
    m = DIED_RE.exec(cleaned);
    if (m) return `💀 **${m[1]}** died`;

    // Unknown format — skip silently
    return null;
  }

  _sanitize(text) {
    return text
      .replace(/@everyone/g, '@\u200beveryone')
      .replace(/@here/g, '@\u200bhere')
      .replace(/<@!?(\d+)>/g, '@user')
      .replace(/<@&(\d+)>/g, '@role')
      // Escape Discord markdown characters to prevent formatting injection
      .replace(/```/g, '\u200b`\u200b`\u200b`')
      .replace(/([*_~`|\\])/g, '\\$1');
  }

  /** Sanitize text for use in RCON commands — strip control characters and null bytes. */
  _sanitizeRcon(text) {
    return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/[\r\n]+/g, ' ');
  }

  // ── Outbound: Discord → [Admin] in-game ────────────────────

  async _onMessage(message) {
    if (message.author.bot) return;
    // Accept messages in the admin channel OR any of its threads (e.g. the chat thread)
    const isInChannel = message.channelId === this.adminChannel.id;
    const isInThread = message.channel.isThread?.() && message.channel.parentId === this.adminChannel.id;
    if (!isInChannel && !isInThread) return;
    if (!message.content || message.content.trim() === '') return;

    try {
      let text = message.content.trim();
      // Limit message length to prevent oversized RCON commands
      if (text.length > 500) {
        text = text.substring(0, 500);
      }
      let displayName = message.member?.displayName || message.author.displayName || message.author.username;
      displayName = this._sanitizeRcon(displayName).replace(/[^a-zA-Z0-9 _\-.']/g, '').slice(0, 32) || 'User';
      text = this._sanitizeRcon(text);
      await this._rcon.send(`admin [Bot] [Discord] ${displayName}: ${text}`);
      await message.react('✅');
    } catch (err) {
      console.error(`[${this._label}] Failed to relay admin message:`, err.message);
      await message.react('❌');
    }
  }
}

module.exports = ChatRelay;
