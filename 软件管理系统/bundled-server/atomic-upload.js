const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
async function saveUpload(input, destination, maxBytes = 500 * 1024 * 1024) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError('Invalid upload limit');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  let size = 0;
  const limit = new Transform({ transform(chunk, encoding, callback) {
    size += chunk.length;
    if (size > maxBytes) return callback(Object.assign(new Error(`单个文件不能超过 ${Math.round(maxBytes / 1024 / 1024)}MB`), { status: 413 }));
    callback(null, chunk);
  } });
  try {
    await pipeline(input, limit, fs.createWriteStream(temporary, { flags: 'wx' }));
    await fs.promises.rename(temporary, destination);
    return size;
  } catch (error) {
    await fs.promises.rm(temporary, { force: true });
    throw error;
  }
}
module.exports = { saveUpload };
