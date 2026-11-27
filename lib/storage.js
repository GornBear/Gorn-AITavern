// 檔案存取：角色、聊天紀錄、世界書、設定
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { stripThink, timeStamp } = require('./util');
const expr = require('./expressions'); // 表情圖
const { cleanStatusDef } = require('./status'); // 狀態欄（大世界的欄位定義在世界卡上）

const ROOT = path.join(__dirname, '..');
// 玩家存檔（角色、對話、世界、世界書、設定、金鑰、備份）全部放在專案第一層的 userdata/；
// data/ 只留程式自己用的東西（應用程式視窗的瀏覽器設定檔 app-profile、視窗位置、啟動紀錄）
const DATA = process.env.TAVERN_DATA_DIR ? path.resolve(process.env.TAVERN_DATA_DIR) : path.join(ROOT, 'userdata');

/** 把 src 搬到 dest；dest 已經存在時逐一合併（同名檔案以 dest 為準，不覆蓋） */
function moveInto(src, dest) {
  if (!fs.existsSync(dest)) {
    try { fs.renameSync(src, dest); return; }
    catch { fs.cpSync(src, dest, { recursive: true }); fs.rmSync(src, { recursive: true, force: true }); return; }
  }
  if (fs.statSync(src).isDirectory() && fs.statSync(dest).isDirectory()) {
    for (const f of fs.readdirSync(src)) moveInto(path.join(src, f), path.join(dest, f));
    if (!fs.readdirSync(src).length) fs.rmdirSync(src);
  }
}
const LEGACY_CHATS = path.join(DATA, 'chats'); // 舊版：所有對話集中放在 chats/<角色 id 或 world-<id>>/（啟動時搬進各自的資料夾）
const DIRS = {
  characters: path.join(DATA, 'char'), // 每個角色一個資料夾（含對話）
  worlds: path.join(DATA, 'worlds'), // 世界書（lorebook）
  bigworlds: path.join(DATA, 'bigworld'), // 大世界（多角色）
};
/**
 * 上次還原（匯入）在換上新資料的途中被中斷（當機、斷電）：有些資料夾已經搬進 .restore-old-* 卻還沒換上新的。
 * 載入時（建立任何資料夾、檔案之前）先把目前缺少的搬回原位；暫存資料夾之後由 lib/backup.js 的 cleanRestoreLeftovers 清掉。
 * 搬不回來的：改名成 restore-incomplete-*（不會被自動清掉），提示使用者處理
 */
function recoverInterruptedRestore() {
  let names = [];
  try { names = fs.readdirSync(DATA).filter(n => /^\.restore-old-\d+$/.test(n)); } catch { return; }
  for (const n of names) {
    const dir = path.join(DATA, n), back = [];
    let stuck = false, kids = [];
    try { kids = fs.readdirSync(dir); } catch { continue; }
    for (const k of kids) {
      if (fs.existsSync(path.join(DATA, k))) continue; // 已經換上新的：舊的不用了
      try { fs.renameSync(path.join(dir, k), path.join(DATA, k)); back.push(k); }
      catch (e) { console.warn(`[還原] 搬不回 ${k}（${e.code || e.message}）`); stuck = true; }
    }
    if (back.length) console.warn(`[還原] 上次還原沒有完成，已把 ${back.join('、')} 搬回原位。資料如果不完整，可以在「設定 → 資料」用「還原前」的那份備份還原`);
    if (stuck) {
      const keep = path.join(DATA, n.replace(/^\.restore-old-/, 'restore-incomplete-'));
      try { fs.renameSync(dir, keep); console.warn(`[還原] 沒搬回去的舊資料留在 ${keep}，請自行確認後再刪除`); } catch { /* 留在原處：下次啟動再試 */ }
    }
  }
}
recoverInterruptedRestore();
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

const SETTINGS_FILE = path.join(DATA, 'settings.json');
// 新安裝：程式載入時（建立使用者設定檔等任何檔案之前）settings.json 還不存在。新安裝的人直接用新的預設值（見 pinChangedDefaults）
const FRESH_INSTALL = !fs.existsSync(SETTINGS_FILE);
let settingsCache = null; // settings.json 讀取快取（見 readSettingsRaw）
const CONFIG_FILE = process.env.TAVERN_CONFIG ? path.resolve(process.env.TAVERN_CONFIG) : path.join(DATA, 'config.json'); // API 金鑰（userdata/ 已加入 .gitignore）

const newId = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const safeId = id => {
  if (typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id)) throw Object.assign(new Error('無效的 ID'), { status: 400 });
  return id;
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
/** 存在但讀不懂的設定檔（settings.json、config.json）：畫面上提示從備份還原，也不拿它做自動備份 */
function corruptFiles() {
  const out = [];
  for (const f of [SETTINGS_FILE, CONFIG_FILE]) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; } // 不存在：不是損毀
    try { JSON.parse(text); } catch { out.push(path.basename(f)); }
  }
  return out;
}
/**
 * 寫入之前讀取設定檔／金鑰檔：檔案不存在就用 fallback；檔案損毀（讀不懂）時「不能」當成空的，
 * 不然存一次設定就會把裡面的模型設定檔、使用者設定檔、其他金鑰全部清掉。
 * 這時把損毀的檔案另存一份（.corrupt-時間），並拒絕這次寫入
 */
function readJsonForWrite(file, fallback) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
  try { return JSON.parse(text); } catch {
    const copy = `${file}.corrupt-${timeStamp()}`;
    try { fs.copyFileSync(file, copy); } catch { /* 另存失敗也照樣拒絕寫入 */ }
    console.warn(`[存檔] ${path.basename(file)} 損毀，已另存為 ${path.basename(copy)}，拒絕寫入`);
    throw Object.assign(new Error(`${path.basename(file)} 損毀、讀不懂，為了不蓋掉裡面的資料，這次沒有儲存。損毀的檔案已另存為 ${path.basename(copy)}；可以到「設定 → 資料」從備份還原，或自行修正這個檔案。`), { status: 409 }); // 409：預期中的狀況（上面已記錄一行），不印錯誤堆疊
  }
}
// 同步等一下（存檔重試用）
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// 換名字被鎖住時，每次重試前等多久（毫秒）：防毒掃描、索引通常幾十毫秒就放開，先短後長；
// 等待期間整個伺服器都會停住（存檔是同步的），所以最多約 0.6 秒（以前是 1.5 秒）
const RENAME_WAITS = [10, 20, 40, 80, 160, 320];
/** 寫入 JSON：先寫暫存檔再換名字（中途斷電也不會只寫一半）；檔案被防毒軟體或雲端同步暫時鎖住時重試幾次 */
function writeJson(file, obj) { writeFileAtomic(file, JSON.stringify(obj, null, 2)); }
/** 寫入任何檔案（圖片、視窗位置等）：同樣先寫暫存檔再換名字 */
function writeFileAtomic(file, data) {
  if (file === SETTINGS_FILE) settingsCache = null; // 自己寫入的：不靠修改時間判斷，直接讓快取失效
  const tmp = file + '.tmp';
  // 換名字之前先確實寫進磁碟（fsync）：不然斷電時，換好名字的檔案可能是空的或整片 0
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) {
      if (i >= RENAME_WAITS.length || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      sleepSync(RENAME_WAITS[i]);
    }
  }
}

// 第一次啟動的引導（first_run_done）：已經在用的人（設定檔早就存在、還沒有這個欄位）當作看過了，不再跳出來
{
  const existing = readJson(SETTINGS_FILE, null);
  if (existing && !('first_run_done' in existing)) writeJson(SETTINGS_FILE, { ...existing, first_run_done: true });
}
// 舊版把所有設定（含預設值）都存進 settings.json：整理一次，和目前預設相同的欄位拿掉、改成跟隨預設（改過的照樣保留）
// 放在 DEFAULT_SETTINGS 定義之後執行（見檔案後段 compactSettingsFile）

