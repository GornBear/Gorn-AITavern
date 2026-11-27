// 應用程式視窗（Edge／Chrome 的 --app 模式）的瀏覽器快取：data/app-profile 裡可以安全清掉的部分。
// 只清快取（網頁、程式碼、繪圖的快取與瀏覽器自己的統計），不動 Local Storage（輸入框的草稿、介面的偏好）、Cookie 與工作階段。
// 視窗開著時瀏覽器鎖著這些檔案，清不掉的部分記一個標記，下次開啟酒館（瀏覽器還沒啟動前）由 launch.js 清掉
'use strict';
const fs = require('fs');
const path = require('path');

const PROFILE = process.env.TAVERN_PROFILE_DIR ? path.resolve(process.env.TAVERN_PROFILE_DIR) : path.join(__dirname, '..', 'data', 'app-profile');
const FLAG = path.join(path.dirname(PROFILE), 'app-cache-clear.flag');
// 相對於設定檔資料夾；Default 是瀏覽器的使用者設定檔
const CACHE_DIRS = [
  'Default/Cache', 'Default/Code Cache', 'Default/GPUCache', 'Default/DawnGraphiteCache', 'Default/DawnWebGPUCache',
  'Default/Service Worker/CacheStorage', 'Default/Service Worker/ScriptCache',
  'ShaderCache', 'GrShaderCache', 'GPUPersistentCache', 'GraphiteDawnCache', 'BrowserMetrics', 'Crashpad/reports',
];

/** 資料夾大小（位元組；不存在是 0） */
function dirSize(p) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const f = path.join(p, e.name);
    try { total += e.isDirectory() ? dirSize(f) : fs.statSync(f).size; } catch { /* 讀不到的略過 */ }
  }
  return total;
}
/** { exists, size：整個設定檔資料夾, cache：可以清掉的部分, pending：上次有清不掉、等下次啟動的 } */
function status() {
  if (!fs.existsSync(PROFILE)) return { exists: false, size: 0, cache: 0, pending: false };
  return { exists: true, size: dirSize(PROFILE), cache: CACHE_DIRS.reduce((s, d) => s + dirSize(path.join(PROFILE, d)), 0), pending: fs.existsSync(FLAG) };
}
/**
 * 清快取：能刪的現在刪，刪不掉（視窗開著、檔案被鎖住）的留到下次啟動。
 * 回傳 { freed：這次清掉的位元組, pending：還有沒清掉的 }
 */
function clear() {
  let freed = 0, pending = false;
  for (const d of CACHE_DIRS) {
    const p = path.join(PROFILE, d);
    if (!fs.existsSync(p)) continue;
    const before = dirSize(p);
    try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }); } catch { pending = true; }
    freed += before - dirSize(p);
    if (fs.existsSync(p) && dirSize(p) > 0) pending = true;
  }
  try { if (pending) fs.writeFileSync(FLAG, String(Date.now())); else fs.rmSync(FLAG, { force: true }); } catch { /* 標記寫不進去：下次再按一次 */ }
  return { freed, pending };
}
/** 啟動時（瀏覽器還沒開）：上次有清不掉的就再清一次 */
function clearPending() {
  if (!fs.existsSync(FLAG)) return null;
  return clear();
}

module.exports = { PROFILE, CACHE_DIRS, status, clear, clearPending };
