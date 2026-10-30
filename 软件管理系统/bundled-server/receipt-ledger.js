const crypto = require("crypto");

const text = (value, max = 300) => String(value || "").trim().slice(0, max);
const normalized = value => text(value).replace(/[\s（）()_-]/g, "").toLocaleLowerCase("zh-CN");
const active = rows => (rows || []).filter(row => row.status !== "voided");

function receivedForProject(receipts, projectId) {
  return Math.round(active(receipts).filter(row => row.projectId === projectId).reduce((sum, row) => sum + Number(row.amount || 0), 0) * 100) / 100;
}

function receivedForInvoice(receipts, invoiceId) {
  return Math.round(active(receipts).filter(row => row.invoiceId === invoiceId).reduce((sum, row) => sum + Number(row.amount || 0), 0) * 100) / 100;
}

function receivedForInvoiceProject(receipts, invoiceId, projectId) {
  return Math.round(active(receipts).filter(row => row.invoiceId === invoiceId && row.projectId === projectId).reduce((sum, row) => sum + Number(row.amount || 0), 0) * 100) / 100;
}

function invoiceAllocation(invoice, projectId) {
  const allocations = Array.isArray(invoice.allocations) && invoice.allocations.length ? invoice.allocations : invoice.projectId ? [{ projectId: invoice.projectId, amount: invoice.amount }] : [];
  return allocations.find(row => row.projectId === projectId) || null;
}

function projectSettlement(project, receipts) {
  const total = Math.max(0, Math.round(Number(project.receivable || 0) * 100) / 100);
  const hasHistory = (receipts || []).some(row => row.projectId === project.id);
  const receivedAmount = hasHistory ? receivedForProject(receipts, project.id) : project.paid ? total : Math.max(0, Number(project.receivedAmount || 0));
  return { total, receivedAmount: Math.min(total, receivedAmount), outstanding: Math.max(0, Math.round((total - receivedAmount) * 100) / 100), source: hasHistory ? "ledger" : project.paid ? "legacy" : "none" };
}

function createCustomerReceipt(input, { projects, invoices, receipts, user }, now = new Date().toISOString()) {
  const project = projects.find(row => row.id === text(input.projectId, 100));
  if (!project) throw new Error("回款项目不存在");
  const settlement = projectSettlement(project, receipts);
  const amount = Math.round(Number(input.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("回款金额必须大于0");
  if (amount > settlement.outstanding + 0.001) throw new Error(`回款金额超过项目未收余额 ${settlement.outstanding.toFixed(2)}`);
  const receiptDate = text(input.receiptDate, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receiptDate)) throw new Error("回款日期格式必须为 YYYY-MM-DD");
  const invoiceId = text(input.invoiceId, 100);
  if (invoiceId) {
    const invoice = invoices.find(row => row.id === invoiceId && row.direction === "customer");
    if (!invoice) throw new Error("关联的客户发票不存在");
    const allocation = invoiceAllocation(invoice, project.id);
    if (!allocation || invoice.matchStatus !== "confirmed") throw new Error("客户发票尚未分配到当前项目");
    if (normalized(invoice.partyName) && normalized(project.customer) && normalized(invoice.partyName) !== normalized(project.customer)) throw new Error("客户发票与当前项目客户不一致");
    const remaining = Math.max(0, Math.round((Number(allocation.amount || 0) - receivedForInvoiceProject(receipts, invoiceId, project.id)) * 100) / 100);
    if (amount > remaining + 0.001) throw new Error(`回款金额超过发票未核销余额 ${remaining.toFixed(2)}`);
  }
  return { id: crypto.randomUUID(), projectId: project.id, invoiceId, customerName: text(project.customer, 200), amount, receiptDate, bankReference: text(input.bankReference, 200), note: text(input.note, 500), status: "posted", createdByUserId: user?.id || "", createdBy: user?.displayName || "", createdAt: now, updatedAt: now };
}

function voidCustomerReceipt(receipt, input, user, now = new Date().toISOString()) {
  if (!receipt || receipt.status === "voided") throw new Error("回款流水不存在或已经冲销");
  const reason = text(input.reason, 300);
  if (reason.length < 2) throw new Error("冲销原因至少填写2个字");
  return { ...receipt, status: "voided", voidReason: reason, voidedByUserId: user?.id || "", voidedBy: user?.displayName || "", voidedAt: now, updatedAt: now };
}

module.exports = { createCustomerReceipt, projectSettlement, receivedForInvoice, receivedForInvoiceProject, receivedForProject, voidCustomerReceipt };
