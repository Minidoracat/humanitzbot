/**
 * Pure, stateless helpers shared across the bot entry-point modules. No
 * AppContext / mutable module state — every function here reads only its
 * arguments or the config singleton.
 *
 * Extracted verbatim from src/index.ts (P1-1b god-file split).
 */
import type { GuildMember } from 'discord.js';
import config, { isAdminView as _isAdminViewRaw } from '../config/index.js';

// Convenience wrapper: isAdminView has 2-arg signature (permissions[], member).
export function isAdminView(member: GuildMember | null): boolean {
  return _isAdminViewRaw(config.adminViewPermissions, member);
}

export function hasSftp(): boolean {
  const host = config.sftpHost || '';
  // Reject the documented setup placeholders (.env.example `your.game.server.ip`
  // / `PASTE_…`) so a setup-mode bot doesn't treat them as configured and start
  // a headless LogWatcher that polls a sample host every interval.
  if (!host || host.startsWith('PASTE_') || /^your[._]/i.test(host)) return false;
  return !!(config.sftpUser && (config.sftpPassword || config.sftpPrivateKeyPath));
}

export function coerceRuntimeBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  return String(value).trim().toLowerCase() === 'true';
}

export function _formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${mins}m`);
  return parts.join(' ');
}