// ---------- 設定 ----------
const DEFAULT_SETTINGS = {
  provider: 'openai', // openai = OpenAI 相容 API；gemini = Google Gemini；anthropic = Claude
  openai: { base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  gemini: { model: '' }, // 按「取得模型清單」選擇，避免預設的模型名稱過期
  anthropic: { model: 'claude-opus-5-5', effort: 'medium', thinking: '', fallbacks: true }, // thinking：'' 模型預設／on／off
  temperature: 0.7, // 1.2.2 以前是 0.9（舊資料保留 0.9，見 pinChangedDefaults）
  top_p: 1,
  repetition_penalty: 1, // 1 = 關閉
  retry_max: 2, // 連線失敗、太頻繁（429）、伺服器錯誤時自動重試的次數上限（0～5）
  // 省 token：導演只讀最近幾則（0 = 和角色相同，本機模型可共用快取）
  director_history: 20,
  // 聊天紀錄最多送多少 tokens（0 = 不限，只受上下文長度限制）；每段對話可以在「對話設定」另外指定
  history_cap_char: 16000,
  history_cap_world: 32000, // 大世界多位角色輪流說話，聊天紀錄長得比較快
  // 上下文壓縮：聊天紀錄超過可用空間的 compress_threshold% 時，把較舊的對話整理進記憶，只保留最近 compress_keep% 的原文
  compress_threshold: 70,
  compress_keep: 35,
  backup_keep: 7, // 每次啟動自動備份，最多保留幾份（0 = 關閉）
  trash_days: 7, // 刪除的角色、大世界、世界書與對話在垃圾桶保留幾天
  first_run_done: false, // 第一次啟動的引導按過「知道了」
  chat_render: 100, // 對話頁一開始顯示最近幾則訊息（0 = 全部）
  update_check: true, // 每次啟動時到 GitHub 檢查有沒有新版本（只檢查、不下載；「設定 → 關於」可以關閉）
  external_images: false, // 自動載入訊息、角色介紹裡的外部圖片（關閉時要點一下才載入：避免對方網站得知你的 IP、或把內容夾帶在網址裡送出）
  max_tokens: 8192, // 1.2.2 以前是 4096（舊資料保留 4096，見 pinChangedDefaults）
  context_tokens: 64000, // 1.5.0 以前是 32000（舊資料保留 32000，見 pinChangedDefaults）；本機小模型請調成模型支援的大小
  user_name: 'User', // 預設使用者設定檔的名字（見 ensurePersonas）
  user_persona: '',
  // 外觀：動畫（on / off）、背景、主題色（空白＝預設星光藍）、字級
  appearance: { motion: 'on', background: 'stars', bg_dim: 0.55, accent: '', font_size: 15 },
  main_prompt: [
    '這是一場與成年使用者共同進行的虛構互動小說創作。你負責扮演角色卡中的角色（大世界時依大世界提示詞的分工），與 {{user}} 一同推進故事。',
    '【創作原則】',
    '- 這是虛構作品，請依劇情需要自然描寫衝突、負面情緒、暴力或成人場景，不刻意淡化、迴避或轉移話題。',
    '- 以感官細節（視覺、聽覺、觸覺、氣味）描寫重要場景與親密互動，節奏循序漸進，不要一筆帶過或直接跳過過程。',
    '- 登場角色皆是成年角色，可發展成人內容；劇情與關係走向由玩家選擇。',
    '- 角色是有血有肉的人：會有缺點、偏見與情緒，可以生氣、拒絕或做出不完美的選擇，不必總是友善或順從。',
    '- 始終保持在角色中，不插入免責聲明、道德提醒或跳出故事的評論；對劇情方向不確定時，以符合角色個性的方式回應，而不是中斷故事。',
    '【寫作風格】',
    // 使用的語言：由「對話語言」設定決定（reply_language；提醒放在送出內容的最後面，思考型模型思考很短時也不會漏掉）
    '- 以第三人稱描寫角色的動作、神情與內心，對話與敘述交錯。',
    '- 每次回應約 2～4 段（大世界另有規定時，以大世界提示詞為準），留給 {{user}} 回應的空間。',
    '- 不要替 {{user}} 說話、決定行動或描寫 {{user}} 的內心。',
    // 你扮演的 NPC、你寫的旁白：不寫在這裡，只有這段對話真的用到時，程式才自動加上說明（lib/prompt.js 的 assemble）
  ].join('\n'),
  // 對話語言：依這個選擇，在每次送出內容的最後面加上語言提醒（角色、旁白、整理記憶都有；導演沒有）。
  // 只寫在系統提示開頭時，思考型模型把思考預算調低後常會漏掉，被英文角色卡帶著寫成英文。選項與提醒的文字見 lib/prompt.js 的 LANGUAGES
  reply_language: 'zh-TW',
  // reply_language 是 'custom' 時用的提醒文字（設定頁在選好的語言提醒上改寫過）
  language_custom: '',
  use_card_system_prompt: true,
  keep_status: 3, // 聊天紀錄中保留狀態欄（<details>）的則數，更早的不送給 AI（至少 3）
  // 大世界系統提示詞：大世界對話時接在主要系統提示後面
  world_prompt: [
    '這是一場多角色的大世界角色扮演，世界名稱是{{world}}。',
    '【角色表現】',
    '- 每個角色的語氣、用詞與說話習慣依照各自的設定與台詞範例，讓讀者不看名字也能分辨是誰在說話。',
    '- 只讓符合情境的角色登場或發言，不要硬塞角色，也不需要每個角色都說話。',
    '- 旁白負責描寫環境、推動事件；可適度引入環境變化或突發事件，但在需要 {{user}} 反應時停下。',
    '【配角】',
    '- 世界裡不是登場角色的人物（例如攤販、店員、路人、守衛、家人朋友），由旁白描寫他們的動作，需要時可以讓他們說簡短的台詞，格式為 配角稱呼：「台詞」，例如 攤販：「剛出爐的包子，來一個嗎？」。',
    '- 不要讓配角替 {{user}} 做決定。',
    '- 同一位配角再次出現時，保持一樣的稱呼、個性與說話方式。',
    '【兩種發言方式】',
    '- 一次寫出整個場景時：你同時擔任旁白與所有登場角色。敘述用一般段落；角色說話另起一行，格式為 角色名：「台詞」。每次約 3～5 段，推進一個場景片段即可，不要一次跳過太多時間或事件。',
    '- 指示中寫著「現在輪到某某發言」時：只寫那一位的部分，直接寫台詞與動作，前面不用加名字；每次 1～2 段，接著上一位的話說下去。',
  ].join('\n'),
  world_ids: [], // 全域啟用的世界書
  // 記憶：每段對話各自保存「劇情摘要＋重點」，放進提示詞，避免舊內容被裁掉後就忘記
  memory_enabled: true,
  memory_auto: true, // 自動壓縮：聊天紀錄快滿時，自動把舊對話整理進記憶（見 compress_threshold）
  memory_prompt: [
    '你是互動小說的記錄員，負責維護這段故事的長期記憶。',
    '請將「目前的記憶」與「新的對話內容」整合成一份更新後的完整記憶，總長度不超過 1000 字。', // 語言：見 reply_language（提醒接在最後）
    '【劇情摘要】',
    '依時間順序簡述重要事件。越早的事件寫得越精簡，近期事件可保留較多細節。',
    '【角色與關係】',
    '各角色的現況、彼此關係與感情變化。',
    '【未解決的事】',
    '約定、承諾、計畫、伏筆、尚未揭曉的謎團。此區內容除非已在劇情中解決，否則不可刪除。',
    '【已確立的設定】',
    '重要的人物、地點、物品與世界規則。',
    '【{{user}} 的角色設定】',
    '{{user}} 在故事中扮演的角色所透露的背景與喜好。只記錄故事內的設定，不記錄故事外的對話。',
    '規則：',
    '- 只記錄對話中實際發生或明確說出的內容，不寫入推測。',
    '- 角色的說法不等於事實：若內容可能是謊言、誤會或未經證實，請標註為「某某聲稱……」。',
    '- 標註「（NPC，由{{user}}扮演）」的發言屬於那位 NPC，不是 {{user}} 本人說的：NPC 的資訊歸到【角色與關係】，不要寫進【{{user}} 的角色設定】。',
    '- 有變化時以新內容為準，直接修改舊條目，不要保留互相矛盾的紀錄。',
    '- 超出長度時，優先精簡劇情摘要中較早的事件，不要刪除「未解決的事」。',
    '- 只輸出記憶本身，不要加任何說明。',
  ].join('\n'),
};

// settings.json 的快取：檔案沒變（修改時間與大小相同）就不重新讀取、解析；每次回傳一份副本，呼叫的人改了也不會動到快取
function readSettingsRaw() {
  let st;
  try { st = fs.statSync(SETTINGS_FILE); } catch { settingsCache = null; return {}; }
  if (!settingsCache || settingsCache.mtimeMs !== st.mtimeMs || settingsCache.size !== st.size) {
    const data = readJson(SETTINGS_FILE, null);
    // 讀不到或讀不懂（防毒、雲端同步暫時鎖住、寫到一半）：不放進快取，下次重新讀；這次當作沒有設定
    if (!data || typeof data !== 'object') { settingsCache = null; return {}; }
    settingsCache = { mtimeMs: st.mtimeMs, size: st.size, data };
  }
  return structuredClone(settingsCache.data);
}
/** 設定檔的內容補上預設值 */
const getSettings = () => withDefaults(readSettingsRaw());
function withDefaults(s) {
  const appearance = { ...DEFAULT_SETTINGS.appearance, ...(s.appearance || {}) };
  if (appearance.motion !== 'off') appearance.motion = 'on'; // 舊版的 system（跟隨 Windows）已移除，視為開啟
  return {
    ...DEFAULT_SETTINGS, ...s,
    openai: { ...DEFAULT_SETTINGS.openai, ...(s.openai || {}) },
    gemini: { ...DEFAULT_SETTINGS.gemini, ...(s.gemini || {}) },
    anthropic: { ...DEFAULT_SETTINGS.anthropic, ...(s.anthropic || {}) },
    appearance,
  };
}
function saveSettings(patch) {
  // 直接用這次讀到的內容合併（不經過快取）：settings.json 損毀或暫時讀不到時拒絕寫入，不然模型設定檔、使用者設定檔會被清空
  const raw = readJsonForWrite(SETTINGS_FILE, {});
  if ('user_name' in patch) {
    patch = { ...patch, user_name: cleanUserName(patch.user_name) };
    if (!patch.user_name) throw Object.assign(new Error('使用者名稱不能空白'), { status: 400 });
  }
  const cur = withDefaults(raw && typeof raw === 'object' ? raw : {});
  const next = { ...cur, ...patch };
  for (const k of PROVIDERS) if (patch[k]) next[k] = { ...cur[k], ...patch[k] };
  // 正在使用某個設定檔時，改了連線設定就一起更新那個設定檔
  const prof = (next.profiles || []).find(p => p.id === next.active_profile);
  if (prof) {
    const oldProvider = prof.provider;
    Object.assign(prof, snapshot(next));
    // 換了供應商：設定檔的金鑰改成新供應商目前的金鑰
    if (oldProvider !== prof.provider) {
      const cfg = readJsonForWrite(CONFIG_FILE, {});
      cfg.profile_keys = { ...(cfg.profile_keys || {}), [prof.id]: (cfg[prof.provider] && cfg[prof.provider].api_key) || '' };
      writeJson(CONFIG_FILE, cfg);
    }
  }
  // 正在使用某個使用者設定檔時，改了名字或人設就一起更新那個設定檔
  const persona = (next.personas || []).find(p => p.id === next.active_persona);
  if (persona && ('user_name' in patch || 'user_persona' in patch)) {
    persona.user_name = next.user_name;
    persona.user_persona = next.user_persona;
  }
  writeJson(SETTINGS_FILE, stripDefaults(next));
  return next;
}
/**
 * settings.json 只存「和程式預設不同」的欄位：沒改過的欄位跟隨預設，
 * 之後新版本改進了內建提示詞或預設值，沒改過的人會自動拿到新版；改過的照樣保留
 */
const SUB_OBJECT_KEYS = ['openai', 'gemini', 'anthropic', 'appearance'];
function stripDefaults(s) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    // 模型設定檔、使用者設定檔等不在預設裡的：照存。first_run_done 一定要存（沒有這個欄位會被當成舊使用者，不再顯示第一次的引導）
    if (!(k in DEFAULT_SETTINGS) || k === 'first_run_done') { out[k] = v; continue; }
    if (SUB_OBJECT_KEYS.includes(k) && v && typeof v === 'object') {
      const sub = {};
      for (const [sk, sv] of Object.entries(v)) if (!same(sv, DEFAULT_SETTINGS[k]?.[sk])) sub[sk] = sv;
      if (Object.keys(sub).length) out[k] = sub;
    } else if (!same(v, DEFAULT_SETTINGS[k])) out[k] = v;
  }
  return out;
}

