const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const html = readFileSync(join(__dirname, "..", "bundled-server", "public", "index.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] || "";

test("内联应用脚本可以完整解析", () => {
  assert.ok(script.length > 1000);
  assert.doesNotThrow(() => new Function(script));
});

test("税务引导嵌入原有财务导航并使用真实业务集合", () => {
  assert.match(html, /id="taxPageBtn"/);
  assert.match(html, /class="tax-only"/);
  assert.match(script, /function taxFacts/);
  assert.match(script, /projects\.filter/);
  assert.match(script, /expenses\.filter/);
  assert.match(script, /calc\(project\)\.supplierUnpaid/);
});

test("税务引导明确人工边界且不直接计算税额", () => {
  assert.match(html, /不自动计算税额、不自动申报/);
  assert.match(html, /不能直接等同于应税收入/);
  assert.doesNotMatch(script, /taxAmount\s*=|应纳税额\s*[=:]/);
});

test("3.0历史发票支持从任务直接带入补录且不伪造票号", () => {
  assert.match(script, /function beginLegacyInvoiceBackfill/);
  assert.match(script, /source: legacyInvoiceBackfillProjectId \? "legacy_backfill" : "manual"/);
  assert.match(script, /taxInvoiceNumber"\)\.value = ""/);
  assert.match(html, /逐项补录/);
});
