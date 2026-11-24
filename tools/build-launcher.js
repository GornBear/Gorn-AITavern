// 編譯啟動程式「AI 酒館.exe」（放在專案第一層）：使用 Windows 內建的 C# 編譯器，圖示用 assets/app.ico
// 用法：npm run build-launcher（換了圖示要先 npm run icon）
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'AI 酒館.exe');
const win = process.env.WINDIR || 'C:\\Windows';
const csc = ['Framework64', 'Framework'].map(f => path.join(win, 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe')).find(f => fs.existsSync(f));
if (process.platform !== 'win32' || !csc) { console.error('找不到 Windows 內建的 C# 編譯器（.NET Framework 4），無法編譯啟動程式'); process.exit(1); }

try {
  execFileSync(csc, [
    '/nologo', '/target:winexe', '/optimize+', '/codepage:65001',
    `/win32icon:${path.join(ROOT, 'assets', 'app.ico')}`,
    '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll',
    `/out:${OUT}`, path.join(__dirname, 'launcher', 'Launcher.cs'),
  ], { stdio: 'inherit' });
} catch { console.error('\n編譯失敗'); process.exit(1); }
console.log(`已產生 ${path.relative(ROOT, OUT)}（${Math.round(fs.statSync(OUT).size / 1024)} KB）`);
