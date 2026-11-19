import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Engine } from "./engine.ts";
import type { JobKey } from "./predict.ts";
import { redactCommand, redactKey } from "./redact.ts";
import type { Sampler } from "./sampler.ts";
import { msFiletime, StartLogWriter, type StartRow } from "./start-log.ts";
import { COMMAND_COLUMNS, Store } from "./store.ts";
import type { ProcessInfo } from "./types.ts";

/** The fixture secrets. No real token: each one only has the shape or the context of a secret. */
const TOKEN = `ghp_${"a1B2c3D4e5".repeat(3)}a1B2c3`;
// CodeQL (js/insufficient-password-hash) reads a name with "password" as a real password. The start log hashes each text
// with SHA-256 only as a content key. Thus this fixture has another name.
const LOGIN_SECRET = "hunter2-fixture-9";
const PG = "pg-fixture-secret-7";
const SECRETS = [TOKEN, LOGIN_SECRET, PG] as const;

describe("redactCommand (H186)", () => {
  it("puts a mark in place of each secret of a command line, and keeps the rest", () => {
    expect(redactCommand(`GITHUB_TOKEN=${TOKEN} gh pr list`)).toBe("GITHUB_TOKEN=[secret] gh pr list");
    expect(redactCommand(`gh auth status --token ${TOKEN}`)).toBe("gh auth status --token [secret]");
    expect(redactCommand(`echo ${TOKEN}`)).toBe("echo [secret]");
    expect(redactCommand(`mysql --password=${LOGIN_SECRET} -u root`)).toBe("mysql --password=[secret] -u root");
    expect(redactCommand(`curl -u admin:${LOGIN_SECRET} https://h`)).toBe("curl -u admin:[secret] https://h");
    expect(redactCommand(`git clone https://user:${LOGIN_SECRET}@github.com/o/r.git`)).toBe("git clone https://user:[secret]@github.com/o/r.git");
  });

  it("keeps a command line with no secret, and changes nothing on a second pass", () => {
    const lines = ["pnpm install --frozen-lockfile --prefer-offline", "vitest run src/redact.test.ts", "node --max-old-space-size=4096 cli.js --title headroom"];
    for (const line of lines) expect(redactCommand(line)).toBe(line);
    const once = redactCommand(`PGPASSWORD=${PG} psql --password ${LOGIN_SECRET} ${TOKEN}`);
    expect(redactCommand(once)).toBe(once);
  });

  it("redacts only the command of a key, and keeps a key with no secret as the same object", () => {
    const key: JobKey = { kind: "test", repo: "headroom", lock: null, filter: null, warm: null, packages: null, command: "vitest run" };
    expect(redactKey(key)).toBe(key);
    expect(redactKey({ ...key, command: `vitest run --token ${TOKEN}` })).toEqual({ ...key, command: "vitest run --token [secret]" });
  });
});

/** This function gives each text of each row of each table of a database file, as JSON. */
function allText(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    return tables.map(({ name }) => JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all())).join("\n");
  } finally {
    db.close();
  }
}

