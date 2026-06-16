/**
 * Per-server definition repository: the .env-key → servers.json path mapping,
 * nested get/set/delete helpers, section builder, DB-first read/write of a
 * server definition, and credential masking.
 *
 * Extracted from web-map/server.ts (P1-1 god-file split). `_getServerDef` /
 * `_saveServerDef` previously closed over the `configRepo` local in
 * `_setupRoutes`; they now take it as an explicit first parameter. Everything
 * else is verbatim (de-indentation + `export` only).
 */

import fs from 'fs';
import { errMsg } from '../utils/error.js';
import { SERVERS_FILE } from './paths.js';
import type { ConfigRepo } from './types/config-repo.js';
import {
  ENV_SENSITIVE_KEYS,
  ENV_READONLY_KEYS,
  ENV_FIELD_BY_KEY,
  _botConfigDisplayValue,
  _botConfigItemMetadata,
} from './bot-config-meta.js';

/**
 * Mapping from .env keys to servers.json nested paths.
 * Each entry: { jsonPath, sensitive?, readOnly?, label? }
 * jsonPath uses dot notation: 'rcon.host', 'channels.serverStatus', etc.
 */
export const ENV_TO_SERVERDEF: Record<
  string,
  { jsonPath: string; legacyJsonPath?: string; sensitive?: boolean; readOnly?: boolean; label?: string }
> = {
  // Identity
  SERVER_NAME: { jsonPath: 'name' },
  PUBLIC_HOST: { jsonPath: 'publicHost' },
  GAME_PORT: { jsonPath: 'gamePort' },
  // RCON
  RCON_HOST: { jsonPath: 'rcon.host' },
  RCON_PORT: { jsonPath: 'rcon.port' },
  RCON_PASSWORD: { jsonPath: 'rcon.password', sensitive: true },
  // SFTP
  SFTP_HOST: { jsonPath: 'sftp.host' },
  SFTP_PORT: { jsonPath: 'sftp.port' },
  SFTP_USER: { jsonPath: 'sftp.user' },
  SFTP_PASSWORD: { jsonPath: 'sftp.password', sensitive: true },
  SFTP_PRIVATE_KEY_PATH: { jsonPath: 'sftp.privateKeyPath', sensitive: true },
  // Channels
  SERVER_STATUS_CHANNEL_ID: { jsonPath: 'channels.serverStatus' },
  PLAYER_STATS_CHANNEL_ID: { jsonPath: 'channels.playerStats' },
  CHAT_CHANNEL_ID: { jsonPath: 'channels.chat' },
  LOG_CHANNEL_ID: { jsonPath: 'channels.log' },
  ADMIN_CHANNEL_ID: { jsonPath: 'channels.admin' },
  ACTIVITY_LOG_CHANNEL_ID: { jsonPath: 'channels.activityLog' },
  // SFTP paths
  SFTP_LOG_PATH: { jsonPath: 'paths.logPath' },
  SFTP_CONNECT_LOG_PATH: { jsonPath: 'paths.connectLogPath' },
  SFTP_ID_MAP_PATH: { jsonPath: 'paths.idMapPath' },
  SFTP_SAVE_PATH: { jsonPath: 'paths.savePath' },
  SFTP_SETTINGS_PATH: { jsonPath: 'paths.settingsPath' },
  SFTP_WELCOME_PATH: { jsonPath: 'paths.welcomePath' },
  // Timezones
  BOT_TIMEZONE: { jsonPath: 'botTimezone' },
  LOG_TIMEZONE: { jsonPath: 'logTimezone' },
  // Docker / restart
  DOCKER_CONTAINER: { jsonPath: 'dockerContainer' },
  ENABLE_SERVER_SCHEDULER: { jsonPath: 'enableServerScheduler' },
  RESTART_TIMES: { jsonPath: 'restartTimes' },
  RESTART_PROFILES: { jsonPath: 'restartProfiles' },
  // PvP
  PVP_START_TIME: { jsonPath: 'pvpStartMinutes', legacyJsonPath: 'pvpStartTime' },
  PVP_END_TIME: { jsonPath: 'pvpEndMinutes', legacyJsonPath: 'pvpEndTime' },
  PVP_SETTINGS_OVERRIDES: { jsonPath: 'pvpSettingsOverrides' },
  ENABLE_PVP_SCHEDULER: { jsonPath: 'enablePvpScheduler' },
  PVP_DAYS: { jsonPath: 'pvpDays' },
  // Activity log filters (per-server overrides; inherit primary when unset)
  ENABLE_ACTIVITY_LOG: { jsonPath: 'enableActivityLog' },
  ENABLE_CONTAINER_LOG: { jsonPath: 'enableContainerLog' },
  ENABLE_HORSE_LOG: { jsonPath: 'enableHorseLog' },
  ENABLE_VEHICLE_LOG: { jsonPath: 'enableVehicleLog' },
  ENABLE_STRUCTURE_LOG: { jsonPath: 'enableStructureLog' },
  ENABLE_WORLD_EVENT_FEED: { jsonPath: 'enableWorldEventFeed' },
  SHOW_INVENTORY_LOG: { jsonPath: 'showInventoryLog' },
  // Auto messages
  ENABLE_WELCOME_MSG: { jsonPath: 'autoMessages.enableWelcomeMsg' },
  ENABLE_WELCOME_FILE: { jsonPath: 'autoMessages.enableWelcomeFile' },
  ENABLE_AUTO_MSG_LINK: { jsonPath: 'autoMessages.enableAutoMsgLink' },
  ENABLE_AUTO_MSG_PROMO: { jsonPath: 'autoMessages.enableAutoMsgPromo' },
  AUTO_MSG_LINK_TEXT: { jsonPath: 'autoMessages.linkText' },
  AUTO_MSG_PROMO_TEXT: { jsonPath: 'autoMessages.promoText' },
  DISCORD_INVITE_LINK: { jsonPath: 'autoMessages.discordLink' },
  // Panel API
  PANEL_SERVER_URL: { jsonPath: 'panel.serverUrl' },
  PANEL_API_KEY: { jsonPath: 'panel.apiKey', sensitive: true },
  // Module toggles (stored in modules.* in servers.json)
  ENABLE_SERVER_STATUS: { jsonPath: 'modules.serverStatus' },
  ENABLE_CHAT_RELAY: { jsonPath: 'modules.chatRelay' },
  ENABLE_LOG_WATCHER: { jsonPath: 'modules.logWatcher' },
  ENABLE_PLAYER_STATS: { jsonPath: 'modules.playerStats' },
  // Server enabled
  ENABLED: { jsonPath: 'enabled' },
};

