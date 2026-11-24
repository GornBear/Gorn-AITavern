// 大世界「輪流發言」：導演規劃、在場判斷、插話，以及角色依序發言的流程
// （server.js 負責實際呼叫 AI 與存檔，這裡只處理「這一輪誰說、帶著什麼指示說」）
'use strict';

const NARRATOR = 'narrator';
const DIRECTOR_MAX_TOKENS = 3000; // 導演回應上限（含思考）
const DIRECTOR_TEMPERATURE = 0.75; // 導演固定的溫度：比聊天低一點，照格式規劃比較穩定，安排也不會太死板

/** 依規則挑下一位發言的角色：被點名 > 很久沒說話 > 隨機；避免同一個角色連續發言（導演規劃失敗時使用） */
function chooseNextSpeaker(members, messages, lastSpeaker) {
  if (!members.length) return NARRATOR;
  if (members.length === 1) return members[0].id;
  const lastText = String(messages[messages.length - 1]?.content || '');
  const scored = members.map(m => {
    let score = Math.random();
    if (lastText.includes(m.card.name)) score += 3; // 被提到
    // 距離上次發言隔了幾則（越久越優先）
    let gap = 0;
    for (let i = messages.length - 1; i >= 0 && gap < 8; i--, gap++) if (messages[i].speaker === m.id) break;
    score += gap * 0.4;
    if (m.id === lastSpeaker) score -= 10;
    return { id: m.id, score };
  });
  return scored.sort((a, b) => b.score - a.score)[0].id;
}

/** 插話時把上一位角色的話從句子中間截斷 */
function cutMessage(msg) {
  const t = msg.content;
  const lo = Math.floor(t.length * 0.4), hi = Math.floor(t.length * 0.8);
  const marks = [];
  for (let i = lo; i < hi; i++) if ('。！？…，」\n'.includes(t[i])) marks.push(i + 1);
  if (!marks.length) return false;
  msg.content = t.slice(0, marks[Math.floor(Math.random() * marks.length)]).replace(/[，\s]+$/, '') + '——';
  if (msg.swipes) msg.swipes[msg.swipe_id ?? 0] = msg.content;
  msg.interrupted = true;
  return true;
}

/** 模型常會順手替別人寫台詞：去掉開頭的自己名字，並在出現其他人的「名字：」時截斷 */
function cleanSpeakerText(text, selfName, otherNames) {
  let t = String(text || '');
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  t = t.replace(new RegExp(`^\\s*(${esc(selfName)}|旁白)\\s*[:：]\\s*`), '');
  const others = otherNames.filter(Boolean).map(esc);
  if (others.length) {
    const m = new RegExp(`\\n\\s*(${others.join('|')})\\s*[:：]`).exec(t);
    if (m && m.index > 0) t = t.slice(0, m.index);
  }
  return t.trim();
}

