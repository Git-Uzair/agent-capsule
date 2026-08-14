import { ZipFile } from "yazl";
import { fromBuffer, type Entry } from "yauzl";
import { CapsuleError } from "../core/errors.ts";

/**
 * Capsule identity is the bytes of the container, so packing must be a pure function of the
 * entries. Two yazl details make that harder than it looks:
 *
 *  - `dateToDosDateTime` reads the mtime with local-time getters (`getFullYear`, `getHours`, …),
 *    so a UTC instant encodes differently in every timezone. `new Date(1980, 0, 1)` is local
 *    midnight, which encodes as DOS 1980-01-01 00:00:00 everywhere — the same bytes the DOS
 *    epoch is meant to produce.
 *  - unless `forceDosTimestamp` is set, yazl also appends an Info-ZIP "UT" extra field holding
 *    the mtime as a Unix instant, which puts the packer's UTC offset back into the file.
 *
 * Verified this session: with both settings the container hashes identically under TZ=UTC,
 * Asia/Kolkata, America/New_York and Pacific/Kiritimati; with either one alone it does not.
 */
const EPOCH = new Date(1980, 0, 1);

const MAX_ENTRIES = 4096;
const MAX_ENTRY = 32 * 1024 * 1024;
const MAX_TOTAL = 64 * 1024 * 1024;
const MAX_PATH = 256;
const LEGAL = /^(capsule\.json|(src|ui|data|\.capsule)\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*)$/;

export type CapsuleEntry = { path: string; data: Uint8Array };

export type CapsuleReader = {
  list(): string[];
  has(path: string): boolean;
  read(path: string): Promise<Buffer>;
};

function fail(message: string, detail: Record<string, unknown> = {}): never {
  throw new CapsuleError("E_CONTAINER", message, detail);
}

/**
 * The one gate on entry names: an allowlist of the four capsule directories plus the manifest.
 * Absolute paths, backslashes and empty segments all fall out of the pattern, but the character
 * class matches `.` and `..` as whole segments, so both are rejected by name. `..` is traversal;
 * `.` is worse than it looks — extractors normalise it away (`Expand-Archive` writes `src/./a.js`
 * to `src\a.js`), so allowing it lets one container hold two entries this reader calls distinct
 * that unpack over each other.
 */
export function assertLegalPath(path: string): void {
  const dotted = (segment: string): boolean => segment === "." || segment === "..";
  if (path.length > MAX_PATH || !LEGAL.test(path) || path.split("/").some(dotted)) {
    fail(`illegal entry path: ${path}`, { path });
  }
}

export async function packEntries(entries: CapsuleEntry[]): Promise<Buffer> {
  if (entries.length > MAX_ENTRIES) {
    fail(`too many entries: ${entries.length} > ${MAX_ENTRIES}`, { count: entries.length });
  }
  const seen = new Set<string>();
  let total = 0;
  for (const entry of entries) {
    assertLegalPath(entry.path);
    if (seen.has(entry.path)) fail(`duplicate entry: ${entry.path}`, { path: entry.path });
    seen.add(entry.path);
    if (entry.data.byteLength > MAX_ENTRY) {
      fail(`entry too large: ${entry.path}`, { path: entry.path, size: entry.data.byteLength });
    }
    total += entry.data.byteLength;
  }
  if (total > MAX_TOTAL) fail(`payload too large: ${total} > ${MAX_TOTAL}`, { total });

  const zip = new ZipFile();
  for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    zip.addBuffer(Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength), entry.path, {
      mtime: EPOCH,
      mode: 0o100644,
      compress: false,
      forceDosTimestamp: true,
    });
  }
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Containers are small and every caller reads most of them, so decode eagerly: no file handles
 * to leak, no lazy error paths, and `list`/`has` stay synchronous.
 */
export async function openContainer(bytes: Buffer): Promise<CapsuleReader> {
  const files = await readAll(bytes);
  return {
    list: () => [...files.keys()].sort(),
    has: (path) => files.has(path),
    read: async (path) => {
      const found = files.get(path);
      if (!found) fail(`no such entry: ${path}`, { path });
      return found;
    },
  };
}

