// 由 assets/icon.svg 產生圖示：assets/app.ico（啟動程式 exe 用）、public/icon.png 與 public/icon-32.png（視窗與工作列用）
// 用法：npm run icon（需要 Chrome 或 Edge，用無頭模式把 SVG 畫成各種尺寸的 PNG；不需要安裝其他套件）
// 改完圖示後再執行 npm run build-launcher，把新圖示編進 AI 酒館.exe
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const SVG = path.join(ROOT, 'assets', 'icon.svg');
const ICO = path.join(ROOT, 'assets', 'app.ico');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]; // Windows 在各種顯示縮放下會挑最接近的尺寸

function findBrowser() {
  const env = process.env.TAVERN_BROWSER;
  if (env && fs.existsSync(env)) return env;
  const bases = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const cands = [
    ...bases.map(b => path.join(b, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    ...bases.map(b => path.join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
  ];
  return cands.find(p => fs.existsSync(p)) || null;
}

/** 用無頭瀏覽器把 SVG 畫成 size × size 的透明背景 PNG。overlay(size)：疊在圖示上的 HTML（可省略），tag 用來區分暫存檔 */
function render(browser, tmp, size, { overlay = null, tag: name = 'icon' } = {}) {
  const tag = `${name}-${size}`;
  const html = path.join(tmp, `${tag}.html`);
  const out = path.join(tmp, `${tag}.png`);
  const extra = overlay ? overlay(size) : '';
  fs.writeFileSync(html, `<!doctype html><html><body style="margin:0;background:transparent"><div style="position:relative;width:${size}px;height:${size}px">`
    + `<img src="${pathToFileURL(SVG).href}" style="width:${size}px;height:${size}px;display:block">${extra}</div></body></html>`);
  execFileSync(browser, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--force-device-scale-factor=1', '--default-background-color=00000000',
    `--window-size=${size},${size}`, `--user-data-dir=${path.join(tmp, 'profile')}`,
    `--screenshot=${out}`, pathToFileURL(html).href,
  ], { stdio: 'ignore', timeout: 60000 });
  const png = fs.readFileSync(out);
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  if (w !== size || h !== size) throw new Error(`畫出來的尺寸不對：要 ${size}，得到 ${w}×${h}`);
  return png;
}

/** 把多張 PNG 包成一個 .ico（Windows Vista 以後支援直接內嵌 PNG） */
function toIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ size, png }, i) => {
    const e = i * 16;
    dir[e] = size >= 256 ? 0 : size; dir[e + 1] = size >= 256 ? 0 : size; // 0 代表 256
    dir[e + 2] = 0; dir[e + 3] = 0;
    dir.writeUInt16LE(1, e + 4); dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(png.length, e + 8); dir.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...images.map(x => x.png)]);
}

/** 畫出所有尺寸（每張印出進度），回傳 [{ size, png }] */
function renderAll(browser, tmp, opts, label = '') {
  return SIZES.map(size => { process.stdout.write(`  ${label}${size}px…`); const png = render(browser, tmp, size, opts); console.log(' 完成'); return { size, png }; });
}

/** 找瀏覽器、建暫存資料夾，跑完 fn(browser, tmp) 後清掉 */
function withBrowser(fn) {
  const browser = findBrowser();
  if (!browser) { console.error('找不到 Chrome 或 Edge，無法產生圖示（可以用環境變數 TAVERN_BROWSER 指定瀏覽器路徑）'); process.exit(1); }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-icon-'));
  try { return fn(browser, tmp); } finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); }
}

module.exports = { ROOT, SIZES, render, renderAll, toIco, withBrowser };

if (require.main === module) withBrowser((browser, tmp) => {
  const images = renderAll(browser, tmp);
  fs.writeFileSync(ICO, toIco(images));
  fs.writeFileSync(path.join(ROOT, 'public', 'icon.png'), images.find(x => x.size === 256).png);
  fs.writeFileSync(path.join(ROOT, 'public', 'icon-32.png'), images.find(x => x.size === 32).png);
  console.log(`
已產生 assets/app.ico、public/icon.png、public/icon-32.png`);
});
