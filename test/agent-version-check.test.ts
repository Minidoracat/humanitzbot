/**
 * Tests for SaveService._checkAgentCacheVersion — stale agent cache detection
 * and forced redeploy (PR #9 review follow-up).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import SaveService from '../src/parsers/save-service.js';
import { AGENT_VERSION } from '../src/parsers/agent-version.js';

type AnyRecord = Record<string, any>;

function makeService(): { svc: AnyRecord; deploys: number[]; warns: string[] } {
  const svc = new SaveService({} as never, {
    dataDir: '/tmp/humanitzbot-agent-version-test',
    idMap: {},
  }) as unknown as AnyRecord;

  const deploys: number[] = [];
  const warns: string[] = [];
  svc.deployAgent = async () => {
    deploys.push(Date.now());
    svc._agentDeployed = true;
  };
  svc._log = new Proxy(
    {},
    {
      get: (_t, level) => (msg: string) => {
        if (level === 'warn') warns.push(msg);
      },
    },
  );
  svc._agentDeployed = true;
  return { svc, deploys, warns };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('SaveService._checkAgentCacheVersion', () => {
  it('forces a redeploy and warns once when the cache version is stale', async () => {
    const { svc, deploys, warns } = makeService();
    svc._sftpConfig = { host: 'example' };

    svc._checkAgentCacheVersion({ v: AGENT_VERSION - 1 });
    await flush();

    assert.equal(svc._agentDeployed, true, 'stubbed deployAgent should have re-marked deployment');
    assert.equal(deploys.length, 1);
    assert.equal(warns.length, 1);
    assert.match(warns[0] ?? '', new RegExp(`v${String(AGENT_VERSION - 1)}.*v${String(AGENT_VERSION)}`));
  });

  it('throttles repeated warnings/deploys for the same stale version', async () => {
    const { svc, deploys, warns } = makeService();
    svc._sftpConfig = { host: 'example' };

    svc._checkAgentCacheVersion({ v: AGENT_VERSION - 1 });
    svc._checkAgentCacheVersion({ v: AGENT_VERSION - 1 });
    svc._checkAgentCacheVersion({ v: AGENT_VERSION - 1 });
    await flush();

    assert.equal(deploys.length, 1);
    assert.equal(warns.length, 1);
    // The deploy flag still drops on every stale sync so the ssh path retries
    assert.equal(svc._agentDeployed, false);
  });

  it('resets the throttle once a current cache arrives', async () => {
    const { svc, deploys, warns } = makeService();
    svc._sftpConfig = { host: 'example' };

    svc._checkAgentCacheVersion({ v: AGENT_VERSION - 1 });
    svc._checkAgentCacheVersion({ v: AGENT_VERSION });
    svc._checkAgentCacheVersion({ v: AGENT_VERSION - 1 });
    await flush();

    assert.equal(deploys.length, 2);
    assert.equal(warns.length, 2);
  });

  it('does nothing for the expected cache version', () => {
    const { svc, deploys, warns } = makeService();
    svc._sftpConfig = { host: 'example' };

    svc._checkAgentCacheVersion({ v: AGENT_VERSION });

    assert.equal(svc._agentDeployed, true);
    assert.equal(deploys.length, 0);
    assert.equal(warns.length, 0);
  });

  it('treats a newer cache version (bot rollback) as a mismatch and redeploys', async () => {
    const { svc, deploys, warns } = makeService();
    svc._sftpConfig = { host: 'example' };

    svc._checkAgentCacheVersion({ v: AGENT_VERSION + 1 });
    await flush();

    assert.equal(deploys.length, 1);
    assert.equal(warns.length, 1);
    assert.match(warns[0] ?? '', /newer than expected/);
  });

  it('ignores caches without a finite numeric version', () => {
    const { svc, deploys, warns } = makeService();
    svc._sftpConfig = { host: 'example' };

    svc._checkAgentCacheVersion({});
    svc._checkAgentCacheVersion({ v: 'old' });
    svc._checkAgentCacheVersion({ v: NaN });

    assert.equal(svc._agentDeployed, true);
    assert.equal(deploys.length, 0);
    assert.equal(warns.length, 0);
  });

  it('retries the redeploy on the next sync after a transient deploy failure', async () => {
    const { svc, deploys, warns } = makeService();
    svc._sftpConfig = { host: 'example' };
    let failFirst = true;
    svc.deployAgent = async () => {
      if (failFirst) {
        failFirst = false;
        throw new Error('sftp timeout');
      }
      deploys.push(Date.now());
      svc._agentDeployed = true;
    };

    svc._checkAgentCacheVersion({ v: AGENT_VERSION - 1 });
    await flush();
    assert.equal(deploys.length, 0, 'first deploy attempt fails');
    assert.equal(warns.length, 2, 'stale warning + failure warning');

    svc._checkAgentCacheVersion({ v: AGENT_VERSION - 1 });
    await flush();
    assert.equal(deploys.length, 1, 'failure cleared the throttle, second sync retried');
  });

  it('reconfigure() clears the throttle so a new server gets its own redeploy', () => {
    const { svc } = makeService();
    svc._staleAgentCacheVersion = AGENT_VERSION - 1;

    svc.reconfigure({ savePath: '/srv/other/Save.sav' });

    assert.equal(svc._staleAgentCacheVersion, null);
  });

  it('only warns and drops the flag when SFTP is not configured (rcon/panel-only setups)', async () => {
    const { svc, deploys, warns } = makeService();
    svc._sftpConfig = null;

    svc._checkAgentCacheVersion({ v: AGENT_VERSION - 1 });
    await flush();

    assert.equal(svc._agentDeployed, false);
    assert.equal(deploys.length, 0);
    assert.equal(warns.length, 1);
  });
});
