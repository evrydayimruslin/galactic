import { DurableObject } from "cloudflare:workers";

export class GxTestSession extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS transcript (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        binding_name TEXT NOT NULL,
        effect TEXT NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS session_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        sealed INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO session_meta (singleton, sealed) VALUES (1, 0)",
    );
  }

  record(bindingName, effect) {
    const row = this.ctx.storage.sql.exec(
      "SELECT sealed FROM session_meta WHERE singleton = 1",
    ).toArray()[0];
    if (!row || Number(row.sealed) !== 0) {
      throw new Error("probe session is sealed");
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO transcript (binding_name, effect) VALUES (?, ?)",
      bindingName,
      effect,
    );
  }

  sealAndSnapshot() {
    return this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec(
        "SELECT sealed FROM session_meta WHERE singleton = 1",
      ).toArray()[0];
      if (!row || Number(row.sealed) !== 0) {
        throw new Error("probe session is sealed");
      }
      const transcript = this.ctx.storage.sql.exec(
        `SELECT binding_name, effect
           FROM transcript
          ORDER BY sequence`,
      ).toArray();
      this.ctx.storage.sql.exec(
        "UPDATE session_meta SET sealed = 1 WHERE singleton = 1",
      );
      return transcript;
    });
  }

  async close() {
    await this.ctx.storage.deleteAll();
  }
}

export default {};
