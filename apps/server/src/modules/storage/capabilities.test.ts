// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The capability matrix (proposal §6.4.2, disposition A).
 *
 * What is worth asserting is not the contents — those change as features do —
 * but that the matrix stays a *declaration an operator can act on*: every
 * entry names a backend that exists, the Disk profile loses nothing, and an
 * unavailable feature is reported rather than raised.
 */

import { describe, expect, it } from 'vitest';

import {
  describeUnavailableCapabilities,
  hasStorageCapability,
  STORAGE_CAPABILITIES,
  unavailableCapabilities,
} from './capabilities.js';
import { validateStorageProfile } from './profile.js';

import type { StorageProfile } from './profile.js';

const DISK: StorageProfile = {
  structured: { kind: 'disk' },
  blobs: { kind: 'disk' },
};

/** The profile that keeps Spaces in tables and their bytes in files. */
const TABLES: StorageProfile = {
  structured: { kind: 'sqlite' },
  blobs: { kind: 'disk' },
};

describe('storage capability matrix', () => {
  it('lists only real, identifiable capabilities', () => {
    const ids = STORAGE_CAPABILITIES.map((capability) => capability.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const capability of STORAGE_CAPABILITIES) {
      // A capability nothing can serve is not a limitation, it is a removed
      // feature; one that names no axis at all is served everywhere and does
      // not belong on an exception list.
      const axes = [capability.structured, capability.blobs].filter(
        (axis) => axis !== undefined,
      );
      expect(axes.length).toBeGreaterThan(0);
      for (const axis of axes) expect(axis.length).toBeGreaterThan(0);
      expect(capability.summary).not.toHaveLength(0);
      expect(capability.rationale).not.toHaveLength(0);
    }
  });

  it('offers every capability on the Disk profile', () => {
    expect(unavailableCapabilities(DISK)).toEqual([]);
    expect(describeUnavailableCapabilities(DISK)).toEqual([]);
  });

  it('answers for the backend that keeps Spaces in tables', () => {
    const missing = unavailableCapabilities(TABLES);

    // Every entry is Disk-only today, so a structured backend that is not
    // Disk loses all of them. The assertion is the shape, not the count.
    //
    // `TABLES` pairs SQLite records with Disk *bytes*, which is the profile
    // this deployment actually runs, so this is also the answer to "does a
    // real file system for bytes give any of these back". It does not: every
    // entry needs the Space's record and node documents to be files, and
    // those are rows whatever holds the bytes.
    expect(missing).toEqual(STORAGE_CAPABILITIES);
    expect(hasStorageCapability(TABLES, 'reveal-space-folder')).toBe(false);
    expect(hasStorageCapability(DISK, 'reveal-space-folder')).toBe(true);
  });

  /**
   * The reason the matrix is keyed on the profile rather than on one axis.
   *
   * `disk`/`azure` has no adapter and `validateStorageProfile` would refuse
   * it, which is exactly why it is the right shape to assert against: the
   * matrix must already answer correctly for the pairing before anyone can
   * select it. Records are files here and Spaces are real directories — a
   * structured-only matrix would call the bundle exportable, and it would
   * archive a Space folder whose artifacts had never been written to it.
   */
  it('takes the bundle with a blob backend that cannot co-locate', () => {
    const OFFSITE_BYTES: StorageProfile = {
      structured: { kind: 'disk' },
      blobs: { kind: 'azure' },
    };

    expect(hasStorageCapability(OFFSITE_BYTES, 'space-bundle-export')).toBe(
      false,
    );
    expect(hasStorageCapability(OFFSITE_BYTES, 'space-bundle-import')).toBe(
      false,
    );
    expect(hasStorageCapability(OFFSITE_BYTES, 'builtin-file-tools')).toBe(
      false,
    );
    expect(hasStorageCapability(OFFSITE_BYTES, 'space-file-plane')).toBe(false);

    // What survives: the Space folder still holds the record and the node
    // documents, so showing it to a user is still showing them the Space, and
    // a note dropped into `nodes/` still arrives. Those rows name no blob
    // axis, which is how they say they do not care where the bytes went.
    expect(hasStorageCapability(OFFSITE_BYTES, 'reveal-space-folder')).toBe(
      true,
    );
    expect(hasStorageCapability(OFFSITE_BYTES, 'external-note-discovery')).toBe(
      true,
    );
    expect(hasStorageCapability(OFFSITE_BYTES, 'workspace-directory')).toBe(
      true,
    );
  });

  it('treats an unknown id as available rather than guessing', () => {
    // The matrix is an exception list. A feature nobody wrote down is
    // portable by construction, and inventing a refusal for it would make
    // adding a portable feature a matrix edit.
    expect(hasStorageCapability(TABLES, 'something-portable')).toBe(true);
  });

  it('reports capability gaps without making them a misconfiguration', () => {
    // The two gates are separate on purpose. A profile that offers fewer
    // features is a stated limitation and must still start; only a profile
    // that cannot serve at all is rejected. Conflating them would refuse a
    // legitimate deployment.
    expect(describeUnavailableCapabilities(TABLES).length).toBeGreaterThan(0);
    expect(() => validateStorageProfile(TABLES)).not.toThrow();
    expect(() => validateStorageProfile(DISK)).not.toThrow();
  });

  it('describes each loss in operator terms', () => {
    const lines = describeUnavailableCapabilities(TABLES);

    for (const capability of STORAGE_CAPABILITIES) {
      const line = lines.find((entry) => entry.startsWith(`${capability.id}:`));
      expect(line).toBeDefined();
      // The id to search for, what is lost, and why it cannot be emulated.
      expect(line).toContain(capability.summary);
      // The whole profile, because a row may be unavailable for either axis.
      expect(line).toContain('sqlite/disk');
    }
  });
});
