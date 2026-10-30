function waitForChildReady(child, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error); else resolve(message);
    };
    const onMessage = message => { if (message?.type === "ready") finish(null, message); };
    const onError = error => finish(error);
    const onExit = (code, signal) => finish(new Error(`本次服务进程在就绪前退出（代码 ${code ?? "无"}${signal ? `，信号 ${signal}` : ""}）`));
    const timer = setTimeout(() => finish(new Error(`本次服务进程在 ${timeoutMs} 毫秒内未确认就绪`)), timeoutMs);
    timer.unref?.();
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

module.exports = { waitForChildReady };
