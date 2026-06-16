/**
 * Welcome-file editor routes: read the current server welcome file (via SFTP
 * with config fallback) and save/upload edited content.
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
import { sendError, sendOk } from '../api-errors.js';
import { safeError } from '../route-helpers.js';
import { errMsg } from '../../utils/error.js';

const __dirname = path.join(getDirname(import.meta.url), '..');

export function registerWelcomeFileRoutes(app: Express, ctx: WebMapRouteContext): void {
  // ══════════════════════════════════════════════════════════════════
  //  Welcome File Editor
  // ══════════════════════════════════════════════════════════════════

  /** GET /api/panel/welcome-file — read current welcome file from SFTP (fallback to config) */
  app.get('/api/panel/welcome-file', requireTier('admin'), rateLimit(10000, 10), async (req, res) => {
    const placeholders = [
      '{server_name}',
      '{day}',
      '{season}',
      '{weather}',
      '{pvp_schedule}',
      '{discord_link}',
      '{discord}',
    ];
    try {
      // Try reading the actual file from the game server via SFTP
      const welcomePath = req.srv.config.sftpWelcomePath;
      if (welcomePath) {
        const SftpClient = (await import('ssh2-sftp-client')).default;
        const sftp = new SftpClient();
        try {
          await sftp.connect(req.srv.config.sftpConnectConfig());
          const buf = (await sftp.get(welcomePath)) as Buffer;
          const content = buf.toString('utf8');
          sendOk(res, { content, placeholders, source: 'sftp' });
          return;
        } catch (sftpErr: unknown) {
          console.warn('[WelcomeFile] SFTP read failed, falling back to config:', errMsg(sftpErr));
        } finally {
          await sftp.end().catch(() => {});
        }
      }

      // Fallback: read from config (pipe-separated lines → newline-separated)
      const lines = (req.srv.config.welcomeFileLines as string[] | undefined) ?? [];
      const content = Array.isArray(lines) ? lines.join('\n') : String(lines);
      sendOk(res, { content, placeholders, source: content ? 'config' : 'empty' });
      return;
    } catch (err: unknown) {
      sendError(res, 'WELCOME_FILE_READ_FAILED', 500, safeError(err));
      return;
    }
  });

  /** POST /api/panel/welcome-file — save welcome file content + trigger SFTP upload */
  app.post('/api/panel/welcome-file', requireTier('admin'), rateLimit(30000, 3), async (req, res) => {
    try {
      const { content } = req.body as { content?: unknown };
      if (typeof content !== 'string') {
        sendError(res, 'INVALID_CONTENT', 400);
        return;
      }
      if (content.length > 10000) {
        sendError(res, 'CONTENT_TOO_LARGE', 400);
        return;
      }

      // Convert newlines to pipe-separated array
      const lines = content.split('\n');

      // Save to config
      const config = req.srv.config;
      config.welcomeFileLines = lines;

      if (ctx._configRepo) {
        ctx._configRepo.update('app', { welcomeFileLines: lines });
      } else {
        // Legacy .env fallback
        const envPath = path.join(__dirname, '..', '..', '.env');
        if (fs.existsSync(envPath)) {
          const envContent = fs.readFileSync(envPath, 'utf8');
          const envLines = envContent.split('\n');
          const pipeValue = lines.join('|');
          const hasKey = envLines.some((l: string) => l.startsWith('WELCOME_FILE_LINES='));
          const newEnvLines = envLines.map((l: string) => {
            if (l.startsWith('WELCOME_FILE_LINES=')) {
              return `WELCOME_FILE_LINES=${pipeValue}`;
            }
            return l;
          });
          if (!hasKey) newEnvLines.push(`WELCOME_FILE_LINES=${pipeValue}`);
          fs.writeFileSync(envPath, newEnvLines.join('\n'));
        }
      }

      // Upload directly via SFTP
      const welcomePath = config.sftpWelcomePath;
      if (welcomePath) {
        try {
          const SftpClient = (await import('ssh2-sftp-client')).default;
          const sftp = new SftpClient();
          await sftp.connect(config.sftpConnectConfig());
          await sftp.put(Buffer.from(content, 'utf8'), welcomePath);
          await sftp.end().catch(() => {});
          console.log('[WelcomeFile] Uploaded WelcomeMessage.txt via panel editor');
        } catch (sftpErr: unknown) {
          console.error('[WelcomeFile] SFTP upload failed:', errMsg(sftpErr));
          sendOk(res, {
            message: 'Welcome file saved to config but SFTP upload failed: ' + errMsg(sftpErr),
            lineCount: lines.length,
            uploaded: false,
          });
          return;
        }
      }
      sendOk(res, {
        message: welcomePath
          ? 'Welcome file saved and uploaded'
          : 'Welcome file saved to config (no SFTP path configured)',
        lineCount: lines.length,
        uploaded: !!welcomePath,
      });
      return;
    } catch (err: unknown) {
      sendError(res, 'WELCOME_FILE_SAVE_FAILED', 500, safeError(err));
      return;
    }
  });
}
