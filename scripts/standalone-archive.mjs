import assert from "node:assert/strict";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

const TAR_BLOCK_BYTES = 512;

function octal(value, bytes) {
  const encoded = value.toString(8).padStart(bytes - 1, "0");
  assert.ok(encoded.length < bytes, `Tar value ${value} does not fit in ${bytes} bytes`);
  return `${encoded}\0`;
}

function splitTarPath(path) {
  if (Buffer.byteLength(path) !== path.length) return undefined;
  if (path.length <= 100) return { name: path, prefix: "" };
  for (let index = path.lastIndexOf("/"); index > 0; index = path.lastIndexOf("/", index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (prefix.length <= 155 && name.length <= 100) return { name, prefix };
  }
  return undefined;
}

function writeField(header, offset, bytes, value) {
  const encoded = Buffer.from(value);
  assert.ok(encoded.length <= bytes, `Tar field is too long: ${value}`);
  encoded.copy(header, offset);
}

export function createTarHeader({ path, bytes, mode, type, link = "" }) {
  const parts = splitTarPath(path);
  assert.ok(parts, `Tar header path requires a PAX record: ${path}`);
  const { name, prefix } = parts;
  assert.ok(Buffer.byteLength(link) <= 100, `Tar link is too long: ${link}`);
  const header = Buffer.alloc(TAR_BLOCK_BYTES);
  writeField(header, 0, 100, name);
  writeField(header, 100, 8, octal(mode, 8));
  writeField(header, 108, 8, octal(0, 8));
  writeField(header, 116, 8, octal(0, 8));
  writeField(header, 124, 12, octal(bytes, 12));
  writeField(header, 136, 12, octal(0, 12));
  header.fill(0x20, 148, 156);
  writeField(header, 156, 1, type);
  writeField(header, 157, 100, link);
  writeField(header, 257, 6, "ustar\0");
  writeField(header, 263, 2, "00");
  writeField(header, 265, 32, "root");
  writeField(header, 297, 32, "root");
  writeField(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeField(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function paxRecord(name, value) {
  const body = ` ${name}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) {
    length = String(length).length + Buffer.byteLength(body);
  }
  return Buffer.from(`${length}${body}`);
}

async function listEntries(root, archiveRoot) {
  const entries = [];
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const absolute = join(directory, name);
      const metadata = await lstat(absolute);
      const path = `${archiveRoot}/${relative(root, absolute).split(sep).join("/")}`;
      if (metadata.isDirectory()) {
        entries.push({ absolute, path: `${path}/`, metadata, type: "5" });
        await visit(absolute);
      } else if (metadata.isFile()) {
        entries.push({ absolute, path, metadata, type: "0" });
      } else if (metadata.isSymbolicLink()) {
        const link = await readlink(absolute);
        const target = resolve(dirname(absolute), link);
        const targetRelative = relative(root, target);
        assert.ok(targetRelative !== ".." && !targetRelative.startsWith(`..${sep}`) && !isAbsolute(targetRelative),
          `Standalone archive symlink escapes its payload: ${absolute}`);
        entries.push({ absolute, path, metadata, type: "2", link });
      } else {
        throw new Error(`Unsupported standalone archive entry: ${absolute}`);
      }
    }
  }
  entries.push({ absolute: root, path: `${archiveRoot}/`, metadata: await lstat(root), type: "5" });
  await visit(root);
  return entries;
}

export async function createStandaloneArchive(source, archivePath, archiveRoot) {
  assert.equal(basename(archiveRoot), archiveRoot, "Standalone archive root must be a basename");
  const root = resolve(source);
  const entries = await listEntries(root, archiveRoot);
  async function* blocks() {
    for (const [index, entry] of entries.entries()) {
      const bytes = entry.type === "0" ? entry.metadata.size : 0;
      const mode = entry.type === "5" ? 0o755 : (entry.metadata.mode & 0o111) === 0 ? 0o644 : 0o755;
      const pax = [];
      if (splitTarPath(entry.path) === undefined) pax.push(paxRecord("path", entry.path));
      if (entry.link !== undefined && Buffer.byteLength(entry.link) > 100) pax.push(paxRecord("linkpath", entry.link));
      if (pax.length > 0) {
        const contents = Buffer.concat(pax);
        yield createTarHeader({
          path: `PaxHeaders/${String(index).padStart(8, "0")}`,
          bytes: contents.length,
          mode: 0o644,
          type: "x",
        });
        yield contents;
        const paxPadding = (TAR_BLOCK_BYTES - (contents.length % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
        if (paxPadding > 0) yield Buffer.alloc(paxPadding);
      }
      yield createTarHeader({
        path: splitTarPath(entry.path) === undefined ? `entry-${String(index).padStart(8, "0")}` : entry.path,
        bytes,
        mode,
        type: entry.type,
        link: entry.link !== undefined && Buffer.byteLength(entry.link) <= 100 ? entry.link : "",
      });
      if (entry.type !== "0") continue;
      for await (const chunk of createReadStream(entry.absolute)) yield chunk;
      const padding = (TAR_BLOCK_BYTES - (bytes % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
      if (padding > 0) yield Buffer.alloc(padding);
    }
    yield Buffer.alloc(TAR_BLOCK_BYTES * 2);
  }
  await pipeline(Readable.from(blocks()), createGzip({ level: 9, mtime: 0 }), createWriteStream(archivePath, { mode: 0o600 }));
}
