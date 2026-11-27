'use strict';
// AI 酒館 前端 — 共用：小工具、圖示、API、文字排版、對話框、圖片、外觀、頁面切換
// 這些檔案依序載入（見 index.html），共用同一個全域範圍；最後由 main.js 啟動
// ===================== AI 酒館 前端 =====================

const $ = (s, el = document) => el.querySelector(s);
const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
};
// ---------- 圖示（Lucide，見 icons.js） ----------
function icon(name, cls = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) s.setAttribute(k, v);
  s.setAttribute('class', ('ic ' + cls).trim());
  s.innerHTML = ICONS[name] || '';
  return s;
}
/** 圖示＋文字（給 h() 當子元素用） */
const ic = (name, text) => (text ? [icon(name), text] : icon(name));
// 把 HTML 裡的 <i data-icon="…"> 換成圖示
for (const el of document.querySelectorAll('i[data-icon]')) el.replaceWith(icon(el.dataset.icon, el.className));

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const state = {
  settings: null, keys: null,
  chars: [], char: null, chatId: null, chat: null,
  generating: false, abort: null, worlds: [],
};

// ---------- API ----------
async function api(method, url, body, raw) {
  const opt = { method, headers: {} };
  if (raw) { opt.body = body; if (raw !== true) Object.assign(opt.headers, raw); }
  else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(url, opt);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.error || `HTTP ${res.status}`), { status: res.status, code: j.code }); // status、code：呼叫端分辨衝突（409、card_stale）用
  return j;
}

function toast(msg, err, ms) {
  const el = h('div', { class: err ? 'err' : '' }, msg);
  $('#toast').append(el);
  setTimeout(() => el.remove(), ms || (err ? 6000 : 2500));
}

// 把 <think>…</think>、<thinking>…</thinking>（模擬思考）從內容中分離出來
function splitThink(s) {
  let think = '';
  const vis = String(s || '').replace(/<(think|thinking)>([\s\S]*?)(<\/\1>|$)/gi, (_, _tag, t) => { think += t; return ''; });
  return { think: think.trim(), vis: vis.replace(/^\s+/, '') };
}
/**
 * 串流中先不顯示狀態欄的標籤：<status>…</status>、<expression>…</expression>，還沒寫完的標籤（含最後半截的「<sta」）也藏起來。
 * 生成完成後伺服器會把標籤拿掉、解析成面板上的狀態（lib/status.js）
 */
