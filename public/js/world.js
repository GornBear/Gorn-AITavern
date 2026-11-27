'use strict';
// AI 酒館 前端 — 大世界：世界卡、世界設定（成員、發言、提示詞、世界書、開場白）、角色與世界的介紹
// 這些檔案依序載入（見 index.html），共用同一個全域範圍；最後由 main.js 啟動
// ===================== 大世界 =====================
const worldChatOwner = w => ({ id: WORLD_PREFIX + w.id, last_chat: w.last_chat });
/** 一排成員頭像 */
const memberRow = (members, cls = 'member-row', onClick) => h('div', { class: cls },
  members.map(m => { const a = avatarEl(m, 'm-av'); a.title = m.name; if (onClick) a.onclick = () => onClick(m); return a; }));

function renderWorlds(q) {
  const grid = $('#worldGrid'); grid.innerHTML = '';
  const all = state.bigworlds || [];
  const match = w => !q || w.name.toLowerCase().includes(q) || (w.tags || []).some(t => t.toLowerCase().includes(q))
    || w.members.some(m => m.name.toLowerCase().includes(q));
  const list = sortHome(all.filter(match));
  $('#worldCount').textContent = all.length ? `（${list.length}）` : '';
  // 「創建世界」固定在第一個位置
  grid.append(h('button', { class: 'card create-card', title: '創建一個新的世界', onclick: () => openBigWorldEditor(null).catch(fail) },
    h('div', { class: 'create-plus' }, icon('plus')), h('span', {}, '創建世界')));
  for (const w of list) {
    grid.append(h('div', { class: 'card world-card' },
      h('button', { class: 'card-edit', title: '編輯世界', onclick: () => openBigWorldEditor(w.id).catch(fail) }, icon('pencil')),
      orderBadge('bigworld', w),
      h('img', { class: 'cover wcover', src: worldCoverUrl(w.id, w.img_ver), alt: '', title: '查看世界', onclick: () => openWorldDetail(w.id).catch(fail) }),
      h('div', { class: 'c-body' },
        h('div', { class: 'c-name', title: w.name, onclick: () => openWorldDetail(w.id).catch(fail) }, w.name),
        h('div', { class: 'c-meta' }, `${w.members.length} 位角色｜` + (w.chat_count ? `${w.chat_count} 段對話｜${fmtTime(w.last_chat.updated)}` : '尚未對話')),
        memberRow(w.members.slice(0, 12)),
        chatButtons(worldChatOwner(w)))));
  }
}

// 世界詳情：封面、成員、介紹
async function openWorldDetail(id) {
  const w = await api('GET', `/api/bigworlds/${id}`);
  const info = (state.bigworlds || []).find(x => x.id === id) || w;
  const members = w.members.filter(m => !m.missing);
  const edit = h('button', { class: 'detail-edit', title: '編輯世界', onclick: () => { closeModal(); openBigWorldEditor(id, { back: () => openWorldDetail(id) }).catch(fail); } }, ic('pencil', '編輯世界'));
  const body = h('div', { class: 'char-detail world-detail' }, h('div', { class: 'detail-tools' }, orderTag('bigworld', id, w.order), edit),
    h('img', { class: 'world-detail-cover', src: worldCoverUrl(id, w.img_ver), alt: '' }),
    h('div', { class: 'detail-info' },
      h('div', { class: 'detail-name' }, w.name),
      h('div', { class: 'c-meta' }, `${members.length} 位角色｜` + (info.chat_count ? `${info.chat_count} 段對話｜最後：${fmtTime(info.last_chat.updated)}` : '尚未對話')),
      (w.tags || []).length ? h('div', { class: 'detail-tags' }, w.tags.map(tagLink)) : null,
      h('div', { class: 'detail-label' }, '登場角色'),
      members.length ? memberRow(members, 'member-row big', m => { closeModal(); openCharDetail(m.id, { back: () => openWorldDetail(id) }).catch(fail); })
        : h('div', { class: 'muted' }, '（還沒有加入角色）'),
      h('div', { class: 'detail-label' }, '世界介紹'),
      w.intro?.trim()
        ? h('div', { class: 'detail-intro mtext', html: formatText(nameMacros(w.intro, w.name)) })
        : h('div', { class: 'detail-intro muted' }, '（還沒有介紹，可以按「編輯世界」填寫）')),
    chatButtons({ id: WORLD_PREFIX + id, last_chat: info.last_chat }, closeModal),
    // 匯入 SillyTavern 的群組對話：名字對得上成員的算那位角色說的，其他算旁白
    h('div', { class: 'detail-tokens detail-import' }, importChatBtn(WORLD_PREFIX + id)));
  openModal(w.name, body, [], { esc: true });
}

/** 在對話框上方疊一層選單（不會關掉正在編輯的視窗） */
function overlayPanel(title, content, onClose) {
  const close = () => { ov.remove(); onClose?.(); };
  const ov = h('div', { class: 'crop-overlay' },
    h('div', { class: 'crop-box pick-box' },
      h('div', { class: 'pick-head' }, h('h3', {}, title), h('button', { class: 'icon', title: '關閉', onclick: close }, icon('x'))),
      content));
  document.body.append(ov);
  return close;
}

const SYS_MODE_LABEL = { full: '完整套用角色卡的系統提示', none: '不套用（只用角色設定、個性與台詞範例）', custom: '自訂：只保留影響角色扮演的規則' };