/** Read a nested value from an object using dot-path: 'rcon.host' → obj.rcon.host */
export function _getNestedValue(obj: Record<string, unknown>, dotPath: string): unknown {
  const parts = dotPath.split('.');
  let cur: unknown = obj;
  for (const pk of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[pk];
  }
  return cur;
}

/** Set a nested value on an object using dot-path, creating intermediary objects. */
export function _setNestedValue(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
  const parts = dotPath.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i] as string;
    if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  const lastKey = parts[parts.length - 1];
  if (lastKey !== undefined) cur[lastKey] = value;
}

/** Delete a nested value on an object using dot-path. */
export function _deleteNestedValue(obj: Record<string, unknown>, dotPath: string): void {
  const parts = dotPath.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i] as string;
    const next = cur[p];
    if (!next || typeof next !== 'object') return;
    cur = next as Record<string, unknown>;
  }
  const lastKey = parts[parts.length - 1];
  if (lastKey !== undefined) Reflect.deleteProperty(cur, lastKey);
}

/** Build categorized bot-config sections from a servers.json serverDef entry. */
export function _buildServerDefSections(serverDef: Record<string, unknown>): Record<string, unknown>[] {
  const categories = [
    { label: 'Server Identity', keys: ['SERVER_NAME', 'PUBLIC_HOST', 'GAME_PORT', 'ENABLED'] },
    { label: 'RCON', keys: ['RCON_HOST', 'RCON_PORT', 'RCON_PASSWORD'] },
    { label: 'SFTP', keys: ['SFTP_HOST', 'SFTP_PORT', 'SFTP_USER', 'SFTP_PASSWORD', 'SFTP_PRIVATE_KEY_PATH'] },
    {
      label: 'Channel IDs',
      keys: [
        'SERVER_STATUS_CHANNEL_ID',
        'PLAYER_STATS_CHANNEL_ID',
        'CHAT_CHANNEL_ID',
        'LOG_CHANNEL_ID',
        'ADMIN_CHANNEL_ID',
        'ACTIVITY_LOG_CHANNEL_ID',
      ],
    },
    {
      label: 'SFTP File Paths',
      keys: [
        'SFTP_LOG_PATH',
        'SFTP_CONNECT_LOG_PATH',
        'SFTP_ID_MAP_PATH',
        'SFTP_SAVE_PATH',
        'SFTP_SETTINGS_PATH',
        'SFTP_WELCOME_PATH',
      ],
    },
    { label: 'Timezones', keys: ['BOT_TIMEZONE', 'LOG_TIMEZONE'] },
    {
      label: 'Server Scheduler',
      keys: ['ENABLE_SERVER_SCHEDULER', 'RESTART_TIMES', 'RESTART_PROFILES', 'DOCKER_CONTAINER'],
    },
    {
      label: 'PvP Scheduler',
      keys: ['ENABLE_PVP_SCHEDULER', 'PVP_START_TIME', 'PVP_END_TIME', 'PVP_DAYS', 'PVP_SETTINGS_OVERRIDES'],
    },
    {
      label: 'Activity Log Filters',
      keys: [
        'ENABLE_ACTIVITY_LOG',
        'ENABLE_CONTAINER_LOG',
        'ENABLE_HORSE_LOG',
        'ENABLE_VEHICLE_LOG',
        'ENABLE_STRUCTURE_LOG',
        'ENABLE_WORLD_EVENT_FEED',
        'SHOW_INVENTORY_LOG',
      ],
    },
    {
      label: 'Auto Messages',
      keys: [
        'ENABLE_WELCOME_MSG',
        'ENABLE_WELCOME_FILE',
        'ENABLE_AUTO_MSG_LINK',
        'ENABLE_AUTO_MSG_PROMO',
        'AUTO_MSG_LINK_TEXT',
        'AUTO_MSG_PROMO_TEXT',
        'DISCORD_INVITE_LINK',
      ],
    },
    {
      label: 'Module Toggles',
      keys: ['ENABLE_SERVER_STATUS', 'ENABLE_CHAT_RELAY', 'ENABLE_LOG_WATCHER', 'ENABLE_PLAYER_STATS'],
    },
    { label: 'Panel API', keys: ['PANEL_SERVER_URL', 'PANEL_API_KEY'] },
  ];

  const sections = [];
  for (const cat of categories as { label: string; keys: string[] }[]) {
    const keys: Record<string, unknown>[] = [];
    for (const envKey of cat.keys) {
      const mapping = ENV_TO_SERVERDEF[envKey];
      if (!mapping) continue;
      let raw = _getNestedValue(serverDef, mapping.jsonPath);
      if ((raw == null || raw === '') && mapping.legacyJsonPath) {
        raw = _getNestedValue(serverDef, mapping.legacyJsonPath);
      }
      const value = _botConfigDisplayValue(envKey, raw);
      const isSensitive = Boolean(mapping.sensitive) || ENV_SENSITIVE_KEYS.has(envKey);
      const isReadOnly = Boolean(mapping.readOnly) || ENV_READONLY_KEYS.has(envKey);
      const field = ENV_FIELD_BY_KEY.get(envKey);
      keys.push({
        key: envKey,
        value: isSensitive ? '' : value,
        sensitive: isSensitive,
        readOnly: isReadOnly,
        ..._botConfigItemMetadata(envKey, field, { sensitive: isSensitive, readOnly: isReadOnly }),
        hasValue: isSensitive ? value.length > 0 : undefined,
        commented: !value && !isSensitive, // show as "not set" if empty
      });
    }
    if (keys.length) sections.push({ label: cat.label, keys });
  }
  return sections;
}

