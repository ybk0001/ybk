const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:net");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const test = require("node:test");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer(); server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); });
  });
}

async function waitFor(url, child) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`测试服务提前退出：${child.exitCode}`);
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error("测试服务启动超时");
}

async function waitUntil(predicate, message) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(message);
}

function launch(data, files, port) {
  return spawn(process.execPath, [join(__dirname, "..", "bundled-server", "server.js")], {
    env: { ...process.env, PORT: String(port), BIND_HOST: "127.0.0.1", PROJECT_DATA_DIR: data, PROJECT_ARCHIVE_DIR: files },
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
}

async function stopGracefully(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once("exit", resolve));
  if (child.connected) child.send({ type: "shutdown" });
  else child.kill("SIGKILL");
  await exited;
}

test("同一业务目录只允许一个服务，正常停止释放锁且同主机崩溃锁可安全回收", async () => {
  const root = mkdtempSync(join(tmpdir(), "epm4-server-lock-"));
  const data = join(root, "data"), files = join(root, "files"), lockDir = join(data, ".epm4-server-lock");
  mkdirSync(data); mkdirSync(files);
  writeFileSync(join(data, "settings.json"), JSON.stringify({ archiveRoot: files, archiveRootAliases: [] }), "utf8");
  writeFileSync(join(data, "projects.json"), "[]", "utf8");
  const firstPort = await freePort(), secondPort = await freePort(), thirdPort = await freePort(), fourthPort = await freePort();
  const first = launch(data, files, firstPort);
  let third, fourth;
  try {
    await waitFor(`http://127.0.0.1:${firstPort}/api/status`, first);
    assert.equal(existsSync(lockDir), true);
    const owner = JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8"));
    assert.equal(owner.pid, first.pid);

    const second = launch(data, files, secondPort);
    let secondError = ""; second.stderr.on("data", chunk => { secondError += chunk; });
    const secondExit = await new Promise(resolve => second.once("exit", code => resolve(code)));
    assert.notEqual(secondExit, 0);
    assert.match(secondError, /数据目录正在由另一台主机使用/);
    assert.equal(JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8")).pid, first.pid);

    first.send({ type: "shutdown" });
    await new Promise(resolve => first.once("exit", resolve));
    await waitUntil(() => !existsSync(lockDir), "服务停止后未释放数据目录锁");

    third = launch(data, files, thirdPort);
    await waitFor(`http://127.0.0.1:${thirdPort}/api/status`, third);
    assert.equal(existsSync(lockDir), true);

    third.kill("SIGKILL");
    await new Promise(resolve => third.once("exit", resolve));
    assert.equal(existsSync(lockDir), true);
    fourth = launch(data, files, fourthPort);
    await waitFor(`http://127.0.0.1:${fourthPort}/api/status`, fourth);
    assert.equal(JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8")).pid, fourth.pid);
  } finally {
    await stopGracefully(first);
    await stopGracefully(third);
    await stopGracefully(fourth);
  }
});
