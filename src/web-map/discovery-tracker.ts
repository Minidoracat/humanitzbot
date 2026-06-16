/**
 * Process-global tracking for multi-server SFTP auto-discovery jobs.
 *
 * Extracted verbatim from web-map/server.ts (P1-1 god-file split). This MUST
 * stay a single shared instance: the `POST /servers/discover` handler writes
 * job state here and `GET /servers/discover/:jobId` reads it back. Duplicating
 * the Map would silently break discovery polling.
 */

// ── Discovery job tracking (multi-server SFTP auto-discovery) ──
export const _discoveryJobs = new Map<
  string,
  { startTime: number; state?: string; result?: unknown; error?: string | null; currentStep?: string | null }
>();
setInterval(() => {
  const now = Date.now();
  for (const [jid, job] of _discoveryJobs) {
    if (now - job.startTime > 300000) _discoveryJobs.delete(jid);
  }
}, 300000).unref();
