// 區網模式（HOST=0.0.0.0）的存取碼：區網裡的其他裝置要先輸入存取碼才能使用酒館；這台電腦自己（127.0.0.1）不用。
// 存取碼：環境變數 TAVERN_ACCESS_CODE；沒有設定時第一次用到就產生一組 6 位數字，存在 data/lan-code.txt（之後沿用）。
// 輸入正確後發一個 cookie（存取碼的 HMAC），存取碼改了舊的 cookie 就失效。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COOKIE = 'tavern_lan';
const MAX_FAILS = 5, LOCK_MS = 60 * 1000; // 同一個位址連續錯 5 次：鎖 1 分鐘

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function cookieOf(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

/** 登入頁：自己的內容安全政策（不載入任何外部檔案、沒有腳本，表單只能送回酒館） */
function loginPage(error = '') {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI 酒館：輸入存取碼</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1d1b19;color:#eee;font:16px/1.6 system-ui,"Microsoft JhengHei",sans-serif}
form{width:min(320px,88vw);padding:28px;border-radius:14px;background:#2a2724;box-shadow:0 8px 30px #0006}
h1{margin:0 0 6px;font-size:20px}p{margin:0 0 16px;color:#bbb;font-size:14px}
input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #555;border-radius:8px;background:#1d1b19;color:#fff;font-size:20px;letter-spacing:4px;text-align:center}
button{margin-top:14px;width:100%;padding:12px;border:0;border-radius:8px;background:#c98a3e;color:#1d1b19;font-size:16px;font-weight:600}
.err{color:#ff8a7a;margin:12px 0 0;font-size:14px}</style></head><body>
<form method="post" action="/lan-login"><h1>AI 酒館</h1><p>請輸入存取碼。存取碼顯示在執行酒館的那台電腦的視窗裡（也可以到那台電腦的 data/lan-code.txt 查看）。</p>
<input name="code" type="password" inputmode="numeric" autocomplete="current-password" autofocus required aria-label="存取碼">
<button type="submit">進入</button>${error ? `<p class="err">${esc(error)}</p>` : ''}</form></body></html>`;
}
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

/**
 * file：存取碼存放的檔案；fixed：環境變數指定的存取碼（有的話優先）。
 * 回傳 { code(), handle(req, res, pathname, isLoopback) }：handle 回傳 true 表示已經回應（要登入、登入結果），呼叫端不要再處理
 */
function createLanAuth({ file, fixed = '' }) {
  let code = String(fixed || '').trim() || null;
  const fails = new Map(); // 位址 → { n, until }

  function getCode() {
    if (code) return code;
    try { code = fs.readFileSync(file, 'utf8').trim() || null; } catch { /* 還沒有：下面產生 */ }
    if (!code) {
      code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, code + '\n'); }
      catch (e) { console.warn('[區網] 存取碼存檔失敗（這次照樣可以用，下次啟動會換一組）：', e.message); }
    }
    return code;
  }
  const token = () => crypto.createHmac('sha256', getCode()).update('ai-tavern-lan').digest('hex');
  const validCookie = req => {
    const c = cookieOf(req, COOKIE);
    return c.length === 64 && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(token()));
  };
  const page = (res, status, error) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': PAGE_CSP });
    res.end(loginPage(error));
  };

  async function login(req, res) {
    const ip = req.socket?.remoteAddress || '';
    const f = fails.get(ip);
    if (f && f.until > Date.now()) return page(res, 429, `錯太多次了，請 ${Math.ceil((f.until - Date.now()) / 1000)} 秒後再試`);
    const chunks = [];
    let size = 0;
    for await (const c of req) { size += c.length; if (size > 4096) return page(res, 413, '內容太長'); chunks.push(c); }
    const input = new URLSearchParams(Buffer.concat(chunks).toString('utf8')).get('code') || '';
    if (crypto.timingSafeEqual(sha(input.trim()), sha(getCode()))) {
      fails.delete(ip);
      res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store',
        'Set-Cookie': `${COOKIE}=${token()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${365 * 86400}` });
      return res.end();
    }
    const n = (f && f.until <= Date.now() && f.n >= MAX_FAILS ? 0 : f?.n || 0) + 1;
    fails.set(ip, { n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
    console.warn(`[區網] ${ip} 輸入的存取碼不對（第 ${n} 次）`);
    return page(res, 401, n >= MAX_FAILS ? '存取碼不對，錯太多次了，請 1 分鐘後再試' : '存取碼不對');
  }

  async function handle(req, res, pathname, loopback) {
    if (loopback) return false; // 這台電腦自己：不用存取碼
    if (pathname === '/lan-login' && req.method === 'POST') { await login(req, res); return true; }
    if (validCookie(req)) return false;
    if (pathname.startsWith('/api/')) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: '需要存取碼：請重新整理頁面，輸入執行酒館的那台電腦上顯示的存取碼' }));
      return true;
    }
    page(res, 401);
    return true;
  }
  return { code: getCode, handle };
}

module.exports = { createLanAuth, COOKIE };
