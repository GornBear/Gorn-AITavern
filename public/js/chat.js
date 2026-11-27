'use strict';
// AI 酒館 前端 — 對話頁：對話清單、搜尋、發言列、記憶、訊息列表、生成與串流、提示詞預覽
// 這些檔案依序載入（見 index.html），共用同一個全域範圍；最後由 main.js 啟動
// ===================== 對話頁 =====================
async function enterChat(charId, chatId) {
  // 快速連點切換對話：比較晚讀完的舊請求不能蓋掉新的畫面（每一段等待後都確認這次切換還有效）
  const tk = {}; state.enterToken = tk;
  const stale = () => state.enterToken !== tk;
  let ch;
  if (isWorldKey(charId)) {
    // 大世界：每次都重新讀取（成員可能有變動）
    const w = await api('GET', `/api/bigworlds/${charId.slice(WORLD_PREFIX.length)}`);
    ch = { id: charId, is_world: true, world: w, data: { name: w.name }, has_cover: true, img_ver: w.img_ver };
  } else ch = state.char?.id === charId ? state.char : await api('GET', `/api/characters/${charId}`);
  if (stale()) return;
  let chats = await api('GET', '/api/chats'); // 所有角色的對話
  if (stale()) return;
  const mine = chats.filter(c => c.char.id === charId);
  if (!chatId || !mine.some(c => c.id === chatId)) {
    // 快速進入：打開這個角色最近的對話，沒有就新建一段
    chatId = mine[0]?.id;
    if (!chatId) { chatId = (await api('POST', `/api/characters/${charId}/chats`, {})).id; chats = await api('GET', '/api/chats'); }
    if (stale()) return;
    history.replaceState(null, '', `#/chat/${charId}/${chatId}`);
  }
  const chat = await api('GET', `/api/characters/${charId}/chats/${chatId}`);
  if (stale()) return;
  // 全部讀完才一起換上（角色、對話清單、對話內容一定對得上）
  saveDraft(); // 原本那段對話打到一半的字：記在它名下
  state.char = ch; state.chats = chats; state.chat = chat;
  state.chatId = chatId;
  $('#input').value = drafts[draftKey()] || ''; autoGrow(); // 這段對話自己的草稿
  lsSet(LAST_CHAT_KEY, `${charId}/${chatId}`);
  showView('chat');
  $('#sidebar').classList.remove('open');
  setStatusPanel(statusPanelPref(), { remember: false }); // 狀態欄：電腦版照記住的開關，手機版先關著
  $('#status').textContent = ''; $('#status').title = '';
  showUsage();
  state.renderChat = null; // 每次打開對話都依設定重新決定先畫幾則
  renderSide(); renderHead(); renderMessages();
  $('#input').focus();
  // 從搜尋結果打開：捲到那則訊息
  const pj = state.pendingJump;
  if (pj && pj.owner === charId && pj.chat === chatId) { state.pendingJump = null; jumpToMessage(pj.index); }
  // 這段對話還在背景生成：接上串流繼續顯示
  if (state.chats.find(c => c.char.id === charId && c.id === chatId)?.generating) resumeStream(charId, chatId);
}

function renderSide() {
  // 所有角色的對話，新的在前；可搜尋對話名稱或角色名稱
  const q = $('#chatSearch').value.trim().toLowerCase();
  const ul = $('#chatList'); ul.innerHTML = '';
  const filter = state.sideFilter || 'all'; // 所有對話／對話（角色）／世界
  for (const ch of state.chats || []) { // 對話清單還沒讀到時當作空的
    if (filter === 'char' && ch.char.is_world) continue;
    if (filter === 'world' && !ch.char.is_world) continue;
    if (q &&!ch.title.toLowerCase().includes(q) && !ch.char.name.toLowerCase().includes(q)) continue;
    const titleEl = h('div', { class: 'ch-title', title: ch.title }, ch.title);
    const li = h('li', { class: ch.id === state.chatId ? 'active' : '', onclick: e => { if (!e.target.closest('button,input')) go(`#/chat/${ch.char.id}/${ch.id}`); } },
      avatarEl(ch.char, 'ch-av'),
      h('div', { class: 'ch-info' }, titleEl, h('div', { class: 'ch-sub' },
        ch.char.is_world ? icon('globe', 'ch-world') : null,
        ch.generating ? `${ch.char.name}｜生成中…` : `${ch.char.name}｜${ch.count} 則｜${fmtTime(ch.updated)}`)),
      h('div', { class: 'ch-tools' },
        h('button', { title: '重新命名', onclick: () => inlineRename(titleEl, ch.title, t => renameChat(ch.char.id, ch.id, t)) }, icon('pencil')),
        h('button', { title: '刪除這段對話', onclick: () => deleteChat(ch) }, icon('trash-2'))));
    ul.append(li);
  }
  if (!ul.children.length) ul.append(h('li', { class: 'muted' }, filter === 'world' && !q ? '還沒有世界的對話' : '沒有符合的對話'));
  // 輸入兩個字以上時，也搜尋所有對話的訊息內容
  const box = h('div', { class: 'msg-results' });
  ul.append(box);
  clearTimeout(state.searchTimer);
  if (q.length >= 2) state.searchTimer = setTimeout(() => searchMessages(q, box, filter).catch(() => {}), 250);
  for (const b of document.querySelectorAll('#sideTabs button')) b.classList.toggle('active', b.dataset.filter === filter);
  placeSidePill(state.sidePillAt !== undefined && state.sidePillAt !== filter);
  // 切換篩選時清單淡入（只有篩選改變時；背景定時更新清單不會閃）
  if (state.sidePillAt !== undefined && state.sidePillAt !== filter && motionOn() && ul.animate) ul.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
  state.sidePillAt = filter;
  // 有對話在背景生成時，定期更新清單，生成完就會顯示最新狀態
  clearTimeout(state.sideTimer);
  if (state.chats.some(c => c.generating)) state.sideTimer = setTimeout(refreshChatList, 3000);
}
$('#chatSearch').addEventListener('input', () => renderSide());

/** 訊息內容的搜尋結果：點了就打開那段對話並捲到那則訊息 */
async function searchMessages(q, box, filter) {
  const results = await api('GET', '/api/search?q=' + encodeURIComponent(q));
  if (!box.isConnected || $('#chatSearch').value.trim().toLowerCase() !== q) return; // 已經改了搜尋字
  const shown = results.filter(r => filter === 'all' || (filter === 'world') === isWorldKey(r.owner));
  box.append(h('div', { class: 'msg-results-head' }, shown.length ? `訊息內容（${shown.length}${results.length >= 80 ? '+' : ''}）` : '訊息內容：沒有找到'));
  const mark = s => { const t = esc(s), i = t.toLowerCase().indexOf(esc(q)); return i < 0 ? t : t.slice(0, i) + '<mark>' + t.slice(i, i + esc(q).length) + '</mark>' + t.slice(i + esc(q).length); };
  for (const r of shown) {
    const ch = state.chats.find(c => c.id === r.chat && c.char.id === r.owner);
    const who = r.role === 'user' ? (r.user_name || state.settings?.user_name || 'User') // 這段對話自己的名字（NPC、旁白各自標示）
      : r.speaker === 'narrator' ? '旁白' : ch?.char.name || '';
    box.append(h('button', { class: 'msg-hit', onclick: () => {
      state.pendingJump = { owner: r.owner, chat: r.chat, index: r.index };
      if (state.chatId === r.chat && state.char?.id === r.owner) { state.pendingJump = null; jumpToMessage(r.index); }
      else go(`#/chat/${r.owner}/${r.chat}`);
    } },
      h('div', { class: 'hit-title' }, `${r.title}`, h('span', { class: 'muted' }, ` · 第 ${r.index + 1} 則 · ${who}`)),
      h('div', { class: 'hit-snippet', html: mark(r.snippet) })));
  }
}
// 對話清單的篩選（所有對話／對話／世界）：選取的底色在按鈕之間滑動
const sidePill = h('span', { class: 'side-pill', 'aria-hidden': 'true' });
$('#sideTabs').prepend(sidePill);
function placeSidePill(animate) {
  const b = $('#sideTabs button.active');
  if (!b || !b.offsetWidth) return; // 對話頁還沒顯示：等 ResizeObserver
  sidePill.classList.toggle('no-anim', !animate || !motionOn());
  sidePill.style.width = b.offsetWidth + 'px';
  sidePill.style.transform = `translateX(${b.offsetLeft}px)`;
}
new ResizeObserver(() => placeSidePill(false)).observe($('#sideTabs'));
$('#sideTabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-filter]'); if (!b) return;
  state.sideFilter = b.dataset.filter; lsSet('tavern.sideFilter', state.sideFilter); renderSide();
});
state.sideFilter = lsGet('tavern.sideFilter') || 'all';
// ---------- 大世界：發言模式與發言列 ----------
/** 這段對話的發言模式：開始對話時決定，之後不變；舊對話沒有記錄就跟隨世界 */
const chatTurnMode = () => state.chat?.turn_mode || state.char?.world?.turn_mode || 'turns';
const TURN_MODE_LABEL = { turns: '輪流發言', narrator: '旁白統一' };
function renderSpeakerBar() {
  const bar = $('#speakerBar');
  const w = state.char?.is_world ? state.char.world : null;
  bar.hidden = !w || chatTurnMode() !== 'turns';
  bar.innerHTML = '';
  if (bar.hidden) return;
  bar.append(h('span', { class: 'sb-label' }, '讓誰說話'));
  // 導演判斷不在場的角色顯示成淡色；點他＝讓他登場
  const present = Array.isArray(state.chat?.present) ? state.chat.present : null;
  for (const m of w.members.filter(x => !x.missing)) {
    const a = avatarEl(m, 'sb-av');
    const away = present && !present.includes(m.id);
    bar.append(h('button', { class: 'sb-btn' + (away ? ' absent' : ''), title: away ? `${m.name} 目前不在場；點擊讓他登場並發言` : `讓 ${m.name} 發言（生成中點擊＝插話）`, onclick: () => speakAs(m.id).catch(fail) }, a, h('span', {}, m.name)));
  }
  // 旁白不會自動出現，但隨時可以點它來描寫、統整場景
  bar.append(h('button', { class: 'sb-btn', title: '讓旁白描寫、統整場景', onclick: () => speakAs('narrator').catch(fail) },
    h('div', { class: 'avatar-ph sb-av narrator-av' }, icon('book-open')), h('span', {}, '旁白')));
  bar.append(h('button', { class: 'sb-btn sb-auto', title: '自動挑選下一位角色接話', onclick: () => { if (!state.generating) generate('normal', ''); } }, icon('users'), h('span', {}, '接話')));
}
/** 指定角色發言；如果正在生成，先停下來再讓他插話 */
async function speakAs(id) {
  if (state.generating) {
    // 插話：先請目前的生成停下來（最多等 8 秒），等待期間在狀態列顯示，不然看起來像沒反應
    const name = id === 'narrator' ? '旁白' : (state.char.world?.members || []).find(m => m.id === id)?.name || '';
    const st = $('#status'), prevText = st.textContent;
    st.textContent = `等待插話…（先停下目前的回應${name ? `，再讓 ${name} 接話` : ''}）`;
    await api('POST', '/api/generate/stop', { char_id: state.char.id, chat_id: state.chatId });
    for (let i = 0; i < 80 && state.generating; i++) await new Promise(r => setTimeout(r, 100));
    if (state.generating) { st.textContent = prevText; return toast('上一則還沒停下來，請再按一次', true); }
    return generate('normal', '', { speaker: id, interrupt: true });
  }
  return generate('normal', '', { speaker: id });
}

// 對話頁右上角的模型選單：切換模型設定檔（下一次生成就會使用）
async function renderModelPick() {
  const sel = $('#modelPick');
  const [prof, st] = await Promise.all([api('GET', '/api/profiles'), state.settings ? null : api('GET', '/api/settings')]);
  if (st) state.settings = st.settings;
  const s = state.settings || {};
  const curModel = (s[s.provider] || {}).model || '未選模型';
  sel.innerHTML = '';
  for (const p of prof.profiles) sel.append(h('option', { value: p.id }, `${p.name}｜${p.model || '未選模型'}`));
  sel.append(h('option', { value: '__manage' }, '管理設定檔…'));
  sel.value = prof.active; // 一定有一個使用中的設定檔（伺服器保證）
  sel.title = `目前使用：${prof.profiles.find(p => p.id === prof.active)?.name}（${curModel}）`;
  sel.onchange = async () => {
    if (sel.value === '__manage') { sel.value = prof.active; state.settingsTab = 'system'; return go('#/settings'); }
    try {
      const r = await api('POST', `/api/profiles/${sel.value}/apply`);
      state.settings = r.settings;
      toast(`已切換到「${r.profiles.find(p => p.id === sel.value)?.name}」，下一次生成開始使用`);
    } catch (e) { fail(e); }
    renderModelPick().catch(fail);
  };
  renderThinkPick();
}

// 模型選單左邊的思考選單：只對這段對話有效（存在對話裡，送出前依供應商換成各自的參數）
// sim＝模擬思考：給不會思考的模型用，提示詞要求先在 <thinking> 裡規劃再回覆（同時關閉原生思考，避免兩種思考疊在一起）
const THINK_LEVELS = [['off', '關閉'], ['low', '低'], ['medium', '中'], ['high', '高'], ['sim', '模擬思考']];
const EFFORT_LABEL = { none: '關閉', minimal: '關閉', low: '低', medium: '中', high: '高', xhigh: '極高', max: '最高' };
/**
 * 目前的模型設定檔用的思考程度（顯示用）。沒指定時顯示 API 的預設檔位：
 * Claude 的 effort 預設「中」；OpenAI 相容預設「中」；Gemini 3 以後預設「高」，2.x 是模型自己決定（動態）
 */
function profileThinkLabel(s = state.settings || {}) {
  if (s.provider === 'anthropic') {
    const a = s.anthropic || {};
    return a.thinking === 'off' ? '關閉' : EFFORT_LABEL[a.effort] || '中';
  }
  const cfg = s[s.provider] || {};
  if (cfg.reasoning_effort) return EFFORT_LABEL[cfg.reasoning_effort] || cfg.reasoning_effort;
  if (s.provider === 'gemini') return /^gemini-2\./.test(cfg.model || '') ? '自動' : '高';
  return '中';
}
function thinkOptions(sel, own) {
  sel.replaceChildren(h('option', { value: '' }, `${profileThinkLabel()}（跟隨設定）`),
    ...THINK_LEVELS.map(([v, t]) => h('option', { value: v }, t)));
  sel.value = THINK_LEVELS.some(([v]) => v === own) ? own : '';
}
function renderThinkPick() {
  const sel = $('#thinkPick');
  if (!sel || !state.chat) return;
  thinkOptions(sel, state.chat.think);
  const own = !!sel.value;
  sel.closest('.think-pick').classList.toggle('on', own);
  sel.closest('.think-pick').title = `思考程度（只對這段對話有效）：${own ? '這段對話自己指定' : `跟隨模型設定檔（${profileThinkLabel()}；模型設定檔沒指定時是 API 的預設檔位）`}。`
    + '關閉～高只對會思考的模型有效；「模擬思考」給不會思考的模型用：要求先寫一段簡短的思考再回覆，同時關閉模型原生的思考。思考也會佔用回覆長度；在「設定 → API 設定」改模型設定檔的預設。';
}
/** 存這段對話的思考檔位（null＝跟隨模型設定） */
async function saveChatThink(v) {
  const charId = state.char.id, chatId = state.chatId;
  const r = await api('PUT', `/api/characters/${charId}/chats/${chatId}`, { think: v });
  if (state.chatId === chatId) { if (r.think) state.chat.think = r.think; else delete state.chat.think; }
  renderThinkPick();
  toast(v ? `這段對話的思考改成「${THINK_LEVELS.find(([k]) => k === v)[1]}」，下一次生成開始使用` : '這段對話的思考改回跟隨模型設定');
}
$('#thinkPick').onchange = () => saveChatThink($('#thinkPick').value || null).catch(e => { fail(e); renderThinkPick(); });

