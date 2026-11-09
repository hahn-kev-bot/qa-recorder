// Renders assets/icon.svg to assets/icon.png (512 px) and assets/icon.ico (16–256 px), using Chrome or Edge.
// Run after changing the SVG: node scripts/make-icon.mjs
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';

const assets = new URL('../assets/', import.meta.url);
const svg = await fs.readFile(new URL('icon.svg', assets), 'utf8');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const browser = await chromium.launch({ channel: 'msedge' }).catch(() => chromium.launch({ channel: 'chrome' }));
const page = await browser.newPage();
async function render(size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  return page.screenshot({ omitBackground: true });
}

await fs.writeFile(new URL('icon.png', assets), await render(512));
const images = [];
for (const size of ICO_SIZES) images.push({ size, png: await render(size) });
await browser.close();

// An .ico is a directory of images; Windows Vista and later read PNG entries directly.
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(images.length, 4);
let offset = 6 + 16 * images.length;
const entries = images.map(({ size, png }) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(size >= 256 ? 0 : size, 0); // 0 means 256
  e.writeUInt8(size >= 256 ? 0 : size, 1);
  e.writeUInt8(0, 2); // no palette
  e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4); // colour planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(png.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += png.length;
  return e;
});
await fs.writeFile(new URL('icon.ico', assets), Buffer.concat([header, ...entries, ...images.map(i => i.png)]));
console.log(`Wrote assets/icon.png and assets/icon.ico (${ICO_SIZES.join(', ')} px).`);
