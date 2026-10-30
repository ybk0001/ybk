const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const reliableBackup = require("./reliable-backup");
const { saveUpload } = require("./atomic-upload");
const taxAssistant = require("./tax-assistant");
const { writeZip } = require("./local-zip");
const { pipeline } = require("node:stream/promises");
const taxLedger = require("./tax-ledger");
const spreadsheetReader = require("./spreadsheet-reader");
const paymentLedger = require("./payment-ledger");
const bankLedger = require("./bank-ledger");
const receiptLedger = require("./receipt-ledger");
const legacyMigration = require("./legacy-migration");
const dataDirectoryLock = require("./data-directory-lock");
const auditLedger = require("./audit-ledger");
const { buildFinanceReport } = require("./finance-report");
let backupBusy = false;
let activeWrites = 0;

const PORT = Number(process.env.PORT || 3000);
const BIND_HOST = process.env.BIND_HOST || "0.0.0.0";
const DATA_DIR = process.env.PROJECT_DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "projects.json");
const SUPPLIERS_FILE = path.join(DATA_DIR, "suppliers.json");
const LEGACY_FILES_DIR = path.join(DATA_DIR, "project-files");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const DEFAULT_FILES_DIR = process.env.PROJECT_ARCHIVE_DIR || "D:\\文件";
const DEFAULT_NETWORK_SHARE_NAME = "EnterpriseProjects";
const INVENTORY_FILE = path.join(DATA_DIR, "inventory.json");
const EXPENSES_FILE = path.join(DATA_DIR, "expenses.json");
const PROCESSES_FILE = path.join(DATA_DIR, "processes.json");
const CUSTOMERS_FILE = path.join(DATA_DIR, "customers.json");
const TODOS_FILE = path.join(DATA_DIR, "todos.json");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const AUDIT_FILE = path.join(DATA_DIR, "audit-log.json");
const AUDIT_HEAD_FILE = path.join(DATA_DIR, "audit-head.json");
const PRODUCT_TEMPLATES_FILE = path.join(DATA_DIR, "product-templates.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const SETTLEMENT_BATCHES_FILE = path.join(DATA_DIR, "settlement-batches.json");
const INVOICES_FILE = path.join(DATA_DIR, "invoices.json");
const SUPPLIER_STATEMENTS_FILE = path.join(DATA_DIR, "supplier-statements.json");
const TAX_RECONCILIATIONS_FILE = path.join(DATA_DIR, "tax-reconciliations.json");
const SUPPLIER_PAYMENTS_FILE = path.join(DATA_DIR, "supplier-payments.json");
const BANK_TRANSACTIONS_FILE = path.join(DATA_DIR, "bank-transactions.json");
const CUSTOMER_RECEIPTS_FILE = path.join(DATA_DIR, "customer-receipts.json");
const TAX_ASSISTANT_REVIEWS_FILE = path.join(DATA_DIR, "tax-assistant-reviews.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const PUBLIC_DIR = path.join(__dirname, "public");
const SESSION_DAYS = 180;
const SESSION_MAX_AGE = SESSION_DAYS * 86400;
const sessions = new Map();
const ALL_PERMISSIONS = ["dashboard", "order", "projects", "settlement", "payments", "sales", "expenses", "files", "suppliers", "customers", "inventory", "processes"];

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); } catch { return {}; }
}

function archiveRootDir() {
  const configured = String(readSettings().archiveRoot || process.env.PROJECT_ARCHIVE_DIR || "").trim();
  return path.resolve(configured && path.isAbsolute(configured) ? configured : DEFAULT_FILES_DIR);
}

function archiveRootDirs() {
  const settings = readSettings();
  return [archiveRootDir(), ...(Array.isArray(settings.archiveRootAliases) ? settings.archiveRootAliases : [])]
    .filter(item => item && path.isAbsolute(item))
    .map(item => path.resolve(item))
    .filter((item, index, items) => items.findIndex(candidate => candidate.toLocaleLowerCase() === item.toLocaleLowerCase()) === index);
}

function networkShareName() {
  return safeSegment(readSettings().networkShareName || DEFAULT_NETWORK_SHARE_NAME, DEFAULT_NETWORK_SHARE_NAME);
}

function isLocalRequest(req) {
  const address = String(req.socket?.remoteAddress || "").toLowerCase();
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function projectNetworkPath(folder, req) {
  const root = path.resolve(archiveRootDir());
  const target = path.resolve(folder);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error("项目文件夹不在当前共享根目录中");
  const relative = path.relative(root, target);
  const requestHost = String(req?.headers?.host || "").replace(/^\[|\](?::\d+)?$/g, "").split(":")[0];
  const networkHost = requestHost && !["localhost", "127.0.0.1", "::1"].includes(requestHost.toLowerCase()) ? requestHost : os.hostname();
  return `\\\\${networkHost}\\${networkShareName()}${relative ? `\\${relative}` : ""}`;
}

function writeSettings(settings) {
  const temporary = `${SETTINGS_FILE}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(settings, null, 2), "utf8"); fs.renameSync(temporary, SETTINGS_FILE); }
  catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
}

function ensureDataFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "[]", "utf8");
  if (!fs.existsSync(SUPPLIERS_FILE)) fs.writeFileSync(SUPPLIERS_FILE, "[]", "utf8");
  if (!fs.existsSync(INVENTORY_FILE)) fs.writeFileSync(INVENTORY_FILE, "[]", "utf8");
  if (!fs.existsSync(EXPENSES_FILE)) fs.writeFileSync(EXPENSES_FILE, "[]", "utf8");
  if (!fs.existsSync(PROCESSES_FILE)) fs.writeFileSync(PROCESSES_FILE, "[]", "utf8");
  if (!fs.existsSync(CUSTOMERS_FILE)) fs.writeFileSync(CUSTOMERS_FILE, "[]", "utf8");
  if (!fs.existsSync(TODOS_FILE)) fs.writeFileSync(TODOS_FILE, "[]", "utf8");
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "[]", "utf8");
  if (!fs.existsSync(AUDIT_FILE)) fs.writeFileSync(AUDIT_FILE, "[]", "utf8");
  if (!fs.existsSync(PRODUCT_TEMPLATES_FILE)) fs.writeFileSync(PRODUCT_TEMPLATES_FILE, JSON.stringify([{ id: "banner", name: "条幅", mode: "area", rate: 25, enabled: true, unit: "条" }], null, 2), "utf8");
  if (!fs.existsSync(SESSIONS_FILE)) fs.writeFileSync(SESSIONS_FILE, "[]", "utf8");
  if (!fs.existsSync(SETTLEMENT_BATCHES_FILE)) fs.writeFileSync(SETTLEMENT_BATCHES_FILE, "[]", "utf8");
  if (!fs.existsSync(INVOICES_FILE)) fs.writeFileSync(INVOICES_FILE, "[]", "utf8");
  if (!fs.existsSync(SUPPLIER_STATEMENTS_FILE)) fs.writeFileSync(SUPPLIER_STATEMENTS_FILE, "[]", "utf8");
  if (!fs.existsSync(TAX_RECONCILIATIONS_FILE)) fs.writeFileSync(TAX_RECONCILIATIONS_FILE, "[]", "utf8");
  if (!fs.existsSync(SUPPLIER_PAYMENTS_FILE)) fs.writeFileSync(SUPPLIER_PAYMENTS_FILE, "[]", "utf8");
  if (!fs.existsSync(BANK_TRANSACTIONS_FILE)) fs.writeFileSync(BANK_TRANSACTIONS_FILE, "[]", "utf8");
  if (!fs.existsSync(CUSTOMER_RECEIPTS_FILE)) fs.writeFileSync(CUSTOMER_RECEIPTS_FILE, "[]", "utf8");
  if (!fs.existsSync(TAX_ASSISTANT_REVIEWS_FILE)) fs.writeFileSync(TAX_ASSISTANT_REVIEWS_FILE, "[]", "utf8");
  if (!fs.existsSync(SETTINGS_FILE)) writeSettings({ archiveRoot: DEFAULT_FILES_DIR, archiveRootAliases: [] });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.mkdirSync(LEGACY_FILES_DIR, { recursive: true });
  fs.mkdirSync(archiveRootDir(), { recursive: true });
}

function safeSegment(value, fallback = "未命名") {
  const cleaned = String(value || "").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/\.+$/g, "").trim();
  return cleaned.slice(0, 120) || fallback;
}

function projectArchiveParts(project) {
  return legacyProjectArchiveParts(project);
}

function customerProjectArchiveParts(project) {
  return [safeSegment(project?.customer, "未分类客户"), safeSegment(project?.name, "未命名项目")];
}

function legacyProjectArchiveParts(project) {
  const date = String(project?.contractDate || project?.createdAt || "");
  const year = /^\d{4}/.test(date) ? date.slice(0, 4) : String(new Date().getFullYear());
  const monthNumber = /^\d{4}-\d{2}/.test(date) ? Number(date.slice(5, 7)) : new Date().getMonth() + 1;
  return [`${year}年`, `${monthNumber}月`, safeSegment(project?.customer, "未分类客户"), safeSegment(project?.name, "未命名项目")];
}

function canonicalProjectDir(project, root = archiveRootDir()) {
  return path.join(root, ...projectArchiveParts(project));
}

function customerProjectDir(project, root = archiveRootDir()) {
  return path.join(root, ...customerProjectArchiveParts(project));
}

function normalizedFolderName(value) {
  return String(value || "").replace(/[\s_\-()（）]/g, "").toLocaleLowerCase("zh-CN");
}

function existingProjectDir(project, root = archiveRootDir()) {
  const [year, month, customerFolder, projectFolder] = legacyProjectArchiveParts(project);
  const monthDir = path.join(root, year, month);
  if (!fs.existsSync(monthDir)) return null;
  const previousCanonical = path.join(monthDir, customerFolder, projectFolder);
  if (fs.existsSync(previousCanonical)) return previousCanonical;
  const projectName = normalizedFolderName(project?.name);
  const aliases = [project?.customerGroup, project?.customerContact].map(normalizedFolderName).filter(value => value.length >= 2);
  const directories = fs.readdirSync(monthDir, { withFileTypes: true }).filter(entry => entry.isDirectory());
  const exact = directories.find(entry => aliases.includes(normalizedFolderName(entry.name)));
  if (exact) return path.join(monthDir, exact.name);
  const projectMatch = directories.find(entry => {
    const folder = normalizedFolderName(entry.name);
    return folder.length >= 2 && projectName && (projectName.includes(folder) || folder.includes(projectName));
  });
  if (projectMatch) return path.join(monthDir, projectMatch.name);
  const customer = normalizedFolderName(project?.customer);
  const customerMatch = directories.find(entry => customer.length >= 2 && normalizedFolderName(entry.name) === customer);
  return customerMatch ? path.join(monthDir, customerMatch.name) : null;
}

function projectFilesDir(project) {
  return canonicalProjectDir(project);
}

function projectArchiveRoots(project) {
  const aliases = (Array.isArray(project?.archiveAliases) ? project.archiveAliases : []).flatMap(relativePath => {
    try { return [resolveArchiveFile(relativePath).target]; } catch { return []; }
  });
  const configuredRoots = archiveRootDirs().flatMap(root => [canonicalProjectDir(project, root), customerProjectDir(project, root), existingProjectDir(project, root)]);
  return [...configuredRoots, ...aliases]
    .filter(Boolean)
    .filter((item, index, items) => items.findIndex(candidate => path.resolve(candidate) === path.resolve(item)) === index);
}

function listFilesRecursive(root, current = root) {
  if (!fs.existsSync(current)) return [];
  const rows = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      rows.push(...listFilesRecursive(root, fullPath));
    } else {
      const stat = fs.statSync(fullPath);
      rows.push({
        name: entry.name,
        relativePath: path.relative(root, fullPath).replace(/\\/g, "/"),
        size: stat.size,
        updatedAt: stat.mtime.toISOString()
      });
    }
  }
  return rows;
}

function archiveRelativePath(filePath) {
  const resolvedFile = path.resolve(filePath);
  const currentRoot = path.resolve(archiveRootDir());
  if (resolvedFile === currentRoot || resolvedFile.startsWith(currentRoot + path.sep)) return path.relative(currentRoot, resolvedFile).replace(/\\/g, "/");
  return resolvedFile.replace(/\\/g, "/");
}

function resolveArchiveFile(relativePath) {
  const value = String(relativePath || "");
  const root = path.resolve(archiveRootDir());
  const target = path.resolve(path.isAbsolute(value) ? value : path.join(root, value));
  const allowed = archiveRootDirs().some(candidate => target === candidate || target.startsWith(candidate + path.sep));
  if (!allowed) throw new Error("文件路径不安全");
  return { root, target };
}

function filesForProject(project) {
  const root = projectFilesDir(project);
  const archiveFolder = archiveRelativePath(root);
  const roots = projectArchiveRoots(project);
  const files = roots.flatMap(sourceRoot => {
    const sourceArchiveFolder = archiveRelativePath(sourceRoot);
    return listFilesRecursive(sourceRoot).map(file => ({ ...file, archivePath: `${sourceArchiveFolder}/${file.relativePath}` }));
  });
  return { root, archiveFolder, files };
}

function validInvoiceAttachmentSignature(filePath, extension) {
  const fd = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(12); const length = fs.readSync(fd, header, 0, header.length, 0); const bytes = header.subarray(0, length);
    if (extension === ".pdf") return bytes.subarray(0, 4).toString("ascii") === "%PDF";
    if (extension === ".png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if ([".jpg", ".jpeg"].includes(extension)) return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (extension === ".webp") return bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
    return false;
  } finally { fs.closeSync(fd); }
}

function inventoryState(material) {
  let quantity = Math.max(0, Number(material.openingQuantity || 0));
  let value = quantity * Math.max(0, Number(material.openingUnitCost ?? material.unitCost ?? 0));
  const transactions = [...(material.transactions || [])].sort((a, b) => String(a.createdAt || a.date || "").localeCompare(String(b.createdAt || b.date || "")));
  for (const row of transactions) {
    const rowQuantity = Math.max(0, Number(row.quantity || 0));
    if (row.type === "in") {
      const unitCost = Math.max(0, Number(row.unitCost || 0));
      quantity += rowQuantity;
      value += rowQuantity * unitCost;
    } else {
      const averageCost = quantity > 0 ? value / quantity : 0;
      const actualQuantity = Math.min(quantity, rowQuantity);
      quantity -= actualQuantity;
      value = Math.max(0, value - actualQuantity * averageCost);
    }
  }
  return { quantity, value, averageCost: quantity > 0 ? value / quantity : 0 };
}

function readList(filePath) {
  ensureDataFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ''));
    if (!Array.isArray(parsed)) throw new Error('数据必须为数组');
    return parsed.map(item => ({ ...item, _version: recordVersion(item) }));
  } catch (error) {
    throw new Error(`数据文件读取失败：${path.basename(filePath)}；已停止操作以避免覆盖。${error.message}`);
  }
}

function writeList(filePath, items) {
  ensureDataFile();
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(items.map(({ _version, ...item }) => item), null, 2), "utf8");
  fs.renameSync(tmp, filePath);
  items.forEach(item => { item._version = recordVersion(item); });
}

function readProjects() {
  return readList(DATA_FILE);
}

function writeProjects(projects) {
  writeList(DATA_FILE, projects);
}

function recordVersion(item) {
  const { _version, ...value } = item;
  return reliableBackup.hash(JSON.stringify(value));
}
function checkRecordVersion(req) {
  const match = new URL(req.url, 'http://localhost').pathname.match(/^\/api\/(projects|customers|suppliers|processes|inventory|expenses|todos|product-templates|users|invoices|supplier-statements|supplier-payments|customer-receipts|bank-transactions|settlement-batches)\/([^/]+)$/);
  if (!match || !['PUT', 'DELETE'].includes(req.method)) return;
  const files = { projects: DATA_FILE, customers: CUSTOMERS_FILE, suppliers: SUPPLIERS_FILE, processes: PROCESSES_FILE, inventory: INVENTORY_FILE, expenses: EXPENSES_FILE, todos: TODOS_FILE, 'product-templates': PRODUCT_TEMPLATES_FILE, users: USERS_FILE, invoices: INVOICES_FILE, 'supplier-statements': SUPPLIER_STATEMENTS_FILE, 'supplier-payments': SUPPLIER_PAYMENTS_FILE, 'customer-receipts': CUSTOMER_RECEIPTS_FILE, 'bank-transactions': BANK_TRANSACTIONS_FILE, 'settlement-batches': SETTLEMENT_BATCHES_FILE };
  const record = readList(files[match[1]]).find(item => item.id === decodeURIComponent(match[2]));
  if (!record) return;
  const version = req.headers['if-match']?.replace(/^"|"$/g, '');
  if (!version) throw Object.assign(new Error('页面版本已过期，请刷新后重新打开记录再保存。'), { status: 428 });
  if (version !== recordVersion(record)) throw Object.assign(new Error('这条记录已被其他操作修改，本次没有覆盖。你的表单仍保留，请复制需要保留的内容，再重新打开最新记录核对。'), { status: 409 });
}
const backupTargets = () => [[DATA_FILE, 'projects'], [CUSTOMERS_FILE, 'customers'], [SUPPLIERS_FILE, 'suppliers'], [INVENTORY_FILE, 'inventory'], [EXPENSES_FILE, 'expenses'], [PROCESSES_FILE, 'processes'], [TODOS_FILE, 'todos'], [PRODUCT_TEMPLATES_FILE, 'productTemplates'], [USERS_FILE, 'users'], [SETTLEMENT_BATCHES_FILE, 'settlementBatches'], [INVOICES_FILE, 'invoices'], [SUPPLIER_STATEMENTS_FILE, 'supplierStatements'], [TAX_RECONCILIATIONS_FILE, 'taxReconciliations'], [SUPPLIER_PAYMENTS_FILE, 'supplierPayments'], [BANK_TRANSACTIONS_FILE, 'bankTransactions'], [CUSTOMER_RECEIPTS_FILE, 'customerReceipts'], [TAX_ASSISTANT_REVIEWS_FILE, 'taxAssistantReviews'], [AUDIT_FILE, 'auditLog']];
function fullBackupState() {
  const directories = [...new Set([...archiveRootDirs(), LEGACY_FILES_DIR].map(p => path.resolve(p)))];
  const roots = Object.fromEntries(directories.map((p, i) => [`r${i}`, p]));
  return { roots, manifest: { format: 'enterprise-project-manager-backup', version: 2, exportedAt: new Date().toISOString(), settings: readSettings(), roots: Object.keys(roots), legacyRoot: `r${directories.indexOf(path.resolve(LEGACY_FILES_DIR))}`, data: Object.fromEntries(backupTargets().map(([file, key]) => [key, readList(file)])) } };
}
async function mergeFullBackup(staged, user) {
  const { manifest, files } = staged;
  const changes = [], conflicts = [], result = {};
  for (const [file, key] of backupTargets()) {
    const incoming = manifest.data[key];
    if (incoming === undefined && ['settlementBatches', 'invoices', 'supplierStatements', 'taxReconciliations', 'supplierPayments', 'bankTransactions', 'customerReceipts'].includes(key)) continue;
    if (!Array.isArray(incoming) || incoming.some(row => !row || typeof row.id !== 'string' || !row.id)) throw Object.assign(new Error(`备份中的${key}数据无效`), { status: 400 });
    const normalizedIncoming = key === 'auditLog' ? incoming.map(auditLedger.asImportedLegacy) : incoming;
    const current = readList(file), merged = new Map(current.map(row => [row.id, row]));
    for (const row of normalizedIncoming) {
      const existing = merged.get(row.id);
      const sameUsername = key === 'users' && [...merged.values()].some(value => value.username === row.username && value.id !== row.id);
      if (existing || sameUsername) {
        if (sameUsername || recordVersion(existing) !== recordVersion(row)) conflicts.push({ type: key, name: row.name || row.username || row.id, reason: '保留现有记录' });
      } else merged.set(row.id, row);
    }
    changes.push({ file, rows: [...merged.values()] });
    result[key] = { added: merged.size - current.length };
  }
  const settings = readSettings();
  const restoredBase = path.join(DATA_DIR, 'restored-archives', crypto.randomUUID());
  const rootMap = Object.fromEntries(manifest.roots.map(key => [key, key === 'r0' ? archiveRootDir() : key === manifest.legacyRoot ? LEGACY_FILES_DIR : path.join(restoredBase, key)]));
  const pending = [];
  for (const file of files) {
    const target = reliableBackup.safePath(rootMap[file.root], file.path);
    if (fs.existsSync(target)) {
      if (!fs.statSync(target).isFile() || await reliableBackup.fileHash(target) !== file.sha256) conflicts.push({ type: 'attachment', name: file.path, reason: '保留现有附件' });
    } else pending.push({ ...file, target });
  }
  const snapshot = safetyBackup('complete-restore');
  fs.copyFileSync(SETTINGS_FILE, path.join(snapshot, 'settings.json'));
  const created = [];
  try {
    for (const file of pending) {
      fs.mkdirSync(path.dirname(file.target), { recursive: true });
      fs.copyFileSync(file.staged, file.target, fs.constants.COPYFILE_EXCL); created.push(file.target);
    }
    for (const change of changes) writeList(change.file, change.rows);
    // Device-specific paths stay local. Other settings only fill missing values.
    const { archiveRoot, archiveRootAliases, networkShareName, features: restoredFeatures, ...portable } = manifest.settings || {};
    const aliases = Object.entries(rootMap).filter(([key]) => key !== 'r0' && key !== manifest.legacyRoot).map(([, root]) => root);
    writeSettings({ ...portable, ...settings, archiveRootAliases: [...new Set([...(settings.archiveRootAliases || []), ...aliases])] });
    audit(user, '恢复完整备份（合并）', 'backup', 'full', `新增附件${created.length}，冲突${conflicts.length}`);
    return { ...result, attachments: { added: created.length }, conflicts, snapshot };
  } catch (error) {
    for (const [file] of backupTargets()) fs.copyFileSync(path.join(snapshot, path.basename(file)), file);
    fs.copyFileSync(path.join(snapshot, 'settings.json'), SETTINGS_FILE);
    for (const file of created) fs.unlinkSync(file);
    throw error;
  }
}

function safetyBackup(reason) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const folder = path.join(BACKUP_DIR, `before-${safeSegment(reason, "data-change")}-${stamp}`);
  fs.mkdirSync(folder, { recursive: true });
  for (const [file] of backupTargets()) {
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(folder, path.basename(file)));
  }
  return folder;
}

function readAuditHead() {
  if (!fs.existsSync(AUDIT_HEAD_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(AUDIT_HEAD_FILE, "utf8").replace(/^\uFEFF/, "")); }
  catch (error) { return { invalid: true, error: error.message }; }
}

function writeAuditHead(head) {
  const tmp = `${AUDIT_HEAD_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(head, null, 2), "utf8");
  fs.renameSync(tmp, AUDIT_HEAD_FILE);
}

function audit(user, action, targetType, targetId, detail = "") {
  const rows = readList(AUDIT_FILE);
  const previousHead = readAuditHead();
  const entry = auditLedger.createEntry({ id: crypto.randomUUID(), at: new Date().toISOString(), userId: user?.id || "system", userName: user?.displayName || "系统", action, targetType, targetId, detail }, rows, previousHead?.invalid ? null : previousHead);
  try {
    writeList(AUDIT_FILE, [entry, ...rows].slice(0, 5000));
    writeAuditHead({ entryId: entry.id, entryHash: entry.entryHash, sequence: entry.sequence, updatedAt: entry.at });
  } catch (error) {
    writeList(AUDIT_FILE, rows);
    throw error;
  }
}

function dailyBackup() {
  const day = new Date().toLocaleDateString("sv-SE");
  const folder = path.join(BACKUP_DIR, `${day}-complete-v4`);
  if (fs.existsSync(folder)) return;
  fs.mkdirSync(folder, { recursive: true });
  for (const file of [SETTINGS_FILE, AUDIT_HEAD_FILE, ...backupTargets().map(([target]) => target)]) {
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(folder, path.basename(file)));
  }
}

