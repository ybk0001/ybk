const assert = require("node:assert/strict");
const test = require("node:test");
const { asImportedLegacy, createEntry, verify } = require("../bundled-server/audit-ledger");

const legacy = { id: "legacy-1", at: "2026-09-01T00:00:00.000Z", action: "3.0历史操作", detail: "原始记录" };
const input = (id, action) => ({ id, at: `2026-09-24T00:00:0${id.slice(-1)}.000Z`, userId: "main", userName: "管理员", action, targetType: "project", targetId: "p1", detail: "测试" });

test("新审计日志形成前向哈希链并兼容未封存的3.0历史记录", () => {
  const first = createEntry(input("new-1", "首次修改"), [legacy]);
  const second = createEntry(input("new-2", "再次修改"), [first, legacy]);
  const head = { entryId: second.id, entryHash: second.entryHash, sequence: second.sequence };
  const result = verify([second, first, legacy], head);

  assert.equal(result.ok, true);
  assert.equal(result.status, "verified_with_legacy");
  assert.equal(result.sealedCount, 2);
  assert.equal(result.legacyCount, 1);
});

test("审计日志内容修改、链路重排和链头删除都能被识别", () => {
  const first = createEntry(input("new-1", "首次修改"), [legacy]);
  const second = createEntry(input("new-2", "再次修改"), [first, legacy]);
  const head = { entryId: second.id, entryHash: second.entryHash, sequence: second.sequence };

  assert.equal(verify([{ ...second, detail: "被篡改" }, first, legacy], head).ok, false);
  assert.equal(verify([first, second, legacy], head).ok, false);
  assert.equal(verify([first, legacy], head).errors.some(item => item.code === "head_mismatch"), true);
});

test("外部备份中的哈希链降级为保留来源的历史记录", () => {
  const sealed = createEntry(input("new-1", "外部操作"), []);
  const imported = asImportedLegacy(sealed);

  assert.equal("entryHash" in imported, false);
  assert.equal("previousHash" in imported, false);
  assert.equal(imported.importedAuditIntegrity, "external_chain_not_trusted");
});
