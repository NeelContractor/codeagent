"use client";

import type { FileSystemTree, WebContainer } from "@webcontainer/api";
import { createTar, type TarEntryInput } from "@/lib/tar";

/**
 * Directories that are large, machine specific, or reconstructible.
 * WebContainer's own exporter drops them, which keeps a snapshot small and
 * fast; `npm install` brings them back on the next boot.
 *
 * The file tree hides the same names, so what you see in the editor is what
 * gets saved.
 */
export const HIDDEN_DIRECTORIES = ["node_modules", ".git", ".cache"] as const;

export function isHiddenDirectory(name: string): boolean {
  return (HIDDEN_DIRECTORIES as readonly string[]).includes(name);
}

export const SNAPSHOT_EXCLUDES = HIDDEN_DIRECTORIES.map(
  (name) => `**/${name}/**`,
);

export const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;

export type SnapshotResult = {
  tar: Uint8Array;
  fileCount: number;
  totalBytes: number;
};

const encoder = new TextEncoder();

/** Walk a `FileSystemTree` depth-first, collecting tar entries. */
function collect(
  tree: FileSystemTree,
  prefix: string,
  entries: TarEntryInput[],
  stats: { files: number; bytes: number },
): void {
  for (const [name, node] of Object.entries(tree)) {
    const path = prefix ? `${prefix}/${name}` : name;

    if ("directory" in node) {
      entries.push({ path, isDirectory: true });
      collect(node.directory, path, entries, stats);
      continue;
    }

    if ("file" in node && "contents" in node.file) {
      const contents =
        typeof node.file.contents === "string"
          ? encoder.encode(node.file.contents)
          : node.file.contents;

      stats.files += 1;
      stats.bytes += contents.byteLength;
      entries.push({ path, contents });
    }

    // SymlinkNode entries (file.symlink) are intentionally skipped: tar would
    // need the link target resolved, and mounted project trees rarely have any.
  }
}

/**
 * Snapshot the WebContainer filesystem as a standard tar archive.
 *
 * `wc.export` does the walking and honours the exclude globs, so the only
 * thing left to do is serialise its JSON tree into tar. WebContainer's own
 * `export` supports `json`, `binary`, and `zip` but not `tar`, which is why the
 * tree is re-serialised here instead of uploaded as-is.
 */
export async function tarWebContainer(
  wc: WebContainer,
  onProgress?: (files: number) => void,
): Promise<SnapshotResult> {
  const tree = await wc.export(".", {
    format: "json",
    excludes: [...SNAPSHOT_EXCLUDES],
  });

  const entries: TarEntryInput[] = [];
  const stats = { files: 0, bytes: 0 };

  collect(tree, "", entries, stats);

  onProgress?.(stats.files);

  const tar = createTar(entries);

  if (tar.byteLength > MAX_SNAPSHOT_BYTES) {
    throw new Error(
      `Snapshot is ${(tar.byteLength / 1024 / 1024).toFixed(1)} MB, over the ${
        MAX_SNAPSHOT_BYTES / 1024 / 1024
      } MB limit. Remove large files and try again.`,
    );
  }

  return { tar, fileCount: stats.files, totalBytes: stats.bytes };
}