function renderHead() {
  renderSpeakerBar();
  renderAsWho();
  renderModelPick().catch(() => {});
  $('#chatTitle').replaceChildren(state.chat.title, icon('pencil', 'title-edit'));
  const who = state.char.is_world
    ? `世界「${state.char.data.name}」｜${state.char.world.members.filter(m => !m.missing).length} 位角色｜${TURN_MODE_LABEL[chatTurnMode()]}`
    : `與 ${state.char.data.name} 的對話`;
  $('#chatSub').textContent = `${who}｜${state.chat.messages.length} 則｜${memInfo(state.chat)}`;
  document.title = `AI酒館－${state.char.data.name}`; // 對話中：AI酒館 後面接角色（或世界）名稱
  renderStatusPanel();
}
/** 把文字元素換成輸入框就地改名：Enter 儲存、Esc 取消 */
function inlineRename(el, current, save) {
  const input = h('input', { type: 'text', value: current });
  let done = false;
  const finish = async ok => {
    if (done) return; done = true;
    const v = input.value.trim();
    input.replaceWith(el);
    if (ok && v && v !== current) await save(v).catch(fail);
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) finish(true); if (e.key === 'Escape') finish(false); });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', e => e.stopPropagation());
  el.replaceWith(input); input.focus(); input.select();
}
async function renameChat(charId, chatId, title) {
  await api('PUT', `/api/characters/${charId}/chats/${chatId}`, { title });
  const item = state.chats.find(c => c.id === chatId); if (item) item.title = title;
  if (chatId === state.chatId) { state.chat.title = title; renderHead(); }
  renderSide();
}
// 清空聊天：只留下開場白。開場白依角色卡／世界「目前」的內容重新帶入：
// 在對話裡改過或刪掉的開場白都會恢復，角色卡後來改過的開場白也會換成新的（角色有好幾個開場白時，沿用原本選的那一個）
async function clearChat() {
  if (state.generating || !state.chat) return;
  const msgs = state.chat.messages;
  const charId = state.char.id, chatId = state.chatId;
  const prevIdx = msgs[0]?.greeting ? msgs[0].greeting_idx ?? msgs[0].swipe_id ?? 0 : 0; // 多則訊息的開場白記在 greeting_idx
  let opening;
  try { opening = await api('GET', `/api/characters/${charId}/chats/${chatId}/opening?greeting=${prevIdx}`); } catch (e) { return fail(e); }
  const same = msgs.length === opening.length && msgs.every((m, i) => m.role === opening[i].role && m.content === opening[i].content);
  if (same) return toast('這段對話已經是空的');
  let nOpen = 0;
  while (nOpen < msgs.length && msgs[nOpen].greeting) nOpen++;
  const others = msgs.length - nOpen;
  if (!await askConfirm(`確定清空「${state.chat.title}」？\n`
    + (others ? `開場白以外的 ${others} 則訊息都會刪除。清空前會把原本的對話完整放進垃圾桶，${trashDaysText()}\n` : '')
    + (opening.length ? '開場白會依角色卡目前的內容重新帶入（在對話裡改過或刪掉的開場白都會恢復）。' : '角色卡沒有開場白，清空後對話會是空的。'))) return;
  // 記憶：可以一起清空，或保留下來接著用。兩個問題都問完才存檔（一次存好，中途關掉也不會留下對不上的進度）
  const clearMem = !!state.chat.memory?.trim() && await askConfirm('也要清空這段對話的「記憶」嗎？\n選「保留記憶」的話，之後的新訊息會接著整理進去。', { okText: '一起清空', cancelText: '保留記憶' });
  if (state.chatId !== chatId || state.generating) return; // 問的期間切走了或開始生成：不動
  const keep = opening;
  state.chat.messages = keep;
  const memPatch = clearMem ? { memory: '', memory_upto: 0, memory_cut: 0, present: null } : { memory_upto: keep.length, memory_cut: 0, present: null };
  if (!await saveChat({ ...memPatch, snapshot: 'clear' })) return; // snapshot：伺服器先把原本的對話留一份在垃圾桶
  renderMessages(); refreshChatList();
  $('#status').textContent = '';
  toast((clearMem ? '已清空聊天與記憶' : '已清空聊天') + (others ? '。原本的對話放在垃圾桶（設定 → 資料），清錯了可以還原' : ''), false, others ? 7000 : undefined);
}

/**
 * 更換名字：列出記憶與「目前會送給 AI 的聊天紀錄」裡每一處舊名字，讓使用者勾選要改哪些。
 * 每一處單獨一列（依對話順序，記憶在最後），一次顯示 50 列，超過時按「顯示更多」。
 * 回傳 [{ i, at }]（i = -1 是記憶）；按取消回傳 null（名字也不換）
 */
function pickRenames(scan, from, to, chat) {
  return new Promise(resolve => {
    const PAGE = 50;
    const list = scan.items; // 伺服器已經依對話順序排好，記憶在最後
    const checked = new Set(list); // 預設全部勾選
    const where = it => (it.i === -1 ? '記憶' : `第 ${it.i + 1} 則`);
    const dots = (s, head) => (s.length >= 16 ? (head ? '…' + s : s + '…') : s);
    const hl = it => h('span', { class: 'rn-ctx' }, dots(it.before, true).replace(/\s+/g, ' '), h('mark', {}, from), dots(it.after, false).replace(/\s+/g, ' '));
    const box = h('div', { class: 'rn-list' });
    const countEl = h('span', { class: 'muted' });
    const syncCount = () => (countEl.textContent = `已勾選 ${checked.size} / ${list.length} 處`);
    const boxes = [];
    // 點開：顯示完整的訊息（或記憶），這一處標亮、其他同名的地方淡淡標示
    const fullText = it => {
      const t = String(it.i === -1 ? chat?.memory || '' : chat?.messages?.[it.i]?.content || '');
      if (t.slice(it.at, it.at + from.length) !== from) return h('div', { class: 'rn-full muted' }, '（找不到原文，可能剛被修改過）');
      const parts = [];
      let pos = 0;
      for (let k = t.indexOf(from); k >= 0; k = t.indexOf(from, k + from.length)) {
        parts.push(t.slice(pos, k), h('mark', { class: k === it.at ? 'here' : 'other' }, from));
        pos = k + from.length;
      }
      parts.push(t.slice(pos));
      return h('div', { class: 'rn-full' }, ...parts);
    };
    const row = it => {
      const cb = h('input', { type: 'checkbox', checked: checked.has(it) });
      cb.onchange = () => { cb.checked ? checked.add(it) : checked.delete(it); syncCount(); };
      cb.addEventListener('click', e => e.stopPropagation()); // 點勾選框只勾選，不展開
      boxes.push({ it, cb });
      const d = h('details', { class: 'rn-item' },
        h('summary', { class: 'rn-sub', title: '點一下看完整的內容' }, cb, h('span', { class: 'muted rn-where' }, where(it)), hl(it)));
      d.addEventListener('toggle', () => {
        if (d.open && !d.querySelector('.rn-full')) {
          const full = fullText(it);
          d.append(full);
          const m = full.querySelector('mark.here'); // 很長的訊息：在框裡捲到這一處（不動外面的清單）
          if (m) full.scrollTop = Math.max(0, m.offsetTop - full.offsetTop - 40);
        }
      });
      return d;
    };
    let shown = 0;
    const more = h('button', { type: 'button', class: 'small' }, '顯示更多');
    const showMore = () => { for (const it of list.slice(shown, shown + PAGE)) box.append(row(it)); shown = Math.min(list.length, shown + PAGE); more.hidden = shown >= list.length; };
    more.onclick = showMore;
    showMore();
    const setAll = v => { list.forEach(it => (v ? checked.add(it) : checked.delete(it))); boxes.forEach(b => (b.cb.checked = v)); syncCount(); };
    syncCount();
    const close = v => { document.removeEventListener('keydown', onKey, true); ov.remove(); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); } };
    const notes = [
      scan.greetings ? `開場白已依角色卡的模板自動換成新名字（${scan.greetings} 則），只改原本是 {{user}} 的地方。` : '',
      `下面是記憶與目前會送給 AI 的聊天紀錄裡每一處「${from}」。不是名字的（例如形容詞）請取消勾選；點一下那一列可以看完整的內容。`,
      `更早的訊息${scan.older ? `（還有 ${scan.older} 處）` : ''}目前不會送給 AI，保留原文不改；需要時可以直接編輯那則訊息。之後如果按記憶的「全部重新整理」，舊名字可能再出現在記憶裡。`,
      '不建議在對話已經拉長時更改名字：沒改到的舊名字可能讓 AI 把新舊名字當成兩個人。想換身分時，開一段新對話會比較乾淨。',
    ].filter(Boolean);
    const ov = h('div', { class: 'crop-overlay' },
      h('div', { class: 'crop-box rn-box', role: 'dialog' },
        h('h3', {}, `把「${from}」改成「${to}」`),
        ...notes.map(t => h('p', { class: 'ask-note' }, t)),
        h('div', { class: 'rn-tools' }, h('button', { type: 'button', class: 'small', onclick: () => setAll(true) }, '全選'),
          h('button', { type: 'button', class: 'small', onclick: () => setAll(false) }, '全不選'), countEl),
        box, more,
        h('div', { class: 'ask-btns' },
          h('button', { type: 'button', onclick: () => close(null) }, '取消（不換名字）'),
          h('button', { type: 'button', class: 'primary', onclick: () => close([...checked].map(it => ({ i: it.i, at: it.at }))) }, '套用'))));
    document.addEventListener('keydown', onKey, true);
    document.body.append(ov);
  });
}