// ---------- 使用者設定檔：名字、人設與頭像（頭像存在 personas/<id>.png） ----------
// 用法和模型設定檔一樣：設定頁目前的名字／人設／頭像可以存成設定檔、一鍵切換；
// 每段對話也可以在「對話設定」指定用哪個使用者設定檔（chat.persona_id）
const PERSONA_DIR = path.join(DATA, 'personas');
const personaAvatarFile = id => path.join(PERSONA_DIR, safeId(id) + '.png');
const personaAvatarVer = id => { try { return Math.floor(fs.statSync(personaAvatarFile(id)).mtimeMs); } catch { return 0; } };
const getPersonaAvatarPath = id => (fs.existsSync(personaAvatarFile(id)) ? personaAvatarFile(id) : null);
const findPersona = (s, id) => {
  const p = (s.personas || []).find(x => x.id === id);
  if (!p) throw Object.assign(new Error('找不到這個使用者設定檔'), { status: 404 });
  return p;
};
// 一定有一個使用中的使用者設定檔：全部刪光、舊備份沒有、使用中的不見了，都會自動補上或切換（見 ensurePersonas）
const cleanUserName = v => String(v ?? '').trim().slice(0, 60);
const DEFAULT_PERSONA = () => ({ name: DEFAULT_SETTINGS.user_name, user_name: DEFAULT_SETTINGS.user_name, user_persona: '' });
/** 使用者設定檔清單（附頭像版本號，0 = 沒有頭像） */
function listPersonas() {
  const s = ensurePersonas();
  return {
    active: s.active_persona,
    personas: s.personas.map(p => ({ id: p.id, name: p.name, user_name: p.user_name, user_persona: p.user_persona || '', avatar_ver: personaAvatarVer(p.id) })),
  };
}
const getPersona = id => (getSettings().personas || []).find(p => p.id === id) || null;
/**
 * 檢查使用者設定檔：一個都沒有時建立並套用預設的「User」；使用中的不見了就改用第一個；
 * 設定檔裡的名字是空白的（舊資料）就補成 User。啟動、刪除設定檔、還原備份後都會呼叫。
 */
function ensurePersonas() {
  let s = getSettings();
  const personas = s.personas || [];
  let fixed = false;
  for (const p of personas) {
    if (!cleanUserName(p.user_name)) { p.user_name = DEFAULT_SETTINGS.user_name; fixed = true; }
    if (!String(p.name || '').trim()) { p.name = p.user_name; fixed = true; }
  }
  if (!personas.length) {
    const p = { id: newId(), ...DEFAULT_PERSONA() }; // 預設設定檔沒有頭像
    return saveSettings({ personas: [p], active_persona: p.id, user_name: p.user_name, user_persona: p.user_persona });
  }
  if (!personas.some(p => p.id === s.active_persona)) {
    if (fixed) saveSettings({ personas });
    return applyPersona(personas[0].id);
  }
  // 目前的名字是空白（舊版允許）：用使用中設定檔的名字
  if (!cleanUserName(s.user_name)) {
    const act = personas.find(p => p.id === s.active_persona);
    return saveSettings({ personas, user_name: act.user_name });
  }
  if (fixed) s = saveSettings({ personas });
  return s;
}
/**
 * 建立新的使用者設定檔並設為使用中（名字、人設與頭像換成它的）。
 * fields：user_name、user_persona（沒給＝沿用目前的）；名字不能空白
 * avatar：Buffer＝這張圖；null＝不要頭像；不給＝沿用目前的頭像
 */
function createPersona(name, { avatar, user_name, user_persona } = {}) {
  const s = getSettings();
  const id = newId();
  const uname = cleanUserName(user_name ?? s.user_name);
  if (!uname) throw Object.assign(new Error('使用者名稱不能空白'), { status: 400 });
  const p = { id, name: String(name || '').trim() || uname, user_name: uname, user_persona: typeof user_persona === 'string' ? user_persona : (s.user_persona || '') };
  fs.mkdirSync(PERSONA_DIR, { recursive: true });
  if (avatar === undefined) {
    // 沿用目前的頭像：複製使用中設定檔的那一張
    const cur = s.active_persona && getPersonaAvatarPath(s.active_persona);
    if (cur) fs.copyFileSync(cur, personaAvatarFile(id));
  } else if (avatar) writeFileAtomic(personaAvatarFile(id), avatar);
  // avatar 是 null：新的設定檔不要頭像（什麼都不用寫）
  // 先切到新設定檔再寫名字與人設，原本使用中的設定檔不會被改到
  saveSettings({ personas: [...(s.personas || []), p], active_persona: id });
  saveSettings({ user_name: p.user_name, user_persona: p.user_persona });
  return p;
}
function renamePersona(id, name) {
  const s = getSettings();
  findPersona(s, id).name = String(name || '').trim() || '未命名';
  saveSettings({ personas: s.personas });
}
function deletePersona(id) {
  const s = getSettings();
  findPersona(s, id);
  const f = personaAvatarFile(id);
  if (fs.existsSync(f)) fs.unlinkSync(f);
  saveSettings({ personas: s.personas.filter(p => p.id !== id), active_persona: s.active_persona === id ? null : s.active_persona });
  ensurePersonas(); // 刪的是使用中的：改用第一個；全部刪光：還原並套用預設的 User
}
/** 切換到某個使用者設定檔：名字、人設與頭像換成它的（頭像直接讀它自己的，不用複製） */
function applyPersona(id) {
  const p = findPersona(getSettings(), id);
  return saveSettings({ user_name: cleanUserName(p.user_name) || DEFAULT_SETTINGS.user_name, user_persona: p.user_persona || '', active_persona: id });
}

// ---------- 模型設定檔：供應商、位址、模型、思考程度與生成參數；金鑰另外存在 config.json ----------
const PROFILE_FIELDS = ['provider', 'openai', 'gemini', 'anthropic', 'max_tokens', 'context_tokens', 'temperature', 'top_p', 'repetition_penalty',
  'retry_max', 'director_history'];
const snapshot = s => structuredClone(Object.fromEntries(PROFILE_FIELDS.map(k => [k, s[k]])));
const profileModel = p => (p[p.provider] || {}).model || '';
function listProfiles() {
  const s = getSettings();
  const keys = readJson(CONFIG_FILE, {}).profile_keys || {};
  return {
    active: (s.profiles || []).some(p => p.id === s.active_profile) ? s.active_profile : null,
    profiles: (s.profiles || []).map(p => ({ id: p.id, name: p.name, provider: p.provider, model: profileModel(p), has_key: !!keys[p.id] })),
  };
}
const findProfile = (s, id) => {
  const p = (s.profiles || []).find(x => x.id === id);
  if (!p) throw Object.assign(new Error('找不到這個設定檔'), { status: 404 });
  return p;
};
/**
 * 建立新的模型設定檔，並切換過去（一定有一個使用中的設定檔）。
 * fields：設定檔的內容（畫面上還沒儲存的連線設定與生成參數）；沒給＝用目前的設定。
 * key：這個設定檔的金鑰；沒給＝用目前存好的那個供應商的金鑰（新增時金鑰欄空白＝''，不沿用）。
 * 原本使用中的設定檔不會被改到：新內容直接放進新設定檔，不經過目前的設定
 */
function createProfile(name, { fields = null, key } = {}) {
  const s = getSettings();
  const merged = fields ? { ...s, ...fields } : s;
  if (fields) for (const k of PROVIDERS) if (fields[k]) merged[k] = { ...s[k], ...fields[k] };
  const data = snapshot(merged);
  const id = newId();
  const p = { id, name: String(name || '').trim() || profileModel(data) || '未命名設定檔', ...data };
  const cfg = readJsonForWrite(CONFIG_FILE, {});
  cfg.profile_keys = { ...(cfg.profile_keys || {}), [id]: typeof key === 'string' ? key : (cfg[data.provider] && cfg[data.provider].api_key) || '' };
  writeJson(CONFIG_FILE, cfg);
  saveSettings({ profiles: [...(s.profiles || []), p] });
  applyProfile(id);
  return p;
}
function renameProfile(id, name) {
  const s = getSettings();
  findProfile(s, id).name = String(name || '').trim() || '未命名設定檔';
  saveSettings({ profiles: s.profiles });
}
/**
 * 刪除設定檔。刪的是使用中的那個：切換到清單裡的第一個；全部刪光時，用目前的設定重新建立一個
 * （和使用者設定檔一樣，一定有一個在使用中）
 */
function deleteProfile(id) {
  const s = getSettings();
  findProfile(s, id);
  const cfg = readJsonForWrite(CONFIG_FILE, {});
  if (cfg.profile_keys) { delete cfg.profile_keys[id]; writeJson(CONFIG_FILE, cfg); }
  const rest = s.profiles.filter(p => p.id !== id);
  saveSettings({ profiles: rest, active_profile: s.active_profile === id ? null : s.active_profile });
  if (s.active_profile === id) {
    if (rest.length) applyProfile(rest[0].id);
    else createProfile('');
  }
}
/**
 * 確保有一個使用中的模型設定檔（啟動、還原或匯入資料之後呼叫）：
 * 舊資料可能沒有設定檔、或使用中的那個已經不在了：用目前的設定（含金鑰）建立一個，什麼都不會遺失
 */
function ensureProfile() {
  const s = getSettings();
  if ((s.profiles || []).some(p => p.id === s.active_profile)) return null;
  return createProfile('');
}
/**
 * 匯入別人的資料後：這台電腦沒有替這些設定檔存過金鑰，記成「空的」，
 * 切換過去時才不會沿用目前的金鑰（把你的金鑰送到別人設定的 API 位址）
 */
