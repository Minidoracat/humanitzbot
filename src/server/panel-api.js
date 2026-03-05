/**
 * Pterodactyl Panel API client.
 *
 * Optional module — only active when PANEL_SERVER_URL + PANEL_API_KEY are set.
 * Works with any Pterodactyl-based host (BisectHosting, Bloom.host, etc.).
 *
 * Provides:
 *   - Server resources (CPU, RAM, disk, uptime, state)
 *   - Power management (start, stop, restart, kill)
 *   - Console commands (fire-and-forget)
 *   - Backup management (list, create, delete, download URL)
 *   - File access (read, write, list)
 *   - Server details (name, limits, allocations)
 *
 * Exports a singleton. All methods return null/throw when panel is not configured.
 */

const config = require('../config');

// ── URL parsing ─────────────────────────────────────────────
// PANEL_SERVER_URL is the full browser URL, e.g.:
//   https://games.bisecthosting.com/server/a1b2c3d4
// We extract the API base URL and server identifier from it.

let _baseUrl = null;   // https://games.bisecthosting.com
let _serverId = null;  // a1b2c3d4

function _parseServerUrl() {
  if (_baseUrl !== null) return; // already parsed

  const raw = (config.panelServerUrl || '').replace(/\/+$/, '');
  if (!raw) return;

  const lastSlash = raw.lastIndexOf('/');
  if (lastSlash <= 0) return;

  _serverId = raw.substring(lastSlash + 1);
  // Go up one more level to strip "/server" from the URL
  const parentSlash = raw.lastIndexOf('/', lastSlash - 1);
  _baseUrl = parentSlash > 0 ? raw.substring(0, parentSlash) : raw.substring(0, lastSlash);
}

// ── Core fetch wrapper ──────────────────────────────────────

/**
 * Make an authenticated request to the Pterodactyl client API.
 * @param {string} endpoint - Path after /api/client/servers/{id}/ (or absolute if starting with /)
 * @param {object} [options] - fetch options override
 * @returns {Promise<object|null>} Parsed JSON body, or null for 204/empty responses
 */
async function _request(endpoint, options = {}) {
  _parseServerUrl();
  if (!_baseUrl || !_serverId || !config.panelApiKey) {
    throw new Error('Panel API not configured (PANEL_SERVER_URL + PANEL_API_KEY required)');
  }

  const path = endpoint.startsWith('/')
    ? endpoint
    : `/api/client/servers/${_serverId}/${endpoint}`;

  const url = `${_baseUrl}${path}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.panelApiKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Panel API ${res.status} ${res.statusText}: ${body.substring(0, 200)}`);
  }

  // 204 No Content (e.g. power, command)
  if (res.status === 204) return null;

  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text);
}

// ── Resource monitoring ─────────────────────────────────────

/**
 * Get current server resource usage + power state.
 * @returns {Promise<{cpu: number, memUsed: number, memTotal: number, memPercent: number,
 *           diskUsed: number, diskTotal: number, diskPercent: number, uptime: number,
 *           state: string}>}
 */
async function getResources() {
  const data = await _request('resources');
  const attrs = data?.attributes || data || {};
  const r = attrs.resources || attrs;

  return {
    cpu: r.cpu_absolute != null ? Math.round(r.cpu_absolute * 10) / 10 : null,
    memUsed: r.memory_bytes ?? null,
    memTotal: r.memory_limit_bytes ?? null,
    memPercent: (r.memory_bytes != null && r.memory_limit_bytes > 0)
      ? Math.round((r.memory_bytes / r.memory_limit_bytes) * 1000) / 10
      : null,
    diskUsed: r.disk_bytes ?? null,
    diskTotal: r.disk_limit_bytes ?? null,
    diskPercent: (r.disk_bytes != null && r.disk_limit_bytes > 0)
      ? Math.round((r.disk_bytes / r.disk_limit_bytes) * 1000) / 10
      : null,
    uptime: r.uptime != null ? Math.floor(r.uptime / 1000) : null, // ms → s
    state: attrs.current_state || null,  // running, starting, stopping, offline
  };
}

// ── Power management ────────────────────────────────────────

/**
 * Send a power signal to the server.
 * @param {'start'|'stop'|'restart'|'kill'} signal
 */