function masterKey(value) {
  return String(value || "").trim().toLocaleLowerCase("zh-CN");
}

function meaningfulMasterValue(value) {
  const text = String(value || "").trim();
  return text && !["/", "-", "未填写客户", "未填供应商", "未填写供应商"].includes(text) ? text : "";
}

function masterCategoryLabel(value) {
  const category = String(value || "").trim();
  return ({ purchase: "采购", processing: "加工", outsourcing: "外包", logistics: "物流", design: "设计", other: "其他" })[category] || category;
}

function syncMasterDataFromProjects(projectRows) {
  const rows = Array.isArray(projectRows) ? projectRows : [projectRows];
  const now = new Date().toISOString();
  const suppliers = readList(SUPPLIERS_FILE);
  const customers = readList(CUSTOMERS_FILE);
  const processes = readList(PROCESSES_FILE);
  let suppliersChanged = false;
  let customersChanged = false;
  let processesChanged = false;

  for (const project of rows) {
    const company = meaningfulMasterValue(project.customer);
    if (company) {
      const group = String(project.customerGroup || "").trim();
      const contact = String(project.customerContact || "").trim();
      const phone = String(project.customerPhone || "").trim();
      const existing = customers.find(item =>
        (project.customerId && item.id === project.customerId) ||
        (masterKey(item.company) === masterKey(company) && masterKey(item.group) === masterKey(group) && masterKey(item.contact) === masterKey(contact))
      );
      if (!existing) {
        customers.unshift({ id: crypto.randomUUID(), company, group, contact, phone, remark: "项目录入自动同步", createdAt: now, updatedAt: now });
        customersChanged = true;
      } else {
        const additions = {};
        if (!existing.company) additions.company = company;
        if (!existing.group && group) additions.group = group;
        if (!existing.contact && contact) additions.contact = contact;
        if (!existing.phone && phone) additions.phone = phone;
        if (Object.keys(additions).length) {
          Object.assign(existing, additions, { updatedAt: now });
          customersChanged = true;
        }
      }
    }

    for (const item of Array.isArray(project.supplierItems) ? project.supplierItems : []) {
      const supplierName = meaningfulMasterValue(item.supplier);
      const processName = meaningfulMasterValue(item.process);
      const category = masterCategoryLabel(item.category);
      if (supplierName) {
        const existingSupplier = suppliers.find(entry => masterKey(entry.name) === masterKey(supplierName));
        if (!existingSupplier) {
          suppliers.unshift({ id: crypto.randomUUID(), name: supplierName, contact: "", phone: "", category, process: processName, remark: "项目录入自动同步", createdAt: now, updatedAt: now });
          suppliersChanged = true;
        } else if ((!existingSupplier.category && category) || (!existingSupplier.process && processName)) {
          if (!existingSupplier.category && category) existingSupplier.category = category;
          if (!existingSupplier.process && processName) existingSupplier.process = processName;
          existingSupplier.updatedAt = now;
          suppliersChanged = true;
        } else if (existingSupplier.remark === "项目录入自动同步" && existingSupplier.category !== masterCategoryLabel(existingSupplier.category)) {
          existingSupplier.category = masterCategoryLabel(existingSupplier.category);
          existingSupplier.updatedAt = now;
          suppliersChanged = true;
        }
      }
      if (processName) {
        const existingProcess = processes.find(entry => masterKey(entry.name) === masterKey(processName));
        if (!existingProcess) {
          processes.unshift({ id: crypto.randomUUID(), name: processName, category, remark: "项目录入自动同步", createdAt: now, updatedAt: now });
          processesChanged = true;
        } else if ((!existingProcess.category && category) || (existingProcess.remark === "项目录入自动同步" && existingProcess.category !== masterCategoryLabel(existingProcess.category))) {
          existingProcess.category = category || masterCategoryLabel(existingProcess.category);
          existingProcess.updatedAt = now;
          processesChanged = true;
        }
      }
    }
  }

  if (suppliersChanged) writeList(SUPPLIERS_FILE, suppliers);
  if (customersChanged) writeList(CUSTOMERS_FILE, customers);
  if (processesChanged) writeList(PROCESSES_FILE, processes);
}

function bodyJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) {
        req.destroy();
        reject(new Error("请求内容过大"));
      }
    });
    req.on("end", () => {
      try {
        if (backupBusy && !req.backupOwner) throw Object.assign(new Error('正在备份或恢复，请完成后再保存。'), { status: 423 });
        checkRecordVersion(req);
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error instanceof SyntaxError ? new Error("JSON 格式错误") : error);
      }
    });
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, If-Match",
    "Access-Control-Allow-Credentials": "true"
  });
  res.end(JSON.stringify(data));
}

function passwordHash(password, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 64).toString("hex") };
}

function publicUser(user) {
  return { id: user.id, _version: recordVersion(user), username: user.username, displayName: user.displayName, role: user.role, enabled: user.enabled !== false, permissions: user.role === "main" ? ALL_PERMISSIONS : (user.permissions || []) };
}

function currentUser(req) {
  const token = String(req.headers.cookie || "").split(/;\s*/).find(item => item.startsWith("enterprise_session="))?.split("=")[1];
  if (!token || !sessions.has(token)) return null;
  const session = sessions.get(token);
  if (!session?.expiresAt || new Date(session.expiresAt).getTime() <= Date.now()) { sessions.delete(token); saveSessions(); return null; }
  const user = readList(USERS_FILE).find(item => item.id === session.userId);
  return user && user.enabled !== false ? user : null;
}

function saveSessions() {
  writeList(SESSIONS_FILE, [...sessions].map(([token, value]) => ({ token, ...value })));
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { userId, expiresAt: new Date(Date.now() + SESSION_DAYS * 86400000).toISOString() });
  saveSessions();
  return token;
}

function can(user, permission) { return user?.role === "main" || (user?.permissions || []).includes(permission); }
function owns(item, user) { return user?.role === "main" || item.ownerUserId === user?.id; }
function canUseProjectFiles(project, user) { return owns(project, user) || can(user, "files"); }
function canAccessProjectFile(target, user) {
  if (user?.role === "main") return true;
  const resolvedTarget = path.resolve(target);
  return readProjects().filter(project => canUseProjectFiles(project, user)).some(project => {
    const roots = projectArchiveRoots(project).map(item => path.resolve(item));
    return roots.some(root => resolvedTarget === root || resolvedTarget.startsWith(root + path.sep));
  });
}

function routePermission(pathname) {
  if (pathname.startsWith("/api/customer-receipts")) return "settlement";
  if (pathname.startsWith("/api/bank-transactions")) return "payments";
  if (pathname.startsWith("/api/supplier-payments")) return "payments";
  if (pathname.startsWith("/api/settlement-batches")) return "settlement";
  if (pathname.startsWith("/api/todos")) return "dashboard";
  if (pathname.startsWith("/api/project-files")) return "files";
  if (pathname.startsWith("/api/files") || pathname === "/api/file-projects") return "files";
  if (pathname.startsWith("/api/suppliers")) return "suppliers";
  if (pathname.startsWith("/api/customers")) return "customers";
  if (pathname.startsWith("/api/processes")) return "processes";
  if (pathname.startsWith("/api/inventory")) return "inventory";
  if (pathname.startsWith("/api/expenses")) return "expenses";
  return null;
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml; charset=utf-8"
  };
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": types[ext] || "application/octet-stream",
      "Cache-Control": "no-store, no-cache, must-revalidate"
    });
    res.end(data);
  });
}

