/**
 * Bot-config routes: read the full bot configuration (primary via
 * ENV_CATEGORIES + DB documents, non-primary via serverDef, legacy via .env)
 * and apply config changes (DB write + live runtime reload, serverDef write,
 * or legacy .env write).
 *
 * Behavior-preserving extraction from web-map/server.ts (P1-1 god-file split).
 * Handlers are verbatim; only `this.` -> `ctx.` (and the local `configRepo` ->
 * `ctx._configRepo`) was applied. The module-level `__dirname` here is anchored
 * one directory up (to src/web-map/) so the verbatim `path.join(__dirname,
 * '..', '..', '.env')` legacy-fallback expression resolves to the project-root
 * .env exactly as it did in server.ts.
 */
import type { Express } from 'express';
import type { WebMapRouteContext } from '../types/route-context.js';
import path from 'path';
import fs from 'fs';
import config, { getConfigValue, setConfigValue } from '../../config/index.js';
import { summarizeConfigReloadApplyAsync } from '../../config/reload-strategy.js';
import { getDirname } from '../../utils/paths.js';
import { requireTier } from '../auth.js';
import { rateLimit } from '../rate-limit.js';
import { API_ERRORS, sendError, sendOk } from '../api-errors.js';
import { safeError, safeUnknownString } from '../route-helpers.js';
import { errMsg } from '../../utils/error.js';
import { ENV_CATEGORIES, ENV_CATEGORY_GROUPS } from '../../modules/panel-constants.js';
import { buildMigrationMap, SERVER_SCOPED_KEYS, BOOTSTRAP_KEYS, _coerce } from '../../db/config-migration.js';
import { ENV_KEY_VALIDATORS, validateField } from '../../db/config-validation.js';
import {
  ENV_SENSITIVE_KEYS,
  ENV_READONLY_KEYS,
  ENV_FIELD_BY_KEY,
  BOT_CONFIG_OPTION_SETS,
  BOT_CONFIG_TYPED_RUNTIME_KEYS,
  BOT_CONFIG_REQUIRED_RUNTIME_KEYS,
  BOT_CONFIG_RUNTIME_VALIDATION_KEYS,
  _botConfigItemMetadata,
  _botConfigDisplayValue,
  _serializeBotConfigInputValue,
  _normalizeBotConfigTypedValue,
  parseEnvFile,
} from '../bot-config-meta.js';
import {
  ENV_TO_SERVERDEF,
  _setNestedValue,
  _deleteNestedValue,
  _buildServerDefSections,
  _getServerDef,
  _saveServerDef,
} from '../serverdef-repo.js';

const __dirname = path.join(getDirname(import.meta.url), '..');

