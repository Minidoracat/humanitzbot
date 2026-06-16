/**
 * HZMod (HOWYAGARN) runtime reconfiguration — swap the shared IPC client when
 * the HZMod socket config changes at runtime, and rebind the HowyagarnManager to
 * the new IPC. Extracted verbatim from src/index.ts (P1-1b god-file split). The
 * get/set ipc accessor bridge over ctx.hzmodIpc and the live ctx reads
 * (ctx.optional.HzmodIpcClient, ctx.webMapServer) are preserved exactly.
 */
import { reconfigureHzmodRuntimeState } from '../config/hzmod-source-runtime.js';
import type { HzmodIpcClientInstance } from '../config/hzmod-source-runtime.js';
import type { HzmodSourceRuntimeSnapshot } from '../config/external-source-runtime.js';
import type { AppContext } from '../runtime/app-context.js';

function rebindHowyagarnManagerIpc(
  ctx: AppContext,
  nextIpc: HzmodIpcClientInstance | null,
  previousIpc: HzmodIpcClientInstance | null,
): (() => void) | null {
  const manager = ctx.howyagarnManager;
  if (!manager) return null;

  if (typeof manager.setIpc === 'function') {
    manager.setIpc(nextIpc);
    return () => {
      manager.setIpc?.(previousIpc);
    };
  }

  if (typeof manager.reconfigure === 'function') {
    manager.reconfigure({ ipc: nextIpc });
    return () => {
      manager.reconfigure?.({ ipc: previousIpc });
    };
  }

  throw new Error('HOWYAGARN manager does not support runtime IPC rebind; restart required for HZMod socket changes');
}

export function reconfigureHzmodRuntime(
  ctx: AppContext,
  next: HzmodSourceRuntimeSnapshot,
  previous: HzmodSourceRuntimeSnapshot,
): void {
  reconfigureHzmodRuntimeState(
    {
      get ipc() {
        return ctx.hzmodIpc;
      },
      set ipc(nextIpc) {
        ctx.hzmodIpc = nextIpc;
      },
    },
    next,
    previous,
    {
      getIpcClientConstructor: () => ctx.optional.HzmodIpcClient,
      getWebMapServer: () => ctx.webMapServer,
      rebindManager: (n, p) => rebindHowyagarnManagerIpc(ctx, n, p),
    },
  );
}