async function sendPowerAction(signal) {
  const valid = ['start', 'stop', 'restart', 'kill'];
  if (!valid.includes(signal)) throw new Error(`Invalid power signal: ${signal}`);
  await _request('power', {
    method: 'POST',
    body: JSON.stringify({ signal }),
  });
}

// ── Console command ─────────────────────────────────────────

/**
 * Send a console command via the panel API. Fire-and-forget — no response body.
 * For commands that need a response, use RCON instead.
 * @param {string} command
 */
async function sendCommand(command) {
  await _request('command', {
    method: 'POST',
    body: JSON.stringify({ command }),
  });
}

// ── Server details ──────────────────────────────────────────

/**
 * Get server details (name, description, limits, allocations, etc.)
 * @returns {Promise<object>}
 */
async function getServerDetails() {
  _parseServerUrl();
  const data = await _request(`/api/client/servers/${_serverId}`);
  return data?.attributes || data || {};
}

// ── Backups ─────────────────────────────────────────────────

/**
 * List all backups for this server.
 * @returns {Promise<Array<{uuid: string, name: string, bytes: number, created_at: string,
 *           completed_at: string, is_successful: boolean, is_locked: boolean}>>}
 */
async function listBackups() {
  const data = await _request('backups');
  const items = data?.data || [];
  return items.map(b => {
    const a = b.attributes || b;
    return {
      uuid: a.uuid,
      name: a.name,
      bytes: a.bytes || 0,
      created_at: a.created_at,
      completed_at: a.completed_at,
      is_successful: a.is_successful ?? true,
      is_locked: a.is_locked ?? false,
    };
  });
}

/**
 * Create a new backup.
 * @param {string} [name] - Backup name (auto-generated if empty)
 * @returns {Promise<object>} Created backup attributes
 */
async function createBackup(name) {
  const data = await _request('backups', {
    method: 'POST',
    body: JSON.stringify({ name: name || '' }),
  });
  return data?.attributes || data || {};
}

/**
 * Delete a backup by UUID.
 * @param {string} uuid
 */
async function deleteBackup(uuid) {
  await _request(`backups/${uuid}`, { method: 'DELETE' });
}

/**
 * Get the download URL for a backup.
 * @param {string} uuid
 * @returns {Promise<string>} Signed download URL
 */
async function getBackupDownloadUrl(uuid) {
  const data = await _request(`backups/${uuid}/download`);
  return data?.attributes?.url || null;
}

// ── File management ─────────────────────────────────────────

/**
 * List files in a directory.
 * @param {string} [dir='/'] - Directory path
 * @returns {Promise<Array<{name: string, mode: string, size: number, is_file: boolean, modified_at: string}>>}
 */
async function listFiles(dir = '/') {
  const data = await _request(`files/list?directory=${encodeURIComponent(dir)}`);
  const items = data?.data || [];
  return items.map(f => {
    const a = f.attributes || f;
    return {
      name: a.name,
      mode: a.mode,
      size: a.size || 0,
      is_file: a.is_file ?? true,
      modified_at: a.modified_at,
    };
  });
}

/**
 * Read the contents of a file.
 * @param {string} filePath - Absolute path on the server (e.g. /HumanitZServer/GameServerSettings.ini)
 * @returns {Promise<string>} File contents as text
 */
async function readFile(filePath) {
  _parseServerUrl();
  if (!_baseUrl || !_serverId || !config.panelApiKey) {
    throw new Error('Panel API not configured');
  }

  // Try files/contents first (fast, text-based)
  const url = `${_baseUrl}/api/client/servers/${_serverId}/files/contents?file=${encodeURIComponent(filePath)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${config.panelApiKey}`,
      Accept: 'text/plain',
    },
  });

  if (res.ok) return res.text();

  // Some hosts disable files/contents (405) — fall back to signed download URL
  if (res.status === 405 || res.status === 403) {
    const buf = await downloadFile(filePath);
    return buf.toString('utf-8');
  }

  throw new Error(`Panel file read ${res.status}: ${res.statusText}`);
}

/**
 * Write content to a file on the server.
 * @param {string} filePath - Absolute path on the server
 * @param {string} content - File contents to write
 */
async function writeFile(filePath, content) {
  _parseServerUrl();
  if (!_baseUrl || !_serverId || !config.panelApiKey) {
    throw new Error('Panel API not configured');
  }

  const url = `${_baseUrl}/api/client/servers/${_serverId}/files/write?file=${encodeURIComponent(filePath)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.panelApiKey}`,
      'Content-Type': 'text/plain',
    },
    body: content,
  });

  if (!res.ok) {
    throw new Error(`Panel file write ${res.status}: ${res.statusText}`);
  }
}

