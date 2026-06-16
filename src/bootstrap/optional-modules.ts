/**
 * loadOptionalModules — resolve the optional private-package constructors
 * (anticheat, howyagarn/*) into ctx.optional.*. Each import is wrapped in its
 * own try/catch so a missing private package is a no-op. Extracted verbatim
 * from src/index.ts (P1-1b god-file split); the only change is the leading
 * `../` on the dynamic import specifiers now that this file lives under
 * src/bootstrap/ instead of src/.
 */
import type { AppContext } from '../runtime/app-context.js';

/**
 * True only when the optional module FILE ITSELF is absent — not when a module
 * that IS present fails to load a transitive dependency. Both throw
 * ERR_MODULE_NOT_FOUND, so we disambiguate on the unresolved URL: a genuinely
 * absent optional module reports its own path, whereas a broken dependency
 * reports the nested specifier. Unknown error shapes fail toward logging.
 */
function isAbsentOptionalModule(err: unknown, moduleFile: string): boolean {
  const e = err as (NodeJS.ErrnoException & { url?: string }) | null | undefined;
  return e?.code === 'ERR_MODULE_NOT_FOUND' && (e.url?.endsWith(moduleFile) ?? false);
}

export async function loadOptionalModules(ctx: AppContext): Promise<void> {
  try {
    ctx.optional.AnticheatIntegration = (
      (await import('../modules/anticheat-integration.js')) as unknown as {
        default: typeof ctx.optional.AnticheatIntegration;
      }
    ).default; // SAFETY: optional private module dynamic import
  } catch (err) {
    if (!isAbsentOptionalModule(err, 'anticheat-integration.js')) {
      console.error('[BOOT] Failed loading optional module anticheat-integration:', err);
    }
  }
  // howyagarn/* modules are optional private packages — path via variable bypasses static TSC resolution
  const _webPluginPath = '../modules/howyagarn/web-plugin.js';
  const _managerPath = '../modules/howyagarn/howyagarn-manager.js';
  const _ipcClientPath = '../modules/howyagarn/ipc-client.js';
  try {
    ctx.optional.hzmodWebPlugin = (
      (await import(/* @vite-ignore */ _webPluginPath)) as { default: typeof ctx.optional.hzmodWebPlugin }
    ).default;
  } catch (err) {
    if (!isAbsentOptionalModule(err, 'web-plugin.js')) {
      console.error('[BOOT] Failed loading optional module howyagarn/web-plugin:', err);
    }
  }
  try {
    ({ HowyagarnManager: ctx.optional.HowyagarnManager } = (await import(/* @vite-ignore */ _managerPath)) as {
      HowyagarnManager: typeof ctx.optional.HowyagarnManager;
    });
  } catch (err) {
    if (!isAbsentOptionalModule(err, 'howyagarn-manager.js')) {
      console.error('[BOOT] Failed loading optional module howyagarn/howyagarn-manager:', err);
    }
  }
  try {
    ctx.optional.HzmodIpcClient = (
      (await import(/* @vite-ignore */ _ipcClientPath)) as { default: typeof ctx.optional.HzmodIpcClient }
    ).default;
  } catch (err) {
    if (!isAbsentOptionalModule(err, 'ipc-client.js')) {
      console.error('[BOOT] Failed loading optional module howyagarn/ipc-client:', err);
    }
  }
}
