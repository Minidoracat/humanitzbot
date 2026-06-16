/**
 * Scheduler routes: read the server scheduler status and save restart times,
 * profiles, and per-profile settings (serverDef write for non-primary, legacy
 * .env write for primary).
 *
 * Behavior-preserving extraction from web-map/server.ts (P1-1 god-file split).
 * Handlers are verbatim; only `this.` -> `ctx.` (and the local `configRepo` ->
 * `ctx._configRepo`) was applied. The module-level `__dirname` here is anchored
 * one directory up (to src/web-map/) so the verbatim `path.join(__dirname,
 * '..', '..', '.env')` expression resolves to the project-root .env exactly as
 * it did in server.ts.
 */
import type { Express } from 'express';
import type { WebMapRouteContext } from '../types/route-context.js';
import path from 'path';
import fs from 'fs';
import { getDirname } from '../../utils/paths.js';
import { requireTier } from '../auth.js';
import { rateLimit } from '../rate-limit.js';
import { API_ERRORS, sendError, sendOk } from '../api-errors.js';
import { safeError } from '../route-helpers.js';
import { _saveServerDef } from '../serverdef-repo.js';

const __dirname = path.join(getDirname(import.meta.url), '..');

export function registerSchedulerRoutes(app: Express, ctx: WebMapRouteContext): void {
  // ── API: Server scheduler status ──
  app.get('/api/panel/scheduler', requireTier('survivor'), (req, res) => {
    // This will be populated by the bot when it passes the scheduler instance
    if (req.srv.scheduler) {
      res.json(req.srv.scheduler.getStatus());
    } else {
      res.json({ active: false });
    }
  });

  // ── Schedule Editor: save restart times, profiles, and per-profile settings ──
  app.post('/api/panel/scheduler', requireTier('admin'), rateLimit(30000, 3), (req, res) => {
    const { restartTimes, profiles, profileSettings, rotateDaily, serverNameTemplate } = req.body as {
      restartTimes?: string[];
      profiles?: string[];
      profileSettings?: Record<string, unknown>;
      rotateDaily?: boolean;
      serverNameTemplate?: string;
    };
    if (!restartTimes || !Array.isArray(restartTimes)) {
      sendError(res, API_ERRORS.RESTART_TIMES_INVALID, 400);
      return;
    }
    // Validate restart times format
    for (const t of restartTimes) {
      if (!/^\d{1,2}:\d{2}$/.test(t)) {
        sendError(res, API_ERRORS.INVALID_TIME_FORMAT, 400, t);
        return;
      }
    }
    // Validate profiles
    const profileList = Array.isArray(profiles)
      ? profiles.filter((p: unknown): p is string => typeof p === 'string' && !!p.trim())
      : [];
    const settings: Record<string, Record<string, unknown>> = profileSettings && typeof profileSettings === 'object'
      ? (profileSettings as Record<string, Record<string, unknown>>)
      : {};

    // Validate profile settings are JSON-safe objects
    for (const [name, val] of Object.entries(settings)) {
      if (typeof val !== 'object' || Array.isArray(val)) {
        sendError(res, API_ERRORS.PROFILE_SETTINGS_MUST_BE_OBJECT, 400, name);
        return;
      }
      // Ensure all values are strings (game server INI format)
      for (const [k, v] of Object.entries(val)) {
        if (typeof v !== 'string' && typeof v !== 'number') {
          sendError(res, API_ERRORS.INVALID_PROFILE_VALUE_TYPE, 400, `${name}.${k}`);
          return;
        }
      }
    }

    const timesStr = restartTimes.join(',');
    const profilesStr = profileList.map((p: string) => p.trim().toLowerCase()).join(',');

    // ── Non-primary: write to servers.json ──
    if (!req.srv.isPrimary) {
      try {
        const serverId = req.srv.serverId;
        const ok = _saveServerDef(ctx._configRepo, serverId, (serverDef) => {
          serverDef.restartTimes = timesStr;
          serverDef.restartProfiles = profilesStr;
          serverDef.enableServerScheduler = restartTimes.length > 0;
          if (rotateDaily !== undefined) serverDef.restartRotateDaily = rotateDaily;
          if (typeof serverNameTemplate === 'string') serverDef.serverNameTemplate = serverNameTemplate;
          if (profileList.length > 0) {
            (serverDef.restartProfileSettings as Record<string, unknown>) = {};
            for (const name of profileList) {
              const key = name.trim().toLowerCase();
              if (settings[key]) (serverDef.restartProfileSettings as Record<string, unknown>)[key] = settings[key];
            }
          } else {
            Reflect.deleteProperty(serverDef, 'restartProfileSettings');
          }
        });
        if (!ok) {
          sendError(res, API_ERRORS.SERVER_NOT_FOUND, 404);
          return;
        }
        sendOk(res, {
          restartRequired: true,
          message: 'Schedule saved. Restart the bot for changes to take effect.',
        });
        return;
      } catch (err: unknown) {
        sendError(res, API_ERRORS.FAILED_TO_SAVE, 500, safeError(err));
        return;
      }
    }

    // ── Primary: write to .env ──
    try {
      const envPath = path.join(__dirname, '..', '..', '.env');
      if (!fs.existsSync(envPath)) {
        sendError(res, API_ERRORS.ENV_FILE_NOT_FOUND, 404);
        return;
      }

      const content = fs.readFileSync(envPath, 'utf8');
      const lines = content.split('\n');
      const updated = new Set();

      // Build the changes map
      const changes: Record<string, string> = {
        ENABLE_SERVER_SCHEDULER: restartTimes.length > 0 ? 'true' : 'false',
        RESTART_TIMES: timesStr,
        RESTART_PROFILES: profilesStr,
      };
      if (rotateDaily !== undefined) changes.RESTART_ROTATE_DAILY = rotateDaily ? 'true' : 'false';
      if (typeof serverNameTemplate === 'string') changes.SERVER_NAME_TEMPLATE = serverNameTemplate;

      // Add profile settings as RESTART_PROFILE_<NAME>=JSON
      for (const name of profileList) {
        const key = name.trim().toLowerCase();
        const envKey = `RESTART_PROFILE_${key.toUpperCase()}`;
        if (settings[key] && Object.keys(settings[key]).length > 0) {
          changes[envKey] = JSON.stringify(settings[key]);
        }
      }

      // Remove old RESTART_PROFILE_* that are no longer in the profile list
      const activeProfileKeys = new Set(profileList.map((p: string) => `RESTART_PROFILE_${p.trim().toUpperCase()}`));

      const newLines = lines.map((line: string) => {
        const trimmed = line.trim();
        const eq = trimmed.indexOf('=');
        if (eq > 0 && !trimmed.startsWith('#') && !trimmed.startsWith(';')) {
          const key = trimmed.substring(0, eq).trim();
          if (key in changes) {
            updated.add(key);
            return `${key}=${String(changes[key])}`;
          }
          // Comment out old profile keys that are no longer active
          if (key.startsWith('RESTART_PROFILE_') && !activeProfileKeys.has(key)) {
            updated.add(key);
            return `#${line}`;
          }
        }
        // Uncomment if it's a key we want to set
        if (trimmed.startsWith('#')) {
          const m = trimmed.match(/^#\s*([A-Z][A-Z0-9_]*)=(.*)/);
          if (m?.[1] && m[1] in changes) {
            updated.add(m[1]);
            return `${m[1]}=${String(changes[m[1]])}`;
          }
        }
        return line;
      });

      // Append any keys not found
      for (const key of Object.keys(changes)) {
        if (!updated.has(key) && String(changes[key]) !== '') {
          newLines.push(`${key}=${changes[key]}`);
          updated.add(key);
        }
      }

      const tmpPath = envPath + '.tmp';
      fs.writeFileSync(tmpPath, newLines.join('\n'));
      fs.renameSync(tmpPath, envPath);

      sendOk(res, {
        updated: [...updated],
        restartRequired: true,
        message: `Schedule saved (${updated.size} keys). Restart the bot for changes to take effect.`,
      });
    } catch (err: unknown) {
      sendError(res, API_ERRORS.FAILED_TO_SAVE_SCHEDULE, 500, safeError(err));
    }
  });
}
