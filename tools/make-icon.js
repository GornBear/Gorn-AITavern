// 由 assets/icon.svg 產生圖示：assets/app.ico（啟動程式 exe 用）、public/icon.png 與 public/icon-32.png（視窗與工作列用），
// 以及 assets/packager.ico（打包工具 exe 用：同一個圖示，右下角加上扳手，和程式本體區分）
// 只重新產生打包工具的圖示：node tools/make-icon.js packager
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
const PACKAGER_ICO = path.join(ROOT, 'assets', 'packager.ico');
// 扳手徽章：淺色圓底＋深藍扳手（Lucide 的 wrench 圖形），放在右下角
const WRENCH = '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>';
const badgeSvg = () => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%">'
  + '<circle cx="12" cy="12" r="11.2" fill="#eef2ff" stroke="#0b1435" stroke-width="1.4"/>'
  + '<g transform="translate(12 12) scale(0.68) translate(-12 -12)" fill="none" stroke="#16245e" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">'
  + WRENCH + '</g></svg>';
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

/** 用無頭瀏覽器把 SVG 畫成 size × size 的透明背景 PNG */
function render(browser, tmp, size, { badge = false } = {}) {
  const tag = `${badge ? 'pk' : 'icon'}-${size}`;
  const html = path.join(tmp, `${tag}.html`);
  const out = path.join(tmp, `${tag}.png`);
  // 小尺寸時徽章佔比大一點，不然看不出是扳手
  const b = Math.round(size * (size <= 24 ? 0.62 : size <= 48 ? 0.54 : 0.48));
  const badgeHtml = badge ? `<div style="position:absolute;right:0;bottom:0;width:${b}px;height:${b}px">${badgeSvg()}</div>` : '';
  fs.writeFileSync(html, `<!doctype html><html><body style="margin:0;background:transparent"><div style="position:relative;width:${size}px;height:${size}px">`
    + `<img src="${pathToFileURL(SVG).href}" style="width:${size}px;height:${size}px;display:block">${badgeHtml}</div></body></html>`);
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

const browser = findBrowser();
if (!browser) { console.error('找不到 Chrome 或 Edge，無法產生圖示（可以用環境變數 TAVERN_BROWSER 指定瀏覽器路徑）'); process.exit(1); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-icon-'));
const onlyPackager = process.argv.includes('packager');
try {
  if (!onlyPackager) {
    const images = SIZES.map(size => { process.stdout.write(`  ${size}px…`); const png = render(browser, tmp, size); console.log(' 完成'); return { size, png }; });
    fs.writeFileSync(ICO, toIco(images));
    fs.writeFileSync(path.join(ROOT, 'public', 'icon.png'), images.find(x => x.size === 256).png);
    fs.writeFileSync(path.join(ROOT, 'public', 'icon-32.png'), images.find(x => x.size === 32).png);
    console.log(`\n已產生 assets/app.ico、public/icon.png、public/icon-32.png`);
  }
  const pk = SIZES.map(size => { process.stdout.write(`  打包工具 ${size}px…`); const png = render(browser, tmp, size, { badge: true }); console.log(' 完成'); return { size, png }; });
  fs.writeFileSync(PACKAGER_ICO, toIco(pk));
  console.log('已產生 assets/packager.ico（接著執行 npm run build-packager 把它編進打包工具.exe）');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