// 世界設定：名稱、封面、成員、介紹、提示詞、開場白
/** back：按上一頁時回到哪個視窗（從世界介紹打開時回到介紹） */
async function openBigWorldEditor(id, { back } = {}) {
  const isNew = !id;
  const w = isNew ? { name: '', tags: [], intro: '', setting: '', system_prompt: '', post_history_instructions: '', opening: [], members: [],
    turn_mode: 'turns', max_replies: 2, allow_interrupt: true, interrupt_rate: 25, cut_interrupt: true }
    : await api('GET', `/api/bigworlds/${id}`);
  const d = structuredClone({
    turn_mode: 'turns', max_replies: 2, allow_interrupt: true, interrupt_rate: 25, cut_interrupt: true, opening: [], // 舊的世界沒有這些欄位
    ...w, members: w.members.filter(m => !m.missing),
  });
  if (!state.chars?.length) state.chars = await api('GET', '/api/characters');
  // 世界書：全域世界書清單＋成員角色卡（需要時才讀取，看它們帶了哪些世界書）
  const lorebooks = await api('GET', '/api/worlds').catch(() => []);
  const cardCache = {};
  const bookCache = {}; // 角色卡連結的世界書（要列出每個條目）
  const loadCard = async mid => {
    if (!cardCache[mid]) cardCache[mid] = await api('GET', `/api/characters/${mid}`).catch(() => null);
    const wid = cardCache[mid]?.world_id;
    if (wid && !bookCache[wid]) bookCache[wid] = await api('GET', `/api/worlds/${wid}`).catch(() => null);
  };
  await Promise.all(d.members.map(m => loadCard(m.id)));
  const cover = { url: null, remove: false };
  // 狀態欄的欄位（所有成員共用角色欄位、玩家欄位一份；和角色卡的格式相同）
  const statusLists = {
    char_fields: structuredClone(Array.isArray(d.status?.char_fields) ? d.status.char_fields : []),
    user_fields: structuredClone(Array.isArray(d.status?.user_fields) ? d.status.user_fields : []),
  };
  const statusEd = statusFieldsEditor(statusLists, { world: true });
  const f = {};
  const field = fieldMaker(f, d);

  // 封面
  const coverImg = h('img', { class: 'wcover-prev', alt: '', src: isNew ? '/world-cover.svg' : worldCoverUrl(id, w.img_ver) });
  const coverBox = h('div', { class: 'img-slot' }, coverImg, h('span', {}, '封面'),
    h('div', { class: 'btns' },
      h('button', { type: 'button', class: 'small', onclick: async () => {
        const url = await pickImage(1280); if (!url) return;
        cover.url = url; cover.remove = false; coverImg.src = url;
      } }, '更換封面'),
      h('button', { type: 'button', class: 'small', title: '改回預設的風景圖', onclick: () => {
        cover.url = null; cover.remove = true; coverImg.src = '/world-cover.svg';
      } }, '預設封面')));

  // 成員：虛線圓圈＋號固定在最前面，後面是已加入角色的頭像
  let selected = null;
  const membersBox = h('div', { class: 'member-edit' });
  const memberPanel = h('div', { class: 'member-panel' });
  const charOf = mid => state.chars.find(c => c.id === mid);
  const renderMembers = () => {
    membersBox.innerHTML = '';
    membersBox.append(h('button', { type: 'button', class: 'add-member', title: '加入角色', onclick: openPicker }, icon('plus')));
    for (const m of d.members) {
      const c = charOf(m.id) || m;
      const a = avatarEl({ ...c, id: m.id }, 'm-av' + (selected === m.id ? ' selected' : ''));
      a.title = c.name;
      a.onclick = () => { selected = selected === m.id ? null : m.id; renderMembers(); };
      membersBox.append(h('div', { class: 'member-chip' }, a, h('span', {}, c.name)));
    }
    renderPanel();
    renderMemberBooks();
    renderOpening(); // 開場白的發言者選單跟著成員更新
  };

  // 世界書分頁：角色卡帶來的（可開關）＋世界專屬的
  const memberBooks = h('fieldset', {});
  function renderMemberBooks() {
    memberBooks.innerHTML = '';
    memberBooks.append(h('legend', {}, '角色卡的世界書（跟隨角色卡，可以各自開關）'));
    if (!d.members.length) return memberBooks.append(h('p', { class: 'muted small-note' }, '加入角色後，角色卡內嵌或連結的世界書會出現在這裡。'));
    for (const m of d.members) {
      const card = cardCache[m.id];
      const c = charOf(m.id) || m;
      m.book_off = m.book_off || [];
      const embEntries = card?.data.character_book?.entries || [];
      const linkedBook = card?.world_id ? bookCache[card.world_id] : null;
      // 一本世界書：上面是整本的開關，下面每個條目各自一個開關
      const bookBlock = (flagKey, prefix, title, entries) => {
        const list = h('div', { class: 'book-entries' }, entries.map(e => {
          const key = prefix + e.id;
          const label = e.comment?.trim() || (e.keys || []).join('、') || '（未命名條目）';
          return h('label', { class: 'check book-entry', title: (e.content || '').slice(0, 200) },
            h('input', { type: 'checkbox', checked: !m.book_off.includes(key), onchange: ev => {
              m.book_off = ev.target.checked ? m.book_off.filter(k => k !== key) : [...new Set([...m.book_off, key])];
            } }),
            h('span', {}, label), e.constant ? h('span', { class: 'tag' }, '常駐') : (e.keys || []).length ? h('span', { class: 'muted ek' }, (e.keys || []).slice(0, 4).join('、')) : null);
        }));
        list.classList.toggle('off', m[flagKey] === false);
        return h('div', { class: 'book-block' },
          h('label', { class: 'check book-head' },
            h('input', { type: 'checkbox', checked: m[flagKey] !== false, onchange: ev => { m[flagKey] = ev.target.checked; list.classList.toggle('off', !ev.target.checked); } }),
            h('b', {}, title), h('span', { class: 'muted' }, `${entries.length} 條`)),
          list);
      };
      memberBooks.append(h('div', { class: 'book-member' },
        h('div', { class: 'book-who' }, avatarEl({ ...c, id: m.id }, 'm-av'), h('b', {}, c.name)),
        h('div', { class: 'book-opts' },
          embEntries.length ? bookBlock('book_embedded', 'emb:', '內嵌世界書', embEntries) : null,
          linkedBook ? bookBlock('book_linked', 'lnk:', `連結的世界書：${linkedBook.name}`, linkedBook.entries || []) : null,
          !card ? h('span', { class: 'muted' }, '讀取中…') : !embEntries.length && !linkedBook ? h('span', { class: 'muted' }, '這張角色卡沒有世界書') : null)));
    }
    memberBooks.append(h('p', { class: 'muted small-note' }, '輪流發言時，角色卡帶來的世界書只會在該角色發言時使用；世界專屬的世界書所有角色都會用到。全域世界書（設定 → 提示詞設定）一律生效。'));
  }
  const wbook = d.character_book ? structuredClone(d.character_book) : { name: '', entries: [], scan_depth: 4, token_budget: 2048, recursive_scanning: false };
  const worldBookChecks = lorebooks.map(b => h('label', { class: 'check' },
    h('input', { type: 'checkbox', value: b.id, checked: (d.world_ids || []).includes(b.id) }), `${b.name}（${b.count} 條）`));
  const bookPane = h('div', { class: 'form' },
    memberBooks,
    h('fieldset', {}, h('legend', {}, '世界專屬：連結世界書'),
      worldBookChecks.length ? worldBookChecks : h('p', { class: 'muted small-note' }, '還沒有世界書，可以在首頁右上的「世界書」建立或匯入。')),
    h('fieldset', {}, h('legend', {}, '世界專屬：內嵌在世界卡裡的世界書'), entriesEditor(wbook)));
  const renderPanel = () => {
    memberPanel.innerHTML = '';
    const m = d.members.find(x => x.id === selected);
    if (!m) {
      memberPanel.append(h('p', { class: 'muted small-note' }, d.members.length
        ? '點角色頭像可以設定這個角色在世界裡如何套用角色卡的系統提示，或把角色移出世界。'
        : '按虛線圓圈的「＋」加入角色。世界只會記住加入了哪些角色，對話時才讀取角色卡。'));
      return;
    }
    const c = charOf(m.id) || m;
    // 角色卡的系統提示：「完整套用」時也把完整內容顯示在下面的欄位；
    // 在欄位裡修改就自動切成「自訂」，切回「完整套用」時把完整內容重新寫回（捨棄修改）
    const mode = h('select', {}, Object.entries(SYS_MODE_LABEL).map(([v, t]) => h('option', { value: v }, t)));
    mode.value = m.sys_mode || 'full';
    const fullPrompt = async () => {
      if (!cardCache[m.id]) await loadCard(m.id);
      return cardCache[m.id]?.data?.system_prompt || '';
    };
    const custom = h('textarea', { rows: 7, placeholder: '只保留會影響角色扮演的規則（例如角色的行為準則、禁忌、口癖），刪掉只影響文字描寫手法的部分。' });
    const customLabel = h('span', {});
    const customNote = h('span', { class: 'muted small-note' });
    const customTok = h('div', { class: 'tok' });
    const customWrap = h('label', {}, customLabel, custom, customTok, customNote);
    // 這位角色發言時，角色卡佔多少：設定、個性、台詞範例（大世界不送開場白與情境）＋目前套用的系統提示＋公開資訊
    const memTok = h('div', { class: 'detail-tokens member-tokens' });
    const nameSub = s => String(s || '').replace(/{{char}}|<BOT>/gi, c.name || '').replace(/{{user}}|<USER>/gi, state.settings?.user_name || 'User');
    const updTok = () => {
      customTok.textContent = `約 ${estTok(custom.value)} tokens`;
      const cd = cardCache[m.id]?.data;
      if (!cd) { memTok.textContent = '計算 token…'; loadCard(m.id).then(() => cardCache[m.id]?.data && updTok()).catch(() => (memTok.textContent = '')); return; }
      const core = ['description', 'personality', 'mes_example'].reduce((s, k) => s + estTok(nameSub(cd[k])), 0);
      const sys = mode.value === 'none' ? 0 : estTok(nameSub(custom.value));
      const pubT = estTok(m.public_info || '');
      const n = x => x.toLocaleString();
      const part = (label, v) => h('span', { class: 'dt-part' }, label, ' ', h('b', {}, n(v)));
      memTok.replaceChildren(h('span', { class: 'dt-total' }, icon('file-text'), `發言時約 ${n(core + sys)} tokens`),
        part('角色設定', core), part('系統提示', sys), part('公開資訊', pubT));
      memTok.title = '估算值，實際數字依模型而不同。\n發言時：這位角色說話的那次呼叫會送出的角色卡內容（角色設定、個性、台詞範例＋目前套用的系統提示）。\n'
        + '公開資訊：其他角色發言時都會看到，角色越多加起來越多。\n內嵌世界書的條目要觸發時才送，不算在裡面。';
    };
    const syncCustom = async () => {
      const v = mode.value;
      customWrap.hidden = v === 'none';
      if (v === 'full') {
        custom.value = await fullPrompt();
        customLabel.textContent = '角色卡的系統提示（完整套用中）';
        customNote.textContent = custom.value.trim()
          ? '目前完整套用這些內容。直接在這裡修改，就會自動改成「自訂」；切回「完整套用」會重新帶入完整內容（捨棄修改）。'
          : '這張角色卡沒有系統提示。在這裡輸入規則，就會自動改成「自訂」。';
      } else if (v === 'custom') {
        custom.value = m.sys_custom || '';
        customLabel.textContent = '自訂的角色卡規則';
        customNote.textContent = '只會套用這裡的內容。切回「完整套用」會重新帶入角色卡的完整系統提示（這裡的修改會被捨棄）。';
      }
      updTok();
    };
    custom.oninput = () => {
      if (mode.value !== 'custom') {
        mode.value = m.sys_mode = 'custom';
        customLabel.textContent = '自訂的角色卡規則';
        customNote.textContent = '已自動改成「自訂」：只會套用這裡的內容。切回「完整套用」會重新帶入角色卡的完整系統提示（這裡的修改會被捨棄）。';
      }
      m.sys_custom = custom.value;
      updTok();
    };
    mode.onchange = async () => {
      m.sys_mode = mode.value;
      if (mode.value === 'full') m.sys_custom = ''; // 完整套用：捨棄自訂內容，下次切到自訂再從完整內容開始
      // 從選單切到自訂、內容是空的：帶入完整內容方便刪減（整理規則後留空的「自訂」不會被補回來）
      if (mode.value === 'custom' && !(m.sys_custom || '').trim()) m.sys_custom = await fullPrompt().catch(() => '');
      syncCustom().catch(fail);
    };
    syncCustom().catch(fail);
    memberPanel.append(h('div', { class: 'form' },
      h('div', { class: 'member-panel-head' }, avatarEl({ ...c, id: m.id }, 'm-av'), h('b', {}, c.name),
        h('button', { type: 'button', class: 'small danger', onclick: () => { d.members = d.members.filter(x => x.id !== m.id); selected = null; renderMembers(); } }, ic('trash-2', '移出世界'))),
      h('label', {}, h('span', {}, '角色卡的系統提示'), mode),
      h('p', { class: 'muted small-note' }, '角色卡的系統提示有些是角色扮演規則（會影響行為），有些只是文字描寫手法（可能和其他角色衝突）。大世界會讀取角色的設定、個性與台詞範例，不會放入角色的開場白與情境。'),
      customWrap,
      memTok,
      (() => {
        // 公開資訊：輪流發言時，其他角色對這個角色只知道這些
        const pub = h('textarea', { rows: 3, value: m.public_info || '', placeholder: `例：${c.name} 的外表、身分、大家都知道的事。留空時，其他角色只知道名字與劇情中看到的言行。` });
        const pubTok = h('div', { class: 'tok' }, `約 ${estTok(pub.value)} tokens`);
        pub.oninput = () => { m.public_info = pub.value; pubTok.textContent = `約 ${estTok(pub.value)} tokens`; updTok(); };
        return h('label', {}, h('span', {}, `公開資訊（其他角色對 ${c.name} 的了解）`), pub, pubTok,
          h('span', { class: 'muted small-note' }, '輪流發言時，每個角色只拿到自己的完整角色卡，其他角色只看得到這裡寫的內容，避免知道別人卡裡才有的秘密。'));
      })()));
  };
  function openPicker() {
    const avail = state.chars.filter(c => !d.members.some(m => m.id === c.id));
    const list = h('div', { class: 'pick-list' });
    let close;
    for (const c of avail) {
      list.append(h('button', { type: 'button', class: 'pick-item', onclick: async () => {
        d.members.push({ id: c.id, name: c.name, sys_mode: 'full', sys_custom: '', book_embedded: true, book_linked: true });
        selected = c.id; close();
        await loadCard(c.id); renderMembers();
      } }, avatarEl(c, 'm-av'), h('span', {}, c.name)));
    }
    if (!avail.length) list.append(h('p', { class: 'muted' }, state.chars.length ? '所有角色都已經加入了。' : '還沒有角色，請先到首頁匯入或建立角色。'));
    close = overlayPanel('加入角色', list);
  }

  // 開場白：一串訊息，每則選擇由誰說（旁白、某位角色或你自己）；下方點頭像加入一則
  const openingList = h('div', { class: 'opening-list' });
  const openingAdd = h('div', { class: 'opening-add' });
  const myName = () => state.settings?.user_name || 'User';
  const speakerOpts = () => [['narrator', '旁白'], ...d.members.map(m => [m.id, (charOf(m.id) || m).name]), ['user', `${myName()}（你）`]];
  const speakerAv = (sp, cls) => sp === 'narrator' ? h('div', { class: 'avatar-ph narrator-av ' + cls }, icon('book-open'))
    : sp === 'user' ? userAvatarEl(cls, { global: true })
    : avatarEl({ ...(charOf(sp) || { name: '?' }), id: sp }, cls);
  function renderOpening() {
    const opts = speakerOpts();
    const valid = new Set(opts.map(o => o[0]));
    openingList.innerHTML = '';
    if (!d.opening.length) openingList.append(h('div', { class: 'empty muted' }, '還沒有開場白。', h('br'), '點下面的頭像加入第一則：可以由旁白開場，也可以讓某位角色或你自己先開口。'));
    // 和對話頁一樣的排版：頭像、上方的名字、對話框，你的訊息靠右；對話框裡直接編輯
    // 對話框隨內容長高：新版 Chrome / Edge 用 CSS field-sizing，舊版用 JS 補
    const autoSize = CSS.supports?.('field-sizing', 'content');
    const grow = ta => { if (autoSize || !ta.offsetParent) return; ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 2 + 'px'; };
    d.opening.forEach((o, i) => {
      const isUser = o.speaker === 'user', isNar = o.speaker === 'narrator';
      // 名字就是下拉選單：點名字可以改成別人說
      const sel = h('select', { class: 'op-who', title: '改成由誰說', onchange: e => { o.speaker = e.target.value; renderOpening(); } }, opts.map(([v, t]) => h('option', { value: v }, t)));
      if (!valid.has(o.speaker)) sel.append(h('option', { value: o.speaker }, '（已移出世界的角色，不會顯示）'));
      sel.value = o.speaker;
      const who = opts.find(x => x[0] === o.speaker)?.[1] || '';
      const ta = h('textarea', { class: 'op-text', rows: 1, value: o.content,
        placeholder: isNar ? '場景描寫、事件經過…' : isUser ? '你的行動或台詞…' : `${who} 的台詞與動作…` });
      ta.oninput = () => { o.content = ta.value; grow(ta); };
      ta.onfocus = () => grow(ta);
      const move = dir => { const j = i + dir; [d.opening[i], d.opening[j]] = [d.opening[j], d.opening[i]]; renderOpening(); };
      const btn = (label, title, fn, disabled) => h('button', { type: 'button', title, disabled, onclick: fn }, label);
      openingList.append(h('div', { class: 'msg op-msg ' + (isUser ? 'user' : 'bot') + (isNar ? ' narrator' : '') },
        speakerAv(o.speaker, 'mav'),
        h('div', { class: 'mcol' },
          h('div', { class: 'mhead' }, h('span', { class: 'mname' }, sel), h('span', { class: 'mtime' }, `開場 ${i + 1}`)),
          h('div', { class: 'mbody', onclick: () => ta.focus() }, ta),
          h('div', { class: 'mactions' },
            btn(icon('chevron-up'), '上移', () => move(-1), i === 0),
            btn(icon('chevron-down'), '下移', () => move(1), i === d.opening.length - 1),
            h('span', { class: 'sep' }),
            btn(ic('trash-2', '刪除'), '刪除這則', () => { d.opening.splice(i, 1); renderOpening(); })))));
      setTimeout(() => grow(ta), 0);
    });
    // 下方像對話頁的發言列：點頭像加入一則
    openingAdd.innerHTML = '';
    openingAdd.append(h('span', { class: 'sb-label' }, '加入一則'), ...opts.map(([v, t]) => h('button', { type: 'button', class: 'sb-btn', onclick: () => {
      d.opening.push({ speaker: v, content: '' }); renderOpening();
      const last = [...openingList.querySelectorAll('textarea')].at(-1);
      last?.focus(); last?.scrollIntoView({ block: 'nearest' });
    } }, speakerAv(v, 'sb-av'), h('span', {}, t))));
  }
  renderMembers();

  // 發言方式
  function turnPane() {
    const sel = (key, opts) => { const s = f[key] = h('select', {}, Object.entries(opts).map(([v, t]) => h('option', { value: v }, t))); s.value = String(d[key]); return s; };
    const numIn = (key, min, max) => (f[key] = h('input', { type: 'number', min, max, value: d[key] }));
    const chk = (key, label) => h('label', { class: 'check' }, f[key] = h('input', { type: 'checkbox', checked: !!d[key] }), label);
    const mode = sel('turn_mode', { turns: '輪流發言：每個角色各自說話，用自己的頭像與對話框', narrator: '旁白統一：一次寫出所有角色（較省 token）' });
    const turnOpts = h('div', { class: 'form' },
      h('div', { class: 'row' },
        h('label', {}, h('span', {}, '你說完話後，最多幾位角色接話'), numIn('max_replies', 1, 5)),
        h('label', {}, h('span', {}, '插話機率（%，導演規劃失敗、改用規則挑選時使用）'), numIn('interrupt_rate', 0, 100))),
      chk('allow_interrupt', '允許角色插話（打斷上一位角色）'),
      chk('cut_interrupt', '插話時把上一位的話從中間截斷'),
      h('p', { class: 'muted small-note' }, '輪流發言一律由「導演」先判斷誰在場，再決定這一輪由誰、依什麼順序、帶著什麼意圖發言，每個角色只看得到自己那一行（每輪多呼叫一次 AI）。導演不安排旁白（只有沒有任何角色在場時，才由旁白描寫場景）；需要時可以在對話頁輸入框上方點「旁白」，讓旁白描寫或統整場景。每多一位角色接話就多呼叫一次 AI。對話頁輸入框上方的頭像可以直接指定誰說話；生成中點別人的頭像＝讓他插話。'));
    const sync = () => (turnOpts.hidden = mode.value !== 'turns');
    mode.onchange = sync; sync();
    return h('div', { class: 'form' }, h('label', {}, h('span', {}, '發言模式'), mode), turnOpts);
  }

  // ---------- 整理角色卡規則：請 AI 把共用的扮演規則移到這頁的「規則與文風」，角色只保留自己的 ----------
  // 用編輯器目前（還沒存檔）的內容；結果先顯示預覽，可以修改，按「套用」才寫回編輯器（按「儲存」才存檔）
  const memberBody = () => ({ world_prompt: f.system_prompt.value, members: d.members.map(m => ({ id: m.id, sys_mode: m.sys_mode || 'full', sys_custom: m.sys_custom || '' })) });
  async function organizeRules() {
    let info;
    try { info = await api('POST', '/api/bigworlds/organize-rules', { ...memberBody(), estimate_only: true }); } catch (e) { return fail(e); }
    if (info.problem) {
      const go2 = await askConfirm(`還不能整理：${info.problem}\n整理角色卡規則需要呼叫 AI，請先到「設定 → API 設定」選擇供應商、填入金鑰並選好模型。\n前往設定頁會關閉這個視窗：世界設定還沒儲存的修改請先按「儲存」。`, { okText: '前往 API 設定', danger: false });
      if (go2) { closeModal(); state.settingsTab = 'system'; go('#/settings'); }
      return;
    }
    if (!info.members.length) return toast('沒有需要整理的角色規則：角色卡沒有系統提示，或都設成「不套用」', true, 5000);
    if (!await askConfirm(`整理角色卡規則\n會把 ${info.members.map(m => m.name).join('、')} 的系統提示交給 AI，把共用的扮演規則挑出來移到「規則與文風」，每位角色只保留和自己有關的內容。\n\n使用的模型：${info.model}\n預計送出：約 ${info.input_tokens.toLocaleString()} tokens（回覆通常再加 1,000～3,000 tokens）\n\n整理完會先顯示預覽，可以修改，確認後才套用。`, { okText: '開始整理' })) return;

    const ac = new AbortController();
    const wait = h('p', { class: 'muted' }, 'AI 整理中…（角色多、模型慢的時候可能要一兩分鐘）');
    const box = organizeOverlay('整理角色卡規則', h('div', { class: 'form' }, wait), () => ac.abort());
    let r;
    try {
      const res = await fetch('/api/bigworlds/organize-rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(memberBody()), signal: ac.signal });
      r = await res.json();
      if (!res.ok) throw new Error(r.error || '整理失敗');
    } catch (e) {
      if (e.name === 'AbortError') return;
      box.close(); return fail(e);
    }
    // ---------- 預覽：共用規則與每位角色保留的內容都可以修改 ----------
    const sharedIn = h('textarea', { rows: 7, value: r.shared, placeholder: '（沒有找到共用規則）' });
    const keepIns = r.results.map(x => ({ x, ta: h('textarea', { rows: 5, value: x.keep ?? x.original, placeholder: '（沒有專屬規則：套用後這位角色不帶任何角色卡規則）' }) }));
    const content = h('div', { class: 'form organize-preview' },
      r.conflicts.length ? h('div', { class: 'key-warning' }, h('b', {}, '⚠ AI 的說明：改寫的地方、各角色要求不同的規則（請對照下面的內容確認）'),
        ...r.conflicts.map(c => h('p', {}, '• ' + c))) : null,
      h('label', {}, h('span', {}, '移到「規則與文風」的共用規則（會加在原本內容的最後面）'), sharedIn),
      ...keepIns.map(({ x, ta }) => h('div', { class: 'organize-member' },
        h('label', {}, h('span', {}, `${x.name} 保留的規則` + (x.keep === null ? '（AI 沒有回傳這位角色的結果，先保留原本的內容）' : '')), ta),
        h('details', {}, h('summary', { class: 'muted small-note' }, '對照原本的內容'), h('pre', { class: 'organize-orig' }, x.original)))),
      h('p', { class: 'muted small-note' }, `使用 ${r.model}` + (r.usage ? `，實際用量：送出 ${r.usage.input.toLocaleString()}、回覆 ${r.usage.output.toLocaleString()} tokens` : '')
        + '。套用後，這些角色的「角色卡的系統提示」會改成「自訂」並換成上面保留的內容；角色卡本身不會被修改。按世界設定的「儲存」才會存檔。'),
      h('div', { class: 'ask-btns' },
        h('button', { type: 'button', onclick: () => box.close() }, '取消'),
        h('button', { type: 'button', class: 'primary', onclick: () => {
          const shared = sharedIn.value.trim();
          if (shared) f.system_prompt.value = f.system_prompt.value.trim() ? `${f.system_prompt.value.trimEnd()}\n\n${shared}` : shared;
          for (const { x, ta } of keepIns) {
            const m = d.members.find(mm => mm.id === x.id);
            if (m) { m.sys_mode = 'custom'; m.sys_custom = ta.value.trim(); }
          }
          box.close(); renderPanel();
          toast('已套用：共用規則已加到「規則與文風」，角色改成「自訂」。按「儲存」才會存檔', false, 6000);
        } }, '套用')));
    box.set(content);
  }
  /** 疊在世界設定上方的視窗（比選單寬）；關閉時呼叫 onClose */
  function organizeOverlay(title, content, onClose) {
    const body = h('div', {}, content);
    const close = () => { ov.remove(); onClose?.(); };
    const ov = h('div', { class: 'crop-overlay' },
      h('div', { class: 'crop-box organize-box' },
        h('div', { class: 'pick-head' }, h('h3', {}, title), h('button', { class: 'icon', title: '關閉', onclick: close }, icon('x'))),
        body));
    document.body.append(ov);
    return { close, set: el => { body.innerHTML = ''; body.append(el); } };
  }

  const panes = {
    '基本': h('div', { class: 'form' },
      h('div', { class: 'editor-top' }, coverBox, h('div', { class: 'form' },
        field('name', '世界名稱 *'),
        field('tags', '標籤（逗號分隔，只用來分類與搜尋）'))),
      h('div', { class: 'detail-label' }, '登場角色'),
      membersBox, memberPanel,
      field('setting', '世界設定', 10, '時代背景、地理與主要地點、勢力與組織、力量或魔法體系、歷史與重大事件、文化習俗等。每一輪都會送給 AI（角色、旁白與導演都看得到）；只偶爾提到的細節（某座城市、某個組織的內幕），放在「世界書」分頁用關鍵字觸發比較省 token。{{user}}、{{world}} 可用'),
      field('intro', '世界介紹（顯示在世界詳情，不會送給 AI）', 5)),
    '發言': turnPane(),
    '提示詞': h('div', { class: 'form' },
      field('system_prompt', '規則與文風', 12, '這個世界額外的規則與寫作風格（世界觀請寫在「基本」分頁的「世界設定」）；會接在主要系統提示與大世界系統提示後面。{{user}}、{{world}} 可用'),
      h('div', { class: 'organize-row' },
        h('button', { type: 'button', onclick: () => organizeRules().catch(fail) }, ic('sparkles', '整理角色卡規則（AI）')),
        h('span', { class: 'muted small-note' }, '角色卡的系統提示常混著共用的扮演規則（例如不替玩家說話、回應長度）。這個按鈕會請 AI 把共用的部分移到上面，角色只保留自己的規則，避免重複送出與互相衝突。會呼叫一次 AI，先顯示預覽，確認後才套用。')),
      field('post_history_instructions', '後置指令（選填，放在聊天紀錄之後，例如狀態欄格式提醒）', 5)),
    '狀態欄': statusEd.el,
    '世界書': bookPane,
    '開場白': h('div', { class: 'form' },
      h('p', { class: 'muted small-note' }, '新對話開始時，這些訊息會依序出現在聊天裡，各自用自己的頭像與對話框（由你自己寫，不會使用角色卡的開場白）。{{user}}、{{world}} 可用；清空聊天時會保留。'),
      h('div', { class: 'opening-chat' }, openingList, openingAdd)),
  };
  f.tags.value = (d.tags || []).join(', ');
  const { bar: tabBar, panes: paneEls } = tabsUI(Object.entries(panes));

  // 目前畫面上的內容（儲存與「有沒有還沒儲存的修改」共用）
  const collect = () => ({
      name: f.name.value.trim(), tags: f.tags.value.split(/[,，]/).map(s => s.trim()).filter(Boolean),
      intro: f.intro.value, setting: f.setting.value, system_prompt: f.system_prompt.value, post_history_instructions: f.post_history_instructions.value,
      opening: d.opening.filter(o => o.content.trim()).map(o => ({ speaker: o.speaker, content: o.content })),
      turn_mode: f.turn_mode.value,
      max_replies: Math.min(5, Math.max(1, +f.max_replies.value || 2)),
      allow_interrupt: f.allow_interrupt.checked, cut_interrupt: f.cut_interrupt.checked,
      interrupt_rate: Math.min(100, Math.max(0, +f.interrupt_rate.value || 0)),
      members: d.members.map(m => ({ id: m.id, sys_mode: m.sys_mode || 'full', sys_custom: m.sys_custom || '', public_info: m.public_info || '',
        book_embedded: m.book_embedded !== false, book_linked: m.book_linked !== false, book_off: m.book_off || [] })),
      world_ids: worldBookChecks.map(l => $('input', l)).filter(i => i.checked).map(i => i.value),
      character_book: wbook.entries.length ? { ...wbook, name: wbook.name || f.name.value.trim() } : null,
      status: statusLists.char_fields.length || statusLists.user_fields.length ? structuredClone(statusLists) : null,
  });
  const snap = () => JSON.stringify([collect(), cover.url || null, !!cover.remove]);
  let baseline = '';
  const save = async () => {
    const data = collect();
    if (!data.name) return toast('請輸入世界名稱', true);
    const statusErr = statusEd.check();
    if (statusErr) return toast(statusErr, true);
    try {
      const body = { data, cover: cover.url || undefined, remove_cover: cover.remove || undefined };
      // 打開之後在別處改過（card_stale）：讓你選仍要覆蓋、重新讀取或取消
      const put = force => api('PUT', `/api/bigworlds/${id}`, { ...body, base_ver: w.ver, ...(force ? { force: true } : {}) });
      let r;
      if (isNew) r = await api('POST', '/api/bigworlds', body);
      else {
        try { r = await put(false); } catch (e) {
          if (e.code !== 'card_stale') throw e;
          const pick = await askCardStale('世界卡');
          if (pick === 'force') r = await put(true);
          else { if (pick === 'cancel') closeModal(); else if (pick === 'reload') { closeModal(); openBigWorldEditor(id, { back }).catch(fail); } return; }
        }
      }
      closeModal(); toast(isNew ? '世界已建立' : '世界已儲存');
      if (!$('#chatView').hidden && state.char?.id === WORLD_PREFIX + r.id) await enterChat(state.char.id, state.chatId);
      else await loadChars();
    } catch (e) { fail(e); }
  };
  const foot = [];
  if (!isNew) foot.push(h('div', { class: 'left' }, h('button', { class: 'danger', onclick: async () => {
    if (!await askConfirm(`刪除世界「${w.name}」？\n這個世界的所有對話與記憶都會一起移到垃圾桶，${trashDaysText()}角色卡不受影響。`)) return;
    try { await api('DELETE', `/api/bigworlds/${id}`); } catch (e) { return fail(e); } // 刪除失敗：視窗留著，不顯示成功
    closeModal(); toast('已刪除世界'); go('#/');
  } }, ic('trash-2', '刪除世界'))));
  foot.push(h('button', { 'data-close': true }, '取消'), h('button', { class: 'primary', onclick: save }, '儲存'));
  baseline = snap();
  openModal(isNew ? '創建世界' : `世界設定：${w.name}`, h('div', {}, tabBar, ...paneEls), foot, { wide: true, fixed: true, back, dirty: () => snap() !== baseline });
}

// 「開始新對話」「繼續對話」兩顆按鈕（首頁卡片與角色詳情共用）
function chatButtons(c, after) {
  const run = fn => () => { after?.(); fn(); };
  return h('div', { class: 'c-actions' },
    h('button', { class: 'success', title: '與這個角色開一段新對話', onclick: run(() => startNewChat(c.id)) }, ic('play', '開始對話')),
    h('button', {
      class: 'primary', disabled: !c.last_chat,
      title: c.last_chat ? `繼續「${c.last_chat.title}」` : '還沒有對話',
      onclick: run(() => go(`#/chat/${c.id}/${c.last_chat.id}`)),
    }, ic('message-circle', '繼續')));
}

/** 把 {{char}}／<BOT> 換成指定角色的名稱、{{user}}／<USER> 換成你的名字 */
const nameMacros = (t, charName) => String(t || '')
  .replace(/\{\{char\}\}|<BOT>/gi, () => charName || '') // 用函式：名字裡的 $ 照原樣
  .replace(/\{\{user\}\}|<USER>/gi, () => state.settings?.user_name || 'User');

/** 點標籤：關掉詳情、回到首頁，把標籤填進「搜尋角色或標籤」 */
function searchTag(t) {
  closeModal();
  $('#charSearch').value = t;
  if ($('#homeView').hidden) go('#/'); // 從對話頁等其他頁面打開的：回首頁時會用搜尋框的內容篩選
  else renderHome();
  $('#homeView').scrollTop = 0;
}
/** 可以點的標籤（詳情頁用） */
const tagLink = t => h('span', {
  class: 'tag tag-link', role: 'button', tabindex: 0, title: `搜尋「${t}」`,
  onclick: () => searchTag(t), onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); searchTag(t); } },
}, t);

