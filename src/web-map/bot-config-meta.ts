/**
 * Bot-config metadata: static option sets, control/runtime metadata builders,
 * value (de)serialization, and .env file parsing. All pure/static — no `this`
 * or per-request state. Used by the bot-config routes and by serverdef-repo's
 * section builder.
 *
 * Extracted verbatim from web-map/server.ts (P1-1 god-file split); only
 * de-indentation and `export` were added.
 */

import { BOOTSTRAP_KEYS } from '../db/config-migration.js';
import { resolveReloadStrategy } from '../config/reload-strategy.js';
import { ENV_CATEGORIES } from '../modules/panel-constants.js';
import { ENV_KEY_VALIDATORS } from '../db/config-validation.js';
import { safeUnknownString } from './route-helpers.js';
import type { EnvEntry } from './types/db-rows.js';

// Keys that contain credentials — values are NEVER sent to the client.
// Write is allowed (masked placeholder is replaced only if user provides a real value).
export const ENV_SENSITIVE_KEYS = new Set([
  'DISCORD_TOKEN',
  'DISCORD_OAUTH_SECRET',
  'RCON_PASSWORD',
  'SFTP_PASSWORD',
  'SFTP_PRIVATE_KEY_PATH',
  'PANEL_API_KEY',
]);

// Keys that are read-only (managed by the bot/bootstrap .env, not user-editable via web)
export const ENV_READONLY_KEYS = new Set(['ENV_SCHEMA_VERSION', ...BOOTSTRAP_KEYS]);

export function _reloadStrategyReasonKey(envKey: string, reloadStrategy: string): string {
  if (envKey === 'WEB_MAP_SESSION_SECRET') return 'settings.reload_reason.session_secret';
  return `settings.reload_strategy_desc.${reloadStrategy.replace(/-/g, '_')}`;
}

export function _botConfigRuntimeMetadata(envKey: string): { reloadStrategy: string; reloadStrategyReasonKey: string } {
  const reloadStrategy = resolveReloadStrategy(envKey);
  return {
    reloadStrategy,
    reloadStrategyReasonKey: _reloadStrategyReasonKey(envKey, reloadStrategy),
  };
}

export type BotConfigFieldMeta = {
  env: string;
  label?: string;
  type?: string;
  style?: string;
  sensitive?: boolean;
};

export const ENV_FIELD_BY_KEY = new Map<string, BotConfigFieldMeta>();
for (const cat of ENV_CATEGORIES as Array<{ fields: BotConfigFieldMeta[] }>) {
  for (const field of cat.fields) {
    ENV_FIELD_BY_KEY.set(field.env, field);
  }
}

export const ENUM_OPTION_LABELS: Record<string, Record<string, string>> = {
  BOT_LOCALE: { en: 'English', 'zh-TW': '繁體中文', 'zh-CN': '简体中文' },
  AGENT_MODE: {
    auto: 'auto',
    agent: 'agent',
    direct: 'direct',
    cache: 'cache (legacy)',
  },
  AGENT_TRIGGER: { auto: 'auto', rcon: 'rcon', panel: 'panel', ssh: 'ssh', none: 'none' },
  SESSION_STORE: { memory: 'memory', sqlite: 'sqlite', redis: 'redis' },
};

export const ENUM_OPTION_DESCRIPTIONS: Record<string, Record<string, string>> = {
  AGENT_MODE: {
    cache: 'Legacy/deprecated compatibility mode; keep existing cache values valid, prefer auto/agent/direct.',
  },
};

export function _buildTimezoneOptionSet(): string[] {
  // SAFETY: the ES2022 lib types Intl.supportedValuesOf as always-present, but we model it as
  // optional so the runtime feature-detection guard below stays meaningful on engines that
  // predate it. Removing the cast makes the `if` provably-truthy (no-unnecessary-condition).
  const supportedValuesOf = (Intl as unknown as { supportedValuesOf?: (key: 'timeZone') => string[] })
    .supportedValuesOf;
  const zones = new Set<string>(['UTC', 'Etc/UTC']);
  if (supportedValuesOf) {
    for (const zone of supportedValuesOf('timeZone')) {
      zones.add(zone);
    }
  }
  return [...zones].sort((a, b) => a.localeCompare(b));
}