// ── File download ───────────────────────────────────────────

/**
 * Get a signed download URL for a file.
 * The URL is temporary and can be used with a simple HTTP GET (no auth header needed).
 * @param {string} filePath - Absolute path on the server (e.g. /HumanitZServer/Saved/SaveGames/SaveList/Default/Save_DedicatedSaveMP.sav)
 * @returns {Promise<string>} Signed download URL
 */
async function getFileDownloadUrl(filePath) {
  const data = await _request(`files/download?file=${encodeURIComponent(filePath)}`);
  return data?.attributes?.url || null;
}

/**
 * Download a file as a Buffer.
 * Uses the Panel API to get a signed URL, then fetches the file content.
 * Ideal for binary files like save files where readFile() (text-based) won't work.
 * @param {string} filePath - Absolute path on the server
 * @returns {Promise<Buffer>} File contents as a Buffer
 */
async function downloadFile(filePath) {
  const url = await getFileDownloadUrl(filePath);
  if (!url) throw new Error(`No download URL returned for: ${filePath}`);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`File download failed ${res.status}: ${res.statusText}`);
  }

  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

// ── WebSocket auth ──────────────────────────────────────────

/**
 * Get WebSocket credentials for real-time console/stats.
 * @returns {Promise<{token: string, socket: string}>}
 */
async function getWebsocketAuth() {
  const data = await _request('websocket');
  return data?.data || {};
}

// ── Schedules ───────────────────────────────────────────────

/**
 * List all schedules for this server.
 * @returns {Promise<Array>}
 */
async function listSchedules() {
  const data = await _request('schedules');
  const items = data?.data || [];
  return items.map(s => s.attributes || s);
}

/**
 * Create a new schedule.
 * @param {object} params - { name, minute, hour, day_of_week, day_of_month, month, is_active, only_when_online }
 * @returns {Promise<object>} Created schedule
 */
async function createSchedule(params) {
  const data = await _request('schedules', {
    method: 'POST',
    body: JSON.stringify(params),
  });
  return data?.attributes || data || {};
}

/**
 * Delete a schedule by ID.
 * @param {number} scheduleId
 */
async function deleteSchedule(scheduleId) {
  await _request(`schedules/${scheduleId}`, { method: 'DELETE' });
}

// ── Network allocations ─────────────────────────────────────

/**
 * List all network allocations for this server.
 * Returns IPs and ports assigned to the server (primary + additional).
 * @returns {Promise<Array<{id: number, ip: string, ip_alias: string|null, port: number, is_default: boolean}>>}
 */
async function listAllocations() {
  const data = await _request('network/allocations');
  const items = data?.data || [];
  return items.map(a => {
    const attrs = a.attributes || a;
    return {
      id: attrs.id,
      ip: attrs.ip || '',
      ip_alias: attrs.ip_alias || null,
      port: attrs.port || 0,
      is_default: attrs.is_default ?? false,
    };
  });
}

// ── List all servers ────────────────────────────────────────

/**
 * List all servers accessible with this API key.
 * Uses the /api/client endpoint (no server ID needed).
 * Useful for auto-discovery — find game server + bot server from a single API key.
 * @returns {Promise<Array<{identifier: string, uuid: string, name: string, description: string, node: string,
 *           sftp_details: {ip: string, port: number}, allocations: Array}>>}
 */
async function listServers() {
  _parseServerUrl();
  if (!_baseUrl || !config.panelApiKey) {
    throw new Error('Panel API not configured (PANEL_SERVER_URL + PANEL_API_KEY required)');
  }

  const allServers = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const url = `${_baseUrl}/api/client?page=${page}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${config.panelApiKey}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Panel API ${res.status} ${res.statusText}: ${body.substring(0, 200)}`);
    }
    const data = await res.json();
    const items = data?.data || [];
    for (const item of items) {
      const a = item.attributes || item;
      allServers.push({
        identifier: a.identifier || '',
        uuid: a.uuid || '',
        name: a.name || '',
        description: a.description || '',
        node: a.node || '',
        sftp_details: a.sftp_details || {},
        allocations: (a.relationships?.allocations?.data || []).map(al => {
          const attrs = al.attributes || al;
          return {
            id: attrs.id, ip: attrs.ip || '', ip_alias: attrs.ip_alias || null,
            port: attrs.port || 0, is_default: attrs.is_default ?? false,
          };
        }),
        egg: a.egg || 0,
        docker_image: a.docker_image || '',
        limits: a.limits || {},
      });
    }
    totalPages = data?.meta?.pagination?.total_pages || 1;
    page++;
  }

  return allServers;
}

