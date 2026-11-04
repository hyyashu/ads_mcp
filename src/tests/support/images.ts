/** Minimal synthetic image files: valid headers with the given pixel size (enough for header parsing and size checks). */
export function png(w: number, h: number, padTo = 64): Buffer {
  const b = Buffer.alloc(Math.max(33, padTo));
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
export function gif(w: number, h: number): Buffer {
  const b = Buffer.alloc(16);
  b.write("GIF89a", 0, "ascii");
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
}
export function jpeg(w: number, h: number): Buffer {
  // SOI, an APP0 segment, then SOF0 with height and width.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}
