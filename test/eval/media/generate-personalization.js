// Dibujo sintético de una vaca para Q-03: sin fotos, letras ni datos personales.
import { deflateSync } from "node:zlib";
import { writeFile } from "node:fs/promises";
const width = 480, height = 480;
const rgba = Buffer.alloc((width * 4 + 1) * height);
const ellipse = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  let color = [237, 246, 230];
  if (ellipse(x, y, 130, 164, 60, 32) || ellipse(x, y, 350, 164, 60, 32)) color = [40, 42, 43];
  if (ellipse(x, y, 240, 245, 133, 143)) color = [40, 42, 43];
  if (ellipse(x, y, 240, 245, 127, 137)) color = [255, 255, 250];
  if ((x > 161 && x < 184 && y > 70 && y < 132) || (x > 296 && x < 319 && y > 70 && y < 132)) color = [202, 177, 128];
  if (ellipse(x, y, 172, 192, 40, 62) || ellipse(x, y, 296, 142, 43, 30)) color = [40, 42, 43];
  if (ellipse(x, y, 196, 236, 11, 16) || ellipse(x, y, 284, 236, 11, 16)) color = [24, 25, 26];
  if (ellipse(x, y, 240, 318, 95, 59)) color = [40, 42, 43];
  if (ellipse(x, y, 240, 318, 90, 54)) color = [239, 169, 175];
  if (ellipse(x, y, 211, 310, 12, 8) || ellipse(x, y, 269, 310, 12, 8)) color = [78, 54, 57];
  if (y >= 342 && y <= 345 && x >= 218 && x <= 262) color = [78, 54, 57];
  rgba.set([...color, 255], y * (width * 4 + 1) + 1 + x * 4);
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}
const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
await writeFile(new URL("q03-reference.png", import.meta.url), Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rgba)), chunk("IEND", Buffer.alloc(0)),
]));
