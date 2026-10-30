const fs = require("node:fs");
const path = require("node:path");

const LOCAL_PORT = 32100;

function defaultSettings() {
  return { mode: "local", host: "127.0.0.1", port: LOCAL_PORT, dataDir: "", archiveDir: "" };
}

function normalizeSettings(value = {}) {
  const mode = ["local", "host", "remote"].includes(value.mode) ? value.mode : "local";
  const host = mode === "remote" ? String(value.host || "").trim().replace(/^https?:\/\//, "").replace(/\/$/, "") : "127.0.0.1";
  const port = Number(value.port || (mode === "remote" ? 3000 : LOCAL_PORT));
  const dataDir = mode === "host" ? String(value.dataDir || "").trim() : "";
  const archiveDir = mode === "host" ? String(value.archiveDir || "").trim() : "";
  if (mode === "remote" && !/^[a-zA-Z0-9.-]+$/.test(host)) throw new Error("请输入正确的主机或 NAS IP 地址");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口必须是 1–65535");
  if (Boolean(dataDir) !== Boolean(archiveDir)) throw new Error("NAS 主机模式必须同时填写业务数据目录和项目附件目录");
  if (dataDir && (!path.isAbsolute(dataDir) || !path.isAbsolute(archiveDir))) throw new Error("业务数据目录和项目附件目录必须使用绝对路径或 UNC 路径");
  return { mode, host, port, dataDir, archiveDir };
}

function runtimePaths(settings, userDataDir) {
  const normalized = normalizeSettings(settings);
  if (normalized.mode === "host" && normalized.dataDir) return { dataDir: path.resolve(normalized.dataDir), archiveDir: path.resolve(normalized.archiveDir), external: true };
  return { dataDir: path.join(userDataDir, "business-data"), archiveDir: path.join(userDataDir, "project-files"), external: false };
}

function validateHostPaths(settings, userDataDir) {
  const normalized = normalizeSettings(settings);
  const paths = runtimePaths(normalized, userDataDir);
  if (!paths.external) return paths;
  for (const [label, target] of [["业务数据目录", paths.dataDir], ["项目附件目录", paths.archiveDir]]) {
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error(`${label}不可访问：${target}`);
  }
  for (const name of ["projects.json", "customers.json", "suppliers.json", "users.json", "settings.json"]) {
    const target = path.join(paths.dataDir, name);
    if (!fs.existsSync(target)) throw new Error(`业务数据目录缺少 3.0 基线文件：${name}`);
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(target, "utf8").replace(/^\uFEFF/, "")); }
    catch (error) { throw new Error(`3.0 基线文件无法解析：${name}；${error.message}`); }
    if (name === "settings.json" ? (!parsed || Array.isArray(parsed) || typeof parsed !== "object") : !Array.isArray(parsed)) throw new Error(`3.0 基线文件结构无效：${name}`);
  }
  const dataSettings = JSON.parse(fs.readFileSync(path.join(paths.dataDir, "settings.json"), "utf8").replace(/^\uFEFF/, ""));
  const configuredArchive = String(dataSettings.archiveRoot || "").trim();
  if (!configuredArchive || !path.isAbsolute(configuredArchive)) throw new Error("settings.json 未配置有效的项目附件绝对路径");
  if (path.resolve(configuredArchive).toLocaleLowerCase() !== paths.archiveDir.toLocaleLowerCase()) throw new Error(`所选项目附件目录与 settings.json 不一致；当前实际目录：${path.resolve(configuredArchive)}`);
  return paths;
}

function stableUserDataDir(appData, explicitProfile = '') {
  return path.resolve(explicitProfile || path.join(appData, 'enterprise-project-manager-local'));
}

function resolveStartupSettings(value, userDataDir) {
  const saved = normalizeSettings(value);
  if (saved.mode !== 'host' || !saved.dataDir) return saved;
  const file = path.join(saved.dataDir, 'settings.json');
  // Keep the strict baseline checks and never infer a different account book.
  if (!fs.existsSync(file)) { validateHostPaths(saved, userDataDir); return saved; }
  let business;
  try { business = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { validateHostPaths(saved, userDataDir); return saved; }
  const samePath = (a, b) => process.platform === 'win32'
    ? path.resolve(a).toLocaleLowerCase() === path.resolve(b).toLocaleLowerCase()
    : path.resolve(a) === path.resolve(b);
  const current = String(business?.archiveRoot || '').trim();
  const aliases = Array.isArray(business?.archiveRootAliases) ? business.archiveRootAliases : [];
  // The archive API records the former root as an alias after an authorized change.
  // Only follow that recorded transition; an arbitrary mismatch must still fail.
  const recordedTransition = current && path.isAbsolute(current)
    && !samePath(current, saved.archiveDir)
    && aliases.some(alias => typeof alias === 'string' && path.isAbsolute(alias) && samePath(alias, saved.archiveDir));
  const resolved = recordedTransition ? { ...saved, archiveDir: current } : saved;
  validateHostPaths(resolved, userDataDir);
  return resolved;
}

module.exports = { LOCAL_PORT, defaultSettings, normalizeSettings, runtimePaths, validateHostPaths, stableUserDataDir, resolveStartupSettings };
