const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const MAGIC = 'ENTERPRISE-BACKUP-2\n';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };

// All paths are relative to a declared archive root; never follow links.
function safePath(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.split('/').some(p => !p || p === '.' || p === '..' || /[<>:"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) fail('备份包含不安全的文件路径');
  const result = path.resolve(root, ...relative.split('/'));
  let check = root;
  for (const part of relative.split('/')) {
    check = path.join(check, part);
    if (fs.existsSync(check) && fs.lstatSync(check).isSymbolicLink()) fail('备份路径包含链接，已停止恢复');
  }
  return result;
}
function* walk(root, prefix = '') {
  if (!fs.existsSync(root)) return;
  if (fs.lstatSync(root).isSymbolicLink()) fail('附件根目录不能是链接');
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) fail(`附件中存在链接，无法完整备份：${relative}`);
    if (entry.isDirectory()) yield* walk(full, relative);
    else if (entry.isFile()) yield { full, relative, size: fs.statSync(full).size };
  }
}
async function* encode(manifest, roots) {
  yield Buffer.from(MAGIC + JSON.stringify(manifest) + '\n');
  let count = 0;
  for (const [key, root] of Object.entries(roots)) {
    for (const file of walk(root)) {
      yield Buffer.from(JSON.stringify({ type: 'file', root: key, path: file.relative, size: file.size }) + '\n');
      const digest = crypto.createHash('sha256');
      let size = 0;
      for await (const chunk of fs.createReadStream(file.full)) { size += chunk.length; digest.update(chunk); yield chunk; }
      if (size !== file.size) throw new Error('附件在备份期间发生变化，请重新备份');
      yield Buffer.from(JSON.stringify({ type: 'checksum', sha256: digest.digest('hex') }) + '\n');
      count++;
    }
  }
  yield Buffer.from(JSON.stringify({ type: 'end', count }) + '\n');
}
async function exportTo(destination, manifest, roots) {
  await pipeline(Readable.from(encode(manifest, roots)), destination);
}
async function stage(input, parent) {
  const folder = fs.mkdtempSync(path.join(parent, 'restore-'));
  const iterator = input[Symbol.asyncIterator]();
  let buffer = Buffer.alloc(0), done = false;
  async function more() {
    const next = await iterator.next(); done = !!next.done;
    if (!done) buffer = buffer.length ? Buffer.concat([buffer, next.value]) : Buffer.from(next.value);
  }
  async function line() {
    while (!buffer.includes(10)) {
      if (buffer.length > 32 * 1024 * 1024) fail('备份记录过大');
      if (done) fail('备份不完整，未进行恢复');
      await more();
    }
    const end = buffer.indexOf(10), value = buffer.subarray(0, end).toString('utf8');
    buffer = buffer.subarray(end + 1); return value;
  }
  try {
    if (await line() !== MAGIC.trim()) fail('不是有效的完整备份');
    const manifest = JSON.parse(await line());
    if (manifest.format !== 'enterprise-project-manager-backup' || manifest.version !== 2 || !manifest.data || !Array.isArray(manifest.roots)) fail('备份格式不支持');
    if (!manifest.roots.includes('r0') || manifest.roots.some(key => typeof key !== 'string' || !/^r\d+$/.test(key)) || new Set(manifest.roots).size !== manifest.roots.length || !manifest.roots.includes(manifest.legacyRoot)) fail('备份根目录信息无效');
    const files = [], names = new Set();
    while (true) {
      const item = JSON.parse(await line());
      if (item.type === 'end') {
        if (item.count !== files.length) fail('备份文件数量不一致');
        if (!done) await more();
        if (buffer.length || !done) fail('备份尾部包含多余内容');
        return { folder, manifest, files };
      }
      if (item.type !== 'file' || !manifest.roots.includes(item.root) || !/^r\d+$/.test(item.root) || !Number.isSafeInteger(item.size) || item.size < 0) fail('备份文件信息无效');
      const target = safePath(folder, `${item.root}/${item.path}`);
      const key = target.toLowerCase(); if (names.has(key)) fail('备份存在重复路径'); names.add(key);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const handle = await fs.promises.open(target, 'wx');
      const digest = crypto.createHash('sha256');
      let remaining = item.size;
      try {
        while (remaining) {
          if (!buffer.length) { if (done) fail('备份附件不完整'); await more(); continue; }
          const chunk = buffer.subarray(0, Math.min(buffer.length, remaining));
          let offset = 0;
          while (offset < chunk.length) offset += (await handle.write(chunk, offset, chunk.length - offset)).bytesWritten;
          digest.update(chunk); remaining -= chunk.length; buffer = buffer.subarray(chunk.length);
        }
      } finally { await handle.close(); }
      const checksum = JSON.parse(await line());
      if (checksum.type !== 'checksum' || checksum.sha256 !== digest.digest('hex')) fail('附件校验失败，未进行恢复');
      files.push({ ...item, staged: target, sha256: checksum.sha256 });
    }
  } catch (error) { fs.rmSync(folder, { recursive: true, force: true }); throw error; }
}
async function fileHash(file) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
module.exports = { exportTo, stage, safePath, fileHash, hash };
