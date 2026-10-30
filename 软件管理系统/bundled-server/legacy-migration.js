const crypto = require("crypto");

const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));

function planToken(plan) {
  const payload = {
    invoiceTasks: plan.invoiceTasks,
    paymentCandidates: plan.paymentCandidates,
    receiptCandidates: plan.receiptCandidates,
    blocked: plan.blocked
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function migrationPlan({ projects, invoices, payments, receipts }) {
  const invoiceTasks = [], paymentCandidates = [], receiptCandidates = [], blocked = [];
  for (const project of projects) {
    if (project.invoiced && !(invoices || []).some(row => row.direction === "customer" && (row.projectId === project.id || (row.allocations || []).some(allocation => allocation.projectId === project.id)))) {
      invoiceTasks.push({ projectId: project.id, projectName: project.name || "未命名项目", customer: project.customer || "", invoiceDate: project.invoiceDate || "", amount: Number(project.receivable || 0), reason: "缺少真实发票号码和完整票面信息，必须人工补录" });
    }
    if (project.paid && !(receipts || []).some(row => row.projectId === project.id)) {
      const amount = Number(project.receivable || 0), date = project.paymentDate || "";
      if (amount > 0 && validDate(date)) receiptCandidates.push({ projectId: project.id, projectName: project.name || "未命名项目", customerName: project.customer || "", amount, receiptDate: date });
      else blocked.push({ type: "customerReceipt", projectId: project.id, projectName: project.name || "未命名项目", reason: amount <= 0 ? "缺少应收金额" : "缺少有效回款日期" });
    }
    const supplierItems = Array.isArray(project.supplierItems) && project.supplierItems.length
      ? project.supplierItems
      : (project.supplier || Number(project.payable || 0) || project.supplierPaid ? [{ supplier: project.supplier || "", payable: project.payable || 0, shippingFee: project.shippingFee || 0, paid: Boolean(project.supplierPaid), paymentDate: project.supplierPaymentDate || "" }] : []);
    supplierItems.forEach((item, index) => {
      const itemId = item.id || `legacy-${project.id}-${index}`;
      if (!item.paid || (payments || []).some(row => row.projectId === project.id && row.supplierItemId === itemId)) return;
      const amount = Number(item.payable || 0) + Number(item.shippingFee || 0), date = item.paymentDate || project.supplierPaymentDate || "";
      if (amount > 0 && validDate(date)) paymentCandidates.push({ projectId: project.id, projectName: project.name || "未命名项目", supplierItemId: itemId, supplierName: item.supplier || "", amount, paymentDate: date });
      else blocked.push({ type: "supplierPayment", projectId: project.id, projectName: project.name || "未命名项目", supplierItemId: itemId, reason: amount <= 0 ? "缺少应付金额" : "缺少有效付款日期" });
    });
  }
  const plan = { invoiceTasks, paymentCandidates, receiptCandidates, blocked, counts: { invoiceTasks: invoiceTasks.length, paymentsReady: paymentCandidates.length, receiptsReady: receiptCandidates.length, blocked: blocked.length } };
  return { ...plan, planToken: planToken(plan) };
}

function buildLegacyLedgers(plan, user, now = new Date().toISOString()) {
  const payments = plan.paymentCandidates.map(row => ({ id: crypto.randomUUID(), projectId: row.projectId, supplierItemId: row.supplierItemId, invoiceId: "", supplierName: row.supplierName, amount: row.amount, paymentDate: row.paymentDate, bankReference: "", note: "由3.0已付款状态迁移", status: "posted", source: "legacy_migration", createdByUserId: user.id, createdBy: user.displayName, createdAt: now, updatedAt: now }));
  const receipts = plan.receiptCandidates.map(row => ({ id: crypto.randomUUID(), projectId: row.projectId, invoiceId: "", customerName: row.customerName, amount: row.amount, receiptDate: row.receiptDate, bankReference: "", note: "由3.0已回款状态迁移", status: "posted", source: "legacy_migration", createdByUserId: user.id, createdBy: user.displayName, createdAt: now, updatedAt: now }));
  return { payments, receipts };
}

module.exports = { buildLegacyLedgers, migrationPlan, planToken };