// ---------- 對話設定：只對這段對話有效（模型設定檔留在標題列，方便快速切換） ----------
$('#btnChatSettings').onclick = () => openChatSettings().catch(fail);
async function openChatSettings() {
  if (!state.chat) return;
  const charId = state.char.id, chatId = state.chatId, c = state.chat, c0 = c;
  const s = state.settings || (await api('GET', '/api/settings')).settings;
  const isWorld = !!state.char.is_world;
  const def = isWorld ? (s.history_cap_world ?? 32000) : (s.history_cap_char ?? 16000);
  const url = `/api/characters/${charId}/chats/${chatId}`;

  // 聊天紀錄上限：跟隨預設，或這段對話自己指定
  const capSel = h('select', {}, h('option', { value: '' }, `跟隨預設（${isWorld ? '大世界' : '角色'}對話：${fmtCap(def)}）`),
    HISTORY_CAP_OPTS.map(([v, t]) => h('option', { value: String(v) }, t)));
  const own = Number.isFinite(c.history_cap) ? String(c.history_cap) : '';
  if (own && !HISTORY_CAP_OPTS.some(([v]) => String(v) === own)) capSel.append(h('option', { value: own }, `自訂：${fmtCap(+own)}`));
  capSel.value = own;
  const usage = h('p', { class: 'muted small-note' }, '計算目前的用量…');
  const room = h('p', { class: 'small-note ctx-room' });
  const refreshUsage = async () => {
    const r = await api('POST', '/api/prompt-preview', { char_id: charId, chat_id: chatId });
    usage.textContent = `目前每次送出約 ${r.info.tokens} tokens（聊天紀錄 ${r.info.history_used}/${r.info.history_total} 則`
      + (r.info.memory_cut ? `，前 ${r.info.memory_cut} 則已壓縮進記憶` : '') + `）｜套用中的上限：${fmtCap(r.info.history_cap)}`;
    const t = roomText(r.info);
    room.textContent = t.text;
    room.classList.toggle('warn', t.warn);
  };
  capSel.onchange = async () => {
    try {
      const r = await api('PUT', url, { history_cap: capSel.value === '' ? null : +capSel.value });
      if (state.chatId === chatId) state.chat.history_cap = r.history_cap; // 只更新這個欄位，不動到畫面上的訊息
      toast('已套用到這段對話');
      refreshUsage().catch(() => {});
    } catch (e) { fail(e); }
  };

  const after = fn => () => { closeModal(); fn().catch(fail); }; // 先關掉對話設定再打開下一個視窗
  const cut = Math.min(c.memory_cut || 0, c.memory_upto || 0, c.messages.length);
  /** 存一個對話設定欄位：只更新這幾個欄位，不動到畫面上的訊息（生成中也可以改） */
  const patchChat = async (patch, msg = '已套用到這段對話') => {
    const r = await api('PUT', url, patch);
    if (state.chatId === chatId) for (const k of Object.keys(patch)) { if (k in r) state.chat[k] = r[k]; else delete state.chat[k]; }
    toast(msg);
    return r;
  };

  // 生成參數：留空＝跟隨目前的模型設定（標題列選的模型設定檔）
  const GEN = [
    ['context_tokens', '上下文長度（tokens）', s.context_tokens, { min: 256, max: 1e8, step: 512 }],
    ['temperature', '創意發散度（Temperature）', s.temperature, { min: 0, max: 2, step: 0.05 }],
    ['max_tokens', '回覆長度（最大回應 tokens）', s.max_tokens, { min: 16, max: 1e6, step: 16 }],
  ];
  const genField = ([k, label, def, o]) => {
    const inp = h('input', { type: 'number', min: o.min, max: o.max, step: o.step, value: Number.isFinite(c[k]) ? String(c[k]) : '', placeholder: `跟隨模型設定（${def ?? '—'}）` });
    // 空白（跟隨模型設定）時用滾輪、方向鍵或右邊的上下箭頭調整：先填入目前生效的值，從它開始加減
    // （瀏覽器對空白的數字欄位會從最小值開始）
    const prefill = () => { if (inp.value === '' && Number.isFinite(def)) inp.value = String(def); };
    inp.addEventListener('wheel', () => { if (document.activeElement === inp) prefill(); }, { passive: true });
    inp.addEventListener('keydown', e => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') prefill(); });
    inp.addEventListener('pointerdown', e => { if (e.clientX > inp.getBoundingClientRect().right - 24) prefill(); }); // 點右邊的上下箭頭
    inp.onchange = async () => {
      const raw = inp.value.trim(), v = raw === '' ? null : Number(raw);
      if (v !== null && !(Number.isFinite(v) && v >= o.min && v <= o.max)) return toast(`「${label}」要是 ${o.min}～${o.max} 之間的數字；留空＝跟隨模型設定`, true);
      try {
        await patchChat({ [k]: v }, v === null ? `「${label}」改回跟隨模型設定` : '已套用到這段對話');
        refreshUsage().catch(() => {});
      } catch (e) { fail(e); }
    };
    return h('label', {}, h('span', {}, label), inp);
  };
  const [ctxField, tempField, lenField] = GEN.map(genField);
  // 思考程度：和標題列模型選單左邊的思考選單是同一個設定
  const thinkSel = h('select', {});
  thinkOptions(thinkSel, c.think);
  thinkSel.onchange = () => saveChatThink(thinkSel.value || null).catch(fail);
  const thinkField = h('label', { title: '關閉～高只對會思考的模型有效；「模擬思考」給不會思考的模型用' }, h('span', {}, '思考程度'), thinkSel);

  // 這段對話的你：跟隨設定頁／使用者設定檔／這段對話自訂的名字與人設
  const personas = s.personas || [];
  const youSel = h('select', {}, h('option', { value: '' }, `跟隨設定頁（目前：${s.user_name || 'User'}；在設定頁切換時，名字可能前後不一致）`),
    personas.map(p => h('option', { value: 'p:' + p.id }, `使用者設定檔：${p.name}｜${p.user_name}`)),
    h('option', { value: 'custom' }, '自訂（只用在這段對話）'));
  youSel.value = c.persona_id && personas.some(p => p.id === c.persona_id) ? 'p:' + c.persona_id
    : (c.user_name || c.user_persona) ? 'custom' : '';
  const nameIn = h('input', { type: 'text', value: c.user_name || '', placeholder: `留空＝用設定頁的名字（${s.user_name || 'User'}）` });
  const personaIn = h('textarea', { rows: 4, value: c.user_persona || '', placeholder: '留空＝用設定頁的人設' + (s.user_persona?.trim() ? `：${s.user_persona.trim().slice(0, 40)}…` : '（目前沒有）') });
  const rerender = () => { if (state.chatId === chatId) renderMessages(); }; // 訊息上的名字與頭像跟著換
  // 這段對話實際用的名字（{{user}}）：使用者設定檔 > 這段對話自訂的 > 設定頁的
  const userNameOf = x => {
    const p = x.persona_id ? personas.find(q => q.id === x.persona_id) : null;
    return (p ? p.user_name : (x.user_name || '').trim()) || s.user_name || 'User';
  };
  /**
   * 換名字或使用者設定檔：開場白是建立對話時就把 {{user}} 換成當時的名字，所以要一起改成新名字，
   * 不然 AI 會看到舊名字、把兩個人搞混。開場白自動改；其他訊息與記憶裡也有舊名字時先問
   */
  const applyYou = async (patch, msg) => {
    const c = state.chatId === chatId ? state.chat : c0; // 生成完成後 state.chat 會換成新的物件：用最新的
    const from = userNameOf(c), to = userNameOf({ ...c, ...patch, persona_id: patch.persona_id ?? undefined });
    let note = '';
    if (from !== to) {
      if (state.generating && state.chatId === chatId) return toast('生成中無法更換名字（要一起改對話裡的名字），請等生成完成或按「停止」', true);
      // 開場白由伺服器依模板自動換；記憶與送給 AI 的那段聊天紀錄裡的舊名字，讓你勾選要改哪些
      const scan = await api('POST', `${url}/rename-preview`, { from, to });
      let edits = [];
      if (scan.items.length) {
        edits = await pickRenames(scan, from, to, c);
        if (!edits) return; // 取消：名字也不換
      }
      patch = { ...patch, rename_user: { from, to, edits } };
      if (scan.older) note = `；更早的訊息還有 ${scan.older} 處「${from}」沒有改（目前不會送給 AI）`;
    }
    const r = await api('PUT', url, patch);
    if (state.chatId === chatId) {
      if (patch.rename_user) state.chat = r; // 訊息與記憶也改了：整份換上
      else for (const k of Object.keys(patch)) { if (k in r) state.chat[k] = r[k]; else delete state.chat[k]; }
    }
    toast(msg + note, false, note ? 8000 : undefined); rerender(); showYouAv();
  };
  // 選單旁邊顯示這段對話目前用的頭像（使用者設定檔的頭像只套用在這段對話）
  const youAv = h('span', { class: 'cs-you-av' });
  const showYouAv = () => { if (state.chatId === chatId) youAv.replaceChildren(userAvatarEl('cs-av')); };
  showYouAv();
  const customBox = h('div', { class: 'form' },
    h('label', {}, h('span', {}, '名字（{{user}}）'), nameIn),
    h('label', {}, h('span', {}, '人設（會加入提示詞）'), personaIn),
    h('div', { class: 'btns-right' }, h('button', { type: 'button', class: 'success', onclick: async () => {
      try { await applyYou({ persona_id: null, user_name: nameIn.value, user_persona: personaIn.value }, '已儲存這段對話的名字與人設'); }
      catch (e) { fail(e); }
    } }, ic('save', '儲存名字與人設'))));
  const syncYou = () => (customBox.hidden = youSel.value !== 'custom');
  youSel.onchange = async () => {
    syncYou();
    if (youSel.value === 'custom') return; // 自訂：填好再按「儲存」
    try {
      const id = youSel.value ? youSel.value.slice(2) : null;
      await applyYou({ persona_id: id, user_name: '', user_persona: '' }, id ? '這段對話改用這個使用者設定檔' : '這段對話改回跟隨設定頁');
    } catch (e) { fail(e); }
  };
  syncYou();
  const youBox = h('fieldset', {}, h('legend', {}, '這段對話的你'),
    h('div', { class: 'cs-you' }, youAv, h('label', { class: 'grow' }, h('span', {}, '名字、人設與頭像'), youSel)), customBox,
    h('p', { class: 'muted small-note' }, '同一個角色開不同的對話時，可以扮演不同的身分。使用者設定檔會連頭像一起換（只換這段對話的）；自訂只換名字與人設（頭像用設定頁的）。使用者設定檔在「設定 → 使用者」新增，各自的頭像也在那裡設定。'),
    h('p', { class: 'note-warn' }, h('b', {}, '提醒：'), '建議在對話剛開始時就決定名字。對話已經拉長後再換名字，舊訊息與記憶裡會留著舊名字（只會改送給 AI 的那一段，更早的不改），AI 可能把新舊名字當成兩個人；想換身分時，開一段新對話會比較乾淨。'));

  // 你扮演的 NPC：只有名字，台詞與行動由你寫；在輸入框旁的身分選單切換
  const npcList = h('div', { class: 'book-toggles' });
  const renderNpcs = () => {
    npcList.innerHTML = '';
    const list = state.chat.npcs || [];
    if (!list.length) npcList.append(h('p', { class: 'muted small-note' }, '還沒有 NPC。'));
    for (const n of list) npcList.append(h('div', { class: 'prof-row' }, h('span', { class: 'grow' }, n),
      h('button', { type: 'button', class: 'small', onclick: async () => {
        // 改名要改到舊訊息，生成中不能改（生成存檔時會把訊息蓋回去）
        if (state.generating && state.chatId === chatId) return toast('生成中無法改名（要一起改舊訊息），請等生成完成或按「停止」', true);
        const name = ((await askText('NPC 改名', { note: '這段對話裡用這個名字說過的話也會一起改', value: n, okText: '改名' })) || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        if (!name || name === n) return;
        if (reservedNames().has(name) || list.includes(name)) return toast(`「${name}」已經有人用了，請換一個名字`, true);
        try {
          for (const m of state.chat.messages) if (m.npc === n) m.npc = name;
          if (!await saveChat()) return; // 舊訊息沒存成功：名單也不改，兩邊才對得上
          await patchChat({ npcs: list.map(x => (x === n ? name : x)) }, `已改名為「${name}」`);
          renderNpcs(); renderAsWho(); rerender();
        } catch (e) { fail(e); }
      } }, ic('pencil', '改名')),
      h('button', { type: 'button', class: 'small', onclick: async () => {
        try { await patchChat({ npcs: list.filter(x => x !== n) }, `已從名單移除「${n}」`); renderNpcs(); renderAsWho(); } catch (e) { fail(e); }
      } }, ic('trash-2', '移除'))));
  };
  renderNpcs();
  const npcBox = h('fieldset', {}, h('legend', {}, '你扮演的 NPC'), npcList,
    h('div', { class: 'btns' }, h('button', { type: 'button', onclick: async () => {
      try { if (await addNpc()) { renderNpcs(); renderAsWho(); } } catch (e) { fail(e); }
    } }, ic('plus', '新增 NPC'))),
    h('p', { class: 'muted small-note' }, '只需要名字，個性與台詞由你扮演。在輸入框旁的身分選單選「NPC：名字」再送出；送給 AI 時會標註是你扮演的 NPC，AI 不會替他們說話。移除只是不再列在選單裡，說過的話照樣保留。'));

  // 世界書：這段對話停用哪幾本（預設全部啟用）
  const bookList = h('div', { class: 'book-toggles' }, h('p', { class: 'muted small-note' }, '讀取中…'));
  const loadBooks = async () => {
    const books = await api('GET', `${url}/books`);
    bookList.innerHTML = '';
    if (!books.length) return bookList.append(h('p', { class: 'muted small-note' }, '這段對話沒有會用到的世界書（全域世界書在設定頁，角色卡的在角色設定）。'));
    const boxes = books.map(b => {
      const cb = h('input', { type: 'checkbox', checked: !b.off });
      cb.onchange = () => patchChat({ books_off: boxes.filter(x => !x.cb.checked).map(x => x.key) }, cb.checked ? `已啟用「${b.name}」` : `這段對話不再使用「${b.name}」`).catch(fail);
      bookList.append(h('label', { class: 'check' }, cb, `${b.name}`, h('span', { class: 'muted' }, `（${b.source}，${b.count} 條）`)));
      return { cb, key: b.key };
    });
  };
  const body = h('div', { class: 'form chat-settings' },
    h('p', { class: 'muted small-note' }, '這裡的設定只對這段對話有效，其他對話不受影響。'),
    h('fieldset', {}, h('legend', {}, '生成與上下文'),
      h('div', { class: 'row cs-grid' }, ctxField, h('label', {}, h('span', {}, '聊天紀錄最多送多少 tokens'), capSel), tempField, lenField, thinkField),
      usage, room,
      h('div', { class: 'muted small-note cs-help' },
        h('p', {}, '留空＝跟隨目前的模型設定（標題列選的模型設定檔，或「設定 → API 設定」）。'),
        h('p', {}, h('b', {}, '上下文長度：'), 'AI 一次能看到的總量。包含：系統提示、角色卡、世界書、你的人設、記憶、聊天紀錄，加上留給回覆的長度。請配合模型能力設定；超過模型的上限會被拒絕或截斷。'
          + '使用本機小模型（LM Studio、Ollama 等）時，不要超過載入模型時設定的長度；出錯、變得很慢或回覆被截斷時，請調小上下文長度。'),
        h('p', {}, h('b', {}, '聊天紀錄最多送多少 tokens：'), '只限制「聊天紀錄」。上下文長度扣掉其他內容後，剩下的空間才會給聊天紀錄。調低可以節省 Token、加快速度，建議將更早的劇情交給記憶。預設值在「提示詞設定 → 記憶與上下文壓縮」。'),
        h('p', {}, h('b', {}, '創意發散度：'), '越高越有變化，越低越平穩、貼近設定。'),
        h('p', {}, h('b', {}, '回覆長度：'), '上下文裡預留給回覆的空間，影響回覆最多寫多長。模型的思考也會算在裡面。'),
        h('p', {}, h('b', {}, '思考程度：'), '只對會思考的模型有效；「模擬思考」給不會思考的模型用。'))),
    isWorld ? worldBox() : null, // 大世界：發言模式與每輪接話人數（和生成有關，接在生成與上下文後面）
    h('fieldset', {}, h('legend', {}, '記憶與工具'),
      h('p', { class: 'muted' }, memInfo(c) + (s.memory_enabled && c.memory?.trim() && cut ? `｜前 ${cut} 則已壓縮（不再送出原文）` : '')),
      h('div', { class: 'btns' },
        h('button', { type: 'button', onclick: after(openMemory) }, ic('brain', '檢視／編輯記憶')),
        h('button', { type: 'button', onclick: after(openPreview) }, ic('file-text', '檢視送出的提示詞')),
        h('button', { type: 'button', class: 'danger', onclick: after(clearChat) }, ic('eraser', '清空聊天')))),
    // 匯出這段對話：Markdown／純文字方便閱讀，jsonl 是 SillyTavern 的對話格式（可以帶到 SillyTavern 匯入）
    // 匯入 SillyTavern 的對話：這段還停在開場白就直接帶入，已經有內容就開一段新的
    h('fieldset', {}, h('legend', {}, '匯出／匯入對話'),
      h('div', { class: 'btns' },
        [['md', 'Markdown'], ['txt', '純文字'], ['jsonl', 'SillyTavern（.jsonl）']].map(([fmt, label]) =>
          h('button', { type: 'button', onclick: () => exportFile({ kind: 'chat', id: `${charId}/${chatId}`, format: fmt }, `${url}/export?format=${fmt}`) }, ic('export', label)))),
      h('p', { class: 'muted small-note' }, '匯出：每則訊息用目前顯示的版本，思考過程不包含在內。'),
      h('div', { class: 'btns' },
        h('button', { type: 'button', onclick: () => importChatFile(charId, { into: chatId }) }, ic('import', '匯入 SillyTavern 對話（.jsonl）'))),
      h('p', { class: 'muted small-note' }, c.messages.every(m => m.greeting)
        ? '匯入：這段對話還停在開場白，匯入的內容會直接取代開場白。'
        : '匯入：這段對話已經有內容，會另外開一段新的對話，這段不受影響。')),
    h('fieldset', {}, h('legend', {}, '世界書'), bookList,
      h('p', { class: 'muted small-note' }, '取消勾選＝這段對話不使用那本世界書（其他對話不受影響）。')),
    npcBox,
    youBox);
  openModal(`對話設定：${c.title}`, body, [h('button', { 'data-close': true }, '關閉')], { esc: true });
  refreshUsage().catch(() => { usage.textContent = ''; });
  loadBooks().catch(() => { bookList.textContent = '無法讀取世界書'; });

  /** 大世界：發言模式（開始後不能改）與每輪最多幾位角色接話 */
  function worldBox() {
    const mode = chatTurnMode();
    const worldMax = state.char.world?.max_replies || 2;
    const maxSel = h('select', {}, h('option', { value: '' }, `跟隨世界設定（${worldMax} 位）`), [1, 2, 3, 4, 5].map(n => h('option', { value: String(n) }, `${n} 位`)));
    maxSel.value = Number.isInteger(c.max_replies) ? String(c.max_replies) : '';
    maxSel.onchange = () => patchChat({ max_replies: maxSel.value === '' ? null : +maxSel.value }).catch(fail);
    return h('fieldset', {}, h('legend', {}, '大世界'),
      h('p', { class: 'muted' }, `發言模式：${TURN_MODE_LABEL[mode]}（開始對話後不能更改）`),
      mode === 'turns' ? h('label', {}, h('span', {}, '你說完話後，最多幾位角色接話'), maxSel) : null);
  }
}

// ---------- 記憶 ----------
const memInfo = c => {
  if (!c.memory?.trim()) return '尚無記憶';
  const upto = Math.min(c.memory_upto || 0, c.messages.length);
  return `記憶已整理 ${upto}/${c.messages.length} 則`;
};
/** 背景自動更新記憶時，在標題列顯示進度，完成後更新 */
async function watchMemory(charId, chatId, label = '正在背景壓縮舊對話（整理進記憶）…') {
  const here = () => state.char?.id === charId && state.chatId === chatId;
  if (here()) $('#chatSub').textContent += '｜' + label;
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const all = await api('GET', '/api/chats').catch(() => null);
    const c = all?.find(x => x.char.id === charId && x.id === chatId);
    if (c && c.memory_updating) continue;
    if (here() && !state.generating) {
      const fresh = await api('GET', `/api/characters/${charId}/chats/${chatId}`).catch(() => null);
      if (fresh && here()) {
        Object.assign(state.chat, { memory: fresh.memory, memory_upto: fresh.memory_upto, memory_updated: fresh.memory_updated, memory_cut: fresh.memory_cut, memory_prev: fresh.memory_prev });
        if (fresh.deleted) state.chat.deleted = fresh.deleted; else delete state.chat.deleted; // 重新整理後「已整理進記憶」的標記會變
        renderHead();
      }
    }
    return;
  }
}
async function openMemory() {
  const charId = state.char.id, chatId = state.chatId;
  const chat = await api('GET', `/api/characters/${charId}/chats/${chatId}`);
  const s = state.settings || (await api('GET', '/api/settings')).settings;
  const ta = h('textarea', { rows: 16, value: chat.memory || '', placeholder: '這裡記錄這段對話的劇情摘要與重點，會放進提示詞裡讓 AI 記住。\n可以自己寫，也可以按下方「AI 整理新訊息」讓 AI 幫你整理。' });
  const tok = h('div', { class: 'tok' });
  const info = h('div', { class: 'muted mem-info' });
  const updInfo = c => {
    tok.textContent = `約 ${estTok(ta.value)} tokens`;
    const parts = [memInfo(c)];
    if (c.memory_updated) parts.push(`上次更新 ${fmtTime(c.memory_updated)}`);
    const cut = Math.min(c.memory_cut || 0, c.memory_upto || 0, c.messages.length);
    if (s.memory_enabled && c.memory?.trim() && cut) parts.push(`前 ${cut} 則已壓縮（不再送出原文）`);
    parts.push(!s.memory_enabled ? '注意：設定中已關閉記憶，不會放進提示詞'
      : s.memory_auto ? `自動壓縮：聊天紀錄超過可用空間的 ${s.compress_threshold ?? 70}% 時` : '自動壓縮：關閉');
    info.textContent = parts.join('｜');
  };
  ta.addEventListener('input', () => updInfo(chat));
  updInfo(chat);

  let busy = false;
  const aiBtn = (label, full) => h('button', { onclick: async e => {
    if (busy) return;
    if (full && !await askConfirm('要讓 AI 從第一則訊息開始，重新整理整段對話的記憶嗎？\n目前的記憶會被取代（會留一版，可以按「換回上一版」找回來）；對話很長時會分段處理，需要一些時間。')) return;
    busy = true; const b = e.currentTarget, old = [...b.childNodes];
    b.replaceChildren(icon('loader-circle', 'spin'), '整理中…'); b.disabled = true;
    try {
      // 先存下手動修改，AI 會以這份為基礎整理
      if (!full && ta.value !== (chat.memory || '')) await api('PUT', `/api/characters/${charId}/chats/${chatId}`, { memory: ta.value });
      const r = await api('POST', `/api/characters/${charId}/chats/${chatId}/memory`, { full });
      Object.assign(chat, r); ta.value = r.memory || '';
      if (state.chatId === chatId) { Object.assign(state.chat, { memory: r.memory, memory_upto: r.memory_upto, memory_updated: r.memory_updated }); renderHead(); }
      updInfo(chat); syncPrev(); toast('記憶已更新');
    } catch (err) { fail(err); }
    finally { busy = false; b.replaceChildren(...old); b.disabled = false; }
  } }, label);

  // 換回上一版：「全部重新整理」或手動儲存前的記憶（和目前的互換，再按一次就換回來）
  const prevBtn = h('button', { title: '', onclick: async () => {
    if (busy || !chat.memory_prev) return;
    if (!await askConfirm(`換回 ${fmtTime(chat.memory_prev.time)} 的記憶？\n目前的記憶會變成「上一版」，再按一次可以換回來。` + (ta.value !== (chat.memory || '') ? '\n這個視窗裡還沒儲存的修改會被捨棄。' : ''), { okText: '換回上一版' })) return;
    try {
      const r = await api('PUT', `/api/characters/${charId}/chats/${chatId}`, { memory_restore_prev: true });
      Object.assign(chat, r); ta.value = r.memory || '';
      if (state.chatId === chatId) { Object.assign(state.chat, { memory: r.memory, memory_upto: r.memory_upto, memory_cut: r.memory_cut, memory_updated: r.memory_updated, memory_prev: r.memory_prev }); renderHead(); }
      updInfo(chat); syncPrev(); toast('已換回上一版的記憶');
    } catch (err) { fail(err); }
  } }, ic('undo-2', '換回上一版'));
  const syncPrev = () => {
    prevBtn.disabled = !chat.memory_prev;
    prevBtn.title = chat.memory_prev ? `換回 ${fmtTime(chat.memory_prev.time)} 的記憶（全部重新整理或手動儲存之前的版本）` : '還沒有上一版：全部重新整理或手動儲存記憶後，才會留下上一版';
  };
  syncPrev();

  const body = h('div', { class: 'form' }, info,
    h('label', {}, h('span', {}, '記憶內容（可直接編輯）'), ta, tok),
    h('p', { class: 'muted small-note' }, '提示：「AI 整理新訊息」只會整理還沒整理過的訊息並合併進現有記憶；刪除或改寫了舊訊息時，可以用「全部重新整理」。全部重新整理或手動儲存時會留下上一版，可以按「換回上一版」找回來。'));
  openModal(`記憶：${chat.title}`, body, [
    h('div', { class: 'left' }, aiBtn(ic('bot', 'AI 整理新訊息'), false), aiBtn(ic('list-restart', '全部重新整理'), true), prevBtn),
    h('button', { 'data-close': true }, '取消'),
    h('button', { class: 'primary', onclick: async () => {
      try {
        const r = await api('PUT', `/api/characters/${charId}/chats/${chatId}`, { memory: ta.value });
        if (state.chatId === chatId) { Object.assign(state.chat, { memory: r.memory, memory_upto: r.memory_upto, memory_updated: r.memory_updated, memory_prev: r.memory_prev }); renderHead(); }
        closeModal(); toast('記憶已儲存');
      } catch (err) { fail(err); }
    } }, '儲存')], { dirty: () => ta.value !== (chat.memory || '') });
}
$('#chatTitle').onclick = () => inlineRename($('#chatTitle'), state.chat.title, t => renameChat(state.char.id, state.chatId, t));
async function deleteChat(ch) {
  const current = ch.id === state.chatId;
  if (current && state.generating && !await askConfirm('這段對話還在生成中，刪除會一併停止生成。要繼續嗎？')) return;
  if (!await askConfirm(`確定刪除「${ch.char.name}」的對話「${ch.title}」？\n對話內容與記憶會一起移到垃圾桶，${trashDaysText()}`)) return;
  try { await api('DELETE', `/api/characters/${ch.char.id}/chats/${ch.id}`); } catch (e) { return fail(e); }
  // 立刻從清單移除
  state.chats = state.chats.filter(x => !(x.id === ch.id && x.char.id === ch.char.id));
  if (lsGet(LAST_CHAT_KEY) === `${ch.char.id}/${ch.id}`) lsSet(LAST_CHAT_KEY, '');
  if (!current) return renderSide();
  // 刪掉的是目前開著的對話：改開最近的其他對話，沒有的話回首頁
  detachStream();
  const next = state.chats[0];
  if (next) go(`#/chat/${next.char.id}/${next.id}`);
  else { toast('已刪除對話'); go('#/'); }
}
async function refreshChatList() {
  state.chats = await api('GET', '/api/chats').catch(() => state.chats);
  if (!$('#chatView').hidden) renderSide();
}

$('#btnOpenSide').onclick = () => $('#sidebar').classList.add('open');
$('#btnCloseSide').onclick = () => $('#sidebar').classList.remove('open');

// ===================== 狀態欄面板 =====================
// 對話頁右側：圖片 → 角色狀態 → 使用者狀態（使用者狀態一律貼齊底部）。設計稿：docs/狀態欄設計稿.md
// 電腦版佔一欄，開關記在這台裝置（localStorage）；手機版（≤760px）從右邊滑出蓋在畫面上，每次進對話預設關閉
const STATUS_PANEL_KEY = 'tavern.statusPanel';
const narrowMq = matchMedia('(max-width: 760px)');
/** 這台裝置記住的開關（只有電腦版算數；手機版一律先關著） */
const statusPanelPref = () => !narrowMq.matches && lsGet(STATUS_PANEL_KEY) === '1';
function setStatusPanel(open, { remember = true } = {}) {
  const view = $('#chatView');
  // 使用者按的才滑動；進對話、視窗寬度跨過界線時直接切換（不然每次進對話面板都滑一次）
  // （先關掉過場、換好狀態、讀一次版面讓瀏覽器套用，再把過場打開；不靠畫格，視窗在背景時也不會卡住）
  if (!remember) view.classList.add('sp-no-anim');
  view.classList.toggle('sp-open', open);
  if (!remember) { void $('#statusPanel').offsetWidth; view.classList.remove('sp-no-anim'); }
  const btn = $('#btnStatusPanel');
  btn.classList.toggle('on', open);
  btn.setAttribute('aria-pressed', String(open));
  btn.title = open ? '收起狀態欄' : '狀態欄（顯示角色圖片與狀態）';
  if (remember && !narrowMq.matches) lsSet(STATUS_PANEL_KEY, open ? '1' : '0'); // 手機版的開關不影響電腦版記住的設定
}
$('#btnStatusPanel').onclick = () => setStatusPanel(!$('#chatView').classList.contains('sp-open'));
$('#btnSpExpand').onclick = () => setStatusPanel(true); // 訊息區右緣的「<<」
$('#btnSpCollapse').onclick = () => setStatusPanel(false); // 訊息區右緣的「>>」
$('#btnCloseStatus').onclick = () => setStatusPanel(false);
$('#spMask').onclick = () => setStatusPanel(false);
// 視窗寬度跨過手機版的界線：變窄時先關掉（不要突然蓋住畫面），變寬時回到記住的開關
narrowMq.addEventListener('change', () => setStatusPanel(statusPanelPref(), { remember: false }));

/** 面板裡的一行：「名稱：內容」（內容可換行） */
/** 欄位名稱：不到 4 個字時平均分散在 4 個字的寬度裡（心　　情：），冒號對齊；更長的照原本寬度往右推 */
const statusKey = name => h('span', { class: 'sp-key' }, h('span', { class: 'sp-kn' }, name));
const statusRow = (name, value) => h('div', { class: 'sp-row' }, statusKey(name), h('span', { class: 'sp-val' }, value ?? ''));
/** 狀態欄位定義：角色卡的 extensions.ai_tavern_status；大世界是世界卡的 status（所有成員共用角色欄位） */
function statusDefOf(ch) {
  const s = ch?.is_world ? ch.world?.status : ch?.data?.extensions?.ai_tavern_status;
  const ok = l => (Array.isArray(l) ? l.filter(f => f && f.key && f.name) : []);
  return { char: ok(s?.char_fields), user: ok(s?.user_fields) };
}
/** 這張卡（這個世界）有沒有用到狀態欄：有欄位或有表情圖（和伺服器的 ownerUsesStatus 相同） */
function usesStatus(ch) {
  const d = statusDefOf(ch);
  if (d.char.length || d.user.length) return true;
  return ch?.is_world ? worldMembers(ch).some(m => m.expressions.length) : (ch?.expressions || []).length > 0;
}
// ---------- 大世界 ----------
// 每則訊息的 swipe_status：{ chars: { 成員 id: {...} }, exprs: { 成員 id: 表情 }, user?, focus? }，只記那則寫到的角色
/** 世界的成員，整理成和角色卡一樣的樣子（頭像、表情圖、預設表情都用同一套函式） */
const worldMembers = ch => (ch?.world?.members || []).filter(m => !m.missing).map(m => ({
  id: m.id, name: m.name, has_cover: m.has_cover, has_avatar: m.has_avatar, img_ver: m.img_ver, expressions: m.expressions || [],
  data: { name: m.name, extensions: { ai_tavern_expressions: { default: m.expr_default || null } } } }));
/** 大世界的目前狀態：每個角色、表情、玩家狀態各自往回找最近的一份（upto：只看前 upto 則） */
function worldStatus(msgs, upto = msgs?.length || 0) {
  const out = { chars: {}, exprs: {}, user: null };
  for (let i = Math.min(upto, msgs?.length || 0) - 1; i >= 0; i--) {
    const m = msgs[i];
    const s = m?.role === 'assistant' && Array.isArray(m.swipe_status) ? m.swipe_status[m.swipe_id || 0] : null;
    if (!s || typeof s !== 'object') continue;
    for (const [id, v] of Object.entries(s.chars || {})) if (!(id in out.chars)) out.chars[id] = v;
    for (const [id, v] of Object.entries(s.exprs || {})) if (!(id in out.exprs)) out.exprs[id] = v;
    if (!out.user && s.user) out.user = s.user;
  }
  return out;
}
/** 最後發言的角色：輪流發言看訊息的發言者（旁白發言時沿用上一位），旁白統一模式看狀態記下的 focus（表情區塊最後一個角色） */
function lastSpeaker(msgs, ids) {
  for (let i = (msgs?.length || 0) - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role !== 'assistant') continue;
    if (ids.has(m.speaker)) return m.speaker;
    if (m.speaker) continue; // 旁白
    const s = Array.isArray(m.swipe_status) ? m.swipe_status[m.swipe_id || 0] : null;
    if (s?.focus && ids.has(s.focus)) return s.focus;
  }
  return null;
}
/** 這一輪（你最後一則訊息之後）狀態或表情有變動的角色 */
function changedThisRound(msgs) {
  const u = msgs.findLastIndex(m => m.role === 'user');
  if (u < 0) return new Set();
  const a = worldStatus(msgs, u), b = worldStatus(msgs);
  const ids = new Set([...Object.keys(b.chars), ...Object.keys(b.exprs)]);
  return new Set([...ids].filter(id => JSON.stringify(a.chars[id] ?? null) !== JSON.stringify(b.chars[id] ?? null) || (a.exprs[id] ?? null) !== (b.exprs[id] ?? null)));
}
/**
 * 面板上的大世界角色：在場的（輪流發言記錄了誰在場時），沒有紀錄就是全部成員。
 * 選到的角色：state.spMember；最後發言的角色換人時自動切過去（角色發言時面板跟著換）
 */
