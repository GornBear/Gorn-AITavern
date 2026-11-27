// 備份、匯出與匯入：把角色、對話、世界、世界書、設定與頭像／背景圖打包成一個檔案
//
// 檔案格式（gzip 壓縮的 JSON）：{ app: 'ai-tavern', version: 1, created, hash, files: { 相對路徑: 內容 } }
//   內容是 { t: 文字 }、{ b: base64 }（圖片），或 { h: 雜湊 }（只在自動備份裡：圖片另外存一份，多份備份共用）
// API 金鑰（config.json）不會被打包。
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const store = require('./storage');
const { timeStamp: stamp } = require('./util');

const DATA = store.DATA_DIR;
const BACKUP_DIR = path.join(DATA, 'backups');
const BLOB_DIR = path.join(BACKUP_DIR, 'blobs'); // 自動備份共用的圖片（同一張圖只存一次）
const TOP_FILES = ['settings.json', 'background.png'];
// 舊版備份裡的檔案：還原時接受（不會因此判定備份無效），但不再寫回去（你的頭像現在就是使用中設定檔的頭像，存在 personas/）
const LEGACY_FILES = ['user-avatar.png'];
// 'chats' 是舊版的對話資料夾：新版的對話放在各角色／世界的資料夾裡，只有還原舊備份時才會出現（還原後自動整理成新結構）
const SUB_DIRS = ['char', 'worlds', 'bigworld', 'personas', 'chats']; // personas：使用者設定檔的頭像
// 名稱：backup-日期-時間[-序號][-種類].tavern。種類：沒有＝自動備份（啟動、關閉時），manual＝手動按「立即備份」，
// restore＝還原或匯入前自動留的。只有自動備份會被輪替；另外兩種要自己刪
const NAME_RE = /^backup-\d{8}-\d{6}(-\d+)?(-(manual|restore))?\.tavern$/;
const kindOf = name => (/-manual\.tavern$/.test(name) ? 'manual' : /-restore\.tavern$/.test(name) ? 'restore' : 'auto');
// 每份備份用到哪些共用圖片（不用每次都把所有備份解壓縮一遍才知道哪些圖片還在用）
const INDEX_FILE = path.join(BACKUP_DIR, 'index.json');
// 打包裡允許的路徑：只能是上面這些資料夾（最多往下 3 層，例如 char/角色名稱-xxx/chats/yyy.json）或檔案；
// 每一段都不能是 . 或 ..，也不能有 Windows 不允許的字元
const SEGMENT_RE = /^(?!\.{1,2}$)[^\\/:*?"<>|\x00-\x1f]+$/;
const isAllowedPath = rel => {
  if (TOP_FILES.includes(rel)) return true;
  const parts = String(rel).split('/');
  return parts.length >= 2 && parts.length <= 4 && SUB_DIRS.includes(parts[0]) && parts.slice(1).every(s => SEGMENT_RE.test(s) && !/[. ]$/.test(s));
};
const isText = f => /\.json$/i.test(f);
const sha1 = buf => crypto.createHash('sha1').update(buf).digest('hex');
/**
 * 先寫暫存檔再換名字：寫到一半被強制結束（例如關閉時超過等待時間）只會留下 .tmp，
 * 不會出現一份解壓縮不了的備份或圖片（下次備份時清掉殘留的 .tmp）
 */
function writeAtomic(file, buf) {
  const tmp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, buf); fs.renameSync(tmp, file); }
  catch (e) { try { fs.unlinkSync(tmp); } catch { /* 沒有暫存檔 */ } throw e; }
}
/** 清掉中斷留下的暫存檔 */
function cleanTmp() {
  for (const dir of [BACKUP_DIR, BLOB_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const n of fs.readdirSync(dir)) if (n.endsWith('.tmp')) { try { fs.unlinkSync(path.join(dir, n)); } catch { /* 下次再清 */ } }
  }
}

/** 目前所有要打包的檔案（相對路徑 → 完整路徑） */
function collect() {
  const out = [];
  for (const f of TOP_FILES) { const p = path.join(DATA, f); if (fs.existsSync(p)) out.push([f, p]); }
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel + '/' + e.name, p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, r);
      else if (!e.name.endsWith('.tmp') && isAllowedPath(r)) out.push([r, p]);
    }
  };
  for (const d of SUB_DIRS) { const p = path.join(DATA, d); if (fs.existsSync(p)) walk(p, d); }
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