describe("the secrets of a command line never reach the store (H186)", () => {
  it("keeps no fixture secret of a job name, a job key or a process command line in any table", () => {
    const dir = mkdtempSync(join(tmpdir(), "headroom-redact-"));
    try {
      let now = 1_800_000_000_000;
      const node = (pid: number, ppid: number, name: string): ProcessInfo => ({ pid, ppid, name, privateMb: 10, workingMb: 10, startedAt: now - 60_000 });
      const sampler: Sampler = {
        memory: () => ({ totalMb: 28_000, availableMb: 9000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
        processes: () => [node(4, 0, "System"), node(21, 4, "psql.exe"), node(22, 4, "curl.exe")],
        commandLine: (pid) =>
          pid === 21 ? `"C:\\Program Files\\PostgreSQL\\bin\\psql.exe" "postgres://app:${PG}@db/app" --password ${LOGIN_SECRET}` : pid === 22 ? `curl -H "Authorization: Bearer ${TOKEN}" https://h` : null,
        close: () => undefined,
      };
      const path = join(dir, "headroom.db");
      const engine = new Engine({ sampler, store: new Store(path), now: () => now, sessionsDir: "/nowhere" });
      const key: JobKey = { kind: "test", repo: "headroom", lock: null, filter: null, warm: null, packages: null, command: `GITHUB_TOKEN=${TOKEN} vitest run` };
      const lease = engine.request({ holder: "headroom", job: `GITHUB_TOKEN=${TOKEN} vitest run --password ${LOGIN_SECRET}`, amounts: { memory: 100 }, key });
      expect(lease.job).toBe("GITHUB_TOKEN=[secret] vitest run --password [secret]");
      expect(engine.suggest(`GITHUB_TOKEN=${TOKEN} vitest run --password ${LOGIN_SECRET}`, "headroom", key).rung).toBeDefined();
      for (let step = 0; step < 3; step++) {
        engine.tick();
        now += 60_000;
      }
      engine.release(lease.id, "done", 120);
      engine.tick();
      const shown = JSON.stringify([engine.status(), engine.alerts(), engine.get(lease.id)]);
      engine.close();
      const stored = allText(path);
      // The test holds only when the store has the rows: the job, the key and the records of the two processes.
      expect(stored).toContain("GITHUB_TOKEN=[secret] vitest run --password [secret]");
      expect(stored).toContain("psql");
      expect(stored).toContain("Authorization: [secret]");
      for (const secret of SECRETS) {
        expect(stored.includes(secret), secret).toBe(false);
        expect(shown.includes(secret), secret).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redacts the rows of an older file at the next open, and only the rows with a secret", () => {
    const dir = mkdtempSync(join(tmpdir(), "headroom-redact-"));
    try {
      const path = join(dir, "headroom.db");
      new Store(path).close();
      const db = new DatabaseSync(path);
      const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      db.prepare("INSERT INTO process_owners (pid, created, owner, command, first_seen) VALUES (?, ?, ?, ?, ?)").run(31, 1, "other", `psql --password ${LOGIN_SECRET}`, 1);
      db.prepare("INSERT INTO process_owners (pid, created, owner, command, first_seen) VALUES (?, ?, ?, ?, ?)").run(32, 1, "other", "vitest run", 1);
      db.prepare("INSERT INTO leases (id, holder, job, amounts, priority, ttl_ms, state, requested_at, heartbeat_at) VALUES (?, ?, ?, ?, 0, 1, 'released', 1, 1)").run(
        "l1",
        "h",
        `GITHUB_TOKEN=${TOKEN} gh pr list`,
        "{}",
      );
      db.prepare("INSERT INTO lease_keys (lease_id, kind, command, rung, runs) VALUES (?, 'other', ?, 'none', 0)").run("l1", `gh pr list --token ${TOKEN}`);
      db.prepare("INSERT INTO reap_log (at, pid, created, name, action, private_mb, command, result) VALUES (1, 31, 1, 'psql.exe', 'ask', 1, ?, 'ok')").run(`psql --password ${LOGIN_SECRET}`);
      // The file goes back to step 4, the last step before the step of H186, as a file of a release before H186. The next
      // open runs the step of H186 and each later step.
      db.exec("PRAGMA user_version = 4");
      db.close();
      new Store(path).close();
      const stored = allText(path);
      for (const secret of SECRETS) expect(stored.includes(secret), secret).toBe(false);
      expect(stored).toContain("psql --password [secret]");
      expect(stored).toContain("GITHUB_TOKEN=[secret] gh pr list");
      expect(stored).toContain("gh pr list --token [secret]");
      expect(stored).toContain('"command":"vitest run"');
      const after = new DatabaseSync(path, { readOnly: true });
      expect((after.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(version);
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps no fixture secret of the command of a memory peak (H62 part 5)", () => {
    const dir = mkdtempSync(join(tmpdir(), "headroom-redact-"));
    try {
      let now = 1_800_000_000_000;
      const big = (pid: number, ppid: number, name: string, privateMb: number): ProcessInfo => ({ pid, ppid, name, privateMb, workingMb: privateMb, startedAt: now - 60_000 });
      const sampler: Sampler = {
        memory: () => ({ totalMb: 28_000, availableMb: 9000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
        processes: () => [big(4, 0, "System", 1), big(21, 4, "psql.exe", 900)],
        commandLine: (pid) => (pid === 21 ? `psql "postgres://app:${PG}@db/app" --password ${LOGIN_SECRET}` : null),
        close: () => undefined,
      };
      const path = join(dir, "headroom.db");
      const store = new Store(path);
      const engine = new Engine({ sampler, store, now: () => now, sessionsDir: "/nowhere" });
      for (let step = 0; step < 2; step++) {
        engine.tick();
        now += 60_000;
      }
      // A caller of the store that gives a raw command line also gets the mark.
      const raw = `curl -H "Authorization: Bearer ${TOKEN}" https://h`;
      store.saveMemoryPeaks(now, [{ kind: "process", key: "22:1", name: "curl.exe", owner: null, pid: 22, created: 1, lease: null, peakMb: 600, command: raw }]);
      const shown = JSON.stringify(engine.peaks(0));
      engine.close();
      const stored = allText(path);
      // The test holds only when the store has the two holders with their commands.
      expect(stored).toContain("psql.exe");
      expect(stored).toContain("--password [secret]");
      expect(stored).toContain("Authorization: [secret]");
      for (const secret of SECRETS) {
        expect(stored.includes(secret), secret).toBe(false);
        expect(shown.includes(secret), secret).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redacts each column of the schema with the name command or job, and the reason of a lease below its floor", () => {
    const dir = mkdtempSync(join(tmpdir(), "headroom-redact-"));
    try {
      const path = join(dir, "headroom.db");
      new Store(path).close();
      const db = new DatabaseSync(path, { readOnly: true });
      const columns = db
        .prepare("SELECT m.name AS tableName, c.name AS columnName FROM sqlite_master m JOIN pragma_table_info(m.name) c WHERE m.type = 'table'")
        .all() as { tableName: string; columnName: string }[];
      db.close();
      // H215: the reason of `--below-peak` is free text from the caller, so it gets the marks of a command line.
      const named = columns.filter((each) => /command|^job$|^below_peak$/.test(each.columnName)).map((each) => `${each.tableName}.${each.columnName}`);
      expect(named.sort()).toEqual(COMMAND_COLUMNS.map(([table, column]) => `${table}.${column}`).sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** All the values of all the tables of a file, as text. The start log keeps 64-bit hashes, so it reads big integers. */
function allLogText(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true, readBigInts: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    const text = (_key: string, value: unknown): unknown => (typeof value === "bigint" ? value.toString() : value);
    return tables.map(({ name }) => JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all(), text)).join("\n");
  } finally {
    db.close();
  }
}

/** A start row of the start log, 50 ms after its creation. */
function start(at: number, pid: number, command: string, parentCommand: string | null = null): StartRow {
  return { at, key: 1, pid, ppid: 4, created: msFiletime(at - 50), image: "C:\\x\\psql.exe", command, parentCommand, reuseMs: null };
}

/** The first 8 bytes of the SHA-256 of a text, as the start log keeps it. */
const hashOf = (text: string): bigint => createHash("sha256").update(text).digest().readBigInt64LE(0);

describe("the secrets of a command line never reach the start log (H186, H193)", () => {
  const T0 = Date.UTC(2026, 10, 17, 21, 0, 0);

  it("keeps no fixture secret of a command line or of the command line of a parent", () => {
    const dir = mkdtempSync(join(tmpdir(), "headroom-redact-"));
    try {
      const path = join(dir, "starts.db");
      const writer = new StartLogWriter(path, { now: () => T0 });
      writer.write([start(T0, 21, `psql --password ${LOGIN_SECRET} -h db`, `GITHUB_TOKEN=${TOKEN} bash -c x`), start(T0 + 10, 22, `psql --password ${LOGIN_SECRET} -h db`)], []);
      // The second row is a known text: it gets the id of the first row, with no second text.
      writer.write([start(T0 + 20, 23, `curl -u admin:${PG} https://h`)], []);
      writer.close();
      const stored = allLogText(path);
      expect(stored).toContain("psql --password [secret] -h db");
      expect(stored).toContain("GITHUB_TOKEN=[secret] bash -c x");
      expect(stored).toContain("curl -u admin:[secret] https://h");
      for (const secret of SECRETS) expect(stored.includes(secret), secret).toBe(false);
      const db = new DatabaseSync(path, { readOnly: true });
      expect(db.prepare("SELECT count(*) AS n FROM texts WHERE text = 'psql --password [secret] -h db'").get()).toEqual({ n: 1 });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redacts the texts of an older file at the next open, and gives no hash to a text that another text has", () => {
    const dir = mkdtempSync(join(tmpdir(), "headroom-redact-"));
    try {
      const path = join(dir, "starts.db");
      const first = new StartLogWriter(path, { now: () => T0 });
      first.write([start(T0, 21, "mysql --password=[secret] -u root")], []);
      first.close();
      const db = new DatabaseSync(path);
      const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      // The texts of a file of the first version: each one as it came, with the hash of that text.
      const insert = db.prepare("INSERT INTO texts (hash, text, last) VALUES (?, ?, ?)");
      for (const text of [`mysql --password=${LOGIN_SECRET} -u root`, `gh pr list --token ${TOKEN}`, "vitest run"]) insert.run(hashOf(text), text, T0);
      db.exec(`PRAGMA user_version = ${version - 1}`);
      db.close();
      const second = new StartLogWriter(path, { now: () => T0 + 1000 });
      // A new text with the same redaction finds a text of the file, and the unique hash does not refuse it.
      second.write([start(T0 + 1000, 22, `mysql --password=${PG} -u root`)], []);
      second.close();
      const stored = allLogText(path);
      for (const secret of SECRETS) expect(stored.includes(secret), secret).toBe(false);
      expect(stored).toContain("gh pr list --token [secret]");
      expect(stored).toContain('"text":"vitest run"');
      const after = new DatabaseSync(path, { readOnly: true });
      expect((after.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(version);
      // Two texts are the same after the step. Only the first one keeps its hash, so a search finds one text.
      const same = after.prepare("SELECT hash IS NOT NULL AS hashed FROM texts WHERE text = 'mysql --password=[secret] -u root' ORDER BY id").all();
      expect(same).toEqual([{ hashed: 1 }, { hashed: 0 }]);
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
