// 以「應用程式模式」啟動：開伺服器 → 用 Edge / Chrome 的 --app 開獨立視窗 → 視窗關閉時結束伺服器
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { ready, WINDOW_FILE, lastHeartbeat, shutdown } = require('./server');

/** 結束伺服器：先停下生成並存好已產生的內容、做一次備份（最多等 10 秒），再結束 */
let exiting = false;
async function exitServer(code = 0) {
  if (exiting) return;
  exiting = true;
  setTimeout(() => process.exit(code), 10000).unref(); // 收尾卡住也一定會結束
  try { await shutdown(); } catch (e) { console.warn('  結束前收尾失敗：', e.message || e); }
  process.exit(code);
}
process.on('SIGINT', () => exitServer(0)); // start.bat 按 Ctrl+C：一樣先收尾再結束
// 直接按主控台視窗的 ✕（Windows 會送 SIGHUP，大約幾秒後強制結束）、Ctrl+Break、系統要求結束：一樣先存好正在生成的內容、做關閉前的備份
for (const sig of ['SIGHUP', 'SIGBREAK', 'SIGTERM']) { try { process.on(sig, () => exitServer(0)); } catch { /* 這個平台沒有這個訊號 */ } }

// 瀏覽器設定檔是程式執行時的快取，不是玩家存檔，所以留在 data/（不放進 userdata/）
const PROFILE = process.env.TAVERN_PROFILE_DIR ? path.resolve(process.env.TAVERN_PROFILE_DIR) : path.join(__dirname, 'data', 'app-profile');

/** 上次視窗的位置與大小（視窗裡的頁面會回報給伺服器存到 data/window.json）；第一次啟動用預設大小 */
function windowArgs() {
  try {
    const w = JSON.parse(fs.readFileSync(WINDOW_FILE, 'utf8'));
    if ([w.x, w.y, w.w, w.h].every(Number.isFinite) && w.w >= 300 && w.h >= 200) {
      // 有指定大小時瀏覽器會忽略 --start-maximized，所以最大化時只給位置（決定開在哪個螢幕）
      if (w.max) return ['--start-maximized'];
      return [`--window-position=${w.x},${w.y}`, `--window-size=${w.w},${w.h}`];
    }
  } catch { /* 還沒有記錄 */ }
  return ['--window-size=1280,860'];
}

function findBrowser() {
  const env = process.env.TAVERN_BROWSER;
  if (env && fs.existsSync(env)) return env;
  const cands = [];
  if (process.platform === 'win32') {
    const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
    // 優先使用 Chrome，找不到才用 Edge
    for (const base of pf) cands.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    for (const base of pf) cands.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  } else if (process.platform === 'darwin') {
    cands.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
      try { cands.push(execSync(`command -v ${bin}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()); } catch { }
    }
  }
  return cands.find(p => p && fs.existsSync(p)) || null;
}

function openDefaultBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref();
}

(async () => {
  const { url, existing } = await ready;
  const browser = findBrowser();
  if (!browser) {
    console.log('  找不到 Edge 或 Chrome，改用預設瀏覽器開啟。');
    openDefaultBrowser(url);
    if (existing) process.exit(0);
    return;
  }

  fs.mkdirSync(PROFILE, { recursive: true });
  const args = [
    `--app=${url}/?app=1`, // ?app=1：讓頁面知道自己在應用程式視窗裡，才回報視窗位置
    `--user-data-dir=${PROFILE}`, // 獨立設定檔：與平常的瀏覽器分開，視窗關閉時程序才會真的結束
    ...windowArgs(), // 還原上次關閉時的位置、大小與是否最大化
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
    // 視窗縮小或被擋住時也不要放慢計時器：「視窗還開著」的訊號才能每 10 秒準時送到（見下方，伺服器靠它判斷何時結束）
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    // 只能有一個 --disable-features，全部寫在這裡；OptimizationGuide…／OptimizationHints：不下載 Chrome 的 AI 最佳化模型（數十 MB，酒館用不到）
    '--disable-features=msEdgeStartupBoost,Translate,IntensiveWakeUpThrottling,OptimizationGuideModelDownloading,OptimizationHints',
    '--disable-component-update', // 不下載瀏覽器元件（語音引擎、元件快取等），data/app-profile 不會越長越大
    '--disk-cache-size=52428800', // 瀏覽器快取最多 50 MB
  ];
  const child = spawn(browser, args, { stdio: 'ignore', detached: existing });
  if (existing) { child.unref(); process.exit(0); }

  console.log('  已開啟 AI 酒館視窗。關閉視窗即會結束伺服器。\n');
  const startedAt = Date.now();
  child.on('exit', () => {
    // 若瀏覽器幾秒內就結束，通常是把視窗交給了已在執行的同設定檔程序（例如剛關掉的視窗還沒完全結束）。
    // 這時沒辦法知道視窗什麼時候關閉，改看 App 視窗每 10 秒送來的「還開著」訊號：
    // 超過 30 秒沒收到就結束伺服器，不會一直留在背景（視窗縮小時計時器也不會被放慢，見上方的啟動參數）
    if (Date.now() - startedAt < 5000) {
      const IDLE = Number(process.env.TAVERN_IDLE_MS) || 30 * 1000; // TAVERN_IDLE_MS 只用來測試
      console.log(`  視窗已交給既有的瀏覽器程序處理；視窗關閉約 ${Math.round(IDLE / 1000)} 秒後會自動結束伺服器。`);
      // 電腦睡眠：醒來時計時器一次跳過很久，訊號也還沒來得及送到；這時重新起算，不要誤判成視窗已經關閉
      let lastTick = Date.now(), since = startedAt;
      setInterval(() => {
        const now = Date.now();
        if (now - lastTick > 20000) since = now; // 這次檢查和上次差太久＝剛從睡眠醒來
        lastTick = now;
        if (now - Math.max(lastHeartbeat() || 0, since) > IDLE) {
          console.log(`  已經 ${Math.round(IDLE / 1000)} 秒沒有收到 AI 酒館視窗的訊號，結束伺服器。`);
          exitServer(0);
        }
      }, 5000);
      return;
    }
    console.log('  視窗已關閉，結束伺服器。');
    exitServer(0);
  });
  child.on('error', err => {
    console.log('  無法啟動瀏覽器（' + err.message + '），改用預設瀏覽器開啟。');
    openDefaultBrowser(url);
  });
})().catch(err => { console.error(err); process.exit(1); });
