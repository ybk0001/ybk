const path = require("path");
const { inflateRawSync } = require("zlib");

function zipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error("XLSX 文件内容无效");
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error("找不到 XLSX 压缩目录");
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  let expandedTotal = 0;
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("XLSX 压缩目录损坏");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8").replace(/\\/g, "/");
    expandedTotal += uncompressedSize;
    if (uncompressedSize > 16 * 1024 * 1024 || expandedTotal > 32 * 1024 * 1024) throw new Error("XLSX 解压后内容过大，已停止读取");
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("XLSX 文件条目损坏");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(start, start + compressedSize);
    if (method === 0) entries.set(name, Buffer.from(compressed));
    else if (method === 8) entries.set(name, inflateRawSync(compressed, { maxOutputLength: 16 * 1024 * 1024 }));
    else throw new Error(`XLSX 使用了不支持的压缩方式：${method}`);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function xmlText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function entryText(entries, name, required = true) {
  const entry = entries.get(name);
  if (!entry && required) throw new Error(`XLSX 缺少文件：${name}`);
  return entry ? entry.toString("utf8") : "";
}

function columnIndex(reference) {
  const letters = String(reference || "").match(/^[A-Z]+/i)?.[0]?.toUpperCase() || "A";
  return [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function normalizeSheetTarget(target) {
  const value = String(target || "").replace(/\\/g, "/");
  return value.startsWith("/") ? value.slice(1) : path.posix.normalize(`xl/${value}`);
}

function firstWorksheet(buffer) {
  const entries = zipEntries(buffer);
  const sharedXml = entryText(entries, "xl/sharedStrings.xml", false);
  const shared = [...sharedXml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map(match => [...match[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(part => xmlText(part[1])).join(""));
  const workbook = entryText(entries, "xl/workbook.xml");
  const firstSheet = workbook.match(/<sheet\b[^>]*\br:id="([^"]+)"[^>]*\/?\s*>/);
  if (!firstSheet) throw new Error("XLSX 中没有工作表");
  const relationships = entryText(entries, "xl/_rels/workbook.xml.rels");
  const relPattern = /<Relationship\b([^>]*)\/?\s*>/g;
  let target = "";
  for (const match of relationships.matchAll(relPattern)) {
    const id = match[1].match(/\bId="([^"]+)"/)?.[1];
    if (id === firstSheet[1]) { target = match[1].match(/\bTarget="([^"]+)"/)?.[1] || ""; break; }
  }
  if (!target) throw new Error("XLSX 工作表关系无效");
  const sheet = entryText(entries, normalizeSheetTarget(target));
  const rows = [];
  for (const rowMatch of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attributes = cellMatch[1];
      const cell = cellMatch[2];
      const reference = attributes.match(/\br="([^"]+)"/)?.[1] || "A1";
      const type = attributes.match(/\bt="([^"]+)"/)?.[1] || "n";
      const raw = cell.match(/<v>([\s\S]*?)<\/v>/)?.[1] || "";
      let value = type === "s" ? (shared[Number(raw)] || "") : type === "inlineStr" ? xmlText(cell) : xmlText(raw);
      if (type === "b") value = raw === "1" ? "是" : "否";
      row[columnIndex(reference)] = value;
    }
    if (row.some(value => String(value || "").trim())) rows.push(row.map(value => String(value || "").trim()));
  }
  if (!rows.length) throw new Error("XLSX 第一张工作表没有可导入的数据");
  return rows;
}

module.exports = { firstWorksheet };