// 和 lib/status.js 的 TAG_RE、OPEN_TAG_RE 相同（<status-bar> 這種卡片自訂的 HTML 不算）
const hideStatusTags = s => String(s || '')
  .replace(/<(status|expression)(?=[\s>/])[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
  .replace(/<(status|expression)(?:(?=[\s>/])[^<>]*>[\s\S]*|[\w\s="'-]*)$/i, '')
  .replace(/<(?:s(?:t(?:a(?:t(?:u)?)?)?)?|e(?:x(?:p(?:r(?:e(?:s(?:s(?:i(?:o)?)?)?)?)?)?)?)?)?$/i, '');
const thinkBox = (text, label = '思考過程') => h('details', { class: 'think' }, h('summary', {}, icon('lightbulb'), h('span', { class: 'lbl' }, label)), h('div', { class: 'think-body' }, text));
const fail = e => { console.error(e); toast(e.message || String(e), true); };

// 粗估 token（與伺服器相同算法）
// 估算 tokens：和伺服器的 estimateTokens（lib/prompt.js）同一套算法，畫面上的數字和送出時的估算一致
// （伺服器每則多算 4，是訊息本身的格式開銷；這裡估的是一段文字，所以不加）
const estTok = t => { if (!t) return 0; const c = (t.match(/[　-鿿가-힯＀-￯]/g) || []).length; return Math.ceil(c + (t.length - c) / 3.5); };
/** 目前這段對話指定的使用者設定檔（對話設定 → 這段對話的你）；沒有指定或已刪除時是 null */
const chatPersona = () => {
  const id = state.chat?.persona_id;
  return id ? (state.settings?.personas || []).find(p => p.id === id) || null : null;
};
/** 你在目前這段對話的名字：使用者設定檔 → 這段對話自訂的 → 設定頁的 */
const userName = () => chatPersona()?.user_name || state.chat?.user_name || state.settings?.user_name || 'User';
// 替換值用函式回傳：名字裡有 $&、$$ 這類符號時照原樣顯示
const sub = t => String(t || '').replace(/\{\{char\}\}|<BOT>/gi, () => state.char?.data.name || '').replace(/\{\{user\}\}|<USER>/gi, () => userName());

// ---------- 文字格式 ----------
// ---- 安全 HTML：允許排版用標籤，移除腳本與事件屬性 ----
const HTML_ALLOWED = new Set(('details summary p br hr b strong i em u s del ins mark small big sub sup span div blockquote ' +
  'ul ol li dl dt dd h1 h2 h3 h4 h5 h6 table thead tbody tfoot tr th td caption colgroup col code pre font center a img ruby rt rp q abbr kbd figure figcaption').split(' '));
const HTML_DROP = new Set('script style iframe frame frameset object embed link meta base form input button textarea select option noscript svg math template video audio source track canvas portal dialog'.split(' '));
const HTML_ATTRS = { '*': ['title', 'style', 'align'], details: ['open'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'], a: ['href'], img: ['src', 'alt', 'width', 'height'], font: ['color', 'size', 'face'], ol: ['start', 'type', 'reversed'], li: ['value'], col: ['span'] };
const CSS_OK = /^(color|background(-color)?|font(-weight|-style|-size|-family|-variant)?|text-(align|decoration|shadow|transform|indent)|letter-spacing|line-height|border(-[a-z]+)*|padding(-[a-z]+)?|margin(-[a-z]+)?|opacity|white-space|vertical-align|width|max-width|min-width|display|list-style(-type)?)$/;
const BLOCK = new Set('details summary p hr div blockquote ul ol li dl dt dd h1 h2 h3 h4 h5 h6 table thead tbody tfoot tr th td caption pre center figure figcaption'.split(' '));

function cleanStyle(v) {
  return String(v).split(';').map(d => {
    const i = d.indexOf(':'); if (i < 0) return '';
    const prop = d.slice(0, i).trim().toLowerCase(), val = d.slice(i + 1).trim();
    // 會載入外部圖片的寫法一律拿掉：url()、image-set()／-webkit-image-set()、cross-fade()、image()、element()，
    // 以及任何寫著網址的字串（image-set('http://…') 不用 url() 也能載入）。border-image、list-style-image 整個不允許
    if (!CSS_OK.test(prop) || /^(border-image|list-style-image)/.test(prop)
      || /url\s*\(|image-set|cross-fade|\bimage\s*\(|element\s*\(|https?:|\/\/|expression|javascript:|@import|\\/i.test(val)) return '';
    if (prop === 'display' && !/^(block|inline|inline-block|none|flex|grid)$/i.test(val)) return '';
    return `${prop}: ${val}`;
  }).filter(Boolean).join('; ');
}
/** 外部圖片的佔位：顯示網站名稱，點一下才換成圖片 */
function extImgHolder(src, alt) {
  let host = '';
  try { host = new URL(src).host; } catch { /* 網址格式錯誤：只顯示文字 */ }
  const el = document.createElement('span');
  el.className = 'ext-img';
  el.dataset.src = src;
  if (alt) el.dataset.alt = alt;
  el.setAttribute('role', 'button'); el.tabIndex = 0;
  el.title = `外部圖片：${src}\n點一下載入（對方網站會知道你的 IP）`;
  el.textContent = `🖼 外部圖片${host ? `（${host}）` : ''}：點一下載入`;
  return el;
}
// 這次開啟期間已經點過載入的外部圖片：畫面重畫（串流中、切換版本、編輯後）時直接顯示，不會又變回佔位框
const allowedExtImgs = new Set();
const loadExtImg = el => {
  allowedExtImgs.add(el.dataset.src);
  const img = document.createElement('img');
  img.src = el.dataset.src; img.alt = el.dataset.alt || ''; img.loading = 'lazy';
  el.replaceWith(img);
};
document.addEventListener('click', e => { const el = e.target.closest?.('.ext-img'); if (el) { e.preventDefault(); e.stopPropagation(); loadExtImg(el); } }, true);
document.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('ext-img')) { e.preventDefault(); loadExtImg(e.target); } });
function sanitizeNode(node) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === 8) { child.remove(); continue; } // 註解
    if (child.nodeType !== 1) continue;
    const tag = child.tagName.toLowerCase();
    if (HTML_DROP.has(tag)) { child.remove(); continue; }
    if (!HTML_ALLOWED.has(tag)) { sanitizeNode(child); child.replaceWith(...child.childNodes); continue; } // 未知標籤：保留內容
    const allow = [...HTML_ATTRS['*'], ...(HTML_ATTRS[tag] || [])];
    for (const a of [...child.attributes]) {
      const name = a.name.toLowerCase();
      if (!allow.includes(name)) { child.removeAttribute(a.name); continue; }
      if (name === 'style') { const s = cleanStyle(a.value); s ? child.setAttribute('style', s) : child.removeAttribute('style'); }
      if (name === 'href' && !/^https?:\/\//i.test(a.value.trim())) child.removeAttribute('href');
      if (name === 'src' && !/^(https?:\/\/|data:image\/(png|jpe?g|gif|webp);)/i.test(a.value.trim())) child.removeAttribute('src');
    }
    if (tag === 'a') { child.setAttribute('target', '_blank'); child.setAttribute('rel', 'noopener noreferrer'); }
    if (tag === 'img') {
      child.setAttribute('loading', 'lazy');
      // 外部圖片：設定沒有開啟「自動載入」時，先換成「點一下載入」的佔位（不會連到對方的網站）
      const src = child.getAttribute('src') || '';
      if (/^https?:\/\//i.test(src) && !state.settings?.external_images && !allowedExtImgs.has(src)) { child.replaceWith(extImgHolder(src, child.getAttribute('alt'))); continue; }
    }
    sanitizeNode(child);
  }
}
const isBlock = n => n && n.nodeType === 1 && BLOCK.has(n.tagName.toLowerCase());
/** 區塊標籤前後的換行在 pre-wrap 下會變成多餘空行，把它們修掉 */
function tidyWhitespace(node) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === 1) { if (!/^(pre|code)$/i.test(child.tagName)) tidyWhitespace(child); continue; }
    if (child.nodeType !== 3) continue;
    const parentBlockList = node.nodeType === 1 && /^(ul|ol|dl|table|thead|tbody|tfoot|tr|colgroup)$/i.test(node.tagName);
    if (!child.data.trim() && (parentBlockList || isBlock(child.previousSibling) || isBlock(child.nextSibling))) { child.remove(); continue; }
    if (isBlock(child.previousSibling) || (node.nodeType === 1 && isBlock(node) && child === node.firstChild)) child.data = child.data.replace(/^[ \t]*\n/, '');
    if (isBlock(child.nextSibling) || (node.nodeType === 1 && isBlock(node) && child === node.lastChild)) child.data = child.data.replace(/\n[ \t]*$/, '');
  }
}
/** 對話上色（粗體、斜體動作、引號台詞）只套用在文字節點上 */
function decorateText(node) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === 1) { if (!/^(code|pre|a|summary)$/i.test(child.tagName)) decorateText(child); continue; }
    if (child.nodeType !== 3 || !child.data.trim()) continue;
    // 只轉義 & < >：這段只會成為標籤之間的文字（不會放進屬性），引號保持原樣，下面才比對得到 "…"
    let s = String(child.data).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const before = s;
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>*$2*</em>');
    // 台詞：半形 "…"、彎引號 “…”、全形 ＂…＂、「…」、『…』
    s = s.replace(/("[^"\n]+"|“[^”\n]+”|＂[^＂\n]+＂|「[^」\n]+」|『[^』\n]+』)/g, '<q>$1</q>');
    if (s === before) continue;
    const t = document.createElement('template'); t.innerHTML = s;
    child.replaceWith(t.content);
  }
}
function formatText(text) {
  // 程式碼區塊先轉義，內容不當作 HTML
  let s = String(text || '')
    .replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, c) => `<pre><code>${esc(c.replace(/\n$/, ''))}</code></pre>`)
    .replace(/`([^`\n]+)`/g, (_, c) => `<code>${esc(c)}</code>`);
  const t = document.createElement('template'); // template 內的內容不會執行或載入
  t.innerHTML = s;
  sanitizeNode(t.content);
  tidyWhitespace(t.content);
  decorateText(t.content);
  const div = document.createElement('div');
  div.append(t.content);
  return div.innerHTML;
}

// ---------- 對話框（只能按 ✕、取消或儲存關閉，點外面或滑鼠移出都不會關） ----------
/** fixed：固定大小（例如有分頁的編輯器，切換分頁時視窗不會忽大忽小） */
// dirty：回傳「有沒有還沒儲存的修改」的函式。有的話，按 ✕、取消或返回時先問要不要放棄
// back：按上一頁（滑鼠側鍵、Alt+←）時回到哪個視窗（例如世界書編輯 → 世界書清單）；沒有就關閉視窗
// esc：可以按 Esc 關閉（檢視類的視窗；編輯器不行，免得誤按丟掉修改）
let modalDirty = null, modalBack = null, modalEsc = false;
// 開著視窗時多一筆瀏覽紀錄（網址相同），按上一頁就是用掉這一筆、回到上一層視窗，不會吃掉頁面本身的紀錄
// （沒有這一筆時，瀏覽紀錄退到最前面就按不動上一頁）
const MODAL_GUARD = 'tavernModal';
const pushGuard = () => { if (!history.state?.[MODAL_GUARD]) history.pushState({ [MODAL_GUARD]: true }, '', location.href); };
function openModal(title, body, buttons = [], { wide, fixed, dirty, back, esc } = {}) {
  modalDirty = dirty || null; modalBack = back || null; modalEsc = !!esc;
  $('.modal-box').classList.toggle('fixed-size', !!fixed);
  $('#modalTitle').textContent = title;
  const mb = $('#modalBody'); mb.innerHTML = ''; mb.append(body); mb.scrollTop = 0;
  const mf = $('#modalFoot'); mf.innerHTML = '';
  for (const b of buttons) mf.append(b);
  $('.modal-box').style.width = wide ? 'min(1100px, 100%)' : '';
  $('#modal').hidden = false;
  pushGuard();
}
const closeModal = () => { modalDirty = null; modalBack = null; modalEsc = false; $('#modal').hidden = true; };
/** 有還沒儲存的修改時先確認；回傳 true＝可以離開（沒修改，或選了放棄） */
async function confirmDiscard() {
  let d = false;
  try { d = !!modalDirty?.(); } catch { /* 判斷不了就當作沒改 */ }
  return !d || askConfirm('放棄還沒儲存的修改？\n關閉後，這次的修改不會保存。', { okText: '放棄修改', cancelText: '繼續編輯', danger: true });
}
/** 按 ✕ 或「取消」：有修改時先確認再關 */
async function tryCloseModal() { if (await confirmDiscard()) closeModal(); }
/** 上一頁：回到上一層視窗（有修改時先確認）；沒有上一層就關閉 */
async function modalGoBack() {
  const back = modalBack;
  if (!await confirmDiscard()) return;
  if (!back) return closeModal();
  try { await back(); } catch (e) { closeModal(); fail(e); }
}
// Esc：只關閉允許的視窗（角色、世界的檢視、對話設定）；上面疊著確認框之類的小視窗時由它自己處理
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || !modalEsc || $('#modal').hidden || document.querySelector('.crop-overlay')) return;
  e.preventDefault(); closeModal();
});

/** 分頁：tabs = [[標籤, 內容], …]，回傳 { bar, panes, show(i) }；onShow(i) 在切換時呼叫 */
/** 動畫開關（設定 → 外觀）：關閉時所有轉場都直接切換 */
const motionOn = () => document.documentElement.dataset.motion !== 'off';
function tabsUI(tabs, start = 0, onShow) {
  const bar = h('div', { class: 'tabs' });
  const panes = tabs.map(t => t[1]);
  const btns = tabs.map(([label], i) => h('button', { type: 'button', onclick: () => show(i, true) }, label));
  // 選取標示：一條線在分頁之間滑動（只移動、伸縮這條線，不需要重新排版）
  const ind = h('span', { class: 'tab-ind', 'aria-hidden': 'true' });
  bar.append(...btns, ind);
  let cur = start;
  const place = animate => {
    const b = btns[cur];
    if (!b || !b.offsetWidth) return; // 還沒放進畫面：等 ResizeObserver
    ind.classList.toggle('no-anim', !animate || !motionOn());
    ind.style.width = b.offsetWidth + 'px';
    ind.style.transform = `translate(${b.offsetLeft}px, ${b.offsetTop + b.offsetHeight - 2}px)`;
  };
  // 第一次出現、視窗縮放、分頁換行時：直接放到正確位置，不滑動
  let seen = false; // 放進畫面過，之後被移除（視窗關掉、頁面重畫）就停止觀察
  const ro = new ResizeObserver(() => {
    if (!bar.isConnected) { if (seen) ro.disconnect(); return; }
    seen = true; place(false);
  });
  ro.observe(bar);
  const show = (i, user) => {
    if (user && i === cur) return; // 點目前的分頁：什麼都不做（不重播動畫）
    cur = i;
    panes.forEach((p, j) => (p.hidden = j !== i));
    btns.forEach((b, j) => b.classList.toggle('active', j === i));
    place(!!user);
    // 視窗裡切換分頁：捲回最上方。分頁列固定在上方，不捲回來的話新分頁會沿用上一頁捲到的位置，從中間開始顯示
    if (user) { const sc = bar.closest('.modal-body'); if (sc) sc.scrollTop = 0; }
    // 內容淡入（點分頁切換時才有；開啟視窗時直接顯示）
    if (user && motionOn() && panes[i]?.animate)
      panes[i].animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 160, easing: 'ease-out' });
    onShow?.(i);
  };
  show(start);
  return { bar, panes, show };
}
/** 表單欄位產生器：rows 有值時是多行（附 token 估計）；輸入框存到 f[key]，初始值取自 d[key] */
const fieldMaker = (f, d) => (key, label, rows, hint) => {
  const el = f[key] = rows ? h('textarea', { rows, value: d[key] || '' }) : h('input', { type: 'text', value: d[key] || '' });
  const kids = [h('span', {}, label)];
  if (hint) kids.push(h('span', { class: 'muted' }, hint));
  kids.push(el);
  if (rows) {
    const tok = h('div', { class: 'tok' }, `約 ${estTok(el.value)} tokens`);
    el.addEventListener('input', () => (tok.textContent = `約 ${estTok(el.value)} tokens`));
    kids.push(tok);
  }
  return h('label', {}, ...kids);
};
$('#modal').addEventListener('click', e => { if (e.target.closest('[data-close]')) tryCloseModal(); });
/**
 * 放大檢視圖片：滾輪以游標位置為中心縮放（1～8 倍）、可以拖曳移動、雙擊切換原尺寸／2.5 倍；
 * 點一下（沒有拖曳）：縮放或移動過就先還原，否則關閉；按 Esc 或上一頁直接關閉。
 * 還原與關閉有縮放動畫（跟著「設定 → 外觀」的動畫開關）；from：原本的縮圖，關閉時縮回它的位置
 */
function viewImage(src, from) {
  const img = h('img', { src, alt: '', draggable: 'false' });
  const ov = h('div', { class: 'crop-overlay img-view' }, img, h('div', { class: 'img-view-hint' }, '滾輪縮放・拖曳移動・雙擊切換大小・點一下還原（再點一下或 Esc 關閉）'));
  let s = 1, tx = 0, ty = 0;
  const apply = () => { img.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`; ov.classList.toggle('zoomed', s !== 1 || !!tx || !!ty); };
  /** 縮放到 next 倍，(px, py) 這一點（視窗座標）保持在游標下 */
  const zoomAt = (next, px, py) => {
    next = Math.min(8, Math.max(1, next));
    if (next === 1) { s = 1; tx = ty = 0; return apply(); }
    const cx = innerWidth / 2, cy = innerHeight / 2; // 圖片置中，縮放以圖片中心為基準
    const ix = (px - cx - tx) / s, iy = (py - cy - ty) / s;
    s = next; tx = px - cx - ix * s; ty = py - cy - iy * s;
    apply();
  };
  /** 用動畫過渡到新的大小與位置（還原、雙擊切換；滾輪與拖曳要即時跟手，不用動畫） */
  const smooth = fn => {
    if (!motionOn()) return fn();
    img.style.transition = 'transform .22s ease';
    fn();
    clearTimeout(img._t); img._t = setTimeout(() => { img.style.transition = ''; }, 240);
  };
  ov.addEventListener('wheel', e => { e.preventDefault(); img.style.transition = ''; zoomAt(s * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX, e.clientY); }, { passive: false });
  // 拖曳移動（放大時）；拖曳過就不算「點一下關閉」
  let drag = null, moved = false;
  ov.addEventListener('pointerdown', e => { if (e.button !== 0) return; img.style.transition = ''; moved = false; drag = { x: e.clientX, y: e.clientY, tx, ty }; });
  ov.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
    if (moved) { ov.setPointerCapture?.(e.pointerId); tx = drag.tx + dx; ty = drag.ty + dy; apply(); }
  });
  const endDrag = () => { drag = null; };
  ov.addEventListener('pointerup', endDrag); ov.addEventListener('pointercancel', endDrag);
  let clickTimer = null;
  ov.addEventListener('click', e => {
    if (moved) return;
    // 等一下看是不是雙擊：雙擊不關閉。縮放或移動過時，點一下先回到原本的大小與位置，再點一下才關閉
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => { if (s !== 1 || tx || ty) smooth(() => zoomAt(1)); else close(); }, 220);
  });
  ov.addEventListener('dblclick', e => { clearTimeout(clickTimer); smooth(() => zoomAt(s > 1 ? 1 : 2.5, e.clientX, e.clientY)); });
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true; clearTimeout(clickTimer); document.removeEventListener('keydown', onKey, true);
    if (!motionOn()) return ov.remove();
    // 縮回原本縮圖的位置（縮圖不在畫面上時，原地縮小淡出），背景同時淡出
    let to = `translate(${tx}px, ${ty}px) scale(${s * 0.85})`;
    const r = from?.isConnected ? from.getBoundingClientRect() : null;
    if (r && r.width && img.offsetWidth) {
      const dx = r.left + r.width / 2 - innerWidth / 2, dy = r.top + r.height / 2 - innerHeight / 2;
      to = `translate(${dx}px, ${dy}px) scale(${r.width / img.offsetWidth})`;
    }
    ov.style.pointerEvents = 'none'; img.style.transition = '';
    img.animate([{ transform: img.style.transform || 'none' }, { transform: to }], { duration: 220, easing: 'ease-in', fill: 'forwards' });
    ov.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, easing: 'ease-in', fill: 'forwards' }).onfinish = () => ov.remove();
    setTimeout(() => ov.remove(), 300); // 保險：視窗在背景時動畫不會播完，照樣移除
  };
  const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  ov._close = close; // 上一頁時關閉（見 hashchange）
  document.addEventListener('keydown', onKey, true);
  document.body.append(ov);
  pushGuard();
}
/** 讓圖片可以點擊放大（沒有圖片、只是預設圖示的就不處理） */
const zoomable = el => {
  if (el.tagName !== 'IMG') return el;
  el.classList.add('zoomable'); el.title = '點一下放大';
  el.onclick = () => viewImage(el.src, el);
  return el;
};
// 直接關掉視窗時：編輯器或設定頁有還沒儲存的修改，就讓瀏覽器先問一次
window.addEventListener('beforeunload', e => {
  let d = false;
  try { d = (!$('#modal').hidden && !!modalDirty?.()) || (!$('#settingsView').hidden && !!state.settingsDirty?.()); } catch { /* 判斷不了就不問 */ }
  if (d) { e.preventDefault(); e.returnValue = ''; }
});