function blankProfileKeys(ids) {
  const cfg = readJsonForWrite(CONFIG_FILE, {});
  const keys = { ...(cfg.profile_keys || {}) };
  let changed = false;
  for (const id of ids) if (typeof keys[id] !== 'string') { keys[id] = ''; changed = true; }
  if (changed) { cfg.profile_keys = keys; writeJson(CONFIG_FILE, cfg); }
}
/** 切換到某個設定檔：連線設定與生成參數換成它的，金鑰也換成它存的那一把 */
function applyProfile(id) {
  const s0 = getSettings();
  const p = findProfile(s0, id);
  // 換掉目前的金鑰之前，先把它記回原本使用中的設定檔，切換回來時拿得回來
  // （例如切到匯入進來、還沒有金鑰的設定檔時，目前的金鑰不會就此消失）
  const cur = readJsonForWrite(CONFIG_FILE, {});
  const curKey = (cur[s0.provider] && cur[s0.provider].api_key) || '';
  const active = (s0.profiles || []).some(x => x.id === s0.active_profile) ? s0.active_profile : null;
  if (active && active !== id && curKey) {
    cur.profile_keys = { ...(cur.profile_keys || {}), [active]: curKey };
    writeJson(CONFIG_FILE, cur);
  }
  const cfg = readJsonForWrite(CONFIG_FILE, {});
  const key = (cfg.profile_keys || {})[id];
  if (typeof key === 'string') { cfg[p.provider] = { ...(cfg[p.provider] || {}), api_key: key }; writeJson(CONFIG_FILE, cfg); }
  return saveSettings({ ...snapshot(p), active_profile: id });
}

// ---------- 使用者頭像：就是「使用中的使用者設定檔」的頭像（personas/<id>.png），不另外存一份 ----------
const activePersonaId = () => getSettings().active_persona || null;
const getUserAvatarPath = () => { const id = activePersonaId(); return id ? getPersonaAvatarPath(id) : null; };
const userAvatarVer = () => { const id = activePersonaId(); return id ? personaAvatarVer(id) : 0; };
function setUserAvatar(buf) {
  const id = activePersonaId();
  if (!id) return;
  const f = personaAvatarFile(id);
  if (buf) { fs.mkdirSync(PERSONA_DIR, { recursive: true }); writeFileAtomic(f, buf); }
  else if (fs.existsSync(f)) fs.unlinkSync(f);
}

// ---------- 自訂背景圖（外觀設定） ----------
const BG_IMAGE = path.join(DATA, 'background.png');
const getBackgroundPath = () => (fs.existsSync(BG_IMAGE) ? BG_IMAGE : null);
const backgroundVer = () => { try { return Math.floor(fs.statSync(BG_IMAGE).mtimeMs); } catch { return 0; } };
function setBackground(buf) {
  if (buf) writeFileAtomic(BG_IMAGE, buf);
  else if (fs.existsSync(BG_IMAGE)) fs.unlinkSync(BG_IMAGE);
}

// ---------- API 金鑰：環境變數優先，其次 config.json ----------
const PROVIDERS = ['openai', 'gemini', 'anthropic'];
const ENV_KEYS = { openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' };
function getApiKey(provider) {
  const env = process.env[ENV_KEYS[provider]];
  if (env) return env;
  const cfg = readJson(CONFIG_FILE, {});
  return (cfg[provider] && cfg[provider].api_key) || '';
}
function keyStatus() {
  const cfg = readJson(CONFIG_FILE, {});
  const st = p => ({
    set: !!getApiKey(p),
    source: process.env[ENV_KEYS[p]] ? 'env' : cfg[p] && cfg[p].api_key ? 'config' : 'none',
  });
  return Object.fromEntries(PROVIDERS.map(p => [p, st(p)]));
}
function setApiKey(provider, key) {
  if (!PROVIDERS.includes(provider)) throw new Error('未知的 provider');
  const cfg = readJsonForWrite(CONFIG_FILE, {});
  cfg[provider] = { ...(cfg[provider] || {}), api_key: String(key || '') };
  // 使用中的設定檔是這個供應商時，金鑰也記到設定檔裡
  const s = getSettings();
  if (s.active_profile && (s.profiles || []).some(p => p.id === s.active_profile && p.provider === provider))
    cfg.profile_keys = { ...(cfg.profile_keys || {}), [s.active_profile]: String(key || '') };
  writeJson(CONFIG_FILE, cfg);
}

// ---------- 每個角色、每個大世界各自一個資料夾 ----------
// char/<名稱>-<id>/      card.json（資料）、cover.png（封面，也是匯出角色卡用的圖）、avatar.png（對話頭像，可省略）、chats/（對話）
// bigworld/<名稱>-<id>/  world.json、cover.png（可省略）、chats/
// 程式用 id 找資料夾（名稱只是方便在檔案總管辨認）；改名時資料夾跟著改名，改不了（例如資料夾正被其他程式使用）就先沿用舊名稱
/** 資料夾名稱用的名稱：拿掉 Windows 不能用的字元，太長就截斷 */
const folderName = (name, id) => {
  const n = String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 40).replace(/[. ]+$/, '');
  return `${n || '未命名'}-${id}`;
};
const idOfFolder = f => f.slice(f.lastIndexOf('-') + 1); // id 不含「-」（newId 產生的只有英數字）
function folderIndex(base) {
  const map = new Map();
  /** id → 資料夾完整路徑；找不到回傳 null（快取沒有或資料夾被搬走時重新掃描一次） */
  const find = id => {
    safeId(id);
    const hit = map.get(id);
    if (hit && fs.existsSync(hit)) return hit;
    map.clear();
    for (const e of fs.readdirSync(base, { withFileTypes: true })) if (e.isDirectory()) map.set(idOfFolder(e.name), path.join(base, e.name));
    return map.get(id) || null;
  };
  /** 確保 id 的資料夾存在而且名稱符合目前的名稱，回傳完整路徑 */
  const ensure = (id, name) => {
    const want = path.join(base, folderName(name, safeId(id)));
    const cur = find(id);
    if (!cur) { fs.mkdirSync(want, { recursive: true }); map.set(id, want); return want; }
    if (cur === want) return cur;
    try { fs.renameSync(cur, want); map.set(id, want); forgetListCache(cur); return want; } catch { return cur; } // 改不了名稱：沿用舊資料夾，下次儲存再試
  };
  /** 刪除：整個資料夾（含對話）移到 userdata/trash/（保留天數見設定，萬一刪錯還找得回來） */
  const remove = id => {
    const d = find(id);
    if (d) {
      const kind = path.basename(base);
      const info = readJson(path.join(d, kind === 'char' ? 'card.json' : 'world.json'), {});
      moveToTrash(d, kind, { id, name: (info.data && info.data.name) || info.name || '' });
      forgetListCache(d);
    }
    map.delete(id);
  };
  const list = () => fs.readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => ({ id: idOfFolder(e.name), dir: path.join(base, e.name) }));
  return { find, ensure, remove, list, clear: () => map.clear() };
}

