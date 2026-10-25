import {
  BlobReader,
  BlobWriter,
  configure,
  type Entry,
  Uint8ArrayWriter,
  ZipReader,
} from "@zip.js/zip.js";

/**
 * Reads Notion export zips in place. zip.js reads the central directory and
 * then only the entries asked for, straight from the File, so a multi-GB
 * export is never loaded whole. Large workspaces come split into parts, and
 * sometimes as a zip of zips: nested zips are opened the same way.
 *
 * No web workers (the CSP has no worker-src for blobs); decompression uses the
 * browser's native DecompressionStream.
 */
configure({ useWebWorkers: false });

export interface ExportFile {
  /** Path inside the export, "/"-separated, without a leading "/". */
  path: string;
  size: number;
  bytes(): Promise<Uint8Array<ArrayBuffer>>;
  text(): Promise<string>;
}

const decoder = new TextDecoder();

function fileOf(entry: Entry, path: string): ExportFile {
  const bytes = async () => {
    if (entry.directory) throw new Error("Not a file");
    return entry.getData(new Uint8ArrayWriter());
  };
  return {
    path,
    size: entry.uncompressedSize,
    bytes,
    text: async () => decoder.decode(await bytes()),
  };
}

const isZip = (name: string) => /\.zip$/i.test(name);

async function readZip(blob: Blob, out: ExportFile[], depth: number): Promise<void> {
  const reader = new ZipReader(new BlobReader(blob));
  const entries = await reader.getEntries();
  for (const entry of entries) {
    if (entry.directory) continue;
    const path = entry.filename.replace(/\\/g, "/").replace(/^\/+/, "");
    // macOS archive litter.
    if (path.startsWith("__MACOSX/") || /(^|\/)\.DS_Store$/.test(path)) continue;
    if (isZip(path) && depth < 3) {
      // A part of a split export. Unpacked to a Blob, which browsers may keep on disk.
      if (entry.directory) continue;
      const inner = await entry.getData(new BlobWriter("application/zip"));
      await readZip(inner, out, depth + 1);
      continue;
    }
    out.push(fileOf(entry, path));
  }
}

/** Every file in the given zips (and zips inside them), by path. */
export async function readExport(files: Blob[]): Promise<ExportFile[]> {
  const out: ExportFile[] = [];
  for (const f of files) await readZip(f, out, 0);
  return out;
}
