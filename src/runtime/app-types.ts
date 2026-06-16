/**
 * Domain interfaces shared across the bot entry-point modules — extracted
 * verbatim from src/index.ts (P1-1b god-file split). Pure types: every import
 * here is `import type` (or inline `typeof import(...)`), so this module is a
 * leaf with no runtime/value dependency and cannot create an import cycle.
 */
import type { ChatInputCommandInteraction } from 'discord.js';
import type WebMapServer from '../web-map/server.js';
import type { HzmodIpcClientInstance } from '../config/hzmod-source-runtime.js';

// ── Interfaces for dynamically loaded commands ────────────
export interface SlashCommand {
  data: { name: string; toJSON: () => unknown };
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

// ── Interfaces for optional modules ───────────────────────
export interface AnticheatInstance {
  start: () => Promise<void>;
  stop: () => Promise<void> | void;
  available: boolean;
  onSaveSync: (result: SaveSyncResult) => Promise<void>;
  reconfigure: (options: { anticheatAnalyzeInterval?: unknown; anticheatBaselineInterval?: unknown }) => void;
}

export interface HowyagarnManagerInstance {
  init: () => void;
  shutdown: () => void;
  onSaveSync: (data: { players: HowyagarnPlayer[]; structures: unknown[] }) => void;
  onLogEvent: (type: string, data: unknown) => void;
  onPlayerConnect: (steamId: string, playerName: string) => void;
  setIpc?: (ipc: HzmodIpcClientInstance | null) => void;
  reconfigure?: (options: { ipc?: HzmodIpcClientInstance | null }) => void;
}

export interface HowyagarnPlayer {
  steamId: string;
  name: string;
  x: number;
  y: number;
  deltaZeeksKilled: number;
  deltaNpcKills: number;
  deltaAnimalKills: number;
  deltaFishCaught: number;
  deltaDaysSurvived: number;
}

export interface HzmodWebPluginModule {
  register: (
    server: WebMapServer,
    cfg: typeof import('../config/index.js').default,
    opts: { ipc: HzmodIpcClientInstance | null },
  ) => { ipcClient?: { destroy: () => void } };
  setManager: (manager: HowyagarnManagerInstance) => void;
}

// ── Server definition (from loadServers() / multi-server.ts) ──
export interface ServerDef {
  id: string;
  name?: string;
  channels?: Record<string, string | undefined>;
  enabled?: boolean;
  [key: string]: unknown;
}

// ── Save sync result (emitted by SaveService 'sync' event) ──
export interface SaveSyncResult {
  playerCount: number;
  structureCount: number;
  vehicleCount: number;
  companionCount: number;
  clanCount: number;
  horseCount: number;
  containerCount: number;
  activityEvents: number;
  itemTracking: Record<string, unknown>;
  worldState: unknown;
  elapsed: number;
  steamIds: string[];
  mode: string;
  diffEvents: unknown[];
  syncTime: Date;
  parsed: Record<string, unknown> & {
    players: Map<string, Record<string, unknown>> | Record<string, Record<string, unknown>>;
    structures: unknown[];
    vehicles: unknown[];
    companions: unknown[];
    horses: unknown[];
    containers: unknown[];
  };
}