/**
 * 詳情視窗右上角（編輯按鈕左邊）的順序 ID：首頁排序選「自訂ID排序」時由小到大排列。
 * 點一下變成輸入框：Enter 或點別的地方儲存，Esc 取消；留空＝不指定
 */
const ORDER_MAX = 9999; // 和伺服器的上限一致
/** look：外觀（首頁卡片左上角的小框用 card: true；預設是詳情視窗的樣式） */
function orderTag(kind, id, current, look = {}) {
  let cur = Number.isInteger(current) ? current : null;
  const el = h('button', { type: 'button', class: look.card ? 'card-order' : 'order-tag', title: '順序 ID：首頁的排序選「自訂ID排序」時，由小到大排列（一樣大時照加入的時間）。點一下修改，留空＝不指定' });
  const show = look.card
    ? () => { el.textContent = cur ?? '－'; el.classList.toggle('none', cur === null); }
    : () => { el.textContent = `ID：${cur ?? '—'}`; };
  show();
  el.onclick = () => {
    // 只能輸入數字、最多 4 位（0～9999），打不出超過上限的值
    const input = h('input', { type: 'text', inputmode: 'numeric', maxlength: String(ORDER_MAX).length, class: look.card ? 'order-input card-order-input' : 'order-input', value: cur ?? '', placeholder: '—', 'aria-label': `順序 ID（0～${ORDER_MAX}）`, title: `0～${ORDER_MAX}，留空＝不指定` });
    input.addEventListener('input', () => { const v = input.value.replace(/\D/g, '').slice(0, String(ORDER_MAX).length); if (v !== input.value) input.value = v; });
    let done = false;
    const finish = async save => {
      if (done) return; done = true;
      const raw = input.value.trim();
      input.replaceWith(el);
      if (!save) return;
      const v = raw === '' ? null : Number(raw);
      if (v !== null && !(Number.isInteger(v) && v >= 0 && v <= ORDER_MAX)) return toast(`順序 ID 要是 0～${ORDER_MAX} 的整數；留空＝不指定`, true);
      if (v === cur) return;
      try {
        const r = await api('PUT', `/api/${kind === 'bigworld' ? 'bigworlds' : 'characters'}/${id}/order`, { order: v });
        cur = r.order; show();
        const item = ((kind === 'bigworld' ? state.bigworlds : state.chars) || []).find(x => x.id === id);
        if (item) item.order = cur;
        if (!$('#homeView').hidden) renderHome();
        toast(cur === null ? '已清除順序 ID' : `順序 ID 改成 ${cur}`);
      } catch (e) { fail(e); }
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); } // 只取消編輯，不關掉視窗
    });
    input.addEventListener('blur', () => finish(true));
    el.replaceWith(input); input.focus(); input.select();
  };
  return el;
}

