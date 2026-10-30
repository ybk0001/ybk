const crypto = require("crypto");

function text(value, max = 300) {
  return String(value || "").trim().slice(0, max);
}

function amount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error("金额必须大于0");
  return Math.round(number * 100) / 100;
}

function date(value) {
  const normalized = text(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw new Error("日期格式必须为 YYYY-MM-DD");
  return normalized;
}

function optionalTaxNumber(value, label) {
  const normalized = text(value, 30).replace(/\s/g, "").toUpperCase();
  if (normalized && !/^[0-9A-Z]{8,30}$/.test(normalized)) throw new Error(`${label}应为8至30位字母或数字`);
  return normalized;
}

function optionalDecimal(value, label, maximum) {
  if (value === "" || value === undefined || value === null) return null;
  const number = Number(String(value).trim().replace(/%$/, ""));
  if (!Number.isFinite(number) || number < 0 || number > maximum) throw new Error(`${label}必须在0到${maximum}之间`);
  return Math.round(number * 100) / 100;
}

function invoiceKind(value) {
  const input = text(value, 30) || "unspecified";
  const aliases = { "数电普票": "digital_normal", "数电专票": "digital_special", "电子普票": "electronic_normal", "电子专票": "electronic_special", "纸质普票": "paper_normal", "纸质专票": "paper_special", "其他": "other", "未分类": "unspecified" };
  const normalizedKind = aliases[input] || input;
  if (!["digital_normal", "digital_special", "electronic_normal", "electronic_special", "paper_normal", "paper_special", "other", "unspecified"].includes(normalizedKind)) throw new Error(`票种“${input}”无法识别`);
  return normalizedKind;
}

function invoiceTaxFields(input, totalAmount) {
  return {
    invoiceCode: text(input.invoiceCode, 50).replace(/\s/g, "").toUpperCase(),
    invoiceKind: invoiceKind(input.invoiceKind),
    sellerTaxId: optionalTaxNumber(input.sellerTaxId, "销方税号"),
    buyerTaxId: optionalTaxNumber(input.buyerTaxId, "购方税号"),
    taxRate: optionalDecimal(input.taxRate, "税率", 100),
    taxAmount: optionalDecimal(input.taxAmount, "税额", Number(totalAmount || 0))
  };
}

function normalized(value) {
  return text(value).replace(/[\s（）()_-]/g, "").toLocaleLowerCase("zh-CN");
}

function invoiceKey(direction, invoiceNumber) {
  return `${direction === "supplier" ? "supplier" : "customer"}:${text(invoiceNumber, 100).replace(/\s/g, "").toLocaleUpperCase("zh-CN")}`;
}

function parseDelimited(content) {
  const source = String(content || "").replace(/^\uFEFF/, "");
  if (!source.trim()) throw new Error("导入文件为空");
  const firstLine = source.split(/\r?\n/, 1)[0];
  const delimiter = firstLine.includes("\t") ? "\t" : ",";
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) { row.push(field.trim()); field = ""; }
    else if (char === "\n") { row.push(field.trim().replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += char;
  }
  if (quoted) throw new Error("CSV 引号未闭合");
  row.push(field.trim().replace(/\r$/, ""));
  if (row.some(Boolean)) rows.push(row);
  return rows.filter(columns => columns.some(Boolean));
}

function invoiceDirection(value, fallback) {
  const input = normalized(value || fallback);
  if (["customer", "销项", "客户", "向客户开票", "销售"].some(item => normalized(item) === input)) return "customer";
  if (["supplier", "进项", "供应商", "收到供应商发票", "采购"].some(item => normalized(item) === input)) return "supplier";
  throw new Error(`发票类型“${text(value || fallback)}”无法识别`);
}

function parseInvoiceRows(rows, options = {}) {
  if (!Array.isArray(rows)) throw new Error("发票导入数据无效");
  rows = rows.filter(columns => Array.isArray(columns) && columns.some(value => text(value)));
  if (rows.length < 2) throw new Error("导入文件需要表头和至少一行发票");
  if (rows.length > 2001) throw new Error("单次最多导入 2000 张发票");
  const aliases = {
    direction: ["发票类型", "类型", "方向", "direction"],
    invoiceNumber: ["发票号码", "发票号", "号码", "invoiceNumber"],
    invoiceDate: ["开票日期", "发票日期", "日期", "invoiceDate"],
    amount: ["价税合计", "价税合计小写", "含税金额", "金额", "amount"],
    partyName: ["客户/供应商名称", "客户供应商名称", "往来单位", "购销方名称", "客户名称", "供应商名称", "partyName"],
    buyerName: ["购买方名称", "购方名称", "buyerName"],
    sellerName: ["销售方名称", "销方名称", "sellerName"],
    invoiceCode: ["发票代码", "代码", "invoiceCode"],
    invoiceKind: ["票种", "发票票种", "invoiceKind"],
    sellerTaxId: ["销方税号", "销售方税号", "sellerTaxId"],
    buyerTaxId: ["购方税号", "购买方税号", "buyerTaxId"],
    taxRate: ["税率", "税率%", "taxRate"],
    taxAmount: ["税额", "合计税额", "taxAmount"],
    projectHint: ["项目提示", "项目名称", "项目", "projectHint"],
    note: ["备注", "note"]
  };
  const headers = rows[0].map(normalized);
  const positions = Object.fromEntries(Object.entries(aliases).map(([key, names]) => [key, headers.findIndex(header => names.map(normalized).includes(header))]));
  for (const required of ["invoiceNumber", "invoiceDate", "amount"]) {
    if (positions[required] < 0) throw new Error(`缺少必需表头：${aliases[required][0]}`);
  }
  if (["partyName", "buyerName", "sellerName"].every(key => positions[key] < 0)) throw new Error(`缺少必需表头：${aliases.partyName[0]}`);
  return rows.slice(1).map((columns, index) => {
    const get = key => positions[key] < 0 ? "" : columns[positions[key]];
    try {
      const direction = invoiceDirection(get("direction"), options.defaultDirection || "customer");
      return {
        direction,
        invoiceNumber: get("invoiceNumber"), invoiceDate: statementDate(get("invoiceDate")), amount: get("amount"),
        partyName: get("partyName") || (direction === "customer" ? get("buyerName") : get("sellerName")), invoiceCode: get("invoiceCode"), invoiceKind: get("invoiceKind"), sellerTaxId: get("sellerTaxId"), buyerTaxId: get("buyerTaxId"), taxRate: get("taxRate"), taxAmount: get("taxAmount"), projectHint: get("projectHint"), note: get("note"), source: options.source || "csv"
      };
    } catch (error) { throw new Error(`第 ${index + 2} 行：${error.message}`); }
  });
}

function parseInvoiceCsv(content, options = {}) {
  return parseInvoiceRows(parseDelimited(content), options);
}

function statementDate(value) {
  const input = text(value, 30);
  if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(input)) {
    const [year, month, day] = input.split(/[-/.]/).map(Number);
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  const serial = Number(input);
  if (Number.isFinite(serial) && serial >= 1 && serial <= 2958465) {
    const excelEpoch = Date.UTC(1899, 11, 30);
    return new Date(excelEpoch + Math.floor(serial) * 86400000).toISOString().slice(0, 10);
  }
  throw new Error(`日期“${input}”无法识别`);
}

function parseStatementRows(rows) {
  if (!Array.isArray(rows) || rows.length < 2) throw new Error("对账单需要表头和至少一行明细");
  if (rows.length > 5001) throw new Error("单次最多导入 5000 条对账明细");
  const aliases = {
    occurredOn: ["日期", "发生日期", "对账日期", "业务日期", "occurredOn"],
    projectHint: ["项目提示", "项目名称", "项目", "订单名称", "projectHint"],
    itemName: ["事项", "品名", "摘要", "内容", "费用名称", "itemName"],
    amount: ["金额", "含税金额", "价税合计", "应付金额", "amount"]
  };
  const headers = rows[0].map(normalized);
  const positions = Object.fromEntries(Object.entries(aliases).map(([key, names]) => [key, headers.findIndex(header => names.map(normalized).includes(header))]));
  for (const required of ["occurredOn", "itemName", "amount"]) {
    if (positions[required] < 0) throw new Error(`缺少必需表头：${aliases[required][0]}`);
  }
  return rows.slice(1).filter(columns => columns.some(value => text(value))).map((columns, index) => {
    const get = key => positions[key] < 0 ? "" : columns[positions[key]];
    try {
      return { occurredOn: statementDate(get("occurredOn")), projectHint: text(get("projectHint"), 300), itemName: text(get("itemName"), 300), amount: amount(get("amount")) };
    } catch (error) { throw new Error(`第 ${index + 2} 行：${error.message}`); }
  });
}

function parseStatementText(content) {
  return parseStatementRows(parseDelimited(content));
}

function projectSupplierNames(project) {
  return [...new Set([project.supplier, ...(project.supplierItems || []).map(item => item.supplier)].map(item => text(item)).filter(Boolean))];
}

function daysBetween(left, right) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(left || "")) || !/^\d{4}-\d{2}-\d{2}$/.test(String(right || ""))) return null;
  return Math.abs((Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`)) / 86400000);
}

function invoiceCandidates(input, projects) {
  const party = normalized(input.partyName);
  const invoiceAmount = Number(input.amount || 0);
  return projects.map(project => {
    const supplierItems = (project.supplierItems || []).filter(item => !party || normalized(item.supplier) === party);
    const supplierAmounts = supplierItems.map(item => Math.round((Number(item.payable || 0) + Number(item.shippingFee || 0)) * 100) / 100);
    if (!supplierItems.length && normalized(project.supplier) === party) supplierAmounts.push(Math.round((Number(project.payable || 0) + Number(project.shippingFee || 0)) * 100) / 100);
    const projectAmount = input.direction === "customer" ? Number(project.receivable || 0) : supplierAmounts.reduce((sum, value) => sum + value, 0);
    const names = input.direction === "customer" ? [project.customer] : projectSupplierNames(project);
    const nameMatch = party && names.some(name => normalized(name) === party);
    const aggregateAmountMatch = invoiceAmount > 0 && Math.abs(projectAmount - invoiceAmount) < 0.01;
    const itemAmountMatch = input.direction === "supplier" && invoiceAmount > 0 && supplierAmounts.some(value => Math.abs(value - invoiceAmount) < 0.01);
    const amountMatch = aggregateAmountMatch || itemAmountMatch;
    const hint = normalized(input.projectHint);
    const hintFields = [project.name, project.content, project.remark, ...supplierItems.map(item => item.itemName)].map(value => normalized(value)).filter(Boolean);
    const hintMatch = Boolean(hint && hintFields.some(value => value.includes(hint) || hint.includes(value)));
    const projectDate = project.contractDate || text(project.createdAt, 10);
    const dateDistanceDays = daysBetween(input.invoiceDate || input.occurredOn, projectDate);
    const dateScore = dateDistanceDays === null ? 0 : dateDistanceDays <= 120 ? 10 : dateDistanceDays <= 365 ? 5 : 0;
    const coreScore = (nameMatch ? 60 : 0) + (amountMatch ? 35 : 0) + (hintMatch ? 20 : 0);
    const score = coreScore + dateScore;
    const amountReason = itemAmountMatch && !aggregateAmountMatch ? "采购明细金额一致" : aggregateAmountMatch ? "金额一致" : "金额不同";
    const reasons = [nameMatch ? "往来单位一致" : "往来单位未命中", amountReason];
    if (hintMatch) reasons.push("项目提示命中");
    if (dateScore) reasons.push(`业务日期相近${dateDistanceDays}天`);
    return { projectId: project.id, projectName: project.name, customer: project.customer || "", score, confidence: score >= 95 ? "high" : score >= 60 ? "medium" : "low", dateDistanceDays, reason: reasons.join("；"), coreScore };
  }).filter(item => item.coreScore > 0).sort((a, b) => b.score - a.score || (a.dateDistanceDays ?? Number.MAX_SAFE_INTEGER) - (b.dateDistanceDays ?? Number.MAX_SAFE_INTEGER) || String(a.projectId).localeCompare(String(b.projectId))).slice(0, 5).map(({ coreScore, ...item }) => item);
}

function invoiceAllocations(invoice) {
  if (Array.isArray(invoice?.allocations) && invoice.allocations.length) return invoice.allocations.map(row => ({ projectId: text(row.projectId, 100), amount: Math.round(Number(row.amount || 0) * 100) / 100 })).filter(row => row.projectId && row.amount > 0);
  return invoice?.projectId && invoice?.matchStatus === "confirmed" ? [{ projectId: invoice.projectId, amount: Math.round(Number(invoice.amount || 0) * 100) / 100 }] : [];
}

function validateInvoiceAllocations(invoice, inputAllocations, projects) {
  if (!Array.isArray(inputAllocations) || !inputAllocations.length) throw new Error("至少需要一条项目分配");
  const seen = new Set();
  const allocations = inputAllocations.map((row, index) => {
    const projectId = text(row.projectId, 100);
    if (!projectId || !projects.some(project => project.id === projectId)) throw new Error(`第 ${index + 1} 条分配的项目不存在`);
    if (seen.has(projectId)) throw new Error("同一项目不能重复分配");
    seen.add(projectId);
    return { projectId, amount: amount(row.amount) };
  });
  const allocated = Math.round(allocations.reduce((sum, row) => sum + row.amount, 0) * 100) / 100;
  if (Math.abs(allocated - Number(invoice.amount || 0)) > 0.001) throw new Error(`分配合计 ${allocated.toFixed(2)} 必须等于发票金额 ${Number(invoice.amount || 0).toFixed(2)}`);
  return allocations;
}

function createInvoice(input, projects, now = new Date().toISOString()) {
  const direction = input.direction === "supplier" ? "supplier" : "customer";
  const invoiceNumber = text(input.invoiceNumber, 100);
  if (!invoiceNumber) throw new Error("发票号码不能为空");
  const partyName = text(input.partyName, 200);
  if (!partyName) throw new Error("购销方名称不能为空");
  const candidates = invoiceCandidates({ ...input, direction }, projects);
  const requestedProject = text(input.projectId, 100);
  if (requestedProject && !projects.some(project => project.id === requestedProject)) throw new Error("指定项目不存在");
  const totalAmount = amount(input.amount); const taxFields = invoiceTaxFields(input, totalAmount);
  return {
    id: crypto.randomUUID(), direction, invoiceNumber, ...taxFields, invoiceDate: date(input.invoiceDate), amount: totalAmount, partyName,
    projectId: requestedProject, matchStatus: requestedProject ? "confirmed" : candidates.length ? "suggested" : "unmatched",
    allocations: requestedProject ? [{ projectId: requestedProject, amount: totalAmount }] : [], attachments: [],
    candidates, source: text(input.source || "manual", 30), note: text(input.note, 500), createdAt: now, updatedAt: now
  };
}

function createStatement(input, projects, now = new Date().toISOString()) {
  const supplierName = text(input.supplierName, 200);
  if (!supplierName) throw new Error("供应商名称不能为空");
  const period = text(input.period, 7);
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error("对账期间格式必须为 YYYY-MM");
  const lines = Array.isArray(input.lines) ? input.lines : [];
  if (!lines.length) throw new Error("对账单至少需要一行");
  return {
    id: crypto.randomUUID(), supplierName, period, sourceName: text(input.sourceName || "手工录入", 200), status: "reviewing",
    lines: lines.map(row => {
      const candidates = invoiceCandidates({ direction: "supplier", partyName: supplierName, amount: row.amount, occurredOn: row.occurredOn, projectHint: row.projectHint || row.itemName }, projects);
      return { id: crypto.randomUUID(), occurredOn: date(row.occurredOn), itemName: text(row.itemName, 300), amount: amount(row.amount), projectId: "", matchStatus: candidates.length ? "suggested" : "unmatched", candidates };
    }),
    createdAt: now, updatedAt: now
  };
}

function statementReconciliation(statement, { projects = [], payments = [], basis } = {}) {
  const supplier = normalized(statement?.supplierName);
  const linkedProjectIds = new Set((statement?.lines || []).map(line => line.projectId).filter(Boolean));
  const matchedItems = [];
  for (const project of projects.filter(item => linkedProjectIds.has(item.id))) {
    const sourceItems = Array.isArray(project.supplierItems) && project.supplierItems.length
      ? project.supplierItems
      : project.supplier ? [{ id: `legacy-${project.id}-0`, supplier: project.supplier, payable: project.payable, shippingFee: project.shippingFee }] : [];
    sourceItems.forEach((item, index) => {
      if (normalized(item.supplier) === supplier) matchedItems.push({ projectId: project.id, itemId: text(item.id || `legacy-${project.id}-${index}`, 100), amount: Math.round((Number(item.payable || 0) + Number(item.shippingFee || 0)) * 100) / 100 });
    });
  }
  const itemKeys = new Set(matchedItems.map(item => `${item.projectId}:${item.itemId}`));
  const paidAmount = Math.round((payments || []).filter(payment => payment.status !== "voided" && linkedProjectIds.has(payment.projectId) && (itemKeys.has(`${payment.projectId}:${payment.supplierItemId}`) || normalized(payment.supplierName) === supplier)).reduce((sum, payment) => sum + Number(payment.amount || 0), 0) * 100) / 100;
  const statementAmount = Math.round((statement?.lines || []).reduce((sum, line) => sum + Number(line.amount || 0), 0) * 100) / 100;
  const systemPayable = Math.round(matchedItems.reduce((sum, item) => sum + item.amount, 0) * 100) / 100;
  const outstanding = Math.max(0, Math.round((systemPayable - paidAmount) * 100) / 100);
  const reconciliationBasis = basis === "outstanding" ? "outstanding" : "purchases";
  const comparisonAmount = reconciliationBasis === "outstanding" ? outstanding : systemPayable;
  return {
    basis: reconciliationBasis, statementAmount, systemPayable, paidAmount, outstanding,
    difference: Math.round((statementAmount - comparisonAmount) * 100) / 100,
    linkedProjectCount: linkedProjectIds.size, matchedItemCount: matchedItems.length
  };
}

function reconciliationEvidence({ periodInvoices, periodStatements, periodPayments, periodReceipts, legacyInvoiceOnly }) {
  const byId = (left, right) => String(left.id || "").localeCompare(String(right.id || ""));
  const manifest = {
    invoices: periodInvoices.map(item => ({
      id: item.id, direction: item.direction, invoiceNumber: item.invoiceNumber, invoiceDate: item.invoiceDate, amount: Number(item.amount || 0),
      invoiceKind: item.invoiceKind || "unspecified", taxAmount: item.taxAmount ?? null, sellerTaxId: item.sellerTaxId || "", buyerTaxId: item.buyerTaxId || "",
      allocations: invoiceAllocations(item).sort((left, right) => String(left.projectId).localeCompare(String(right.projectId)))
    })).sort(byId),
    statements: periodStatements.map(item => ({
      id: item.id, supplierName: item.supplierName, period: item.period, status: item.status, reconciliation: item.reconciliation || null,
      lines: (item.lines || []).map(line => ({ id: line.id, occurredOn: line.occurredOn, amount: Number(line.amount || 0), projectId: line.projectId || "", matchStatus: line.matchStatus || "unmatched" })).sort(byId)
    })).sort(byId),
    supplierPayments: periodPayments.map(item => ({ id: item.id, projectId: item.projectId, supplierItemId: item.supplierItemId || "", invoiceId: item.invoiceId || "", paymentDate: item.paymentDate, amount: Number(item.amount || 0), status: item.status })).sort(byId),
    customerReceipts: periodReceipts.map(item => ({ id: item.id, projectId: item.projectId, invoiceId: item.invoiceId || "", receiptDate: item.receiptDate, amount: Number(item.amount || 0), status: item.status })).sort(byId),
    legacyInvoiceProjectIds: legacyInvoiceOnly.map(item => item.id).sort()
  };
  return { manifest, hash: crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex") };
}

function reconciliationView({ period, mode, projects, invoices, statements, snapshots, payments = [], receipts = [] }) {
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error("对账期间格式必须为 YYYY-MM");
  if (!["mid_month", "month_end"].includes(mode)) throw new Error("对账模式无效");
  const periodInvoices = invoices.filter(item => String(item.invoiceDate || "").startsWith(period));
  const periodStatements = statements.filter(item => item.period === period);
  const periodPayments = payments.filter(item => item.status !== "voided" && String(item.paymentDate || "").startsWith(period));
  const periodReceipts = receipts.filter(item => item.status !== "voided" && String(item.receiptDate || "").startsWith(period));
  const statementLines = periodStatements.flatMap(statement => statement.lines || []);
  const missingInvoiceLinks = periodInvoices.filter(item => item.matchStatus !== "confirmed" || !invoiceAllocations(item).length);
  const incompleteTaxFields = periodInvoices.filter(item => !item.invoiceKind || item.invoiceKind === "unspecified" || item.taxAmount === null || item.taxAmount === undefined || !item.sellerTaxId || !item.buyerTaxId);
  const missingStatementLinks = statementLines.filter(item => item.matchStatus !== "confirmed" || !item.projectId);
  const unconfirmedStatements = periodStatements.filter(item => item.status !== "confirmed");
  const legacyStatementSnapshots = periodStatements.filter(item => item.status === "confirmed" && !item.reconciliation);
  const legacyInvoiceOnly = projects.filter(project => project.invoiced && String(project.invoiceDate || "").startsWith(period) && !periodInvoices.some(invoice => invoice.direction === "customer" && invoiceAllocations(invoice).some(row => row.projectId === project.id)));
  const evidence = reconciliationEvidence({ periodInvoices, periodStatements, periodPayments, periodReceipts, legacyInvoiceOnly });
  const latestSnapshot = snapshots.filter(item => item.period === period).sort((a, b) => b.version - a.version)[0] || null;
  const changedSinceSnapshot = Boolean(latestSnapshot?.evidenceHash && latestSnapshot.evidenceHash !== evidence.hash);
  const blockers = [
    ...(missingInvoiceLinks.length ? [{ code: "unmatched_invoices", label: `${missingInvoiceLinks.length} 张发票尚未确认项目` }] : []),
    ...(missingStatementLinks.length ? [{ code: "unmatched_statement_lines", label: `${missingStatementLinks.length} 条供应商对账明细尚未确认项目` }] : []),
    ...(unconfirmedStatements.length ? [{ code: "unconfirmed_supplier_statements", label: `${unconfirmedStatements.length} 份供应商对账单尚未完成金额核对` }] : []),
    ...(legacyInvoiceOnly.length ? [{ code: "legacy_invoice_without_record", label: `${legacyInvoiceOnly.length} 个项目只有已开票标记，没有发票明细` }] : [])
  ];
  return {
    period, mode,
    warnings: [
      ...(incompleteTaxFields.length ? [{ code: "incomplete_invoice_tax_fields", label: `${incompleteTaxFields.length} 张发票的票种、税额或购销方税号尚未补齐`, invoiceIds: incompleteTaxFields.map(item => item.id) }] : []),
      ...(legacyStatementSnapshots.length ? [{ code: "legacy_statement_without_balance_snapshot", label: `${legacyStatementSnapshots.length} 份旧对账单没有金额核对快照，请人工抽查` }] : []),
      ...(latestSnapshot && !latestSnapshot.evidenceHash ? [{ code: "legacy_month_end_without_evidence", label: "最近的旧版月末快照没有单据证据指纹，请人工复核后生成新版本" }] : []),
      ...(changedSinceSnapshot ? [{ code: "month_end_data_changed_after_snapshot", label: `当前单据已不同于月末快照 v${latestSnapshot.version}，请重新核对并生成新版本` }] : [])
    ],
    summary: {
      invoiceCount: periodInvoices.length,
      customerInvoiceAmount: periodInvoices.filter(item => item.direction === "customer").reduce((sum, item) => sum + Number(item.amount || 0), 0),
      supplierInvoiceAmount: periodInvoices.filter(item => item.direction === "supplier").reduce((sum, item) => sum + Number(item.amount || 0), 0),
      statementCount: periodStatements.length,
      statementAmount: statementLines.reduce((sum, item) => sum + Number(item.amount || 0), 0),
      supplierPaymentCount: periodPayments.length,
      supplierPaymentAmount: periodPayments.reduce((sum, item) => sum + Number(item.amount || 0), 0),
      customerReceiptCount: periodReceipts.length,
      customerReceiptAmount: periodReceipts.reduce((sum, item) => sum + Number(item.amount || 0), 0)
    },
    blockers,
    ready: mode === "month_end" && blockers.length === 0,
    evidenceHash: evidence.hash,
    evidenceManifest: evidence.manifest,
    changedSinceSnapshot,
    latestSnapshot
  };
}

module.exports = { createInvoice, createStatement, invoiceAllocations, invoiceCandidates, invoiceKey, invoiceTaxFields, parseDelimited, parseInvoiceCsv, parseInvoiceRows, parseStatementRows, parseStatementText, reconciliationEvidence, reconciliationView, statementDate, statementReconciliation, validateInvoiceAllocations };