// 圖片轉 PNG（data URL），可順便縮放
function fileToPng(file, maxW = 800) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxW / img.width);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('無法讀取圖片'));
    img.src = URL.createObjectURL(file);
  });
}
/**
 * 頭像裁切：在正方形框內拖曳移動、用滑桿或滾輪縮放，回傳裁好的 PNG data URL（取消回傳 null）。
 * 疊在對話框之上，不會關掉正在編輯的角色。
 */
function cropImage(src, { out = 400, title = '調整頭像範圍' } = {}) {
  return new Promise(resolve => {
    const S = Math.min(320, innerWidth - 80); // 裁切框大小
    const im = h('img', { class: 'crop-img', alt: '', draggable: 'false' });
    const zoom = h('input', { type: 'range', min: 1, max: 5, step: 0.01, value: 1 });
    // 九宮格輔助線：方便把臉放在中間、眼睛對齊上方的橫線
    const grid = h('div', { class: 'crop-grid' });
    const stage = h('div', { class: 'crop-stage', style: `width:${S}px;height:${S}px` }, im, h('div', { class: 'crop-ring' }), grid);
    let w = 0, ht = 0, base = 1, k = 1, x = 0, y = 0;
    const clamp = () => {
      const sw = w * base * k, sh = ht * base * k;
      x = Math.min(0, Math.max(S - sw, x)); y = Math.min(0, Math.max(S - sh, y));
    };
    const draw = () => { clamp(); im.style.width = w * base * k + 'px'; im.style.transform = `translate(${x}px, ${y}px)`; };
    // 以裁切框中心為基準縮放
    const setZoom = nk => {
      nk = Math.min(5, Math.max(1, nk));
      const cx = (S / 2 - x) / (base * k), cy = (S / 2 - y) / (base * k);
      k = nk; x = S / 2 - cx * base * k; y = S / 2 - cy * base * k;
      zoom.value = k; draw();
    };
    im.onload = () => {
      w = im.naturalWidth; ht = im.naturalHeight;
      base = Math.max(S / w, S / ht); // 最小倍率：圖片剛好填滿框
      x = (S - w * base) / 2; y = -(ht * base - S) * 0.15; // 預設偏上（人像的臉通常在上方）
      draw();
    };
    im.onerror = () => { done(null); toast('無法讀取圖片', true); };
    im.src = src;
    zoom.oninput = () => setZoom(+zoom.value);
    stage.addEventListener('wheel', e => { e.preventDefault(); setZoom(k * (e.deltaY < 0 ? 1.08 : 1 / 1.08)); }, { passive: false });
    let drag = null;
    stage.addEventListener('pointerdown', e => { drag = { px: e.clientX, py: e.clientY, x, y }; stage.setPointerCapture(e.pointerId); stage.classList.add('dragging'); });
    stage.addEventListener('pointermove', e => { if (!drag) return; x = drag.x + e.clientX - drag.px; y = drag.y + e.clientY - drag.py; draw(); });
    const end = () => { drag = null; stage.classList.remove('dragging'); };
    stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);

    const overlay = h('div', { class: 'crop-overlay' },
      h('div', { class: 'crop-box' },
        h('h3', {}, title),
        stage,
        h('label', { class: 'crop-zoom' }, icon('zoom-in'), zoom),
        h('p', { class: 'muted small-note' }, '拖曳圖片調整位置，用滑桿或滑鼠滾輪縮放。圓圈內是對話中顯示的範圍；九宮格可以幫你把臉放在中間、眼睛對齊上方那條橫線。'),
        h('div', { class: 'crop-btns' },
          h('button', { type: 'button', onclick: () => done(null) }, '取消'),
          h('button', { type: 'button', class: 'primary', onclick: () => {
            const c = document.createElement('canvas'); c.width = c.height = out;
            const sc = base * k;
            c.getContext('2d').drawImage(im, -x / sc, -y / sc, S / sc, S / sc, 0, 0, out, out);
            done(c.toDataURL('image/png'));
          } }, '套用'))));
    function done(v) { overlay.remove(); resolve(v); }
    document.body.append(overlay);
  });
}