/**
 * yauzl enumerates exactly as many central directory records as the EOCD's count field claims, so
 * records past that count never reach the gates below — while an extractor that walks the
 * directory by its declared *size* (python's `zipfile` does) reads them as ordinary files. Reading
 * the declared size back out lets the reader prove every directory byte belongs to a record it
 * checked. Same backwards scan yauzl does (yauzl/index.js:154): the last signature in the file
 * wins, and yauzl has already rejected the buffer if the comment length disagreed with it.
 *
 * A zip64 container keeps its real size in the zip64 EOCD and leaves 0xffffffff here, so it fails
 * this check; nothing inside the 4096-entry / 64 MiB limits needs zip64 to begin with.
 */
function declaredCentralDirectorySize(bytes: Buffer): number {
  const floor = Math.max(0, bytes.length - (0xffff + 42));
  for (let at = bytes.length - 22; at >= floor; at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50) return bytes.readUInt32LE(at + 12);
  }
  fail("unreadable container: no end of central directory record");
}

function readAll(bytes: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    // Read up front: a throw in the executor rejects the promise, while a throw from inside a
    // yauzl callback would escape as an uncaught exception.
    const declaredDirectoryBytes = declaredCentralDirectorySize(bytes);
    // `validateEntrySizes` makes yauzl abort a stream that does not match its declared
    // uncompressed size, which is what stops a lying central directory from smuggling a bomb
    // past the size checks below. DEFLATE stays readable so third-party capsules load.
    fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (err, zip) => {
      if (err || !zip) {
        return reject(new CapsuleError("E_CONTAINER", `unreadable container: ${err?.message ?? "not a zip"}`));
      }
      const files = new Map<string, Buffer>();
      let total = 0;
      let directoryBytes = 0;
      let settled = false;
      const abort = (cause: unknown): void => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(cause);
      };
      const abortWith = (message: string, detail: Record<string, unknown> = {}): void => {
        abort(new CapsuleError("E_CONTAINER", message, detail));
      };

      if (zip.entryCount > MAX_ENTRIES) {
        return abortWith(`too many entries: ${zip.entryCount} > ${MAX_ENTRIES}`, { count: zip.entryCount });
      }

      zip.on("entry", (entry: Entry) => {
        if (settled) return;
        // Record sizes are 46 bytes of fixed header plus the three variable fields (APPNOTE 4.3.12).
        directoryBytes += 46 + entry.fileNameLength + entry.extraFieldLength + entry.fileCommentLength;
        if (entry.fileName.endsWith("/")) return zip.readEntry(); // directory record, no data
        try {
          assertLegalPath(entry.fileName);
        } catch (cause) {
          return abort(cause);
        }
        // Two entries with one name leave "which bytes are signed?" to the unzipper.
        if (files.has(entry.fileName)) {
          return abortWith(`duplicate entry: ${entry.fileName}`, { path: entry.fileName });
        }
        if (entry.uncompressedSize > MAX_ENTRY) {
          return abortWith(`entry too large: ${entry.fileName}`, {
            path: entry.fileName,
            size: entry.uncompressedSize,
          });
        }
        total += entry.uncompressedSize;
        if (total > MAX_TOTAL) return abortWith(`payload too large: ${total} > ${MAX_TOTAL}`, { total });

        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) return abortWith(`unreadable entry: ${entry.fileName}`);
          const parts: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => parts.push(chunk));
          stream.on("end", () => {
            if (settled) return;
            files.set(entry.fileName, Buffer.concat(parts));
            zip.readEntry();
          });
          stream.on("error", (cause: Error) => {
            abortWith(`unreadable entry: ${entry.fileName}: ${cause.message}`);
          });
        });
      });
      zip.on("end", () => {
        if (settled) return;
        const declared = declaredDirectoryBytes;
        if (directoryBytes !== declared) {
          return abortWith(
            `central directory not fully accounted for: read ${directoryBytes} of ${declared} bytes`,
            { read: directoryBytes, declared },
          );
        }
        settled = true;
        resolve(files);
      });
      zip.on("error", (cause: Error) => abortWith(`unreadable container: ${cause.message}`));
      zip.readEntry();
    });
  });
}
