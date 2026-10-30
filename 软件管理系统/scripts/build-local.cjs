const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const product=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const version=process.env.EPM_BUILD_VERSION||product.version;
if(!/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(version))throw Error('Invalid release version');
const release=path.join(root,'dist',version),payload=path.join(release,'win-x64');
if(fs.existsSync(release))throw Error('Release exists; refusing overwrite');
const electron=process.env.ELECTRON_DIST||path.resolve(root,'../enterprise-project-manager-4/node_modules/electron/dist');
const compiler=process.env.NSIS_COMPILER;
if(!compiler||!fs.existsSync(compiler))throw Error('NSIS_COMPILER must point to the installed makensis.exe');
if(!fs.existsSync(path.join(electron,'electron.exe')))throw Error('Electron runtime missing');
const appFiles=['main.js','desktop-config.js','local-network-policy.js','startup-handshake.js','startup-error.js','main-preload.js','preload.js','settings.html','app-icon.ico'];
const modules=['server.js','atomic-upload.js','audit-ledger.js','bank-ledger.js','data-directory-lock.js','finance-report.js','legacy-migration.js','payment-ledger.js','receipt-ledger.js','reliable-backup.js','spreadsheet-reader.js','tax-ledger.js','tax-assistant.js','tax-reference-sources.js','local-zip.js'];
const assets=['index.html','minimal.css','merged-workspace.js','workspace-layout.css','workspace-layout.js','finance-report.js','tax-assistant.js','tax-assistant.css','manifest.webmanifest','app-icon.svg'];
const inputs=[...appFiles,...modules.map(f=>'bundled-server/'+f),...assets.map(f=>'bundled-server/public/'+f)];
for(const name of inputs)if(!fs.statSync(path.join(root,name)).isFile())throw Error('Missing '+name);
const html=fs.readFileSync(path.join(root,'bundled-server/public/index.html'),'utf8');
for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))new Function(match[1]);
for(const file of inputs.filter(n=>n.endsWith('.js')))execFileSync(process.execPath,['--check',path.join(root,file)],{stdio:'pipe'});
fs.mkdirSync(release,{recursive:true});fs.cpSync(electron,payload,{recursive:true});
const app=path.join(payload,'resources/app'),server=path.join(payload,'resources/app.asar.unpacked/bundled-server');
fs.mkdirSync(app,{recursive:true});fs.mkdirSync(path.join(server,'public'),{recursive:true});
for(const file of appFiles)fs.copyFileSync(path.join(root,file),path.join(app,file));
fs.writeFileSync(path.join(app,'package.json'),JSON.stringify({...product,version},null,2)+'\n');
for(const file of modules)fs.copyFileSync(path.join(root,'bundled-server',file),path.join(server,file));
for(const file of assets)fs.copyFileSync(path.join(root,'bundled-server/public',file),path.join(server,'public',file));
fs.renameSync(path.join(payload,'electron.exe'),path.join(payload,'企业项目收付款管理 本地版.exe'));
fs.writeFileSync(path.join(payload,'本地数据说明.txt'),[
 '企业项目收付款管理 本地版 '+version+'（候选）',
 '数据与附件：%APPDATA%\\enterprise-project-manager-local；连接公司主机时由主机保存。',
 '安装目录只保存程序，升级和卸载不清空AppData或NAS业务数据。',
 '升级前请导出包含附件的完整备份。更新员工客户端不会更新NAS服务器。',
 '不需要厂商云账号，不自动上传业务资料，不自动下载更新组件。',
 '公司多人使用时指定一台主机，其他电脑通过连接码连接。',
 '此候选版本尚未完成商业发布验收或代码签名。'
].join('\r\n'),'utf8');
const files=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name)):[path.join(dir,e.name)]);
const manifest=files(payload).sort().map(file=>({path:path.relative(payload,file).replaceAll('\\','/'),sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}));
for(const row of manifest)if(/(?:^|\/)(?:business-data|project-files|data|\.data|users\.json|sessions\.json|projects\.json)(?:\/|$)/i.test(row.path))throw Error('Business data found in distribution');
fs.writeFileSync(path.join(payload,'release-manifest.json'),JSON.stringify({product:product.name,version,offline:true,businessDataIncluded:false,files:manifest},null,2)+'\n');
const installer=path.join(release,`企业项目收付款管理-本地版-${version}-安装更新.exe`);
execFileSync(compiler,['/V2','/INPUTCHARSET','UTF8',`/DPAYLOAD=${payload}`,`/DVERSION=${version}`,`/DOUTPUT=${installer}`,path.join(root,'installer/local.nsi')],{stdio:'pipe',maxBuffer:2*1024*1024});
const sha=crypto.createHash('sha256').update(fs.readFileSync(installer)).digest('hex');
fs.writeFileSync(installer+'.sha256',sha+' *'+path.basename(installer)+'\n');
console.log(JSON.stringify({version,installer,payload,sha256:sha,files:manifest.length,offline:true,businessDataIncluded:false},null,2));
