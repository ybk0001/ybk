const crypto = require("crypto");

function text(value, max = 300) {
  return String(value || "").trim().slice(0, max);
}

function money(value, label = "付款金额") {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label}必须大于0`);
  return Math.round(number * 100) / 100;
}

function validDate(value) {
  const result = text(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw new Error("付款日期格式必须为 YYYY-MM-DD");
  return result;
}

function normalized(value) {
  return text(value, 300).replace(/[\s（）()_-]/g, "").toLocaleLowerCase("zh-CN");
}

function itemTotal(item) {
  return Math.round((Number(item?.payable || 0) + Number(item?.shippingFee || 0)) * 100) / 100;
}

function activePayments(payments) {
  return (payments || []).filter(item => item.status !== "voided");
}

function paidForItem(payments, projectId, supplierItemId) {
  return Math.round(activePayments(payments).filter(item => item.projectId === projectId && item.supplierItemId === supplierItemId).reduce((sum, item) => sum + Number(item.amount || 0), 0) * 100) / 100;
}

function paidForInvoice(payments, invoiceId) {
  return Math.round(activePayments(payments).filter(item => item.invoiceId === invoiceId).reduce((sum, item) => sum + Number(item.amount || 0), 0) * 100) / 100;
}

function paidForInvoiceProject(payments, invoiceId, projectId) {
  return Math.round(activePayments(payments).filter(item => item.invoiceId === invoiceId && item.projectId === projectId).reduce((sum, item) => sum + Number(item.amount || 0), 0) * 100) / 100;
}

function invoiceAllocation(invoice, projectId) {
  const allocations = Array.isArray(invoice.allocations) && invoice.allocations.length ? invoice.allocations : invoice.projectId ? [{ projectId: invoice.projectId, amount: invoice.amount }] : [];
  return allocations.find(row => row.projectId === projectId) || null;
}

function itemSettlement(project, item, payments) {
  const total = itemTotal(item);
  const ledgerPaid = paidForItem(payments, project.id, item.id);
  const hasLedgerHistory = (payments || []).some(payment => payment.projectId === project.id && payment.supplierItemId === item.id);
  const paidAmount = hasLedgerHistory ? ledgerPaid : item.paid ? total : Math.max(0, Number(item.paidAmount || 0));
  return { total, paidAmount: Math.min(total, paidAmount), outstanding: Math.max(0, Math.round((total - paidAmount) * 100) / 100), source: hasLedgerHistory ? "ledger" : item.paid ? "legacy" : "none" };
}

function createSupplierPayment(input, { projects, invoices, payments, user }, now = new Date().toISOString()) {
  const project = projects.find(item => item.id === text(input.projectId, 100));
  if (!project) throw new Error("付款项目不存在");
  const supplierItem = (project.supplierItems || []).find(item => item.id === text(input.supplierItemId, 100));
  if (!supplierItem) throw new Error("供应商应付明细不存在");
  const settlement = itemSettlement(project, supplierItem, payments);
  const amount = money(input.amount);
  if (amount > settlement.outstanding + 0.001) throw new Error(`付款金额超过明细未付余额 ${settlement.outstanding.toFixed(2)}`);
  const invoiceId = text(input.invoiceId, 100);
  let invoice = null;
  if (invoiceId) {
    invoice = invoices.find(item => item.id === invoiceId && item.direction === "supplier");
    if (!invoice) throw new Error("关联的供应商发票不存在");
    const allocation = invoiceAllocation(invoice, project.id);
    if (!allocation || invoice.matchStatus !== "confirmed") throw new Error("供应商发票尚未分配到当前项目");
    if (normalized(invoice.partyName) && normalized(supplierItem.supplier) && normalized(invoice.partyName) !== normalized(supplierItem.supplier)) throw new Error("供应商发票与当前应付明细的供应商不一致");
    const invoiceOutstanding = Math.max(0, Math.round((Number(allocation.amount || 0) - paidForInvoiceProject(payments, invoiceId, project.id)) * 100) / 100);
    if (amount > invoiceOutstanding + 0.001) throw new Error(`付款金额超过发票未核销余额 ${invoiceOutstanding.toFixed(2)}`);
  }
  return {
    id: crypto.randomUUID(), projectId: project.id, supplierItemId: supplierItem.id, invoiceId,
    supplierName: text(supplierItem.supplier, 200), amount, paymentDate: validDate(input.paymentDate),
    bankReference: text(input.bankReference, 200), note: text(input.note, 500), status: "posted",
    createdByUserId: user?.id || "", createdBy: user?.displayName || "", createdAt: now, updatedAt: now
  };
}

function voidSupplierPayment(payment, input, user, now = new Date().toISOString()) {
  if (!payment || payment.status === "voided") throw new Error("付款流水不存在或已经冲销");
  const reason = text(input.reason, 300);
  if (reason.length < 2) throw new Error("冲销原因至少填写2个字");
  return { ...payment, status: "voided", voidReason: reason, voidedByUserId: user?.id || "", voidedBy: user?.displayName || "", voidedAt: now, updatedAt: now };
}

module.exports = { createSupplierPayment, itemSettlement, itemTotal, paidForInvoice, paidForInvoiceProject, paidForItem, voidSupplierPayment };