// 封面 = 角色卡圖片；頭像 = 對話中使用（沒有專屬頭像時伺服器會回傳封面）
const hasImg = c => c && (c.has_cover || c.has_avatar);
// 大世界在對話中以 world-<id> 當作擁有者 key
const WORLD_PREFIX = 'world-';
const isWorldKey = id => typeof id === 'string' && id.startsWith(WORLD_PREFIX);
const worldCoverUrl = (id, ver) => `/api/bigworlds/${id}/cover?v=${ver || 0}`;
const imgUrl = (c, kind) => isWorldKey(c.id) ? worldCoverUrl(c.id.slice(WORLD_PREFIX.length), c.img_ver)
  : `/api/characters/${c.id}/${kind}?v=${c.img_ver || 0}`;
/**
 * 選一張圖片，轉成 PNG data URL（取消時回傳 null）。頭像、封面、背景圖都用這個。
 * crop：給了就接著開啟裁切框（例如 { title: '調整頭像範圍' }），回傳裁好的圖
 */
function pickImage(maxW = 1280, { crop } = {}) {
  return new Promise(resolve => {
    const input = h('input', { type: 'file', accept: 'image/*', hidden: true });
    const finish = v => { input.remove(); resolve(v); };
    input.addEventListener('cancel', () => finish(null)); // 關掉選檔視窗
    input.addEventListener('change', async e => {
      const fl = e.target.files[0];
      if (!fl) return finish(null);
      try {
        const url = await fileToPng(fl, maxW);
        finish(crop ? await cropImage(url, crop) : url);
      } catch (err) { fail(err); finish(null); }
    });
    document.body.append(input); input.click();
  });
}
const charName = c => c.name || c.data?.name || '?';
// ---------- 表情圖（狀態欄的圖片；角色資料夾的 expressions/） ----------
// 預設表情：表情圖分頁固定排出的 8 個格子。檔名用英文（大多和 SillyTavern 表情包相同；害羞、緊張用比較短的 shy、nervous，
// 匯入時 embarrassment、nervousness 會自動改成這兩個名稱，見 lib/expressions.js 的 ALIASES），
// 畫面顯示「開心（joy）」；送給模型與存檔一律用檔名。自訂的表情照原本的名稱顯示
const EXPR_PRESETS = [['neutral', '平常'], ['joy', '開心'], ['sadness', '難過'], ['anger', '生氣'],
  ['shy', '害羞'], ['surprise', '驚訝'], ['fear', '害怕'], ['nervous', '緊張']].map(([name, zh]) => ({ name, zh }));