/** 打包目前的資料。shareImages = true：圖片存到共用區、打包裡只記雜湊（自動備份用，省空間） */
// 圖片的雜湊（路徑 → { mtimeMs, size, h }）：檔案沒變就不用重新讀取、計算（啟動與關閉各備份一次，圖片通常都沒變）
const imageHashCache = new Map();
// 讀寫檔案的步驟寫成 generator（yield 一個要做的 IO），同一份流程可以同步跑（還原前的備份、手動備份），
// 也可以非同步跑（啟動、關閉時的自動備份：讀檔、壓縮時不卡住伺服器，畫面照常回應）
const IO_SYNC = {
  read: p => fs.readFileSync(p),
  stat: p => fs.statSync(p),
  write: ([file, buf]) => writeAtomic(file, buf),
  gzip: buf => zlib.gzipSync(buf),
};
const gzipAsync = require('util').promisify(zlib.gzip);
const IO_ASYNC = {
  read: p => fs.promises.readFile(p),
  stat: p => fs.promises.stat(p),
  write: async ([file, buf]) => {
    const tmp = `${file}.${process.pid}.tmp`;
    try { await fs.promises.writeFile(tmp, buf); await fs.promises.rename(tmp, file); }
    catch (e) { await fs.promises.unlink(tmp).catch(() => {}); throw e; }
  },
  gzip: buf => gzipAsync(buf),
};
const op = (kind, arg) => ({ kind, arg });
function runSync(gen) {
  let r = gen.next();
  while (!r.done) r = gen.next(IO_SYNC[r.value.kind](r.value.arg));
  return r.value;
}
async function runAsync(gen) {
  let r = gen.next();
  while (!r.done) r = gen.next(await IO_ASYNC[r.value.kind](r.value.arg));
  return r.value;
}

function* packSteps({ shareImages = false } = {}) {
  const files = {};
  const hash = crypto.createHash('sha1');
  for (const [rel, p] of collect()) {
    if (isText(rel)) {
      const buf = yield op('read', p);
      hash.update(rel).update(buf);
      files[rel] = { t: buf.toString('utf8') };
    } else if (shareImages) {
      // 整份備份的雜湊用圖片的雜湊計算：圖片沒變時不必讀檔
      const st = yield op('stat', p), c = imageHashCache.get(p);
      let h = c && c.mtimeMs === st.mtimeMs && c.size === st.size ? c.h : null;
      const bp = () => path.join(BLOB_DIR, h);
      if (!h || !fs.existsSync(bp())) {
        const buf = yield op('read', p);
        h = sha1(buf);
        imageHashCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, h });
        fs.mkdirSync(BLOB_DIR, { recursive: true });
        if (!fs.existsSync(bp())) yield op('write', [bp(), buf]);
      }
      hash.update(rel).update(h);
      files[rel] = { h };
    } else {
      const buf = yield op('read', p);
      hash.update(rel).update(sha1(buf));
      files[rel] = { b: buf.toString('base64') };
    }
  }
  return { app: 'ai-tavern', version: 1, created: Date.now(), hash: hash.digest('hex'), files };
}
function decode(buf) {
  let bundle;
  try { bundle = JSON.parse(zlib.gunzipSync(buf).toString('utf8')); }
  catch { throw Object.assign(new Error('不是 AI 酒館的備份檔（無法解壓縮）'), { status: 400 }); }
  if (!bundle || bundle.app !== 'ai-tavern' || typeof bundle.files !== 'object') throw Object.assign(new Error('不是 AI 酒館的備份檔'), { status: 400 });
  return bundle;
}
/** 把打包裡的「雜湊」換成實際的圖片內容（下載備份、還原時用） */
function inline(bundle) {
  for (const [rel, v] of Object.entries(bundle.files)) {
    if (v && v.h) {
      const bp = path.join(BLOB_DIR, String(v.h).replace(/[^0-9a-f]/g, ''));
      if (fs.existsSync(bp)) bundle.files[rel] = { b: fs.readFileSync(bp).toString('base64') };
      else delete bundle.files[rel]; // 圖片遺失：略過（文字資料照常還原）
    }
  }
  return bundle;
}

// ---------- 自動備份 ----------
const backupPath = name => {
  if (!NAME_RE.test(String(name))) throw Object.assign(new Error('無效的備份名稱'), { status: 400 });
  return path.join(BACKUP_DIR, name);
};
/**
 * 備份建立的時間：從檔名讀（backup-20261120-153012 → 本機時間）。檔案的修改時間在複製 userdata 搬家後
 * 會全部變成複製當下的時間，檔名不會變
 */
