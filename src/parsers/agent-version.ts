/**
 * Expected remote-agent / cache schema version.
 *
 * Lives in its own dependency-free module so runtime code (save-service's
 * cache version check) can import it without pulling in agent-builder's
 * esbuild dependency. Bump whenever parser extraction changes shape — the
 * bot compares this against `cache.v` and redeploys stale agents.
 */
export const AGENT_VERSION = 5;