function localAddresses() {
  const addresses = [];
  for (const items of Object.values(os.networkInterfaces())) {
    for (const item of items || []) {
      if (item.family === "IPv4" && !item.internal) addresses.push(`http://${item.address}:${PORT}`);
    }
  }
  return addresses;
}

function assistantFile(relative, fileRequired = true) {
  const { target } = resolveArchiveFile(relative);
  const root = archiveRootDirs().find(candidate => target.startsWith(candidate + path.sep));
  if (!root || fs.lstatSync(root).isSymbolicLink()) throw new Error('资料路径包含链接或不在附件目录');
  let current = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('资料路径包含链接');
  }
  const realRoot = fs.realpathSync(root), realTarget = fs.realpathSync(target);
  if (!realTarget.startsWith(realRoot + path.sep) || (fileRequired ? !fs.statSync(target).isFile() : !fs.statSync(target).isDirectory())) throw new Error('资料路径无效');
  return target;
}
function assistantInput() {
  const projects = readProjects(), filesByProject = {}, fileWarnings = [];
  for (const project of projects) {
    const files = [];
    function walk(root, current = root) {
      if (!fs.existsSync(current)) return;
      if (fs.lstatSync(current).isSymbolicLink()) { fileWarnings.push('项目存在链接目录，已跳过'); return; }
      try { assistantFile(archiveRelativePath(current), false); } catch { fileWarnings.push('项目目录不可安全读取，已跳过'); return; }
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isSymbolicLink()) { fileWarnings.push('项目存在链接文件，已跳过'); continue; }
        if (entry.isDirectory()) { walk(root, full); continue; }
        if (!entry.isFile() || entry.name.endsWith('.tmp')) continue;
        try {
          assistantFile(archiveRelativePath(full));
          const stat = fs.statSync(full);
          files.push({ name:entry.name, relativePath:path.relative(root,full).replace(/\\/g,'/'), archivePath:archiveRelativePath(full), size:stat.size, updatedAt:stat.mtime.toISOString() });
        } catch { fileWarnings.push('项目存在不可读取资料，已跳过'); }
      }
    }
    for (const root of projectArchiveRoots(project)) walk(root);
    filesByProject[project.id] = [...new Map(files.map(file=>[file.archivePath,file])).values()];
  }
  return { projects, invoices:readList(INVOICES_FILE), payments:readList(SUPPLIER_PAYMENTS_FILE), receipts:readList(CUSTOMER_RECEIPTS_FILE), expenses:readList(EXPENSES_FILE), reviews:readList(TAX_ASSISTANT_REVIEWS_FILE), filesByProject, fileWarnings };
}
function assistantReport(period) {
  const input = assistantInput();
  return { ...taxAssistant.buildReport(input, period), fileWarnings:[...new Set(input.fileWarnings)] };
}
const featureState = () => ({ taxAssistant:readSettings().features?.taxAssistant===true, version:taxAssistant.fingerprint(readSettings().features||{}) });