const exprPreset = name => EXPR_PRESETS.find(p => p.name === String(name).toLowerCase()) || null;
/** 表情的顯示名稱：預設表情是「開心（joy）」，自訂的照原本的名稱 */
const exprLabel = name => { const p = exprPreset(name); return p ? `${p.zh}（${name}）` : String(name); };
const exprUrl = (charId, e) => `/api/characters/${charId}/expression?name=${encodeURIComponent(e.name)}&v=${e.ver || 0}`;
/** 卡片上的預設表情（角色卡 extensions.ai_tavern_expressions.default） */
const defaultExpr = ch => ch?.data?.extensions?.ai_tavern_expressions?.default || null;
/** 找表情（不分大小寫）；沒有就是 null */
const findExpr = (ch, name) => (name ? (ch?.expressions || []).find(e => e.name.toLowerCase() === String(name).toLowerCase()) || null : null);
const avatarEl = (c, cls = '') => hasImg(c) ? h('img', { src: imgUrl(c, 'avatar'), class: cls, alt: '' }) : h('div', { class: 'avatar-ph ' + cls }, charName(c).slice(0, 1));
const coverEl = (c, cls = '', attrs = {}) => hasImg(c) ? h('img', { src: imgUrl(c, c.has_cover ? 'cover' : 'avatar'), class: cls, alt: '', ...attrs }) : h('div', { class: 'avatar-ph ' + cls, ...attrs }, charName(c).slice(0, 1));
// 使用者頭像（設定 → 使用者 可以更換）；對話指定了使用者設定檔時用它的頭像（global：一律用設定頁的，例如設定頁的預覽）
// 使用者沒有頭像時：內建的人像剪影（顏色跟著主題色）；角色沒有頭像時仍然顯示名字的第一個字
const USER_SILHOUETTE = '<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="24" r="12"/><path d="M8 60c0-13.3 10.7-22 24-22s24 8.7 24 22z"/></svg>';
const defaultUserAv = cls => { const el = h('div', { class: 'avatar-ph user-ph ' + cls }); el.innerHTML = USER_SILHOUETTE; return el; };
// 你的頭像：這段對話指定的使用者設定檔 → 設定頁的頭像 → 剪影。global：不看這段對話的設定（設定頁、其他對話用）
const userAvatarEl = (cls, { global = false } = {}) => {
  const p = global ? null : chatPersona();
  if (p) return p.avatar_ver
    ? h('img', { src: `/api/personas/${p.id}/avatar?v=${p.avatar_ver}`, class: cls, alt: '' })
    : defaultUserAv(cls);
  return state.settings?.user_avatar
    ? h('img', { src: `/api/user/avatar?v=${state.settings.user_avatar}`, class: cls, alt: '' })
    : defaultUserAv(cls);
};
const fmtTime = t => t ? new Date(t).toLocaleString('zh-TW', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

function download(url) { const a = h('a', { href: url, download: '' }); document.body.append(a); a.click(); a.remove(); }
/** 這個畫面是在執行酒館的這台電腦上開的（應用程式視窗、或本機瀏覽器）：匯出時可以由伺服器直接存檔 */
const onHostMachine = () => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(location.hostname);
/** API 位址是不是自己架的（本機或區網的 LM Studio、Ollama，通常不需要金鑰）；和伺服器 lib/providers.js 的 isLocalHost 相同 */
const isSelfHostedUrl = u => { try { return /^(localhost|127\.|\[?::1\]?$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|[\w-]+\.local$)/i.test(new URL(String(u || '')).hostname); } catch { return false; } };
/**
 * 匯出（角色卡、世界書、備份、全部資料）。在這台電腦上：伺服器直接存到「下載」資料夾，顯示實際的存檔路徑；
 * 別台裝置（手機、區網）或直接存檔失敗時：照舊讓瀏覽器下載（url）。
 * what = { kind: 'char'|'world'|'backup'|'all', id, format }（見 server.js 的 EXPORTS）
 */
async function exportFile(what, url) {
  // 全部資料、備份：太大的檔案匯出得了、卻匯不回來（解壓縮後超過約 5 億字元就解析不了），先提醒
  if (what.kind === 'all' || what.kind === 'backup') {
    const est = await api('GET', `/api/export/estimate?kind=${what.kind}${what.id ? `&id=${encodeURIComponent(what.id)}` : ''}`).catch(() => null);
    if (est?.too_big && !await askConfirm(`這個檔案太大，匯出後沒辦法用「匯入資料」還原\n`
      + `解壓縮後大約 ${Math.round(est.chars / 1048576)} MB，超過匯入能處理的上限（約 ${Math.round(est.limit / 1048576)} MB）。檔案本身照樣可以保存、當作封存。\n\n`
      + '要搬到另一台電腦，請改用直接複製資料夾：先關掉兩台電腦的酒館，把 AI 酒館資料夾裡的 userdata 整個複製過去（取代原本的 userdata），再開啟酒館。', { okText: '仍要匯出', danger: false })) return;
  }
  if (!onHostMachine()) { download(url); return toast('已開始下載，檔案會存在這台裝置的下載資料夾'); }
  try {
    const r = await api('POST', '/api/export-save', what);
    toast(`已匯出至「${r.path}」`, false, 8000);
  } catch (e) {
    toast(`無法直接存檔（${e.message}），改用瀏覽器下載`, true);
    download(url);
  }
}
/**
 * 匯入 SillyTavern 的對話（.jsonl）成這個角色（大世界：world-<id>）的對話，完成後打開它。
 * into：從某段對話的「對話設定」匯入時傳那段對話的 id，還停在開場白就直接帶入，已經有內容就開一段新的
 */
function importChatFile(ownerKey, { into = null } = {}) {
  const input = h('input', { type: 'file', accept: '.jsonl,application/jsonl,application/json,text/plain' });
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const r = await api('POST', `/api/characters/${ownerKey}/chats/import${into ? `?into=${encodeURIComponent(into)}` : ''}`, await file.arrayBuffer(), true);
      closeModal();
      toast(r.replaced ? `已把「${file.name}」帶入這段對話：${r.count} 則訊息` : `已匯入「${file.name}」成一段新對話：${r.count} 則訊息`);
      const hash = `#/chat/${ownerKey}/${r.id}`;
      if (location.hash === hash) await route(); else go(hash); // 帶入目前這段：重新讀取
    } catch (e) { fail(e); }
  };
  input.click();
}
/** 檢視頁用的小按鈕：匯入 SillyTavern 的對話（開一段新對話） */
const importChatBtn = ownerKey => h('button', { type: 'button', class: 'small import-chat', title: '把 SillyTavern 的對話檔（.jsonl）匯入成一段新對話',
  onclick: e => { e.stopPropagation(); importChatFile(ownerKey); } }, ic('import', '匯入對話'));
