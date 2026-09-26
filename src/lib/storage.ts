import "server-only";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Snapshot storage.
 *
 * Callers only ever see the two functions exported at the bottom of this
 * file. Everything backend specific lives behind `SnapshotStorage`, so
 * swapping local disk for an S3-compatible service (Cloudflare R2, AWS S3,
 * MinIO) means writing one new implementation and changing the single
 * `storage` binding below — no call sites change.
 *
 * A backend receives and returns an opaque snapshot blob. It does not
 * interpret the format, so switching backends does not require the tar
 * layout to stay stable either.
 */
export interface SnapshotStorage {
  /** Human-readable name, surfaced in the UI and logs. */
  readonly kind: string;
  /**
   * Where a snapshot with this key physically lives. Local disk reports an
   * absolute path; an object store would report a bucket URL.
   */
  describeLocation(key: string): Promise<string>;
  put(key: string, body: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  remove(key: string): Promise<void>;
}

/** Default location, statically scoped under the project directory. */
const DEFAULT_SNAPSHOT_DIR = path.join(process.cwd(), "data", "snapshots");

/** `123` -> `project-123.tar`. Keys stay filesystem safe. */
export function snapshotKeyForProject(projectId: number): string {
  return `project-${projectId}.tar`;
}

function assertProjectId(projectId: number): void {
  if (!Number.isInteger(projectId) || projectId <= 0) {
    throw new Error(`Invalid project id: ${projectId}`);
  }
}

/**
 * Keys are derived from the project id, never from request input, but they are
 * joined onto a filesystem path so they are validated anyway.
 */
function assertSafeKey(key: string): void {
  if (
    key.length === 0 ||
    key === "." ||
    key === ".." ||
    key.includes("/") ||
    key.includes("\\") ||
    key.includes("\0")
  ) {
    throw new Error(`Unsafe storage key: ${JSON.stringify(key)}`);
  }
}

function resolveSnapshotDir(): string {
  const configured = process.env.SNAPSHOT_DIR?.trim();

  if (!configured) {
    return DEFAULT_SNAPSHOT_DIR;
  }

  // Absolute values let a container mount a volume (e.g. /data/snapshots);
  // relative values resolve against the project directory. The bundler cannot
  // see the value, so it is marked to avoid tracing the whole project.
  return path.resolve(/* turbopackIgnore: true */ process.cwd(), configured);
}

function snapshotPath(key: string): string {
  assertSafeKey(key);
  // The directory comes from the environment, so it is opaque to the bundler.
  // Marked so the build does not trace the whole project into the output.
  return path.join(/* turbopackIgnore: true */ resolveSnapshotDir(), key);
}

const localDiskStorage: SnapshotStorage = {
  kind: "local-disk",

  async describeLocation(key) {
    return snapshotPath(key);
  },

  async put(key, body) {
    const target = snapshotPath(key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  },

  async get(key) {
    try {
      return new Uint8Array(await readFile(snapshotPath(key)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  },

  async remove(key) {
    try {
      await unlink(snapshotPath(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  },
};

/**
 * The active backend. To move to object storage, implement `SnapshotStorage`
 * against the S3 SDK and replace this line, e.g.
 *
 *   const storage: SnapshotStorage = r2Storage;
 */
const storage: SnapshotStorage = localDiskStorage;

/** Persist a snapshot blob. Returns the key and where it physically landed. */
export async function saveSnapshot(
  projectId: number,
  buffer: Uint8Array,
): Promise<{ storageKey: string; location: string }> {
  assertProjectId(projectId);

  const storageKey = snapshotKeyForProject(projectId);
  await storage.put(storageKey, buffer);

  return { storageKey, location: await storage.describeLocation(storageKey) };
}

/** Read a snapshot blob, or `null` when the project has no snapshot yet. */
export async function loadSnapshot(
  projectId: number,
): Promise<Uint8Array | null> {
  assertProjectId(projectId);
  return storage.get(snapshotKeyForProject(projectId));
}

export const snapshotStorageKind = storage.kind;
