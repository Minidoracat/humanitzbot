/**
 * Server discovery routes: SFTP path auto-discovery (async job + polling) and
 * stateless RCON/SFTP connection testing.
 *
 * Behavior-preserving extraction from web-map/server.ts (P1-1 god-file split).
 * Handlers are verbatim; only `this.` -> `ctx.` was applied. The _testRconAuth /
 * _testSftpAuth helpers (formerly closures inside _setupRoutes, used only by
 * test-connection) are co-located here as module-level functions.
 */
import type { Express } from 'express';
import type { WebMapRouteContext } from '../types/route-context.js';
import { requireTier } from '../auth.js';
import { rateLimit } from '../rate-limit.js';
import { API_ERRORS, sendError, sendOk } from '../api-errors.js';
import { safeError } from '../route-helpers.js';
import { _discoveryJobs } from '../discovery-tracker.js';
import { discoverPaths as _discoverPaths } from '../../server/multi-server.js';
import { readPrivateKey } from '../../utils/security.js';
import { errMsg } from '../../utils/error.js';

/** Test RCON auth via raw Source RCON protocol. Resolves { ok, error? }. */
async function _testRconAuth(
  host: string,
  port: number | string,
  password: string,
  timeout = 10000,
): Promise<{ ok: boolean; error?: string }> {
  // Validate host: must be hostname or IP, no URL schemes/paths/spaces
  if (typeof host !== 'string' || !/^[\w.:-]+$/.test(host) || host.includes('://')) {
    return Promise.resolve({ ok: false, error: 'Invalid host format' });
  }
  const numPort = Number(port);
  if (!Number.isInteger(numPort) || numPort < 1 || numPort > 65535) {
    return Promise.resolve({ ok: false, error: 'Invalid port (must be 1-65535)' });
  }
  console.log('[WebMap] RCON test: %s:%d by admin', host, numPort);
  const net = await import('net');
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;
    let buf = Buffer.alloc(0);
    const done = (result: { ok: boolean; error?: string }) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch (cleanupErr: unknown) {
        console.warn('[WebMap] RCON test socket cleanup error:', errMsg(cleanupErr));
      }
      resolve(result);
    };
    const timer = setTimeout(() => {
      done({ ok: false, error: 'Connection timed out' });
    }, timeout);
    socket.connect(port as number, host, () => {
      const passLen = Buffer.byteLength(password, 'utf8');
      const bodyLen = 4 + 4 + passLen + 1 + 1;
      const pkt = Buffer.alloc(4 + bodyLen);
      pkt.writeInt32LE(bodyLen, 0);
      pkt.writeInt32LE(1, 4);
      pkt.writeInt32LE(3, 8); // SERVERDATA_AUTH
      pkt.write(password, 12, 'utf8');
      socket.write(pkt);
    });
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 12) {
        const pktSize = buf.readInt32LE(0);
        if (pktSize < 10 || pktSize > 4096) {
          done({ ok: false, error: 'Invalid RCON response' });
          return;
        }
        if (buf.length < 4 + pktSize) break;
        const id = buf.readInt32LE(4);
        const type = buf.readInt32LE(8);
        buf = buf.subarray(4 + pktSize);
        if (type === 2) {
          done(id === -1 ? { ok: false, error: 'Authentication failed' } : { ok: true });
          return;
        }
      }
    });
    socket.on('error', (err: NodeJS.ErrnoException | null) => {
      done({ ok: false, error: errMsg(err) });
    });
    socket.setTimeout(timeout);
    socket.on('timeout', () => {
      done({ ok: false, error: 'Connection timed out' });
    });
  });
}

/** Test SFTP auth + directory listing. Resolves { ok, error? }. */
async function _testSftpAuth(
  sftpCfg: Record<string, unknown>,
  timeout = 10000,
): Promise<{ ok: boolean; error?: string }> {
  const SftpClient = (await import('ssh2-sftp-client')).default;
  const client = new SftpClient();
  try {
    const opts: Record<string, unknown> = {
      host: sftpCfg.host,
      port: sftpCfg.port || 22,
      username: sftpCfg.user,
      readyTimeout: timeout,
    };
    if (sftpCfg.password) opts.password = sftpCfg.password;
    if (sftpCfg.privateKeyPath) {
      try {
        opts.privateKey = readPrivateKey(sftpCfg.privateKeyPath as string);
      } catch (keyErr: unknown) {
        return { ok: false, error: 'Cannot read private key: ' + errMsg(keyErr) };
      }
    }
    await client.connect(opts);
    await client.list('/');
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: (errMsg(err) || 'Connection failed').substring(0, 200) };
  } finally {
    try {
      await client.end();
    } catch (endErr: unknown) {
      console.warn('[WebMap] SFTP test client cleanup error:', errMsg(endErr));
    }
  }
}

