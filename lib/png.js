// PNG 角色卡讀寫：角色資料以 base64 JSON 存在 tEXt chunk（關鍵字 chara = V2、ccv3 = V3）
'use strict';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function isPng(buf) {
  return buf.length > 8 && buf.subarray(0, 8).equals(PNG_SIG);
}

function readChunks(buf) {
  if (!isPng(buf)) throw new Error('不是有效的 PNG 檔案');
  const chunks = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    chunks.push({ type, data });
    off += 12 + len;
    if (type === 'IEND') break;
  }
  return chunks;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** 讀出 PNG 內所有 tEXt 文字（keyword -> text） */
function readTextChunks(buf) {
  const out = {};
  for (const { type, data } of readChunks(buf)) {
    if (type !== 'tEXt') continue;
    const sep = data.indexOf(0);
    if (sep < 0) continue;
    out[data.toString('latin1', 0, sep)] = data.toString('latin1', sep + 1);
  }
  return out;
}

/** 從 PNG 取出角色卡 JSON（優先 V3） */
function extractCard(buf) {
  const texts = readTextChunks(buf);
  const raw = texts.ccv3 || texts.chara;
  // 檔案本身的問題（不是伺服器錯誤）：回 400
  if (!raw) throw Object.assign(new Error('這張圖片裡沒有角色卡資料（chara / ccv3）'), { status: 400 });
  try { return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); }
  catch { throw Object.assign(new Error('圖片裡的角色卡資料損毀，無法讀取'), { status: 400 }); }
}

/** 把角色卡 JSON 寫進 PNG（同時寫入 chara 與 ccv3，移除舊的） */
function embedCard(buf, cardV2, cardV3) {
  const chunks = readChunks(buf).filter(c => {
    if (c.type !== 'tEXt') return true;
    const kw = c.data.toString('latin1', 0, Math.max(0, c.data.indexOf(0)));
    return kw !== 'chara' && kw !== 'ccv3';
  });
  const text = (kw, obj) =>
    makeChunk('tEXt', Buffer.concat([
      Buffer.from(kw + '\0', 'latin1'),
      Buffer.from(Buffer.from(JSON.stringify(obj), 'utf8').toString('base64'), 'latin1'),
    ]));
  const parts = [PNG_SIG];
  for (const c of chunks) {
    if (c.type === 'IEND') {
      parts.push(text('chara', cardV2));
      if (cardV3) parts.push(text('ccv3', cardV3));
    }
    parts.push(makeChunk(c.type, c.data));
  }
  return Buffer.concat(parts);
}

/** 產生純色 PNG（沒有頭像的角色匯出成 PNG 時用） */
function solidPng(w, h, [r, g, b]) {
  const zlib = require('zlib');
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([PNG_SIG, makeChunk('IHDR', ihdr), makeChunk('IDAT', zlib.deflateSync(raw)), makeChunk('IEND', Buffer.alloc(0))]);
}

module.exports = { isPng, extractCard, embedCard, readTextChunks, solidPng };