const exportCharFile = (id, format) =>exportFile({ kind: 'char', id, format }, `/api/characters/${id}/export?format=${format}`);

/**
 * 酒館自己的文字輸入視窗（取代瀏覽器的 prompt()：那個會顯示「127.0.0.1:8000 顯示」，樣式也改不了）。
 * 回傳輸入的文字；按「取消」、Esc 或點外面回傳 null。
 */
function askText(title, { note = '', value = '', placeholder = '', okText = '確定' } = {}) {
  return new Promise(resolve => {
    const input = h('input', { type: 'text', value, placeholder });
    const close = v => { ov.remove(); resolve(v); };
    const ok = () => close(input.value);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); ok(); }
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
    });
    const ov = h('div', { class: 'crop-overlay', onmousedown: e => { if (e.target === ov) close(null); } },
      h('div', { class: 'crop-box ask-box', role: 'dialog' },
        h('h3', {}, title),
        note ? h('p', { class: 'ask-note' }, note) : null,
        input,
        h('div', { class: 'ask-btns' },
          h('button', { type: 'button', onclick: () => close(null) }, '取消'),
          h('button', { type: 'button', class: 'primary', onclick: ok }, okText))));
    document.body.append(ov);
    input.focus(); input.select();
  });
}

// API 金鑰外流提醒：第一次啟動引導、API 設定頁、資料頁共用
const keyWarning = () => h('div', { class: 'key-warning', role: 'note' },
  h('b', {}, '⚠ 保護你的 API 金鑰'),
  h('p', {}, '請勿將 userdata 資料夾底下的 config.json（或整個 userdata 資料夾）分享給他人，裡面以明文存著你的 API 金鑰。要分享角色卡請用角色編輯裡的「匯出 PNG／JSON」，要搬家請用「設定 → 資料 → 匯出全部資料」，這兩種都不含金鑰。'),
  h('p', {}, '若不慎傳出，請立即到 API 供應商的網站撤銷（刪除）這把金鑰並重新產生一把，再回到這裡填入新的金鑰，以免被他人盜用而產生費用。'));
/** 刪除確認用的說明：垃圾桶保留幾天、去哪裡還原 */
const trashDaysText = () => `${state.settings?.trash_days ?? 7} 天內可以在「設定 → 資料 → 垃圾桶」還原，之後自動清除。`;
/**
 * 酒館自己的確認視窗（取代瀏覽器的 confirm()）。message 的第一行是標題，其餘是說明；
 * danger：確定按鈕用紅色（刪除、清空這類無法復原的動作）。回傳 true／false
 */
function askConfirm(message, { okText, cancelText = '取消', danger, okOnly = false } = {}) {
  // okOnly：只是告知（只有一個「確定」按鈕）
  if (okOnly) return askChoice(message, [{ value: true, label: okText || '確定', primary: true }], true);
  const [title, ...rest] = String(message).split('\n');
  const body = rest.join('\n').trim();
  const isDanger = danger ?? /刪除|清空|無法復原/.test(message);
  return new Promise(resolve => {
    const close = v => { document.removeEventListener('keydown', onKey, true); ov.remove(); resolve(v); };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); }
      // 危險操作（刪除、清空）：Enter 按的是目前選中的按鈕，預設是「取消」，避免順手按 Enter 就刪掉
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); close(isDanger ? document.activeElement === okBtn : true); }
    };
    const label = okText || (/^[^\n]*刪除/.test(message) ? '刪除' : /^[^\n]*清空/.test(message) ? '清空' : '確定');
    const okBtn = h('button', { type: 'button', class: isDanger ? 'danger' : 'primary', onclick: () => close(true) }, label);
    const cancelBtn = h('button', { type: 'button', onclick: () => close(false) }, cancelText);
    const ov = h('div', { class: 'crop-overlay', onmousedown: e => { if (e.target === ov) close(false); } },
      h('div', { class: 'crop-box ask-box', role: 'alertdialog' },
        h('h3', {}, title),
        body ? h('p', { class: 'ask-note ask-body' }, body) : null,
        h('div', { class: 'ask-btns' }, cancelBtn, okBtn)));
    document.addEventListener('keydown', onKey, true);
    document.body.append(ov);
    (isDanger ? cancelBtn : okBtn).focus();
  });
}
/**
 * 存卡片（角色卡、大世界、世界書）時，伺服器說「打開編輯之後在別處改過」（409 card_stale）：問要怎麼辦。
 * 回傳 'force'（仍要覆蓋）、'reload'（重新讀取最新的內容）、'cancel'（關閉編輯視窗），按 Esc 是 null（回到編輯，什麼都不做）
 */