// 角色詳情：封面、頭像、標籤、角色介紹
/** back：按上一頁時回到哪個視窗（從世界介紹點成員打開時回到世界介紹） */
/**
 * 角色詳情的卡片 token 估算（和送出時同一套算法，見 core.js 的 estTok）：
 * 角色設定＝每次對話都會送出的欄位；開場白＝主要開場白（會成為聊天紀錄的第一則）；世界書＝內嵌條目，關鍵字觸發時才送
 */
function cardTokens(d, extra = null) { // extra：放在同一列最右邊的東西（匯入對話的小按鈕）
  const name = d.name || '';
  const t = s => estTok(String(s || '').replace(/\{\{char\}\}|<BOT>/gi, name).replace(/\{\{user\}\}|<USER>/gi, state.settings?.user_name || 'User'));
  const core = ['description', 'personality', 'scenario', 'system_prompt', 'post_history_instructions', 'mes_example'].reduce((s, k) => s + t(d[k]), 0);
  const greet = t(d.first_mes);
  const entries = (d.character_book?.entries || []).filter(e => e.enabled !== false && String(e.content || '').trim());
  const book = entries.reduce((s, e) => s + t(e.content), 0);
  const n = x => x.toLocaleString();
  const alts = (d.alternate_greetings || []).filter(g => g.trim()).length;
  const part = (label, v, note) => h('span', { class: 'dt-part' }, label, ' ', h('b', {}, n(v)), note ? h('span', { class: 'muted' }, note) : null);
  return h('div', { class: 'detail-tokens', title: '估算值，實際數字依模型而不同。\n角色設定：描述、個性、情境、系統提示、後置指令、對話範例，每次生成都會送出（大世界不送情境）。\n開場白：主要開場白，會成為聊天紀錄的第一則。\n世界書：角色內嵌的條目，對話出現關鍵字時才送出。' },
    h('span', { class: 'dt-total' }, icon('file-text'), `卡片約 ${n(core + greet)} tokens`),
    part('角色設定', core),
    part('開場白', greet, alts ? `（另有 ${alts} 則備用）` : ''),
    entries.length ? part('世界書', book, `（${entries.length} 條，觸發時才送）`) : null,
    extra);
}

