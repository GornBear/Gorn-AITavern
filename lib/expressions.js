// 表情圖（狀態欄的圖片）：存在角色資料夾的 expressions/<表情名稱>.<副檔名>。設計稿：docs/狀態欄設計稿.md 第 4.4、6.3 節
// 表情名稱＝檔名（不含副檔名），相容 SillyTavern 的表情包；格式用檔頭判斷（PNG、WebP、GIF、JPEG），不看副檔名
'use strict';
const fs = require('fs');
const path = require('path');
const { readZip } = require('./zip');

const DIR = 'expressions';
const MAX_SIZE = 5 * 1024 * 1024; // 單張上限 5 MB
const MAX_NAME = 40;
// 目前沒有任何地方用到 EXTS（支援的格式以 imageType 讀檔頭判斷、list 的正規表示式為準），之後確認不需要可以刪掉
const EXTS = ['png', 'webp', 'gif', 'jpg'];
const TYPES = { png: 'image/png', webp: 'image/webp', gif: 'image/gif', jpg: 'image/jpeg' };
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

/** 用檔頭判斷圖片格式：png／webp／gif／jpg，不是圖片回傳 null */
function imageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (/^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return 'gif';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  return null;
}
/**
 * 表情名稱：拿掉路徑、副檔名（給 stripExt 時）、Windows 不允許的字元與前後的空白、句點，最多 40 字。
 * 不能用的名稱回傳空字串
 */
