import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Clock } from "../core/clock.ts";
import type { Id } from "../core/types.ts";
import type { Store } from "../store/repos.ts";

/**
 * Credentials for members' own accounts. Secrets are encrypted at rest with
 * MASTER_KEY and only ever handed to a hand inside `use`; they never reach the
 * model, the transcript, the events or the UI. The prompt sees service names
 * only ("Alex has connected: gmail, calendar").
 */
export class Vault {
  private key: Buffer;
  constructor(
    private store: Store,
    private clock: Clock,
    masterKey: string,
  ) {
    this.key = createHash("sha256").update(masterKey).digest();
  }

  put(personId: Id, service: string, secret: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const enc = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    this.store.putCredential(personId, normalise(service), [iv, tag, enc].map((b) => b.toString("base64")).join("."), this.clock.now());
  }

  has(personId: Id, service: string): boolean {
    return this.store.getCredential(personId, normalise(service)) !== undefined;
  }

  services(personId: Id): string[] {
    return this.store.listCredentialServices(personId);
  }

  remove(personId: Id, service: string) {
    this.store.deleteCredential(personId, normalise(service));
  }

  /** Run `fn` with the secret; the secret itself never leaves this call. */
  use<T>(personId: Id, service: string, fn: (secret: string) => T): T | undefined {
    const raw = this.store.getCredential(personId, normalise(service));
    if (!raw) return undefined;
    const [iv, tag, enc] = raw.split(".").map((p) => Buffer.from(p, "base64"));
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv!);
    decipher.setAuthTag(tag!);
    const secret = Buffer.concat([decipher.update(enc!), decipher.final()]).toString("utf8");
    return fn(secret);
  }
}

function normalise(service: string) {
  return service.trim().toLowerCase();
}
