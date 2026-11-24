// 內附的 Node.js（runtime/node.exe）共用的小工具：
// 設定頁「資料 → 內附的 Node.js」用這裡
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// TAVERN_RUNTIME_DIR：測試用，指到暫存資料夾（不會動到專案真正的 runtime/）
const DIR = process.env.TAVERN_RUNTIME_DIR ? path.resolve(process.env.TAVERN_RUNTIME_DIR) : path.join(ROOT, 'runtime');
const EXE = path.join(DIR, 'node.exe');

/** 目前執行的 Node.js 是不是內附的那一份 */
const runningBundled = () => path.resolve(process.execPath).toLowerCase() === path.resolve(EXE).toLowerCase();

/** runtime/README.txt 的內容（記下複製來源與版本） */
const readmeText = (src = process.execPath) => [
  'AI 酒館內附的 Node.js',
  '',
  `版本：${process.version}（${process.platform}-${process.arch}）`,
  `複製自：${src}`,
  `複製時間：${new Date().toLocaleString('zh-TW', { hour12: false })}`,
  '',
  '只有在電腦上沒有安裝 Node.js、而且在 AI 酒館.exe 的詢問視窗選擇「使用內附版本」時才會用到它；',
  '電腦上有安裝 Node.js 時一律使用安裝的版本。',
  '要更新：先更新電腦上的 Node.js，再到 AI 酒館的「設定 → 資料 → 內附的 Node.js」按「重新建立」。',
  '',
  'Node.js 以 MIT 授權發布：https://github.com/nodejs/node/blob/main/LICENSE',
  '',
].join('\r\n');

/**
 * 把目前執行的 Node.js 複製到 dir/node.exe，並寫一份 README.txt（預設是專案的 runtime/）。
 * 打包時 runtime/node.exe 已經刪掉，就用這個從安裝的 Node.js 複製一份到輸出的資料夾
 */
function copyInstalledNode(dir = DIR) {
  if (process.platform !== 'win32') throw new Error('內附版本只支援 Windows');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'node.exe');
  const tmp = out + '.tmp';
  fs.copyFileSync(process.execPath, tmp);
  fs.renameSync(tmp, out);
  fs.writeFileSync(path.join(dir, 'README.txt'), readmeText(), 'utf8');
  return out;
}

module.exports = { DIR, EXE, runningBundled, readmeText, copyInstalledNode };
