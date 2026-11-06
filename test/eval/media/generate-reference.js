// Fixture sintética: caja sin marcas, personas, texto ni datos del negocio.
import { deflateSync } from "node:zlib";
import { writeFile } from "node:fs/promises";
const width = 640, height = 480;
const rgba = Buffer.alloc((width * 4 + 1) * height);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  let color = [242, 239, 232];
  if (x >= 115 && x <= 527 && y >= 153 && y <= 350) color = [55, 58, 65];
  if (x >= 103 && x <= 539 && y >= 135 && y <= 183) color = [35, 38, 43];
  if (x >= 104 && x <= 538 && y >= 129 && y < 145) color = [80, 85, 95];
  if (x >= 128 && x <= 514 && y >= 191 && y <= 197) color = [90, 92, 97];
  if (x >= 117 && x <= 525 && y >= 349 && y <= 353) color = [27, 29, 33];
  const offset = y * (width * 4 + 1) + 1 + x * 4;
  rgba.set([...color, 255], offset);
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
await writeFile(new URL("p06-reference.png", import.meta.url), Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rgba)), chunk("IEND", Buffer.alloc(0)),
]));
