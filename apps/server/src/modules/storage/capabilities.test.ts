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
      expect(capability.backends.length).toBeGreaterThan(0);
      // A capability nothing can serve is not a limitation, it is a removed
      // feature; a capability every backend serves does not belong here.
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
      expect(line).toContain('sqlite');
    }
  });
});
