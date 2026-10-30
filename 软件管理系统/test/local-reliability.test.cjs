const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {Readable,PassThrough}=require('node:stream');
const {saveUpload}=require('../bundled-server/atomic-upload');
const {allowedRequest}=require('../local-network-policy');
const {stableUserDataDir}=require('../desktop-config');

test('本地数据路径绑定固定产品ID，显式隔离测试目录继续有效',()=>{
 const roaming=path.resolve(os.tmpdir(),'company-roaming');
 assert.equal(stableUserDataDir(roaming),path.join(roaming,'enterprise-project-manager-local'));
 const isolated=path.resolve(os.tmpdir(),'isolated-profile');
 assert.equal(stableUserDataDir(roaming,isolated),isolated);
});

test('断线上传不覆盖原附件，超限和磁盘提交失败都清理临时文件',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'epm-local-upload-'));
 const file=path.join(root,'proof.bin');fs.writeFileSync(file,'original');
 const input=new PassThrough();const transfer=saveUpload(input,file);input.write('partial');
 input.destroy(new Error('connection lost'));await assert.rejects(transfer,/connection lost/);
 assert.equal(fs.readFileSync(file,'utf8'),'original');assert.deepEqual(fs.readdirSync(root),['proof.bin']);
 await assert.rejects(saveUpload(Readable.from([Buffer.from('oversize')]),file,3),error=>error.status===413);
 assert.equal(fs.readFileSync(file,'utf8'),'original');assert.deepEqual(fs.readdirSync(root),['proof.bin']);
 const blocked=path.join(root,'directory');fs.mkdirSync(blocked);
 await assert.rejects(saveUpload(Readable.from([Buffer.from('new')]),blocked));
 assert.equal(fs.readdirSync(root).some(name=>name.endsWith('.tmp')),false);
 assert.equal(await saveUpload(Readable.from([Buffer.from('complete')]),file),8);
 assert.equal(fs.readFileSync(file,'utf8'),'complete');
});
test('桌面业务请求仅允许当前公司服务，拒绝外部域名、前缀欺骗和其他端口',()=>{
 const company='http://192.168.1.3:3000';
 for(const url of [company+'/api/projects',company+'/api/files/upload','data:text/html,test','file:///C:/app/settings.html'])assert.equal(allowedRequest(url,company),true,url);
 for(const url of ['https://example.com/collect','http://192.168.1.3:3000.evil.invalid/','http://192.168.1.3:3001/api','http://user@192.168.1.3:3000/','ws://192.168.1.3:3000','invalid'])assert.equal(allowedRequest(url,company),false,url);
 assert.equal(allowedRequest('http://127.0.0.1:32100/api/status','http://127.0.0.1:32100'),true);
 assert.equal(allowedRequest('blob:http://192.168.1.3:3000/uuid',company),true);
});