function worldPanelPick(ch) {
  const all = worldMembers(ch);
  if (!all.length) return null;
  const msgs = state.chat.messages;
  const present = Array.isArray(state.chat.present) ? all.filter(m => state.chat.present.includes(m.id)) : [];
  const list = present.length ? present : all;
  const ids = new Set(all.map(m => m.id));
  const focus = lastSpeaker(msgs, ids);
  const sp = state.spWorld?.chat === state.chatId ? state.spWorld : (state.spWorld = { chat: state.chatId, focus, member: null, seen: new Map() });
  if (sp.focus !== focus) { sp.focus = focus; if (focus) sp.member = focus; }
  if (!list.some(m => m.id === sp.member)) sp.member = list.some(m => m.id === focus) ? focus : list[0].id;
  // 看過了：記下看的時候那個角色的狀態；之後又變了就再亮起來
  const cur = worldStatus(msgs);
  const sigOf = id => JSON.stringify([cur.chars[id] ?? null, cur.exprs[id] ?? null]);
  sp.seen.set(sp.member, sigOf(sp.member)); // 正在看的角色不用再提醒
  const changed = changedThisRound(msgs);
  return { list, member: all.find(m => m.id === sp.member), lit: new Set([...changed].filter(id => sp.seen.get(id) !== sigOf(id))) };
}
function selectPanelMember(id) {
  if (!state.spWorld || state.spWorld.member === id) return;
  state.spWorld.member = id;
  if (state.spEdit) state.spEdit = null; // 換角色：放棄編輯到一半的內容
  renderStatusPanel();
}
/** 頭像切換列：選到的外框亮起，這一輪有變動、還沒看過的右上角亮一個點 */
function renderMemberStrip(pick) {
  const box = $('#spMembers');
  box.hidden = !pick;
  if (!pick) { box.replaceChildren(); box.dataset.sig = ''; return; }
  const sig = JSON.stringify([pick.list.map(m => [m.id, m.name, m.img_ver]), pick.member.id, [...pick.lit]]);
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.replaceChildren(...pick.list.map(m => {
    const on = m.id === pick.member.id, lit = pick.lit.has(m.id);
    const b = h('button', { type: 'button', class: 'sp-mem' + (on ? ' on' : '') + (lit ? ' lit' : ''), role: 'tab', 'aria-selected': String(on),
      title: m.name + (lit ? '（這一輪狀態有變動）' : ''), onclick: () => selectPanelMember(m.id) }, avatarEl(m, 'm-av'));
    return b;
  }));
  // 選到的頭像捲進看得到的範圍（只捲這一列，不動整個頁面）
  const on = $('.sp-mem.on', box);
  if (on) {
    const r = on.getBoundingClientRect(), br = box.getBoundingClientRect();
    if (r.left < br.left) box.scrollLeft -= br.left - r.left + 8;
    else if (r.right > br.right) box.scrollLeft += r.right - br.right + 8;
  }
}
/**
 * 目前狀態：從最新的訊息往回找，第一則「目前顯示的版本有狀態」的 assistant 訊息。
 * 切換版本、刪除訊息、回溯時自動回到當時的狀態。都沒有（舊對話）時回傳 null
 */
