import { describe, expect, it } from "vitest";
import { MAX_IMAGE_BYTES, checkImage, imageInfo, prepareImage } from "../../platforms/google/media";
import { gif, jpeg, png } from "../support/images";

describe("image headers and Google's image specs", () => {
  it("reads PNG, JPEG and GIF sizes and hashes the bytes", () => {
    expect(imageInfo(png(1200, 628))).toMatchObject({ mime: "IMAGE_PNG", width: 1200, height: 628 });
    expect(imageInfo(jpeg(1200, 1200))).toMatchObject({ mime: "IMAGE_JPEG", width: 1200, height: 1200 });
    expect(imageInfo(gif(512, 128))).toMatchObject({ mime: "IMAGE_GIF", width: 512, height: 128 });
    expect(imageInfo(png(10, 10)).sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => imageInfo(Buffer.from("<svg/>"))).toThrow(/PNG, JPEG and GIF/);
  });

  it("checks aspect ratio, minimum size and file size per field type", () => {
    expect(checkImage(imageInfo(png(1200, 628)), "MARKETING_IMAGE")).toEqual([]);
    expect(checkImage(imageInfo(png(1200, 1200)), "MARKETING_IMAGE")[0]).toContain("aspect ratio");
    expect(checkImage(imageInfo(png(200, 200)), "SQUARE_MARKETING_IMAGE")[0]).toContain("at least 300x300");
    expect(checkImage(imageInfo(png(960, 1200)), "PORTRAIT_MARKETING_IMAGE")).toEqual([]);
    expect(checkImage(imageInfo(png(1200, 300)), "LANDSCAPE_LOGO")).toEqual([]);
    expect(checkImage(imageInfo(png(128, 128)), "LOGO")).toEqual([]);
    expect(checkImage({ ...imageInfo(png(1200, 1200)), bytes: MAX_IMAGE_BYTES + 1 }, "LOGO")[0]).toContain("5120 KB");
  });

  it("prepareImage returns base64 data or explains every problem", async () => {
    const ok = await prepareImage(async () => png(1200, 1200), "https://cdn.example/sq.png", "SQUARE_MARKETING_IMAGE");
    expect(Buffer.from(ok.data, "base64").equals(png(1200, 1200))).toBe(true);
    await expect(prepareImage(async () => png(100, 50), "https://cdn.example/x.png", "LOGO")).rejects.toMatchObject({ code: "invalid_argument", message: expect.stringMatching(/aspect ratio.*size is 100x50/) });
  });
});
