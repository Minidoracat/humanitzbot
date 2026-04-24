import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import HumanitZDB from '../src/db/database.js';

describe('HumanitZDB.rawQuery', () => {
  let db: HumanitZDB;

  beforeEach(() => {
    db = new HumanitZDB({ memory: true, label: 'RawQueryTest' });
    db.init();
  });

  afterEach(() => {
    db.close();
  });

  it('requires an audit context', () => {
    assert.throws(() => db.rawQuery('SELECT 1', [], { ctx: '' }), /ctx/);
  });

  it('supports read-only all/get queries with positional params', () => {
    db.botState.setState('raw_query_test', 'ok');

    const rows = db.rawQuery('SELECT key, value FROM bot_state WHERE key = ?', ['raw_query_test'], {
      ctx: 'test:all',
    }) as Array<{ key: string; value: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.value, 'ok');

    const row = db.rawQuery('SELECT value FROM bot_state WHERE key = ?', ['raw_query_test'], {
      ctx: 'test:get',
      mode: 'get',
    }) as { value: string } | undefined;
    assert.equal(row?.value, 'ok');
  });

  it('supports named params for read-only queries', () => {
    db.botState.setState('raw_query_named_test', 'ok');

    const row = db.rawQuery(
      'SELECT value FROM bot_state WHERE key = @key',
      { key: 'raw_query_named_test' },
      {
        ctx: 'test:named',
        mode: 'get',
      },
    ) as { value: string } | undefined;

    assert.equal(row?.value, 'ok');
  });

  it('allowlists read-only PRAGMA and rejects mutating PRAGMA', () => {
    const rows = db.rawQuery('PRAGMA table_info("bot_state")', [], { ctx: 'test:pragma' });
    assert.ok(rows.some((row) => row.name === 'key'));

    assert.throws(
      () => db.rawQuery('PRAGMA journal_mode = WAL', [], { ctx: 'test:mutating-pragma' }),
      /mutating PRAGMA/,
    );
    assert.throws(
      () => db.rawQuery('PRAGMA optimize', [], { ctx: 'test:non-allowlisted-pragma' }),
      /non-allowlisted PRAGMA/,
    );
  });

  it('blocks mutations unless explicitly enabled', () => {
    assert.throws(
      () => db.rawQuery('DELETE FROM bot_state', [], { ctx: 'test:blocked', mode: 'get' }),
      /read mode only allows/,
    );
    assert.throws(
      () => db.rawQuery('DELETE FROM bot_state', [], { ctx: 'test:blocked-run', mode: 'run' } as never),
      /mutation=true/,
    );
    assert.throws(
      () =>
        db.rawQuery('DELETE FROM bot_state', [], {
          ctx: 'test:blocked-mutation-all',
          mode: 'all',
          mutation: true,
        } as never),
      /requires run mode/,
    );
  });

  it('allows explicit mutation mode for admin console operations', () => {
    const info = db.rawQuery('INSERT INTO bot_state (key, value) VALUES (?, ?)', ['raw_query_mutation', 'ok'], {
      ctx: 'test:mutation',
      mode: 'run',
      mutation: true,
    });
    assert.equal(info.changes, 1);
    assert.equal(db.botState.getState('raw_query_mutation'), 'ok');
  });
});

describe('PR3 repository migration helpers', () => {
  let db: HumanitZDB;

  beforeEach(() => {
    db = new HumanitZDB({ memory: true, label: 'RepositoryMigrationTest' });
    db.init();
  });

  afterEach(() => {
    db.close();
  });

  it('repairs numeric activity actors through ActivityLogRepository', () => {
    const steamId = '76561198000000000';
    db.activityLog.insertActivity({
      type: 'inventory',
      category: 'inventory',
      actor: steamId,
      actorName: steamId,
      item: 'Wood',
      details: { action: 'test' },
    });

    const fixed = db.activityLog.repairActorNames({ [steamId]: 'Alice' });
    const row = db.rawQuery('SELECT actor_name FROM activity_log WHERE actor = ?', [steamId], {
      ctx: 'test:repair-activity-actor',
      mode: 'get',
    }) as { actor_name: string } | undefined;

    assert.equal(fixed, 1);
    assert.equal(row?.actor_name, 'Alice');
  });
});