const askCardStale = what => askChoice(`這張${what}已經在其他地方改過\n你打開編輯之後，這張${what}在別的視窗或裝置存過。\n・仍要覆蓋：用你現在的內容存檔，那邊的修改會不見。\n・重新讀取：載入最新的內容重新編輯，你在這裡還沒存的修改會不見。\n・取消：關閉編輯視窗，什麼都不存。`, [
  { value: 'cancel', label: '取消（關閉編輯視窗）' },
  { value: 'reload', label: '重新讀取', primary: true },
  { value: 'force', label: '仍要覆蓋', danger: true },
]);
/**
 * 有好幾個選擇的視窗：buttons = [{ value, label, primary?, danger? }]，由左到右排列；回傳按下的那個 value。
 * 按 Esc、點外面回傳 dismiss（預設 null）
 */
function askChoice(message, buttons, dismiss = null) {
  const [title, ...rest] = String(message).split('\n');
  const body = rest.join('\n').trim();
  return new Promise(resolve => {
    const close = v => { document.removeEventListener('keydown', onKey, true); ov.remove(); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(dismiss); } };
    const btns = buttons.map(b => h('button', { type: 'button', class: b.danger ? 'danger' : b.primary ? 'primary' : '', onclick: () => close(b.value) }, b.label));
    const ov = h('div', { class: 'crop-overlay', onmousedown: e => { if (e.target === ov) close(dismiss); } },
      h('div', { class: 'crop-box ask-box', role: 'alertdialog' },
        h('h3', {}, title),
        body ? h('p', { class: 'ask-note ask-body' }, body) : null,
        h('div', { class: 'ask-btns' }, ...btns)));
    document.addEventListener('keydown', onKey, true);
    document.body.append(ov);
    (btns[buttons.findIndex(b => b.primary)] || btns[btns.length - 1]).focus();
  });
}

// 聊天紀錄上限的選項（設定頁的預設值、對話設定共用）；0 = 不限（只受上下文長度限制）
const HISTORY_CAP_OPTS = [[0, '不限（只受上下文長度限制）'], [8000, '8k'], [16000, '16k'], [24000, '24k'], [32000, '32k'], [48000, '48k'], [64000, '64k'], [96000, '96k'], [128000, '128k']];
/** 有新版本時（state.update，見 main.js 與設定頁「關於」）：底部的「設定」與「關於」分頁顯示小紅點 */
function markUpdateDot() {
  const on = !!state.update?.newer;
  document.querySelector('#tabbar [data-tab="settings"]')?.classList.toggle('has-dot', on);
  document.querySelector('.tabs .about-tab')?.classList.toggle('has-dot', on);
}
const fmtCap = v => (v > 0 ? `${Math.round(v / 1000)}k tokens` : '不限');

// ===================== 外觀（動畫、背景、主題色、字級） =====================
const APPEARANCE_DEFAULT = { motion: 'on', background: 'stars', bg_dim: 0.55, accent: '', font_size: 15 };
const APPEARANCE_CACHE = 'tavern-appearance'; // 記在瀏覽器裡，下次開啟時一載入就套用，不會先閃一下預設主題
/**
 * 這個底色上的字要用深褐還是米白：比較兩種的對比度（WCAG 的算法），挑高的那個。
 * 設定頁的六個主題色都是亮色，會挑深褐（對比度 6.6～9.9:1）；用調色盤選了很深的顏色時會挑米白
 */