function currentStatus(msgs) {
  for (let i = (msgs?.length || 0) - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role !== 'assistant' || !Array.isArray(m.swipe_status)) continue;
    const s = m.swipe_status[m.swipe_id || 0];
    if (s && typeof s === 'object') return s;
  }
  return null;
}
/** 一個欄位的顯示：數值有最大值時畫進度條＋「80/100」；沒有值顯示「—」 */
function statusFieldRow(f, raw) {
  const v = raw == null ? '' : String(raw).trim();
  if (!v) return h('div', { class: 'sp-row' }, statusKey(f.name), h('span', { class: 'sp-val sp-none' }, '—'));
  const n = Number(v), max = Number(f.max);
  if (f.type === 'number' && max > 0 && Number.isFinite(n)) {
    const pct = Math.max(0, Math.min(100, (n / max) * 100));
    return h('div', { class: 'sp-row sp-num', title: `${f.name}：${v}/${max}` },
      statusKey(f.name), h('span', { class: 'sp-val' }, `${v}/${max}`),
      h('div', { class: 'sp-bar' }, h('i', { style: `width:${pct}%` })));
  }
  return statusRow(f.name, v);
}
/**
 * 填一區（角色狀態／玩家狀態）。兩區都沒有欄位：兩區都不顯示（只有圖片）；
 * 只有一區有欄位：另一區留著空位（sp-blank），玩家狀態永遠從同一個位置開始
 */
function fillStatusSection(sec, title, rows, otherHas = false, actions = []) {
  sec.hidden = !rows.length && !otherHas;
  sec.classList.toggle('sp-blank', !rows.length);
  $('.sp-sec-name', sec).textContent = title;
  const head = $('.sp-sec-head', sec);
  head.querySelector('.sp-acts')?.remove();
  if (actions.length) head.append(h('div', { class: 'sp-acts' }, actions));
  $('.sp-sec-body', sec).replaceChildren(...rows);
}

// ---------- 面板上手動編輯狀態（按區塊標題的「編輯」；生成中不能改） ----------
// state.spEdit = { chat, char, side: 'char'|'user', draft: { key: 值 } }：正在編輯的那一區（換對話就取消）
/** 編輯中的一列：名稱＋輸入框（數值有最大值時限制 0～最大值）；Enter 儲存、Esc 取消 */
function statusEditRow(f, ed) {
  const num = f.type === 'number';
  const input = h('input', { type: num ? 'number' : 'text', value: ed.draft[f.key] ?? '', 'aria-label': f.name,
    ...(num ? { step: 'any', ...(f.max ? { min: 0, max: f.max } : {}) } : { maxlength: 200 }) });
  input.oninput = () => { ed.draft[f.key] = input.value; };
  input.onkeydown = e => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); saveStatusEdit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelStatusEdit(); }
  };
  return h('label', { class: 'sp-row sp-edit-row' }, statusKey(f.name), input, f.max ? h('span', { class: 'sp-max' }, '/' + f.max) : null);
}
function startStatusEdit(side, def, valOf) {
  if (state.generating) return;
  const fields = side === 'char' ? def.char : def.user;
  state.spEdit = { chat: state.chatId, char: state.char.id, member: state.char.is_world ? state.spWorld?.member ?? null : null, side, draft: Object.fromEntries(fields.map(f => [f.key, String(valOf(side, f) ?? '')])) };
  renderStatusPanel();
  $(`#${side === 'char' ? 'spChar' : 'spUser'} .sp-edit-row input`)?.focus();
}
function cancelStatusEdit() { state.spEdit = null; renderStatusPanel(); }
async function saveStatusEdit() {
  const ed = state.spEdit;
  if (!ed || ed.saving || state.generating) return;
  const def = statusDefOf(state.char);
  // 先在畫面上檢查一次（伺服器也會檢查）：數值要是數字、在範圍內
  for (const f of ed.side === 'char' ? def.char : def.user) {
    const v = String(ed.draft[f.key] ?? '').trim();
    if (f.type !== 'number' || !v) continue;
    if (!/^-?\d+(\.\d+)?$/.test(v)) return toast(`「${f.name}」要是數字`, true);
    if (f.max && (Number(v) < 0 || Number(v) > f.max)) return toast(`「${f.name}」要在 0～${f.max} 之間`, true);
  }
  const charId = state.char.id, chatId = state.chatId;
  ed.saving = true; renderStatusPanel();
  try {
    const r = await api('PUT', `/api/characters/${charId}/chats/${chatId}/status`, { [ed.side]: ed.draft, base_ver: state.chat.msg_ver, ...(ed.member ? { member: ed.member } : {}) });
    if (state.chatId !== chatId) return;
    // 只換狀態與訊息版本（不整份換掉 state.chat：畫面上的訊息還握著原本的物件）
    r.messages.forEach((m, i) => { const cur = state.chat.messages[i]; if (cur && m.swipe_status) cur.swipe_status = m.swipe_status; });
    state.chat.msg_ver = r.msg_ver; state.spEdit = null;
    renderStatusPanel();
    toast('狀態已更新');
  } catch (e) {
    fail(e);
    if (state.spEdit === ed) { ed.saving = false; renderStatusPanel(); }
    // 其他視窗改過這段對話：重新讀取（和存訊息時一樣）
    if (e.status === 409 && state.chatId === chatId) {
      try { state.chat = await api('GET', `/api/characters/${charId}/chats/${chatId}`); renderMessages(); } catch { /* 讀不到就維持原樣 */ }
    }
  }
}
function renderStatusPanel() {
  const ch = state.char;
  $('#btnStatusPanel').hidden = !state.chat; // 沒有選對話時不顯示開關
  if (!ch || !state.chat) return;
  // 圖片的順序（設計稿第七節）：目前狀態的表情 → 預設表情 → 封面 → 頭像 → 名字的首字。
  // 網址帶版本（表情圖的修改時間、img_ver），換圖後不會讀到快取；網址沒變就不重畫，避免更新標題、記憶時圖片閃一下
  // 大世界：圖片與「角色的狀態」顯示選到的那位角色（頭像列切換），玩家的狀態只有一份
  const pick = ch.is_world ? worldPanelPick(ch) : null;
  $('#chatView').classList.toggle('sp-world', !!pick);
  renderMemberStrip(pick);
  const who = pick ? pick.member : ch; // 圖片、角色區的標題用誰
  const wst = ch.is_world ? worldStatus(state.chat.messages) : null;
  // 目前狀態（和角色卡同樣的樣子：{ char, user, expression }）
  const st = ch.is_world ? (pick ? { char: wst.chars[who.id], user: wst.user, expression: wst.exprs[who.id] } : { user: wst.user }) : currentStatus(state.chat.messages);
  const ex = ch.is_world && !pick ? null : findExpr(who, st?.expression) || findExpr(who, defaultExpr(who));
  const box = $('#spImg'), key = `${who.id}|${ex ? exprUrl(who.id, ex) : hasImg(who) ? imgUrl(who, who.has_cover ? 'cover' : 'avatar') : ''}|${charName(who)}`;
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    // 沒有成員的世界：顯示世界的封面（橫的）。第二個參數一定要是 true／false：
    // 一般角色的 is_world 是 undefined，toggle 收到 undefined 會當成沒給、變成來回切換，每換一張表情圖框就在 3:4 和 16:9 之間跳
    box.classList.toggle('wide', !!(ch.is_world && !pick));
    // replaceChildren 會把 null 變成「null」文字：沒有的項目先濾掉
    box.replaceChildren(...[ex
      ? zoomable(h('img', { class: 'sp-pic', src: exprUrl(who.id, ex), alt: exprLabel(ex.name) }))
      : zoomable(coverEl(who, 'sp-pic')),
      ex ? h('span', { class: 'sp-expr', title: '目前的表情' }, exprLabel(ex.name)) : null].filter(Boolean));
  }
  // 狀態欄位：卡片（世界卡）定義的欄位＋目前狀態的值；還沒有任何狀態（舊對話）時顯示欄位的初始值
  // 欄位定義被刪掉的值不顯示；內容沒變就不重畫（串流時每次更新訊息都會走到這裡）
  const def = statusDefOf(ch);
  if (ch.is_world && !pick) def.char = []; // 沒有成員：只有玩家的狀態
  // 這份狀態裡沒有的欄位（例如對話開始後才新增的欄位）也用初始值
  const valOf = (side, f) => (st?.[side] && Object.hasOwn(st[side], f.key) ? st[side][f.key] : f.initial);
  // 編輯中的那一區：換了對話、角色（大世界換了選到的角色）就取消
  const memberId = pick ? who.id : null;
  if (state.spEdit && (state.spEdit.chat !== state.chatId || state.spEdit.char !== ch.id || state.spEdit.member !== memberId)) state.spEdit = null;
  const ed = state.spEdit;
  const sig = JSON.stringify([def, def.char.map(f => valOf('char', f)), def.user.map(f => valOf('user', f)), charName(who), memberId, userName(),
    ed ? [ed.side, !!ed.saving] : null, !!state.generating]);
  const panel = $('#statusPanel');
  if (panel.dataset.sig === sig) return;
  panel.dataset.sig = sig;
  // 有變動的欄位短暫高亮，數值顯示變化量（+5）：和上一次畫的比（同一段對話、同一位角色才比，剛打開對話時不標）
  // 大世界每次都記下所有角色的值：角色發言完自動切過去時，和他上一次的值比
  const now = { char: {}, user: {} };
  const lastOf = state.spLast?.chat === state.chatId && state.spLast?.char === ch.id ? state.spLast : null;
  const last = lastOf ? (pick ? { char: lastOf.members?.[memberId], user: lastOf.vals?.user } : lastOf.vals) : null;
  const row = side => f => {
    const v = valOf(side, f);
    now[side][f.key] = v;
    const el = statusFieldRow(f, v);
    const old = last?.[side]?.[f.key];
    if (last && old !== undefined && String(old ?? '') !== String(v ?? '')) markChanged(el, f, old, v);
    return el;
  };
  // 區塊標題右邊的按鈕：平常是「編輯」（生成中停用）；編輯中是「取消」「儲存」
  const acts = side => {
    if (ed?.side === side) return [
      h('button', { type: 'button', class: 'small', disabled: !!ed.saving, onclick: cancelStatusEdit }, '取消'),
      h('button', { type: 'button', class: 'small primary', disabled: !!ed.saving || !!state.generating, title: state.generating ? '生成中不能修改狀態' : '', onclick: saveStatusEdit }, ed.saving ? '儲存中…' : '儲存')];
    return [h('button', { type: 'button', class: 'small sp-edit-btn', disabled: !!state.generating, title: state.generating ? '生成中不能修改狀態' : '手動修改這一區的狀態',
      onclick: () => startStatusEdit(side, def, valOf) }, ic('pencil', '編輯'))];
  };
  const rowsOf = (side, fields) => {
    if (ed?.side === side) { for (const f of fields) now[side][f.key] = valOf(side, f); return fields.map(f => statusEditRow(f, ed)); }
    return fields.map(row(side));
  };
  fillStatusSection($('#spChar'), charName(who), rowsOf('char', def.char), def.user.length > 0, def.char.length ? acts('char') : []);
  fillStatusSection($('#spUser'), userName(), rowsOf('user', def.user), def.char.length > 0, def.user.length ? acts('user') : []);
  let members;
  if (pick) {
    members = {};
    for (const m of worldMembers(ch)) {
      const c = wst.chars[m.id];
      members[m.id] = Object.fromEntries(def.char.map(f => [f.key, c && Object.hasOwn(c, f.key) ? c[f.key] : f.initial]));
    }
  }
  state.spLast = { chat: state.chatId, char: ch.id, vals: now, members };
}
/** 這次有變動的欄位：高亮一下；數值欄位在旁邊顯示變化量（動畫關閉時直接顯示，不閃） */
function markChanged(el, f, oldV, newV) {
  el.classList.add('sp-changed');
  const a = Number(oldV), b = Number(newV);
  if (f.type !== 'number' || !String(oldV ?? '').trim() || !Number.isFinite(a) || !Number.isFinite(b) || a === b) return;
  const d = Math.round((b - a) * 100) / 100;
  $('.sp-val', el).append(h('span', { class: 'sp-delta ' + (d > 0 ? 'up' : 'down') }, (d > 0 ? '+' : '') + d)); // 接在數值後面：35/100 +5
}

/**
 * 把畫面上的訊息存回伺服器。被拒絕時（例如這段對話正在背景或另一個視窗生成，409）
 * 重新讀取伺服器上的內容並重畫，畫面不會停在「看起來改好了、其實沒存到」的樣子。回傳是否成功
 */
/** 存訊息與名稱；extra：同一次一起存的欄位（例如記憶進度），避免分兩次存、第二次失敗時資料對不上 */
/** 只存一則訊息（編輯、切換版本）：不用把整段對話送給伺服器。失敗時和 saveChat 一樣重新讀取 */
async function saveMessage(i) {
  if (!state.chat) return false;
  const charId = state.char.id, chatId = state.chatId;
  try {
    const r = await api('PUT', `/api/characters/${charId}/chats/${chatId}/messages/${i}`, { message: state.chat.messages[i], base_ver: state.chat.msg_ver });
    if (state.chatId === chatId && state.chat) {
      state.chat.msg_ver = r.msg_ver;
      if (r.memory_stale) state.chat.memory_stale = true;
    }
    return r; // 成功時回傳伺服器的回應（memory_stale：改到已經整理進記憶的內容）
  } catch (e) {
    fail(e);
    if (state.chatId === chatId) {
      try { state.chat = await api('GET', `/api/characters/${charId}/chats/${chatId}`); renderMessages(); } catch { /* 讀不到就維持原樣 */ }
    }
    return false;
  }
}
async function saveChat(extra = {}) {
  if (!state.chat) return false;
  const charId = state.char.id, chatId = state.chatId;
  try {
    // 不帶名稱：改名另外存（renameChat），免得把別的視窗改好的名稱蓋回舊的。
    // base_ver：這個畫面讀到的訊息版本；另一個視窗改過訊息（例如剛產生新訊息）時伺服器會拒絕，不會把它蓋掉
    const r = await api('PUT', `/api/characters/${charId}/chats/${chatId}`, { messages: state.chat.messages, base_ver: state.chat.msg_ver, ...extra });
    if (state.chatId === chatId && state.chat) for (const k of ['memory', 'memory_upto', 'memory_cut', 'present', 'msg_ver', 'deleted']) { if (k in r) state.chat[k] = r[k]; else delete state.chat[k]; }
    return r; // 成功時回傳伺服器的回應（memory_updating：背景正在重新整理記憶）
  } catch (e) {
    fail(e);
    if (state.chatId === chatId) {
      try { state.chat = await api('GET', `/api/characters/${charId}/chats/${chatId}`); renderMessages(); } catch { /* 讀不到就維持原樣 */ }
    }
    return false;
  }
}

// ---------- 訊息列表：長對話只先畫最近幾則（設定 → 外觀 → 對話頁），往上捲再載入更早的 ----------
const RENDER_BATCH = 100; // 打開對話先畫的則數；按「載入更早的訊息」一次補的則數
const FILL_BATCH = 40; // 背景分批補畫時每批的則數（小一點，每批只佔用主執行緒幾十毫秒）
const renderLimit = () => { const n = Number(state.settings?.chat_render ?? 100); return n > 0 ? n : 0; };
const later = f => setTimeout(f, 0); // 每批之間讓出主執行緒：捲動、打字照常反應