function nameTime(name) {
  const m = /^backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name);
  if (!m) return 0;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  return Number.isFinite(t) ? t : 0;
}
/** 同一秒內建立的第幾份（backup-日期-時間-2… 的 2；沒有序號＝1） */
const seqOf = name => +(/^backup-\d{8}-\d{6}-(\d+)/.exec(name)?.[1] || 1);
function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR).filter(n => NAME_RE.test(n))
    .map(name => { const st = fs.statSync(path.join(BACKUP_DIR, name)); return { name, kind: kindOf(name), size: st.size, created: nameTime(name) || st.mtimeMs }; })
    // 新的在前：先比建立時間（檔名），同一秒內再比序號（backup-…-2 比 backup-… 晚）。
    // 直接比檔名字串的話，同一秒內的 -2、-manual、-restore 順序會亂掉
    .sort((a, b) => (b.created - a.created) || (seqOf(b.name) - seqOf(a.name)) || b.name.localeCompare(a.name));
}
const dirSize = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).reduce((s, n) => s + fs.statSync(path.join(dir, n)).size, 0) : 0);
function backupStatus() {
  const items = listBackups();
  const blobs = dirSize(BLOB_DIR);
  return { items, total_size: items.reduce((s, b) => s + b.size, 0) + blobs, images_size: blobs };
}
/** 讀出一份備份的內容 */
function readBackup(name) {
  let buf;
  try { buf = fs.readFileSync(backupPath(name)); }
  catch (e) { throw e.code === 'ENOENT' ? Object.assign(new Error('找不到這份備份（可能已經被刪除或輪替掉了）'), { status: 404 }) : e; }
  return decode(buf);
}

// ---------- 圖片索引 ----------
const readIndex = () => { try { const j = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } };
const writeIndex = idx => { fs.mkdirSync(BACKUP_DIR, { recursive: true }); writeAtomic(INDEX_FILE, Buffer.from(JSON.stringify(idx))); };
// 索引裡另外記「最新一份自動備份」的雜湊（不是備份名稱，清圖片時不算）
const HASH_KEY = '_latest_auto';
const blobsOf = bundle => [...new Set(Object.values(bundle.files).filter(v => v && v.h).map(v => String(v.h)))];

/**
 * 建立一份備份；自動備份和最新一份自動備份完全相同時不重複建立（除非 force）。
 * kind：'auto'（預設）／'manual'／'restore'。回傳備份名稱，沒有建立時回傳 null
 */