export function registerBotConfigRoutes(app: Express, ctx: WebMapRouteContext): void {
  /** GET /api/panel/bot-config — read from DB (primary uses ENV_CATEGORIES, non-primary uses serverDef) */
  app.get('/api/panel/bot-config', requireTier('admin'), rateLimit(10000, 10), (req, res) => {
    try {
      // ── Non-primary: read from config_documents / servers.json ──
      if (!req.srv.isPrimary) {
        const result = _getServerDef(ctx._configRepo, req.srv.serverId);
        if (!result) {
          sendError(res, API_ERRORS.SERVER_NOT_FOUND_IN_SERVERS_JSON, 404);
          return;
        }
        const sections = _buildServerDefSections(result.data as Record<string, unknown>);
        return res.json({
          sections,
          groups: ENV_CATEGORY_GROUPS,
          optionSets: BOT_CONFIG_OPTION_SETS,
          source: result.source,
        });
      }

      // ── Primary: read from config singleton + DB documents ──
      if (ctx._configRepo) {
        const migrationMap = buildMigrationMap();
        const appData = ctx._configRepo.get('app') || {};
        const serverData = ctx._configRepo.get('server:primary') || {};

        const sections: Record<string, unknown>[] = [];
        for (const cat of ENV_CATEGORIES) {
          const keys: Record<string, unknown>[] = [];
          for (const field of cat.fields) {
            const isSensitive = ('sensitive' in field && Boolean(field.sensitive)) || ENV_SENSITIVE_KEYS.has(field.env);
            const isReadOnly = ENV_READONLY_KEYS.has(field.env);
            const mapping = migrationMap[field.env];
            const doc = mapping?.scope === 'server:primary' || SERVER_SCOPED_KEYS.has(field.env) ? serverData : appData;
            const docKey = mapping?.cfgKey || field.env;
            const hasDbValue = Object.prototype.hasOwnProperty.call(doc, docKey);

            // Resolve value: DB document first, then config singleton for live/hydrated fallback.
            let rawValue: unknown;
            if (hasDbValue) {
              rawValue = doc[docKey];
            } else if (field.cfg) {
              rawValue = getConfigValue(config, field.cfg);
            } else {
              // Fields without cfg are stored under their env key in DB
              rawValue = doc[field.env];
            }
            const value = _botConfigDisplayValue(field.env, rawValue);

            keys.push({
              key: field.env,
              value: isSensitive ? '' : value,
              sensitive: isSensitive,
              readOnly: isReadOnly,
              ..._botConfigItemMetadata(field.env, field, { sensitive: isSensitive, readOnly: isReadOnly }),
              hasValue: isSensitive ? value.length > 0 && !value.startsWith('your_') : undefined,
              commented: !value && !isSensitive,
            });
          }
          if (keys.length) sections.push({ id: cat.id, label: cat.label, keys });
        }

        return res.json({
          sections,
          groups: ENV_CATEGORY_GROUPS,
          optionSets: BOT_CONFIG_OPTION_SETS,
          source: 'database',
        });
      }

      // ── Legacy fallback: read from .env ──
      const envPath = path.join(__dirname, '..', '..', '.env');
      if (!fs.existsSync(envPath)) {
        sendError(res, API_ERRORS.ENV_FILE_NOT_FOUND, 404);
        return;
      }

      const content = fs.readFileSync(envPath, 'utf8');
      const entries = parseEnvFile(content);

      // Build categorized output
      const sections: Record<string, unknown>[] = [];
      let currentSection: { label: string | undefined; keys: Record<string, unknown>[] } = {
        label: 'General',
        keys: [],
      };

      for (const entry of entries) {
        if (entry.type === 'section') {
          // Start a new section if current has keys
          if (currentSection.keys.length > 0) sections.push(currentSection);
          currentSection = { label: entry.label, keys: [] };
          continue;
        }
        if (entry.type === 'keyval') {
          const entryKey = entry.key;
          const entryValue = entry.value;
          const field = ENV_FIELD_BY_KEY.get(entryKey);
          const isSensitive = ENV_SENSITIVE_KEYS.has(entryKey) || Boolean(field?.sensitive);
          const isReadOnly = ENV_READONLY_KEYS.has(entryKey);
          const value = _botConfigDisplayValue(entryKey, entryValue);
          currentSection.keys.push({
            key: entryKey,
            value: isSensitive ? '' : value,
            sensitive: isSensitive,
            readOnly: isReadOnly,
            ..._botConfigItemMetadata(entryKey, field, { sensitive: isSensitive, readOnly: isReadOnly }),
            hasValue: isSensitive ? value.length > 0 && !value.startsWith('your_') : undefined,
            commented: false,
          });
        } else if (entry.type === 'commented') {
          const entryKey = entry.key;
          const entryValue = entry.value;
          const field = ENV_FIELD_BY_KEY.get(entryKey);
          const isSensitive = ENV_SENSITIVE_KEYS.has(entryKey) || Boolean(field?.sensitive);
          const isReadOnly = ENV_READONLY_KEYS.has(entryKey);
          const value = _botConfigDisplayValue(entryKey, entryValue);
          currentSection.keys.push({
            key: entryKey,
            value: isSensitive ? '' : value,
            sensitive: isSensitive,
            readOnly: isReadOnly,
            ..._botConfigItemMetadata(entryKey, field, { sensitive: isSensitive, readOnly: isReadOnly }),
            hasValue: false,
            commented: true,
          });
        }
      }
      if (currentSection.keys.length > 0) sections.push(currentSection);

      res.json({ sections, groups: ENV_CATEGORY_GROUPS, optionSets: BOT_CONFIG_OPTION_SETS });
    } catch (err: unknown) {
      sendError(res, API_ERRORS.FAILED_TO_READ_BOT_CONFIG, 500, safeError(err));
    }
  });

  /** POST /api/panel/bot-config — update config in DB (primary) or serverDef (non-primary) */
  app.post('/api/panel/bot-config', requireTier('admin'), rateLimit(30000, 3), async (req, res) => {
    const { changes } = req.body as { changes?: Record<string, unknown> };
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      sendError(res, API_ERRORS.MISSING_CHANGES_OBJECT, 400);
      return;
    }

    // Block read-only keys
    const blocked = Object.keys(changes).filter((k) => ENV_READONLY_KEYS.has(k));
    if (blocked.length > 0) {
      sendError(res, API_ERRORS.CANNOT_MODIFY_READ_ONLY_KEYS, 403, blocked.join(', '));
      return;
    }

    // Validate and normalize values: generic string guards first, then field-level validators where configured.
    const validationMigrationMap = buildMigrationMap();
    const normalizedChanges: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(changes)) {
      let v: string;
      try {
        const serialized = _serializeBotConfigInputValue(value);
        if (typeof serialized !== 'string') {
          sendError(res, API_ERRORS.INVALID_BOT_CONFIG_VALUE, 400, {
            key,
            reason: 'Value must be serializable to a string',
          });
          return;
        }
        v = serialized;
      } catch {
        sendError(res, API_ERRORS.INVALID_BOT_CONFIG_VALUE, 400, {
          key,
          reason: 'Value must be JSON-serializable',
        });
        return;
      }
      if (BOT_CONFIG_REQUIRED_RUNTIME_KEYS.has(key) && (value == null || !v.trim())) {
        sendError(res, API_ERRORS.INVALID_BOT_CONFIG_VALUE, 400, {
          key,
          reason: 'Value is required',
        });
        return;
      }
      if (/[\r\n]/.test(v)) {
        sendError(res, API_ERRORS.INVALID_VALUE_CONTAINS_NEWLINE, 400, key);
        return;
      }
      if (v.length > 2000) {
        sendError(res, API_ERRORS.VALUE_TOO_LONG, 400, key);
        return;
      }
      if (ENV_KEY_VALIDATORS[key] || BOT_CONFIG_RUNTIME_VALIDATION_KEYS.has(key)) {
        const mapping = validationMigrationMap[key];
        const validation = validateField(key, value, mapping);
        if (!validation.valid) {
          sendError(res, API_ERRORS.INVALID_BOT_CONFIG_VALUE, 400, { key, reason: validation.error });
          return;
        }
        try {
          normalizedChanges[key] = _normalizeBotConfigTypedValue(key, validation.value);
        } catch (err: unknown) {
          sendError(res, API_ERRORS.INVALID_BOT_CONFIG_VALUE, 400, { key, reason: errMsg(err) });
          return;
        }
      } else {
        normalizedChanges[key] = value;
      }
    }

    // ── Non-primary: write to serverDef via DB / servers.json ──
    if (!req.srv.isPrimary) {
      try {
        const serverId = req.srv.serverId;
        const updated = new Set<string>();
        const ok = _saveServerDef(ctx._configRepo, serverId, (serverDef) => {
          for (const [envKey, value] of Object.entries(normalizedChanges)) {
            const mapping = ENV_TO_SERVERDEF[envKey];
            if (!mapping) continue; // ignore keys not in the mapping
            const val =
              value == null
                ? ''
                : typeof value === 'string'
                  ? value
                  : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
                    ? String(value)
                    : safeUnknownString(value);
            // Convert booleans for boolean-like fields while preserving typed runtime fields.
            let coerced: unknown = value;
            if (!BOT_CONFIG_TYPED_RUNTIME_KEYS.has(envKey)) {
              coerced = val;
              if (val === 'true') coerced = true;
              else if (val === 'false') coerced = false;
              else if (
                /^\d+$/.test(val) &&
                !envKey.includes('ID') &&
                !envKey.includes('PATH') &&
                !envKey.includes('NAME') &&
                !envKey.includes('TEXT') &&
                !envKey.includes('HOST') &&
                !envKey.includes('USER') &&
                !envKey.includes('PASSWORD') &&
                !envKey.includes('KEY') &&
                !envKey.includes('LINK') &&
                !envKey.includes('URL') &&
                !envKey.includes('CONTAINER') &&
                !envKey.includes('TIMEZONE') &&
                !envKey.includes('OVERRIDES') &&
                !envKey.includes('PROFILES') &&
                !envKey.includes('TIMES') &&
                !envKey.includes('DAYS') // PVP_DAYS is a day-spec string, never a number
              ) {
                coerced = parseInt(val, 10);
              }
            }
            // Empty/null/undefined → remove the key (so it falls through to primary defaults via prototype)
            if (val === '') {
              _deleteNestedValue(serverDef, mapping.jsonPath);
              if (mapping.legacyJsonPath) _deleteNestedValue(serverDef, mapping.legacyJsonPath);
            } else {
              _setNestedValue(serverDef, mapping.jsonPath, coerced);
              if (mapping.legacyJsonPath) _deleteNestedValue(serverDef, mapping.legacyJsonPath);
            }
            updated.add(envKey);
          }
        });

        if (!ok) {
          sendError(res, API_ERRORS.SERVER_NOT_FOUND_IN_SERVERS_JSON, 404);
          return;
        }

        sendOk(res, {
          updated: [...updated],
          restartRequired: true,
          message: `Updated ${updated.size} setting${updated.size !== 1 ? 's' : ''}. Restart the bot for changes to take effect.`,
        });
        return;
      } catch (err: unknown) {
        sendError(res, API_ERRORS.FAILED_TO_SAVE_SERVER_CONFIG, 500, safeError(err));
        return;
      }
    }

    // ── Primary: write to DB via ctx._configRepo ──
    if (ctx._configRepo) {
      try {
        const migrationMap = buildMigrationMap();
        const appPatch: Record<string, unknown> = {};
        const serverPatch: Record<string, unknown> = {};
        const updated = new Set<string>();
        const runtimeConfigValues = new Map<string, { cfgKey: string; value: unknown }>();

        for (const [envKey, rawValue] of Object.entries(normalizedChanges)) {
          // Skip bootstrap keys — they live in .env and can't be changed via web panel
          if (BOOTSTRAP_KEYS.has(envKey)) continue;

          const mapping = migrationMap[envKey];
          const targetKey = mapping?.cfgKey || envKey;
          const type = mapping?.type || 'string';
          const coerced = BOT_CONFIG_TYPED_RUNTIME_KEYS.has(envKey) ? rawValue : _coerce(String(rawValue), type);
          const scope = mapping?.scope || (SERVER_SCOPED_KEYS.has(envKey) ? 'server:primary' : 'app');

          if (scope === 'server:primary') {
            serverPatch[targetKey] = coerced;
          } else {
            appPatch[targetKey] = coerced;
          }

          if (mapping?.cfgKey) runtimeConfigValues.set(envKey, { cfgKey: mapping.cfgKey, value: coerced });

          updated.add(envKey);
        }

        if (Object.keys(appPatch).length > 0) ctx._configRepo.update('app', appPatch);
        if (Object.keys(serverPatch).length > 0) ctx._configRepo.update('server:primary', serverPatch);

        const applyResult = await summarizeConfigReloadApplyAsync(updated, {
          applyLive(envKey) {
            const liveConfigValue = runtimeConfigValues.get(envKey);
            if (!liveConfigValue) throw new Error('No runtime config mapping for live setting');
            setConfigValue(config, liveConfigValue.cfgKey, liveConfigValue.value);
          },
          applyModuleReconfigure: (envKey) => {
            const runtimeConfigValue = runtimeConfigValues.get(envKey);
            if (!runtimeConfigValue) {
              if (ctx._runtimeConfigApplier?.hasModuleReconfigure(envKey)) {
                throw new Error('No runtime config mapping for module reconfigure setting');
              }
              return false;
            }

            return (
              ctx._runtimeConfigApplier?.applyModuleReconfigure({
                envKey,
                cfgKey: runtimeConfigValue.cfgKey,
                value: runtimeConfigValue.value,
              }) === true
            );
          },
          applyModuleRestartAsync: async (envKey) => {
            const runtimeConfigValue = runtimeConfigValues.get(envKey);
            if (!runtimeConfigValue) {
              if (ctx._runtimeConfigApplier?.hasModuleRestart(envKey)) {
                throw new Error('No runtime config mapping for module restart setting');
              }
              return false;
            }

            return (
              (await ctx._runtimeConfigApplier?.applyModuleRestart({
                envKey,
                cfgKey: runtimeConfigValue.cfgKey,
                value: runtimeConfigValue.value,
              })) === true
            );
          },
          applyConnectionReconnect: (envKey) => {
            const runtimeConfigValue = runtimeConfigValues.get(envKey);
            if (!runtimeConfigValue) {
              if (ctx._runtimeConfigApplier?.hasConnectionReconnect(envKey)) {
                throw new Error('No runtime config mapping for connection reconnect setting');
              }
              return false;
            }

            return (
              ctx._runtimeConfigApplier?.applyConnectionReconnect({
                envKey,
                cfgKey: runtimeConfigValue.cfgKey,
                value: runtimeConfigValue.value,
              }) === true
            );
          },
          applyConnectionReconnectBatch: async (envKeys) => {
            const contexts = envKeys.map((envKey) => {
              const runtimeConfigValue = runtimeConfigValues.get(envKey);
              if (!runtimeConfigValue) {
                if (ctx._runtimeConfigApplier?.hasConnectionReconnect(envKey)) {
                  throw new Error('No runtime config mapping for connection reconnect setting');
                }
                return null;
              }
              return {
                envKey,
                cfgKey: runtimeConfigValue.cfgKey,
                value: runtimeConfigValue.value,
              };
            });

            const applicableContexts = contexts.filter(
              (context): context is NonNullable<typeof context> => context !== null,
            );
            const missingApplicableKeys = envKeys.filter((_envKey, index) => contexts[index] === null);
            const applied = await ctx._runtimeConfigApplier?.applyConnectionReconnectBatch(applicableContexts);

            return {
              applied: applied?.applied ?? [],
              errors: [
                ...(applied?.errors ?? []),
                ...missingApplicableKeys
                  .filter((envKey) => ctx._runtimeConfigApplier?.hasConnectionReconnect(envKey))
                  .map((envKey) => ({
                    key: envKey,
                    message: 'No runtime config mapping for connection reconnect setting',
                  })),
              ],
            };
          },
        });

        sendOk(res, {
          ...applyResult,
        });
        return;
      } catch (err: unknown) {
        sendError(res, API_ERRORS.FAILED_TO_SAVE_BOT_CONFIG, 500, safeError(err));
        return;
      }
    }

    // ── Legacy fallback: write to .env ──
    try {
      const envPath = path.join(__dirname, '..', '..', '.env');
      if (!fs.existsSync(envPath)) {
        sendError(res, API_ERRORS.ENV_FILE_NOT_FOUND, 404);
        return;
      }

      const content = fs.readFileSync(envPath, 'utf8');
      const lines = content.split('\n');
      const updated = new Set();

      const newLines = lines.map((line: string) => {
        const trimmed = line.trim();

        // Active key=value line
        const eq = trimmed.indexOf('=');
        if (eq > 0 && !trimmed.startsWith('#') && !trimmed.startsWith(';')) {
          const key = trimmed.substring(0, eq).trim();
          if (key in changes) {
            updated.add(key);
            return `${key}=${String(changes[key])}`;
          }
        }

        // Commented-out key — uncomment it if user is setting a value
        if (trimmed.startsWith('#')) {
          const commentedMatch = trimmed.match(/^#\s*([A-Z][A-Z0-9_]*)=(.*)/);
          if (commentedMatch?.[1] && commentedMatch[1] in changes) {
            const key = commentedMatch[1];
            updated.add(key);
            const val = String(changes[key]);
            // If setting to empty, re-comment it
            if (val === '') return `#${key}=`;
            return `${key}=${val}`;
          }
        }

        return line;
      });

      // Any keys not found in the file — append them at the end
      for (const key of Object.keys(changes)) {
        if (!updated.has(key) && String(changes[key]) !== '') {
          newLines.push(`${key}=${String(changes[key])}`);
          updated.add(key);
        }
      }

      // Write atomically — write to temp then rename
      const tmpPath = envPath + '.tmp';
      fs.writeFileSync(tmpPath, newLines.join('\n'));
      fs.renameSync(tmpPath, envPath);

      sendOk(res, {
        updated: [...updated],
        restartRequired: true,
        message: `Updated ${updated.size} setting${updated.size !== 1 ? 's' : ''}. Restart the bot for changes to take effect.`,
      });
    } catch (err: unknown) {
      sendError(res, API_ERRORS.FAILED_TO_SAVE_BOT_CONFIG, 500, safeError(err));
    }
  });
}