function inkOn(hex) {
  return contrastRatio(hex, '#2b1606') >= contrastRatio(hex, '#fff8ea') ? '#2b1606' : '#fff8ea';
}
/** 兩個顏色（#rrggbb）的對比度（WCAG 的算法，1～21） */
function contrastRatio(a, b) {
  const lum = h => { const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(x => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/**
 * 把 hex 一點一點混入 toward（調深用深褐、調亮用白），直到放在 bg 上的對比度有 4.5:1（一般文字的最低標準）；
 * 本來就夠清楚的原樣回傳。bg 是這個主題裡最不利的底色（古卷軸：最深的紙色；星空：最亮的對話框）
 */
function readableOn(hex, bg, toward) {
  const mix = p => '#' + [1, 3, 5].map(i => Math.round(parseInt(hex.slice(i, i + 2), 16) * p + parseInt(toward.slice(i, i + 2), 16) * (1 - p)).toString(16).padStart(2, '0')).join('');
  for (let p = 1; p > 0; p -= 0.02) { const c = mix(p); if (contrastRatio(c, bg) >= 4.5) return c; }
  return toward;
}
function applyAppearance(a, bgVer, remember = true) {
  a = { ...APPEARANCE_DEFAULT, ...(a || {}) };
  const root = document.documentElement;
  root.dataset.motion = a.motion === 'off' ? 'off' : 'on';
  root.dataset.bg = a.background === 'image' && !bgVer ? 'stars' : a.background; // 選了圖片但還沒上傳：先用星空
  const custom = /^#[0-9a-f]{6}$/i.test(a.accent || '');
  // 文字用的主題色要看得清楚：古卷軸（淺色紙）上太亮就調深、星空（深色）上太暗就調亮，只調到夠清楚為止（保留最多原本的顏色）
  if (custom) root.style.setProperty('--accent', a.background === 'paper' ? readableOn(a.accent, '#dcc28b', '#2b1606') : readableOn(a.accent, '#1e2c58', '#ffffff'));
  else root.style.removeProperty('--accent');
  // 古卷軸：按鈕、切換開關這類底色用你選的原色（不調深），上面的字依底色深淺用深褐或米白（style.css 的 --accent-fill、--on-accent）
  if (custom && a.background === 'paper') {
    root.style.setProperty('--accent-fill', a.accent);
    root.style.setProperty('--on-accent', inkOn(a.accent));
  } else { root.style.removeProperty('--accent-fill'); root.style.removeProperty('--on-accent'); }
  root.style.setProperty('--font-size', (Number(a.font_size) || 15) + 'px');
  root.style.setProperty('--bg-dim', String(Math.min(0.9, Math.max(0, Number(a.bg_dim) || 0))));
  if (bgVer) root.style.setProperty('--bg-image', `url("/api/appearance/background?v=${bgVer}")`); else root.style.removeProperty('--bg-image');
  if (remember) try { localStorage.setItem(APPEARANCE_CACHE, JSON.stringify({ a, bgVer })); } catch { /* 無法記住也沒關係 */ }
}
/** 套用已儲存的外觀（離開設定頁時用，取消尚未儲存的預覽） */
const applySavedAppearance = () => state.settings && applyAppearance(state.settings.appearance, state.settings.bg_ver);
try { const c = JSON.parse(localStorage.getItem(APPEARANCE_CACHE) || 'null'); if (c) applyAppearance(c.a, c.bgVer, false); } catch { /* 沒有記錄 */ }

// 視窗標題：首頁與設定頁用這個；進入對話時換成「AI酒館－角色名稱」（AI 酒館.exe 也靠「AI酒館」開頭辨認 App 視窗）
const APP_TITLE = 'AI酒館－by 葛恩 with Claude';

// ===================== 頁面切換（網址 #/ 首頁、#/chat/角色/對話） =====================
// 程式裡換頁一律經過 go()；其他的網址變化是瀏覽器的上一頁／下一頁（滑鼠側鍵、Alt+←）
let appNav = false;
const go = hash => { if (location.hash === hash) route(); else { appNav = true; location.hash = hash; } };
async function route() {
  detachStream(); // 只斷開畫面上的串流，AI 會在背景繼續生成
  if (location.hash !== '#/settings') applySavedAppearance(); // 外觀預覽沒有儲存就離開：還原
  const m = location.hash.match(/^#\/chat\/([\w-]+)(?:\/([\w-]+))?/);
  try {
    if (m) await enterChat(m[1], m[2]);
    else if (location.hash === '#/settings') { showView('settings'); document.title = APP_TITLE; await openSettings(); }
    else await showHome();
  } catch (e) { fail(e); if (m) go('#/'); }
}
// 離開設定頁（下方分頁列、滑鼠側鍵、Alt+←、程式裡的 go()）：有還沒儲存的修改時先確認；
// 選「留在設定頁」就把網址換回設定頁（畫面與修改都不動）；之後再按上一頁會再問一次
let curHash = location.hash; // 目前畫面上的頁面
// 把網址換回原本的頁面：用 replaceState，不會觸發 hashchange、不會多一筆瀏覽紀錄，也不會蓋掉「下一頁」的紀錄
const restoreHash = hash => { if (location.hash !== hash) history.replaceState(history.state, '', hash || location.pathname + location.search); };
const overlayOpen = () => !$('#modal').hidden || !!document.querySelector('.crop-overlay');
/**
 * 開著視窗時按上一頁／下一頁：放大的圖片就關掉它；確認框之類的小視窗擋下；一般視窗回到上一層或關閉。
 * 處理完還有視窗開著（回到上一層、選了繼續編輯）：補回一筆紀錄，下次上一頁照樣有效
 */
async function overlayBack() {
  const view = document.querySelector('.img-view');
  if (view) view._close();
  else if (!document.querySelector('.crop-overlay')) await modalGoBack();
  if (!$('#modal').hidden || document.querySelector('.crop-overlay:not(.img-view)')) pushGuard();
}
// 上一頁／下一頁到網址相同的紀錄（開視窗時加的那一筆）：瀏覽器不會發 hashchange，這裡處理
// （網址有變的交給下面的 hashchange；程式換頁一定會換網址，不會走到這裡）
window.addEventListener('popstate', () => {
  if (location.hash !== curHash) return;
  if (overlayOpen()) return overlayBack();
  // 視窗已經用按鈕關掉、留下用不到的那一筆：直接跳過，不要讓這次上一頁／下一頁白按
  if (history.state?.[MODAL_GUARD]) history.forward(); else history.back();
});
window.addEventListener('hashchange', async () => {
  const byApp = appNav; appNav = false;
  const target = location.hash; // 要前往的頁面：先記下來（確認框開著時網址可能又被上一頁改掉）
  // 開著視窗（編輯器、對話設定…）時按上一頁／下一頁：背後的頁面不換，改成回到上一層視窗或關閉視窗（有修改時先問）；
  // 開著確認框、裁切圖片之類的小視窗時直接擋下
  if (!byApp && overlayOpen()) {
    restoreHash(curHash);
    overlayBack();
    return;
  }
  if (target !== '#/settings' && !$('#settingsView').hidden && state.settingsDirty?.()) {
    if (!await askConfirm('離開設定頁，放棄還沒儲存的修改？\n要保留修改，請先按下方的「儲存設定」。', { okText: '放棄修改', cancelText: '留在設定頁', danger: true })) {
      restoreHash('#/settings');
      return;
    }
    restoreHash(target); // 選了放棄：前往原本要去的頁面（確認框開著時又按了上一頁也一樣）
  }
  curHash = target;
  route();
});
function showView(name) {
  for (const v of ['home', 'chat', 'settings']) $(`#${v}View`).hidden = name !== v;
  for (const b of document.querySelectorAll('#tabbar button')) b.classList.toggle('active', b.dataset.tab === name);
  // 頁面本身直接切換；只有選取標示滑過去（第一次顯示時直接放好）
  placeNavInd(navIndAt !== undefined && navIndAt !== name);
  navIndAt = name;
}
// 下方首頁／對話／設定的選取標示：一條線在按鈕之間滑動
const navInd = h('span', { class: 'nav-ind', 'aria-hidden': 'true' });
$('#tabbar').append(navInd);
let navIndAt;
function placeNavInd(animate) {
  const b = $('#tabbar button.active');
  navInd.hidden = !b;
  if (!b || !b.offsetWidth) return;
  navInd.classList.toggle('no-anim', !animate || !motionOn());
  navInd.style.width = b.offsetWidth + 'px';
  navInd.style.transform = `translateX(${b.offsetLeft}px)`;
}
new ResizeObserver(() => placeNavInd(false)).observe($('#tabbar'));

// 底部快速切換欄
const LAST_CHAT_KEY = 'tavern.lastChat';
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { } };
$('#tabbar').addEventListener('click', async e => {
  const tab = e.target.closest('button')?.dataset.tab;
  if (!tab) return;
  if ((tab === 'home' && location.hash.replace(/^#\/?$/, '') === '' && !$('#homeView').hidden)
    || (tab === 'settings' && location.hash === '#/settings' && !$('#settingsView').hidden)) return; // 點目前的頁面：不重新載入（避免畫面閃一下）
  // 離開設定頁時的未儲存確認在 hashchange 裡統一處理
  if (tab === 'home') go('#/');
  else if (tab === 'settings') go('#/settings');
  else if (tab === 'chat') {
    if (!$('#chatView').hidden) return;
    // 回到上次開啟的對話；沒有的話打開最近更新的對話
    const last = lsGet(LAST_CHAT_KEY);
    const all = await api('GET', '/api/chats').catch(() => []);
    const target = (last && all.find(c => `${c.char.id}/${c.id}` === last)) || all[0];
    if (target) go(`#/chat/${target.char.id}/${target.id}`);
    else { toast('還沒有任何對話，先從首頁選一個角色吧'); go('#/'); }
  }
});