// ---------- 垃圾桶：刪除的角色、大世界、世界書與對話先放這裡，超過保留天數（預設 7 天）自動清掉（不包含在備份裡） ----------
// trash/<種類>/<原本的名稱>（刪除於 時間）[.json]，旁邊的 <同名>.trash.json 記錄原本是什麼、屬於誰，還原時用
const TRASH = path.join(DATA, 'trash');
const TRASH_KINDS = ['char', 'bigworld', 'worlds', 'chats'];
const META_EXT = '.trash.json';
const STAMP_RE = /（刪除於 \d{8}-\d{6}）/;
const trashDays = () => { const n = Number(getSettings().trash_days); return Number.isInteger(n) && n >= 1 && n <= 365 ? n : 7; };
function moveToTrash(src, kind, meta = {}) {
  const stamp = timeStamp();
  const ext = path.extname(src); // 單一檔案（世界書、對話）保留副檔名
  let dest = path.join(TRASH, kind, `${path.basename(src, ext)}（刪除於 ${stamp}）${ext}`);
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(TRASH, kind, `${path.basename(src, ext)}（刪除於 ${stamp}）(${i})${ext}`); // 同一秒刪兩次
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try { fs.renameSync(src, dest); }
  catch { fs.cpSync(src, dest, { recursive: true }); fs.rmSync(src, { recursive: true, force: true }); } // 換名字失敗（例如被鎖住）：複製後再刪
  try { const now = new Date(); fs.utimesSync(dest, now, now); } catch { /* 保留天數從放進垃圾桶的時間算 */ }
  try { writeJson(dest + META_EXT, { ...meta, kind, deleted: Date.now() }); } catch { /* 沒有紀錄也能用檔名推回來 */ }
}
const trashPath = (kind, name) => {
  if (!TRASH_KINDS.includes(kind) || !name || /[\\/]/.test(name) || name.endsWith(META_EXT) || name === '.' || name === '..')
    throw Object.assign(new Error('垃圾桶裡沒有這個項目'), { status: 404 });
  const p = path.join(TRASH, kind, name);
  if (!fs.existsSync(p)) throw Object.assign(new Error('垃圾桶裡沒有這個項目（可能已經過期清掉了）'), { status: 404 });
  return p;
};
const sizeOf = p => { try { const st = fs.statSync(p); return st.isDirectory() ? fs.readdirSync(p).reduce((s, f) => s + sizeOf(path.join(p, f)), 0) : st.size; } catch { return 0; } };
/** 一個垃圾桶項目的資訊（舊版沒有 .trash.json 的項目從檔名與內容推回來） */
function trashInfo(kind, name) {
  const p = path.join(TRASH, kind, name);
  const meta = readJson(p + META_EXT, null) || {};
  let deleted = meta.deleted;
  if (!deleted) { try { deleted = fs.statSync(p).mtimeMs; } catch { deleted = Date.now(); } }
  const base = name.replace(STAMP_RE, '').replace(/\(\d+\)(?=(\.json)?$)/, '').replace(/\.json$/, '');
  const info = { kind, name, deleted, size: sizeOf(p), id: meta.id || (kind === 'char' || kind === 'bigworld' ? idOfFolder(base) : base) };
  if (kind === 'char' || kind === 'bigworld') {
    const j = readJson(path.join(p, kind === 'char' ? 'card.json' : 'world.json'), {});
    info.title = meta.name || (j.data && j.data.name) || j.name || base.slice(0, base.lastIndexOf('-')) || base;
    try { info.chats = fs.readdirSync(path.join(p, 'chats')).filter(f => f.endsWith('.json')).length; } catch { info.chats = 0; }
  } else if (kind === 'worlds') {
    info.title = meta.name || readJson(p, {}).name || base;
  } else {
    const c = readJson(p, {});
    info.title = meta.title || (typeof c.title === 'string' && c.title) || '未命名對話';
    info.owner = meta.owner || null;
    info.owner_name = meta.owner_name || '';
    info.messages = Array.isArray(c.messages) ? c.messages.length : 0;
  }
  return info;
}
/** 垃圾桶清單（新刪的在前面），順便清掉過期的 */
function listTrash() {
  purgeTrash();
  const days = trashDays(), out = [];
  for (const kind of TRASH_KINDS) {
    let names = [];
    try { names = fs.readdirSync(path.join(TRASH, kind)).filter(f => !f.endsWith(META_EXT)); } catch { continue; }
    for (const n of names) { const i = trashInfo(kind, n); i.expires = i.deleted + days * 86400000; out.push(i); }
  }
  return { days, items: out.sort((a, b) => b.deleted - a.deleted) };
}
/** 從垃圾桶永久刪除一項 */
function deleteTrashItem(kind, name) {
  const p = trashPath(kind, name);
  fs.rmSync(p, { recursive: true, force: true });
  fs.rmSync(p + META_EXT, { force: true });
}
/** 清空垃圾桶，回傳刪掉幾項 */
function emptyTrash() {
  const n = listTrash().items.length;
  fs.rmSync(TRASH, { recursive: true, force: true });
  return n;
}
/** 從垃圾桶還原到原本的位置 */
function restoreTrashItem(kind, name) {
  const p = trashPath(kind, name);
  const info = trashInfo(kind, name);
  const conflict = msg => Object.assign(new Error(msg), { status: 409 });
  let dest;
  if (kind === 'char' || kind === 'bigworld') {
    const idx = kind === 'char' ? charDirs : worldDirs;
    if (idx.find(info.id)) throw conflict(`已經有同一個${kind === 'char' ? '角色' : '大世界'}了，不能還原`);
    dest = path.join(kind === 'char' ? DIRS.characters : DIRS.bigworlds, folderName(info.title, info.id));
  } else if (kind === 'worlds') {
    dest = worldFile(info.id);
    if (fs.existsSync(dest)) throw conflict('已經有同一本世界書了，不能還原');
  } else {
    if (!info.owner) throw conflict('不知道這段對話原本屬於哪個角色，請到 userdata/trash/chats 手動搬回去');
    const dir = chatDir(info.owner);
    if (!dir) throw conflict(`原本的${info.owner.startsWith(WORLD_PREFIX) ? '大世界' : '角色'}「${info.owner_name || '?'}」已經不在了（可能也在垃圾桶裡），請先還原它`);
    fs.mkdirSync(dir, { recursive: true });
    dest = path.join(dir, safeId(info.id) + '.json');
    if (fs.existsSync(dest)) throw conflict('這段對話已經存在，不能還原');
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try { fs.renameSync(p, dest); }
  catch { fs.cpSync(p, dest, { recursive: true }); fs.rmSync(p, { recursive: true, force: true }); }
  fs.rmSync(p + META_EXT, { force: true });
  charDirs.clear(); worldDirs.clear(); summaryCache.clear(); searchCache.clear(); listCache.clear();
  return info;
}
/** 清掉放進垃圾桶超過保留天數的項目（啟動時、打開垃圾桶清單時、改了保留天數時） */
function purgeTrash() {
  if (!fs.existsSync(TRASH)) return;
  const limit = Date.now() - trashDays() * 86400000;
  for (const kind of fs.readdirSync(TRASH)) {
    const kdir = path.join(TRASH, kind);
    try {
      for (const f of fs.readdirSync(kdir)) {
        if (f.endsWith(META_EXT)) { if (!fs.existsSync(path.join(kdir, f.slice(0, -META_EXT.length)))) fs.rmSync(path.join(kdir, f), { force: true }); continue; }
        const p = path.join(kdir, f);
        const meta = readJson(p + META_EXT, null);
        const t = (meta && meta.deleted) || fs.statSync(p).mtimeMs;
        if (t < limit) { fs.rmSync(p, { recursive: true, force: true }); fs.rmSync(p + META_EXT, { force: true }); }
      }
    } catch { /* 略過 */ }
  }
}

const WORLD_PREFIX = 'world-'; // 大世界對話的擁有者 key：world-<id>
const charDirs = folderIndex(DIRS.characters);
const worldDirs = folderIndex(DIRS.bigworlds);
const inDir = (dir, f) => (dir ? path.join(dir, f) : null); // 資料夾不存在時回傳 null（readJson / existsSync 會當成沒有檔案）

// ---------- 角色 ----------
const charFile = id => inDir(charDirs.find(id), 'card.json');
const coverFile = id => inDir(charDirs.find(id), 'cover.png');
const avatarFile = id => inDir(charDirs.find(id), 'avatar.png');
const mtime = f => { try { return Math.floor(fs.statSync(f).mtimeMs); } catch { return 0; } };
const exists = f => !!f && fs.existsSync(f);

/** 表情圖（expressions/）：[{ name, ver }]（ver＝修改時間，圖片網址帶上它，換圖後不會讀到快取） */
const expressionInfo = id => expr.list(charDirs.find(id)).map(({ name, ver }) => ({ name, ver }));
const getCharDir = id => charDirs.find(id) || null;
function imageInfo(id) {
  const cover = coverFile(id), avatar = avatarFile(id);
  return { has_cover: exists(cover), has_avatar: exists(avatar), img_ver: mtime(cover) + mtime(avatar) };
}
// ---------- 順序 ID（首頁「自訂ID排序」用） ----------
// 存在角色／世界資料夾裡的 order.json：{ "order": 12 }。不改角色卡格式、不改資料夾名稱（ID 不變，世界成員、對話都不受影響）；
// 跟著資料夾一起改名、刪除、備份
const ORDER_FILE = 'order.json';
const ORDER_MAX = 9999; // 0～9999（4 位數）：輸入框也只能輸入 4 位數字
/**
 * 讀取順序 ID。檔案可能被手動改過：超出範圍的數字收進 0～9999（取整數），
 * 寫成 "12" 這種文字、或整個檔案只寫一個數字也接受；看不懂的內容當成沒有指定
 */
const readOrder = dir => {
  const raw = dir ? readJson(path.join(dir, ORDER_FILE), null) : null;
  let v = raw !== null && typeof raw === 'object' ? raw.order : raw;
  if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) v = Number(v);
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(ORDER_MAX, Math.max(0, Math.round(v)));
};
/** 設定順序 ID；order 是 null 時刪掉（回到沒有指定）。kind：'char'／'bigworld' */
function setOrder(kind, id, order) {
  const dir = (kind === 'bigworld' ? worldDirs : charDirs).find(id);
  if (!dir) throw Object.assign(new Error(kind === 'bigworld' ? '找不到世界' : '找不到角色'), { status: 404 });
  const file = path.join(dir, ORDER_FILE);
  if (order === null) { if (exists(file)) fs.unlinkSync(file); return null; }
  if (!Number.isInteger(order) || order < 0 || order > ORDER_MAX)
    throw Object.assign(new Error(`順序 ID 要是 0～${ORDER_MAX} 之間的整數（留空＝不指定）`), { status: 400 });
  writeJson(file, { order });
  return order;
}
/**
 * 讀取角色卡檔（card.json）：手動改壞、少了 data 或角色名稱時當成讀不到（回傳 null），
 * 只略過這一張，不會讓整個首頁、對話清單出錯
 */
function readCard(file) {
  const c = readJson(file, null);
  return c && typeof c === 'object' && c.data && typeof c.data === 'object' && typeof c.data.name === 'string' ? c : null;
}
/** 讀取世界檔（world.json）：不是物件時當成讀不到 */
function readWorldFile(file) {
  const w = readJson(file, null);
  return w && typeof w === 'object' && !Array.isArray(w) ? w : null;
}
/**
 * 清單用的讀取快取（首頁、對話清單、世界成員）：檔案沒變（修改時間與大小相同）就不重新讀取、解析。
 * 對話清單在生成中每幾秒就會更新一次，以前每次都把所有角色卡重讀一遍，卡片多、內嵌大型世界書時很吃 CPU。
 * 回傳的物件是共用的：呼叫端只能讀，不能修改（要修改的地方用 getCharacter／getBigWorld，那些不走快取）
 */