async function openCharDetail(id, { back } = {}) {
  const ch = await api('GET', `/api/characters/${id}`);
  if (!state.chars.some(c => c.id === id)) state.chars = await api('GET', '/api/characters').catch(() => state.chars);
  const info = state.chars.find(c => c.id === id) || { id, name: ch.data.name, ...ch };
  const d = ch.data, tags = d.tags || [];
  const edit = h('button', { class: 'detail-edit', title: '編輯角色', onclick: () => { closeModal(); openCharEditor(ch, { back: () => openCharDetail(id, { back }) }); } }, ic('pencil', '編輯角色'));
  const body = h('div', { class: 'char-detail' }, h('div', { class: 'detail-tools' }, orderTag('char', id, ch.order), edit),
    h('div', { class: 'detail-top' },
      h('div', { class: 'detail-imgs' },
        zoomable(coverEl(ch, 'detail-cover')),
        h('div', { class: 'detail-av' }, zoomable(avatarEl(ch, 'detail-avatar')), h('span', {}, ch.has_avatar ? '頭像' : '頭像（使用封面）'))),
      h('div', { class: 'detail-info' },
        h('div', { class: 'detail-name' }, d.name),
        h('div', { class: 'c-meta' }, info.chat_count ? `${info.chat_count} 段對話｜最後：${fmtTime(info.last_chat.updated)}` : '尚未對話'),
        h('div', { class: 'detail-tags' }, tags.length ? tags.map(tagLink) : h('span', { class: 'muted' }, '沒有標籤')),
        h('div', { class: 'detail-label' }, '角色介紹'),
        d.creator_notes?.trim()
          ? h('div', { class: 'detail-intro mtext', html: formatText(nameMacros(d.creator_notes, d.name)) })
          : h('div', { class: 'detail-intro muted' }, '（還沒有介紹，可以按「編輯角色」填寫）'))),
    chatButtons(info, closeModal),
    cardTokens(d, importChatBtn(id)));
  openModal(d.name, body, [], { esc: true, back });
}

