const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const LOCK_NAME = ".epm4-server-lock";

function ownerSummary(owner) {
  if (!owner || typeof owner !== "object") return "锁信息不可读";
  return [owner.hostname && `主机 ${owner.hostname}`, owner.pid && `进程 ${owner.pid}`, owner.startedAt && `启动于 ${owner.startedAt}`].filter(Boolean).join("，") || "锁信息不完整";
}

function readOwner(lockDir) {
  try { return JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8")); } catch { return null; }
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

function processStartToken(pid) {
  if (process.platform !== "linux") return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    return stat.slice(close + 1).trim().split(/\s+/)[19] || null;
  } catch { return null; }
}

function ownerProcessExists(owner) {
  const pid = Number(owner?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (!processExists(pid)) return false;
  if (owner.hostname !== os.hostname()) return true;
  const actualToken = processStartToken(pid);
  if (owner.processStartToken && actualToken) return owner.processStartToken === actualToken;
  if (pid === process.pid) {
    const lockStartedAt = Date.parse(owner.startedAt || "");
    const thisProcessStartedAt = Date.now() - process.uptime() * 1000;
    if (Number.isFinite(lockStartedAt) && lockStartedAt < thisProcessStartedAt - 5000) return false;
  }
  return true;
}

function removeLock(lockDir, expectedId) {
  const current = readOwner(lockDir);
  if (!current || current.id !== expectedId) return false;
  try { fs.unlinkSync(path.join(lockDir, "owner.json")); } catch { return false; }
  try { fs.rmdirSync(lockDir); return true; } catch { return false; }
}

function acquire(dataDir, recovered = false) {
  fs.mkdirSync(dataDir, { recursive: true });
  const lockDir = path.join(dataDir, LOCK_NAME);
  const owner = { id: crypto.randomUUID(), hostname: os.hostname(), pid: process.pid, startedAt: new Date().toISOString(), processStartToken: processStartToken(process.pid) };
  try {
    fs.mkdirSync(lockDir);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const stat = fs.lstatSync(lockDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`数据目录锁路径不安全：${lockDir}`);
    const current = readOwner(lockDir);
    if (!recovered && current?.hostname === os.hostname() && !ownerProcessExists(current) && removeLock(lockDir, current.id)) return acquire(dataDir, true);
    throw new Error(`数据目录正在由另一台主机使用（${ownerSummary(current)}）。请只保留一个4.0服务；若确认所有服务都已停止，请按部署手册清理遗留锁。`);
  }

  try {
    fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify(owner, null, 2), { encoding: "utf8", flag: "wx" });
  } catch (error) {
    try { fs.rmdirSync(lockDir); } catch {}
    throw error;
  }

  let released = false;
  return function release() {
    if (released) return;
    released = removeLock(lockDir, owner.id);
  };
}

module.exports = { LOCK_NAME, acquire, readOwner, ownerSummary };