export function registerServersDiscoveryRoutes(app: Express, _ctx: WebMapRouteContext): void {
  /** POST /api/panel/servers/discover — Start SFTP path discovery (202 + polling) */
  app.post('/api/panel/servers/discover', requireTier('admin'), rateLimit(30000, 3), (req, res) => {
    type SftpCfg = {
      host?: string;
      port?: number;
      user?: string;
      password?: string;
      privateKeyPath?: string;
      privateKey?: string;
      passphrase?: string;
    };
    let sftpCfg = (req.body as { sftp?: SftpCfg; useCurrentConfig?: boolean }).sftp;

    // Allow using the server's existing SFTP config (for settings page discover button)
    // Use sftpConnectConfig() to get fully resolved connect options
    // (reads private key from disk, handles passphrase fallback).
    if ((req.body as { useCurrentConfig?: boolean }).useCurrentConfig) {
      let connectOpts;
      try {
        const srvCfg = req.srv.config;
        connectOpts = srvCfg.sftpConnectConfig.call(srvCfg);
      } catch (err: unknown) {
        console.error('[DISCOVER] Failed to build SFTP config:', errMsg(err));
        sendError(res, API_ERRORS.MISSING_SFTP_CONFIG, 400);
        return;
      }
      sftpCfg = {
        host: connectOpts.host,
        port: connectOpts.port || 22,
        user: connectOpts.username,
        password: connectOpts.password,
        privateKey: connectOpts.privateKey as string | undefined,
        passphrase: connectOpts.passphrase,
      };
    }

    if (!sftpCfg || !sftpCfg.host || !sftpCfg.user) {
      sendError(res, API_ERRORS.MISSING_SFTP_CONFIG, 400);
      return;
    }
    if (!sftpCfg.password && !sftpCfg.privateKeyPath && !sftpCfg.privateKey) {
      sendError(res, API_ERRORS.MISSING_SFTP_CONFIG, 400);
      return;
    }

    // Max 3 concurrent jobs
    let activeCount = 0;
    for (const [, job] of _discoveryJobs) {
      if (job.state === 'pending' || job.state === 'running') activeCount++;
    }
    if (activeCount >= 3) {
      sendError(res, API_ERRORS.MAX_CONCURRENT_DISCOVERIES, 429);
      return;
    }

    // Cleanup stale jobs (> 5 min)
    const now = Date.now();
    for (const [jid] of _discoveryJobs) {
      const j = _discoveryJobs.get(jid);
      if (j && now - j.startTime > 300000) _discoveryJobs.delete(jid);
    }

    const jobId = 'disc_' + Date.now().toString(36);
    const job: {
      state: string;
      startTime: number;
      result: unknown;
      error: string | null;
      currentStep: string | null;
    } = { state: 'running', startTime: now, result: null, error: null, currentStep: 'connecting' };
    _discoveryJobs.set(jobId, job);

    // Run discovery in background
    const timeoutHandle = setTimeout(() => {
      if (job.state === 'running') {
        job.state = 'failed';
        job.error = 'Discovery timed out after 120 seconds';
        job.currentStep = null;
      }
    }, 120000);

    _discoverPaths(
      {
        host: sftpCfg.host,
        port: sftpCfg.port || 22,
        user: sftpCfg.user,
        password: sftpCfg.password,
        privateKey: sftpCfg.privateKey,
        privateKeyPath: sftpCfg.privateKeyPath,
        passphrase: sftpCfg.passphrase,
      },
      'WEB_DISCOVER',
    )
      .then((result: unknown) => {
        clearTimeout(timeoutHandle);
        if (job.state !== 'running') return;
        job.state = result ? 'completed' : 'failed';
        job.result = result;
        if (!result) job.error = 'No game files found';
        job.currentStep = null;
      })
      .catch((err: unknown) => {
        clearTimeout(timeoutHandle);
        if (job.state !== 'running') return;
        job.state = 'failed';
        job.error = (errMsg(err) || 'Discovery failed').substring(0, 200);
        job.currentStep = null;
      });

    res.status(202).json({ ok: true, jobId });
  });
  /** GET /api/panel/servers/discover/:jobId — Poll discovery job status */

  app.get('/api/panel/servers/discover/:jobId', requireTier('admin'), rateLimit(5000, 20), (req, res) => {
    const job = _discoveryJobs.get(req.params.jobId as string);
    if (!job) {
      sendError(res, API_ERRORS.DISCOVERY_JOB_NOT_FOUND, 404);
      return;
    }
    sendOk(res, {
      state: job.state,
      elapsed: Date.now() - job.startTime,
      ...(job.currentStep ? { currentStep: job.currentStep } : {}),
      ...(job.result ? { result: job.result } : {}),
      ...(job.error ? { error: job.error } : {}),
    });
  });
  /** POST /api/panel/servers/test-connection — Stateless connection validation */
  app.post('/api/panel/servers/test-connection', requireTier('admin'), rateLimit(10000, 5), async (req, res) => {
    try {
      const bodyConn = (req.body ?? {}) as {
        rcon?: { host: string; port: number; password: string };
        sftp?: Record<string, unknown>;
      };
      const rconCfg = bodyConn.rcon;
      const sftpCfg = bodyConn.sftp;
      if (!rconCfg && !sftpCfg) {
        sendError(res, API_ERRORS.MISSING_CONNECTION_CONFIG, 400);
        return;
      }

      const result: Record<string, unknown> = {};
      const promises: Promise<void>[] = [];

      if (rconCfg) {
        promises.push(
          _testRconAuth(rconCfg.host, rconCfg.port || 27015, rconCfg.password || '', 10000).then((r) => {
            result.rcon = r;
          }),
        );
      }
      if (sftpCfg) {
        promises.push(
          _testSftpAuth(sftpCfg, 10000).then((r) => {
            result.sftp = r;
          }),
        );
      }

      await Promise.all(promises);
      sendOk(res, result);
    } catch (err: unknown) {
      sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
    }
  });
}
