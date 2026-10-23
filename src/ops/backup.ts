import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * A consistent copy of the live database, safe while the server writes (VACUUM INTO reads one snapshot).
 * Kept beside the database so a bad migration or a corrupted file can be rolled back without the provider;
 * the volume snapshots Fly takes are the copy that survives losing the volume.
 */
export function backup(db: Database, dir: string, now = Date.now(), keep = 7): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `circle-${new Date(now).toISOString().replace(/[:.]/g, "-")}.sqlite`);
  db.run("VACUUM INTO ?", [file]);
  const old = readdirSync(dir)
    .filter((f) => /^circle-.*\.sqlite$/.test(f))
    .sort()
    .reverse()
    .slice(keep);
  for (const f of old) rmSync(join(dir, f), { force: true });
  return file;
}

/**
 * Restore at boot: a file uploaded to restore.sqlite beside the database replaces it before anything opens it.
 * The database it replaces is kept in backups/, so a restore can itself be undone.
 */
export function restoreIfStaged(dbPath: string, now = Date.now()): string | undefined {
  const staged = join(dirname(dbPath), "restore.sqlite");
  if (!existsSync(staged)) return undefined;
  // Each file leaves as one self-contained file (no -wal beside it), so it can be moved and opened anywhere.
  const check = new Database(staged);
  try {
    const ok = (check.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
    if (ok !== "ok") throw new Error(`restore.sqlite failed its integrity check: ${ok}`);
    check.run("PRAGMA journal_mode = DELETE");
  } catch (e) {
    throw new Error(`restore.sqlite is not a usable database: ${(e as Error).message}`);
  } finally {
    check.close();
  }
  const kept = join(dirname(dbPath), "backups", `pre-restore-${new Date(now).toISOString().replace(/[:.]/g, "-")}.sqlite`);
  mkdirSync(dirname(kept), { recursive: true });
  if (existsSync(dbPath)) {
    const cur = new Database(dbPath);
    cur.run("PRAGMA journal_mode = DELETE"); // folds the write-ahead log in
    cur.close();
    renameSync(dbPath, kept);
  }
  for (const f of [`${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true });
  renameSync(staged, dbPath);
  return kept;
}

// `bun run src/ops/backup.ts` — an on-demand copy of DB_PATH into backups/ beside it; prints the file.
if (import.meta.main) {
  const path = process.env.DB_PATH ?? "data/circle.sqlite";
  const db = new Database(path, { readonly: true });
  console.log(backup(db, join(dirname(path), "backups"), Date.now(), Number(process.env.BACKUPS_KEPT ?? 7)));
}
