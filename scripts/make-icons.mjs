// 확장 아이콘(PNG)을 의존성 없이 생성한다. 실행: node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/extension/public/icons');
mkdirSync(outDir, { recursive: true });

const BG = [23, 25, 29];
const FG = [242, 242, 242];
const ACCENT = [216, 87, 87];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size) {
  const bars = [0.34, 0.62, 0.9, 0.62, 0.34];
  const barWidth = Math.max(1, Math.round(size * 0.08));
  const gap = Math.max(1, Math.round(size * 0.06));
  const totalWidth = bars.length * barWidth + (bars.length - 1) * gap;
  const startX = Math.round((size - totalWidth) / 2);
  const radius = size * 0.22;

  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 3 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      // 둥근 사각형 배경
      const dx = Math.max(radius - x, 0, x - (size - 1 - radius));
      const dy = Math.max(radius - y, 0, y - (size - 1 - radius));
      let color = dx * dx + dy * dy > radius * radius ? null : BG;

      if (color) {
        for (let b = 0; b < bars.length; b += 1) {
          const bx = startX + b * (barWidth + gap);
          if (x < bx || x >= bx + barWidth) continue;
          const height = Math.round(size * bars[b] * 0.62);
          const top = Math.round((size - height) / 2);
          if (y >= top && y < top + height) color = b === 2 ? ACCENT : FG;
        }
      }

      const offset = rowStart + 1 + x * 3;
      if (color) {
        raw[offset] = color[0];
        raw[offset + 1] = color[1];
        raw[offset + 2] = color[2];
      } else {
        // 투명 대신 배경색을 살짝 어둡게 둬 모서리를 자연스럽게 만든다
        raw[offset] = 17;
        raw[offset + 1] = 18;
        raw[offset + 2] = 20;
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

for (const size of [16, 32, 48, 128]) {
  const file = path.join(outDir, `icon-${size}.png`);
  writeFileSync(file, png(size));
  console.log(`생성: ${file}`);
}
