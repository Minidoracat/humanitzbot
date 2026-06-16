/**
 * Backups + game-server settings routes: list backups (Pterodactyl panel API
 * with local directory fallback), read/write game-server settings via SFTP, and
 * the settings-schema category definitions.
 *
 * Behavior-preserving extraction from web-map/server.ts (P1-1 god-file split).
 * Handlers are verbatim; only `this.` -> `ctx.` was applied. The HIDDEN_SETTINGS
 * set and filterSettings helper (formerly locals inside _setupRoutes, used only
 * by the settings routes) are co-located here as module-level definitions.
 */
import type { Express } from 'express';
import type { WebMapRouteContext } from '../types/route-context.js';
import path from 'path';
import fs from 'fs';
import { requireTier } from '../auth.js';
import { rateLimit } from '../rate-limit.js';
import { API_ERRORS, sendError } from '../api-errors.js';
import { safeError } from '../route-helpers.js';
import { GAME_SETTINGS_CATEGORIES } from '../../modules/panel-constants.js';

// Sensitive keys that should never be exposed or written via API
const HIDDEN_SETTINGS = new Set(['AdminPass', 'RCONPass', 'Password', 'RConPort', 'RCONEnabled']);
function filterSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(settings)) {
    if (!HIDDEN_SETTINGS.has(k) && !k.startsWith('_')) filtered[k] = v;
  }
  return filtered;
}

export function registerBackupsSettingsRoutes(app: Express, _ctx: WebMapRouteContext): void {
  // ── Panel: List backups ──
  app.get('/api/panel/backups', requireTier('admin'), rateLimit(10000, 5), async (req, res) => {
    const backups = [];

    // Try Pterodactyl API first (per-server or primary singleton)
    try {
      const srvPanelApi = req.srv.panelApi;
      if (srvPanelApi && srvPanelApi.available) {
        const list = await srvPanelApi.listBackups();
        if (list.length) {
          for (const b of list) {
            backups.push({
              name: b.name || b.uuid,
              uuid: b.uuid,
              size: b.bytes || 0,
              created: b.created_at || b.completed_at,
              source: 'panel',
            });
          }
          return res.json({ backups });
        }
      }
    } catch (_e) {
      /* panel API unavailable — fall through */
    }

    // Fall back to local data/backups/ directory
    const backupsDir = path.join(req.srv.dataDir, 'backups');
    try {
      if (fs.existsSync(backupsDir)) {
        const entries = fs.readdirSync(backupsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const stat = fs.statSync(path.join(backupsDir, entry.name));
          backups.push({
            name: entry.name,
            uuid: entry.name,
            size: 0,
            created: stat.mtime.toISOString(),
            source: 'local',
          });
        }
        backups.sort(
          (a: Record<string, unknown>, b: Record<string, unknown>) =>
            new Date(b.created as string).getTime() - new Date(a.created as string).getTime(),
        );
      }
    } catch (_e) {
      /* directory not readable */
    }

    res.json({ backups });
  });
  // ── Panel: Game server settings (read) ──
  app.get('/api/panel/settings', requireTier('admin'), async (req, res) => {
    const srv = req.srv;
    // Try loading from cached file first
    const settingsFile = path.join(srv.dataDir, 'server-settings.json');
    try {
      if (fs.existsSync(settingsFile)) {
        const data = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, unknown>;
        return res.json({ settings: filterSettings(data) });
      }
    } catch {
      /* fall through to SFTP */
    }

    // Try reading via SFTP
    if (srv.config.sftpHost && srv.config.sftpUser) {
      try {
        const SftpClient = (await import('ssh2-sftp-client')).default;
        const sftp = new SftpClient();
        await sftp.connect(srv.config.sftpConnectConfig());
        const content = await sftp.get(srv.config.sftpSettingsPath);
        await sftp.end();

        const settings: Record<string, string> = {};
        const lines = (content as Buffer).toString().split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[') || trimmed.startsWith(';')) continue;
          const eq = trimmed.indexOf('=');
          if (eq > 0) {
            settings[trimmed.substring(0, eq).trim()] = trimmed.substring(eq + 1).trim();
          }
        }
        // Cache for next time
        fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
        res.json({ settings: filterSettings(settings) });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.FAILED_TO_READ_SETTINGS, 500, safeError(err));
      }
    } else {
      sendError(res, API_ERRORS.NO_SETTINGS_AVAILABLE_SFTP_NOT_CONFIGURED, 404);
    }
  });

  // ── Panel: Game server settings (write) ──
  app.post('/api/panel/settings', requireTier('admin'), rateLimit(30000, 5), async (req, res) => {
    const { settings } = req.body as { settings?: Record<string, unknown> };
    if (!settings || typeof settings !== 'object') {
      sendError(res, API_ERRORS.MISSING_SETTINGS_OBJECT, 400);
      return;
    }

    // Block writes to sensitive keys — same set filtered on read, enforced on write
    const rejected = Object.keys(settings).filter((k) => HIDDEN_SETTINGS.has(k) || k.startsWith('_'));
    if (rejected.length > 0) {
      sendError(res, API_ERRORS.CANNOT_WRITE_PROTECTED_SETTINGS, 403, rejected.join(', '));
      return;
    }
    // Validate values: no newlines, no INI section injection
    for (const [key, value] of Object.entries(settings)) {
      const v = String(value);
      if (/[\r\n]/.test(v) || /^\[/.test(v.trim())) {
        sendError(res, API_ERRORS.INVALID_VALUE_CONTAINS_ILLEGAL_CHARACTERS, 400, key);
        return;
      }
    }

    if (!req.srv.config.sftpHost || !req.srv.config.sftpUser) {
      sendError(res, API_ERRORS.SFTP_NOT_CONFIGURED, 400);
      return;
    }

    try {
      const SftpClient = (await import('ssh2-sftp-client')).default;
      const sftp = new SftpClient();
      await sftp.connect(req.srv.config.sftpConnectConfig());

      // Read current file
      const content = ((await sftp.get(req.srv.config.sftpSettingsPath)) as Buffer).toString();
      const lines = content.split('\n');

      // Update values in-place
      const updated = new Set();
      const newLines = lines.map((line: string) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[') || trimmed.startsWith(';')) return line;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) return line;
        const key = trimmed.substring(0, eq).trim();
        if (key in settings) {
          updated.add(key);
          return `${key}=${String(settings[key])}`;
        }
        return line;
      });

      // Write back
      await sftp.put(Buffer.from(newLines.join('\n')), req.srv.config.sftpSettingsPath);
      await sftp.end();

      // Update local cache
      const settingsFile = path.join(req.srv.dataDir, 'server-settings.json');
      try {
        let cached: Record<string, string> = {};
        if (fs.existsSync(settingsFile))
          cached = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, string>;
        Object.assign(cached, settings);
        fs.writeFileSync(settingsFile, JSON.stringify(cached, null, 2));
      } catch {
        /* cache update failed, not critical */
      }

      res.json({ ok: true, updated: [...updated] });
    } catch (err: unknown) {
      sendError(res, API_ERRORS.FAILED_TO_SAVE_SETTINGS, 500, safeError(err));
    }
  });
  // ── Panel: Settings Schema ──
  /** GET /api/panel/settings-schema — Return game settings category definitions */

  app.get('/api/panel/settings-schema', requireTier('admin'), (_req, res) => {
    res.json({ categories: GAME_SETTINGS_CATEGORIES });
  });
}
