// 讀取與寫入 ZIP（表情包匯入、.charx 匯入匯出用）：只用 Node 內建的 zlib，不加相依套件。
// 只支援「不壓縮（stored）」與「Deflate」兩種；限制檔案數、單檔與總大小，防止 ZIP 炸彈。
'use strict';
const zlib = require('zlib');

const bad = msg => Object.assign(new Error(msg), { status: 400 });

/** 檔名：有 UTF-8 旗標就用 UTF-8；沒有時先試 UTF-8，不合法再用 Big5（繁中 Windows 壓縮的）、最後 latin1 */
function decodeName(buf, utf8Flag) {
  if (utf8Flag) return buf.toString('utf8');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { /* 不是 UTF-8 */ }
  try { return new TextDecoder('big5', { fatal: true }).decode(buf); } catch { /* 也不是 Big5 */ }
  return buf.toString('latin1');
}

/**
 * 讀出 ZIP 裡的檔案：[{ name, data }]（資料夾本身略過）。
 * limits：files＝最多幾個檔案、each＝單檔解壓後上限、total＝全部解壓後上限（位元組）
 */
function readZip(buf, { files = 300, each = 5 * 1024 * 1024, total = 100 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw bad('不是 ZIP 檔');
  // 中央目錄結尾（EOCD）：從最後往前找簽章 0x06054b50（後面可能有最多 65535 字元的註解）
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw bad('不是 ZIP 檔（找不到檔案目錄）');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count > files) throw bad(`ZIP 裡的檔案太多（${count} 個，上限 ${files} 個）`);
  const out = [];
  let sum = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw bad('ZIP 檔損毀（檔案目錄不完整）');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = decodeName(buf.subarray(p + 46, p + 46 + nlen), flags & 0x800);
    p += 46 + nlen + elen + clen;
    if (name.endsWith('/') || name.endsWith('\\')) continue; // 資料夾
    if (flags & 1) throw bad('不支援加密的 ZIP');
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw bad('ZIP 檔損毀（檔案內容不完整）');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    if (raw.length !== csize) throw bad('ZIP 檔損毀（檔案內容不完整）');
    let data = null, error = null;
    if (usize > each) error = 'too_big';
    else if (method === 0) data = raw;
    else if (method === 8) {
      // maxOutputLength：就算目錄裡寫的大小是假的，解壓縮超過上限也會中止
      try { data = zlib.inflateRawSync(raw, { maxOutputLength: each }); } catch (e) { error = e.code === 'ERR_BUFFER_TOO_LARGE' ? 'too_big' : 'broken'; }
    } else error = 'method';
    if (data) {
      sum += data.length;
      if (sum > total) throw bad(`ZIP 解壓縮後太大（上限 ${Math.round(total / 1048576)} MB）`);
    }
    out.push({ name, data, error });
  }
  return out;
}

// ---------- 寫入 ----------
// CRC-32（ZIP 用的那一種）：Node 22.0、22.1 的 zlib 還沒有 crc32，自己算
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** DOS 格式的日期時間（ZIP 的檔案時間） */
function dosTime(d) {
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
/**
 * 寫出 ZIP：entries = [{ name, data: Buffer }]。檔名用 UTF-8（標上旗標）；
 * 已經壓縮過的圖片（PNG、WebP、JPEG、GIF）直接存，其他（JSON 等）用 Deflate 壓縮。不支援 ZIP64（單檔與總大小要小於 4 GB）
 */
function writeZip(entries, { date = new Date() } = {}) {
  const { time, date: day } = dosTime(date);
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(String(name).replace(/\\/g, '/'), 'utf8');
    const deflated = /\.(png|webp|jpe?g|gif)$/i.test(name) ? null : zlib.deflateRawSync(data);
    const useDeflate = deflated && deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x800, 6); head.writeUInt16LE(useDeflate ? 8 : 0, 8);
    head.writeUInt16LE(time, 10); head.writeUInt16LE(day, 12); head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(body.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(nameBuf.length, 26); head.writeUInt16LE(0, 28);
    locals.push(head, nameBuf, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x800, 8); cen.writeUInt16LE(useDeflate ? 8 : 0, 10);
    cen.writeUInt16LE(time, 12); cen.writeUInt16LE(day, 14); cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    centrals.push(cen, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cenSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cenSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

module.exports = { readZip, writeZip, crc32 };