export const BOT_CONFIG_OPTION_SETS: Record<string, string[]> = {
  timezones: _buildTimezoneOptionSet(),
};

export function _enumControlOptions(envKey: string, options: string[]): Record<string, unknown>[] {
  const labels = ENUM_OPTION_LABELS[envKey] ?? {};
  const descriptions = ENUM_OPTION_DESCRIPTIONS[envKey] ?? {};
  return options.map((value) => {
    const option: Record<string, unknown> = {
      value,
      label: labels[value] ?? value,
    };
    if (descriptions[value]) option.description = descriptions[value];
    if (envKey === 'AGENT_MODE' && value === 'cache') {
      option.legacy = true;
      option.deprecated = true;
    }
    return option;
  });
}

export function _botConfigControlMetadata(
  envKey: string,
  field: BotConfigFieldMeta | undefined,
  flags: { sensitive?: boolean; readOnly?: boolean },
): Record<string, unknown> {
  if (flags.readOnly) return { control: 'readonly' };
  if (flags.sensitive) return { control: 'password' };

  const validator = ENV_KEY_VALIDATORS[envKey];
  const fieldType = field?.type ?? (envKey === 'ENABLED' ? 'bool' : undefined);
  if (fieldType === 'bool') return { control: 'toggle', valueType: 'boolean' };

  if (validator) {
    if (validator.type === 'enum') {
      return {
        control: 'select',
        validator: validator.type,
        valueType: 'string',
        options: _enumControlOptions(envKey, validator.options),
      };
    }
    if (validator.type === 'timezone') {
      return {
        control: 'combobox',
        validator: validator.type,
        valueType: 'string',
        optionSet: 'timezones',
        freeform: true,
      };
    }
    if (validator.type === 'time') {
      return {
        control: 'time',
        validator: validator.type,
        valueType: 'string',
        pattern: 'HH:MM',
        required: BOT_CONFIG_REQUIRED_RUNTIME_KEYS.has(envKey),
      };
    }
    if (validator.type === 'json') {
      return {
        control: 'textarea',
        validator: validator.type,
        valueType: 'json',
        rows: 3,
        singleLine: true,
      };
    }
    if (validator.type === 'port') {
      return {
        control: 'number',
        validator: validator.type,
        valueType: 'integer',
        inputMode: 'numeric',
        min: 1,
        max: 65535,
      };
    }
    if (validator.type === 'interval') {
      return {
        control: 'number',
        validator: validator.type,
        valueType: 'integer',
        inputMode: 'numeric',
        min: validator.min,
      };
    }
    if (validator.type === 'url') {
      return { control: 'url', validator: validator.type, valueType: 'string' };
    }
    if (validator.type === 'snowflake') {
      return {
        control: 'text',
        validator: validator.type,
        valueType: 'string',
        inputMode: 'numeric',
        pattern: 'comma-separated Discord snowflake IDs',
      };
    }
    return { control: 'text', validator: validator.type, valueType: 'string' };
  }

  if (field?.style === 'paragraph') {
    return { control: 'textarea', valueType: 'string', rows: 3, singleLine: true };
  }
  if (fieldType === 'int') {
    return { control: 'number', valueType: 'integer', inputMode: 'numeric' };
  }
  return { control: 'text', valueType: 'string' };
}

export function _botConfigItemMetadata(
  envKey: string,
  field: BotConfigFieldMeta | undefined,
  flags: { sensitive?: boolean; readOnly?: boolean },
): Record<string, unknown> {
  return {
    ..._botConfigRuntimeMetadata(envKey),
    ..._botConfigControlMetadata(envKey, field, flags),
  };
}

