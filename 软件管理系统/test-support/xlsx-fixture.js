const { deflateRawSync } = require("node:zlib");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipFixture(files, compress = false) {
  const localParts = [], centralParts = [];
  let localOffset = 0;
  for (const [name, value] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name), data = Buffer.from(value), payload = compress ? deflateRawSync(data) : data, crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(compress ? 8 : 0, 8); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuffer.length, 26);
    localParts.push(local, nameBuffer, payload);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(compress ? 8 : 0, 10); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuffer.length, 28); central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBuffer);
    localOffset += local.length + nameBuffer.length + payload.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(Object.keys(files).length, 8); eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralSize, 12); eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

function worksheetFixture({ sharedStrings, rows, sheetName = "Sheet1" }) {
  const workbook = `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const relationships = '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>';
  const shared = `<?xml version="1.0"?><sst>${sharedStrings.map(value => `<si><t>${value}</t></si>`).join("")}</sst>`;
  const sheet = `<?xml version="1.0"?><worksheet><sheetData>${rows.join("")}</sheetData></worksheet>`;
  return zipFixture({ "xl/workbook.xml": workbook, "xl/_rels/workbook.xml.rels": relationships, "xl/sharedStrings.xml": shared, "xl/worksheets/sheet1.xml": sheet }, true);
}

module.exports = { worksheetFixture, zipFixture };