const listCache = new Map();
function readCached(file, read) {
  let st;
  try { st = fs.statSync(file); } catch { listCache.delete(file); return null; }
  const hit = listCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.v;
  const v = read(file);
  if (v) listCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, v }); else listCache.delete(file);
  return v;
}
/** 資料夾改名、刪除後：舊位置的快取不會再用到，拿掉（不然會一直留在記憶體裡） */
function forgetListCache(dir) { for (const f of ['card.json', 'world.json']) listCache.delete(path.join(dir, f)); }
const readCardCached = file => readCached(file, readCard);
const readWorldCached = file => readCached(file, readWorldFile);
function listCharacters() {
  return charDirs.list()
    .map(({ id, dir }) => {
      const c = readCardCached(path.join(dir, 'card.json'));
      if (!c) return null;
      const chats = listChats(id);
      return {
        id, name: c.data.name, tags: c.data.tags, creator_notes: (c.data.creator_notes || '').slice(0, 200),
        ...imageInfo(id), updated: c.updated || 0, created: c.created || 0, order: readOrder(dir),
        chat_count: chats.length,
        last_chat: chats[0] ? { id: chats[0].id, title: chats[0].title, updated: chats[0].updated, count: chats[0].count } : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => Math.max(b.updated, b.last_chat?.updated || 0) - Math.max(a.updated, a.last_chat?.updated || 0));
}
function getCharacter(id) {
  const c = readCard(charFile(id));
  if (!c) throw Object.assign(new Error('找不到角色'), { status: 404 });
  return { id, ...c, ...imageInfo(id), order: readOrder(charDirs.find(id)), expressions: expressionInfo(id) };
}
/** images: { cover?: Buffer, avatar?: Buffer|null }（avatar 為 null 代表移除頭像） */
/**
 * 存卡片前讀舊的（要沿用連結的世界書與建立時間）：檔案不存在或內容讀不懂時當作沒有；
 * 檔案暫時讀不到（防毒、雲端同步鎖住）時拒絕這次存檔，不然世界書的連結會不見
 */
function readPrevCard(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw Object.assign(new Error(`角色卡暫時讀不到（${e.code || e.message}），這次沒有儲存，請稍後再試一次`), { status: 503 });
  }
  try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
function saveCharacter(id, data, images = {}) {
  id = id || newId();
  const dir = charDirs.ensure(id, data && data.name); // 名稱改了：資料夾跟著改名
  const file = path.join(dir, 'card.json');
  const prev = readPrevCard(file);
  writeJson(file, { data, world_id: prev.world_id || null, created: prev.created || Date.now(), updated: Date.now() });
  if (images.cover) writeFileAtomic(path.join(dir, 'cover.png'), images.cover);
  const av = path.join(dir, 'avatar.png');
  if (images.avatar) writeFileAtomic(av, images.avatar);
  else if (images.avatar === null && fs.existsSync(av)) fs.unlinkSync(av);
  return id;
}
function setCharacterWorld(id, worldId) {
  const c = readJson(charFile(id), null);
  if (!c) throw Object.assign(new Error('找不到角色'), { status: 404 });
  c.world_id = worldId || null;
  writeJson(charFile(id), c);
}
/** 刪除角色：整個資料夾（含對話）一起刪掉 */
const deleteCharacter = id => charDirs.remove(id);
const getCoverPath = id => (exists(coverFile(id)) ? coverFile(id) : null);
/** 頭像：有專屬頭像用頭像，否則用封面 */
const getAvatarPath = id => (exists(avatarFile(id)) ? avatarFile(id) : getCoverPath(id));

// ---------- 聊天紀錄（放在角色或大世界資料夾裡的 chats/，每段對話一個 JSON） ----------
// owner 是角色 id，或大世界的 world-<id>
const ownerDir = owner => (String(owner).startsWith(WORLD_PREFIX) ? worldDirs.find(owner.slice(WORLD_PREFIX.length)) : charDirs.find(owner));
/** 對話資料夾；角色或世界不存在時：create = true 丟出 404，否則回傳 null */
function chatDir(owner, create = false) {
  const base = ownerDir(safeId(owner));
  if (!base) {
    if (create) throw Object.assign(new Error('找不到角色或世界'), { status: 404 });
    return null;
  }
  const d = path.join(base, 'chats');
  if (create) fs.mkdirSync(d, { recursive: true });
  return d;
}
const chatFile = (owner, chatId, create = false) => inDir(chatDir(owner, create), safeId(chatId) + '.json');

// 對話清單用的摘要快取：檔案沒變（修改時間與大小相同）就不重新讀整個對話檔
const summaryCache = new Map();
// 讀不懂、從清單略過的對話檔（畫面上提示從備份還原）
const brokenChats = new Set();
/** 目前已知損毀的對話檔（相對於 userdata 的路徑）：會先掃一遍所有對話 */
function brokenChatFiles() {
  listAllChats();
  return [...brokenChats].filter(f => fs.existsSync(f)).map(f => path.relative(DATA, f).replace(/\\/g, '/'));
}
function chatSummary(file) {
  let st;
  try { st = fs.statSync(file); } catch { summaryCache.delete(file); return null; }
  const hit = summaryCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.summary;
  const c = readJson(file, null);
  // 讀不懂的對話檔：只略過這一段，不能讓整份對話清單出錯
  if (!c || typeof c !== 'object' || !Array.isArray(c.messages)) {
    if (c !== null || fs.existsSync(file)) { console.warn(`[對話] 檔案損毀，略過：${file}`); brokenChats.add(file); }
    return null;
  }
  brokenChats.delete(file);
  const last = c.messages[c.messages.length - 1];
  const summary = {
    id: c.id, title: String(c.title || ''), updated: c.updated || 0, count: c.messages.length,
    started: c.messages.some(m => m && m.role === 'user'), // 使用者已經說過話（只作為資訊）
    preview: last ? String(last.content ?? '').slice(0, 60) : '',
    persona_id: c.persona_id || null, // 這段對話固定的使用者設定檔（null＝跟隨設定頁或自訂名字）
  };
  summaryCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, summary });
  return summary;
}
function listChats(owner) {
  const dir = chatDir(owner);
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => chatSummary(path.join(dir, f)))
    .filter(Boolean)
    .sort((a, b) => b.updated - a.updated);
}
/** 所有角色與大世界的對話（新的在前），附上擁有者名稱與圖片資訊 */
function listAllChats() {
  const out = [];
  for (const { id, dir } of charDirs.list()) {
    const c = readCardCached(path.join(dir, 'card.json'));
    if (!c) continue;
    const char = { id, name: c.data.name, ...imageInfo(id) };
    for (const ch of listChats(id)) out.push({ ...ch, char });
  }
  // 大世界的對話：擁有者 key 為 world-<id>
  for (const { id, dir } of worldDirs.list()) {
    const w = readWorldCached(path.join(dir, 'world.json'));
    if (!w) continue;
    const char ={ id: WORLD_PREFIX + id, name: w.name, is_world: true, ...worldImageInfo(id) };
    for (const ch of listChats(WORLD_PREFIX + id)) out.push({ ...ch, char });
  }
  return out.sort((a, b) => b.updated - a.updated);
}
// 全文搜尋用的快取：每個對話檔的訊息文字（轉小寫），檔案沒變就不重讀
const searchCache = new Map();
/**
 * 搜尋所有對話的訊息內容（不分大小寫）。只搜尋目前存在的角色與世界的對話。
 * 回傳 [{ owner, chat, title, index, role, speaker, snippet }]，新的對話在前、同一段對話依訊息順序
 */
function searchMessages(query, limit = 80) {
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) return [];
  const qre = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); // 搜尋字照字面比對（不當成正規表示式）
  const results = [];
  const personas = getSettings().personas || [];
  // 你這一側訊息的名字：這段對話指定的使用者設定檔 > 這段對話自訂的名字（都沒有＝空字串，畫面用設定頁的名字）
  const userNameOf = hit => (hit.persona_id && personas.find(p => p.id === hit.persona_id)?.user_name) || hit.user_name || '';
  const chats = listAllChats().map(ch => ({ ch, file: chatFile(ch.char.id, ch.id) }));
  // 已經刪掉、搬走的對話：快取裡的全文拿掉（不然會一直留在記憶體裡）
  const live = new Set(chats.map(x => x.file));
  for (const f of searchCache.keys()) if (!live.has(f)) searchCache.delete(f);
  for (const { ch, file } of chats) {
    let st; try { st = fs.statSync(file); } catch { continue; } // file 為 null 時也會跳過
    let hit = searchCache.get(file);
    if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
      const c = readJson(file, null);
      if (!c || !Array.isArray(c.messages)) continue; // 損毀的對話檔：略過
      // 搜尋看得到的文字：拿掉 HTML 標籤與思考內容
      const plain = s => stripThink(s).replace(/<[^>]*>/g, ' ').replace(/[ \t]+/g, ' ');
      hit = { mtimeMs: st.mtimeMs, size: st.size, persona_id: c.persona_id || null, user_name: typeof c.user_name === 'string' ? c.user_name.trim() : '',
        msgs: c.messages.map(m => ({ role: m?.role, speaker: m?.speaker || null, npc: m?.npc || null, narration: !!m?.narration, text: plain(m?.content) })) };
      searchCache.set(file, hit);
    }
    // 快取只存原文一份（以前另外存一份小寫的，所有對話的文字在記憶體裡放兩份）；
    // 用不分大小寫的正規表示式直接在原文裡找，位置就是原文的位置
    hit.msgs.forEach((m, index) => {
      if (results.length >= limit) return;
      const at = m.text.search(qre);
      if (at < 0) return;
      const from = Math.max(0, at - 30);
      results.push({
        owner: ch.char.id, chat: ch.id, title: ch.title, index, role: m.role, speaker: m.speaker,
        ...(m.role === 'user' ? { user_name: m.npc || (m.narration ? '旁白（你寫的）' : userNameOf(hit)) } : {}),
        snippet: (from ? '…' : '') + m.text.slice(from, at + q.length + 50).replace(/\s+/g, ' ') + (at + q.length + 50 < m.text.length ? '…' : ''),
      });
    });
    if (results.length >= limit) break;
  }
  return results;
}

/**
 * 每段對話開始時就固定使用者設定檔（chat.persona_id，見 server.js 的 newChatFor）：開場白在建立時就把 {{user}} 換成當時的名字，
 * 之後在設定頁切換設定檔，對話裡的名字才不會前後不一致。
 * 舊版的對話沒有記錄、一律跟著設定頁：一次性地固定到目前使用中的設定檔（現在畫面上顯示的就是它，看起來不會變）。
 * 自訂了名字或人設的對話不動。做過就記在 settings.json 的 chat_persona_pinned；還原沒有這個記錄的舊備份時會再做一次。
 * 不更新 updated：對話清單的順序不變。回傳固定了幾段對話
 */
function pinChatPersonas() {
  const s = getSettings();
  if (s.chat_persona_pinned) return 0;
  const pid = (s.personas || []).some(p => p.id === s.active_persona) ? s.active_persona : null;
  if (!pid) return 0; // 還沒有使用者設定檔（ensurePersonas 之後再做）
  let n = 0;
  for (const ch of listAllChats()) {
    const file = chatFile(ch.char.id, ch.id);
    const c = file && readJson(file, null);
    if (!c || !Array.isArray(c.messages) || c.persona_id) continue;
    if ((typeof c.user_name === 'string' && c.user_name.trim()) || (typeof c.user_persona === 'string' && c.user_persona.trim())) continue;
    c.persona_id = pid;
    writeJson(file, c);
    n++;
  }
  saveSettings({ chat_persona_pinned: true });
  return n;
}
function getChat(charId, chatId) {
  const c = readJson(chatFile(charId, chatId), null);
  if (!c || typeof c !== 'object') throw Object.assign(new Error('找不到聊天紀錄'), { status: 404 });
  return cleanChatMessages(c);
}
/**
 * 讀進來的對話：格式不對的訊息（手動改過的檔案、匯入的備份）略過，內容不是文字的轉成文字，
 * 不然一則壞掉的訊息會讓整段對話無法生成。只改記憶體裡的，檔案下次存檔時才會更新
 */