function cleanName(raw, { stripExt = false } = {}) {
  let n = String(raw ?? '').split(/[\\/]/).pop();
  if (stripExt) n = n.replace(/\.[^.]*$/, '');
  n = n.replace(/[:*?"<>|\x00-\x1f]/g, '').replace(/\s+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, '');
  if (!n || n === '..' || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(n)) return '';
  return [...n].slice(0, MAX_NAME).join('').replace(/[\s.]+$/, '');
}
const same = (a, b) => a.toLowerCase() === b.toLowerCase(); // Windows 的檔名不分大小寫
// SillyTavern 表情包的名稱 → 預設表情格子的名稱（格子用比較短的 shy、nervous）：新增、匯入時自動改名，表情包照樣填進格子
const ALIASES = { embarrassment: 'shy', nervousness: 'nervous' };
const alias = name => ALIASES[name.toLowerCase()] || name;
// 反過來：匯出給其他程式（.charx）時，shy、nervous 改回 SillyTavern 通用的 embarrassment、nervousness（匯回來時再自動改成短的）
const ST_NAMES = Object.fromEntries(Object.entries(ALIASES).map(([st, short]) => [short, st]));
const exportName = name => ST_NAMES[name.toLowerCase()] || name;

/** 這個角色的表情：[{ name, file, type, ver }]，依名稱排序 */
function list(charDir) {
  const dir = charDir && path.join(charDir, DIR);
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const m = /^(.+)\.(png|webp|gif|jpg)$/i.exec(f);
    if (!m || m[1] !== cleanName(m[1])) continue;
    const st = fs.statSync(path.join(dir, f));
    if (!st.isFile()) continue;
    out.push({ name: m[1], file: path.join(dir, f), type: TYPES[m[2].toLowerCase()], ver: Math.floor(st.mtimeMs) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
}
const find = (charDir, name) => list(charDir).find(e => same(e.name, name)) || null;

/** 存一張表情（replace＝false 時同名回 409）。回傳 { name } */
function save(charDir, rawName, buf, { replace = false } = {}) {
  const name = alias(cleanName(rawName));
  if (!name) throw bad('表情名稱不能用（空白、或只有不允許的字元）');
  const type = imageType(buf);
  if (!type) throw bad(`「${name}」不是圖片（支援 PNG、WebP、GIF、JPEG）`);
  if (buf.length > MAX_SIZE) throw bad(`「${name}」太大了（上限 5 MB）`);
  const old = find(charDir, name);
  if (old && !replace) throw bad(`已經有「${old.name}」這個表情`, 409);
  const dir = path.join(charDir, DIR);
  fs.mkdirSync(dir, { recursive: true });
  if (old) fs.unlinkSync(old.file); // 同名不同格式（例如 joy.png 換成 joy.webp）：舊的拿掉
  fs.writeFileSync(path.join(dir, `${name}.${type}`), buf);
  return { name };
}
function remove(charDir, name) {
  const e = find(charDir, name);
  if (!e) throw bad('找不到這個表情', 404);
  fs.unlinkSync(e.file);
}
/** 改名：新名稱已經被別的表情用了回 409（只改大小寫可以） */
function rename(charDir, from, to) {
  const e = find(charDir, from);
  if (!e) throw bad('找不到這個表情', 404);
  const name = cleanName(to);
  if (!name) throw bad('新的名稱不能用');
  const other = find(charDir, name);
  if (other && other.file !== e.file) throw bad(`已經有「${other.name}」這個表情`, 409);
  const dest = path.join(path.dirname(e.file), name + path.extname(e.file).toLowerCase());
  if (dest !== e.file) {
    // 只改大小寫時（Windows 視為同一個檔案）先換成暫時的名字
    const tmp = e.file + '.renaming';
    fs.renameSync(e.file, tmp); fs.renameSync(tmp, dest);
  }
  return { name };
}

/**
 * 匯入表情包（ZIP）：照 SillyTavern 的規則，圖片放在第一層、檔名就是表情名稱。
 * 子資料夾裡的檔案、不是圖片的檔案、太大的檔案略過，並回報略過了哪些。
 * onConflict：'ask'（有同名就什麼都不寫，回傳 conflicts 讓畫面問）、'replace'、'skip'
 */
function importZip(charDir, buf, { onConflict = 'ask' } = {}) {
  const entries = readZip(buf, { files: 300, each: MAX_SIZE, total: 100 * 1024 * 1024 });
  const ok = [], skipped = [];
  const seen = new Set();
  for (const e of entries) {
    const base = e.name.split('/').pop();
    if (/(^|\/)__MACOSX\//.test(e.name) || /^\./.test(base) || /^(thumbs\.db|desktop\.ini)$/i.test(base)) continue; // 系統產生的檔案：不用回報
    if (/[\\/]/.test(e.name.replace(/\\/g, '/').replace(/^\.\//, ''))) { skipped.push({ file: e.name, reason: '在子資料夾裡' }); continue; }
    if (e.error === 'too_big') { skipped.push({ file: e.name, reason: '超過 5 MB' }); continue; }
    if (e.error) { skipped.push({ file: e.name, reason: e.error === 'method' ? '不支援的壓縮方式' : '檔案損毀' }); continue; }
    if (!imageType(e.data)) { skipped.push({ file: e.name, reason: '不是圖片' }); continue; }
    const name = alias(cleanName(e.name, { stripExt: true }));
    if (!name) { skipped.push({ file: e.name, reason: '檔名不能當表情名稱' }); continue; }
    if (seen.has(name.toLowerCase())) { skipped.push({ file: e.name, reason: '和 ZIP 裡另一張同名' }); continue; }
    seen.add(name.toLowerCase());
    ok.push({ name, data: e.data });
  }
  const conflicts = ok.filter(x => find(charDir, x.name)).map(x => x.name);
  if (conflicts.length && onConflict === 'ask') return { added: [], skipped, conflicts };
  const added = [];
  for (const x of ok) {
    if (conflicts.includes(x.name) && onConflict === 'skip') { skipped.push({ file: x.name, reason: '已經有同名的表情' }); continue; }
    save(charDir, x.name, x.data, { replace: true });
    added.push(x.name);
  }
  return { added, skipped, conflicts: [] };
}

// ---------- 角色卡 V3 的 assets（設計稿第九節） ----------
const ZIP_LIMITS = { files: 2000, each: 20 * 1024 * 1024, total: 200 * 1024 * 1024 }; // .charx 常帶很多圖片
/** .charx（其實是 ZIP）：回傳 { card, files }。files：路徑 → readZip 的項目（有 data 或 error） */
function readCharx(buf) {
  const files = new Map();
  for (const e of readZip(buf, ZIP_LIMITS)) files.set(e.name.replace(/\\/g, '/').replace(/^\.?\/+/, ''), e);
  const cj = files.get('card.json');
  if (!cj || !cj.data) throw bad('這個 .charx 裡沒有 card.json（或檔案損毀）');
  let card;
  try { card = JSON.parse(cj.data.toString('utf8').replace(/^﻿/, '')); } catch { throw bad('這個 .charx 的 card.json 格式不對'); }
  return { card, files };
}
/**
 * 角色卡 V3 的 assets 裡要用的圖片：type 為 emotion 的（表情圖，name＝表情名稱）與 icon（封面，優先用 name 為 main 的）。
 * uri：embeded://路徑（.charx 裡的檔案）、data:…;base64,…；網址不自動下載、ccdefault:（卡片本身的圖）略過。
 * 回傳 { emotions: [{ name, data }], icon: Buffer|null, skipped: [{ file, reason }] }
 */
function cardAssets(card, files = null) {
  const out = { emotions: [], icon: null, skipped: [] };
  const assets = card?.data?.assets ?? card?.assets;
  if (!Array.isArray(assets)) return out;
  const load = uri => {
    uri = String(uri || '');
    if (/^data:/i.test(uri)) {
      const m = /^data:[^,]*;base64,([\s\S]*)$/i.exec(uri);
      return m ? Buffer.from(m[1], 'base64') : { error: '圖片資料的格式不對' };
    }
    if (/^embedd?ed:\/\//i.test(uri)) {
      const e = files?.get(uri.replace(/^embedd?ed:\/\//i, '').replace(/\\/g, '/').replace(/^\/+/, ''));
      if (!e) return { error: '卡片裡找不到這個檔案' };
      return e.data || { error: e.error === 'too_big' ? '檔案太大' : '檔案損毀' };
    }
    if (/^ccdefault:/i.test(uri)) return null;
    if (/^https?:/i.test(uri)) return { error: '是網址，不會自動下載' };
    return { error: '不支援的圖片位置' };
  };
  let iconMain = false;
  for (const a of assets) {
    if (!a || typeof a !== 'object') continue;
    const type = String(a.type || '').toLowerCase();
    if (type === 'emotion') {
      const name = String(a.name || '').trim() || '（沒有名稱）';
      const d = load(a.uri);
      if (d == null) continue;
      if (Buffer.isBuffer(d)) out.emotions.push({ name, data: d }); else out.skipped.push({ file: name, reason: d.error });
    } else if (type === 'icon' && !iconMain) {
      const d = load(a.uri);
      if (!Buffer.isBuffer(d)) continue;
      const main = String(a.name || '').toLowerCase() === 'main';
      if (main || !out.icon) { out.icon = d; iconMain = main; }
    }
  }
  return out;
}
/**
 * 把角色卡帶來的表情圖存進新角色的 expressions/（不是圖片、太大、名稱不能用、和前面同名的略過並說明原因）。
 * 回傳 { added: [名稱], skipped: [{ file, reason }] }
 */
function importCardEmotions(charDir, emotions) {
  const added = [], skipped = [], seen = new Set();
  for (const { name: raw, data } of emotions) {
    const name = alias(cleanName(raw));
    if (!name) { skipped.push({ file: raw, reason: '名稱不能當表情名稱' }); continue; }
    if (!imageType(data)) { skipped.push({ file: raw, reason: '不是圖片' }); continue; }
    if (data.length > MAX_SIZE) { skipped.push({ file: raw, reason: '超過 5 MB' }); continue; }
    if (seen.has(name.toLowerCase())) { skipped.push({ file: raw, reason: '和前面的表情同名' }); continue; }
    seen.add(name.toLowerCase());
    save(charDir, name, data, { replace: true });
    added.push(name);
  }
  return { added, skipped };
}

module.exports = { DIR, MAX_SIZE, imageType, cleanName, exportName, list, find, save, remove, rename, importZip, readCharx, cardAssets, importCardEmotions };
