// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Which product features a storage profile can actually serve.
 *
 * Some features are *about* a filesystem — showing a folder in Finder,
 * adopting a document a user dropped in from outside, a bundle that is a
 * directory zipped up. A backend that keeps Spaces in tables has no honest
 * answer for them, and the honest outcome is that the feature is
 * **unavailable, not emulated** (proposal §6.4.2, disposition A). A
 * workaround that makes such a feature *nearly* work is worse than its
 * absence: it has to be built, tested, and explained, and it hides the
 * limitation instead of stating it.
 *
 * "Stated" is what this file is for. An outcome of A is an acceptable product
 * limitation only if an operator can learn it when they select a profile
 * rather than when a user clicks the button — so the matrix sits beside
 * profile validation, which is the one place a profile is inspected before
 * anything opens.
 *
 * This is a *declaration*, not an enforcement point. Each listed feature also
 * refuses at its own call site, because a matrix nobody consults at runtime is
 * documentation. What the matrix adds is the up-front answer.
 */

import type { StructuredBackendKind } from './ports/structured.js';
import type { StorageProfile } from './profile.js';

/**
 * A product feature whose availability depends on the structured backend.
 *
 * Keyed by structured kind alone: every entry here needs a Space to be a real
 * directory, which is a structured-backend property.
 *
 * Four of them need slightly more than that — they need the Space's *bytes* to
 * be in that directory too. Bundle export archives the folder, bundle import
 * unzips into it, reveal-in-file-manager shows it, and the built-in file tools
 * sandbox on it; a Space whose artifacts had been relocated elsewhere would
 * export as an incomplete bundle rather than fail. Today that is free: the one
 * blob backend is a file system, and composition places a Space's bytes inside
 * its directory whenever it has one (`storage.ts::buildBlobStore`). A blob
 * backend that *cannot* co-locate — an object store — would break the
 * implication, and those four rows would then have to be keyed on the profile
 * rather than on the structured kind. That is the second matrix this comment
 * used to say did not exist; it does not exist yet.
 */
export interface StorageCapability {
  /** Stable id, for a diagnostic an operator can search for. */
  readonly id: string;
  /** What a user loses, in their vocabulary rather than the port's. */
  readonly summary: string;
  /** Structured backends that serve it. */
  readonly backends: readonly StructuredBackendKind[];
  /** Why it cannot be served elsewhere, and what remains instead. */
  readonly rationale: string;
}

/**
 * Every feature that is not available on every backend.
 *
 * Deliberately not "every feature" — a matrix that listed the portable ones
 * too would need updating whenever anything was built, and would go stale
 * silently. What must stay accurate is the exception list.
 */