export function _formatMinutesAsTime(totalMinutes: number): string {
  const normalized = ((Math.trunc(totalMinutes) % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function _botConfigDisplayValue(envKey: string, rawValue: unknown): string {
  if ((envKey !== 'PVP_START_TIME' && envKey !== 'PVP_END_TIME') || rawValue == null || rawValue === '') {
    return safeUnknownString(rawValue);
  }
  if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
    return _formatMinutesAsTime(rawValue);
  }
  const value = safeUnknownString(rawValue).trim();
  if (/^\d{2}:\d{2}$/.test(value)) return value;
  if (/^\d+$/.test(value)) {
    const n = parseInt(value, 10);
    if (n >= 0 && n <= 23) return `${String(n).padStart(2, '0')}:00`;
    if (n >= 0 && n < 1440) return _formatMinutesAsTime(n);
  }
  return value;
}

export const BOT_CONFIG_TYPED_RUNTIME_KEYS = new Set(['PVP_START_TIME', 'PVP_END_TIME', 'PVP_SETTINGS_OVERRIDES']);
export const BOT_CONFIG_REQUIRED_RUNTIME_KEYS = new Set(['PVP_START_TIME', 'PVP_END_TIME']);

export function _serializeBotConfigInputValue(value: unknown): string | undefined {
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value);
    case 'symbol':
      return value.toString();
    case 'object':
      return JSON.stringify(value);
    case 'function':
    case 'undefined':
      return undefined;
  }
}

export function _parseBotConfigTimeMinutes(value: unknown): number | undefined {
  if (typeof value === 'number') {
    if (Number.isFinite(value) && value >= 0 && value < 1440) return value;
    throw new Error('Invalid time minutes value');
  }
  const raw = safeUnknownString(value).trim();
  if (!raw) return undefined;
  const match = raw.match(/^(\d{2}):(\d{2})$/);
  if (!match) throw new Error('Time must be in HH:MM format');
  const hours = parseInt(match[1] ?? '0', 10);
  const minutes = parseInt(match[2] ?? '0', 10);
  if (hours > 23 || minutes > 59) throw new Error('Time hours must be under 24 and minutes under 60');
  return hours * 60 + minutes;
}

export function _normalizeBotConfigJsonObject(value: Record<string, unknown>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (typeof entryValue !== 'string' && typeof entryValue !== 'number' && typeof entryValue !== 'boolean') {
      throw new Error('JSON object values must be strings, numbers, or booleans');
    }
    normalized[key] = String(entryValue);
  }
  return normalized;
}

export function _parseBotConfigJsonObject(value: unknown): Record<string, string> | null {
  if (value == null) return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return _normalizeBotConfigJsonObject(value as Record<string, unknown>);
  }
  const raw = typeof value === 'string' ? value.trim() : safeUnknownString(value).trim();
  if (!raw) return null;
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON value must be an object');
  }
  return _normalizeBotConfigJsonObject(parsed as Record<string, unknown>);
}

export function _normalizeBotConfigTypedValue(envKey: string, value: unknown): unknown {
  if (envKey === 'PVP_START_TIME' || envKey === 'PVP_END_TIME') {
    return _parseBotConfigTimeMinutes(value);
  }
  if (envKey === 'PVP_SETTINGS_OVERRIDES') {
    return _parseBotConfigJsonObject(value);
  }
  return value;
}

/** Parse a .env file into structured entries preserving comments and order */
export function parseEnvFile(content: string): (EnvEntry | { type: string; raw?: string })[] {
  const entries = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = (raw ?? '').trim();

    // Blank line
    if (!trimmed) {
      entries.push({ type: 'blank', raw });
      continue;
    }

    // Section header comment (e.g. "# ── Discord Bot ──")
    if (/^#\s*[─═]/.test(trimmed)) {
      entries.push({
        type: 'section',
        raw,
        label: trimmed
          .replace(/^#\s*[─═]+\s*/, '')
          .replace(/\s*[─═]+\s*$/, '')
          .trim(),
      });
      continue;
    }

    // Regular comment
    if (trimmed.startsWith('#')) {
      // Check if it's a commented-out key (e.g. #KEY=value)
      const commentedMatch = trimmed.match(/^#\s*([A-Z][A-Z0-9_]*)=(.*)/);
      if (commentedMatch) {
        entries.push({ type: 'commented', raw, key: commentedMatch[1], value: commentedMatch[2] });
      } else {
        entries.push({ type: 'comment', raw });
      }
      continue;
    }

    // Key=value line
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      const key = trimmed.substring(0, eq).trim();
      const value = trimmed.substring(eq + 1).trim();
      entries.push({ type: 'keyval', raw, key, value });
    } else {
      entries.push({ type: 'other', raw });
    }
  }
  return entries;
}
