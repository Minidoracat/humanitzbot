/**
 * Minimal structural interface for ConfigRepository (get/set/update config
 * documents). Extracted verbatim from web-map/server.ts (P1-1 god-file split)
 * so route helpers (serverdef-repo) can type their config-repo parameter
 * without importing server.ts. Pure type — no imports, no cycle.
 */
export interface ConfigRepo {
  get(doc: string): Record<string, unknown> | undefined;
  set(doc: string, data: Record<string, unknown>): void;
  update(doc: string, data: Record<string, unknown>): void;
  delete(doc: string): void;
  loadAll(): Iterable<[string, { data: Record<string, unknown> }]>;
}
