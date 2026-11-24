'use strict';
// AI 酒館 前端 — 首頁：角色與世界的卡片
// 這些檔案依序載入（見 index.html），共用同一個全域範圍；最後由 main.js 啟動
// ===================== 首頁 =====================
async function showHome() {
  showView('home');
  state.char = null; state.chat = null; state.chatId = null;
  document.title = APP_TITLE;
  await loadChars();
}
async function loadChars() {
  [state.chars, state.bigworlds] = await Promise.all([api('GET', '/api/characters'), api('GET', '/api/bigworlds')]);
  renderHome();
}
// 首頁欄位收合（記在這台電腦的瀏覽器）
const COLLAPSE_KEY = 'tavern.collapsed';
const collapsed = () => { try { return JSON.parse(lsGet(COLLAPSE_KEY) || '{}'); } catch { return {}; } };
function applyCollapse() {
  const c = collapsed();
  for (const sec of document.querySelectorAll('.home-sec')) sec.classList.toggle('collapsed', !!c[sec.dataset.sec]);
}
// 收合動畫：高度慢慢收起／展開；卡片很多時（超過 60 張）只淡入淡出，避免每一格畫面重新排版大量卡片
const SEC_ANIM_MAX = 60;
for (const t of document.querySelectorAll('.sec-toggle')) t.onclick = () => {
  const sec = t.closest('.home-sec'), body = sec.querySelector('.sec-body');
  const key = sec.dataset.sec, c = collapsed();
  c[key] = !c[key]; lsSet(COLLAPSE_KEY, JSON.stringify(c));
  const closing = !!c[key];
  body.getAnimations().forEach(a => a.cancel()); // 連點時：取消上一次還沒跑完的動畫
  if (!motionOn() || !body.animate) return applyCollapse();
  const light = body.children.length > SEC_ANIM_MAX;
  const opts = { duration: light ? 120 : 160, easing: 'ease-out' };
  if (closing) {
    const hgt = body.offsetHeight;
    const a = body.animate(light ? [{ opacity: 1 }, { opacity: 0 }]
      : [{ height: hgt + 'px', opacity: 1, overflow: 'hidden' }, { height: '0px', opacity: 0, overflow: 'hidden' }], opts);
    a.onfinish = () => { if (collapsed()[key]) applyCollapse(); };
  } else {
    applyCollapse();
    const hgt = body.offsetHeight;
    body.animate(light ? [{ opacity: 0 }, { opacity: 1 }]
      : [{ height: '0px', opacity: 0, overflow: 'hidden' }, { height: hgt + 'px', opacity: 1, overflow: 'hidden' }], opts);
  }
};

// 首頁排序（角色與世界共用，記在這台電腦的瀏覽器）
const SORT_KEY = 'tavern.homeSort';
/** 加入酒館的時間：舊資料沒有 created 時，從 ID 開頭的時間戳記推算（ID＝建立時的時間＋亂數） */
const createdAt = c => c.created || parseInt(String(c.id).slice(0, 8), 36) || 0;
const lastUsed = c => Math.max(c.updated || 0, c.last_chat?.updated || 0);
const byName = new Intl.Collator('zh-Hant', { numeric: true, sensitivity: 'base' });
const HOME_SORTS = [
  ['recent', '最近使用', (a, b) => lastUsed(b) - lastUsed(a)],
  ['name', '名稱（A→Z）', (a, b) => byName.compare(a.name, b.name)],
  ['name-desc', '名稱（Z→A）', (a, b) => byName.compare(b.name, a.name)],
  ['new', '最新加入', (a, b) => createdAt(b) - createdAt(a)],
  ['old', '最早加入', (a, b) => createdAt(a) - createdAt(b)],
  ['chats', '對話最多', (a, b) => (b.chat_count || 0) - (a.chat_count || 0) || lastUsed(b) - lastUsed(a)],
  // 自訂ID排序：照角色／世界詳情裡設定的順序 ID 由小到大；沒設定的排在後面；一樣大（或都沒設定）時照加入的時間
  ['order', '自訂ID排序', (a, b) => {
    const ha = Number.isInteger(a.order), hb = Number.isInteger(b.order);
    if (ha !== hb) return ha ? -1 : 1;
    return (ha ? a.order - b.order : 0) || createdAt(a) - createdAt(b);
  }],
];
const homeSortSel = $('#homeSort');
homeSortSel.append(...HOME_SORTS.map(([v, t]) => h('option', { value: v }, t)));
homeSortSel.value = HOME_SORTS.some(([v]) => v === lsGet(SORT_KEY)) ? lsGet(SORT_KEY) : 'recent';
homeSortSel.onchange = () => { lsSet(SORT_KEY, homeSortSel.value); renderHome(); };
/** 依目前選的排序方式排列（不改動原本的陣列） */
function sortHome(list) {
  const cmp = (HOME_SORTS.find(([v]) => v === homeSortSel.value) || HOME_SORTS[0])[2];
  return list.slice().sort(cmp);
}
/** 自訂ID排序時，卡片左上角顯示順序 ID（沒設定時顯示「－」；其他排序不顯示）。點一下直接修改（world.js 的 orderTag） */
const orderBadge = (kind, x) => homeSortSel.value === 'order' ? orderTag(kind, x.id, x.order, { card: true }) : null;

function renderHome() {
  applyCollapse();
  const q = $('#charSearch').value.trim().toLowerCase();
  const match = c => !q || c.name.toLowerCase().includes(q) || (c.tags || []).some(t => t.toLowerCase().includes(q));
  renderWorlds(q);

  // 角色卡
  const grid = $('#charGrid'); grid.innerHTML = '';
  const list = sortHome(state.chars.filter(match));
  $('#charCount').textContent = state.chars.length ? `（${list.length}）` : '';
  // 「創建角色」固定在第一個位置
  grid.append(h('button', { class: 'card create-card', title: '自己建立一個新角色', onclick: () => openCharEditor(null).catch(fail) },
    h('div', { class: 'create-plus' }, icon('plus')), h('span', {}, '創建角色')));
  for (const c of list) {
    const tags = c.tags || [];
    grid.append(h('div', { class: 'card' },
      h('button', { class: 'card-edit', title: '編輯角色', onclick: async () => openCharEditor(await api('GET', `/api/characters/${c.id}`)).catch(fail) }, icon('pencil')),
      orderBadge('char', c),
      coverEl(c, 'cover', { title: '查看角色', onclick: () => openCharDetail(c.id).catch(fail) }),
      h('div', { class: 'c-body' },
        h('div', { class: 'c-name', title: c.name, onclick: () => openCharDetail(c.id).catch(fail) }, c.name),
        h('div', { class: 'c-meta' }, c.chat_count ? `${c.chat_count} 段對話｜${fmtTime(c.last_chat.updated)}` : '尚未對話'),
        h('div', { class: 'c-tags', title: tags.join(', ') }, tags.map(t => h('span', { class: 'tag' }, t))),
        chatButtons(c))));
  }
  if (!list.length) grid.append(h('div', { class: 'empty-home' },
    state.chars.length ? '沒有符合的角色' : h('div', {}, h('p', {}, '還沒有角色。'), h('p', {}, '按「匯入」選擇 PNG / JSON 角色卡，或直接把檔案拖進這個視窗；也可以按左邊的「創建角色」自己建立。'))));
}
$('#charSearch').addEventListener('input', renderHome);

