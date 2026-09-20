// Regenerates electron/build/icon.png (app icon; electron-builder derives .icns/.ico from it) and the
// tray PNGs from a geometric "A" glyph — no fonts involved, so output is identical on every machine.
// Brand rules: square corners (no rounding), dark #0a110d, green #00c876.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const buildDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'build');
const trayDir = path.join(buildDir, 'tray');

const A_PATH = 'M50 12 L86 88 H70 L61 68 H39 L30 88 H14 Z M44 56 H56 L50 40 Z';
const BG = '#0a110d';
const GREEN = '#00c876';
const RED = '#ff3b3b';
const AMBER = '#f0b429';

const square = (bg, fg) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="${bg}"/><path d="${A_PATH}" fill="${fg}" fill-rule="evenodd"/></svg>`;
const glyph = (fg) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="${A_PATH}" fill="${fg}" fill-rule="evenodd"/></svg>`;

async function render(svg, size, file) {
  await sharp(Buffer.from(svg), { density: 400 }).resize(size, size).png().toFile(file);
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}

await fs.mkdir(trayDir, { recursive: true });
await fs.writeFile(path.join(buildDir, 'icon.svg'), square(BG, GREEN));
await render(square(BG, GREEN), 1024, path.join(buildDir, 'icon.png'));

// Windows/Linux tray: filled squares read clearly at 16 px on any taskbar color.
await render(square(BG, GREEN), 32, path.join(trayDir, 'tray-idle.png'));
await render(square(RED, '#ffffff'), 32, path.join(trayDir, 'tray-recording.png'));
await render(square(AMBER, BG), 32, path.join(trayDir, 'tray-transcribing.png'));

// macOS menu bar: idle is a template glyph (the system recolors it); status variants keep their color.
await render(glyph('#000000'), 16, path.join(trayDir, 'trayTemplate.png'));
await render(glyph('#000000'), 32, path.join(trayDir, 'trayTemplate@2x.png'));
await render(glyph(RED), 16, path.join(trayDir, 'tray-recording-mac.png'));
await render(glyph(RED), 32, path.join(trayDir, 'tray-recording-mac@2x.png'));
await render(glyph(AMBER), 16, path.join(trayDir, 'tray-transcribing-mac.png'));
await render(glyph(AMBER), 32, path.join(trayDir, 'tray-transcribing-mac@2x.png'));
