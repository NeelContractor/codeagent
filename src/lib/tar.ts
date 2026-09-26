const BLOCK_SIZE = 512;

export type TarEntryInput = {
  path: string;
  contents?: Uint8Array;
  isDirectory?: boolean;
  mode?: number;
  mtimeSeconds?: number;
};

export type TarEntry = {
  path: string;
  contents: Uint8Array;
  isDirectory: boolean;
  mode: number;
};

import type { FileSystemTree } from "@webcontainer/api";

function encodeOctal(value: number, length: number): Uint8Array {
  // ustar numeric fields are zero-padded octal, NUL terminated.
  const text = value.toString(8).padStart(length - 1, "0");
  const bytes = new Uint8Array(length);
  for (let i = 0; i < text.length && i < length - 1; i += 1) {
    bytes[i] = text.charCodeAt(i);
  }

  return bytes;
}

function writeString(
  block: Uint8Array,
  offset: number,
  text: string,
  length: number,
): void {
  for (let i = 0; i < length; i += 1) {
    const code = i < text.length ? text.charCodeAt(i) : 0;
    block[offset + i] = code === 0 ? 0 : code;
  }
}

function checksum(block: Uint8Array): number {
  let sum = 0;

  for (let i = 0; i < BLOCK_SIZE; i += 1) {
    // The checksum field itself is treated as spaces.
    sum += i >= 148 && i < 156 ? 0x20 : block[i];
  }

  return sum;
}

function splitName(path: string): { prefix: string; name: string } | null {
  if (path.length <= 100) {
    return { prefix: "", name: path };
  }

  // ustar splits long paths on a "/" boundary into a 155-byte prefix
  // plus a 100-byte name.
  for (let i = path.length - 101; i < 155; i += 1) {
    if (path[i] === "/" && path.length - i - 1 <= 100) {
      return { prefix: path.slice(0, i), name: path.slice(i + 1) };
    }
  }

  return null;
}

function buildHeader(options: {
  name: string;
  prefix: string;
  size: number;
  mode: number;
  mtimeSeconds: number;
  typeFlag: string;
}): Uint8Array {
  const block = new Uint8Array(BLOCK_SIZE);

  writeString(block, 0, options.name, 100);
  block.set(encodeOctal(options.mode & 0o7777, 8), 100);
  block.set(encodeOctal(0, 8), 108);
  block.set(encodeOctal(0, 8), 116);
  block.set(encodeOctal(options.size, 12), 124);
  block.set(encodeOctal(options.mtimeSeconds, 12), 136);
  writeString(block, 156, options.typeFlag, 1);
  writeString(block, 257, "ustar", 6);
  writeString(block, 263, "00", 2);
  writeString(block, 265, "root", 32);
  writeString(block, 297, "root", 32);
  block.set(encodeOctal(0, 8), 329);
  block.set(encodeOctal(0, 8), 337);
  writeString(block, 345, options.prefix, 155);

  const sum = checksum(block);
  const octal = sum.toString(8).padStart(6, "0");
  writeString(block, 148, octal, 7);
  block[155] = 0x20;

  return block;
}

function paxRecord(keyword: string, value: string): Uint8Array {
  // "<len> <keyword>=<value>\n" where <len> includes its own digits.
  const body = ` ${keyword}=${value}\n`;
  let length = body.length + 1;

  for (;;) {
    const candidate = `${length}${body}`;
    if (candidate.length === length) {
      return new TextEncoder().encode(candidate);
    }
    length = candidate.length;
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;

  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }

  return output;
}

function pad(size: number): Uint8Array {
  const remainder = size % BLOCK_SIZE;
  return remainder === 0
    ? new Uint8Array(0)
    : new Uint8Array(BLOCK_SIZE - remainder);
}

export function createTar(entries: TarEntryInput[]): Uint8Array {
  const defaultMtime = Math.floor(Date.now() / 1000);
  const parts: Uint8Array[] = [];

  for (const entry of entries) {
    const isDirectory = entry.isDirectory === true;
    const contents = isDirectory
      ? new Uint8Array(0)
      : (entry.contents ?? new Uint8Array(0));
    const mode = entry.mode ?? (isDirectory ? 0o755 : 0o644);
    const mtime = entry.mtimeSeconds ?? defaultMtime;
    const typeFlag = isDirectory ? "5" : "0";
    const split = splitName(entry.path);

    if (split) {
      parts.push(
        buildHeader({
          name: split.name,
          prefix: split.prefix,
          size: contents.length,
          mode,
          mtimeSeconds: mtime,
          typeFlag,
        }),
      );
    } else {
      // Path too long for ustar: emit a PAX extended header carrying the
      // real path, then a placeholder ustar header.
      const record = paxRecord("path", entry.path);
      parts.push(
        buildHeader({
          name: "PaxHeader",
          prefix: "",
          size: record.length,
          mode: 0o644,
          mtimeSeconds: mtime,
          typeFlag: "x",
        }),
        record,
        pad(record.length),
        buildHeader({
          name: entry.path.slice(-100),
          prefix: "",
          size: contents.length,
          mode,
          mtimeSeconds: mtime,
          typeFlag,
        }),
      );
    }

    if (contents.length > 0) {
      parts.push(contents, pad(contents.length));
    }
  }

  parts.push(new Uint8Array(BLOCK_SIZE * 2));

  return concat(parts);
}

function readString(view: DataView, offset: number, length: number): string {
  let out = "";

  for (let i = 0; i < length; i += 1) {
    const code = view.getUint8(offset + i);
    if (code === 0) {
      break;
    }
    out += String.fromCharCode(code);
  }

  return out;
}

