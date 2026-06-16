/**
 * Shared context type for web-map route-registrar functions.
 *
 * Each `registerXxxRoutes(app, ctx)` receives the live `WebMapServer` instance
 * as `ctx` and reads its `_`-prefixed fields and helper methods (including
 * setter-injected dependencies such as `_scheduler` / `_saveService` /
 * `_botControl` that are bound after construction) instead of `this`.
 *
 * This is a type-only alias — `import type` is erased at runtime, so there is
 * no runtime import cycle between route modules and server.ts. Route modules
 * import `WebMapRouteContext` from here; they never import server.ts.
 */

import type { WebMapServer } from '../server.js';

export type WebMapRouteContext = WebMapServer;