/** 給導演的指示：先判斷誰在場，再排出這一輪誰、依序、帶著什麼意圖發言（不寫台詞） */
function directorInstruction({ names, maxReplies, user, prevNames, allowInterrupt, narration }) {
  return [
    '[導演指示：這一段只用來規劃，不會給讀者看]',
    `你是這場多角色角色扮演的導演。請規劃「接下來這一輪」的發展，讓劇情通順、角色的反應彼此銜接。`,
    `這個世界的角色：${names.join('、')}。發言的角色最多 ${maxReplies} 位。`,
    prevNames ? `上一輪記錄的在場角色：${prevNames.length ? prevNames.join('、') : '無'}（依最新的劇情重新判斷，有人離開或到來就更新）。` : '',
    `請先判斷此刻誰在場：和 ${user} 在同一個地點、看得到或聽得到這一幕的角色才算；已經離開、還沒出現、人在別處的都不算在場。`,
    '只用以下格式輸出，不要寫出台詞本身，也不要任何說明：',
    '在場：（此刻在場的角色名，用「、」分隔；一個都沒有就寫「無」）',
    '重點：（這一輪劇情的方向，一句話）',
    '1. 角色名：（這位角色這次要做什麼、說什麼的意圖，一句話）',
    '2. 角色名：（……）',
    '規則：',
    '- 只安排在場的角色發言。不在場的角色聽不到也看不到這一幕，不能回應、也不會突然插嘴。',
    '- 只有劇情確實需要、而且有合理的理由（被叫來、約好在這裡、剛好經過、聽到動靜趕來等），才讓不在場的角色登場：在那一行最後加上「（登場）」，意圖要寫出他怎麼出現。一輪最多一位登場；沒有必要就不要安排。',
    '- 角色在這一輪離開現場時，在那一行最後加上「（離場）」。',
    `- 第一位要回應 ${user} 剛才的行動；之後的角色要接續前一位的話。`,
    // 玩家寫的旁白常會描寫角色的動作：那是已經發生的事，要由那位角色接著演下去
    narration ? `- ${user} 最新的內容裡有旁白（標註「旁白，由${user}撰寫」）：旁白寫的事已經發生了。旁白寫到哪位角色的動作或處境，就讓那位角色先發言，意圖寫成「延續旁白裡的動作、演出接下來的發展」；不要安排和旁白矛盾、或忽略旁白的行動。` : '',
    '- 依劇情決定誰該說話，不需要每個在場的角色都發言；同一個角色不要連續出現。',
    '- 每一行的意圖只寫該角色自己知道的事，不要把其他角色的秘密、身世或內心想法寫進去。',
    allowInterrupt ? '- 如果某位角色會打斷前一位，在那一行最後加上「（插話）」。' : '',
    // 配角由發言的角色在自己那一則順手帶出（角色的指示允許寫配角），導演不必另外安排；
    // 導演偶爾主動寫「旁白：…（配角）」時，程式照樣保留那一行（見 parsePlan）
    '- 有角色發言時不要安排旁白；只有沒有任何角色在場、也沒有人需要登場時，才只寫一行「旁白：……」，描寫場景與周遭的反應。',
    '- 攤販、路人、家人朋友等配角不用另外安排，發言的角色會在自己那一則帶出他們；需要的話，可以把配角寫進那位角色的意圖裡（例如「和攤販討價還價」）。',
    `- 不要安排 ${user} 的行動。`,
  ].filter(Boolean).join('\n');
}

/**
 * 解析導演的規劃。回傳 { raw, focus, steps: [{ speaker, intent, interrupt, enter, leave }], present: [id] | null }；
 * 看不懂（沒有可用的角色，也沒有「在場」行）時回傳 null，改用規則挑選。
 */
function parsePlan(raw, members, maxReplies) {
  const focus = (raw.match(/重點\s*[:：]\s*(.+)/) || [])[1] || '';
  const norm = s => String(s).replace(/[*【】\[\]「」\s]/g, '');
  const byName = nm => members.find(x => norm(x.card.name) === norm(nm))?.id;
  // 在場：沒有這一行（舊格式）＝不限制
  const pm = raw.match(/^\s*[*【\[]*在場[*】\]]*\s*[:：]\s*(.*)$/m);
  const present = pm ? new Set(pm[1].split(/[、,，/／;；]+/).map(byName).filter(Boolean)) : null;
  const steps = [];
  let entered = 0;
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(?:\d+\s*[.、)）]\s*)?[*【\[]*([^:：*】\]]{1,20}?)[*】\]]*\s*[:：]\s*(.+)$/);
    if (!m) continue;
    const nm = m[1].trim();
    if (nm === '重點' || nm === '在場') continue;
    const sp = nm === '旁白' ? NARRATOR : byName(nm);
    if (!sp) continue;
    // 行尾的標記：（插話）（登場）（離場），順序不拘
    let intent = m[2].trim();
    const tags = new Set();
    for (let t; (t = intent.match(/[（(]\s*(插話|登場|離場|配角)\s*[）)]\s*$/));) { tags.add(t[1]); intent = intent.slice(0, t.index).trim(); }
    const st = { speaker: sp, intent, interrupt: tags.has('插話'), enter: false, leave: tags.has('離場'), npc: tags.has('配角') };
    if (sp !== NARRATOR && present && !present.has(sp)) {
      // 不在場的角色：只有標了（登場）才讓他出現，一輪最多一位
      if (!tags.has('登場') || entered) continue;
      present.add(sp); st.enter = true; entered++;
    }
    if (steps.length && steps[steps.length - 1].speaker === sp) continue;
    steps.push(st);
  }
  // 有角色發言時，旁白只留一行「標了（配角）」的（演出攤販、路人、家人朋友等配角），放在導演安排的位置；沒標的旁白照舊拿掉。
  // 這一行不算進「每輪最多幾位角色接話」，不會擠掉正式角色
  let count = 0, narr = 0;
  let limited = steps.filter(s => (s.speaker === NARRATOR ? s.npc && narr++ === 0 : ++count <= maxReplies));
  if (!limited.some(s => s.speaker !== NARRATOR)) {
    if (!present) return null; // 舊格式又沒有角色可用：改用規則
    // 沒有角色在場：由旁白描寫場景
    limited = [steps.find(s => s.speaker === NARRATOR) || { speaker: NARRATOR, intent: '', interrupt: false }];
  }
  return { raw, focus, steps: limited, present: present ? [...present] : null };
}

