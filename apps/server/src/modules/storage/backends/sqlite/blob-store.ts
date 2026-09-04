// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * SQLite implementation of the blob port.
 *
 * Bytes live in the same database file as the records, in one row per blob.
 * That is what lets a SQL deployment need no folder at all: uploads,
 * artifacts, the guide document and the agent's memory body stop being files
 * without becoming a second service to run.
 *
 * The price is stated rather than hidden. A row is read and written whole, so
 * this backend is sized for the documents and images a Space actually holds,
 * not for arbitrarily large media, and a database holding blobs grows to the
 * size of everything ever uploaded. `materialize()` therefore spools to the
 * OS temp directory — the port's own escape hatch for consumers that need a
 * real path — and unlinks on release, which is exactly the "temp copy"
 * behaviour `BlobLease` was written to keep honest.
 *
 * Atomicity comes free where Disk had to work for it: a `put` buffers its body
 * and then replaces the row in one statement, so a reader mid-write sees the
 * previous blob and a failed body leaves the previous blob in place.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import {
  BlobNameError,
  createBlobLease,
  normalizeBlobName,
  SPACE_GUIDE_BLOB_NAMES,
} from '../../ports/blob.js';

import type { SqliteStoreContext } from './database.js';
import type {
  BlobInfo,
  BlobLease,
  BlobRange,
  BlobRead,
  BlobScope,
  BlobStore,
  SpaceBlobs,
} from '../../ports/blob.js';
import type { StorageHealth } from '../../ports/common.js';

type SpaceBlobArea = keyof SpaceBlobs;

/**
 * Names an area owns, or `null` when it owns whatever is put in it.
 *
 * The distinction is the port's, not this backend's: `guide` is bounded by a
 * fixed member list because on Disk it shares the Space root with records that
 * are not blobs. A table has no such neighbours, but the boundary is a
 * contract term — a name outside the set must be refused on every backend, or
 * a caller could write one where only one adapter accepts it.
 */
function areaMembers(area: SpaceBlobArea): readonly string[] | null {
  return area === 'guide' ? SPACE_GUIDE_BLOB_NAMES : null;
}

async function collect(body: Readable | Buffer): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

function decodeBytes(value: unknown, name: string): Buffer {
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  throw new SyntaxError(`Persisted blob ${JSON.stringify(name)} is not bytes`);
}

function decodeInfo(value: unknown): BlobInfo {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SyntaxError('Malformed persisted SQLite blob row');
  }
  const row = value as Record<string, unknown>;
  const name = row['name'];
  const size = row['size'];
  const updatedAt = row['updated_at'];
  if (typeof name !== 'string') {
    throw new SyntaxError('Invalid name in persisted SQLite blob');
  }
  if (typeof size !== 'number' || !Number.isFinite(size)) {
    throw new SyntaxError(`Invalid size for persisted blob ${name}`);
  }
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) {
    throw new SyntaxError(`Invalid updated_at for persisted blob ${name}`);
  }
  return { name, size, updatedAt };
}

class SqliteBlobScope implements BlobScope {
  readonly #context: SqliteStoreContext;
  readonly #workspaceId: string;
  readonly #canvasId: string;
  readonly #area: SpaceBlobArea;

  constructor(
    context: SqliteStoreContext,
    workspaceId: string,
    canvasId: string,
    area: SpaceBlobArea,
  ) {
    this.#context = context;
    this.#workspaceId = workspaceId;
    this.#canvasId = canvasId;
    this.#area = area;
  }

