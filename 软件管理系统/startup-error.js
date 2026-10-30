function formatStartupError(error) {
  const message = String(error?.message || error || "");

  if (/数据目录正在由.*使用/.test(message)) {
    return "账本正在由另一个服务使用。为避免同时写入造成数据冲突，本次没有启动第二个服务。请先退出正在使用这份账本的旧客户端或服务，再选择“系统 → 重新连接”。如果账本放在 NAS 上，请先确认 NAS 主机上的服务已经停止。";
  }

  if (/EADDRINUSE|address already in use|端口.*占用/i.test(message)) {
    return "本机服务端口已被占用。请在“系统 → 使用模式与网络设置”中检查端口，或关闭占用该端口的旧服务后重新连接。";
  }

  const firstLine = message.split(/\r?\n/).map(line => line.trim()).find(line => line && !/^at\s/.test(line));
  if (firstLine && /(?:目录|路径|settings\.json|基线文件|配置|端口).*(?:不可访问|缺少|无效|不一致|无法|必须|错误)/i.test(firstLine)) {
    return firstLine.replace(/^Error:\s*/, "");
  }

  return "本地服务未能启动。启动过程不会删除或覆盖账本数据。请检查数据目录和附件目录是否可用，再选择“系统 → 重新连接”；若仍失败，请联系软件维护人员并提供诊断信息。";
}

module.exports = { formatStartupError };