const releaseDataDirectoryLock = dataDirectoryLock.acquire(DATA_DIR);
process.once("exit", releaseDataDirectoryLock);
ensureDataFile();
readList(SESSIONS_FILE).forEach(item => { if (item.token && item.userId && new Date(item.expiresAt).getTime() > Date.now()) sessions.set(item.token, { userId: item.userId, expiresAt: item.expiresAt }); });
dailyBackup();
syncMasterDataFromProjects(readProjects());

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return sendJson(res, 200, {});
  const writing = !['GET', 'HEAD'].includes(req.method);
  if (backupBusy && writing) return sendJson(res, 423, { error: '正在备份或恢复，暂时不能修改数据，请稍后重试。' });
  if (writing) activeWrites++;
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/api/status") {
      const statusUser = currentUser(req);
      return sendJson(res, 200, statusUser?.role === "main" ? { ok: true, port: PORT, addresses: localAddresses(), dataFile: DATA_FILE, suppliersFile: SUPPLIERS_FILE, archiveDir: archiveRootDir() } : { ok: true, port: PORT });
    }

    if (url.pathname === "/api/auth/status" && req.method === "GET") {
      const signedIn = currentUser(req);
      return sendJson(res, 200, { setupRequired: readList(USERS_FILE).length === 0, user: signedIn ? publicUser(signedIn) : null });
    }
    if (url.pathname === "/api/auth/setup" && req.method === "POST") {
      if (readList(USERS_FILE).length) return sendJson(res, 409, { error: "主账号已经创建" });
      const input = await bodyJson(req); const username = String(input.username || "").trim(); const password = String(input.password || "");
      if (username.length < 2 || password.length < 6) return sendJson(res, 400, { error: "账号至少2位，密码至少6位" });
      const user = { id: crypto.randomUUID(), username, displayName: String(input.displayName || username).trim(), role: "main", enabled: true, permissions: ALL_PERMISSIONS, ...passwordHash(password), createdAt: new Date().toISOString() };
      writeList(USERS_FILE, [user]); const token = createSession(user.id);
      res.setHeader("Set-Cookie", `enterprise_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE}`);
      return sendJson(res, 200, publicUser(user));
    }
    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      const input = await bodyJson(req); const user = readList(USERS_FILE).find(item => item.username === String(input.username || "").trim() && item.enabled !== false);
      if (!user) return sendJson(res, 401, { error: "账号或密码错误" });
      const actual = passwordHash(input.password, user.salt).hash;
      if (actual.length !== user.hash.length || !crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(user.hash))) return sendJson(res, 401, { error: "账号或密码错误" });
      const token = createSession(user.id); res.setHeader("Set-Cookie", `enterprise_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE}`);
      return sendJson(res, 200, publicUser(user));
    }
    if (url.pathname === "/api/auth/logout" && req.method === "POST") {
      const token = String(req.headers.cookie || "").split(/;\s*/).find(item => item.startsWith("enterprise_session="))?.split("=")[1];
      if (token) { sessions.delete(token); saveSessions(); } res.setHeader("Set-Cookie", "enterprise_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
      return sendJson(res, 200, { ok: true });
    }

    const user = currentUser(req);
    if (url.pathname.startsWith("/api/") && !user) return sendJson(res, 401, { error: "请先登录" });
    if (req.method === 'DELETE') checkRecordVersion(req);
    if (url.pathname === '/api/features') {
      if (user.role !== 'main') return sendJson(res,403,{error:'仅公司主账号可管理可选功能'});
      if (req.method === 'GET') return sendJson(res,200,featureState());
      if (req.method !== 'PUT') return sendJson(res,405,{error:'不支持的操作'});
      const input = await bodyJson(req);
      if (typeof input.taxAssistant !== 'boolean') return sendJson(res,400,{error:'税务助手开关必须为布尔值'});
      const current = featureState();
      if (req.headers['if-match'] !== current.version) return sendJson(res,409,{error:'功能设置已变化，请刷新后重新选择'});
      const settings = readSettings();
      writeSettings({...settings,features:{...settings.features,taxAssistant:input.taxAssistant}});
      audit(user,input.taxAssistant?'启用税务助手':'停用税务助手','settings','taxAssistant','不删除已有核对记录');
      return sendJson(res,200,featureState());
    }
    if (url.pathname.startsWith('/api/tax-assistant/')) {
      if (user.role !== 'main') return sendJson(res,403,{error:'税务助手资料仅公司主账号可查看'});
      if (!featureState().taxAssistant) return sendJson(res,403,{error:'税务助手未启用，请在系统设置的可选功能中启用'});
      const period = taxAssistant.validPeriod(url.searchParams.get('period'));
      if (url.pathname === '/api/tax-assistant/report' && req.method === 'GET') return sendJson(res,200,assistantReport(period));
      if (url.pathname === '/api/tax-assistant/review' && req.method === 'POST') {
        const input = await bodyJson(req), report = assistantReport(period);
        if (typeof input.done !== 'boolean' || typeof input.evidence !== 'string' || input.evidence.trim().length>500) return sendJson(res,400,{error:'请填写500字以内的核对说明'});
        if (input.done && !input.evidence.trim()) return sendJson(res,400,{error:'标记已核对时请填写核对说明'});
        const task = report.tasks.find(task=>task.id===input.taskId);
        if (!task || task.fingerprint!==input.fingerprint) return sendJson(res,409,{error:'资料已变化，请刷新后重新核对；本次未保存确认'});
        const rows = readList(TAX_ASSISTANT_REVIEWS_FILE), id = period+':'+task.id;
        const index = rows.findIndex(row=>row.id===id);
        if (input.reviewVersion!==taxAssistant.fingerprint(index<0?null:rows[index]))return sendJson(res,409,{error:'核对记录已被其他操作更新，请刷新后重试'});
        const row = {id,period,taskId:task.id,fingerprint:task.fingerprint,done:input.done,evidence:input.evidence.trim(),reviewedBy:user.displayName,reviewedByUserId:user.id,updatedAt:new Date().toISOString()};
        if(index<0)rows.push(row);else rows[index]=row;
        writeList(TAX_ASSISTANT_REVIEWS_FILE,rows);audit(user,'税务资料人工核对','taxAssistant',task.id,input.done?'标记已核对':'取消核对');
        return sendJson(res,200,{ok:true});
      }
      if (['/api/tax-assistant/export-preview','/api/tax-assistant/export'].includes(url.pathname) && req.method==='GET') {
        if (backupBusy || activeWrites) return sendJson(res,409,{error:'有资料正在保存或备份，请稍后预览导出'});
        const attachmentOption=url.searchParams.get('attachments')||'0';
        if (!['0','1'].includes(attachmentOption))return sendJson(res,400,{error:'附件选项无效'});
        const report=assistantReport(period), includeAttachments=attachmentOption==='1';
        const files=includeAttachments?report.attachmentFiles:[];
        const bytes=files.reduce((n,file)=>n+Number(file.size||0),0);
        const version=taxAssistant.fingerprint([report.exportFingerprint,includeAttachments]);
        if (bytes>500*1024*1024 || files.length>5900)return sendJson(res,413,{error:'附件超过500MB或数量过多，请减少附件或分批整理'});
        if (url.pathname.endsWith('export-preview'))return sendJson(res,200,{period,fingerprint:version,includeAttachments,files,attachmentBytes:bytes,records:Object.fromEntries(Object.entries(report.monthly).map(([key,rows])=>[key,rows.length])),fileWarnings:report.fileWarnings,scope:report.scope});
        if (url.searchParams.get('fingerprint')!==version)return sendJson(res,409,{error:'资料与预览已不同，请重新预览；没有导出旧版本资料'});
        let folder, ownsExportLock=true;
        backupBusy=true;
        try {
          const entries=taxAssistant.exportEntries(report);
          for(const [index,file] of files.entries())entries.push({name:`附件/${String(index+1).padStart(4,'0')}-${safeSegment(file.name)}`,file:assistantFile(file.archivePath)});
          folder=fs.mkdtempSync(path.join(BACKUP_DIR,'tax-export-'));
          const zip=path.join(folder,'monthly.zip');await writeZip(entries,zip);
          backupBusy=false;ownsExportLock=false;
          res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':`attachment; filename="accountant-materials-${period}.zip"`,'Content-Length':fs.statSync(zip).size,'Cache-Control':'no-store'});
          await pipeline(fs.createReadStream(zip),res);
        } finally { if(ownsExportLock)backupBusy=false;if(folder)fs.rmSync(folder,{recursive:true,force:true}); }
        return;
      }
      return sendJson(res,404,{error:'税务助手接口不存在'});
    }
    if (url.pathname === '/api/backup/full' && ['GET', 'POST'].includes(req.method)) {
      if (user.role !== 'main') return sendJson(res, 403, { error: '仅主账号可备份或恢复' });
      if (backupBusy || activeWrites > (writing ? 1 : 0)) return sendJson(res, 409, { error: '其他数据正在保存，请稍后重试备份。' });
      backupBusy = true; req.backupOwner = true;
      let staged;
      try {
        if (req.method === 'GET') {
          const state = fullBackupState();
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="enterprise-backup-${new Date().toISOString().slice(0, 10)}.epbackup"`, 'Cache-Control': 'no-store' });
          await reliableBackup.exportTo(res, state.manifest, state.roots);
        } else {
          staged = await reliableBackup.stage(req, BACKUP_DIR);
          const result = await mergeFullBackup(staged, user);
          sendJson(res, 200, result);
        }
      } finally {
        backupBusy = false;
        if (staged) fs.rmSync(staged.folder, { recursive: true, force: true });
      }
      return;
    }
    if (url.pathname === "/api/auth/me" && req.method === "GET") return sendJson(res, 200, publicUser(user));
    if (url.pathname === "/api/settings/archive" && req.method === "GET") {
      if (user.role !== "main") return sendJson(res, 403, { error: "仅主账号可查看文件存放位置" });
      return sendJson(res, 200, { archiveRoot: archiveRootDir(), legacyRoots: archiveRootDirs().slice(1) });
    }
    if (url.pathname === "/api/settings/archive" && req.method === "PUT") {
      if (user.role !== "main") return sendJson(res, 403, { error: "仅主账号可修改文件存放位置" });
      const input = await bodyJson(req);
      const requested = String(input.archiveRoot || "").trim();
      if (!requested || !path.isAbsolute(requested)) return sendJson(res, 400, { error: "请输入主机上的完整绝对路径，例如 D:\\企业项目文件" });
      const nextRoot = path.resolve(requested);
      if (nextRoot === path.parse(nextRoot).root) return sendJson(res, 400, { error: "不能直接使用整个磁盘根目录，请选择或填写一个专用文件夹" });
      fs.mkdirSync(nextRoot, { recursive: true });
      const previousRoot = archiveRootDir();
      const settings = readSettings();
      const aliases = [previousRoot, ...(Array.isArray(settings.archiveRootAliases) ? settings.archiveRootAliases : [])]
        .map(item => path.resolve(item))
        .filter(item => item.toLocaleLowerCase() !== nextRoot.toLocaleLowerCase())
        .filter((item, index, items) => items.findIndex(candidate => candidate.toLocaleLowerCase() === item.toLocaleLowerCase()) === index);
      writeSettings({ ...settings, archiveRoot: nextRoot, archiveRootAliases: aliases });
      audit(user, "修改项目文件根目录", "settings", "archiveRoot", `${previousRoot} → ${nextRoot}`);
      return sendJson(res, 200, { ok: true, archiveRoot: nextRoot, legacyRoots: aliases });
    }
    if (url.pathname === "/api/users" && req.method === "GET") {
      if (user.role !== "main") return sendJson(res, 403, { error: "仅主账号可管理账号" });
      return sendJson(res, 200, readList(USERS_FILE).map(publicUser));
    }
    if (url.pathname === "/api/audit/integrity" && req.method === "GET") {
      if (user.role !== "main") return sendJson(res, 403, { error: "仅主账号可验证操作日志" });
      const rows = readList(AUDIT_FILE), head = readAuditHead();
      const integrity = auditLedger.verify(rows, head?.invalid ? null : head);
      if (head?.invalid) { integrity.ok = false; integrity.status = "compromised"; integrity.errors.push({ code: "head_file_invalid" }); }
      return sendJson(res, 200, integrity);
    }
    if (url.pathname === "/api/audit" && req.method === "GET") {
      if (user.role !== "main") return sendJson(res, 403, { error: "仅主账号可查看操作日志" });
      return sendJson(res, 200, readList(AUDIT_FILE).slice(0, 300));
    }
    if (url.pathname === "/api/backups" && req.method === "GET") {
      if (user.role !== "main") return sendJson(res, 403, { error: "仅主账号可查看备份" });
      return sendJson(res, 200, fs.readdirSync(BACKUP_DIR, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort().reverse());
    }
    if (url.pathname === "/api/backup/export" && req.method === "GET") {
      if (user.role !== "main") return sendJson(res, 403, { error: "仅主账号可导出完整备份" });
      return sendJson(res, 200, {
        format: "enterprise-project-manager-backup", version: 1, exportedAt: new Date().toISOString(),
        data: Object.fromEntries(backupTargets().map(([file, key]) => [key, readList(file)]))
      });
    }
    if (url.pathname === "/api/backup/import" && req.method === "POST") {
      if (user.role !== "main") return sendJson(res, 403, { error: "仅主账号可导入完整备份" });
      const payload = await bodyJson(req);
      if (payload?.format !== "enterprise-project-manager-backup" || !payload.data) return sendJson(res, 400, { error: "不是有效的完整备份文件" });
      for (const [, key] of backupTargets()) {
        const incoming = payload.data[key];
        if (incoming !== undefined && (!Array.isArray(incoming) || incoming.some(item => !item || typeof item !== "object" || Array.isArray(item)))) return sendJson(res, 400, { error: `备份中的${key}数据无效` });
      }
      safetyBackup("before-full-backup-merge");
      const result = {};
      for (const [file, key] of backupTargets()) {
        const incoming = Array.isArray(payload.data[key]) ? payload.data[key] : [];
        const current = readList(file); const merged = new Map(current.map(item => [item.id || crypto.randomUUID(), item]));
        incoming.forEach(item => { const id = item.id || crypto.randomUUID(); if (!merged.has(id)) merged.set(id, { ...item, id }); });
        writeList(file, [...merged.values()]); result[key] = { before: current.length, added: merged.size - current.length, after: merged.size };
      }
      audit(user, "合并完整备份", "backup", "full", JSON.stringify(result));
      return sendJson(res, 200, result);
    }
    if (url.pathname === "/api/share-package" && req.method === "POST") {
      if (user.role !== "main") return sendJson(res, 403, { error: "仅主账号可生成软件分享包" });
      execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "build-clean-release.ps1")], { cwd: __dirname, windowsHide: true });
      const releaseRoot = path.join(path.dirname(__dirname), "releases");
      const zip = fs.readdirSync(releaseRoot, { withFileTypes: true })
        .filter(item => item.isFile() && /^enterprise-project-clean-.*\.zip$/i.test(item.name))
        .map(item => ({ path: path.join(releaseRoot, item.name), modifiedAt: fs.statSync(path.join(releaseRoot, item.name)).mtimeMs }))
        .sort((a, b) => b.modifiedAt - a.modifiedAt)[0]?.path;
      if (!zip) throw new Error("分享包构建完成，但未找到生成的 ZIP 文件");
      audit(user, "生成干净软件包", "software", "share", zip);
      return sendJson(res, 200, { ok: true, path: zip });
    }
    if (url.pathname === "/api/product-templates" && req.method === "GET") return sendJson(res, 200, readList(PRODUCT_TEMPLATES_FILE).filter(item => item.enabled !== false || user.role === "main"));
    if (url.pathname === "/api/product-templates" && req.method === "POST") {
      if (user.role !== "main") return sendJson(res, 403, { error: "仅主账号可管理产品模板" });
      const input = await bodyJson(req); const name = String(input.name || "").trim(); if (!name) return sendJson(res, 400, { error: "模板名称不能为空" });
      const rows = readList(PRODUCT_TEMPLATES_FILE); const saved = { id: crypto.randomUUID(), name, mode: ["area", "quantity", "pages"].includes(input.mode) ? input.mode : "quantity", rate: Math.max(0, Number(input.rate || 0)), fixedFee: Math.max(0, Number(input.fixedFee || 0)), unit: String(input.unit || "件").trim(), enabled: true };
      rows.push(saved); writeList(PRODUCT_TEMPLATES_FILE, rows); audit(user, "新增产品模板", "productTemplate", saved.id, saved.name); return sendJson(res, 200, saved);
    }
    if (url.pathname.startsWith("/api/product-templates/") && req.method === "PUT") {
      if (user.role !== "main") return sendJson(res, 403, { error: "仅主账号可管理产品模板" });
      const id = decodeURIComponent(url.pathname.replace("/api/product-templates/", "")); const input = await bodyJson(req); const rows = readList(PRODUCT_TEMPLATES_FILE); const index = rows.findIndex(item => item.id === id); if (index < 0) return sendJson(res, 404, { error: "模板不存在" });
      rows[index] = { ...rows[index], name: String(input.name || rows[index].name).trim(), rate: Math.max(0, Number(input.rate ?? rows[index].rate)), fixedFee: Math.max(0, Number(input.fixedFee ?? rows[index].fixedFee)), enabled: input.enabled !== false }; writeList(PRODUCT_TEMPLATES_FILE, rows); audit(user, "修改产品模板", "productTemplate", id, rows[index].name); return sendJson(res, 200, rows[index]);
    }
    if (url.pathname === "/api/users" && req.method === "POST") {
      if (user.role !== "main") return sendJson(res, 403, { error: "仅主账号可管理账号" });
      const input = await bodyJson(req); const users = readList(USERS_FILE); const username = String(input.username || "").trim(); const password = String(input.password || "");
      if (username.length < 2 || password.length < 6) return sendJson(res, 400, { error: "账号至少2位，密码至少6位" });
      if (users.some(item => item.username === username)) return sendJson(res, 409, { error: "账号已存在" });
      const saved = { id: crypto.randomUUID(), username, displayName: String(input.displayName || username).trim(), role: "sub", enabled: true, permissions: (input.permissions || []).filter(item => ALL_PERMISSIONS.includes(item)), ...passwordHash(password), createdAt: new Date().toISOString() };
      users.push(saved); writeList(USERS_FILE, users); audit(user, "创建子账号", "user", saved.id, saved.displayName); return sendJson(res, 200, publicUser(saved));
    }
    if (url.pathname.startsWith("/api/users/") && req.method === "PUT") {
      if (user.role !== "main") return sendJson(res, 403, { error: "仅主账号可管理账号" });
      const id = decodeURIComponent(url.pathname.replace("/api/users/", "")); const input = await bodyJson(req); const users = readList(USERS_FILE); const index = users.findIndex(item => item.id === id && item.role === "sub");
      if (index < 0) return sendJson(res, 404, { error: "子账号不存在" });
      if (input.password && String(input.password).length < 6) return sendJson(res, 400, { error: "新密码至少6位" });
      users[index] = { ...users[index], displayName: String(input.displayName || users[index].displayName).trim(), enabled: input.enabled !== false, permissions: (input.permissions || users[index].permissions || []).filter(item => ALL_PERMISSIONS.includes(item)) };
      if (input.password) {
        Object.assign(users[index], passwordHash(input.password));
        [...sessions].filter(([, session]) => session.userId === id).forEach(([token]) => sessions.delete(token));
        saveSessions();
      }
      writeList(USERS_FILE, users); audit(user, input.password ? "重置子账号密码" : "修改子账号权限", "user", users[index].id, users[index].displayName); return sendJson(res, 200, publicUser(users[index]));
    }
    const requiredPermission = routePermission(url.pathname);
    if (requiredPermission && !can(user, requiredPermission)) return sendJson(res, 403, { error: "主账号未开通此功能权限" });
    if (url.pathname.startsWith("/api/projects")) {
      const allowed = req.method === "GET"
        ? ["dashboard", "order", "projects", "settlement", "payments", "sales", "files"].some(permission => can(user, permission))
        : req.method === "POST" && url.pathname.endsWith("/events") ? ["projects", "settlement", "payments"].some(permission => can(user, permission))
          : req.method === "POST" ? can(user, "order")
          : req.method === "PUT" ? ["order", "projects", "settlement", "payments"].some(permission => can(user, permission))
            : can(user, "projects");
      if (!allowed) return sendJson(res, 403, { error: "主账号未开通此项目操作权限" });
    }
    if (["/api/import", "/api/backup/import"].includes(url.pathname) && user.role !== "main") return sendJson(res, 403, { error: "仅主账号可使用数据备份与迁移" });

    if (url.pathname.startsWith("/api/invoices") || url.pathname.startsWith("/api/supplier-statements") || url.pathname.startsWith("/api/tax-reconciliation")) {
      if (user.role !== "main") return sendJson(res, 403, { error: "仅主账号可使用发票与税务对账" });
    }

    if (url.pathname === "/api/finance-report" && req.method === "GET") {
      if (user.role !== "main") return sendJson(res, 403, { error: "仅主账号可查看财务报表" });
      try {
        return sendJson(res, 200, buildFinanceReport({ projects: readProjects(), receipts: readList(CUSTOMER_RECEIPTS_FILE), payments: readList(SUPPLIER_PAYMENTS_FILE), expenses: readList(EXPENSES_FILE) }, url.searchParams.get("period")));
      } catch (error) { return sendJson(res, 400, { error: error.message }); }
    }

    if (url.pathname === "/api/invoices" && req.method === "GET") {
      const projects = readProjects();
      return sendJson(res, 200, readList(INVOICES_FILE).map(invoice => {
        if (invoice.matchStatus === "confirmed" && taxLedger.invoiceAllocations(invoice).length) return invoice;
        const candidates = taxLedger.invoiceCandidates(invoice, projects);
        return { ...invoice, candidates, matchStatus: candidates.length ? "suggested" : "unmatched" };
      }));
    }

    if (url.pathname === "/api/invoices" && req.method === "POST") {
      const input = await bodyJson(req);
      const invoices = readList(INVOICES_FILE);
      const duplicate = invoices.find(item => taxLedger.invoiceKey(item.direction, item.invoiceNumber) === taxLedger.invoiceKey(input.direction, input.invoiceNumber));
      if (duplicate) return sendJson(res, 409, { error: "该方向和发票号码已存在，已阻止重复登记", duplicateId: duplicate.id });
      let saved;
      try { saved = taxLedger.createInvoice(input, readProjects()); }
      catch (error) { return sendJson(res, 400, { error: error.message }); }
      invoices.unshift(saved); writeList(INVOICES_FILE, invoices);
      audit(user, "登记发票", "invoice", saved.id, `${saved.direction === "customer" ? "客户" : "供应商"} · ${saved.invoiceNumber} · ${saved.amount}`);
      return sendJson(res, 200, saved);
    }

    if (url.pathname === "/api/invoices/import" && req.method === "POST") {
      const input = await bodyJson(req);
      const sourceName = path.basename(String(input.sourceName || "发票导入.csv")).slice(0, 200);
      const extension = path.extname(sourceName).toLowerCase();
      if (![".csv", ".txt", ".xlsx"].includes(extension)) return sendJson(res, 400, { error: "只支持 CSV、TXT 或 XLSX 发票文件" });
      let parsed;
      try {
        if (input.contentBase64 !== undefined) {
          const encoded = String(input.contentBase64 || "").replace(/\s/g, "");
          if (!encoded || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("发票文件内容无效");
          const content = Buffer.from(encoded, "base64");
          if (!content.length || content.length > 4 * 1024 * 1024) throw new Error("发票文件必须大于0且不超过4MB");
          parsed = extension === ".xlsx"
            ? taxLedger.parseInvoiceRows(spreadsheetReader.firstWorksheet(content), { defaultDirection: input.defaultDirection, source: "xlsx" })
            : taxLedger.parseInvoiceCsv(content.toString("utf8"), { defaultDirection: input.defaultDirection, source: "csv" });
        } else {
          parsed = taxLedger.parseInvoiceCsv(input.content, { defaultDirection: input.defaultDirection, source: "csv" });
        }
      } catch (error) { return sendJson(res, 400, { error: error.message }); }
      const invoices = readList(INVOICES_FILE);
      const existingKeys = new Set(invoices.map(item => taxLedger.invoiceKey(item.direction, item.invoiceNumber)));
      const batchKeys = new Set();
      const projects = readProjects();
      const duplicates = [];
      const saved = [];
      for (let index = 0; index < parsed.length; index += 1) {
        const row = parsed[index];
        const key = taxLedger.invoiceKey(row.direction, row.invoiceNumber);
        if (existingKeys.has(key) || batchKeys.has(key)) {
          duplicates.push({ row: index + 2, direction: row.direction, invoiceNumber: row.invoiceNumber });
          continue;
        }
        try {
          saved.push(taxLedger.createInvoice({ ...row, note: [row.note, sourceName].filter(Boolean).join(" · ") }, projects));
          batchKeys.add(key);
        } catch (error) { return sendJson(res, 422, { error: `第 ${index + 2} 行：${error.message}`, imported: 0 }); }
      }
      if (saved.length) writeList(INVOICES_FILE, [...saved.reverse(), ...invoices]);
      const report = { sourceName, total: parsed.length, imported: saved.length, duplicateCount: duplicates.length, duplicates };
      audit(user, "批量导入发票", "invoiceImport", crypto.randomUUID(), `${report.sourceName} · ${report.imported}/${report.total}张 · 重复${report.duplicateCount}张`);
      return sendJson(res, 200, report);
    }

    if (/^\/api\/invoices\/[^/]+\/attachments$/.test(url.pathname) && req.method === "POST") {
      const id = decodeURIComponent(url.pathname.split("/")[3]);
      const invoices = readList(INVOICES_FILE); const index = invoices.findIndex(item => item.id === id);
      if (index < 0) return sendJson(res, 404, { error: "发票不存在" });
      const expectedVersion = String(req.headers["if-match"] || "").replace(/^"|"$/g, "");
      if (!expectedVersion) return sendJson(res, 428, { error: "页面版本已过期，请刷新发票列表后再上传原件。" });
      if (expectedVersion !== recordVersion(invoices[index])) return sendJson(res, 409, { error: "这张发票已被其他操作修改，请刷新后核对项目分配再上传。" });
      const projectId = String(url.searchParams.get("projectId") || "");
      const project = readProjects().find(item => item.id === projectId);
      if (!project || !taxLedger.invoiceAllocations(invoices[index]).some(row => row.projectId === projectId)) return sendJson(res, 400, { error: "请选择该发票已分配的项目" });
      const fileName = safeSegment(url.searchParams.get("fileName"), "未命名发票原件");
      const extension = path.extname(fileName).toLowerCase();
      if (![".pdf", ".png", ".jpg", ".jpeg", ".webp"].includes(extension)) return sendJson(res, 400, { error: "发票原件仅支持 PDF、PNG、JPG 或 WEBP" });
      const month = /^\d{4}-\d{2}/.test(invoices[index].invoiceDate || "") ? invoices[index].invoiceDate.slice(0, 7) : "未分月";
      const attachmentId = crypto.randomUUID();
      const root = projectFilesDir(project); const destination = path.join(root, "发票", month, `${safeSegment(invoices[index].invoiceNumber, "发票")}-${attachmentId.slice(0, 8)}-${fileName}`);
      let size = 0;
      try {
        size = await saveUpload(req, destination, 20 * 1024 * 1024);
        if (!validInvoiceAttachmentSignature(destination, extension)) throw Object.assign(new Error("文件内容与发票原件格式不匹配"), { status: 400 });
        const attachment = { id: attachmentId, projectId, name: fileName, size, relativePath: archiveRelativePath(destination), uploadedBy: user.displayName, uploadedAt: new Date().toISOString() };
        const latestInvoices = readList(INVOICES_FILE); const latestIndex = latestInvoices.findIndex(item => item.id === id);
        if (latestIndex < 0 || recordVersion(latestInvoices[latestIndex]) !== expectedVersion) throw Object.assign(new Error("上传期间发票已被修改，原件未关联，请刷新后重试。"), { status: 409 });
        latestInvoices[latestIndex] = { ...latestInvoices[latestIndex], attachments: [attachment, ...(latestInvoices[latestIndex].attachments || [])], updatedAt: new Date().toISOString() };
        writeList(INVOICES_FILE, latestInvoices); audit(user, "关联发票原件", "invoice", id, `${latestInvoices[latestIndex].invoiceNumber} · ${project.name} · ${fileName}`);
        return sendJson(res, 200, attachment);
      } catch (error) {
        if (size && fs.existsSync(destination)) fs.unlinkSync(destination);
        throw error;
      }
    }

    if (url.pathname.startsWith("/api/invoices/") && req.method === "PUT") {
      const id = decodeURIComponent(url.pathname.replace("/api/invoices/", ""));
      const input = await bodyJson(req); const invoices = readList(INVOICES_FILE); const index = invoices.findIndex(item => item.id === id);
      if (index < 0) return sendJson(res, 404, { error: "发票不存在" });
      if (input.action === "update-tax-fields") {
        let taxFields;
        try { taxFields = taxLedger.invoiceTaxFields(input, invoices[index].amount); }
        catch (error) { return sendJson(res, 400, { error: error.message }); }
        invoices[index] = { ...invoices[index], ...taxFields, taxFieldsUpdatedBy: user.displayName, taxFieldsUpdatedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        writeList(INVOICES_FILE, invoices); audit(user, "补录发票税务字段", "invoice", id, `${invoices[index].invoiceNumber} · ${invoices[index].invoiceKind} · 税额${invoices[index].taxAmount ?? "未填"}`);
        return sendJson(res, 200, invoices[index]);
      }
      const projects = readProjects(); let allocations;
      try { allocations = taxLedger.validateInvoiceAllocations(invoices[index], Array.isArray(input.allocations) ? input.allocations : [{ projectId: input.projectId, amount: invoices[index].amount }], projects); }
      catch (error) { return sendJson(res, 400, { error: error.message }); }
      const linkedRows = invoices[index].direction === "supplier" ? readList(SUPPLIER_PAYMENTS_FILE) : readList(CUSTOMER_RECEIPTS_FILE);
      for (const allocation of allocations) {
        const used = linkedRows.filter(row => row.status !== "voided" && row.invoiceId === id && row.projectId === allocation.projectId).reduce((sum, row) => sum + Number(row.amount || 0), 0);
        if (used > allocation.amount + 0.001) return sendJson(res, 400, { error: `项目已核销 ${used.toFixed(2)}，分配金额不能低于已核销金额` });
      }
      const allocatedIds = new Set(allocations.map(row => row.projectId));
      if (linkedRows.some(row => row.status !== "voided" && row.invoiceId === id && !allocatedIds.has(row.projectId))) return sendJson(res, 400, { error: "不能移除已有收付款核销的项目分配" });
      invoices[index] = { ...invoices[index], allocations, projectId: allocations.length === 1 ? allocations[0].projectId : "", matchStatus: "confirmed", confirmedBy: user.displayName, confirmedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      writeList(INVOICES_FILE, invoices); audit(user, "确认发票项目分配", "invoice", id, allocations.map(row => `${projects.find(project => project.id === row.projectId)?.name || row.projectId}:${row.amount}`).join(" · "));
      return sendJson(res, 200, invoices[index]);
    }

    if (url.pathname === "/api/supplier-statements" && req.method === "GET") {
      const projects = readProjects(), payments = readList(SUPPLIER_PAYMENTS_FILE);
      return sendJson(res, 200, readList(SUPPLIER_STATEMENTS_FILE).map(statement => ({
        ...statement,
        lines: (statement.lines || []).map(line => {
          if (line.matchStatus === "confirmed" && line.projectId) return line;
          const candidates = taxLedger.invoiceCandidates({ direction: "supplier", partyName: statement.supplierName, amount: line.amount, occurredOn: line.occurredOn, projectHint: line.itemName }, projects);
          return { ...line, candidates, matchStatus: candidates.length ? "suggested" : "unmatched" };
        }),
        currentReconciliation: taxLedger.statementReconciliation(statement, { projects, payments, basis: statement.reconciliationBasis })
      })));
    }

    if (url.pathname === "/api/supplier-statements" && req.method === "POST") {
      const input = await bodyJson(req); const statements = readList(SUPPLIER_STATEMENTS_FILE);
      const saved = taxLedger.createStatement(input, readProjects());
      statements.unshift(saved); writeList(SUPPLIER_STATEMENTS_FILE, statements);
      audit(user, "录入供应商对账单", "supplierStatement", saved.id, `${saved.supplierName} · ${saved.period} · ${saved.lines.length}行`);
      return sendJson(res, 200, { ...saved, currentReconciliation: taxLedger.statementReconciliation(saved, { projects: readProjects(), payments: readList(SUPPLIER_PAYMENTS_FILE) }) });
    }

    if (url.pathname === "/api/supplier-statements/import" && req.method === "POST") {
      const input = await bodyJson(req);
      const sourceName = path.basename(String(input.sourceName || "对账单")).slice(0, 200);
      const extension = path.extname(sourceName).toLowerCase();
      if (![".csv", ".txt", ".xlsx"].includes(extension)) return sendJson(res, 400, { error: "只支持 CSV、TXT 或 XLSX 对账单" });
      let content;
      try { content = Buffer.from(String(input.contentBase64 || ""), "base64"); }
      catch { return sendJson(res, 400, { error: "对账单文件内容无效" }); }
      if (!content.length || content.length > 3 * 1024 * 1024) return sendJson(res, 400, { error: "对账单文件必须大于0且不超过3MB" });
      const importHash = crypto.createHash("sha256").update(content).digest("hex");
      const statements = readList(SUPPLIER_STATEMENTS_FILE);
      const duplicate = statements.find(item => item.importHash === importHash);
      if (duplicate) return sendJson(res, 409, { error: "该对账单文件已经导入，已阻止重复写入", duplicateId: duplicate.id });
      const rows = extension === ".xlsx"
        ? taxLedger.parseStatementRows(spreadsheetReader.firstWorksheet(content))
        : taxLedger.parseStatementText(content.toString("utf8"));
      const saved = taxLedger.createStatement({ supplierName: input.supplierName, period: input.period, sourceName, lines: rows }, readProjects());
      Object.assign(saved, { importHash, importFormat: extension.slice(1), importedBy: user.displayName });
      statements.unshift(saved); writeList(SUPPLIER_STATEMENTS_FILE, statements);
      audit(user, "导入供应商对账单", "supplierStatement", saved.id, `${saved.supplierName} · ${saved.period} · ${sourceName} · ${saved.lines.length}行`);
      return sendJson(res, 200, { ...saved, currentReconciliation: taxLedger.statementReconciliation(saved, { projects: readProjects(), payments: readList(SUPPLIER_PAYMENTS_FILE) }) });
    }

    if (url.pathname.startsWith("/api/supplier-statements/") && req.method === "PUT") {
      const id = decodeURIComponent(url.pathname.replace("/api/supplier-statements/", ""));
      const input = await bodyJson(req); const statements = readList(SUPPLIER_STATEMENTS_FILE); const index = statements.findIndex(item => item.id === id);
      if (index < 0) return sendJson(res, 404, { error: "供应商对账单不存在" });
      if (statements[index].status === "confirmed") return sendJson(res, 409, { error: "该对账单已经完成并保留核对快照，不能再修改" });
      if (input.action === "confirm-line") {
        const line = (statements[index].lines || []).find(item => item.id === input.lineId);
        const project = readProjects().find(item => item.id === input.projectId);
        if (!line || !project) return sendJson(res, 400, { error: "对账明细或项目不存在" });
        Object.assign(line, { projectId: project.id, matchStatus: "confirmed", confirmedBy: user.displayName, confirmedAt: new Date().toISOString() });
      } else if (input.action === "complete") {
        if ((statements[index].lines || []).some(item => item.matchStatus !== "confirmed")) return sendJson(res, 409, { error: "仍有明细未确认项目，不能完成对账" });
        const reconciliation = taxLedger.statementReconciliation(statements[index], { projects: readProjects(), payments: readList(SUPPLIER_PAYMENTS_FILE), basis: input.basis });
        const differenceReason = String(input.differenceReason || "").trim().slice(0, 500);
        if (Math.abs(reconciliation.difference) > 0.009 && (input.acceptDifference !== true || differenceReason.length < 2)) return sendJson(res, 409, { error: `对账差额 ${reconciliation.difference.toFixed(2)} 尚未说明并确认`, reconciliation });
        Object.assign(statements[index], { status: "confirmed", reconciliationBasis: reconciliation.basis, reconciliation, differenceReason, differenceAccepted: Math.abs(reconciliation.difference) > 0.009, confirmedAt: new Date().toISOString(), confirmedBy: user.displayName });
      } else return sendJson(res, 400, { error: "不支持的对账操作" });
      statements[index].updatedAt = new Date().toISOString(); writeList(SUPPLIER_STATEMENTS_FILE, statements);
      audit(user, input.action === "complete" ? "完成供应商对账" : "确认对账明细项目", "supplierStatement", id, input.action === "complete" ? `${statements[index].supplierName} · 差额${statements[index].reconciliation.difference} · ${statements[index].differenceReason || "无差额"}` : statements[index].supplierName);
      return sendJson(res, 200, { ...statements[index], currentReconciliation: taxLedger.statementReconciliation(statements[index], { projects: readProjects(), payments: readList(SUPPLIER_PAYMENTS_FILE), basis: statements[index].reconciliationBasis }) });
    }

    if (url.pathname === "/api/tax-reconciliation" && req.method === "GET") {
      const period = url.searchParams.get("period") || new Date().toISOString().slice(0, 7);
      const mode = url.searchParams.get("mode") || "mid_month";
      return sendJson(res, 200, taxLedger.reconciliationView({ period, mode, projects: readProjects(), invoices: readList(INVOICES_FILE), statements: readList(SUPPLIER_STATEMENTS_FILE), snapshots: readList(TAX_RECONCILIATIONS_FILE), payments: readList(SUPPLIER_PAYMENTS_FILE), receipts: readList(CUSTOMER_RECEIPTS_FILE) }));
    }

    if (url.pathname === "/api/tax-reconciliation" && req.method === "POST") {
      const input = await bodyJson(req);
      const view = taxLedger.reconciliationView({ period: input.period, mode: "month_end", projects: readProjects(), invoices: readList(INVOICES_FILE), statements: readList(SUPPLIER_STATEMENTS_FILE), snapshots: readList(TAX_RECONCILIATIONS_FILE), payments: readList(SUPPLIER_PAYMENTS_FILE), receipts: readList(CUSTOMER_RECEIPTS_FILE) });
      if (!view.ready) return sendJson(res, 409, { error: "仍有月末阻断项，不能完成对账", blockers: view.blockers });
      const snapshots = readList(TAX_RECONCILIATIONS_FILE); const previous = snapshots.filter(item => item.period === input.period).sort((a, b) => b.version - a.version)[0];
      const snapshot = { id: crypto.randomUUID(), period: input.period, mode: "month_end", version: Number(previous?.version || 0) + 1, action: "completed", summary: view.summary, warnings: view.warnings, evidenceHash: view.evidenceHash, evidenceManifest: view.evidenceManifest, completedBy: user.displayName, completedAt: new Date().toISOString() };
      snapshots.unshift(snapshot); writeList(TAX_RECONCILIATIONS_FILE, snapshots); audit(user, "完成月末税务对账", "taxReconciliation", snapshot.id, `${snapshot.period} v${snapshot.version}`);
      return sendJson(res, 200, snapshot);
    }

    if (url.pathname === "/api/bank-transactions" && req.method === "GET") {
      if (user.role !== "main") return sendJson(res, 403, { error: "仅主账号可查看银行流水" });
      return sendJson(res, 200, readList(BANK_TRANSACTIONS_FILE));
    }

    if (url.pathname === "/api/legacy-migration" && req.method === "GET") {
      if (user.role !== "main") return sendJson(res, 403, { error: "仅主账号可使用历史补录向导" });
      return sendJson(res, 200, legacyMigration.migrationPlan({ projects: readProjects(), invoices: readList(INVOICES_FILE), payments: readList(SUPPLIER_PAYMENTS_FILE), receipts: readList(CUSTOMER_RECEIPTS_FILE) }));
    }

    if (url.pathname === "/api/legacy-migration" && req.method === "POST") {
      if (user.role !== "main") return sendJson(res, 403, { error: "仅主账号可执行历史迁移" });
      const input = await bodyJson(req);
      if (input.confirmText !== "确认迁移3.0历史收付款流水") return sendJson(res, 400, { error: "确认文字不正确，未执行迁移" });
      const projects = readProjects(), payments = readList(SUPPLIER_PAYMENTS_FILE), receipts = readList(CUSTOMER_RECEIPTS_FILE);
      const plan = legacyMigration.migrationPlan({ projects, invoices: readList(INVOICES_FILE), payments, receipts });
      if (!input.planToken) return sendJson(res, 428, { error: "请先重新预览历史迁移计划，再执行迁移", planToken: plan.planToken });
      if (input.planToken !== plan.planToken) return sendJson(res, 409, { error: "3.0数据或迁移账本在预览后已变化，请重新预览并确认", plan });
      const created = legacyMigration.buildLegacyLedgers(plan, user);
      const snapshot = safetyBackup("legacy-ledger-migration");
      try {
        if (created.payments.length) writeList(SUPPLIER_PAYMENTS_FILE, [...created.payments, ...payments]);
        if (created.receipts.length) writeList(CUSTOMER_RECEIPTS_FILE, [...created.receipts, ...receipts]);
        const verification = legacyMigration.migrationPlan({ projects, invoices: readList(INVOICES_FILE), payments: [...created.payments, ...payments], receipts: [...created.receipts, ...receipts] });
        if (verification.paymentCandidates.length || verification.receiptCandidates.length) throw new Error("历史迁移写入后复核失败，已回滚，请检查数据文件");
      } catch (error) {
        writeList(SUPPLIER_PAYMENTS_FILE, payments); writeList(CUSTOMER_RECEIPTS_FILE, receipts); throw error;
      }
      audit(user, "迁移3.0历史收付款流水", "legacyMigration", crypto.randomUUID(), `供应商付款${created.payments.length}笔 · 客户回款${created.receipts.length}笔 · 发票待补${plan.invoiceTasks.length}项 · 快照${path.basename(snapshot)}`);
      return sendJson(res, 200, { migratedPayments: created.payments.length, migratedReceipts: created.receipts.length, invoiceTasks: plan.invoiceTasks, blocked: plan.blocked, snapshot: path.basename(snapshot), verified: true, planToken: plan.planToken });
    }

    if (url.pathname === "/api/customer-receipts" && req.method === "GET") {
      const allowed = new Set(readProjects().filter(project => owns(project, user)).map(project => project.id));
      return sendJson(res, 200, readList(CUSTOMER_RECEIPTS_FILE).filter(receipt => allowed.has(receipt.projectId)));
    }

    if (url.pathname === "/api/customer-receipts" && req.method === "POST") {
      const input = await bodyJson(req); const projects = readProjects(); const projectIndex = projects.findIndex(project => project.id === input.projectId);
      if (projectIndex < 0 || !owns(projects[projectIndex], user)) return sendJson(res, 403, { error: "不能登记这个项目的回款" });
      const receipts = readList(CUSTOMER_RECEIPTS_FILE); let saved;
      try { saved = receiptLedger.createCustomerReceipt(input, { projects, invoices: readList(INVOICES_FILE), receipts, user }); }
      catch (error) { return sendJson(res, 400, { error: error.message }); }
      const previous = JSON.parse(JSON.stringify(projects[projectIndex])); const next = [saved, ...receipts]; const settlement = receiptLedger.projectSettlement(projects[projectIndex], next);
      Object.assign(projects[projectIndex], { receivedAmount: settlement.receivedAmount, paid: settlement.outstanding === 0, paymentDate: settlement.outstanding === 0 ? saved.receiptDate : "", lastReceiptDate: saved.receiptDate, updatedAt: new Date().toISOString() });
      try { writeList(CUSTOMER_RECEIPTS_FILE, next); writeProjects(projects); }
      catch (error) { writeList(CUSTOMER_RECEIPTS_FILE, receipts); projects[projectIndex] = previous; writeProjects(projects); throw error; }
      audit(user, "登记客户回款", "customerReceipt", saved.id, `${saved.customerName} · ${saved.amount}`); return sendJson(res, 200, { ...saved, settlement });
    }

    if (url.pathname.startsWith("/api/customer-receipts/") && req.method === "PUT") {
      const id = decodeURIComponent(url.pathname.replace("/api/customer-receipts/", "")); const input = await bodyJson(req);
      if (input.action !== "void") return sendJson(res, 400, { error: "不支持的回款操作" });
      const receipts = readList(CUSTOMER_RECEIPTS_FILE); const index = receipts.findIndex(row => row.id === id); if (index < 0) return sendJson(res, 404, { error: "回款流水不存在" });
      const projects = readProjects(); const projectIndex = projects.findIndex(project => project.id === receipts[index].projectId);
      if (projectIndex < 0 || !owns(projects[projectIndex], user)) return sendJson(res, 403, { error: "不能冲销这个项目的回款" });
      const originalReceipts = [...receipts], previous = JSON.parse(JSON.stringify(projects[projectIndex]));
      const transactions = receipts[index].bankTransactionId ? readList(BANK_TRANSACTIONS_FILE) : [];
      const originalTransactions = transactions.length ? JSON.parse(JSON.stringify(transactions)) : [];
      const transactionIndex = receipts[index].bankTransactionId ? transactions.findIndex(row => row.id === receipts[index].bankTransactionId) : -1;
      if (receipts[index].bankTransactionId && transactionIndex < 0) return sendJson(res, 409, { error: "关联银行流水已不存在，不能自动保持核销一致性" });
      if (transactionIndex >= 0) {
        try { transactions[transactionIndex] = bankLedger.reopenTransaction(transactions[transactionIndex], { ledgerType: "receipt", ledgerId: id, reason: input.reason, user }); }
        catch (error) { return sendJson(res, 409, { error: error.message }); }
      }
      try { receipts[index] = receiptLedger.voidCustomerReceipt(receipts[index], input, user); }
      catch (error) { return sendJson(res, 400, { error: error.message }); }
      const settlement = receiptLedger.projectSettlement(projects[projectIndex], receipts);
      const latest = receipts.filter(row => row.status !== "voided" && row.projectId === projects[projectIndex].id).sort((a, b) => String(b.receiptDate).localeCompare(String(a.receiptDate)))[0];
      Object.assign(projects[projectIndex], { receivedAmount: settlement.receivedAmount, paid: settlement.outstanding === 0, paymentDate: settlement.outstanding === 0 ? (latest?.receiptDate || "") : "", lastReceiptDate: latest?.receiptDate || "", updatedAt: new Date().toISOString() });
      try { writeList(CUSTOMER_RECEIPTS_FILE, receipts); writeProjects(projects); if (transactionIndex >= 0) writeList(BANK_TRANSACTIONS_FILE, transactions); }
      catch (error) { writeList(CUSTOMER_RECEIPTS_FILE, originalReceipts); projects[projectIndex] = previous; writeProjects(projects); if (transactionIndex >= 0) writeList(BANK_TRANSACTIONS_FILE, originalTransactions); throw error; }
      audit(user, "冲销客户回款", "customerReceipt", id, `${receipts[index].amount} · ${receipts[index].voidReason}`); return sendJson(res, 200, { ...receipts[index], settlement });
    }

    if (url.pathname === "/api/bank-transactions/import" && req.method === "POST") {
      if (user.role !== "main") return sendJson(res, 403, { error: "仅主账号可导入银行流水" });
      const input = await bodyJson(req);
      const sourceName = path.basename(String(input.sourceName || "银行流水")).slice(0, 200);
      const extension = path.extname(sourceName).toLowerCase();
      if (![".csv", ".txt", ".xlsx"].includes(extension)) return sendJson(res, 400, { error: "只支持 CSV、TXT 或 XLSX 银行流水" });
      const content = Buffer.from(String(input.contentBase64 || ""), "base64");
      if (!content.length || content.length > 3 * 1024 * 1024) return sendJson(res, 400, { error: "银行流水文件必须大于0且不超过3MB" });
      const table = extension === ".xlsx" ? spreadsheetReader.firstWorksheet(content) : taxLedger.parseDelimited(content.toString("utf8"));
      let rows;
      try { rows = bankLedger.parseBankRows(table); }
      catch (error) { return sendJson(res, 422, { error: error.message }); }
      const existing = readList(BANK_TRANSACTIONS_FILE);
      const result = bankLedger.importTransactions(rows, { projects: readProjects(), payments: readList(SUPPLIER_PAYMENTS_FILE), receipts: readList(CUSTOMER_RECEIPTS_FILE), existing, sourceName });
      if (result.imported.length) writeList(BANK_TRANSACTIONS_FILE, [...result.imported.reverse(), ...existing]);
      audit(user, "导入银行流水", "bankTransaction", crypto.randomUUID(), `${sourceName} · 新增${result.imported.length}笔 · 重复${result.duplicates.length}笔`);
      return sendJson(res, 200, { imported: result.imported.length, duplicateCount: result.duplicates.length, duplicates: result.duplicates });
    }

    if (url.pathname.startsWith("/api/bank-transactions/") && req.method === "PUT") {
      if (user.role !== "main") return sendJson(res, 403, { error: "仅主账号可确认银行流水" });
      const id = decodeURIComponent(url.pathname.replace("/api/bank-transactions/", ""));
      const input = await bodyJson(req);
      const transactions = readList(BANK_TRANSACTIONS_FILE);
      const transactionIndex = transactions.findIndex(item => item.id === id);
      if (transactionIndex < 0) return sendJson(res, 404, { error: "银行流水不存在" });
      const transaction = transactions[transactionIndex];
      const originalTransactions = JSON.parse(JSON.stringify(transactions));
      if (transaction.status === "matched") return sendJson(res, 409, { error: "该银行流水已经核销" });
      const projects = readProjects();
      const projectIndex = projects.findIndex(project => project.id === input.projectId);
      if (projectIndex < 0) return sendJson(res, 400, { error: "请选择有效项目" });
      const originalProject = JSON.parse(JSON.stringify(projects[projectIndex]));
      if (transaction.direction === "in") {
        const receipts = readList(CUSTOMER_RECEIPTS_FILE);
        let receipt;
        try { receipt = receiptLedger.createCustomerReceipt({ projectId: input.projectId, invoiceId: input.invoiceId, amount: transaction.amount, receiptDate: transaction.transactionDate, bankReference: transaction.bankReference, note: transaction.summary }, { projects, invoices: readList(INVOICES_FILE), receipts, user }); }
        catch (error) { return sendJson(res, 400, { error: error.message }); }
        receipt.bankTransactionId = transaction.id;
        const nextReceipts = [receipt, ...receipts];
        const settlement = receiptLedger.projectSettlement(projects[projectIndex], nextReceipts);
        Object.assign(projects[projectIndex], { receivedAmount: settlement.receivedAmount, paid: settlement.outstanding === 0, paymentDate: settlement.outstanding === 0 ? receipt.receiptDate : "", lastReceiptDate: receipt.receiptDate, updatedAt: new Date().toISOString() });
        transactions[transactionIndex] = { ...transaction, status: "matched", receiptId: receipt.id, projectId: receipt.projectId, matchedBy: user.displayName, matchedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        try { writeList(CUSTOMER_RECEIPTS_FILE, nextReceipts); writeProjects(projects); writeList(BANK_TRANSACTIONS_FILE, transactions); }
        catch (error) { writeList(CUSTOMER_RECEIPTS_FILE, receipts); projects[projectIndex] = originalProject; writeProjects(projects); writeList(BANK_TRANSACTIONS_FILE, originalTransactions); throw error; }
        audit(user, "确认银行流水并核销客户回款", "bankTransaction", id, `${receipt.customerName} · ${receipt.amount}`);
        return sendJson(res, 200, { transaction: transactions[transactionIndex], receipt, settlement });
      }
      (projects[projectIndex].supplierItems || []).forEach((item, index) => { if (!item.id) item.id = `legacy-${projects[projectIndex].id}-${index}`; });
      const payments = readList(SUPPLIER_PAYMENTS_FILE);
      let payment;
      try { payment = paymentLedger.createSupplierPayment({ projectId: input.projectId, supplierItemId: input.supplierItemId, amount: transaction.amount, paymentDate: transaction.transactionDate, bankReference: transaction.bankReference, note: transaction.summary }, { projects, invoices: readList(INVOICES_FILE), payments, user }); }
      catch (error) { return sendJson(res, 400, { error: error.message }); }
      payment.bankTransactionId = transaction.id;
      const nextPayments = [payment, ...payments];
      const supplierItem = projects[projectIndex].supplierItems.find(item => item.id === payment.supplierItemId);
      const settlement = paymentLedger.itemSettlement(projects[projectIndex], supplierItem, nextPayments);
      Object.assign(supplierItem, { paidAmount: settlement.paidAmount, paid: settlement.outstanding === 0, paymentDate: settlement.outstanding === 0 ? payment.paymentDate : "", lastPaymentDate: payment.paymentDate });
      transactions[transactionIndex] = { ...transaction, status: "matched", paymentId: payment.id, projectId: payment.projectId, supplierItemId: payment.supplierItemId, matchedBy: user.displayName, matchedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      try {
        writeList(SUPPLIER_PAYMENTS_FILE, nextPayments); writeProjects(projects); writeList(BANK_TRANSACTIONS_FILE, transactions);
      } catch (error) {
        writeList(SUPPLIER_PAYMENTS_FILE, payments); projects[projectIndex] = originalProject; writeProjects(projects); writeList(BANK_TRANSACTIONS_FILE, originalTransactions); throw error;
      }
      audit(user, "确认银行流水并核销供应商付款", "bankTransaction", id, `${payment.supplierName} · ${payment.amount}`);
      return sendJson(res, 200, { transaction: transactions[transactionIndex], payment, settlement });
    }

    if (url.pathname === "/api/supplier-payments" && req.method === "GET") {
      const allowedProjectIds = new Set(readProjects().filter(project => owns(project, user)).map(project => project.id));
      return sendJson(res, 200, readList(SUPPLIER_PAYMENTS_FILE).filter(payment => allowedProjectIds.has(payment.projectId)));
    }

    if (url.pathname === "/api/supplier-payments" && req.method === "POST") {
      const input = await bodyJson(req);
      const projects = readProjects();
      const projectIndex = projects.findIndex(project => project.id === input.projectId);
      if (projectIndex < 0) return sendJson(res, 404, { error: "付款项目不存在" });
      if (!owns(projects[projectIndex], user)) return sendJson(res, 403, { error: "不能登记其他账号项目的付款" });
      const previousProject = JSON.parse(JSON.stringify(projects[projectIndex]));
      if ((!Array.isArray(projects[projectIndex].supplierItems) || !projects[projectIndex].supplierItems.length) && (projects[projectIndex].supplier || Number(projects[projectIndex].payable || 0))) {
        projects[projectIndex].supplierItems = [{
          id: String(input.supplierItemId || crypto.randomUUID()), category: "purchase", itemName: projects[projectIndex].content || "项目采购",
          process: "", quantity: 1, unit: "", supplier: projects[projectIndex].supplier || "",
          purchaseTotal: Number(projects[projectIndex].payable || 0), payable: Number(projects[projectIndex].payable || 0), shippingFee: 0,
          paid: Boolean(projects[projectIndex].supplierPaid), paymentDate: projects[projectIndex].supplierPaymentDate || ""
        }];
      }
      (projects[projectIndex].supplierItems || []).forEach((item, index) => { if (!item.id) item.id = `legacy-${projects[projectIndex].id}-${index}`; });
      const payments = readList(SUPPLIER_PAYMENTS_FILE);
      let saved;
      try { saved = paymentLedger.createSupplierPayment(input, { projects, invoices: readList(INVOICES_FILE), payments, user }); }
      catch (error) { return sendJson(res, 400, { error: error.message }); }
      const nextPayments = [saved, ...payments];
      const supplierItem = (projects[projectIndex].supplierItems || []).find(item => item.id === saved.supplierItemId);
      const settlement = paymentLedger.itemSettlement(projects[projectIndex], supplierItem, nextPayments);
      Object.assign(supplierItem, { paidAmount: settlement.paidAmount, paid: settlement.outstanding === 0, paymentDate: settlement.outstanding === 0 ? saved.paymentDate : "", lastPaymentDate: saved.paymentDate });
      projects[projectIndex].updatedAt = new Date().toISOString();
      try {
        writeList(SUPPLIER_PAYMENTS_FILE, nextPayments);
        writeProjects(projects);
      } catch (error) {
        writeList(SUPPLIER_PAYMENTS_FILE, payments);
        projects[projectIndex] = previousProject;
        writeProjects(projects);
        throw error;
      }
      audit(user, "登记供应商付款", "supplierPayment", saved.id, `${saved.supplierName || "未填供应商"} · ${saved.amount} · ${projects[projectIndex].name}`);
      return sendJson(res, 200, { ...saved, settlement });
    }

    if (url.pathname.startsWith("/api/supplier-payments/") && req.method === "PUT") {
      const id = decodeURIComponent(url.pathname.replace("/api/supplier-payments/", ""));
      const input = await bodyJson(req);
      if (input.action !== "void") return sendJson(res, 400, { error: "不支持的付款操作" });
      const payments = readList(SUPPLIER_PAYMENTS_FILE);
      const index = payments.findIndex(payment => payment.id === id);
      if (index < 0) return sendJson(res, 404, { error: "付款流水不存在" });
      const projects = readProjects();
      const projectIndex = projects.findIndex(project => project.id === payments[index].projectId);
      if (projectIndex < 0 || !owns(projects[projectIndex], user)) return sendJson(res, 403, { error: "不能冲销其他账号项目的付款" });
      const previousProject = JSON.parse(JSON.stringify(projects[projectIndex]));
      const originalPayments = [...payments];
      const transactions = payments[index].bankTransactionId ? readList(BANK_TRANSACTIONS_FILE) : [];
      const originalTransactions = transactions.length ? JSON.parse(JSON.stringify(transactions)) : [];
      const transactionIndex = payments[index].bankTransactionId ? transactions.findIndex(row => row.id === payments[index].bankTransactionId) : -1;
      if (payments[index].bankTransactionId && transactionIndex < 0) return sendJson(res, 409, { error: "关联银行流水已不存在，不能自动保持核销一致性" });
      if (transactionIndex >= 0) {
        try { transactions[transactionIndex] = bankLedger.reopenTransaction(transactions[transactionIndex], { ledgerType: "payment", ledgerId: id, reason: input.reason, user }); }
        catch (error) { return sendJson(res, 409, { error: error.message }); }
      }
      try { payments[index] = paymentLedger.voidSupplierPayment(payments[index], input, user); }
      catch (error) { return sendJson(res, 400, { error: error.message }); }
      const supplierItem = (projects[projectIndex].supplierItems || []).find(item => item.id === payments[index].supplierItemId);
      if (!supplierItem) return sendJson(res, 409, { error: "项目中的供应商明细已不存在，不能自动冲销" });
      const settlement = paymentLedger.itemSettlement(projects[projectIndex], supplierItem, payments);
      const latest = payments.filter(payment => payment.status !== "voided" && payment.projectId === projects[projectIndex].id && payment.supplierItemId === supplierItem.id).sort((a, b) => String(b.paymentDate).localeCompare(String(a.paymentDate)))[0];
      Object.assign(supplierItem, { paidAmount: settlement.paidAmount, paid: settlement.outstanding === 0, paymentDate: settlement.outstanding === 0 ? (latest?.paymentDate || "") : "", lastPaymentDate: latest?.paymentDate || "" });
      projects[projectIndex].updatedAt = new Date().toISOString();
      try {
        writeList(SUPPLIER_PAYMENTS_FILE, payments);
        writeProjects(projects);
        if (transactionIndex >= 0) writeList(BANK_TRANSACTIONS_FILE, transactions);
      } catch (error) {
        writeList(SUPPLIER_PAYMENTS_FILE, originalPayments);
        projects[projectIndex] = previousProject;
        writeProjects(projects);
        if (transactionIndex >= 0) writeList(BANK_TRANSACTIONS_FILE, originalTransactions);
        throw error;
      }
      audit(user, "冲销供应商付款", "supplierPayment", id, `${payments[index].amount} · ${payments[index].voidReason}`);
      return sendJson(res, 200, { ...payments[index], settlement });
    }

    if (url.pathname === "/api/settlement-batches" && req.method === "GET") {
      return sendJson(res, 200, readList(SETTLEMENT_BATCHES_FILE));
    }

    if (url.pathname === "/api/settlement-batches" && req.method === "POST") {
      const input = await bodyJson(req);
      const projectIds = [...new Set(Array.isArray(input.projectIds) ? input.projectIds.map(String) : [])];
      if (!projectIds.length) return sendJson(res, 400, { error: "请至少选择一个项目" });
      const projects = readProjects();
      const selected = projectIds.map(id => projects.find(project => project.id === id)).filter(Boolean);
      if (selected.length !== projectIds.length) return sendJson(res, 400, { error: "部分项目不存在，请刷新后重新选择" });
      const customer = String(input.customer || selected[0].customer || "").trim();
      const customerGroup = String(input.customerGroup || selected[0].customerGroup || "").trim();
      if (!customer || selected.some(project => String(project.customer || "").trim() !== customer)) return sendJson(res, 400, { error: "只能合并同一客户公司的项目" });
      if (selected.some(project => String(project.customerGroup || "").trim() !== customerGroup)) return sendJson(res, 400, { error: "只能合并同一部门的项目" });
      const existing = readList(SETTLEMENT_BATCHES_FILE);
      const occupied = new Set(existing.filter(batch => batch.status !== "cancelled").flatMap(batch => batch.projectIds || []));
      if (projectIds.some(id => occupied.has(id))) return sendJson(res, 409, { error: "所选项目中已有项目进入其他结算批次" });
      const now = new Date().toISOString();
      const month = /^\d{4}-\d{2}$/.test(input.month || "") ? input.month : now.slice(0, 7);
      const amount = selected.reduce((sum, project) => sum + Number(project.receivable || 0), 0);
      const saved = { id: crypto.randomUUID(), name: String(input.name || `${customer}-${customerGroup || "统一"}-${month}`).trim(), customer, customerGroup, month, projectIds, amount, status: "pending", invoiceDate: "", paymentDate: "", createdAt: now, updatedAt: now, createdBy: user.displayName };
      existing.unshift(saved); writeList(SETTLEMENT_BATCHES_FILE, existing);
      audit(user, "创建部门合并结算", "settlementBatch", saved.id, `${saved.name} · ${projectIds.length}个项目 · ${amount}`);
      return sendJson(res, 200, saved);
    }

    if (url.pathname.startsWith("/api/settlement-batches/") && req.method === "PUT") {
      const id = decodeURIComponent(url.pathname.replace("/api/settlement-batches/", ""));
      const input = await bodyJson(req); const batches = readList(SETTLEMENT_BATCHES_FILE); const index = batches.findIndex(batch => batch.id === id);
      if (index < 0) return sendJson(res, 404, { error: "结算批次不存在" });
      const action = String(input.action || ""); const today = new Date().toISOString().slice(0, 10); const projects = readProjects();
      if (action === "invoice") {
        const invoiceDate = /^\d{4}-\d{2}-\d{2}$/.test(input.invoiceDate || "") ? input.invoiceDate : today;
        batches[index] = { ...batches[index], status: "invoiced", invoiceDate, updatedAt: new Date().toISOString() };
        (batches[index].projectIds || []).forEach(projectId => { const project = projects.find(item => item.id === projectId); if (project) Object.assign(project, { invoiced: true, invoiceDate, updatedAt: new Date().toISOString() }); });
      } else if (action === "paid") {
        const paymentDate = /^\d{4}-\d{2}-\d{2}$/.test(input.paymentDate || "") ? input.paymentDate : today;
        batches[index] = { ...batches[index], status: "paid", paymentDate, updatedAt: new Date().toISOString() };
        (batches[index].projectIds || []).forEach(projectId => { const project = projects.find(item => item.id === projectId); if (project) Object.assign(project, { invoiced: true, paid: true, invoiceDate: project.invoiceDate || batches[index].invoiceDate || today, paymentDate, updatedAt: new Date().toISOString() }); });
      } else return sendJson(res, 400, { error: "不支持的结算操作" });
      writeProjects(projects); writeList(SETTLEMENT_BATCHES_FILE, batches);
      audit(user, action === "invoice" ? "合并批次统一开票" : "合并批次统一回款", "settlementBatch", id, batches[index].name);
      return sendJson(res, 200, batches[index]);
    }

    if (url.pathname === "/api/projects" && req.method === "GET") {
      return sendJson(res, 200, readProjects().filter(item => owns(item, user)));
    }

    if (url.pathname === "/api/file-projects" && req.method === "GET") {
      return sendJson(res, 200, readProjects().filter(project => canUseProjectFiles(project, user)).map(project => ({
        id: project.id,
        name: project.name,
        customer: project.customer,
        customerGroup: project.customerGroup || "",
        customerContact: project.customerContact || "",
        content: project.content || "",
        contractDate: project.contractDate,
        deliveryDate: project.deliveryDate || "",
        remark: project.remark || "",
        ownerName: project.ownerName || project.owner || "",
        supplierItems: (project.supplierItems || []).map(item => ({
          itemName: item.itemName || "",
          process: item.process || "",
          quantity: Number(item.quantity || 0),
          unit: item.unit || ""
        }))
      })));
    }

    if (url.pathname === "/api/todos" && req.method === "GET") {
      return sendJson(res, 200, readList(TODOS_FILE).filter(item => owns(item, user)));
    }

    if (url.pathname === "/api/todos" && req.method === "POST") {
      const todo = await bodyJson(req);
      const title = String(todo.title || "").trim();
      if (!title) return sendJson(res, 400, { error: "待办内容不能为空" });
      const items = readList(TODOS_FILE);
      const now = new Date().toISOString();
      const saved = {
        ...todo,
        ownerUserId: user.role === "main" ? (todo.ownerUserId || user.id) : user.id,
        ownerName: user.role === "main" ? (todo.ownerName || user.displayName) : user.displayName,
        createdByUserId: user.id,
        id: todo.id || crypto.randomUUID(),
        title,
        planDate: /^\d{4}-\d{2}-\d{2}$/.test(todo.planDate || "") ? todo.planDate : now.slice(0, 10),
        priority: ["normal", "high", "urgent"].includes(todo.priority) ? todo.priority : "normal",
        done: Boolean(todo.done),
        completedAt: todo.done ? (todo.completedAt || now) : "",
        createdAt: todo.createdAt || now,
        updatedAt: now
      };
      items.unshift(saved);
      writeList(TODOS_FILE, items);
      audit(user, "新增待办", "todo", saved.id, saved.title);
      return sendJson(res, 200, saved);
    }

    if (url.pathname.startsWith("/api/todos/") && req.method === "PUT") {
      const id = decodeURIComponent(url.pathname.replace("/api/todos/", ""));
      const patch = await bodyJson(req);
      const items = readList(TODOS_FILE);
      const index = items.findIndex(item => item.id === id);
      if (index < 0) return sendJson(res, 404, { error: "待办不存在" });
      if (!owns(items[index], user)) return sendJson(res, 403, { error: "不能修改其他账号的待办" });
      const done = patch.done === undefined ? Boolean(items[index].done) : Boolean(patch.done);
      items[index] = { ...items[index], ...patch, id, done, completedAt: done ? (items[index].completedAt || new Date().toISOString()) : "", updatedAt: new Date().toISOString() };
      writeList(TODOS_FILE, items);
      audit(user, done ? "完成待办" : "修改待办", "todo", id, items[index].title);
      return sendJson(res, 200, items[index]);
    }

    if (url.pathname.startsWith("/api/todos/") && req.method === "DELETE") {
      const id = decodeURIComponent(url.pathname.replace("/api/todos/", ""));
      const existing = readList(TODOS_FILE); const target = existing.find(item => item.id === id);
      if (target && !owns(target, user)) return sendJson(res, 403, { error: "不能删除其他账号的待办" });
      writeList(TODOS_FILE, existing.filter(item => item.id !== id));
      audit(user, "删除待办", "todo", id, target?.title || "");
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === "/api/suppliers" && req.method === "GET") {
      return sendJson(res, 200, readList(SUPPLIERS_FILE));
    }

    if (url.pathname === "/api/processes" && req.method === "GET") {
      return sendJson(res, 200, readList(PROCESSES_FILE));
    }

    if (url.pathname === "/api/customers" && req.method === "GET") {
      return sendJson(res, 200, readList(CUSTOMERS_FILE));
    }

    if (url.pathname === "/api/customers" && req.method === "POST") {
      const customer = await bodyJson(req);
      if (!String(customer.company || "").trim()) return sendJson(res, 400, { error: "客户公司不能为空" });
      const items = readList(CUSTOMERS_FILE);
      const now = new Date().toISOString();
      const saved = { ...customer, id: customer.id || crypto.randomUUID(), createdAt: now, updatedAt: now };
      items.unshift(saved);
      writeList(CUSTOMERS_FILE, items);
      return sendJson(res, 200, saved);
    }

    if (url.pathname.startsWith("/api/customers/") && req.method === "DELETE") {
      const id = decodeURIComponent(url.pathname.replace("/api/customers/", ""));
      writeList(CUSTOMERS_FILE, readList(CUSTOMERS_FILE).filter(item => item.id !== id));
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname.startsWith("/api/customers/") && req.method === "PUT") {
      const id = decodeURIComponent(url.pathname.replace("/api/customers/", ""));
      const customer = await bodyJson(req);
      const items = readList(CUSTOMERS_FILE);
      const index = items.findIndex(item => item.id === id);
      if (index < 0) return sendJson(res, 404, { error: "客户资料不存在" });
      items[index] = { ...items[index], ...customer, id, updatedAt: new Date().toISOString() };
      writeList(CUSTOMERS_FILE, items);
      return sendJson(res, 200, items[index]);
    }

    if (url.pathname === "/api/processes" && req.method === "POST") {
      const processItem = await bodyJson(req);
      if (!String(processItem.name || "").trim()) return sendJson(res, 400, { error: "工艺名称不能为空" });
      const items = readList(PROCESSES_FILE);
      const now = new Date().toISOString();
      const saved = { ...processItem, id: processItem.id || crypto.randomUUID(), createdAt: now, updatedAt: now };
      items.unshift(saved);
      writeList(PROCESSES_FILE, items);
      return sendJson(res, 200, saved);
    }

    if (url.pathname.startsWith("/api/processes/") && req.method === "DELETE") {
      const id = decodeURIComponent(url.pathname.replace("/api/processes/", ""));
      writeList(PROCESSES_FILE, readList(PROCESSES_FILE).filter(item => item.id !== id));
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === "/api/suppliers" && req.method === "POST") {
      const supplier = await bodyJson(req);
      if (!String(supplier.name || "").trim()) return sendJson(res, 400, { error: "供应商名称不能为空" });
      const suppliers = readList(SUPPLIERS_FILE);
      const now = new Date().toISOString();
      const saved = { ...supplier, id: supplier.id || crypto.randomUUID(), createdAt: supplier.createdAt || now, updatedAt: now };
      suppliers.unshift(saved);
      writeList(SUPPLIERS_FILE, suppliers);
      return sendJson(res, 200, saved);
    }

    if (url.pathname.startsWith("/api/suppliers/") && req.method === "PUT") {
      const id = decodeURIComponent(url.pathname.replace("/api/suppliers/", ""));
      const supplier = await bodyJson(req);
      const suppliers = readList(SUPPLIERS_FILE);
      const index = suppliers.findIndex(item => item.id === id);
      if (index < 0) return sendJson(res, 404, { error: "供应商不存在" });
      suppliers[index] = { ...suppliers[index], ...supplier, id, updatedAt: new Date().toISOString() };
      writeList(SUPPLIERS_FILE, suppliers);
      return sendJson(res, 200, suppliers[index]);
    }

    if (url.pathname.startsWith("/api/suppliers/") && req.method === "DELETE") {
      const id = decodeURIComponent(url.pathname.replace("/api/suppliers/", ""));
      writeList(SUPPLIERS_FILE, readList(SUPPLIERS_FILE).filter(item => item.id !== id));
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === "/api/files" && req.method === "GET") {
      const projectId = url.searchParams.get("projectId");
      const projects = readProjects().filter(project => canUseProjectFiles(project, user));
      if (projectId) {
        const project = projects.find(item => item.id === projectId);
        if (!project) return sendJson(res, 404, { error: "项目不存在" });
        const result = filesForProject(project);
        return sendJson(res, 200, { archiveFolder: result.archiveFolder, archivePath: result.root, files: result.files });
      }
      const files = projects.flatMap(project => {
        const result = filesForProject(project);
        return result.files.map(file => ({ ...file, projectId: project.id, projectName: project.name, archiveFolder: result.archiveFolder }));
      });
      return sendJson(res, 200, { archiveFolder: "", files });
    }

    if (url.pathname === "/api/files/upload" && req.method === "POST") {
      const projectId = url.searchParams.get("projectId");
      const category = url.searchParams.get("category") || "other";
      const month = /^\d{4}-\d{2}$/.test(url.searchParams.get("month") || "") ? url.searchParams.get("month") : "未分月";
      const fileName = safeSegment(url.searchParams.get("fileName"), "未命名文件");
      if (!projectId) return sendJson(res, 400, { error: "缺少项目编号" });
      const project = readProjects().find(item => item.id === projectId);
      if (!project) return sendJson(res, 404, { error: "项目不存在" });
      if (!canUseProjectFiles(project, user)) return sendJson(res, 403, { error: "没有这个项目的文件操作权限" });
      const categoryFolder = { invoice: "发票", production: "制作文件", finished: "成品图片", contract: "合同", other: "其他资料" }[category] || "其他资料";
      const folder = category === "invoice" ? path.join(categoryFolder, month) : categoryFolder;
      const root = projectFilesDir(project);
      const destination = path.join(root, folder, fileName);
      const size = await saveUpload(req, destination);
      return sendJson(res, 200, { ok: true, name: fileName, size, relativePath: archiveRelativePath(destination), archiveFolder: archiveRelativePath(root) });
    }

    if (url.pathname === "/api/files/open-folder" && req.method === "POST") {
      const projectId = url.searchParams.get("projectId");
      const project = readProjects().find(item => item.id === projectId);
      if (!project) return sendJson(res, 404, { error: "项目不存在" });
      if (!canUseProjectFiles(project, user)) return sendJson(res, 403, { error: "没有这个项目的文件操作权限" });
      const folder = projectFilesDir(project);
      fs.mkdirSync(folder, { recursive: true });
      if (process.platform === "win32" && isLocalRequest(req)) {
        const explorer = spawn("explorer.exe", [folder], { detached: true, stdio: "ignore", windowsHide: false });
        explorer.unref();
        return sendJson(res, 200, { ok: true, openedOnHost: true, archiveFolder: archiveRelativePath(folder) });
      }
      return sendJson(res, 200, {
        ok: true,
        openedOnHost: false,
        networkPath: projectNetworkPath(folder, req),
        archiveFolder: archiveRelativePath(folder)
      });
    }

    if (url.pathname === "/api/files/download" && req.method === "GET") {
      const relativePath = url.searchParams.get("path");
      const { target } = resolveArchiveFile(relativePath);
      if (!canAccessProjectFile(target, user)) return sendJson(res, 403, { error: "无权访问其他账号的项目文件" });
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return sendJson(res, 404, { error: "文件不存在" });
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": fs.statSync(target).size,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`
      });
      fs.createReadStream(target).pipe(res);
      return;
    }

    if (url.pathname === "/api/files/preview" && req.method === "GET") {
      const relativePath = url.searchParams.get("path");
      const { target } = resolveArchiveFile(relativePath);
      if (!canAccessProjectFile(target, user)) return sendJson(res, 403, { error: "无权查看其他账号的项目文件" });
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return sendJson(res, 404, { error: "文件不存在" });
      const ext = path.extname(target).toLowerCase();
      const previewTypes = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp", ".pdf": "application/pdf", ".ai": "application/pdf" };
      if (!previewTypes[ext]) return sendJson(res, 415, { error: "这个文件格式暂不支持预览" });
      res.writeHead(200, { "Content-Type": previewTypes[ext], "Content-Length": fs.statSync(target).size, "Cache-Control": "private, max-age=60", "Content-Disposition": "inline" });
      fs.createReadStream(target).pipe(res);
      return;
    }

    if (url.pathname === "/api/files" && req.method === "DELETE") {
      const relativePath = url.searchParams.get("path");
      const { target } = resolveArchiveFile(relativePath);
      if (!canAccessProjectFile(target, user)) return sendJson(res, 403, { error: "无权删除其他账号的项目文件" });
      if (fs.existsSync(target) && fs.statSync(target).isFile()) fs.rmSync(target);
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === "/api/inventory" && req.method === "GET") {
      return sendJson(res, 200, readList(INVENTORY_FILE));
    }

    if (url.pathname === "/api/expenses" && req.method === "GET") {
      return sendJson(res, 200, readList(EXPENSES_FILE));
    }

    if (url.pathname === "/api/expenses" && req.method === "POST") {
      const expense = await bodyJson(req);
      if (!String(expense.date || "").trim()) return sendJson(res, 400, { error: "费用日期不能为空" });
      if (Number(expense.amount || 0) <= 0) return sendJson(res, 400, { error: "费用金额必须大于 0" });
      const expenses = readList(EXPENSES_FILE);
      const now = new Date().toISOString();
      const saved = { ...expense, id: expense.id || crypto.randomUUID(), amount: Number(expense.amount), createdAt: expense.createdAt || now, updatedAt: now };
      expenses.unshift(saved);
      writeList(EXPENSES_FILE, expenses);
      return sendJson(res, 200, saved);
    }

    if (url.pathname.startsWith("/api/expenses/") && req.method === "DELETE") {
      const id = decodeURIComponent(url.pathname.replace("/api/expenses/", ""));
      writeList(EXPENSES_FILE, readList(EXPENSES_FILE).filter(item => item.id !== id));
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === "/api/inventory" && req.method === "POST") {
      const material = await bodyJson(req);
      if (!String(material.name || "").trim()) return sendJson(res, 400, { error: "物料名称不能为空" });
      const inventory = readList(INVENTORY_FILE);
      const now = new Date().toISOString();
      const openingQuantity = Math.max(0, Number(material.openingQuantity || 0));
      const openingUnitCost = Math.max(0, Number(material.openingUnitCost ?? material.unitCost ?? 0));
      const saved = { ...material, id: material.id || crypto.randomUUID(), openingQuantity, openingUnitCost, transactions: [], createdAt: now, updatedAt: now };
      inventory.unshift(saved);
      writeList(INVENTORY_FILE, inventory);
      return sendJson(res, 200, saved);
    }

    if (url.pathname.match(/^\/api\/inventory\/[^/]+\/transactions$/) && req.method === "POST") {
      const id = decodeURIComponent(url.pathname.split("/")[3]);
      const transaction = await bodyJson(req);
      const inventory = readList(INVENTORY_FILE);
      const index = inventory.findIndex(item => item.id === id);
      if (index < 0) return sendJson(res, 404, { error: "物料不存在" });
      const quantity = Number(transaction.quantity || 0);
      if (quantity <= 0) return sendJson(res, 400, { error: "数量必须大于 0" });
      if (inventory[index].openingUnitCost === undefined) inventory[index].openingUnitCost = Math.max(0, Number(inventory[index].unitCost || 0));
      const before = inventoryState(inventory[index]);
      if (!["ordered", "in", "out"].includes(transaction.type)) return sendJson(res, 400, { error: "流水类型无效" });
      if (transaction.type === "out") {
        if (!transaction.projectId) return sendJson(res, 400, { error: "项目实际出库必须选择对应项目" });
        const targetProject = readProjects().find(item => item.id === transaction.projectId);
        if (!targetProject || !owns(targetProject, user)) return sendJson(res, 403, { error: "无权为这个项目出库" });
      }
      if (transaction.type === "out" && quantity > before.quantity) return sendJson(res, 400, { error: `库存不足，当前仅剩 ${before.quantity}` });
      const unitCost = transaction.type === "out" ? before.averageCost : Math.max(0, Number(transaction.unitCost || inventory[index].lastPurchaseUnitCost || inventory[index].unitCost || 0));
      const saved = { ...transaction, id: crypto.randomUUID(), quantity, unitCost, costAmount: quantity * unitCost, createdAt: new Date().toISOString() };
      inventory[index].transactions = [saved, ...(inventory[index].transactions || [])];
      if (transaction.type === "in") inventory[index].lastPurchaseUnitCost = unitCost;
      const after = inventoryState(inventory[index]);
      inventory[index].averageUnitCost = after.averageCost;
      inventory[index].updatedAt = new Date().toISOString();
      writeList(INVENTORY_FILE, inventory);
      audit(user, transaction.type === "ordered" ? "登记备货采购" : transaction.type === "in" ? "采购入库" : "项目实际出库", "inventory", id, `${quantity} ${inventory[index].unit || ""}${transaction.projectId ? ` · 项目${transaction.projectId}` : ""}`);
      return sendJson(res, 200, inventory[index]);
    }

    if (url.pathname.startsWith("/api/inventory/") && req.method === "PUT") {
      const id = decodeURIComponent(url.pathname.replace("/api/inventory/", ""));
      const material = await bodyJson(req);
      const inventory = readList(INVENTORY_FILE);
      const index = inventory.findIndex(item => item.id === id);
      if (index < 0) return sendJson(res, 404, { error: "物料不存在" });
      inventory[index] = { ...inventory[index], ...material, id, openingUnitCost: inventory[index].openingUnitCost ?? inventory[index].unitCost ?? material.unitCost ?? 0, transactions: inventory[index].transactions || [], updatedAt: new Date().toISOString() };
      writeList(INVENTORY_FILE, inventory);
      return sendJson(res, 200, inventory[index]);
    }

    if (url.pathname.startsWith("/api/inventory/") && req.method === "DELETE") {
      const id = decodeURIComponent(url.pathname.replace("/api/inventory/", ""));
      writeList(INVENTORY_FILE, readList(INVENTORY_FILE).filter(item => item.id !== id));
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === "/api/projects" && req.method === "POST") {
      const project = await bodyJson(req);
      const projects = readProjects();
      const now = new Date().toISOString();
      if (user.role === "main" && !project.ownerUserId) {
        const customer = readList(CUSTOMERS_FILE).find(item => masterKey(item.company) === masterKey(project.customer));
        if (customer?.ownerUserId) { project.ownerUserId = customer.ownerUserId; project.ownerName = customer.ownerName || ""; }
      }
      const saved = { ...project, ownerUserId: user.role === "main" ? (project.ownerUserId || user.id) : user.id, ownerName: user.role === "main" ? (project.ownerName || user.displayName) : user.displayName, createdByUserId: user.id, id: project.id || crypto.randomUUID(), createdAt: project.createdAt || now, updatedAt: now };
      fs.mkdirSync(projectFilesDir(saved), { recursive: true });
      projects.unshift(saved);
      writeProjects(projects);
      syncMasterDataFromProjects(saved);
      audit(user, "新建项目", "project", saved.id, saved.name);
      return sendJson(res, 200, saved);
    }

    if (/^\/api\/projects\/[^/]+\/events$/.test(url.pathname) && req.method === "POST") {
      const id = decodeURIComponent(url.pathname.split("/")[3]); const input = await bodyJson(req); const projects = readProjects(); const index = projects.findIndex(item => item.id === id);
      if (index < 0) return sendJson(res, 404, { error: "项目不存在" });
      if (!owns(projects[index], user)) return sendJson(res, 403, { error: "不能记录其他账号的项目" });
      const event = { id: crypto.randomUUID(), type: String(input.type || "followup"), amount: Math.max(0, Number(input.amount || 0)), date: /^\d{4}-\d{2}-\d{2}$/.test(input.date || "") ? input.date : new Date().toLocaleDateString("sv-SE"), note: String(input.note || "").trim(), nextDate: String(input.nextDate || ""), userId: user.id, userName: user.displayName, createdAt: new Date().toISOString() };
      projects[index].executionEvents = [...(projects[index].executionEvents || []), event]; projects[index].updatedAt = new Date().toISOString(); writeProjects(projects);
      audit(user, "记录项目进展", "project", id, `${event.type} ${event.note}`.trim()); return sendJson(res, 200, event);
    }

    if (url.pathname.startsWith("/api/projects/") && req.method === "PUT") {
      const id = decodeURIComponent(url.pathname.replace("/api/projects/", ""));
      const project = await bodyJson(req);
      const projects = readProjects();
      const index = projects.findIndex(item => item.id === id);
      if (index < 0) return sendJson(res, 404, { error: "项目不存在" });
      if (!owns(projects[index], user)) return sendJson(res, 403, { error: "不能修改其他账号的项目" });
      if (user.role !== "main") { project.ownerUserId = user.id; project.ownerName = user.displayName; }
      const previous = projects[index];
      const previousFolder = projectFilesDir(previous);
      const updated = { ...previous, ...project, id, updatedAt: new Date().toISOString() };
      const updatedFolder = projectFilesDir(updated);
      if (path.resolve(previousFolder) !== path.resolve(updatedFolder) && fs.existsSync(previousFolder)) {
        updated.archiveAliases = [...new Set([...(previous.archiveAliases || []), archiveRelativePath(previousFolder)])];
      }
      fs.mkdirSync(updatedFolder, { recursive: true });
      projects[index] = updated;
      writeProjects(projects);
      syncMasterDataFromProjects(projects[index]);
      audit(user, "修改项目", "project", id, projects[index].name);
      return sendJson(res, 200, projects[index]);
    }

    if (url.pathname.startsWith("/api/projects/") && req.method === "DELETE") {
      const id = decodeURIComponent(url.pathname.replace("/api/projects/", ""));
      const existing = readProjects(); const target = existing.find(item => item.id === id);
      if (target && !owns(target, user)) return sendJson(res, 403, { error: "不能删除其他账号的项目" });
      writeProjects(existing.filter(item => item.id !== id));
      audit(user, "删除项目", "project", id, target?.name || "");
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === "/api/projects-batch-assign" && req.method === "POST") {
      if (user.role !== "main") return sendJson(res, 403, { error: "仅主账号可批量分配项目" });
      const input = await bodyJson(req); const ids = Array.isArray(input.ids) ? input.ids : []; const assignee = readList(USERS_FILE).find(item => item.id === input.ownerUserId && item.enabled !== false);
      if (!assignee) return sendJson(res, 400, { error: "请选择有效账号" });
      const projects = readProjects(); let count = 0;
      projects.forEach(project => { if (ids.includes(project.id)) { project.ownerUserId = assignee.id; project.ownerName = assignee.displayName; project.updatedAt = new Date().toISOString(); count += 1; } });
      writeProjects(projects); audit(user, "批量分配项目", "project", ids.join(","), `${count}个项目 → ${assignee.displayName}`);
      return sendJson(res, 200, { ok: true, count });
    }

    if (url.pathname === "/api/import" && req.method === "POST") {
      const imported = await bodyJson(req);
      if (!Array.isArray(imported)) return sendJson(res, 400, { error: "导入内容必须是数组" });
      const now = new Date().toISOString();
      const current = readProjects();
      safetyBackup("import-projects");
      const merged = new Map(current.map(item => [item.id, item]));
      imported.forEach(item => {
        const id = item.id || crypto.randomUUID();
        merged.set(id, { ...(merged.get(id) || {}), ...item, id, updatedAt: now });
      });
      const projects = [...merged.values()];
      writeProjects(projects);
      audit(user, "合并导入项目", "project", "batch", `导入${imported.length}条，导入后共${projects.length}条`);
      return sendJson(res, 200, projects);
    }

    if (url.pathname === "/api/projects" && req.method === "DELETE") {
      if (user.role !== "main") return sendJson(res, 403, { error: "仅主账号可清空项目" });
      const input = await bodyJson(req);
      if (input.confirmText !== "确认清空全部项目") return sendJson(res, 400, { error: "确认文字不正确，未执行清空" });
      const count = readProjects().length;
      safetyBackup("clear-all-projects");
      writeProjects([]);
      audit(user, "清空全部项目", "project", "all", `清空前${count}条，已创建安全备份`);
      return sendJson(res, 200, { ok: true });
    }

    const safePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    sendFile(res, filePath);
  } catch (error) {
    if (res.headersSent) res.destroy(error);
    else sendJson(res, error.status || 500, { error: error.message });
  } finally {
    if (writing) activeWrites--;
  }
});

// Large attachment restores may take hours; allow active transfers to finish.
server.requestTimeout = 0;
server.setTimeout(120000, socket => socket.destroy());
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = setTimeout(() => { releaseDataDirectoryLock(); process.exit(1); }, 5000);
  deadline.unref();
  server.close(() => { clearTimeout(deadline); releaseDataDirectoryLock(); process.exit(0); });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.on("message", message => { if (message?.type === "shutdown") shutdown(); });
server.listen(PORT, BIND_HOST, () => {
  console.log(`server started on http://127.0.0.1:${PORT}`);
  console.log(localAddresses().join("\n"));
  if (process.send) process.send({ type: "ready", pid: process.pid, port: PORT, bindHost: BIND_HOST });
});

module.exports = { server, localAddresses, PORT, BIND_HOST };