const createBackup = opts => runSync(createSteps(opts));
/** 和 createBackup 相同，但不卡住伺服器（回傳 Promise） */
const createBackupAsync = opts => runAsync(createSteps(opts));
function* createSteps({ force = false, kind = 'auto' } = {}) {
  const bundle = yield* packSteps({ shareImages: true });
  const latest = listBackups().find(b => b.kind === 'auto');
  if (!force && kind === 'auto' && latest) {
    // 最新一份的雜湊記在索引裡（不用為了比對把整份備份解壓縮）；索引裡沒有才讀備份本身
    const known = readIndex()[HASH_KEY];
    const latestHash = known && known.name === latest.name ? known.hash : (() => { try { return readBackup(latest.name).hash; } catch { return null; } })(); // 舊備份壞掉：照常建立新的
    if (latestHash === bundle.hash) return null;
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const suffix = kind === 'auto' ? '' : `-${kind}`;
  const base = `backup-${stamp(new Date())}`;
  let name = `${base}${suffix}.tavern`;
  for (let i = 2; fs.existsSync(path.join(BACKUP_DIR, name)); i++) name = `${base}-${i}${suffix}.tavern`;
  yield op('write', [path.join(BACKUP_DIR, name), yield op('gzip', Buffer.from(JSON.stringify(bundle)))]);
  try { const idx = readIndex(); idx[name] = blobsOf(bundle); if (kind === 'auto') idx[HASH_KEY] = { name, hash: bundle.hash }; writeIndex(idx); } catch { /* 索引寫不進去：下次清圖片時重建 */ }
  return name;
}
/**
 * 自動備份要保留哪些（新的在前）：最近 keep 份，再加上「最近 keep 天、每天最後一份」。
 * 只依啟動次數輪替的話，一天重開好幾次就會把前幾天的備份全部輪替掉；每天留一份，可以回到幾天前的狀態
 */
function autoKeepSet(autos, keep) {
  const set = new Set(autos.slice(0, keep).map(b => b.name));
  const days = new Set();
  for (const b of autos) {
    const day = b.name.slice(7, 15); // backup-YYYYMMDD-…
    if (days.has(day)) continue;
    if (days.size >= keep) break;
    days.add(day); set.add(b.name);
  }
  return set;
}
/**
 * 輪替自動備份（手動備份與還原前的備份不動），並清掉沒有任何備份用到的圖片。
 * keep = Infinity：不刪備份，只清圖片
 */
function pruneBackups(keep) {
  const autos = listBackups().filter(b => b.kind === 'auto');
  if (Number.isFinite(keep)) {
    const k = Math.max(0, Math.floor(keep));
    const keepSet = k ? autoKeepSet(autos, k) : new Set();
    for (const b of autos) if (!keepSet.has(b.name)) fs.unlinkSync(path.join(BACKUP_DIR, b.name));
  }
  cleanBlobs();
}
/** 依索引清掉沒有任何備份用到的圖片；索引裡沒有的備份才解壓縮一次補進索引 */
function cleanBlobs() {
  const names = listBackups().map(b => b.name);
  const old = readIndex(), idx = old[HASH_KEY] && names.includes(old[HASH_KEY].name) ? { [HASH_KEY]: old[HASH_KEY] } : {};
  let complete = true;
  for (const n of names) {
    if (Array.isArray(old[n])) { idx[n] = old[n]; continue; }
    try { idx[n] = blobsOf(readBackup(n)); } catch { complete = false; } // 壞掉的備份：不知道它用到哪些圖片，這次不清圖片
  }
  if (JSON.stringify(idx) !== JSON.stringify(old)) { try { writeIndex(idx); } catch { /* 下次再寫 */ } }
  if (!complete || !fs.existsSync(BLOB_DIR)) return;
  const used = new Set(names.flatMap(n => idx[n] || []));
  for (const n of fs.readdirSync(BLOB_DIR)) if (!n.endsWith('.tmp') && !used.has(n)) fs.unlinkSync(path.join(BLOB_DIR, n));
}
function deleteBackup(name) {
  const p = backupPath(name);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  pruneBackups(Infinity); // 只清掉不再用到的圖片
}
/**
 * 啟動（與結束）時：建立備份，再刪掉超過保留份數的舊備份（keep = 0 表示關閉自動備份）。
 * settings.json 損毀時不自動備份：不然多啟動幾次，好的舊備份會被損毀的版本輪替掉
 */
const startupBackup = keep => runSync(startupSteps(keep));
/** 和 startupBackup 相同，但不卡住伺服器（啟動、關閉時用；回傳 Promise） */
const startupBackupAsync = keep => runAsync(startupSteps(keep));
function* startupSteps(keep) {
  keep = Math.max(0, Math.floor(Number(keep)) || 0);
  cleanTmp();
  cleanRestoreLeftovers();
  if (!keep) return null;
  if (store.corruptFiles().includes('settings.json')) { console.warn('[備份] settings.json 損毀，略過自動備份（保留好的舊備份）'); return null; }
  const name = yield* createSteps();
  pruneBackups(keep);
  return name;
}

// ---------- 匯出／匯入 ----------
// 匯出全部資料、下載備份：JSON 一段一段產生（呼叫端接上 gzip 再寫到回應或檔案），
// 不在記憶體裡組一個超大字串（圖片很多時會超過 V8 的字串長度上限，記憶體也會用掉好幾倍）。格式和備份檔相同
const kv = (k, v) => JSON.stringify(k) + ':' + JSON.stringify(v);
/** 匯出：所有資料打包成一個檔案（圖片直接放在裡面，可以帶到別台電腦）。回傳 async iterator（字串片段） */
async function* exportAllChunks() {
  const hash = crypto.createHash('sha1');
  yield `{${kv('app', 'ai-tavern')},${kv('version', 1)},${kv('created', Date.now())},"files":{`;
  let first = true;
  for (const [rel, p] of collect()) {
    let buf;
    try { buf = await fs.promises.readFile(p); } catch { continue; } // 剛好被刪掉：略過
    hash.update(rel).update(isText(rel) ? buf : sha1(buf));
    yield (first ? '' : ',') + kv(rel, isText(rel) ? { t: buf.toString('utf8') } : { b: buf.toString('base64') });
    first = false;
  }
  yield `},${kv('hash', hash.digest('hex'))}}`;
}
/**
 * 下載某一份自動備份（補上共用的圖片，變成完整的檔案）。備份讀不到時「呼叫時」就丟出錯誤（還沒開始回應，可以回錯誤訊息）
 */
function backupChunks(name) {
  const { files, ...meta } = readBackup(name);
  return (async function* () {
    yield `{${Object.entries(meta).map(([k, v]) => kv(k, v)).join(',')}${Object.keys(meta).length ? ',' : ''}"files":{`;
    let first = true;
    for (const [rel, v] of Object.entries(files)) {
      let out = v;
      if (v && v.h) {
        try { out = { b: (await fs.promises.readFile(path.join(BLOB_DIR, String(v.h).replace(/[^0-9a-f]/g, '')))).toString('base64') }; }
        catch { continue; } // 圖片遺失：略過（文字資料照常匯出）
      }
      yield (first ? '' : ',') + kv(rel, out);
      first = false;
    }
    yield '}}';
  })();
}

/**
 * 用打包的內容取代目前的資料。取代之前一定先備份目前的資料（不受保留份數影響，之後照常輪替）。
 * 回傳 { restored: 檔案數, safety: 還原前的備份名稱 }
 */
/**
 * keepConnection（匯入別人的檔案時用）：連線設定（供應商、API 位址、模型、使用中的模型設定檔）沿用目前的，
 * 不換成檔案裡的。金鑰不在打包裡、匯入後還是你的，如果連線設定換成檔案裡的位址，下一次生成就會把你的金鑰送到那裡。
 * 檔案裡的模型設定檔照樣匯入，但這台電腦沒有替它們存過金鑰，切換過去時要重新輸入（不會沿用目前的金鑰）
 */
const CONNECTION_KEYS = ['provider', 'openai', 'gemini', 'anthropic', 'active_profile'];
function restore(buf, { keepConnection = false } = {}) {
  const bundle = inline(Buffer.isBuffer(buf) ? decode(buf) : buf);
  const valid = ([, v]) => v && (typeof v.t === 'string' || typeof v.b === 'string');
  const entries = Object.entries(bundle.files).filter(e => isAllowedPath(e[0]) && valid(e));
  const legacyAvatar = Object.entries(bundle.files).find(e => e[0] === LEGACY_FILES[0] && valid(e))?.[1];
  if (!entries.some(([rel]) => rel === 'settings.json' || rel.startsWith('char/') || rel.startsWith('chats/')))
    throw Object.assign(new Error('備份檔裡沒有可以還原的資料'), { status: 400 });
  // 匯入時沿用目前的連線設定
  let connectionKept = false, foreignProfiles = [];
  if (keepConnection) {
    const cur = store.getSettings();
    const sIdx = entries.findIndex(([rel]) => rel === 'settings.json');
    let incoming = {};
    if (sIdx >= 0) { try { incoming = JSON.parse(entries[sIdx][1].t || '{}') || {}; } catch { incoming = {}; } }
    for (const k of CONNECTION_KEYS) { if (cur[k] !== undefined) incoming[k] = cur[k]; else delete incoming[k]; }
    const mine = new Set((cur.profiles || []).map(p => p.id));
    foreignProfiles = (Array.isArray(incoming.profiles) ? incoming.profiles : []).map(p => p && p.id).filter(id => id && !mine.has(id));
    const text = { t: JSON.stringify(incoming, null, 2) };
    if (sIdx >= 0) entries[sIdx] = ['settings.json', text]; else entries.push(['settings.json', text]);
    connectionKept = true;
  }
  const safety = createBackup({ force: true, kind: 'restore' });
  replaceData(entries);
  if (foreignProfiles.length) store.blankProfileKeys(foreignProfiles);
  store.clearCaches();
  try { store.pinChangedDefaults({ restored: true }); } catch { /* 下次啟動再補 */ } // 舊備份的設定：維持當時的值（不跟著新的程式預設值變）
  try { store.ensureProfile(); } catch { /* 下次啟動再補 */ } // 一定有一個使用中的模型設定檔（舊備份可能沒有、或匯入的檔案裡沒有目前使用中的那個）
  store.ensurePersonas(); // 舊備份可能沒有使用者設定檔：補上預設的 User
  // 很舊的備份（還沒有使用者設定檔時）頭像只存在 user-avatar.png：使用中的設定檔沒有頭像時，用它當頭像
  if (legacyAvatar?.b && !store.getUserAvatarPath()) store.setUserAvatar(Buffer.from(legacyAvatar.b, 'base64'));
  store.migrateLayout({ keepCopy: false }); // 舊版的備份：整理成每個角色／世界一個資料夾（還原前已經備份過，不用再複製）
  try { store.pinChatPersonas(); } catch { /* 下次啟動再補 */ } // 舊版的備份：對話固定到使用中的使用者設定檔
  return { restored: entries.length, safety, connection_kept: connectionKept };
}
/**
 * 用打包的內容換掉目前的資料，盡量一次完成：先把所有檔案寫進暫存資料夾，全部寫好才把舊資料夾移開、新資料夾換上。
 * 寫到一半出錯（磁碟滿、檔案被鎖住）時目前的資料完全不動；換上的途中出錯就把舊資料搬回來。
 * 備份資料夾、瀏覽器設定檔、config.json（金鑰）不動
 */
function replaceData(entries) {
  const stage = path.join(DATA, `.restore-new-${process.pid}`), old = path.join(DATA, `.restore-old-${process.pid}`);
  for (const d of [stage, old]) fs.rmSync(d, { recursive: true, force: true });
  try {
    fs.mkdirSync(stage, { recursive: true });
    for (const d of SUB_DIRS) fs.mkdirSync(path.join(stage, d), { recursive: true });
    for (const [rel, v] of entries) {
      const p = path.join(stage, ...rel.split('/'));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, typeof v.t === 'string' ? Buffer.from(v.t, 'utf8') : Buffer.from(v.b, 'base64'));
    }
  } catch (e) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw Object.assign(new Error(`還原失敗，目前的資料沒有任何改變（寫入暫存檔時出錯：${e.code || e.message}）`), { status: 500 });
  }
  // 換上：舊的移到 old、新的移進來；途中出錯就把已經搬走的搬回來
  const names = [...SUB_DIRS, ...TOP_FILES];
  const moved = [];
  try {
    fs.mkdirSync(old, { recursive: true });
    for (const n of names) {
      const cur = path.join(DATA, n);
      if (fs.existsSync(cur)) { fs.renameSync(cur, path.join(old, n)); moved.push(n); }
    }
    for (const n of names) { const src = path.join(stage, n); if (fs.existsSync(src)) fs.renameSync(src, path.join(DATA, n)); }
  } catch (e) {
    for (const n of names) {
      const cur = path.join(DATA, n);
      if (moved.includes(n)) { try { fs.rmSync(cur, { recursive: true, force: true }); fs.renameSync(path.join(old, n), cur); } catch { /* 下面的錯誤訊息會請使用者用還原前的備份 */ } }
    }
    fs.rmSync(stage, { recursive: true, force: true });
    throw Object.assign(new Error(`還原失敗，已盡量換回原本的資料（搬移檔案時出錯：${e.code || e.message}）。如果資料不完整，請在備份清單用「還原前」的那份備份還原`), { status: 500 });
  }
  // 到這裡已經還原好了：清掉舊資料失敗（檔案被防毒軟體、雲端同步鎖住）不算還原失敗，只記錄；留下的資料夾下次啟動時清
  for (const d of [old, stage]) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); }
    catch (e) { console.warn(`[還原] 已還原完成，但暫存資料夾 ${path.basename(d)} 沒有清乾淨（${e.code || e.message}），下次啟動時會再清一次`); }
  }
}
/**
 * 清掉還原、匯入中斷或沒清乾淨留下的暫存資料夾（.restore-new-*、.restore-old-*；啟動時呼叫）。
 * 換上途中被中斷時缺少的資料，lib/storage.js 載入時已經從 .restore-old-* 搬回原位，這裡剩下的都是用不到的
 */
function cleanRestoreLeftovers() {
  let names = [];
  try { names = fs.readdirSync(DATA); } catch { return; }
  for (const n of names) {
    if (!/^\.restore-(new|old)-\d+$/.test(n)) continue;
    try { fs.rmSync(path.join(DATA, n), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); }
    catch (e) { console.warn(`[還原] 清不掉暫存資料夾 ${n}（${e.code || e.message}），下次啟動時再試`); }
  }
}

module.exports = { BACKUP_DIR, backupStatus, createBackup, createBackupAsync, pruneBackups, deleteBackup, startupBackup, startupBackupAsync, exportAllChunks, backupChunks, readBackup, restore };