/** Find a server definition by id. DB-first, fallback to servers.json. */
export function _getServerDef(configRepo: ConfigRepo | null, serverId: string): Record<string, unknown> | null {
  // DB-backed: read from config_documents
  if (configRepo) {
    try {
      const data = configRepo.get(`server:${serverId}`);
      if (data) return { data, source: 'database' };
    } catch (err: unknown) {
      console.warn('[WEB MAP] DB read failed for server, falling back to servers.json:', serverId, errMsg(err));
    }
  }
  // Legacy fallback: read from servers.json
  try {
    if (!fs.existsSync(SERVERS_FILE)) return null;
    const servers = JSON.parse(fs.readFileSync(SERVERS_FILE, 'utf8')) as Array<Record<string, unknown>>;
    const found = servers.find((s: Record<string, unknown>) => s.id === serverId) ?? null;
    return found ? { data: found, source: 'servers.json' } : null;
  } catch {
    return null;
  }
}

/** Write an updated server definition. DB-first, fallback to servers.json. */
export function _saveServerDef(
  configRepo: ConfigRepo | null,
  serverId: string,
  updater: (def: Record<string, unknown>) => void,
): boolean {
  // DB-backed: read-update-write via configRepo
  if (configRepo) {
    try {
      const scope = `server:${serverId}`;
      const data = configRepo.get(scope);
      if (!data) return false;
      updater(data);
      configRepo.set(scope, data);
      return true;
    } catch (err: unknown) {
      console.error('[WEB MAP] Failed to save server def to DB:', serverId, errMsg(err));
      return false;
    }
  }
  // Legacy fallback: read/write servers.json
  if (!fs.existsSync(SERVERS_FILE)) return false;
  const servers = JSON.parse(fs.readFileSync(SERVERS_FILE, 'utf8')) as Array<Record<string, unknown>>;
  const idx = servers.findIndex((s: Record<string, unknown>) => s.id === serverId);
  if (idx < 0) return false;
  updater(servers[idx] as Record<string, unknown>);
  const tmpPath = SERVERS_FILE + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(servers, null, 2));
  fs.renameSync(tmpPath, SERVERS_FILE);
  return true;
}

export function _maskServerDef(def: Record<string, unknown>): Record<string, unknown> {
  const masked = JSON.parse(JSON.stringify(def)) as Record<string, Record<string, unknown>>;
  if (masked.rcon?.password != null) masked.rcon.password = { hasValue: !!masked.rcon.password };
  if (masked.sftp?.password != null) masked.sftp.password = { hasValue: !!masked.sftp.password };
  if (masked.sftp?.privateKeyPath != null) masked.sftp.privateKeyPath = { hasValue: !!masked.sftp.privateKeyPath };
  if (masked.panel?.apiKey != null) masked.panel.apiKey = { hasValue: !!masked.panel.apiKey };
  return masked;
}