function readOctal(view: DataView, offset: number, length: number): number {
  const text = readString(view, offset, length).trim();

  if (text.length === 0) {
    return 0;
  }

  const parsed = Number.parseInt(text, 8);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function isZeroBlock(bytes: Uint8Array, offset: number): boolean {
  for (let i = 0; i < BLOCK_SIZE; i += 1) {
    if (bytes[offset + i] !== 0) {
      return false;
    }
  }

  return true;
}

export function extractTar(bytes: Uint8Array): TarEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const entries: TarEntry[] = [];
  let offset = 0;
  let paxPath: string | null = null;

  while (offset + BLOCK_SIZE <= bytes.length) {
    if (isZeroBlock(bytes, offset)) {
      break;
    }

    const name = readString(view, offset, 100);
    const size = readOctal(view, offset + 124, 12);
    const mode = readOctal(view, offset + 100, 8);
    const typeFlag = readString(view, offset + 156, 1) || "0";
    const prefix = readString(view, offset + 345, 155);
    const dataStart = offset + BLOCK_SIZE;

    if (typeFlag === "x" || typeFlag === "X") {
      const record = decoder.decode(
        bytes.subarray(dataStart, dataStart + size),
      );
      const match = /\d+ path=([^\n]*)\n/.exec(record);
      paxPath = match ? match[1] : null;
      offset = dataStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
      continue;
    }

    if (typeFlag === "L") {
      const longName = decoder
        .decode(bytes.subarray(dataStart, dataStart + size))
        .replace(/\0+$/, "");
      offset = dataStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;

      // The next header is the real entry; stash the name for it.
      const nextView = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      const nextSize = readOctal(nextView, offset + 124, 12);
      const nextType = readString(nextView, offset + 156, 1) || "0";
      const nextStart = offset + BLOCK_SIZE;
      entries.push({
        path: longName,
        contents: bytes.slice(nextStart, nextStart + nextSize),
        isDirectory: nextType === "5",
        mode: readOctal(nextView, offset + 100, 8),
      });
      paxPath = null;
      offset = nextStart + Math.ceil(nextSize / BLOCK_SIZE) * BLOCK_SIZE;
      continue;
    }

    if (typeFlag === "g") {
      offset = dataStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
      continue;
    }

    const fullPath = paxPath ?? (prefix ? `${prefix}/${name}` : name);
    paxPath = null;

    if (typeFlag === "0" || typeFlag === " " || typeFlag === "5") {
      entries.push({
        path: fullPath,
        contents:
          typeFlag === "5"
            ? new Uint8Array(0)
            : bytes.slice(dataStart, dataStart + size),
        isDirectory: typeFlag === "5" || fullPath.endsWith("/"),
        mode,
      });
    }

    offset = dataStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
  }

  return entries;
}

function normalizePath(path: string): string {
  return path.replace(/^\.?\//, "").replace(/\/+$/, "");
}

type TreeNode = {
  directories: Map<string, TreeNode>;
  files: Map<string, Uint8Array>;
};

function makeNode(): TreeNode {
  return { directories: new Map(), files: new Map() };
}

/**
 * Convert a tar archive into the shape `WebContainer.mount()` expects:
 * a flat map of top-level entries, each either
 * `{ file: { contents } }` or `{ directory: { … } }`.
 */
export function tarToFileSystemTree(bytes: Uint8Array): FileSystemTree {
  const root = makeNode();

  for (const entry of extractTar(bytes)) {
    const segments = normalizePath(entry.path)
      .split("/")
      .filter((segment) => segment.length > 0 && segment !== ".");

    if (segments.length === 0 || segments.includes("..")) {
      continue;
    }

    let cursor = root;

    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i];
      let next = cursor.directories.get(segment);

      if (!next) {
        next = makeNode();
        cursor.directories.set(segment, next);
      }

      cursor = next;
    }

    const leaf = segments[segments.length - 1];

    if (entry.isDirectory) {
      if (!cursor.directories.has(leaf)) {
        cursor.directories.set(leaf, makeNode());
      }
    } else {
      cursor.files.set(leaf, entry.contents);
    }
  }

  const render = (node: TreeNode): FileSystemTree => {
    const out: FileSystemTree = {};

    for (const [name, contents] of node.files) {
      out[name] = { file: { contents } };
    }

    for (const [name, child] of node.directories) {
      out[name] = { directory: render(child) };
    }

    return out;
  };

  return render(root);
}

/**
 * Counts regular files in a tar archive by walking header blocks only, so a
 * server can validate an upload without materialising every file body.
 *
 * Throws if the archive is not a well-formed ustar/PAX stream.
 */
export function countTarFileEntries(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let files = 0;
  let sawEntry = false;

  while (offset + BLOCK_SIZE <= bytes.length) {
    if (isZeroBlock(bytes, offset)) {
      break;
    }

    const name = readString(view, offset, 100);
    const size = readOctal(view, offset + 124, 12);
    const typeFlag = readString(view, offset + 156, 1) || "0";
    const prefix = readString(view, offset + 345, 155);
    const dataStart = offset + BLOCK_SIZE;

    // Skip metadata-only records (PAX headers, GNU long names, global headers).
    if (typeFlag === "x" || typeFlag === "X" || typeFlag === "L") {
      offset = dataStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
      continue;
    }

    if (typeFlag === "g") {
      offset = dataStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
      continue;
    }

    if (typeFlag !== "0" && typeFlag !== " " && typeFlag !== "5") {
      throw new Error(
        `Unsupported tar entry type "${typeFlag}" for ${prefix ? `${prefix}/${name}` : name}.`,
      );
    }

    const isDirectory = typeFlag === "5" || name.endsWith("/");
    if (!isDirectory) {
      files += 1;
    }

    sawEntry = true;
    offset = dataStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
  }

  if (!sawEntry) {
    throw new Error("Not a valid tar archive: no entries found.");
  }

  return files;
}