// ── Startup variables ───────────────────────────────────────

/**
 * List all startup variables for this server.
 * Pterodactyl returns env vars like SERVER_NAME, MAX_PLAYERS, RCON_PASSWORD, etc.
 * @returns {Promise<Array<{env_variable: string, server_value: string, default_value: string, name: string, description: string}>>}
 */
async function getStartupVariables() {
  const data = await _request('startup');
  const items = data?.data || [];
  return items.map(v => {
    const a = v.attributes || v;
    return {
      env_variable: a.env_variable,
      server_value: a.server_value ?? a.default_value ?? '',
      default_value: a.default_value ?? '',
      name: a.name || a.env_variable || '',
      description: a.description || '',
    };
  });
}

/**
 * Update a startup variable (e.g. SERVER_NAME, MAX_PLAYERS).
 * Bisect/Pterodactyl passes these as command-line args, overriding INI values.
 * @param {string} key - Environment variable name (e.g. 'SERVER_NAME')
 * @param {string} value - New value
 * @returns {Promise<object>} Updated variable attributes
 */
async function updateStartupVariable(key, value) {
  const data = await _request('startup/variable', {
    method: 'PUT',
    body: JSON.stringify({ key, value }),
  });
  return data?.attributes || data || {};
}

// ── Singleton class ─────────────────────────────────────────

class PanelApi {
  constructor() {
    this._available = null; // lazy-checked
  }

  /** Whether the panel API is configured and the module can be used. */
  get available() {
    if (this._available === null) {
      _parseServerUrl();
      this._available = !!(_baseUrl && _serverId && config.panelApiKey);
    }
    return this._available;
  }

  /** @returns {'pterodactyl'|null} */
  get backend() {
    return this.available ? 'pterodactyl' : null;
  }

  // Expose all methods
  getResources = getResources;
  sendPowerAction = sendPowerAction;
  sendCommand = sendCommand;
  getServerDetails = getServerDetails;
  listBackups = listBackups;
  createBackup = createBackup;
  deleteBackup = deleteBackup;
  getBackupDownloadUrl = getBackupDownloadUrl;
  getFileDownloadUrl = getFileDownloadUrl;
  downloadFile = downloadFile;
  listFiles = listFiles;
  readFile = readFile;
  writeFile = writeFile;
  getWebsocketAuth = getWebsocketAuth;
  listSchedules = listSchedules;
  createSchedule = createSchedule;
  deleteSchedule = deleteSchedule;
  updateStartupVariable = updateStartupVariable;
  getStartupVariables = getStartupVariables;
  listAllocations = listAllocations;
  listServers = listServers;
}

// ── Per-server instance factory ─────────────────────────────

/**
 * Create a standalone PanelApi instance for a specific server.
 * Used by multi-server to give each managed server its own panel credentials.
 *
 * Unlike the singleton (which reads from module-level globals / primary config),
 * this creates a fully isolated instance with its own URL, server ID, and API key.
 *
 * @param {object} options
 * @param {string} options.serverUrl - Full panel URL (e.g. https://games.bisecthosting.com/server/a1b2c3d4)
 * @param {string} options.apiKey    - Panel API key
 * @returns {PanelApi} Standalone instance
 */
