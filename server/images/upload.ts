import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { MAX_IMAGE_BYTES } from "./mime.js";

const execFileP = promisify(execFile);

// Photo upload safety for the app's image endpoint. This is a new attack
// surface, so the rules are strict:
//  - allowlist image types only (jpeg/png/webp/heic), nothing else;
//  - the TRUE type is sniffed from magic bytes — the client's Content-Type is
//    never trusted;
//  - hard size cap (MAX_IMAGE_BYTES, 10 MB) before and after any conversion;
//  - HEIC/HEIF (iPhone default) is converted to JPEG, since Claude vision can't
//    read HEIC; the stored blob is always a vision-compatible jpeg/png/webp;
//  - stored in Convex file storage under a Convex-generated opaque id (safe
//    filename, scoped store); the bytes are NEVER served back or executed.
// Storage growth is bounded by the existing image-retention janitor
// (BOOP_IMAGE_RETENTION_DAYS), which sweeps old message images.

export type UploadMediaType = "image/jpeg" | "image/png" | "image/webp" | "image/heic";
export type VisionMediaType = "image/jpeg" | "image/png" | "image/webp";

// Detect the real type from the leading bytes. Returns null for anything not on
// the allowlist (including disguised non-images).
export function sniffImageType(b: Buffer): UploadMediaType | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) {
    return "image/png";
  }
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  // ISO-BMFF / HEIF container: "....ftyp<brand>". Accept the HEIC/HEIF brands.
  if (b.toString("ascii", 4, 8) === "ftyp") {
    const brand = b.toString("ascii", 8, 12);
    const heic = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs", "mif1", "msf1"]);
    if (heic.has(brand)) return "image/heic";
  }
  return null;
}

export interface ProcessedUpload {
  ok: true;
  storageId: string;
  mediaType: VisionMediaType; // post-conversion, what the model receives
  originalType: UploadMediaType;
  converted: boolean;
  bytes: number;
}
export interface UploadFailure {
  ok: false;
  status: 413 | 415 | 500;
  reason: string;
}
export type UploadResult = ProcessedUpload | UploadFailure;

// Convert HEIC/HEIF to JPEG via macOS `sips` (no npm dep; the server already
// shells out to git/osascript). Temp files are 0600 and always cleaned up.
async function heicToJpeg(bytes: Buffer): Promise<Buffer> {
  const base = join(tmpdir(), `chief-up-${randomBytes(8).toString("hex")}`);
  const inPath = `${base}.heic`;
  const outPath = `${base}.jpg`;
  try {
    await writeFile(inPath, bytes, { mode: 0o600 });
    await execFileP("sips", ["-s", "format", "jpeg", inPath, "--out", outPath], { timeout: 15_000 });
    return await readFile(outPath);
  } finally {
    await unlink(inPath).catch(() => {});
    await unlink(outPath).catch(() => {});
  }
}

async function storeBytes(bytes: Buffer, mediaType: VisionMediaType): Promise<string> {
  const uploadUrl = await convex.mutation(api.messages.generateUploadUrl, {});
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": mediaType },
    // Blob is unambiguously a BodyInit (Buffer/Uint8Array aren't in this lib's type).
    body: new Blob([new Uint8Array(bytes)], { type: mediaType }),
  });
  if (!res.ok) throw new Error(`convex storage upload HTTP ${res.status}`);
  const json = (await res.json()) as { storageId?: string };
  if (!json.storageId) throw new Error("convex storage upload returned no storageId");
  return json.storageId;
}

// Validate, (convert), and store. Returns the storageId + the vision media type
// to hand to the turn, or a typed failure with the HTTP status to return.
export async function processImageUpload(bytes: Buffer): Promise<UploadResult> {
  if (!bytes || bytes.length === 0) return { ok: false, status: 415, reason: "empty body" };
  if (bytes.length > MAX_IMAGE_BYTES) {
    return { ok: false, status: 413, reason: `image too large (>${MAX_IMAGE_BYTES} bytes)` };
  }
  const sniffed = sniffImageType(bytes);
  if (!sniffed) {
    return { ok: false, status: 415, reason: "unrecognized or disallowed image (jpeg/png/webp/heic only)" };
  }

  try {
    let storeBuf = bytes;
    let storeType: VisionMediaType;
    let converted = false;
    if (sniffed === "image/heic") {
      storeBuf = await heicToJpeg(bytes);
      storeType = "image/jpeg";
      converted = true;
      if (storeBuf.length > MAX_IMAGE_BYTES) {
        return { ok: false, status: 413, reason: "converted image exceeds size cap" };
      }
    } else {
      storeType = sniffed; // jpeg | png | webp, already vision-compatible
    }
    const storageId = await storeBytes(storeBuf, storeType);
    return { ok: true, storageId, mediaType: storeType, originalType: sniffed, converted, bytes: storeBuf.length };
  } catch (err) {
    return { ok: false, status: 500, reason: err instanceof Error ? err.message : String(err) };
  }
}
