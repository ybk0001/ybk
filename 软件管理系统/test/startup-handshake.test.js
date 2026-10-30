const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { waitForChildReady } = require("../startup-handshake");

test("桌面只接受本次子服务通过IPC发出的就绪消息", async () => {
  const child = new EventEmitter();
  const pending = waitForChildReady(child, 1000);
  child.emit("message", { type: "unrelated" });
  child.emit("message", { type: "ready", pid: 1234, port: 32100, bindHost: "127.0.0.1" });
  const ready = await pending;

  assert.equal(ready.pid, 1234);
  assert.equal(ready.port, 32100);
});

test("端口冲突等导致子服务就绪前退出时启动失败", async () => {
  const child = new EventEmitter();
  const pending = waitForChildReady(child, 1000);
  child.emit("exit", 1, null);

  await assert.rejects(pending, /就绪前退出.*代码 1/);
});