$('#btnImport').onclick = () => $('#fileImport').click();
$('#fileImport').onchange = async e => {
  const files = [...e.target.files]; e.target.value = '';
  for (const f of files) {
    try {
      const r = await api('POST', '/api/characters/import', f, { 'X-Filename': encodeURIComponent(f.name) });
      // 角色卡 V3／.charx 帶來的表情圖：匯入幾張、略過哪些（和原因）
      const ex = r.expressions || { added: [], skipped: [] };
      toast(`已匯入：${r.name}` + (ex.added.length ? `（含 ${ex.added.length} 張表情圖）` : ''));
      if (ex.skipped.length) toast(`${r.name}：有 ${ex.skipped.length} 張圖片沒有匯入\n` + ex.skipped.slice(0, 5).map(x => `・${x.file}：${x.reason}`).join('\n') + (ex.skipped.length > 5 ? '\n…' : ''), true, 8000);
    } catch (err) { toast(`${f.name}：${err.message}`, true); }
  }
  if ($('#homeView').hidden) go('#/'); else await loadChars();
};
// 拖放匯入：只在首頁，而且只收從電腦拖進來的檔案。
// 頁面裡的圖片（頭像、表情圖）拖動時瀏覽器也會當成檔案，要排除，不然在對話頁拖到圖片就會跳出匯入失敗
let dragFromPage = false;
document.addEventListener('dragstart', () => { dragFromPage = true; });
document.addEventListener('dragend', () => { dragFromPage = false; });
const canDropImport = () => !dragFromPage && !$('#homeView').hidden && $('#modal').hidden;
document.addEventListener('dragover', e => {
  if (!e.dataTransfer.types.includes('Files') || !$('#modal').hidden) return;
  // 一律攔下（檔案拖到別的頁面放開時，瀏覽器才不會直接打開它、離開酒館）；不能匯入的地方游標顯示「不能放」
  e.preventDefault();
  e.dataTransfer.dropEffect = canDropImport() ? 'copy' : 'none';
});
document.addEventListener('drop', e => {
  if (!e.dataTransfer.files.length || !$('#modal').hidden) return;
  e.preventDefault();
  if (!canDropImport()) { dragFromPage = false; return; }
  const dt = new DataTransfer(); [...e.dataTransfer.files].forEach(f => dt.items.add(f));
  $('#fileImport').files = dt.files; $('#fileImport').onchange({ target: $('#fileImport') });
});

