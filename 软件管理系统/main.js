const { app, BrowserWindow, Menu, shell, ipcMain, dialog, session } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const desktopConfig = require('./desktop-config');
const { waitForChildReady } = require('./startup-handshake');
const { formatStartupError } = require('./startup-error');
const { allowedRequest } = require('./local-network-policy');

const { LOCAL_PORT } = desktopConfig;
const backgroundSmoke = app.commandLine.hasSwitch('epm-background-smoke') && Boolean(app.commandLine.getSwitchValue('user-data-dir'));
let mainWindow;
let localServer;
let localServerError = '';
let quitting = false;

function settingsFile() { return path.join(app.getPath('userData'), 'desktop-settings.json'); }
function readSettings() { return fs.existsSync(settingsFile()) ? desktopConfig.normalizeSettings(JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))) : desktopConfig.defaultSettings(); }
function saveSettings(value) { const saved = desktopConfig.normalizeSettings(value); desktopConfig.validateHostPaths(saved, app.getPath('userData')); fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), `${JSON.stringify(saved, null, 2)}\n`, 'utf8'); return saved; }
function localAddresses(port) { const rows = []; for (const items of Object.values(os.networkInterfaces())) for (const item of items || []) if (item.family === 'IPv4' && !item.internal) rows.push({ ip: item.address, url: `http://${item.address}:${port}` }); return rows; }
function makeConnectionCode(settings = readSettings()) { const address = localAddresses(settings.port)[0]; return address ? Buffer.from(JSON.stringify({ v: 1, host: address.ip, port: settings.port }), 'utf8').toString('base64url') : ''; }
function parseConnectionCode(code) { try { const value = JSON.parse(Buffer.from(String(code || '').trim(), 'base64url').toString('utf8')); return desktopConfig.normalizeSettings({ mode: 'remote', host: value.host, port: value.port }); } catch (_) { throw new Error('连接码无效，请让主机电脑重新复制'); } }
function targetUrl(settings = readSettings()) { return settings.mode === 'remote' ? `http://${settings.host}:${settings.port}` : `http://127.0.0.1:${settings.port}`; }
function bundledServerDir() { return app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', 'bundled-server') : path.join(__dirname, 'bundled-server'); }
function stopLocalServer() {
  const child = localServer; localServer = null;
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); }, 5000); timer.unref();
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    if (child.connected) child.send({ type: 'shutdown' }); else child.kill();
  });
}
async function startLocalServer(settings) {
  await stopLocalServer();
  if (settings.mode === 'remote') return;
  const resolved = desktopConfig.resolveStartupSettings(settings, app.getPath('userData'));
  if (resolved.archiveDir !== settings.archiveDir) saveSettings(resolved);
  settings = resolved;
  const serverDir = bundledServerDir();
  const paths = desktopConfig.validateHostPaths(settings, app.getPath('userData'));
  if (!paths.external) { fs.mkdirSync(paths.dataDir, { recursive: true }); fs.mkdirSync(paths.archiveDir, { recursive: true }); }
  localServerError = '';
  localServer = spawn(process.execPath, [path.join(serverDir, 'server.js')], { cwd: serverDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(settings.port), BIND_HOST: settings.mode === 'host' ? '0.0.0.0' : '127.0.0.1', PROJECT_DATA_DIR: paths.dataDir, PROJECT_ARCHIVE_DIR: paths.archiveDir } });
  const child = localServer;
  child.stderr.on('data', chunk => { localServerError = `${localServerError}${chunk}`.slice(-4000); });
  child.on('exit', () => { if (localServer === child) localServer = null; });
  try { await waitForChildReady(child, 15000); }
  catch (error) { await stopLocalServer(); throw new Error(`${error.message}${localServerError ? `：${localServerError.trim()}` : ''}`); }
}
async function waitForServer(url, timeoutMs) { const end = Date.now() + timeoutMs; while (Date.now() < end) { try { const response = await fetch(`${url}/api/status`); if (response.ok) return true; } catch (_) {} await new Promise(resolve => setTimeout(resolve, 250)); } return false; }
function offlinePage(url, detail = '') { const escape = value => String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); const safe = escape(url), reason = escape(detail); return `data:text/html;charset=UTF-8,${encodeURIComponent(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>连接失败</title><style>body{margin:0;background:#f3f7f5;color:#17231f;font:16px system-ui,"Microsoft YaHei";display:grid;place-items:center;min-height:100vh}.card{width:min(680px,calc(100% - 48px));background:#fff;padding:40px;border-radius:18px;box-shadow:0 18px 60px #19382b18}p{color:#66756f;line-height:1.7}code{background:#edf4f1;padding:4px 8px;border-radius:6px;word-break:break-all}.error{color:#b42318}</style><div class="card"><h1>暂时无法连接</h1><p>当前地址：<code>${safe}</code></p>${reason ? `<p class="error">${reason}</p>` : ''}<p>请打开“系统 → 使用模式与网络设置”，检查模式、数据目录、IP 和端口。</p></div></html>`)}`; }
async function connectCurrent() { try { const settings = readSettings(); await startLocalServer(settings); const url = targetUrl(settings); const ready = await waitForServer(url, settings.mode === 'remote' ? 5000 : 15000); if (mainWindow) mainWindow.loadURL(ready ? url : offlinePage(url, formatStartupError(localServerError || '服务未确认就绪'))); } catch (error) { if (mainWindow) mainWindow.loadURL(offlinePage('配置检查未通过', formatStartupError(error))); } }
function openSettings() { const win = new BrowserWindow({ parent: mainWindow || undefined, modal: Boolean(mainWindow), width: 620, height: 680, resizable: false, title: '使用模式与网络设置', autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } }); win.loadFile(path.join(__dirname, 'settings.html')); }
function installMenu() { Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: '系统', submenu: [{ label: '使用模式与网络设置', accelerator: 'CmdOrCtrl+,', click: openSettings }, { label: '重新连接', accelerator: 'CmdOrCtrl+R', click: connectCurrent }, { type: 'separator' }, { label: '退出', role: 'quit' }] }])); }
function createWindow() {
  const win = new BrowserWindow({ width: 1440, height: 920, minWidth: 1080, minHeight: 680, show: false, autoHideMenuBar: false, icon: path.join(__dirname, 'app-icon.ico'), backgroundColor: '#f3f7f5', webPreferences: { preload: path.join(__dirname, 'main-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, ...(backgroundSmoke ? { offscreen: true, backgroundThrottling: false } : {}) } });
  mainWindow = win;
  // Background acceptance requires an explicit isolated profile and never takes focus.
  win.once('ready-to-show', () => { if (!backgroundSmoke) win.show(); });
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  win.webContents.setWindowOpenHandler(({ url }) => ({ action: allowedRequest(url, targetUrl()) ? 'allow' : 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (!allowedRequest(url, targetUrl())) event.preventDefault(); });
  connectCurrent();
}

// A marketing name change must never create a different company data directory.
app.setPath('userData', desktopConfig.stableUserDataDir(app.getPath('appData'), app.commandLine.getSwitchValue('user-data-dir')));
app.setAppUserModelId('cn.fu.enterprise-project-manager-local');
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
app.on('second-instance', () => { if (mainWindow && !backgroundSmoke) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });
if (primaryInstance) app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    callback({ cancel: !allowedRequest(details.url, targetUrl()) });
  });
  ipcMain.handle('settings:get', () => { const settings = readSettings(); return { ...settings, addresses: localAddresses(settings.port), connectionCode: settings.mode === 'host' ? makeConnectionCode(settings) : '' }; });
  ipcMain.handle('settings:decode', (_event, code) => parseConnectionCode(code));
  ipcMain.handle('settings:save', async (_event, value) => { const saved = saveSettings(value); await connectCurrent(); return saved; });
  ipcMain.handle('settings:choose-directory', async () => { const result = await dialog.showOpenDialog(mainWindow, { title: '选择已存在的文件夹', properties: ['openDirectory'] }); return result.canceled ? '' : result.filePaths[0] || ''; });
  ipcMain.handle('settings:firewall', (_event, port) => new Promise(resolve => { const safePort = Math.max(1, Math.min(65535, Number(port) || LOCAL_PORT)); const command = `Start-Process netsh -Verb RunAs -Wait -ArgumentList 'advfirewall firewall add rule name="企业项目收付款管理" dir=in action=allow protocol=TCP localport=${safePort} profile=private'`; execFile('powershell.exe', ['-NoProfile', '-Command', command], { windowsHide: true }, error => resolve({ ok: !error, message: error ? error.message : '防火墙已允许局域网访问' })); }));
  ipcMain.handle('desktop:context', () => ({ mode: readSettings().mode }));
  ipcMain.handle('desktop:open-tax-reference', (event, id) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('不允许的来源窗口');
    const source = require(path.join(bundledServerDir(), 'tax-reference-sources')).find(source => source.id === id);
    if (!source) throw new Error('未知的官方参考入口');
    return shell.openExternal(source.url);
  });
  ipcMain.handle('desktop:choose-archive-directory', async () => { const current = readSettings(); if (current.mode === 'remote') return ''; const result = await dialog.showOpenDialog(mainWindow, { title: '选择项目文件存放位置', properties: ['openDirectory', 'createDirectory'] }); return result.canceled ? '' : result.filePaths[0] || ''; });
  installMenu(); createWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('before-quit', event => {
  if (quitting || !localServer) return;
  event.preventDefault(); quitting = true;
  stopLocalServer().finally(() => app.quit());
});
app.on('window-all-closed', () => app.quit());