function renderMessages() {
  const box = $('#messages');
  if (!state.chat) { box.innerHTML = ''; return; }
  const msgs = state.chat.messages;
  if (state.renderChat !== state.chat.id) {
    // 換了一段對話：先畫最近的 100 則（打開很快），再分批補到設定的則數（renderTarget），避免一次畫太多而卡住
    state.renderChat = state.chat.id;
    const lim = renderLimit();
    state.renderTarget = lim ? Math.max(0, msgs.length - lim) : 0;
    state.renderFrom = Math.max(state.renderTarget, msgs.length - RENDER_BATCH);
    if (state.renderFrom > state.renderTarget) fillEarlierGradually();
  }
  state.renderFrom = Math.max(0, Math.min(state.renderFrom || 0, msgs.length - 1));
  const frag = document.createDocumentFragment();
  for (let i = state.renderFrom; i < msgs.length; i++) if (msgs[i]) frag.append(...deletedAt(i), renderMessage(msgs[i], i));
  frag.append(...deletedAt(msgs.length, true)); // 刪掉的是最後幾則：框放在最後面
  box.innerHTML = '';
  box.append(earlierBar(), frag);
  if (!msgs.length) box.append(h('div', { class: 'empty muted' }, '這個角色沒有開場白，直接開始聊天吧。'));
  box.scrollTop = box.scrollHeight;
  $('#btnContinue').disabled = state.generating || msgs.at(-1)?.role !== 'assistant';
  renderHead();
}
/** 最上方的「載入更早的訊息」 */
function earlierBar() {
  const n = state.renderFrom || 0;
  return h('div', { class: 'load-earlier', id: 'loadEarlier', hidden: !n },
    h('button', { class: 'small', onclick: () => prependEarlier(RENDER_BATCH) }, `載入更早的訊息（還有 ${n} 則）`),
    h('button', { class: 'small', onclick: () => { state.renderTarget = 0; fillEarlierGradually(); } }, '全部載入'));
}
/** 在最上面補畫 count 則更早的訊息，畫面停在原本看的位置 */
function prependEarlier(count) {
  const box = $('#messages'), msgs = state.chat?.messages;
  if (!msgs || !(state.renderFrom > 0)) return;
  const from = Math.max(0, state.renderFrom - count);
  state.renderTarget = Math.min(state.renderTarget ?? from, from); // 使用者往上捲：目標跟著往前
  const frag = document.createDocumentFragment();
  for (let i = from; i < state.renderFrom; i++) if (msgs[i]) frag.append(...deletedAt(i), renderMessage(msgs[i], i));
  const oldH = box.scrollHeight, oldTop = box.scrollTop;
  // 補在最上面一則（和它前面的「訊息已刪除」框）之前
  const first = box.querySelector(':scope > .msg');
  let anchor = first;
  while (anchor?.previousElementSibling?.classList.contains('del-ph')) anchor = anchor.previousElementSibling;
  anchor?.before(frag);
  state.renderFrom = from;
  $('#loadEarlier')?.replaceWith(earlierBar());
  box.scrollTop = oldTop + (box.scrollHeight - oldH);
}
/** 分批往前補畫到 renderTarget（每批之間讓瀏覽器喘口氣，捲動與輸入不會卡住） */
function fillEarlierGradually() {
  const chatId = state.renderChat;
  const step = () => {
    if (state.renderChat !== chatId || !(state.renderFrom > (state.renderTarget || 0)) || $('#chatView').hidden) return;
    prependEarlier(Math.min(FILL_BATCH, state.renderFrom - (state.renderTarget || 0)));
    later(step);
  };
  later(step);
}
// 捲到最上面時自動載入更早的訊息
$('#messages').addEventListener('scroll', e => { if (e.target.scrollTop < 80 && state.renderFrom > 0) prependEarlier(RENDER_BATCH); }, { passive: true });
/** 捲到第 i 則並閃一下（搜尋結果用）；還沒畫出來就先往前補畫 */
function jumpToMessage(i) {
  if (!state.chat?.messages[i]) return;
  if (i < state.renderFrom) prependEarlier(state.renderFrom - Math.max(0, i - 5));
  const el = $(`#messages .msg[data-i="${i}"]`);
  if (!el) return;
  // 畫面外的訊息高度是估計值，捲過去後附近的訊息排版完成、高度會變：連續對準幾次直到位置穩定
  let tries = 0, lastTop = null;
  const align = () => {
    el.scrollIntoView({ block: 'center' });
    const top = el.getBoundingClientRect().top;
    if (top !== lastTop && ++tries < 8) { lastTop = top; setTimeout(align, 40); }
  };
  align();
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}
/**
 * 只重繪第 i 則與前一則（「最後一則」才有的按鈕會換位置），不必整個對話重畫；
 * 畫面上的訊息數量對不上時（例如有訊息被移除）就整個重繪。
 */
function renderMessageAt(i) {
  const box = $('#messages'), msgs = state.chat.messages;
  const shown = box.querySelectorAll(':scope > .msg').length;
  const expect = msgs.length - (state.renderFrom || 0);
  if (i < (state.renderFrom || 0)) return; // 還沒畫出來的舊訊息
  if (shown !== expect && !(shown === expect - 1 && i === msgs.length - 1)) return renderMessages();
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 200;
  box.querySelector(':scope > .empty')?.remove();
  for (const j of [i - 1, i]) {
    if (j < (state.renderFrom || 0) || j >= msgs.length) continue;
    const fresh = renderMessage(msgs[j], j);
    const el = box.querySelector(`:scope > .msg[data-i="${j}"]`);
    if (el) el.replaceWith(fresh); else box.append(fresh);
  }
  if (nearBottom) box.scrollTop = box.scrollHeight;
  $('#btnContinue').disabled = state.generating || msgs.at(-1)?.role !== 'assistant';
  renderHead();
}

/** 大世界中這則訊息的發言者：角色成員、旁白，或（舊的一次寫全部的訊息）世界本身 */
function speakerOf(m) {
  const c = state.char;
  if (!m.speaker) return null;
  if (m.speaker === 'narrator') return { narrator: true, name: '旁白' }; // 角色卡的開場白也可以有旁白
  if (!c?.is_world) return null;
  const mem = c.world.members.find(x => x.id === m.speaker);
  return mem && !mem.missing ? { member: mem, name: mem.name } : { name: '（已離開的角色）' };
}
function renderMessage(m, i) {
  const isUser = m.role === 'user';
  const c = state.char;
  const sp = isUser ? null : speakerOf(m);
  // 你扮演的 NPC、你寫的旁白：資料上是你的訊息，畫面上用旁白的外觀
  const asOther = isUser && (m.npc || m.narration);
  const name = asOther ? (m.npc || '旁白') : isUser ? userName() : sp ? sp.name : c.data.name;
  const msgs = state.chat.messages;
  const isLast = i === msgs.length - 1;
  const { think, vis } = splitThink(m.content);
  const allThink = [m.reasoning, think].filter(Boolean).join('\n').trim();
  const text = h('div', { class: 'mtext', html: formatText(vis) });

  // 名稱與時間放在對話框上方
  const head = h('div', { class: 'mhead' }, h('span', { class: 'mname' }, name),
    asOther ? h('span', { class: 'npc-tag', title: '這則是你寫的（不會被重新生成）' }, m.npc ? 'NPC・你扮演' : '你寫的') : null,
    h('span', { class: 'mtime' }, m.time ? new Date(m.time).toLocaleString('zh-TW', { hour12: false }) : ''));
  const body = h('div', { class: 'mbody' },
    allThink && !isUser ? thinkBox(allThink) : null,
    text);

  // 對話框下方的操作列
  // 生成中整列停用由 #messages.busy 的樣式處理（不必為了按鈕狀態重畫整段對話）
  const btn = (label, title, fn, disabled) => h('button', { title, disabled, onclick: fn }, label);
  const actions = h('div', { class: 'mactions' });
  // 左下角：回應耗時（滑鼠移上去看毫秒）
  if (!isUser && m.timing?.total >= 0) actions.append(h('span', { class: 'mtiming', title: timingTitle(m.timing) }, icon('timer'), fmtSec(m.timing.total)));
  if (isLast && !isUser) {
    const n = m.swipes?.length || 1, cur = (m.swipe_id || 0) + 1;
    if (n > 1) actions.append(btn(icon('chevron-left'), '上一個版本', () => swipe(i, -1), cur <= 1), h('span', { class: 'swipe-n' }, `${cur}/${n}`), btn(icon('chevron-right'), cur < n ? '下一個版本' : '生成新版本', () => swipe(i, 1)));
    actions.append(btn(ic('refresh-cw', '重新生成'), '重新生成這則回應（保留舊版本，可左右切換）', () => generate('regenerate')), h('span', { class: 'sep' }));
  } else if (isLast && isUser) {
    actions.append(btn(ic('refresh-cw', '生成回應'), '讓角色回應這則訊息', () => generate('normal')), h('span', { class: 'sep' }));
  } else if (!isUser) {
    // 較舊的 AI 回應也可以重新生成：之後的訊息存成分支，或直接刪掉
    actions.append(btn(ic('refresh-cw', '重新生成'), '從這則重新生成（之後的訊息可以先存成分支）', () => regenerateFrom(i)), h('span', { class: 'sep' }));
  }
  // 編輯過的訊息：編輯按鈕左邊可以切換最初版與最後送出的版本
  const ed = editOf(m);
  if (ed) actions.append(ed.orig
    ? btn(ic('redo-2', '最新版'), '目前顯示的是最初的版本；換回最後編輯的版本', () => toggleEdited(i))
    : btn(ic('undo-2', '還原'), '換回最初的版本（再按一次回到編輯後的版本）', () => toggleEdited(i)));
  actions.append(
    btn(ic('pencil', '編輯'), '編輯這則訊息', () => editMessage(i)),
    btn(ic('copy', '複製'), '複製內容', () => navigator.clipboard.writeText(m.content).then(() => toast('已複製'))),
    btn(ic('git-branch', '分支'), '從這則訊息分支成新對話', () => branchFrom(i)),
    btn(ic('trash-2', '刪除'), '刪除訊息', () => deleteMessage(i)));

  let av;
  if (asOther) {
    av = h('div', { class: 'avatar-ph mav narrator-av', title: m.npc ? `${m.npc}（你扮演的 NPC）` : '你寫的旁白' }, icon(m.npc ? 'user' : 'book-open'));
  } else if (isUser) {
    av = userAvatarEl('mav');
    av.title = '更換頭像：設定 → 使用者';
    av.onclick = () => { state.settingsTab = 'user'; go('#/settings'); };
  } else if (sp?.member) {
    // 大世界：每個角色用自己的頭像與對話框
    av = avatarEl(sp.member, 'mav');
    av.title = `查看 ${sp.name} 的介紹`;
    av.onclick = () => openCharDetail(sp.member.id).catch(fail);
  } else {
    av = sp?.narrator ? h('div', { class: 'avatar-ph mav narrator-av' }, icon('book-open')) : avatarEl(c, 'mav');
    av.title = c.is_world ? '查看世界介紹' : '查看角色介紹';
    av.onclick = () => (c.is_world ? openWorldDetail(c.world.id) : openCharDetail(c.id)).catch(fail);
  }
  return h('div', { class: 'msg ' + (isUser && !asOther ? 'user' : 'bot') + (sp?.narrator || asOther ? ' narrator' : '') + (asOther ? ' npc-line' : '') + (isLast ? ' last' : ''), 'data-i': i }, av, h('div', { class: 'mcol' }, head, body, actions));
}

/**
 * 編輯紀錄：只留「最初版」和「最後送出的版本」，中間改過的過程不留。每個版本（swipe）各自一份：m.edits[版本編號]。
 * { other: 目前沒顯示的那一版, orig: true＝目前顯示的是最初版 }；content 一律是目前顯示的那一版（送給 AI 的就是它）
 */
const editOf = m => { const e = m.edits?.[m.swipe_id || 0]; return e && typeof e.other === 'string' ? e : null; };
function setEdited(m, text) {
  const k = m.swipe_id || 0, e = editOf(m);
  const original = e ? (e.orig ? m.content : e.other) : m.content;
  m.edits = { ...(m.edits || {}) };
  if (text === original) delete m.edits[k]; // 改回和最初版一樣：當成沒改過
  else m.edits[k] = { other: original };
  if (!Object.keys(m.edits).length) delete m.edits;
}
/**
 * 已經整理進記憶的訊息改了內容：編輯當下只提醒，記憶先不動；
 * 開著自動整理時，下次送出、產生新的回應之後才在背景從頭重新整理（伺服器的 memory_stale）
 */
function memoryNoteForEdit(r) {
  if (!r?.memory_stale) return;
  toast(r.memory_later
    ? '這則已經整理進記憶，記憶裡暫時還是原本的內容。下次送出、產生新的回應後，會自動重新整理記憶。'
    : '這則已經整理進記憶，記憶裡還是原本的內容。需要時可以在「對話設定 → 記憶」按「全部重新整理」。', false, 8000);
}
/** 編輯過的訊息：在最初版與最後送出的版本之間切換 */
async function toggleEdited(i) {
  if (state.generating) return;
  const m = state.chat.messages[i], e = editOf(m);
  if (!e) return;
  const k = m.swipe_id || 0, shown = m.content;
  m.content = e.other;
  if (m.swipes) m.swipes[k] = e.other;
  m.edits = { ...m.edits, [k]: e.orig ? { other: shown } : { other: shown, orig: true } };
  const r = await saveMessage(i);
  if (r) { renderMessages(); memoryNoteForEdit(r); }
}
function editMessage(i) {
  if (state.generating) return;
  const m = state.chat.messages[i];
  const el = $(`#messages .msg[data-i="${i}"]`);
  const textEl = $('.mtext', el);
  $('.mactions', el).hidden = true;
  const before = m.content;
  const ta = h('textarea', { class: 'edit', value: m.content });
  // 你這一側的訊息：可以改成用哪個身分說的（你的角色／你寫的旁白／你扮演的 NPC）
  const who = m.role === 'user' ? h('select', { class: 'as-who', title: '這則是用誰的身分說的' },
    h('option', { value: '' }, `我（${userName()}）`), h('option', { value: 'narration' }, '旁白（我自己寫）'),
    (state.chat.npcs || []).map(n => h('option', { value: 'npc:' + n }, `NPC：${n}`))) : null;
  if (who) {
    if (m.npc && !(state.chat.npcs || []).includes(m.npc)) who.append(h('option', { value: 'npc:' + m.npc }, `NPC：${m.npc}`));
    who.value = m.npc ? 'npc:' + m.npc : m.narration ? 'narration' : '';
  }
  const done = async save => {
    if (save) {
      if (ta.value !== m.content) setEdited(m, ta.value);
      m.content = ta.value;
      if (m.swipes) m.swipes[m.swipe_id || 0] = ta.value;
      if (who) {
        delete m.npc; delete m.narration;
        if (who.value.startsWith('npc:')) m.npc = who.value.slice(4); else if (who.value === 'narration') m.narration = true;
      }
      const changed = ta.value !== before;
      const r = await saveMessage(i);
      if (r && changed) memoryNoteForEdit(r);
    }
    renderMessages();
  };
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) done(true);
    else if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); done(false); } // Esc：取消編輯
  });
  textEl.replaceWith(h('div', {}, ta, h('div', { class: 'edit-actions' },
    who,
    h('span', { class: 'muted' }, 'Esc 取消｜Ctrl+Enter 儲存'),
    h('button', { onclick: () => done(false) }, '取消'),
    h('button', { class: 'primary', onclick: () => done(true) }, '儲存'))));
  ta.focus(); ta.style.height = Math.min(ta.scrollHeight + 10, 500) + 'px';
}
/**
 * 「訊息已刪除」的框（伺服器存在 chat.deleted，不是訊息：不會送給 AI、不會匯出）。
 * 第 i 則訊息前面的框；atEnd：位置在 i 以後的全部（刪掉的是最後幾則，放在最後面）
 */
function deletedAt(i, atEnd = false) {
  const list = (state.chat?.deleted || []).filter(d => (atEnd ? d.i >= i : d.i === i));
  return list.map(d => {
    const n = d.msgs?.length || 0;
    const first = d.msgs?.[0];
    const peek = first ? String(splitThink(first.content || '').vis).replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    return h('div', { class: 'del-ph', 'data-del': d.id, title: `刪除於 ${fmtTime(d.time)}${peek ? '\n' + peek + (n > 1 ? `…（共 ${n} 則）` : '') : ''}` },
      h('span', {}, n > 1 ? `已刪除 ${n} 則訊息` : '訊息已刪除'), '－',
      h('button', { title: '把刪掉的訊息放回這裡', onclick: () => restoreDeleted(d.id).catch(fail) }, '還原'),
      h('button', { class: 'del-x', title: '關掉這個框（刪掉的訊息就不留了）', onclick: () => dismissDeleted(d.id).catch(fail) }, icon('x')));
  });
}
/**
 * 刪掉（或拿掉）已經整理進記憶的訊息之後：伺服器會在背景從頭重新整理記憶（memory_updating），
 * 記憶關閉或關閉自動整理時不會，提醒可以手動整理
 */