/**
 * 跑一輪輪流發言。env：
 *   chat, owner, world, user（玩家名稱）, userAction（玩家最新的行動）
 *   forced：指定由誰發言（發言列），interrupt：生成中點別人＝插話
 *   speak(speakerId, note)：生成一則訊息；save()；emit(event)
 *   direct(instruction)：請導演規劃，回傳導演寫的文字（失敗時丟出錯誤）
 */
async function playRound(env) {
  const { chat, owner, world, user, userAction, narration, forced, interrupt, save, emit } = env;
  const members = owner.members;
  const maxReplies = forced ? 1 : Math.min(5, Math.max(1, world.max_replies | 0 || 2));
  let lastSpeaker = [...chat.messages].reverse().find(m => m.role === 'assistant')?.speaker;
  // 每則角色訊息記下「說完之後誰在場」（present_after）：刪掉或重新生成後面的訊息時，可以回到當時的在場狀態
  const markAfter = t => { if (t && typeof t === 'object') { t.present_after = Array.isArray(chat.present) ? [...chat.present] : null; save(); } };
  const speak = async (sp, note) => { const t = await env.speak(sp, note); lastSpeaker = sp; return t; };

  // 銜接指示：讓每一則接得上前一則，不要各自重新開始
  // npc：這一則旁白是夾在角色之間、演出配角的（有角色發言的輪次裡導演安排的那一行旁白）
  // 在你之前、玩家上一次行動之後已經發言的人（依序、不重複）：後面的角色要以他們做過的事為準，
  // 不然每個人都直接回應玩家的行動，各自做出一樣的判斷，或無視前一位造成的變化
  const spokeSince = () => {
    const out = [];
    for (let i = chat.messages.length - 1; i >= 0 && chat.messages[i].role !== 'user'; i--) {
      const m = chat.messages[i];
      const n = m.role === 'assistant' && String(m.content || '').trim() ? owner.speakerName(m.speaker || NARRATOR) : '';
      if (n && !out.includes(n)) out.unshift(n);
    }
    return out;
  };
  const flowNote = (first, sp, npc = false) => {
    const before = first ? [] : spokeSince();
    return [
    userAction ? (before.length ? `這一輪開始時 ${user} 的行動／發言（之後已經有人回應）：「${userAction}」` : `${user} 最新的行動／發言：「${userAction}」`) : '',
    before.length ? `在你之前，${before.join('、')} 已經接著發言、行動了（聊天紀錄最後的${before.length > 1 ? '幾則' : '那則'}）。那些都已經發生：場景、人與物的位置、做出的決定，一律以那之後的狀態為準。`
      + `接著他們的言行反應；不要重複他們已經做過的判斷或行動，也不要無視他們帶來的變化。導演的安排和已經發生的事對不上時，以已經發生的事為準。` : '',
    // 玩家寫的旁白：寫到這位角色的動作，就是他剛剛做的事，要接著演，而不是當成別人的行動來回應
    narration && sp !== NARRATOR ? `${user} 寫的旁白是已經發生的事。旁白裡寫到 ${owner.speakerName(sp)} 的動作、處境或感受時，那就是你剛剛做的事、你現在的狀態：從那裡接著演下去（延續那個動作、演出它的結果與你的反應），不要忽略、推翻或重做一遍。` : '',
    sp === NARRATOR && npc ? `以旁白演出配角：照這一輪的安排寫出配角的動作與台詞，${first ? `直接回應 ${user} 剛才的行動` : '接續上一則訊息'}；場景描寫點到為止，不要替這個世界的角色說話。`
      : sp === NARRATOR ? `以旁白描寫場景：統整剛才發生的事，把場面自然地帶到下一步，留下讓 ${user} 行動的空間。`
      : first ? `你是這一輪第一位回應的人：直接回應 ${user} 剛才的行動${narration ? '與旁白' : ''}，可以推進劇情。`
      : '接續上一則訊息，直接回應剛才發言的人；以反應為主，不要另起新的劇情發展。',
    '不要重新描寫前面已經描寫過的場景與環境，也不要重複別人說過的話。',
    ].filter(Boolean).join('\n');
  };

  // 在場角色：導演每輪判斷後存在 chat.present（成員 id）；不是陣列＝還不知道，不限制
  const memberIds = new Set(members.map(m => m.id));
  const knownPresent = () => (Array.isArray(chat.present) ? chat.present.filter(x => memberIds.has(x)) : null);
  const presentNote = ids => `目前在場：${[user, ...ids.map(x => owner.speakerName(x))].join('、')}。不在場的角色看不到也聽不到這一幕，不要和他們說話或等他們回應。`;

  // 插話：依設定把上一位的話截斷，並告訴這一位他打斷了誰
  const interruptNote = sp => {
    const prev = chat.messages[chat.messages.length - 1];
    if (prev?.role !== 'assistant' || !prev.speaker || prev.speaker === sp) return '';
    if (world.cut_interrupt && cutMessage(prev)) {
      save(); emit({ type: 'msg_update', message_index: chat.messages.indexOf(prev), message: prev });
      return `${owner.speakerName(sp)} 在 ${owner.speakerName(prev.speaker)} 說到一半時打斷了對方。`;
    }
    return `${owner.speakerName(sp)} 插話，打斷或搶過 ${owner.speakerName(prev.speaker)} 的話頭。`;
  };

  if (forced) {
    // 指定由誰發言（發言列）：只生成一則
    const prev = chat.messages[chat.messages.length - 1];
    let note = flowNote(prev?.role === 'user', forced);
    if (interrupt && prev?.role === 'assistant' && prev.speaker && prev.speaker !== forced)
      note += `\n${owner.speakerName(forced)} 打斷了 ${owner.speakerName(prev.speaker)} 的話，直接插話。`;
    // 你指定了不在場的角色：讓他登場
    const known = knownPresent();
    if (known && forced !== NARRATOR && !known.includes(forced)) {
      known.push(forced); chat.present = known;
      note += '\n你原本不在現場：先寫出你怎麼出現在這裡，再回應。';
    }
    if (known) note += '\n' + presentNote(known);
    return markAfter(await speak(forced, note));
  }

  // 導演規劃；規劃失敗或看不懂時改用規則挑選發言者
  let plan = null;
  if (members.length) {
    const prev = knownPresent();
    const instr = directorInstruction({
      names: members.map(m => m.card.name), maxReplies, user, allowInterrupt: world.allow_interrupt, narration,
      prevNames: prev ? prev.map(x => owner.speakerName(x)) : null,
    });
    try { plan = parsePlan(await env.direct(instr), members, maxReplies); }
    catch (e) { if (env.aborted?.()) throw e; console.warn('[導演]', e.message || e); }
  }

  if (plan) {
    // 導演回報了在場角色時，記下來（下一輪的參考、規則挑選時的依據）
    const here = plan.present ? [...plan.present] : null;
    if (here) { chat.present = here; save(); }
    const onlyNarrator = plan.steps.every(s => s.speaker === NARRATOR); // 沒有角色發言：旁白描寫場景
    for (let i = 0; i < plan.steps.length; i++) {
      const st = plan.steps[i];
      let note = flowNote(i === 0, st.speaker, st.speaker === NARRATOR && !onlyNarrator);
      if (st.enter) note += '\n你這一輪才登場：先寫出你怎麼出現在這裡，再回應。';
      if (st.leave) note += '\n這一輪你會離開現場。';
      if (st.intent) note += `\n這一輪你的方向（導演在這一輪開始前的安排，只有你看得到；用自己的方式演出，不要照抄${i > 0 ? '，並依前面已經發生的事調整' : ''}）：${st.intent}`;
      if (st.speaker === NARRATOR) {
        if (plan.focus) note += `\n這一輪的重點：${plan.focus}`;
        if (here && onlyNarrator) note += `\n現在沒有角色在場：描寫場景，以及周遭對 ${user} 行動的反應，不要讓任何角色說話。`;
      }
      if (i > 0 && st.interrupt && world.allow_interrupt) note += '\n' + interruptNote(st.speaker);
      if (here) note += '\n' + presentNote(here);
      const t = await speak(st.speaker, note);
      // 離場：只移除那位角色（找不到時 indexOf 是 -1，splice(-1) 會誤刪最後一位，所以要先確認）
      if (here && st.leave && here.includes(st.speaker)) { here.splice(here.indexOf(st.speaker), 1); chat.present = [...here]; }
      markAfter(t);
    }
    return;
  }

  // 規則挑選（只從在場的角色裡挑）：被點名的優先、比較久沒說話的優先；被點名一定接話，否則一半機率
  const known = knownPresent();
  const pool = known ? members.filter(m => known.includes(m.id)) : members;
  for (let i = 0; i < maxReplies; i++) {
    const prev = chat.messages[chat.messages.length - 1];
    let sp;
    if (i === 0) sp = chooseNextSpeaker(pool, chat.messages, prev?.role === 'user' ? null : lastSpeaker);
    else {
      const mentioned = pool.some(m => m.id !== lastSpeaker && String(prev?.content || '').includes(m.card.name));
      if (!mentioned && Math.random() >= 0.5) break;
      sp = chooseNextSpeaker(pool, chat.messages, lastSpeaker);
      if (sp === lastSpeaker) break;
    }
    let note = flowNote(i === 0, sp);
    if (i > 0 && world.allow_interrupt && Math.random() * 100 < (world.interrupt_rate ?? 25)) note += '\n' + interruptNote(sp);
    if (known) note += '\n' + presentNote(known);
    markAfter(await speak(sp, note));
    if (sp === NARRATOR) break;
  }
}

/**
 * 生成前把在場角色對回目前的訊息（chat.present 只有一份，刪掉或重新生成訊息時不會自己回去）：
 * - 重新生成最後一則：回到那則訊息說話前的狀態（present_before）——例如那則原本寫了離場，重新生成時他還在場
 * - 其他：用最後一則記錄了 present_after 的角色訊息（後面的訊息被刪掉時，回到那時候的狀態）
 * 舊對話的訊息沒有這些記錄：維持原本的 chat.present
 */
function restorePresent(chat, regenerate) {
  const msgs = chat.messages || [];
  const copy = v => (Array.isArray(v) ? [...v] : null);
  const last = msgs[msgs.length - 1];
  if (regenerate && last?.role === 'assistant' && 'present_before' in last) { chat.present = copy(last.present_before); return; }
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'assistant' && 'present_after' in m) { chat.present = copy(m.present_after); return; }
  }
}

module.exports = { NARRATOR, DIRECTOR_MAX_TOKENS, DIRECTOR_TEMPERATURE, cleanSpeakerText, playRound, parsePlan, restorePresent };