  /** Re-check the binding, exactly as a Disk scope re-checks its path. */
  #workspace(): string {
    return this.#context.assertBoundWorkspace(
      this.#workspaceId,
      `SQLite blob scope for Space "${this.#canvasId}"`,
    );
  }

  /** Refuse a name this area does not own, before it reaches the database. */
  #assertMember(name: string): string {
    const safe = normalizeBlobName(name);
    const members = areaMembers(this.#area);
    if (members && !members.includes(safe)) {
      throw new BlobNameError(
        `"${safe}" is not a member of the ${this.#area} area. ` +
          `It holds: ${members.join(', ')}.`,
      );
    }
    return safe;
  }

  #key(name: string): [string, string, string, string] {
    return [this.#workspace(), this.#canvasId, this.#area, name];
  }

  async put(name: string, body: Readable | Buffer): Promise<BlobInfo> {
    const safe = this.#assertMember(name);
    // Collect before touching the row: a body that fails mid-stream must
    // leave the previous blob exactly as it was, and a reader must never see
    // a prefix of the replacement.
    const bytes = await collect(body);
    const updatedAt = this.#context.now();
    this.#context
      .database()
      .prepare(
        `INSERT INTO blobs (
           workspace_id, canvas_id, area, name, bytes, size, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, canvas_id, area, name) DO UPDATE SET
           bytes = excluded.bytes,
           size = excluded.size,
           updated_at = excluded.updated_at`,
      )
      .run(...this.#key(safe), bytes, bytes.byteLength, updatedAt);
    return { name: safe, size: bytes.byteLength, updatedAt };
  }

  async head(name: string): Promise<BlobInfo | null> {
    const safe = this.#assertMember(name);
    const row = this.#context
      .database()
      .prepare(
        `SELECT name, size, updated_at
         FROM blobs
         WHERE workspace_id = ? AND canvas_id = ? AND area = ? AND name = ?`,
      )
      .get(...this.#key(safe));
    return row === undefined ? null : decodeInfo(row);
  }

  async open(name: string, range?: BlobRange): Promise<BlobRead | null> {
    const safe = this.#assertMember(name);
    const found = await this.#load(safe);
    if (found === null) return null;
    const { info, bytes } = found;
    // `info.size` stays the whole blob; the range only bounds the body, and
    // an over-long end is clamped the way a filesystem read stream clamps it.
    const start = Math.max(0, range?.start ?? 0);
    const end =
      range?.end === undefined
        ? bytes.byteLength - 1
        : Math.min(range.end, bytes.byteLength - 1);
    const slice =
      end < start ? Buffer.alloc(0) : bytes.subarray(start, end + 1);
    return { info, body: Readable.from([slice]) };
  }

  async read(name: string): Promise<Buffer | null> {
    const safe = this.#assertMember(name);
    return (await this.#load(safe))?.bytes ?? null;
  }

  async hasMany(names: readonly string[]): Promise<ReadonlySet<string>> {
    this.#workspace();
    const requested = new Set(names.map(normalizeBlobName));
    const members = areaMembers(this.#area);
    const wanted = [...requested].filter(
      (candidate) => !members || members.includes(candidate),
    );
    if (wanted.length === 0) return new Set();

    const placeholders = wanted.map(() => '?').join(', ');
    const rows = this.#context
      .database()
      .prepare(
        `SELECT name
         FROM blobs
         WHERE workspace_id = ? AND canvas_id = ? AND area = ?
           AND name IN (${placeholders})`,
      )
      .all(this.#workspace(), this.#canvasId, this.#area, ...wanted);
    return new Set(
      rows.map((row) => {
        const name = (row as Record<string, unknown>)['name'];
        if (typeof name !== 'string') {
          throw new SyntaxError('Invalid name in persisted SQLite blob');
        }
        return name;
      }),
    );
  }

  async list(): Promise<BlobInfo[]> {
    const members = areaMembers(this.#area);
    const rows = this.#context
      .database()
      .prepare(
        `SELECT name, size, updated_at
         FROM blobs
         WHERE workspace_id = ? AND canvas_id = ? AND area = ?
         ORDER BY name`,
      )
      .all(this.#workspace(), this.#canvasId, this.#area)
      .map(decodeInfo);
    return members ? rows.filter((info) => members.includes(info.name)) : rows;
  }

  async materialize(name: string): Promise<BlobLease | null> {
    const safe = this.#assertMember(name);
    const found = await this.#load(safe);
    if (found === null) return null;
    // No permanent path exists, so one is spooled for the life of the lease.
    // The directory is unique per lease, so the blob keeps its own name for
    // consumers that infer a type from the extension.
    const directory = await mkdtemp(path.join(tmpdir(), 'huabu-blob-'));
    const file = path.join(directory, safe);
    try {
      await writeFile(file, found.bytes);
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    return createBlobLease(file, async () => {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    });
  }

  async deleteAll(): Promise<void> {
    const members = areaMembers(this.#area);
    const database = this.#context.database();
    if (!members) {
      database
        .prepare(
          `DELETE FROM blobs
           WHERE workspace_id = ? AND canvas_id = ? AND area = ?`,
        )
        .run(this.#workspace(), this.#canvasId, this.#area);
      return;
    }
    const placeholders = members.map(() => '?').join(', ');
    database
      .prepare(
        `DELETE FROM blobs
         WHERE workspace_id = ? AND canvas_id = ? AND area = ?
           AND name IN (${placeholders})`,
      )
      .run(this.#workspace(), this.#canvasId, this.#area, ...members);
  }

  async #load(name: string): Promise<{ info: BlobInfo; bytes: Buffer } | null> {
    const row = this.#context
      .database()
      .prepare(
        `SELECT name, size, updated_at, bytes
         FROM blobs
         WHERE workspace_id = ? AND canvas_id = ? AND area = ? AND name = ?`,
      )
      .get(...this.#key(name));
    if (row === undefined) return null;
    const info = decodeInfo(row);
    return {
      info,
      bytes: decodeBytes((row as Record<string, unknown>)['bytes'], info.name),
    };
  }
}

export class SqliteBlobStore implements BlobStore {
  readonly kind = 'sqlite' as const;

  readonly #context: SqliteStoreContext;
  readonly #ownsContext: boolean;

  constructor(context: SqliteStoreContext, ownsContext = false) {
    this.#context = context;
    this.#ownsContext = ownsContext;
  }

  async init(): Promise<void> {
    if (this.#ownsContext) this.#context.init();
    else this.#context.assertOpen();
  }

  async health(): Promise<StorageHealth> {
    return this.#context.health(this.kind);
  }

  async close(): Promise<void> {
    if (this.#ownsContext) this.#context.close();
  }

  space(canvasId: string): SpaceBlobs {
    const workspaceId = this.#context.workspaceId();
    const scope = (area: SpaceBlobArea): BlobScope =>
      new SqliteBlobScope(this.#context, workspaceId, canvasId, area);
    return {
      artifacts: scope('artifacts'),
      guide: scope('guide'),
      memory: scope('memory'),
      uploads: scope('uploads'),
    };
  }
}
