/**
 * NUKE_BOT factory-reset helper: delete all bot-authored threads and messages
 * from a channel before modules start. Pure — takes the client, channel id and
 * bot id as arguments and touches no module state, so it needs no AppContext.
 * Extracted verbatim from src/index.ts (P1-1b god-file split).
 */
import type { Client, ThreadChannel } from 'discord.js';
import { errMsg } from '../utils/error.js';

export async function _nukeChannel(discordClient: Client, channelId: string, botId: string): Promise<void> {
  try {
    const ch = await discordClient.channels.fetch(channelId).catch(() => null);
    if (!ch) return;

    // Handle bot-authored threads (active + archived)
    // Delete ALL bot threads for a clean slate during nuke.
    if ('threads' in ch) {
      const textCh = ch as import('discord.js').TextChannel;
      const active = await textCh.threads.fetchActive().catch(() => ({ threads: new Map<string, ThreadChannel>() }));
      const archived = await textCh.threads
        .fetchArchived({ limit: 100 })
        .catch(() => ({ threads: new Map<string, ThreadChannel>() }));
      const allThreads: ThreadChannel[] = [...active.threads.values(), ...archived.threads.values()];
      for (const thread of allThreads) {
        if (thread.ownerId !== botId) continue;
        await thread.delete('NUKE_BOT factory reset').catch(() => {});
        const chName = 'name' in ch ? String((ch as { name: unknown }).name) : channelId;
        console.log(`[NUKE] Deleted thread "${thread.name}" from #${chName}`);
      }
    }

    // Delete bot-authored messages (scan up to 1000)
    if (!('messages' in ch)) return;
    const textCh = ch;
    let lastId: string | undefined;
    let deleted = 0;
    for (let page = 0; page < 10; page++) {
      const opts: { limit: number; before?: string } = { limit: 100 };
      if (lastId) opts.before = lastId;
      const batch = await textCh.messages.fetch(opts).catch(() => null);
      if (!batch || batch.size === 0) break;
      const lastMsg = batch.last();
      if (lastMsg) lastId = lastMsg.id;
      for (const [, msg] of batch) {
        if (msg.author.id !== botId) continue;
        await msg.delete().catch(() => {});
        deleted++;
      }
      if (batch.size < 100) break;
    }
    const chName = 'name' in ch ? String((ch as { name: unknown }).name) : channelId;
    if (deleted > 0) console.log(`[NUKE] Deleted ${deleted} message(s) from #${chName}`);
  } catch (err: unknown) {
    console.warn(`[NUKE] Could not clean channel ${channelId}:`, errMsg(err));
  }
}
