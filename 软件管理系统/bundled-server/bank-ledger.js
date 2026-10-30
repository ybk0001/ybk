const crypto = require("crypto");
const { itemSettlement } = require("./payment-ledger");
const { projectSettlement } = require("./receipt-ledger");
const { statementDate } = require("./tax-ledger");

const clean = value => String(value || "").trim();
const key = value => clean(value).replace(/[\s（）()_-]/g, "").toLocaleLowerCase("zh-CN");
const cents = value => Math.round(Number(String(value || "").replace(/[,，￥¥\s]/g, "")) * 100) / 100;

function direction(value) {
  const input = key(value);
  if (["支出", "付款", "转出", "借", "out", "debit"].includes(input)) return "out";
  if (["收入", "收款", "转入", "贷", "in", "credit"].includes(input)) return "in";
  throw new Error(`收支方向“${clean(value)}”无法识别`);
}

function parseBankRows(rows) {
  if (!Array.isArray(rows) || rows.length < 2) throw new Error("银行流水需要表头和至少一行记录");
  if (rows.length > 10001) throw new Error("单次最多导入10000条银行流水");
  const aliases = {
    date: ["交易日期", "交易时间", "日期", "记账日期"], counterparty: ["对方户名", "对方名称", "交易对手", "收付款人"],
    direction: ["收支方向", "交易方向", "收支", "借贷标志"], amount: ["交易金额", "金额", "发生额"],
    reference: ["银行流水号", "流水号", "交易序号", "凭证号"], summary: ["摘要", "用途", "备注", "附言"]
  };
  const headers = rows[0].map(key);
  const positions = Object.fromEntries(Object.entries(aliases).map(([name, names]) => [name, headers.findIndex(header => names.map(key).includes(header))]));
  for (const required of ["date", "counterparty", "direction", "amount"]) if (positions[required] < 0) throw new Error(`缺少必需表头：${aliases[required][0]}`);
  return rows.slice(1).filter(row => row.some(value => clean(value))).map((row, index) => {
    const get = name => positions[name] < 0 ? "" : row[positions[name]];
    const amount = cents(get("amount"));
    if (!Number.isFinite(amount) || amount <= 0) throw new Error(`第${index + 2}行：交易金额必须大于0`);
    try { return { transactionDate: statementDate(get("date")), counterparty: clean(get("counterparty")).slice(0, 200), direction: direction(get("direction")), amount, bankReference: clean(get("reference")).slice(0, 200), summary: clean(get("summary")).slice(0, 500) }; }
    catch (error) { throw new Error(`第${index + 2}行：${error.message}`); }
  });
}

function supplierCandidates(transaction, projects, payments) {
  if (transaction.direction !== "out") return [];
  const party = key(transaction.counterparty);
  return projects.flatMap(project => (project.supplierItems || []).map((item, index) => {
    const settlement = itemSettlement(project, item, payments);
    const nameMatch = party && key(item.supplier) === party;
    const amountMatch = Math.abs(settlement.outstanding - transaction.amount) < 0.01;
    const score = (nameMatch ? 60 : 0) + (amountMatch ? 35 : 0) + (key(transaction.summary).includes(key(project.name)) && project.name ? 20 : 0);
    return { projectId: project.id, projectName: project.name, supplierItemId: item.id || `legacy-${project.id}-${index}`, itemName: item.itemName || "项目采购", supplierName: item.supplier || "", outstanding: settlement.outstanding, score, reason: `${nameMatch ? "供应商一致" : "供应商未命中"}；${amountMatch ? "金额一致" : "金额不同"}` };
  })).filter(item => item.outstanding > 0 && item.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
}

function customerCandidates(transaction, projects, receipts) {
  if (transaction.direction !== "in") return [];
  const party = key(transaction.counterparty);
  return projects.map(project => {
    const settlement = projectSettlement(project, receipts);
    const nameMatch = party && key(project.customer) === party;
    const amountMatch = Math.abs(settlement.outstanding - transaction.amount) < 0.01;
    const score = (nameMatch ? 60 : 0) + (amountMatch ? 35 : 0) + (key(transaction.summary).includes(key(project.name)) && project.name ? 20 : 0);
    return { projectId: project.id, projectName: project.name, customerName: project.customer || "", outstanding: settlement.outstanding, score, reason: `${nameMatch ? "客户一致" : "客户未命中"}；${amountMatch ? "金额一致" : "金额不同"}` };
  }).filter(row => row.outstanding > 0 && row.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
}

function importTransactions(rows, { projects, payments, receipts = [], existing, sourceName }) {
  const seen = new Set((existing || []).map(item => item.importKey));
  const imported = [], duplicates = [];
  rows.forEach((row, index) => {
    const importKey = crypto.createHash("sha256").update([row.transactionDate, row.direction, row.amount, key(row.counterparty), row.bankReference, row.summary].join("|")).digest("hex");
    if (seen.has(importKey)) { duplicates.push(index + 2); return; }
    seen.add(importKey);
    const candidates = row.direction === "out" ? supplierCandidates(row, projects, payments) : customerCandidates(row, projects, receipts);
    imported.push({ id: crypto.randomUUID(), ...row, importKey, sourceName: clean(sourceName).slice(0, 200), status: candidates.length ? "suggested" : "unmatched", candidates, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  });
  return { imported, duplicates };
}

function reopenTransaction(transaction, { ledgerType, ledgerId, reason, user }, now = new Date().toISOString()) {
  const linkedField = ledgerType === "payment" ? "paymentId" : ledgerType === "receipt" ? "receiptId" : "";
  if (!linkedField) throw new Error("银行流水关联类型无效");
  if (transaction.status !== "matched") throw new Error("银行流水当前不是已核销状态");
  if (!ledgerId || transaction[linkedField] !== ledgerId) throw new Error("银行流水与待冲销账本不一致");
  const history = {
    action: "linked_ledger_voided",
    ledgerType,
    ledgerId,
    reason: clean(reason).slice(0, 500),
    priorMatch: { projectId: transaction.projectId || "", supplierItemId: transaction.supplierItemId || "", paymentId: transaction.paymentId || "", receiptId: transaction.receiptId || "", matchedBy: transaction.matchedBy || "", matchedAt: transaction.matchedAt || "" },
    reopenedByUserId: user?.id || "system",
    reopenedBy: user?.displayName || "系统",
    reopenedAt: now
  };
  return {
    ...transaction,
    status: (transaction.candidates || []).length ? "suggested" : "unmatched",
    projectId: "", supplierItemId: "", paymentId: "", receiptId: "", matchedBy: "", matchedAt: "",
    matchHistory: [history, ...(transaction.matchHistory || [])],
    updatedAt: now
  };
}

module.exports = { customerCandidates, importTransactions, parseBankRows, reopenTransaction, supplierCandidates };
