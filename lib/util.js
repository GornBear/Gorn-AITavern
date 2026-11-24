// 伺服器共用的小工具（避免同樣的寫法散在好幾個檔案，改一處漏一處）
'use strict';

/**
 * 拿掉 <think>…</think> 或 <thinking>…</thinking>（思考內容；沒有結尾標籤時拿到最後）。
 * 模擬思考用 <thinking>：有些模型把 <think> 當成特殊符號，平台輸出時會把標籤濾掉，思考就混進正文
 */
const stripThink = s => String(s || '').replace(/<(think|thinking)>[\s\S]*?(<\/\1>|$)/gi, '');

/** 時間戳記「年月日-時分秒」，例如 20261118-142829（備份、垃圾桶、損毀檔另存的檔名用） */
function timeStamp(d = new Date()) {
  const p2 = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

module.exports = { stripThink, timeStamp };
