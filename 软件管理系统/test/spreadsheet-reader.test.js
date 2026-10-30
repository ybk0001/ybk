const assert = require("node:assert/strict");
const test = require("node:test");
const { firstWorksheet } = require("../bundled-server/spreadsheet-reader");
const { parseStatementRows } = require("../bundled-server/tax-ledger");
const { zipFixture } = require("../test-support/xlsx-fixture");

test("读取 XLSX 第一张工作表并转换供应商对账明细", () => {
  const workbook = '<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="对账单" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const relationships = '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>';
  const shared = '<?xml version="1.0"?><sst><si><t>日期</t></si><si><t>项目名称</t></si><si><t>事项</t></si><si><t>金额</t></si><si><t>展板项目</t></si><si><t>制作费</t></si></sst>';
  const sheet = '<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row><row r="2"><c r="A2"><v>46300</v></c><c r="B2" t="s"><v>4</v></c><c r="C2" t="s"><v>5</v></c><c r="D2"><v>600</v></c></row></sheetData></worksheet>';
  const xlsx = zipFixture({ "xl/workbook.xml": workbook, "xl/_rels/workbook.xml.rels": relationships, "xl/sharedStrings.xml": shared, "xl/worksheets/sheet1.xml": sheet }, true);
  const rows = firstWorksheet(xlsx);
  assert.deepEqual(rows[0], ["日期", "项目名称", "事项", "金额"]);
  const parsed = parseStatementRows(rows);
  assert.equal(parsed[0].occurredOn, "2026-10-05");
  assert.equal(parsed[0].projectHint, "展板项目");
  assert.equal(parsed[0].amount, 600);
});
