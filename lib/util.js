// 伺服器共用的小工具（避免同樣的寫法散在好幾個檔案，改一處漏一處）
'use strict';

/**
 * 拿掉 <think>…</think> 或 <thinking>…</thinking>（思考內容；沒有結尾標籤時拿到最後）。
 * 模擬思考用 <thinking>：有些模型把 <think> 當成特殊符號，平台輸出時會把標籤濾掉，思考就混進正文
 */
const stripThink = s => String(s || '').replace(/<(think|thinking)>[\s\S]*?(<\/\1>|$)/gi, '');

/** 時間戳記「年月日-時分秒」，例如 20261118-142829（備份、垃圾桶、損毀檔另存的檔名用） */
function timeStamp(d = new Date()) {
  const p2 = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

// ---------- 匯出時直接存到這台電腦的「下載」資料夾 ----------
const fs = require('fs');
const os = require('os');
const path = require('path');
let downloadsCache = null;
/**
 * 「下載」資料夾的位置。Windows 可以把下載資料夾搬到別的磁碟：從登錄檔讀實際位置
 * （HKCU\…\User Shell Folders 的 {374DE290-…}，值裡的 %USERPROFILE% 之類自己展開）；讀不到就用 家目錄\Downloads。
 * 測試與預覽用 TAVERN_DOWNLOAD_DIR 指到別的資料夾，不會寫進真正的下載資料夾
 */
function downloadsDir() {
  if (process.env.TAVERN_DOWNLOAD_DIR) return path.resolve(process.env.TAVERN_DOWNLOAD_DIR);
  if (downloadsCache) return downloadsCache;
  let dir = '';
  if (process.platform === 'win32') {
    try {
      const out = require('child_process').execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
        '/v', '{374DE290-123F-4565-9164-39C4925E467B}'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
      const m = /REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(out);
      if (m) dir = m[1].replace(/%([^%]+)%/g, (all, k) => process.env[k] ?? all);
    } catch { /* 讀不到登錄檔：用預設位置 */ }
  }
  if (!dir || /%/.test(dir) || !path.isAbsolute(dir)) dir = path.join(os.homedir(), 'Downloads');
  return (downloadsCache = dir);
}
/** 檔名裡不能用的字元（Windows）換成「_」，前後的空白與句點拿掉，太長截斷 */
const safeFileName = name => String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 80) || '未命名';
/** 存到下載資料夾；同名時在後面加 (1)、(2)…（和瀏覽器下載一樣）。回傳完整路徑 */
function saveToDownloads(base, ext, data) {
  const dir = downloadsDir();
  fs.mkdirSync(dir, { recursive: true });
  const name = safeFileName(base);
  for (let n = 0; n < 1000; n++) {
    const file = path.join(dir, `${name}${n ? ` (${n})` : ''}${ext}`);
    try { fs.writeFileSync(file, data, { flag: 'wx' }); return file; } // wx：已經有同名檔案時失敗，換下一個名字（不會蓋掉）
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error('下載資料夾裡同名的檔案太多了');
}

/**
 * 和 saveToDownloads 相同，但內容是一段一段寫進去的（readable：可讀串流）。寫到一半出錯時刪掉不完整的檔案。回傳完整路徑
 */
async function saveStreamToDownloads(base, ext, readable) {
  const dir = downloadsDir();
  fs.mkdirSync(dir, { recursive: true });
  const name = safeFileName(base);
  let file, fd;
  for (let n = 0; n < 1000 && fd === undefined; n++) {
    file = path.join(dir, `${name}${n ? ` (${n})` : ''}${ext}`);
    try { fd = fs.openSync(file, 'wx'); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  if (fd === undefined) throw new Error('下載資料夾裡同名的檔案太多了');
  try { await require('stream/promises').pipeline(readable, fs.createWriteStream(null, { fd })); }
  catch (e) { try { fs.unlinkSync(file); } catch { /* 刪不掉就留著 */ } throw e; }
  return file;
}

module.exports = { stripThink, timeStamp, downloadsDir, safeFileName, saveToDownloads, saveStreamToDownloads };
