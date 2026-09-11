// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, expect, it } from 'vitest';

import {
  activateWorkspace,
  createNamedWorkspace,
  getWorldCanvasId,
} from './storage.js';
import { mountTestWorkspace, type MountedTestStorage } from './testing.js';
import {
  acquireWorkspaceOperationLease,
  getWorkspaceHandle,
  WorkspaceOperationInProgressError,
} from '../workspace.js';

let mounted: MountedTestStorage | null = null;

afterEach(async () => {
  await mounted?.close();
  mounted = null;
});

it('keeps SQLite scope and World identity unchanged when a lease refuses activation', async () => {
  mounted = await mountTestWorkspace({
    structured: { kind: 'sqlite' },
    blobs: { kind: 'disk' },
  });
  const original = getWorkspaceHandle();
  const originalWorld = getWorldCanvasId();
  const spaces = mounted.storage.structured.spaces();
  expect(
    (await spaces.create({ canvasId: 'original-space', title: 'Original' })).ok,
  ).toBe(true);
  const target = await createNamedWorkspace('Target');
  const lease = acquireWorkspaceOperationLease();

  try {
    expect(lease.workspaceKey).toBe(`workspace:${original?.workspaceId}`);
    await expect(activateWorkspace(target)).rejects.toThrow(
      WorkspaceOperationInProgressError,
    );
    expect(getWorkspaceHandle()).toEqual(original);
    expect(getWorldCanvasId()).toBe(originalWorld);
    // Both retained handles and newly resolved handles must still serve the
    // original Workspace; checking only process identity misses a split scope.
    expect((await spaces.list()).map((space) => space.canvasId)).toEqual([
      'original-space',
    ]);
    expect(
      (await mounted.storage.structured.spaces().list()).map(
        (space) => space.canvasId,
      ),
    ).toEqual(['original-space']);
  } finally {
    lease.release();
  }

  await activateWorkspace(target);
  expect(getWorkspaceHandle()).toEqual(target);
  expect(await mounted.storage.structured.spaces().list()).toEqual([]);
  expect(getWorldCanvasId()).not.toBe(originalWorld);
});