function createPanelApi({ serverUrl, apiKey }) {
  if (!serverUrl || !apiKey) return null;

  // Parse URL to extract base + serverId
  const raw = serverUrl.replace(/\/+$/, '');
  const lastSlash = raw.lastIndexOf('/');
  if (lastSlash <= 0) return null;

  const serverId = raw.substring(lastSlash + 1);
  const parentSlash = raw.lastIndexOf('/', lastSlash - 1);
  const baseUrl = parentSlash > 0 ? raw.substring(0, parentSlash) : raw.substring(0, lastSlash);

  if (!baseUrl || !serverId) return null;

  // Create a private _request scoped to this server's credentials
  async function _scopedRequest(endpoint, options = {}) {
    const path = endpoint.startsWith('/')
      ? endpoint
      : `/api/client/servers/${serverId}/${endpoint}`;

    const url = `${baseUrl}${path}`;

    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Panel API ${res.status} ${res.statusText}: ${body.substring(0, 200)}`);
    }

    if (res.status === 204) return null;

    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text);
  }

  // Build a scoped instance — each method uses _scopedRequest
  const api = new PanelApi();
  api._available = true;

  // Override every method to use scoped request
  api.getResources = async function () {
    const data = await _scopedRequest('resources');
    return getResources._parseResponse ? getResources._parseResponse(data) : (() => {
      const attrs = data?.attributes || data || {};
      const r = attrs.resources || attrs;
      return {
        cpu: r.cpu_absolute != null ? Math.round(r.cpu_absolute * 10) / 10 : null,
        memUsed: r.memory_bytes ?? null,
        memTotal: r.memory_limit_bytes ?? null,
        memPercent: (r.memory_bytes != null && r.memory_limit_bytes > 0)
          ? Math.round((r.memory_bytes / r.memory_limit_bytes) * 1000) / 10 : null,
        diskUsed: r.disk_bytes ?? null,
        diskTotal: r.disk_limit_bytes ?? null,
        diskPercent: (r.disk_bytes != null && r.disk_limit_bytes > 0)
          ? Math.round((r.disk_bytes / r.disk_limit_bytes) * 1000) / 10 : null,
        uptime: r.uptime != null ? Math.floor(r.uptime / 1000) : null,
        state: attrs.current_state || null,
      };
    })();
  };

  api.sendPowerAction = async function (signal) {
    const valid = ['start', 'stop', 'restart', 'kill'];
    if (!valid.includes(signal)) throw new Error(`Invalid power signal: ${signal}`);
    await _scopedRequest('power', { method: 'POST', body: JSON.stringify({ signal }) });
  };

  api.sendCommand = async function (command) {
    await _scopedRequest('command', { method: 'POST', body: JSON.stringify({ command }) });
  };

  api.getServerDetails = async function () {
    const data = await _scopedRequest(`/api/client/servers/${serverId}`);
    return data?.attributes || data || {};
  };

  api.listBackups = async function () {
    const data = await _scopedRequest('backups');
    const items = data?.data || [];
    return items.map(b => {
      const a = b.attributes || b;
      return {
        uuid: a.uuid, name: a.name, bytes: a.bytes || 0,
        created_at: a.created_at, completed_at: a.completed_at,
        is_successful: a.is_successful ?? true, is_locked: a.is_locked ?? false,
      };
    });
  };

  api.createBackup = async function (name) {
    const data = await _scopedRequest('backups', {
      method: 'POST', body: JSON.stringify({ name: name || '' }),
    });
    return data?.attributes || data || {};
  };

  api.deleteBackup = async function (uuid) {
    await _scopedRequest(`backups/${uuid}`, { method: 'DELETE' });
  };

  api.getBackupDownloadUrl = async function (uuid) {
    const data = await _scopedRequest(`backups/${uuid}/download`);
    return data?.attributes?.url || null;
  };

  api.getFileDownloadUrl = async function (filePath) {
    const data = await _scopedRequest(`files/download?file=${encodeURIComponent(filePath)}`);
    return data?.attributes?.url || null;
  };

  api.downloadFile = async function (filePath) {
    const url = await api.getFileDownloadUrl(filePath);
    if (!url) throw new Error(`No download URL returned for: ${filePath}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`File download failed ${res.status}: ${res.statusText}`);
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  };

  api.listFiles = async function (dir = '/') {
    const data = await _scopedRequest(`files/list?directory=${encodeURIComponent(dir)}`);
    const items = data?.data || [];
    return items.map(f => {
      const a = f.attributes || f;
      return {
        name: a.name, mode: a.mode, size: a.size || 0,
        is_file: a.is_file ?? true, modified_at: a.modified_at,
      };
    });
  };

  api.readFile = async function (filePath) {
    // Try files/contents first (fast, text-based)
    const url = `${baseUrl}/api/client/servers/${serverId}/files/contents?file=${encodeURIComponent(filePath)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'text/plain' },
    });
    if (res.ok) return res.text();

    // Some hosts disable files/contents (405) — fall back to signed download URL
    if (res.status === 405 || res.status === 403) {
      const buf = await api.downloadFile(filePath);
      return buf.toString('utf-8');
    }

    throw new Error(`Panel file read ${res.status}: ${res.statusText}`);
  };

  api.writeFile = async function (filePath, content) {
    const url = `${baseUrl}/api/client/servers/${serverId}/files/write?file=${encodeURIComponent(filePath)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'text/plain' },
      body: content,
    });
    if (!res.ok) throw new Error(`Panel file write ${res.status}: ${res.statusText}`);
  };

  api.getWebsocketAuth = async function () {
    const data = await _scopedRequest('websocket');
    return data?.data || {};
  };

  api.listSchedules = async function () {
    const data = await _scopedRequest('schedules');
    const items = data?.data || [];
    return items.map(s => s.attributes || s);
  };

  api.createSchedule = async function (params) {
    const data = await _scopedRequest('schedules', {
      method: 'POST', body: JSON.stringify(params),
    });
    return data?.attributes || data || {};
  };

  api.deleteSchedule = async function (scheduleId) {
    await _scopedRequest(`schedules/${scheduleId}`, { method: 'DELETE' });
  };

  api.getStartupVariables = async function () {
    const data = await _scopedRequest('startup');
    const items = data?.data || [];
    return items.map(v => {
      const a = v.attributes || v;
      return {
        env_variable: a.env_variable,
        server_value: a.server_value ?? a.default_value ?? '',
        default_value: a.default_value ?? '',
        name: a.name || a.env_variable || '',
        description: a.description || '',
      };
    });
  };

  api.updateStartupVariable = async function (key, value) {
    const data = await _scopedRequest('startup/variable', {
      method: 'PUT', body: JSON.stringify({ key, value }),
    });
    return data?.attributes || data || {};
  };

  api.listAllocations = async function () {
    const data = await _scopedRequest('network/allocations');
    const items = data?.data || [];
    return items.map(a => {
      const attrs = a.attributes || a;
      return {
        id: attrs.id, ip: attrs.ip || '', ip_alias: attrs.ip_alias || null,
        port: attrs.port || 0, is_default: attrs.is_default ?? false,
      };
    });
  };

  api.listServers = async function () {
    const allServers = [];
    let page = 1;
    let totalPages = 1;
    while (page <= totalPages) {
      const url = `${baseUrl}/api/client?page=${page}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Panel API ${res.status} ${res.statusText}: ${body.substring(0, 200)}`);
      }
      const data = await res.json();
      const items = data?.data || [];
      for (const item of items) {
        const a = item.attributes || item;
        allServers.push({
          identifier: a.identifier || '', uuid: a.uuid || '', name: a.name || '',
          description: a.description || '', node: a.node || '',
          sftp_details: a.sftp_details || {},
          allocations: (a.relationships?.allocations?.data || []).map(al => {
            const attrs = al.attributes || al;
            return { id: attrs.id, ip: attrs.ip || '', ip_alias: attrs.ip_alias || null,
              port: attrs.port || 0, is_default: attrs.is_default ?? false };
          }),
          egg: a.egg || 0, docker_image: a.docker_image || '', limits: a.limits || {},
        });
      }
      totalPages = data?.meta?.pagination?.total_pages || 1;
      page++;
    }
    return allServers;
  };

  return api;
}

const instance = new PanelApi();

module.exports = instance;
module.exports.PanelApi = PanelApi;
module.exports.createPanelApi = createPanelApi;
// Export individual functions for direct import
module.exports.getResources = getResources;
module.exports.sendPowerAction = sendPowerAction;
module.exports.sendCommand = sendCommand;
module.exports.getServerDetails = getServerDetails;
module.exports.listBackups = listBackups;
module.exports.createBackup = createBackup;
module.exports.deleteBackup = deleteBackup;
module.exports.getBackupDownloadUrl = getBackupDownloadUrl;
module.exports.getFileDownloadUrl = getFileDownloadUrl;
module.exports.downloadFile = downloadFile;
module.exports.listFiles = listFiles;
module.exports.readFile = readFile;
module.exports.writeFile = writeFile;
module.exports.getWebsocketAuth = getWebsocketAuth;
module.exports.listSchedules = listSchedules;
module.exports.createSchedule = createSchedule;
module.exports.deleteSchedule = deleteSchedule;
module.exports.getStartupVariables = getStartupVariables;
module.exports.updateStartupVariable = updateStartupVariable;
module.exports.listAllocations = listAllocations;
module.exports.listServers = listServers;
