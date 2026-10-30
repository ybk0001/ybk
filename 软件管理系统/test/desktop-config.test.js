const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const test = require("node:test");
const config = require("../desktop-config");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "epm4-desktop-config-"));
  const data = join(root, "data"), archive = join(root, "archive"), userData = join(root, "user-data");
  mkdirSync(data); mkdirSync(archive); mkdirSync(userData);
  for (const name of ["projects.json", "customers.json", "suppliers.json", "users.json"]) writeFileSync(join(data, name), "[]", "utf8");
  writeFileSync(join(data, "settings.json"), JSON.stringify({ archiveRoot: archive }), "utf8");
  return { data, archive, userData };
}

test("桌面主机模式只接受同时存在且包含3.0基线的绝对数据与附件目录", () => {
  const sample = fixture();
  assert.throws(() => config.normalizeSettings({ mode: "host", dataDir: sample.data }), /必须同时填写/);
  assert.throws(() => config.normalizeSettings({ mode: "host", dataDir: "relative-data", archiveDir: "relative-files" }), /绝对路径/);
  const paths = config.validateHostPaths({ mode: "host", port: 32100, dataDir: sample.data, archiveDir: sample.archive }, sample.userData);
  assert.equal(paths.external, true);
  assert.equal(paths.dataDir, sample.data);
  assert.equal(paths.archiveDir, sample.archive);
});

test("缺少3.0核心文件时拒绝切换正式主机，旧本地主机配置继续兼容", () => {
  const sample = fixture();
  writeFileSync(join(sample.data, "projects.json"), "[]", "utf8");
  const emptyData = join(sample.userData, "incomplete"); mkdirSync(emptyData);
  assert.throws(() => config.validateHostPaths({ mode: "host", dataDir: emptyData, archiveDir: sample.archive }, sample.userData), /缺少 3\.0 基线文件：projects\.json/);
  const legacy = config.validateHostPaths({ mode: "host", port: 32100 }, sample.userData);
  assert.equal(legacy.external, false);
  assert.equal(legacy.dataDir, join(sample.userData, "business-data"));
});

test("远程客户端不会保留或使用主机数据目录", () => {
  const settings = config.normalizeSettings({ mode: "remote", host: "192.168.1.8", port: 32100, dataDir: "D:\\data", archiveDir: "D:\\files" });
  assert.equal(settings.dataDir, "");
  assert.equal(settings.archiveDir, "");
  assert.equal(settings.host, "192.168.1.8");
});

test("正式主机启动前阻断损坏基线和附件目录配置漂移", () => {
  const malformed = fixture();
  writeFileSync(join(malformed.data, "projects.json"), "{损坏", "utf8");
  assert.throws(() => config.validateHostPaths({ mode: "host", dataDir: malformed.data, archiveDir: malformed.archive }, malformed.userData), /无法解析：projects\.json/);

  const mismatched = fixture(), otherArchive = join(mismatched.userData, "other-archive");
  mkdirSync(otherArchive);
  assert.throws(() => config.validateHostPaths({ mode: "host", dataDir: mismatched.data, archiveDir: otherArchive }, mismatched.userData), /与 settings\.json 不一致/);
});

test('账本已通过文件位置设置切换目录时，重启沿用已记录的新目录且不改业务文件', () => {
  const sample = fixture(), next = join(sample.userData, 'nas-files'); mkdirSync(next);
  const settingsFile = join(sample.data, 'settings.json');
  writeFileSync(settingsFile, JSON.stringify({ archiveRoot: next, archiveRootAliases: [sample.archive] }));
  writeFileSync(join(sample.archive, 'original.txt'), 'preserved');
  const before = readFileSync(settingsFile);
  const saved = { mode: 'host', port: 32100, dataDir: sample.data, archiveDir: sample.archive };
  const resolved = config.resolveStartupSettings(saved, sample.userData);
  assert.equal(resolved.archiveDir, next);
  assert.equal(resolved.dataDir, sample.data);
  assert.equal(saved.archiveDir, sample.archive);
  assert.deepEqual(readFileSync(settingsFile), before);
  assert.equal(readFileSync(join(sample.archive, 'original.txt'), 'utf8'), 'preserved');
});

test('目录不一致但没有历史别名证明时，启动仍拒绝猜测切换', () => {
  const sample = fixture(), wrong = join(sample.userData, 'wrong'); mkdirSync(wrong);
  assert.throws(() => config.resolveStartupSettings({ mode: 'host', dataDir: sample.data, archiveDir: wrong }, sample.userData), /不一致/);
});

test('NAS新目录不可达时不创建空目录，也不退回旧文件位置', () => {
  const sample = fixture(), missing = join(sample.userData, 'unavailable');
  writeFileSync(join(sample.data, 'settings.json'), JSON.stringify({ archiveRoot: missing, archiveRootAliases: [sample.archive] }));
  assert.throws(() => config.resolveStartupSettings({ mode: 'host', dataDir: sample.data, archiveDir: sample.archive }, sample.userData), /不可访问/);
  assert.equal(existsSync(missing), false);
});

test('有历史目录别名仍不能绕过损坏的业务基线', () => {
  const sample = fixture(), next = join(sample.userData, 'next'); mkdirSync(next);
  writeFileSync(join(sample.data, 'settings.json'), JSON.stringify({ archiveRoot: next, archiveRootAliases: [sample.archive] }));
  writeFileSync(join(sample.data, 'projects.json'), '{invalid');
  assert.throws(() => config.resolveStartupSettings({ mode: 'host', dataDir: sample.data, archiveDir: sample.archive }, sample.userData), /无法解析/);
});