export const STORAGE_CAPABILITIES: readonly StorageCapability[] = [
  {
    id: 'space-bundle-export',
    summary: 'Export a Space as a .huabu.zip bundle',
    backends: ['disk'],
    rationale:
      'The bundle is a Disk projection — the Space directory, archived. A ' +
      'portable export generated from records plus reachable blob references ' +
      'is a separate design.',
  },
  {
    id: 'space-bundle-import',
    summary: 'Import a Space from a .huabu.zip bundle',
    backends: ['disk'],
    rationale: 'Pairs with export; unzips into place.',
  },
  {
    id: 'reveal-space-folder',
    summary: 'Reveal a Space in the OS file manager',
    backends: ['disk'],
    rationale:
      'The feature is "show me this in Finder". Without a folder there is ' +
      'nothing to show.',
  },
  {
    id: 'builtin-file-tools',
    summary: 'Built-in agent file tools (read, write, glob, grep)',
    backends: ['disk'],
    rationale:
      'They sandbox on the Space directory. Off Disk the first-party agent ' +
      'reads and writes nodes through the Canvas tools instead, which is ' +
      'the portable surface it already prefers for structured edits.',
  },
  {
    id: 'space-file-plane',
    summary: 'Reach a Space as files over RFS, the plane external agents mount',
    backends: ['disk'],
    rationale:
      'RFS projects the Space directory over HTTP — the same tree, reachable ' +
      'from another machine. It is listed apart from the built-in file tools ' +
      'because it is what those tools were said to fall back to: a Space ' +
      'with no file plane has neither, and an external agent bound to a ' +
      'Space on this backend reaches it through the Canvas API.',
  },
  {
    id: 'external-note-discovery',
    summary: 'Adopt Markdown files dropped into a Space from outside the app',
    backends: ['disk'],
    rationale:
      'It watches for documents that arrived without going through the ' +
      'application. A database backend has no such arrival path unless ' +
      'someone writes to the store out of band, and inventing one would buy ' +
      'nothing.',
  },
  {
    id: 'workspace-directory',
    summary: 'Choose, create, or reveal a Workspace folder on this machine',
    backends: ['disk'],
    rationale:
      'A Workspace is a folder the user picks. Where Workspaces are rows, ' +
      'there is nothing to browse to: the Server opens its own on first ' +
      'start and Workspaces are managed by name instead of by path.',
  },
  {
    id: 'workspace-user-memory',
    summary: 'The cross-Space user memory document (setting/user.md)',
    backends: ['disk'],
    rationale:
      'A user-editable file at the Workspace root, deliberately outside any ' +
      'Space so it applies to all of them. Every blob scope this port has is ' +
      "scoped to a Space, so there is nowhere it belongs yet; a Space's own " +
      'memory body is unaffected.',
  },
  {
    id: 'workspace-user-skills',
    summary: 'User-authored skills under the Workspace setting/skills folder',
    backends: ['disk'],
    rationale:
      'Skills are read as files a user can edit and drop in by hand, which ' +
      'is the same arrival path external notes rely on. Bundled and Agent ' +
      'Team skills are unaffected.',
  },
  {
    id: 'space-directory-handle-coordination',
    summary: 'Windows: rename or delete a Space while a watcher holds it open',
    backends: ['disk'],
    rationale:
      'Exists so a directory rename can succeed against a live `fs.watch` ' +
      'handle. No directory, no problem.',
  },
];

/** Capabilities this profile cannot serve. */
export function unavailableCapabilities(
  profile: StorageProfile,
): readonly StorageCapability[] {
  return STORAGE_CAPABILITIES.filter(
    (capability) =>
      !(capability.backends as readonly string[]).includes(
        profile.structured.kind,
      ),
  );
}

/** Whether this profile serves `id`. Unknown ids are available by omission. */
export function hasStorageCapability(
  profile: StorageProfile,
  id: string,
): boolean {
  const capability = STORAGE_CAPABILITIES.find((entry) => entry.id === id);
  if (!capability) return true;
  return (capability.backends as readonly string[]).includes(
    profile.structured.kind,
  );
}

/**
 * The refusal a Disk-only feature raises when it finds no Space directory.
 *
 * Shares its wording with the startup declaration, so the sentence an
 * operator read when they chose the profile is the sentence they see in the
 * failure. A feature that phrased its own refusal would drift from the
 * matrix, and the drift would only show up in a support thread.
 */
export function unavailableCapabilityMessage(id: string): string {
  const capability = STORAGE_CAPABILITIES.find((entry) => entry.id === id);
  if (!capability) {
    return `Storage capability "${id}" is not available on this backend.`;
  }
  return (
    `${capability.summary} is not available on this storage backend ` +
    `(capability "${capability.id}"). ${capability.rationale}`
  );
}

/**
 * One operator-facing line per feature this profile does not offer.
 *
 * Rendered at startup rather than raised: an unavailable feature is a stated
 * limitation, not a misconfiguration, so it must not stop the Server. The
 * distinction matters — a profile naming an unimplemented backend *is* a
 * misconfiguration and still fails fast in `validateStorageProfile`.
 */
export function describeUnavailableCapabilities(
  profile: StorageProfile,
): readonly string[] {
  return unavailableCapabilities(profile).map(
    (capability) =>
      `${capability.id}: ${capability.summary} — unavailable on the ` +
      `"${profile.structured.kind}" structured backend. ${capability.rationale}`,
  );
}
