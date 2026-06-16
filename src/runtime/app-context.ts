/**
 * AppContext — the single mutable, by-reference object that threads the bot's
 * module state across the extracted entry-point units (bootstrap/*, handlers/*,
 * lifecycle/*). It formalises the existing shared-lexical-scope + getter-thunk
 * pattern that src/index.ts already used (e.g. `getSaveService: () => saveService`,
 * `get ipc()/set ipc()`), NOT a new abstraction.
 *
 * Threading rule (load-bearing): always read fields via live property access
 * (`ctx.statusChannels`) — NEVER destructure (`const { statusChannels } = ctx`),
 * which would freeze a stale snapshot and break runtime reconfigure/shutdown
 * after a module instance is swapped. Deliberate freeze points use an explicit
 * `const _x = ctx.x;` local inside a deferred callback.
 *
 * Every module-class import is `import type` so this module stays a near-leaf
 * with no value-import cycle back into index.ts. The only runtime imports are
 * the two singletons the factory must construct (Collection, RuntimeConfigApplier).
 */
import { Collection } from 'discord.js';
import RuntimeConfigApplier from '../config/runtime-config-applier.js';

import type { Client } from 'discord.js';
import type { BotStatusManager } from '../utils/status.js';
import type { HzmodIpcClientInstance, HzmodIpcClientConstructor } from '../config/hzmod-source-runtime.js';
import type ChatRelay from '../modules/chat-relay.js';
import type StatusChannels from '../modules/status-channels.js';
import type ServerStatus from '../modules/server-status.js';
import type AutoMessages from '../modules/auto-messages.js';
import type PlayerPresenceTracker from '../modules/player-presence.js';
import type LogWatcher from '../modules/log-watcher.js';
import type PlayerStatsChannel from '../modules/player-stats-channel.js';
import type PvpScheduler from '../modules/pvp-scheduler.js';
import type ServerScheduler from '../modules/server-scheduler.js';
import type MultiServerManager from '../server/multi-server.js';
import type WebMapServer from '../web-map/server.js';
import type HumanitZDB from '../db/database.js';
import type ConfigRepository from '../db/config-repository.js';
import type SaveService from '../parsers/save-service.js';
import type SnapshotService from '../tracking/snapshot-service.js';
import type ActivityLog from '../modules/activity-log.js';
import type MilestoneTracker from '../modules/milestone-tracker.js';
import type RecapService from '../modules/recap-service.js';
import type StdinConsole from '../stdin-console.js';
import type { SlashCommand, AnticheatInstance, HowyagarnManagerInstance, HzmodWebPluginModule } from './app-types.js';

/** Optional private-package constructors resolved lazily by loadOptionalModules(). */
export interface OptionalModuleCtors {
  AnticheatIntegration?: new (opts: {
    db: HumanitZDB;
    config: typeof import('../config/index.js').default;
    logWatcher: LogWatcher | undefined;
  }) => AnticheatInstance;
  hzmodWebPlugin?: HzmodWebPluginModule;
  HowyagarnManager?: new (opts: Record<string, unknown>) => HowyagarnManagerInstance;
  HzmodIpcClient?: HzmodIpcClientConstructor;
}

export interface AppContext {
  // ── Stable singletons (built once) ──
  readonly client: Client;
  readonly slashCommands: Collection<string, SlashCommand>;
  readonly runtimeConfigApplier: RuntimeConfigApplier;
  readonly moduleStatus: Record<string, string>;
  readonly startedAt: Date;
  readonly optional: OptionalModuleCtors;

  // ── Core infrastructure (assigned during ClientReady) ──
  db?: HumanitZDB;
  configRepo?: ConfigRepository;
  saveService?: SaveService;
  snapshotService?: SnapshotService;
  webMapServer?: WebMapServer;
  multiServerManager?: MultiServerManager;

  // ── Feature module instances ──
  chatRelay?: ChatRelay;
  statusChannels?: StatusChannels;
  serverStatus?: ServerStatus;
  autoMessages?: AutoMessages;
  presenceTracker?: PlayerPresenceTracker;
  logWatcher?: LogWatcher;
  playerStatsChannel?: PlayerStatsChannel;
  pvpScheduler?: PvpScheduler;
  serverScheduler?: ServerScheduler;
  activityLog?: ActivityLog;
  milestoneTracker?: MilestoneTracker;
  recapService?: RecapService;
  botStatusManager?: BotStatusManager;
  stdinConsole?: StdinConsole;

  // ── Optional / private-package instances ──
  anticheatIntegration?: AnticheatInstance;
  howyagarnManager?: HowyagarnManagerInstance;
  hzmodIpc?: HzmodIpcClientInstance;
  hzmodPlugin?: { ipcClient?: { destroy: () => void } };

  // ── Runtime-handler unregister fns (called by shutdown) ──
  unregisterCoreConnectionRuntimeHandlers?: () => void;
  unregisterSaveServiceRuntimeHandlers?: () => void;
  unregisterExternalSourceRuntimeHandlers?: () => void;
  unregisterDisplayRuntimeHandlers?: () => void;

  // ── Timers ──
  displayRefreshTimer?: ReturnType<typeof setTimeout>;
  playtimeFlushTimer?: ReturnType<typeof setInterval>;

  // ── Module-restart coordination ──
  statusChannelsStartPromise: Promise<void> | null;
  serverStatusStartPromise: Promise<void> | null;
  playerStatsStartPromise: Promise<void> | null;
  statusChannelsRestartQueue: Promise<void>;
  serverStatusRestartQueue: Promise<void>;
  playerStatsRestartQueue: Promise<void>;

  // ── Shutdown guard ──
  shuttingDown: boolean;
}

/**
 * Build a fresh AppContext. `client` is constructed by the caller (the
 * privileged-intent handshake at `new Client(...)` is a top-level side effect
 * that must run before this factory) and passed in by reference.
 */
export function createAppContext(client: Client): AppContext {
  return {
    client,
    slashCommands: new Collection<string, SlashCommand>(),
    runtimeConfigApplier: new RuntimeConfigApplier(),
    moduleStatus: {},
    startedAt: new Date(),
    optional: {},
    statusChannelsStartPromise: null,
    serverStatusStartPromise: null,
    playerStatsStartPromise: null,
    statusChannelsRestartQueue: Promise.resolve(),
    serverStatusRestartQueue: Promise.resolve(),
    playerStatsRestartQueue: Promise.resolve(),
    shuttingDown: false,
  };
}