function memoryNoteForDelete(r, charId, chatId) {
  if (r.memory_updating) {
    watchMemory(charId, chatId, '刪掉的訊息已經整理進記憶，正在背景重新整理記憶…');
    toast('刪掉的訊息已經整理進記憶，正在背景重新整理記憶。原本的記憶留成「上一版」，需要時可以在「對話設定 → 記憶」換回來。', false, 8000);
  } else if (r.memory_cleared) toast('整理進記憶的訊息都刪掉了，記憶已清空（原本的留成「上一版」）。', false, 7000);
  else if (r.in_memory) toast('刪除的訊息已經整理進記憶，記憶裡可能還留著那段劇情（目前關閉了自動整理）。需要時可以在「對話設定 → 記憶」按「全部重新整理」。', false, 9000);
}
/** 換上伺服器回傳的整段對話並重畫（刪除、還原訊息之後） */
function takeChat(chat, chatId) {
  if (state.chatId !== chatId || !state.chat) return false;
  state.chat = chat;
  renderMessages(); refreshChatList();
  return true;
}
/** 訊息操作被拒絕（別的視窗改過、生成中）：重新讀取，畫面回到伺服器上的樣子 */
async function reloadAfterFail(e, charId, chatId) {
  fail(e);
  if (state.chatId !== chatId) return;
  try { state.chat = await api('GET', `/api/characters/${charId}/chats/${chatId}`); renderMessages(); } catch { /* 讀不到就維持原樣 */ }
}
async function restoreDeleted(id) {
  if (state.generating || !state.chat) return;
  const d = (state.chat.deleted || []).find(x => x.id === id);
  if (!d) return;
  const charId = state.char.id, chatId = state.chatId;
  const msgs = state.chat.messages;
  // 刪除之後又有新訊息（在框之後、時間比刪除晚）：和重新生成一樣先決定怎麼處理它們
  const later = msgs.filter((m, j) => j >= d.i && (m.time || 0) > d.time).length;
  const run = async mode => {
    closeModal();
    if (state.generating || state.chatId !== chatId) return;
    let r;
    try { r = await api('POST', `/api/characters/${charId}/chats/${chatId}/deleted/${id}/restore`, { mode, base_ver: state.chat.msg_ver }); }
    catch (e) { return reloadAfterFail(e, charId, chatId); }
    if (!takeChat(r.chat, chatId)) return;
    if (r.branch) toast(`原本的對話已存成分支「${charName(state.char)}（分支）」，可以在對話清單找到`, false, 6000);
    else if (mode === 'drop') toast(`已還原。還原前的完整對話留了一份在垃圾桶，${trashDaysText()}`, false, 7000);
    else toast('已還原刪除的訊息');
    if (r.memory_updating) {
      watchMemory(charId, chatId, '正在背景重新整理記憶…');
      toast('記憶裡沒有還原的訊息（或拿掉了整理過的新訊息），正在背景重新整理記憶。', false, 7000);
    } else if (r.gap) toast('還原的訊息不在目前的記憶裡（刪除之後記憶重新整理過）。需要時可以在「對話設定 → 記憶」按「全部重新整理」。', false, 9000);
  };
  if (!later) return run();
  openModal('還原刪除的訊息', h('div', {},
    h('p', {}, `這則刪除之後又有 ${later} 則訊息，還原會回到刪除當時的狀態。要怎麼處理之後的訊息？`),
    h('p', { class: 'muted small-note' }, '存成分支：目前的完整對話另存一段（之後可以在對話清單打開），這裡回到刪除當時的樣子。'),
    h('p', { class: 'muted small-note' }, '刪除：之後的訊息直接刪掉；還原前的完整對話會先留一份在垃圾桶。')), [
    h('button', { onclick: closeModal }, '取消'),
    h('button', { class: 'primary', onclick: () => run('branch').catch(fail) }, '存成分支並還原'),
    h('button', { class: 'danger', onclick: () => run('drop').catch(fail) }, `刪除之後的 ${later} 則並還原`)]);
}
async function dismissDeleted(id) {
  if (state.generating || !state.chat) return;
  const charId = state.char.id, chatId = state.chatId;
  const r = await api('DELETE', `/api/characters/${charId}/chats/${chatId}/deleted/${id}`);
  if (state.chatId !== chatId || !state.chat) return;
  state.chat.deleted = r.deleted;
  $(`#messages .del-ph[data-del="${id}"]`)?.remove();
}
async function deleteMessage(i) {
  if (state.generating) return;
  const charId = state.char.id, chatId = state.chatId;
  const del = async all => {
    closeModal();
    if (state.generating || state.chatId !== chatId) return;
    // 伺服器刪除並在原本的位置留一個「訊息已刪除」的框；記憶進度、壓縮切點跟著往前移（只移刪掉的則數）
    const many = all && state.chat.messages.length - i > 1;
    let r;
    try { r = await api('POST', `/api/characters/${charId}/chats/${chatId}/messages/${i}/delete`, { all, base_ver: state.chat.msg_ver }); }
    catch (e) { return reloadAfterFail(e, charId, chatId); }
    if (!takeChat(r.chat, chatId)) return;
    memoryNoteForDelete(r, charId, chatId);
    if (many) toast(`已刪除。刪除前的完整對話也留了一份在垃圾桶，${trashDaysText()}`, false, 7000);
  };
  openModal('刪除訊息', h('div', {}, h('p', {}, '要刪除這一則訊息，還是刪除這一則以及之後的所有訊息？'),
    h('p', { class: 'muted small-note' }, '刪除的位置會留一個「訊息已刪除」的框，按「還原」可以放回去（每段對話保留最近 10 筆）。刪除此則及之後時，刪除前的完整對話也會留一份在垃圾桶。')), [
    h('button', { onclick: closeModal }, '取消'),
    h('button', { class: 'danger', onclick: () => del(true) }, '刪除此則及之後'),
    h('button', { class: 'danger', onclick: () => del(false) }, '只刪除此則')]);
}
/**
 * 重新生成較舊的 AI 回應：之後的訊息是接著這則寫的，重新生成後就接不上，所以要先決定怎麼處理它們：
 * 存成分支（原本的完整對話另存一段，這裡從這則重新開始）或直接刪除。重新生成會保留這則的舊版本，可以左右切換
 */
function regenerateFrom(i) {
  if (state.generating) return;
  const msgs = state.chat.messages;
  const later = msgs.length - 1 - i;
  if (later <= 0) return generate('regenerate');
  const charId = state.char.id, chatId = state.chatId;
  const run = async keepBranch => {
    closeModal();
    if (state.generating || state.chatId !== chatId) return;
    if (keepBranch) {
      // 原本的完整對話（含之後的訊息）另存成分支
      try { await api('POST', `/api/characters/${charId}/chats`, { branch_from: chatId, upto: msgs.length - 1 }); }
      catch (e) { return fail(e); }
    }
    const c = state.chat;
    const cutAt = i + 1; // 之後的訊息刪掉；已經整理進記憶的進度也退回來
    const inMemory = cutAt < (c.memory_upto || 0) || cutAt < (c.memory_cut || 0);
    c.messages.splice(cutAt);
    // 直接刪除之後的訊息：刪除前的完整對話先留一份在垃圾桶（存成分支時原本的對話已經另存，不用再留）
    const extra = { ...(inMemory ? { memory_upto: Math.min(c.memory_upto || 0, cutAt), memory_cut: Math.min(c.memory_cut || 0, cutAt) } : {}), ...(keepBranch ? {} : { snapshot: 'delete' }) };
    const memBefore = !!c.memory?.trim();
    const r = await saveChat(extra);
    if (!r) return;
    renderMessages(); refreshChatList();
    if (keepBranch) toast(`原本的對話已存成分支「${charName(state.char)}（分支）」，可以在對話清單找到`, false, 6000);
    if (inMemory && memBefore) memoryNoteForDelete({ ...r, in_memory: true, memory_cleared: !r.memory_updating && !r.memory?.trim() }, charId, chatId);
    generate('regenerate');
  };
  openModal('重新生成這則回應', h('div', {},
    h('p', {}, `這則之後還有 ${later} 則訊息，是接著目前的內容寫的；重新生成後就接不上了。要怎麼處理之後的訊息？`),
    h('p', { class: 'muted small-note' }, '存成分支：原本的完整對話另存一段（之後可以在對話清單打開），這裡從這則重新開始。'),
    h('p', { class: 'muted small-note' }, '刪除：之後的訊息直接刪掉；刪除前的完整對話會先留一份在垃圾桶，刪錯了可以還原。'),
    h('p', { class: 'muted small-note' }, '兩種都會保留這則的舊版本，重新生成後可以用左右箭頭切換。')), [
    h('button', { onclick: closeModal }, '取消'),
    h('button', { class: 'primary', onclick: () => run(true).catch(fail) }, '存成分支並重新生成'),
    h('button', { class: 'danger', onclick: () => run(false).catch(fail) }, `刪除之後的 ${later} 則並重新生成`)]);
}
async function branchFrom(i) {
  if (state.generating) return;
  // 伺服器複製到這一則為止的訊息、對話設定、發言模式與（涵蓋得到的）記憶，一次建立好
  let chat;
  try { chat = await api('POST', `/api/characters/${state.char.id}/chats`, { branch_from: state.chatId, upto: i }); } catch (e) { return fail(e); }
  toast('已建立分支對話');
  go(`#/chat/${state.char.id}/${chat.id}`);
}
async function swipe(i, dir) {
  if (state.generating) return;
  const m = state.chat.messages[i];
  m.swipes = m.swipes?.length ? m.swipes : [m.content];
  const next = (m.swipe_id || 0) + dir;
  if (next < 0) return;
  if (next >= m.swipes.length) return generate('regenerate');
  // 思考過程跟著版本切換（舊訊息沒有逐版本紀錄：原本的思考算在當時顯示的版本上）
  if (!Array.isArray(m.swipe_reasoning)) m.swipe_reasoning = m.swipes.map((_, k) => (k === (m.swipe_id || 0) ? m.reasoning || '' : ''));
  if (!Array.isArray(m.swipe_timing)) m.swipe_timing = m.swipes.map((_, k) => (k === (m.swipe_id || 0) ? m.timing || null : null));
  m.swipe_id = next; m.content = m.swipes[next];
  if (m.swipe_reasoning[next]) m.reasoning = m.swipe_reasoning[next]; else delete m.reasoning;
  if (m.swipe_timing[next]) m.timing = m.swipe_timing[next]; else delete m.timing;
  await saveMessage(i); renderMessages(); showUsage();
}

