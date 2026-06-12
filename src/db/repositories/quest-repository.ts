import type Database from 'better-sqlite3';
import { BaseRepository } from './base-repository.js';
import type { DbRow } from './db-utils.js';

export class QuestRepository extends BaseRepository {
  declare private _stmts: {
    clearQuests: Database.Statement;
    insertQuest: Database.Statement;
    getPositionedQuests: Database.Statement;
  };

  protected _prepareStatements(): void {
    this._stmts = {
      clearQuests: this._handle.prepare('DELETE FROM quests'),
      insertQuest: this._handle.prepare(
        `INSERT INTO quests (id, type, state, data, time, items, pos_x, pos_y, pos_z, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      ),
      getPositionedQuests: this._handle.prepare(
        `SELECT id, type, state, time, items, pos_x, pos_y, pos_z, updated_at
         FROM quests WHERE pos_x IS NOT NULL`,
      ),
    };
  }

  /** Quests with a world position, for the panel map layer. */
  getPositionedQuests(): DbRow[] {
    return this._stmts.getPositionedQuests.all() as DbRow[];
  }

  /** Replace all quests in a transaction. For standalone use. */
  replaceQuests(quests: Array<Record<string, unknown>>): void {
    this._handle.transaction(() => {
      this.innerReplaceQuests(quests);
    })();
  }

  /** Inner replace — no transaction wrapper. Safe to call inside an outer transaction. */
  innerReplaceQuests(quests: Array<Record<string, unknown>>): void {
    this._stmts.clearQuests.run();
    for (const q of quests) {
      this._stmts.insertQuest.run(
        q.id,
        q.type,
        q.state,
        JSON.stringify(q.data),
        JSON.stringify(q.time ?? {}),
        JSON.stringify(q.items ?? []),
        q.x ?? null,
        q.y ?? null,
        q.z ?? null,
      );
    }
  }
}
