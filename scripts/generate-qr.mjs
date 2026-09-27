import { deflateSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';

const [address, outputPath] = process.argv.slice(2);
if (!address || !outputPath || !address.startsWith('https://')) {
  throw new Error('Usage: node generate-qr.mjs <https-url> <output-png>');
}

// Version 5-L fits the short HTTPS URLs used by Cloudflare Quick Tunnels.
const version = 5;
const size = version * 4 + 17;
const dataCodewords = 108;
const eccCodewords = 26;
const matrix = Array.from({ length: size }, () => Array(size).fill(false));
const functionModules = Array.from({ length: size }, () => Array(size).fill(false));

function setFunction(x, y, dark) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  matrix[y][x] = dark;
  functionModules[y][x] = true;
}

function drawFinder(centerX, centerY) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      setFunction(centerX + dx, centerY + dy, distance !== 2 && distance !== 4);
    }
  }
}

drawFinder(3, 3);
drawFinder(size - 4, 3);
drawFinder(3, size - 4);

for (let i = 8; i < size - 8; i++) {
  setFunction(6, i, i % 2 === 0);
  setFunction(i, 6, i % 2 === 0);
}

for (let dy = -2; dy <= 2; dy++) {
  for (let dx = -2; dx <= 2; dx++) {
    setFunction(30 + dx, 30 + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
}

function formatBits(mask) {
  const data = (1 << 3) | mask; // Error correction level L.
  let remainder = data << 10;
  while (remainder !== 0 && Math.floor(Math.log2(remainder)) >= 10) {
    remainder ^= 0x537 << (Math.floor(Math.log2(remainder)) - 10);
  }
  return ((data << 10) | remainder) ^ 0x5412;
}

function drawFormat(mask) {
  const bits = formatBits(mask);
  for (let i = 0; i <= 5; i++) setFunction(8, i, ((bits >>> i) & 1) !== 0);
  setFunction(8, 7, ((bits >>> 6) & 1) !== 0);
  setFunction(8, 8, ((bits >>> 7) & 1) !== 0);
  setFunction(7, 8, ((bits >>> 8) & 1) !== 0);
  for (let i = 9; i < 15; i++) setFunction(14 - i, 8, ((bits >>> i) & 1) !== 0);
  for (let i = 0; i < 8; i++) setFunction(size - 1 - i, 8, ((bits >>> i) & 1) !== 0);
  for (let i = 8; i < 15; i++) setFunction(8, size - 15 + i, ((bits >>> i) & 1) !== 0);
  setFunction(8, size - 8, true);
}

drawFormat(0);

function appendBits(target, value, count) {
  for (let i = count - 1; i >= 0; i--) target.push((value >>> i) & 1);
}

const bytes = Buffer.from(address, 'utf8');
if (bytes.length > 106) throw new Error('The HTTPS address is too long for this QR generator.');
const bits = [];
appendBits(bits, 0b0100, 4);
appendBits(bits, bytes.length, 8);
for (const byte of bytes) appendBits(bits, byte, 8);
const capacity = dataCodewords * 8;
appendBits(bits, 0, Math.min(4, capacity - bits.length));
while (bits.length % 8) bits.push(0);
const data = [];
for (let i = 0; i < bits.length; i += 8) {
  data.push(bits.slice(i, i + 8).reduce((value, bit) => (value << 1) | bit, 0));
}
for (let pad = 0; data.length < dataCodewords; pad++) data.push(pad % 2 === 0 ? 0xec : 0x11);

function gfMultiply(left, right) {
  let product = 0;
  for (let i = 0; i < 8; i++) {
    if (right & 1) product ^= left;
    const high = left & 0x80;
    left = (left << 1) & 0xff;
    if (high) left ^= 0x1d;
    right >>>= 1;
  }
  return product;
}

let generator = [1];
let root = 1;
for (let i = 0; i < eccCodewords; i++) {
  const next = Array(generator.length + 1).fill(0);
  generator.forEach((coefficient, index) => {
    next[index] ^= coefficient;
    next[index + 1] ^= gfMultiply(coefficient, root);
  });
  generator = next;
  root = gfMultiply(root, 2);
}
const remainder = [...data, ...Array(eccCodewords).fill(0)];
for (let i = 0; i < data.length; i++) {
  const factor = remainder[i];
  if (factor) generator.forEach((coefficient, index) => { remainder[i + index] ^= gfMultiply(coefficient, factor); });
}
const codewords = [...data, ...remainder.slice(data.length)];

let bitIndex = 0;
for (let right = size - 1; right >= 1; right -= 2) {
  if (right === 6) right = 5;
  for (let vertical = 0; vertical < size; vertical++) {
    const y = ((right + 1) & 2) === 0 ? size - 1 - vertical : vertical;
    for (let offset = 0; offset < 2; offset++) {
      const x = right - offset;
      if (functionModules[y][x]) continue;
      const bit = bitIndex < codewords.length * 8
        ? ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0
        : false;
      matrix[y][x] = bit !== ((x + y) % 2 === 0); // Mask pattern 0.
      bitIndex++;
    }
  }
}
drawFormat(0);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, payload) {
  const name = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([name, payload]);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([header, name, payload, checksum]);
}

const scale = 12;
const quiet = 4;
const dimension = (size + quiet * 2) * scale;
const raw = Buffer.alloc((dimension * 3 + 1) * dimension, 255);
for (let y = 0; y < dimension; y++) {
  const rowStart = y * (dimension * 3 + 1);
  raw[rowStart] = 0;
  const moduleY = Math.floor(y / scale) - quiet;
  for (let x = 0; x < dimension; x++) {
    const moduleX = Math.floor(x / scale) - quiet;
    if (moduleX < 0 || moduleY < 0 || moduleX >= size || moduleY >= size || !matrix[moduleY][moduleX]) continue;
    const pixelStart = rowStart + 1 + x * 3;
    raw[pixelStart] = 0;
    raw[pixelStart + 1] = 0;
    raw[pixelStart + 2] = 0;
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(dimension, 0);
ihdr.writeUInt32BE(dimension, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  pngChunk('IHDR', ihdr),
  pngChunk('IDAT', deflateSync(raw)),
  pngChunk('IEND', Buffer.alloc(0)),
]);
await writeFile(outputPath, png);
