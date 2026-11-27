// 版本號比較（檢查更新用）
'use strict';

/** 拆成 { nums: [主, 次, 修訂], pre: ['beta', 2] }（「+」後面的建置資訊不比） */
const verParts = v => {
  const [core, ...rest] = String(v || '').trim().replace(/^v/i, '').split('+')[0].split('-');
  const pre = rest.join('-');
  return { nums: core.split('.').slice(0, 3).map(n => parseInt(n, 10) || 0), pre: pre ? pre.split('.').map(p => (/^\d+$/.test(p) ? +p : p)) : [] };
};
/**
 * a 比 b 新：先比 主.次.修訂；一樣時，後面帶「-beta」這類預先發布標記的比正式版舊
 * （2.0.0-beta < 2.0.0，beta 版的使用者才會收到正式版的更新）；兩個都有標記時依序比（數字比大小、文字比字母，2.0.0-beta < 2.0.0-beta.2）
 */
function isNewerVersion(a, b) {
  const x = verParts(a), y = verParts(b);
  for (let i = 0; i < 3; i++) if ((x.nums[i] || 0) !== (y.nums[i] || 0)) return (x.nums[i] || 0) > (y.nums[i] || 0);
  if (!x.pre.length || !y.pre.length) return !x.pre.length && !!y.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === q) continue;
    if (p === undefined) return false; // 標記比較短的比較舊（beta < beta.2）
    if (q === undefined) return true;
    if (typeof p !== typeof q) return typeof p === 'string'; // 文字的比數字的新
    return p > q;
  }
  return false;
}

module.exports = { verParts, isNewerVersion };
