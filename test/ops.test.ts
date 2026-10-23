import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, restoreIfStaged } from "../src/ops/backup.ts";
import { redact } from "../src/ops/ops.ts";

const scratch = () => mkdtempSync(join(tmpdir(), "circle-ops-"));
const seeded = (path: string, note: string) => {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE IF NOT EXISTS t (v TEXT)");
  db.run("INSERT INTO t VALUES (?)", [note]);
  return db;
};
const notes = (path: string) => {
  const db = new Database(path, { readonly: true });
  const v = (db.query("SELECT v FROM t").all() as { v: string }[]).map((r) => r.v);
  db.close();
  return v;
};

describe("backup and restore", () => {
  test("a backup is a whole copy taken while the database is open, and only the newest few are kept", () => {
    const dir = scratch();
    try {
      const db = seeded(join(dir, "circle.sqlite"), "first");
      for (let d = 0; d < 9; d++) backup(db, join(dir, "backups"), Date.UTC(2026, 9, 1 + d), 7);
      const files = readdirSync(join(dir, "backups")).sort();
      expect(files).toHaveLength(7);
      expect(files[0]).toContain("2026-10-03");
      expect(notes(join(dir, "backups", files[6]!))).toEqual(["first"]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a staged restore replaces the database at boot and keeps the replaced one; a corrupt file is refused", () => {
    const dir = scratch();
    const path = join(dir, "circle.sqlite");
    try {
      seeded(path, "live").close();
      const snap = seeded(join(dir, "snap.sqlite"), "yesterday");
      snap.run("VACUUM INTO ?", [join(dir, "restore.sqlite")]);
      snap.close();
      const kept = restoreIfStaged(path)!;
      expect(notes(path)).toEqual(["yesterday"]);
      expect(notes(kept)).toEqual(["live"]);
      expect(existsSync(join(dir, "restore.sqlite"))).toBe(false);
      expect(restoreIfStaged(path)).toBeUndefined();
      writeFileSync(join(dir, "restore.sqlite"), "not a database");
      expect(() => restoreIfStaged(path)).toThrow();
      expect(notes(path)).toEqual(["yesterday"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("the error log redactor takes out keys, bearer tokens and secrets in query strings, and leaves the rest readable", () => {
  expect(redact("POST https://x.test/v1?api_key=abc123&q=pizza failed: 401")).toBe("POST https://x.test/v1?api_key=[redacted]&q=pizza failed: 401");
  expect(redact("Authorization: Bearer eyJhbGciOi.payload.sig")).toBe("Authorization: Bearer [redacted]");
  expect(redact("send to +14155550123 failed")).toBe("send to +14155550123 failed");
});

test("a browser connect URL's signing key is taken out of a tool error before anyone stores it", () => {
  expect(redact('connectOverCDP: WebSocket error fetching "https://1.2.3.4/?signingKey=eyJhbGci.abc.def"')).toBe(
    'connectOverCDP: WebSocket error fetching "https://1.2.3.4/?signingKey=[redacted]"',
  );
});