// 開新對話：有多個開場白時先選擇
async function startNewChat(charId) {
  // 大世界：先選這段對話的發言模式（開始後就固定）；開場白只有一個
  if (isWorldKey(charId)) {
    const w = await api('GET', `/api/bigworlds/${charId.slice(WORLD_PREFIX.length)}`);
    // 先選取（預設選世界的預設模式），按「開始對話」才建立
    let picked = w.turn_mode === 'narrator' ? 'narrator' : 'turns';
    const create = async () => {
      closeModal();
      const chat = await api('POST', `/api/characters/${charId}/chats`, { turn_mode: picked }).catch(fail);
      if (chat) go(`#/chat/${charId}/${chat.id}`);
    };
    const items = [];
    const opt = (mode, title, sub) => {
      const radio = h('input', { type: 'radio', name: 'turn-mode-pick', value: mode, checked: picked === mode });
      const it = h('label', { class: 'item mode-pick' + (picked === mode ? ' picked' : '') }, radio,
        h('div', { class: 'grow' },
          h('div', { class: 'title' }, title, w.turn_mode === mode ? h('span', { class: 'tag' }, '世界預設') : null),
          h('div', { class: 'sub' }, sub)));
      radio.onchange = () => { picked = mode; items.forEach(x => x.classList.toggle('picked', x === it)); };
      items.push(it);
      return it;
    };
    openModal(`開始對話：${w.name}`, h('div', {},
      h('p', { class: 'muted small-note' }, '選擇這段對話的發言模式，開始後就不能更改。'),
      h('div', { class: 'list' },
        opt('turns', '輪流發言', '每個角色各自說話，用自己的頭像與對話框；可以插話，旁白可統整場景。'),
        opt('narrator', '旁白統一', '由旁白一次寫出所有角色的言行，比較省 token。'))),
      [h('button', { 'data-close': true }, '取消'), h('button', { class: 'primary', onclick: create }, '開始對話')]);
    return;
  }
  const ch = state.char?.id === charId ? state.char : await api('GET', `/api/characters/${charId}`);
  const d = ch.data;
  const greetings = [d.first_mes, ...(d.alternate_greetings || [])].filter(Boolean);
  const create = async i => {
    const chat = await api('POST', `/api/characters/${charId}/chats`, { greeting: i });
    go(`#/chat/${charId}/${chat.id}`);
  };
  if (greetings.length <= 1) return create(0).catch(fail);
  const nameSub = t => String(t || '').replace(/\{\{char\}\}|<BOT>/gi, () => d.name).replace(/\{\{user\}\}|<USER>/gi, () => state.settings?.user_name || 'User');
  const plain = t => nameSub(t).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  // 先選取（預設主要開場白），下方預覽完整內容，按「開始對話」才建立
  let picked = 0;
  const preview = h('div', { class: 'greet-preview mtext' });
  const items = [];
  const pick = i => {
    picked = i;
    items.forEach((it, k) => { it.classList.toggle('picked', k === i); it.querySelector('input').checked = k === i; });
    preview.innerHTML = formatText(nameSub(greetings[i])); preview.scrollTop = 0;
  };
  const list = h('div', { class: 'list greet-list' }, greetings.map((g, i) => {
    const radio = h('input', { type: 'radio', name: 'greeting-pick' });
    radio.onchange = () => pick(i);
    const it = h('label', { class: 'item mode-pick' }, radio,
      h('div', { class: 'grow' },
        h('div', { class: 'title' }, i === 0 ? '主要開場白' : `備用開場白 ${i}`), h('div', { class: 'sub clamp2' }, plain(g).slice(0, 200))));
    items.push(it);
    return it;
  }));
  pick(0);
  openModal(`選擇開場白：${d.name}`, h('div', { class: 'form' },
    list, h('div', { class: 'greet-preview-label muted small-note' }, '預覽'), preview),
    [h('button', { onclick: closeModal }, '取消'), h('button', { class: 'primary', onclick: () => { closeModal(); create(picked).catch(fail); } }, '開始對話')], { wide: true });
}