function cleanChatMessages(c) {
  if (!Array.isArray(c.messages)) { c.messages = []; return c; }
  if (c.messages.every(isChatMessage)) return c;
  c.messages = c.messages.filter(m => m && typeof m === 'object' && !Array.isArray(m) && typeof m.role === 'string')
    .map(m => (typeof m.content === 'string' ? m : { ...m, content: m.content == null ? '' : String(m.content) }));
  return c;
}
const isChatMessage = m => !!m && typeof m === 'object' && !Array.isArray(m) && typeof m.role === 'string' && typeof m.content === 'string';
/** 對話檔目前的修改時間與大小（生成存檔時用來判斷：自己上次寫入之後有沒有別人改過，沒有就不用重讀）；不存在回傳 null */
function chatStat(charId, chatId) {
  const f = chatFile(charId, chatId);
  if (!f) return null;
  try { const st = fs.statSync(f); return { mtimeMs: st.mtimeMs, size: st.size }; } catch { return null; }
}
/** touch = false：不更新 updated（對話清單的順序不變，例如只關掉一個「訊息已刪除」的框） */
function saveChat(charId, chat, { touch = true } = {}) {
  chat.id = chat.id || newId();
  if (touch || !chat.updated) chat.updated = Date.now();
  chat.created = chat.created || Date.now();
  // 對話檔不縮排：生成時一則訊息要存好幾次，長對話縮排後大三成，每次整份重寫都是浪費（讀取時兩種都一樣）
  writeFileAtomic(chatFile(charId, chat.id, true), JSON.stringify(chat));
  return chat;
}
/**
 * 清空聊天前留一份完整的副本在垃圾桶（新的對話 ID、標題加上「（清空前）」）：
 * 清錯了可以從「設定 → 資料 → 垃圾桶」還原成另一段對話，原本的對話不受影響
 */
function snapshotChatToTrash(charId, chat, suffix = '（清空前）') {
  const copy = { ...structuredClone(chat), id: newId(), title: `${chat.title || '未命名對話'}${suffix}` };
  delete copy.deleted; // 「訊息已刪除」的框只屬於原本那段對話
  const od = path.basename(ownerDir(charId) || '');
  const tmp = path.join(TRASH, 'chats', copy.id + '.json');
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  writeJson(tmp, copy);
  moveToTrash(tmp, 'chats', { id: copy.id, owner: charId, owner_name: od.slice(0, od.lastIndexOf('-')), title: copy.title });
  return copy.id;
}
/** 刪除對話：移到垃圾桶（記下屬於哪個角色／大世界，還原時放回去） */
function deleteChat(charId, chatId) {
  const f = chatFile(charId, chatId);
  if (!exists(f)) return;
  const c = readJson(f, {});
  const od = path.basename(ownerDir(charId) || '');
  moveToTrash(f, 'chats', { id: chatId, owner: charId, owner_name: od.slice(0, od.lastIndexOf('-')), title: typeof c.title === 'string' ? c.title : '' });
  summaryCache.delete(f);
}

// ---------- 大世界（多角色世界卡） ----------
// world.json 只記錄成員角色的 ID 與各自的設定，不複製角色卡內容；需要時才讀取角色卡。
// cover.png 是封面（沒有時使用預設的風景圖）。對話存在同一個資料夾的 chats/，擁有者 key 為 world-<id>。
const bigWorldFile = id => inDir(worldDirs.find(id), 'world.json');
const bigWorldCover = id => inDir(worldDirs.find(id), 'cover.png');
const worldImageInfo = id => { const c = bigWorldCover(id); return { has_cover: true, custom_cover: exists(c), img_ver: mtime(c) }; };
const SYS_MODES = ['full', 'none', 'custom'];

