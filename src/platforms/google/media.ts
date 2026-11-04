import { createHash } from "node:crypto";
import { safeFetchBytes } from "../../auth/ssrf";
import { ToolError } from "../../mcp/errors";

/**
 * Image handling for image assets. Google needs the image bytes (Asset.image_asset.data); the server downloads an https
 * image with the SSRF-safe fetcher, checks it against Google's published specs, and records its SHA-256 in the plan, so
 * the image uploaded at execution is byte-for-byte the one that was approved (a changed image is refused as drift).
 *
 * Specs from "Performance Max asset requirements" (developers.google.com/google-ads/api/performance-max/asset-requirements,
 * checked 2026-11-04): GIF, JPG or PNG, at most 5120 KB; aspect ratio and minimum size per field type below. Google
 * validates the aspect ratio when the image is linked (ASPECT_RATIO_NOT_ALLOWED); checking here fails earlier.
 */
export const MAX_IMAGE_BYTES = 5120 * 1024;
export const IMAGE_SPECS = {
  MARKETING_IMAGE: { ratio: 1.91, minW: 600, minH: 314, label: "landscape 1.91:1, at least 600x314" },
  SQUARE_MARKETING_IMAGE: { ratio: 1, minW: 300, minH: 300, label: "square 1:1, at least 300x300" },
  PORTRAIT_MARKETING_IMAGE: { ratio: 0.8, minW: 480, minH: 600, label: "portrait 4:5, at least 480x600" },
  LOGO: { ratio: 1, minW: 128, minH: 128, label: "square 1:1, at least 128x128" },
  LANDSCAPE_LOGO: { ratio: 4, minW: 512, minH: 128, label: "landscape 4:1, at least 512x128" },
} as const;
export type ImageFieldType = keyof typeof IMAGE_SPECS;
/** Aspect ratios may differ by +-1% (stated in the v26 DemandGenMultiAssetAdInfo reference for the same image types). */
const RATIO_TOLERANCE = 0.01;

export interface ImageInfo {
  mime: "IMAGE_PNG" | "IMAGE_JPEG" | "IMAGE_GIF";
  width: number;
  height: number;
  bytes: number;
  sha256: string;
}

/** Reads the type and pixel size from the file header (PNG IHDR, GIF logical screen, JPEG SOFn). */
export function imageInfo(b: Buffer): ImageInfo {
  const sha256 = createHash("sha256").update(b).digest("hex");
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString("ascii", 12, 16) === "IHDR") return { mime: "IMAGE_PNG", width: b.readUInt32BE(16), height: b.readUInt32BE(20), bytes: b.length, sha256 };
  if (b.length >= 10 && (b.toString("ascii", 0, 6) === "GIF87a" || b.toString("ascii", 0, 6) === "GIF89a")) return { mime: "IMAGE_GIF", width: b.readUInt16LE(6), height: b.readUInt16LE(8), bytes: b.length, sha256 };
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) break;
      const marker = b[i + 1]!;
      const len = b.readUInt16BE(i + 2);
      // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { mime: "IMAGE_JPEG", height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7), bytes: b.length, sha256 };
      i += 2 + len;
    }
    throw new ToolError("invalid_argument", "The JPEG has no readable frame header.");
  }
  throw new ToolError("invalid_argument", "Only PNG, JPEG and GIF images are supported.");
}

/** Problems with an image for a field type, empty when it meets the published spec. */
export function checkImage(info: ImageInfo, field: ImageFieldType): string[] {
  const s = IMAGE_SPECS[field];
  const out: string[] = [];
  if (info.bytes > MAX_IMAGE_BYTES) out.push(`file is ${Math.ceil(info.bytes / 1024)} KB; the limit is 5120 KB`);
  const ratio = info.width / info.height;
  if (Math.abs(ratio - s.ratio) / s.ratio > RATIO_TOLERANCE) out.push(`aspect ratio is ${ratio.toFixed(2)}:1; ${field} needs ${s.label}`);
  if (info.width < s.minW || info.height < s.minH) out.push(`size is ${info.width}x${info.height}; ${field} needs ${s.label}`);
  return out;
}

export type ImageFetcher = (url: string) => Promise<Buffer>;

/** Production fetcher: https only, public hosts, no redirects, 5120 KB cap, image content types only. */
export const fetchImageSafely: ImageFetcher = async (url) => {
  try {
    return (await safeFetchBytes(url, { accept: "image/png,image/jpeg,image/gif", contentTypes: ["image/png", "image/jpeg", "image/gif"], maxBytes: MAX_IMAGE_BYTES, timeoutMs: 15_000, userAgent: "ads-mcp-image-fetcher" })).bytes;
  } catch (e) {
    throw new ToolError("invalid_argument", `The image could not be downloaded: ${(e as Error).message}`);
  }
};

/** Downloads and checks an image for a field type; throws invalid_argument with every problem found. */
export async function prepareImage(fetcher: ImageFetcher, url: string, field: ImageFieldType): Promise<{ info: ImageInfo; data: string }> {
  const bytes = await fetcher(url);
  const info = imageInfo(bytes);
  const problems = checkImage(info, field);
  if (problems.length) throw new ToolError("invalid_argument", `The image at ${url} does not meet Google's ${field} spec: ${problems.join("; ")}.`);
  return { info, data: bytes.toString("base64") };
}