// ---------- 生成 ----------
// 生成在伺服器背景進行：離開這段對話只會斷開串流，不會中斷 AI；回到這段對話時會重新接上
function detachStream() {
  if (!state.generating) return;
  state.genToken = null;
  state.abort?.abort(); state.abort = null;
  state.generating = false; setBusy(false);
}
/** opts.speaker：大世界中指定由誰發言（角色 ID 或 narrator）；opts.interrupt：是插話 */
async function generate(mode, userMessage, opts = {}) {
  if (!state.char || state.generating) return;

  // 樂觀更新畫面
  const msgs = state.chat.messages;
  // _pending：還沒確定伺服器收到的（連不上時拿掉；伺服器回應後整段對話會換成伺服器的版本）
  if (mode === 'normal' && userMessage) msgs.push({ role: 'user', content: userMessage, time: Date.now(), _pending: true, ...(opts.npc ? { npc: opts.npc } : opts.narration ? { narration: true } : {}) });
  let target, prefix = '';
  const last = msgs[msgs.length - 1];
  if (mode === 'regenerate' && last?.role === 'assistant') { target = last; target.content = ''; target.reasoning = ''; }
  else if (mode === 'continue' && last?.role === 'assistant') { target = last; prefix = last.content; }
  else { target = { role: 'assistant', content: '', time: Date.now(), _pending: true }; msgs.push(target); }
  if (opts.speaker) target.speaker = opts.speaker;
  renderMessages();
  const body = JSON.stringify({ char_id: state.char.id, chat_id: state.chatId, mode, user_message: userMessage, speaker: opts.speaker, interrupt: opts.interrupt, npc: opts.npc, narration: opts.narration });
  await runStream(signal => fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body }), { prefix, restore: opts.restore });
}
/** 接上進行中的生成（例如從首頁或其他對話切回來） */
function resumeStream(charId, chatId) {
  return runStream(signal => fetch(`/api/generate/${charId}/${chatId}`, { signal }), { resume: true });
}
async function runStream(open, { prefix = '', resume = false, restore = '' }) {
  const charId = state.char.id, chatId = state.chatId;
  const here = () => state.char?.id === charId && state.chatId === chatId && !$('#chatView').hidden;
  const token = {}; state.genToken = token;
  const ac = new AbortController(); state.abort = ac;
  state.generating = true; setBusy(true);
  let idx = -1;
  const textEl = () => (here() && idx >= 0 ? $(`#messages .msg[data-i="${idx}"] .mtext`) : null);

  let text = '', reasoning = '', pending = false, planText = '';
  // 還沒收到任何內容時，在訊息框裡顯示等了幾秒（有些模型忙碌時要等很久才開始回應，不然看起來像壞掉）
  let waitTimer = null;
  const stopWait = () => { clearInterval(waitTimer); waitTimer = null; };
  const startWait = () => {
    stopWait();
    const t0 = Date.now();
    const tick = () => {
      if (text || reasoning) return stopWait();
      const el = textEl(); if (!el) return;
      const sec = Math.round((Date.now() - t0) / 1000);
      let note = el.querySelector('.wait-note');
      if (!note) { el.innerHTML = ''; note = h('span', { class: 'wait-note' }); el.append(note); }
      note.textContent = '等待 AI 回應中…' + (sec >= 3 ? ` ${sec} 秒` : '')
        + (sec >= 30 ? '（模型目前回應較慢；可以繼續等，或按「停止」後到「設定」換一個模型）' : '');
    };
    tick(); waitTimer = setInterval(tick, 1000);
  };
  const paint = () => {
    pending = false;
    stopWait();
    const el = textEl(); if (!el) return;
    const { think, vis } = splitThink(prefix + text);
    const allThink = [reasoning, think].filter(Boolean).join('\n').trim();
    if (allThink) {
      let tb = el.parentNode.querySelector('details.think');
      if (!tb) { tb = thinkBox(''); el.before(tb); }
      $('summary .lbl', tb).textContent = vis.trim() ? '思考過程' : '思考中…（點開查看）';
      $('.think-body', tb).textContent = allThink;
    }
    // 狀態欄的標籤先不顯示（完成後伺服器會拿掉）；卡片沒有狀態欄也沒有表情圖時照原樣顯示（伺服器也不會拿掉）
    el.innerHTML = formatText(usesStatus(state.char) ? hideStatusTags(vis) : vis);
    const box = $('#messages');
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 200) box.scrollTop = box.scrollHeight;
  };

  // 伺服器還沒收下訊息（拒絕了，或根本連不上）：把打好的字放回輸入框（也會存回草稿），不要讓它不見
  const putBack = () => { if (restore && here() && !$('#input').value.trim()) { $('#input').value = restore; autoGrow(); } };
  let opened = false;
  try {
    const res = await open(ac.signal);
    opened = true;
    if (!res.ok) {
      if (resume) throw Object.assign(new Error('done'), { name: 'AbortError' }); // 剛好已經生成完
      putBack(); // 例如這段對話正在別處生成
      throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, sep); buf = buf.slice(sep + 2);
        if (!line.startsWith('data: ')) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.type === 'start' || ev.type === 'msg_start') {
          // 一次生成可能有好幾則訊息（大世界輪流發言）：每則開始時切換到那則訊息
          idx = ev.message_index;
          if (ev.message && here()) {
            if (idx > state.chat.messages.length) {
              // 畫面上的對話比伺服器舊（例如中途切換回來）：重新讀取，避免中間出現空洞
              state.chat = await api('GET', `/api/characters/${charId}/chats/${chatId}`).catch(() => state.chat);
              state.chat.messages[idx] = ev.message; renderMessages();
            } else { state.chat.messages[idx] = ev.message; renderMessageAt(idx); }
          }
          if (resume && ev.type === 'start') {
            // 重新接上：補上離開期間已經產生的內容
            prefix = state.chat.messages[idx]?.content || '';
            text = ev.text || ''; reasoning = ev.reasoning || '';
            if (!pending) { pending = true; setTimeout(paint, 40); }
          } else if (ev.message) { prefix = ev.message.content || ''; text = ''; reasoning = ''; }
          textEl()?.classList.add('cursor');
          if (!prefix && !text && !reasoning) startWait(); else stopWait(); // 「繼續」時已經有內容，不顯示等待
          // 重新接上時，如果導演還在規劃，這時還沒有任何訊息的提示詞資訊
          if (ev.phase === 'director' && here()) $('#status').textContent = '導演規劃這一輪…';
          if (ev.phase === 'compress' && here()) $('#status').textContent = '聊天紀錄快滿了，正在把較舊的對話整理進記憶…';
          const inf = ev.info;
          // 提示詞太長：每段對話提醒一次（不擋下，有些模型實際可用的上下文比設定的大）
          if (inf?.overflow > 0 && here() && !overflowWarned.has(chatId)) { overflowWarned.add(chatId); toast(overflowText(inf), true, 15000); }
          if (inf && here()) {
            $('#status').textContent = `約 ${inf.tokens} tokens\n歷史 ${inf.history_used}/${inf.history_total} 則`
              + (inf.memory_cut ? `\n另 ${inf.memory_cut} 則交給記憶` : '')
              + (inf.world_entries.length ? `\n世界書 ${inf.world_entries.length} 條` : '');
            $('#status').title = (planText ? `導演的安排：\n${planText}\n\n` : '') + (inf.world_entries.length ? '觸發的世界書：' + inf.world_entries.map(e => e.comment).join('、') : '');
          }
        } else if (ev.type === 'text') {
          text += ev.text;
          if (!pending) { pending = true; setTimeout(paint, 40); }
        } else if (ev.type === 'reasoning') {
          reasoning += ev.text;
          if (!pending) { pending = true; setTimeout(paint, 40); }
        } else if (ev.type === 'director') {
          // 大世界：導演正在規劃這一輪（規劃內容放在狀態列的提示裡）
          if (here()) {
            if (ev.status === 'planning') $('#status').textContent = '導演規劃這一輪…';
            else if (ev.plan) { planText = ev.plan; $('#status').title = '導演的安排：\n' + ev.plan; }
          }
        } else if (ev.type === 'compress') {
          // 上下文壓縮：聊天紀錄快滿了，先把較舊的對話整理進記憶再回應
          if (here() && ev.status === 'start') $('#status').textContent = '聊天紀錄快滿了，正在把較舊的對話整理進記憶…';
        } else if (ev.type === 'retry') {
          // 連線失敗：伺服器等一下會自動重試
          if (here()) $('#status').textContent = `連線失敗，${Math.round(ev.wait / 1000)} 秒後重試（${ev.attempt}/${ev.max}）`;
          if (here()) $('#status').title = ev.error;
        } else if (ev.type === 'msg_end' || ev.type === 'msg_update') {
          // 一則訊息完成（或被插話截斷）：換成伺服器整理後的內容
          if (ev.message && here()) {
            if (ev.message_index > state.chat.messages.length) {
              state.chat = await api('GET', `/api/characters/${charId}/chats/${chatId}`).catch(() => state.chat);
              renderMessages();
            } else { state.chat.messages[ev.message_index] = ev.message; renderMessageAt(ev.message_index); }
            setBusy(true);
          }
        } else if (ev.type === 'done') {
          if (here()) { state.chat = ev.chat; renderSpeakerBar(); showUsage(); } // 在場角色可能變了
          if (ev.notice && here()) toast(ev.notice, !text.trim(), 12000);
          if (ev.memory_updating) watchMemory(charId, chatId);
        } else if (ev.type === 'error') {
          if (here()) state.chat = ev.chat;
          throw new Error(ev.error);
        }
      }
    }
  } catch (e) {
    if (state.genToken !== token) return; // 已經離開這段對話：生成在背景繼續
    if (!opened) putBack(); // 連不上伺服器（網路斷線、伺服器關掉了）
    if (e.name !== 'AbortError') fail(opened ? e : new Error(restore ? '連不上伺服器，訊息沒有送出' : '連不上伺服器'));
    // 錯誤時重新從伺服器讀取，確保畫面與存檔一致
    await new Promise(r => setTimeout(r, 150));
    try { if (here()) state.chat = await api('GET', `/api/characters/${charId}/chats/${chatId}`); }
    catch {
      // 也讀不到：拿掉畫面上先放上去、其實沒送出的那兩則（你的訊息與空白的回覆），免得看起來像已經送出了
      if (!opened && here()) state.chat.messages = state.chat.messages.filter(m => !m._pending);
    }
  } finally {
    stopWait();
    if (state.genToken === token) {
      state.genToken = null; state.abort = null;
      state.generating = false; setBusy(false);
      // 只重畫最後兩則（按鈕狀態會變）；訊息數對不上時 renderMessageAt 會自動整個重畫
      if (here() && state.chat) state.chat.messages.length ? renderMessageAt(state.chat.messages.length - 1) : renderMessages();
      refreshChatList();
    }
  }
}
/** 狀態列：最後一則實際用掉的 token，以及這段對話的累計（供應商有回報時） */
const fmtTok = n => n >= 10000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : String(n);
/** 回應耗時：畫面上顯示到 0.1 秒，滑鼠移上去看毫秒 */
const fmtSec = ms => (ms / 1000).toFixed(1) + ' 秒';
const fmtMs = ms => ms.toLocaleString() + ' ms';
function timingTitle(t) {
  const lines = [`第一個字：${fmtMs(t.first ?? 0)}`, `總共：${fmtMs(t.total)}`];
  if (t.director) lines.unshift(`導演規劃：${fmtMs(t.director)}（不含在上面的時間裡）`);
  if (t.tps) lines.push(`輸出速度：約 ${t.tps} tokens／秒`);
  return '回應耗時\n' + lines.join('\n');
}
function showUsage() {
  const u = state.chat?.usage;
  const msgs = state.chat?.messages || [];
  const last = [...msgs].reverse().find(m => m.role === 'assistant' && m.usage)?.usage;
  const tm = [...msgs].reverse().find(m => m.role === 'assistant' && m.timing)?.timing;
  if (!u && !last && !tm) return;
  const lines = [];
  if (last) lines.push(`這則：入 ${fmtTok(last.input)}／出 ${fmtTok(last.output)}` + (last.cached ? `\n（快取 ${fmtTok(last.cached)}）` : ''));
  if (tm) lines.push(`耗時 ${fmtSec(tm.total)}`); // 狀態列只有一行：首字與毫秒放在滑鼠提示
  if (u) lines.push(`累計：${fmtTok(u.input + u.output)}（${u.calls} 次呼叫）`);
  $('#status').textContent = lines.join('\n');
  $('#status').title = [u ? `這段對話實際用掉的 token（含導演與整理記憶）：\n輸入 ${u.input.toLocaleString()}\n輸出 ${u.output.toLocaleString()}\n呼叫 ${u.calls} 次` : '',
    tm ? '最後一則' + timingTitle(tm) : ''].filter(Boolean).join('\n\n');
}
function setBusy(b) {
  $('#messages').classList.toggle('busy', !!b);
  $('#btnSend').hidden = b; $('#btnStop').hidden = !b;
  $('#btnContinue').disabled = b;
  $('#btnAddOnly').disabled = b;
  if (state.chat) renderStatusPanel(); // 狀態欄的「編輯」「儲存」：生成中停用
}

// ---------- 用誰的身分說話：你的角色／你自己寫的旁白／你扮演的 NPC（只有名字，存在這段對話） ----------
const asWhoByChat = {}; // 每段對話記住上次選的身分（只在這次開啟期間）
/** 不能拿來當 NPC 名字的：你自己、這段對話的角色、旁白 */
function reservedNames() {
  const c = state.char;
  const chars = c?.is_world ? (c.world?.members || []).map(m => m.name) : [c?.data?.name];
  return new Set([userName(), ...chars, '旁白'].filter(Boolean));
}
/** 新增 NPC（檢查撞名），回傳名字；取消時回傳 null */
async function addNpc(suggest = '') {
  const name = ((await askText('新增 NPC', { note: '只要名字就好，個性與台詞由你扮演', value: suggest, placeholder: '例如：酒館老闆', okText: '新增' })) || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!name) return null;
  if (reservedNames().has(name)) { toast(`「${name}」和你自己、角色或旁白同名，AI 會分不清楚，請換一個名字`, true); return null; }
  const list = state.chat.npcs || [];
  if (!list.includes(name)) {
    const r = await api('PUT', `/api/characters/${state.char.id}/chats/${state.chatId}`, { npcs: [...list, name] });
    state.chat.npcs = r.npcs || [];
  }
  return name;
}
function renderAsWho() {
  const sel = $('#asWho');
  if (!state.chat) return;
  const npcs = state.chat.npcs || [];
  sel.innerHTML = '';
  sel.append(h('option', { value: '' }, `我（${userName()}）`), h('option', { value: 'narration' }, '旁白（我自己寫）'),
    ...npcs.map(n => h('option', { value: 'npc:' + n }, `NPC：${n}`)), h('option', { value: '__new' }, '＋新增 NPC…'));
  const keep = asWhoByChat[state.chatId] || '';
  sel.value = keep === 'narration' || npcs.includes(keep.slice(4)) ? keep : '';
  sel.classList.toggle('on', !!sel.value);
}
$('#asWho').onchange = async () => {
  const sel = $('#asWho');
  if (sel.value === '__new') {
    const name = await addNpc().catch(e => (fail(e), null));
    asWhoByChat[state.chatId] = name ? 'npc:' + name : asWhoByChat[state.chatId] || '';
    renderAsWho();
  } else { asWhoByChat[state.chatId] = sel.value; sel.classList.toggle('on', !!sel.value); }
  $('#input').focus();
};
/** 目前選的身分 → 送出時附上的欄位（npc：名字、narration：你寫的旁白） */
function asWhoFields() {
  const v = $('#asWho').value || '';
  return v.startsWith('npc:') ? { npc: v.slice(4) } : v === 'narration' ? { narration: true } : {};
}

function sendMessage() {
  const ta = $('#input');
  const text = ta.value;
  if (state.generating || !state.char) return;
  ta.value = ''; autoGrow();
  generate('normal', text.trim() ? text : '', text.trim() ? { ...asWhoFields(), restore: text } : {});
}
/** 只加入這則訊息、不讓 AI 回應（例如你的角色說完，再用 NPC 補一句，最後才按「送出」或「生成回應」） */
async function addOnly() {
  const ta = $('#input');
  if (state.generating || !state.char || !ta.value.trim()) return;
  const content = ta.value;
  ta.value = ''; autoGrow();
  try {
    const r = await api('POST', `/api/characters/${state.char.id}/chats/${state.chatId}/messages`, { content, ...asWhoFields() });
    state.chat.messages = r.messages; state.chat.npcs = r.npcs; state.chat.msg_ver = r.msg_ver;
    renderMessages(); refreshChatList();
  } catch (e) { ta.value = content; autoGrow(); fail(e); }
}
$('#btnSend').onclick = sendMessage;
$('#btnAddOnly').onclick = addOnly;
// 停止：請伺服器中斷生成（已產生的內容會保留）
$('#btnStop').onclick = () => {
  if (!state.generating) return;
  api('POST', '/api/generate/stop', { char_id: state.char.id, chat_id: state.chatId }).catch(fail);
};
$('#btnContinue').onclick = () => generate('continue');
const autoGrow = () => { const ta = $('#input'); ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, innerHeight * 0.4) + 'px'; saveDraft(); };
// 草稿：每段對話各自記住輸入框裡還沒送出的字（記在這台電腦的瀏覽器；切換對話、關掉程式都不會不見，也不會送錯對話）
const DRAFT_KEY = 'tavern.drafts';
const drafts = (() => { try { return JSON.parse(lsGet(DRAFT_KEY) || '{}') || {}; } catch { return {}; } })();
function draftKey() { return state.char && state.chatId ? `${state.char.id}/${state.chatId}` : null; }
function saveDraft() {
  const k = draftKey(); if (!k) return;
  const v = $('#input').value;
  if (v.trim()) drafts[k] = v; else if (k in drafts) delete drafts[k]; else return;
  const keys = Object.keys(drafts); // 最多記 50 段對話的草稿（最舊的先丟）
  if (keys.length > 50) for (const old of keys.slice(0, keys.length - 50)) delete drafts[old];
  lsSet(DRAFT_KEY, JSON.stringify(drafts));
}
$('#input').addEventListener('input', autoGrow);
$('#input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.altKey && !e.isComposing) { e.preventDefault(); addOnly(); return; } // Alt+Enter：只加入、不回應
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
});

// ---------- 提示詞預覽 ----------
$('#btnPreview').onclick = () => openPreview();
const overflowWarned = new Set(); // 這次開程式已經提醒過「提示詞太長」的對話
/** 提示詞太長的說明：固定的部分（不含聊天紀錄）就超過上下文長度 */
const overflowText = inf => `⚠ 提示詞太長：系統提示、角色設定、世界書與記憶，加上預留的回應長度，已經超過上下文長度（${inf.context_tokens} tokens）約 ${inf.overflow} tokens。`
  + '這時只會送出最後一則訊息，AI 看不到前面的對話，API 也可能直接報錯。可以到「設定 → API 設定」調大上下文長度或調小最大回應，或精簡角色描述、世界書與記憶。';
const fmtK = v => (v >= 1000 ? `${(v / 1000).toFixed(v < 10000 ? 1 : 0).replace(/\.0$/, '')}k` : String(v));
/**
 * 聊天紀錄實際有多少空間：上下文長度扣掉系統提示、角色卡、世界書、記憶與預留的回應後剩下的，
 * 比聊天紀錄上限小時（例如大世界角色很多），提醒上限送不滿、要調大上下文長度
 */
function roomText(inf) {
  if (inf.overflow > 0) return { text: overflowText(inf), warn: true };
  const cap = inf.history_cap || 0, room = inf.history_room ?? 0, ctx = inf.context_tokens;
  if (cap > 0 && room < cap) {
    const need = Math.ceil((ctx + cap - room) / 1000) * 1000;
    return { warn: true, text: `⚠ 系統提示、角色設定、世界書、記憶與預留的回應約佔 ${fmtK(ctx - room)} tokens，聊天紀錄只剩約 ${fmtK(room)}，送不滿上限 ${fmtCap(cap)}。`
      + `模型支援的話，可以把上下文長度調到 ${fmtK(need)} 以上；不支援就維持現狀（較舊的對話會整理進記憶）。` };
  }
  return { warn: false, text: `聊天紀錄的空間足夠：扣掉其他內容後還有約 ${fmtK(room)} tokens` + (cap > 0 ? `，上限 ${fmtCap(cap)} 送得滿。` : '（沒有設定上限）。') };
}
async function openPreview() {
  try {
    const r = await api('POST', '/api/prompt-preview', { char_id: state.char.id, chat_id: state.chatId });
    const body = h('div', {},
      h('p', { class: 'muted' }, `約 ${r.info.tokens} tokens｜使用歷史 ${r.info.history_used}/${r.info.history_total} 則｜觸發世界書：${r.info.world_entries.map(e => e.comment).join('、') || '無'}`),
      r.info.preview_note ? h('p', { class: 'muted small-note' }, r.info.preview_note) : null,
      r.info.overflow > 0 ? h('p', { class: 'key-warning' }, overflowText(r.info)) : null,
      r.messages.map(m => h('div', { class: 'prompt-msg' }, h('div', { class: 'role' }, m.role), h('pre', {}, m.content))));
    openModal('組裝後的提示詞', body, [h('button', { onclick: closeModal }, '關閉')], { wide: true });
  } catch (e) { fail(e); }
}