function normalizeOpening(d) {
  if (Array.isArray(d.opening)) {
    return d.opening
      .filter(o => o && typeof o.speaker === 'string' && /^[\w-]{1,80}$/.test(o.speaker))
      .map(o => ({ speaker: o.speaker, content: String(o.content || '') }))
      .filter(o => o.content.trim());
  }
  return String(d.first_mes || '').trim() ? [{ speaker: 'narrator', content: String(d.first_mes) }] : [];
}
function normalizeBigWorld(d) {
  d = d || {};
  return {
    spec: 'tavern_bigworld_v1',
    name: String(d.name || '').trim() || '未命名世界',
    tags: Array.isArray(d.tags) ? d.tags.map(String).filter(Boolean) : [],
    intro: String(d.intro || ''), // 世界介紹：只顯示，不送給 AI
    setting: String(d.setting || ''), // 世界設定（世界觀）：每一輪都送給角色、旁白與導演
    system_prompt: String(d.system_prompt || ''), // 這個世界額外的系統提示詞
    post_history_instructions: String(d.post_history_instructions || ''),
    // 開場白：由玩家自己寫的一串訊息，每則指定由誰說（narrator 旁白、user 玩家、或成員角色的 id）；
    // 舊世界卡只有一段 first_mes，視為旁白的開場
    opening: normalizeOpening(d),
    // 發言模式：narrator = 一次寫出所有人（旁白統一）；turns = 每個角色各自發言
    turn_mode: d.turn_mode === 'narrator' ? 'narrator' : 'turns', // 預設輪流發言
    // 輪流發言一律由導演規劃方向與發言順序，導演不安排旁白（沒有角色在場時例外）——寫在 lib/turns.js，不需要設定
    max_replies: Math.min(5, Math.max(1, Number(d.max_replies) || 2)), // 你說完話後最多幾位角色接話
    allow_interrupt: d.allow_interrupt !== false, // 允許角色插話
    interrupt_rate: Math.min(100, Math.max(0, Number(d.interrupt_rate ?? 25))),
    cut_interrupt: d.cut_interrupt !== false, // 插話時把上一位的話從中間截斷（預設開啟）
    members: (Array.isArray(d.members) ? d.members : [])
      .filter(m => m && typeof m.id === 'string' && /^[\w-]{1,80}$/.test(m.id))
      .filter((m, i, a) => a.findIndex(x => x.id === m.id) === i)
      .map(m => ({
        id: m.id,
        // 角色卡系統提示的處理：full 完整套用、none 不套用、custom 改用自訂內容（只留角色扮演規則）
        sys_mode: SYS_MODES.includes(m.sys_mode) ? m.sys_mode : 'full',
        sys_custom: String(m.sys_custom || ''),
        // 公開資訊：其他角色對這個角色的了解（外表、身分等大家都知道的事）
        public_info: String(m.public_info || ''),
        // 角色卡帶來的世界書：內嵌的、連結的，各自可開關（預設開啟，跟隨角色卡）
        book_embedded: m.book_embedded !== false,
        book_linked: m.book_linked !== false,
        // 個別關掉的條目：emb:<條目 id>（內嵌）、lnk:<條目 id>（連結的世界書）
        book_off: (Array.isArray(m.book_off) ? m.book_off : []).map(String).filter(s => /^(emb|lnk):/.test(s)),
      })),
    // 世界專屬的世界書：連結的全域世界書＋內嵌在世界卡裡的條目
    world_ids: (Array.isArray(d.world_ids) ? d.world_ids : []).filter(id => typeof id === 'string' && /^[\w-]{1,80}$/.test(id)),
    character_book: d.character_book && Array.isArray(d.character_book.entries) && d.character_book.entries.length ? d.character_book : null,
    // 狀態欄的欄位（所有成員共用角色欄位、玩家欄位一份）；沒有欄位是 null
    status: cleanStatusDef(d.status),
  };
}
/** 成員的顯示資訊（名稱、頭像）；找不到的角色標記 missing */
function memberInfo(m) {
  const c = readCardCached(charFile(m.id));
  return c ? { ...m, name: c.data.name, ...imageInfo(m.id) } : { ...m, name: '（已刪除的角色）', missing: true };
}
function listBigWorlds() {
  return worldDirs.list()
    .map(({ id, dir }) => {
      const w = readWorldCached(path.join(dir, 'world.json'));
      if (!w) return null;
      const chats = listChats(WORLD_PREFIX + id);
      return {
        id, key: WORLD_PREFIX + id, name: w.name, tags: w.tags || [], intro: (w.intro || '').slice(0, 200),
        members: (w.members || []).map(memberInfo).filter(m => !m.missing),
        ...worldImageInfo(id), updated: w.updated || 0, created: w.created || 0, order: readOrder(dir),
        chat_count: chats.length,
        last_chat: chats[0] ? { id: chats[0].id, title: chats[0].title, updated: chats[0].updated, count: chats[0].count } : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => Math.max(b.updated, b.last_chat?.updated || 0) - Math.max(a.updated, a.last_chat?.updated || 0));
}
function getBigWorld(id) {
  const w = readJson(bigWorldFile(id), null);
  if (!w) throw Object.assign(new Error('找不到世界'), { status: 404 });
  // 補上舊世界卡沒有的欄位（例如發言模式），預設值與 normalizeBigWorld 相同
  const { members: _m, ...defaults } = normalizeBigWorld({ ...w, members: [] });
  // 成員的表情圖與預設表情：對話頁的狀態欄要顯示
  const withExpr = m => (m.missing ? m : { ...m, expressions: expressionInfo(m.id), expr_default: readCardCached(charFile(m.id))?.data?.extensions?.ai_tavern_expressions?.default || null });
  return { id, key: WORLD_PREFIX + id, ...w, ...defaults, members: (w.members || []).map(memberInfo).map(withExpr), ...worldImageInfo(id), order: readOrder(worldDirs.find(id)) };
}
function saveBigWorld(id, data, cover) {
  id = id || newId();
  const norm = normalizeBigWorld(data);
  const dir = worldDirs.ensure(id, norm.name); // 名稱改了：資料夾跟著改名
  const file = path.join(dir, 'world.json'), coverPath = path.join(dir, 'cover.png');
  const prev = readJson(file, {});
  writeJson(file, { ...norm, created: prev.created || Date.now(), updated: Date.now() });
  if (cover) writeFileAtomic(coverPath, cover);
  else if (cover === null && fs.existsSync(coverPath)) fs.unlinkSync(coverPath);
  return id;
}
/** 刪除世界：整個資料夾（含對話）一起刪掉；成員角色不受影響 */
const deleteBigWorld = id => worldDirs.remove(id);
const getBigWorldCoverPath = id => (exists(bigWorldCover(id)) ? bigWorldCover(id) : null);

// ---------- 世界書 ----------
const worldFile = id => path.join(DIRS.worlds, safeId(id) + '.json');
function listWorlds() {
  return fs.readdirSync(DIRS.worlds)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const w = readJson(path.join(DIRS.worlds, f), null);
      // 沒有名稱的（手動改過的檔案）：用檔名代替，不然整份清單排序時會出錯
      return w && typeof w === 'object' && { id: f.slice(0, -5), name: typeof w.name === 'string' && w.name ? w.name : f.slice(0, -5), count: Array.isArray(w.entries) ? w.entries.length : 0 };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}
/**
 * 卡片目前的版本（檔案內容的雜湊）：編輯頁打開時記下來，存檔時帶回來比對；
 * 不一樣＝這段時間在別的視窗（或別台裝置）改過，不要直接蓋掉。kind：char／bigworld／world（世界書）
 */
function fileVer(kind, id) {
  const file = kind === 'char' ? charFile(id) : kind === 'bigworld' ? bigWorldFile(id) : kind === 'world' ? worldFile(id) : null;
  try { return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 16); } catch { return ''; }
}
function getWorld(id) {
  const w = readJson(worldFile(id), null);
  if (!w) throw Object.assign(new Error('找不到世界書'), { status: 404 });
  return { id, ...w };
}
function saveWorld(id, book) {
  id = id || newId();
  const { id: _drop, ...rest } = book;
  writeJson(worldFile(id), rest);
  return id;
}
function deleteWorld(id) {
  const f = worldFile(id);
  if (fs.existsSync(f)) moveToTrash(f, 'worlds', { id, name: readJson(f, {}).name || '' }); // 移到垃圾桶，超過保留天數才清除
}

/**
 * 改過的程式預設值：settings.json 只存「和預設不同」的欄位，所以預設值一改，
 * 原本剛好用舊預設值的人，設定會在不知不覺中跟著變（例如 Temperature 0.9 → 0.7，和模型設定檔上寫的對不起來）。
 * 已經有 settings.json 的人（舊資料、還原的舊備份）：沒存這個欄位就寫入舊的預設值，維持原本的行為；新安裝的才用新預設值
 */
// 1.2.2：Temperature 預設 0.9 → 0.7（比較不會偏離角色設定）；最大回應 tokens 4096 → 8192（思考型模型的思考也算在裡面）
// 1.6.0：上下文長度預設 32000 → 64000（大世界角色多時，扣掉提示詞後聊天紀錄才送得滿 32k 的上限）
const CHANGED_DEFAULTS = { temperature: 0.9, max_tokens: 4096, context_tokens: 32000 };
/**
 * 每個欄位只處理一次（記在 settings.json 的 pinned_defaults）：之後你自己按「填回預設值」改成新的預設，
 * 下次啟動不會又被改回舊的值。回傳這次寫入了舊值的欄位
 */
function pinChangedDefaults(opts = {}) {
  if (!fs.existsSync(SETTINGS_FILE) || corruptFiles().includes(path.basename(SETTINGS_FILE))) return [];
  const raw = readJson(SETTINGS_FILE, null);
  if (!raw || typeof raw !== 'object') return [];
  const done = new Set(Array.isArray(raw.pinned_defaults) ? raw.pinned_defaults : []);
  const todo = Object.keys(CHANGED_DEFAULTS).filter(k => !done.has(k));
  if (!todo.length) return [];
  // 新安裝的（這次啟動前沒有 settings.json）：直接用新的預設值，只記下「處理過了」
  const pinned = FRESH_INSTALL && !opts.restored ? [] : todo.filter(k => !(k in raw));
  for (const k of pinned) raw[k] = CHANGED_DEFAULTS[k];
  raw.pinned_defaults = [...done, ...todo];
  writeJson(SETTINGS_FILE, raw);
  settingsCache = null;
  return pinned;
}
// ---------- 舊版資料結構 → 每個角色／世界一個資料夾 ----------
// 舊版：char/<id>.json、<id>.png、<id>.avatar.png；bigworld/<id>.json、<id>.png；chats/<id>/、chats/world-<id>/
// keepCopy：搬之前先把舊資料原樣複製一份到 backups/before-folder-layout-<時間>/（還原舊備份時不需要，那時已經另外備份過）
function migrateLayout({ keepCopy = true } = {}) {
  const topJson = dir => fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.json')).map(e => e.name.slice(0, -5));
  const oldChars = topJson(DIRS.characters), oldWorlds = topJson(DIRS.bigworlds);
  if (!oldChars.length && !oldWorlds.length && !fs.existsSync(LEGACY_CHATS)) return 0;
  if (keepCopy) {
    const copy = path.join(DATA, 'backups', `before-folder-layout-${timeStamp()}`);
    for (const sub of ['char', 'bigworld', 'chats']) {
      const src = path.join(DATA, sub);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(copy, sub), { recursive: true });
    }
  }
  const move = (src, dest) => { if (fs.existsSync(src) && !fs.existsSync(dest)) fs.renameSync(src, dest); };
  let n = 0;
  for (const id of oldChars) {
    try {
      const c = readJson(path.join(DIRS.characters, id + '.json'), null);
      const dir = charDirs.ensure(id, c && c.data && c.data.name);
      move(path.join(DIRS.characters, id + '.json'), path.join(dir, 'card.json'));
      move(path.join(DIRS.characters, id + '.png'), path.join(dir, 'cover.png'));
      move(path.join(DIRS.characters, id + '.avatar.png'), path.join(dir, 'avatar.png'));
      if (fs.existsSync(path.join(LEGACY_CHATS, id))) moveInto(path.join(LEGACY_CHATS, id), path.join(dir, 'chats'));
      n++;
    } catch (e) { console.warn(`[整理資料夾] 角色 ${id} 搬移失敗：${e.message}`); }
  }
  for (const id of oldWorlds) {
    try {
      const w = readJson(path.join(DIRS.bigworlds, id + '.json'), null);
      const dir = worldDirs.ensure(id, w && w.name);
      move(path.join(DIRS.bigworlds, id + '.json'), path.join(dir, 'world.json'));
      move(path.join(DIRS.bigworlds, id + '.png'), path.join(dir, 'cover.png'));
      if (fs.existsSync(path.join(LEGACY_CHATS, WORLD_PREFIX + id))) moveInto(path.join(LEGACY_CHATS, WORLD_PREFIX + id), path.join(dir, 'chats'));
      n++;
    } catch (e) { console.warn(`[整理資料夾] 世界 ${id} 搬移失敗：${e.message}`); }
  }
  // 舊的 chats/：搬完是空的就刪掉；剩下的是找不到角色或世界的對話，留在原處不動
  if (fs.existsSync(LEGACY_CHATS)) {
    for (const f of fs.readdirSync(LEGACY_CHATS)) {
      const p = path.join(LEGACY_CHATS, f);
      try { if (fs.statSync(p).isDirectory() && !fs.readdirSync(p).length) fs.rmdirSync(p); } catch { /* 略過 */ }
    }
    if (!fs.readdirSync(LEGACY_CHATS).length) fs.rmdirSync(LEGACY_CHATS);
    else console.warn('[整理資料夾] userdata/chats 裡還有找不到角色或世界的對話，已保留在原處');
  }
  charDirs.clear(); worldDirs.clear(); summaryCache.clear(); searchCache.clear(); listCache.clear();
  return n;
}
// 由 server.js 在伺服器真的啟動（拿到連接埠）後才呼叫：已經有另一個 AI 酒館在執行時不搬，免得兩邊同時改資料

try { purgeTrash(); } catch { /* 清不掉下次再試 */ }
try { ensurePersonas(); } catch { /* settings.json 損毀時不動它（saveSettings 會拒絕寫入） */ }
// 舊版的 settings.json 存了全部設定：整理成只存改過的欄位（損毀的檔案不動）
function compactSettingsFile() {
  const raw = readJson(SETTINGS_FILE, null);
  if (!raw || typeof raw !== 'object' || corruptFiles().includes(path.basename(SETTINGS_FILE))) return;
  const compact = stripDefaults(raw);
  if (JSON.stringify(compact) !== JSON.stringify(raw)) writeJson(SETTINGS_FILE, compact);
}
try { compactSettingsFile(); } catch { /* 整理不了就維持原樣，下次存設定時也會整理 */ }

module.exports = {
  getCharDir, expressionInfo,
  migrateLayout,
  listTrash, restoreTrashItem, deleteTrashItem, emptyTrash, purgeTrash,
  DEFAULT_SETTINGS, getSettings, getUserAvatarPath, userAvatarVer, setUserAvatar, saveSettings, getApiKey, keyStatus, setApiKey,
  PROFILE_FIELDS, listProfiles, createProfile, renameProfile, deleteProfile, applyProfile, ensureProfile,
  corruptFiles, pinChangedDefaults, pinChatPersonas, activePersonaId, blankProfileKeys, listPersonas, getPersona, createPersona, ensurePersonas, renamePersona, deletePersona, applyPersona, getPersonaAvatarPath, personaAvatarVer,
  getBackgroundPath, backgroundVer, setBackground,
  DATA_DIR: DATA, writeFileAtomic, clearCaches: () => { summaryCache.clear(); searchCache.clear(); charDirs.clear(); worldDirs.clear(); listCache.clear(); }, searchMessages,
  setOrder, listCharacters, getCharacter, saveCharacter, setCharacterWorld, deleteCharacter, getAvatarPath, getCoverPath,
  fileVer, listChats, listAllChats, brokenChatFiles, getChat, chatStat, isChatMessage, saveChat, deleteChat, snapshotChatToTrash,
  listWorlds, getWorld, saveWorld, deleteWorld,
  WORLD_PREFIX, listBigWorlds, getBigWorld, saveBigWorld, deleteBigWorld, getBigWorldCoverPath,
};
