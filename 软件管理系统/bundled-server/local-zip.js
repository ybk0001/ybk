const fs=require('node:fs');
const {once}=require('node:events');
const crypto=require('node:crypto');
const table=Array.from({length:256},(_,i)=>{let c=i;for(let n=0;n<8;n++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
const crc=(value,chunk)=>{for(const byte of chunk)value=table[(value^byte)&255]^(value>>>8);return value>>>0;};
const limit=512*1024*1024;

async function writeZip(entries,destination){
 if(entries.length>6000)throw Object.assign(new Error('资料文件过多，请分批导出'),{status:413});
 const output=fs.createWriteStream(destination,{flags:'wx'});let offset=0;const directory=[],seen=new Set(),manifest=[];
 let streamError,owned=false;output.on('error',error=>{streamError=error;});
 async function write(bytes){if(streamError)throw streamError;if(offset+bytes.length>limit)throw Object.assign(new Error('资料包超过512MB，请减少附件或分批导出'),{status:413});if(!output.write(bytes))await once(output,'drain');offset+=bytes.length;}
 async function add(entry){
  if(typeof entry.name!=='string'||entry.name.includes('\\')||entry.name.split('/').some(s=>!s||s==='.'||s==='..')||seen.has(entry.name.toLowerCase()))throw new Error('资料包文件名无效或重复');
  seen.add(entry.name.toLowerCase());const name=Buffer.from(entry.name),start=offset;
  if(name.length>65535)throw new Error('资料包文件名过长');
  const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x808,6);header.writeUInt16LE(33,12);header.writeUInt16LE(name.length,26);
  await write(header);await write(name);let size=0,checksum=0xffffffff;const sha=crypto.createHash('sha256');
  const before=entry.file?await fs.promises.stat(entry.file):null;
  const input=entry.file?fs.createReadStream(entry.file):[entry.content];
  for await(const bytes of input){const chunk=Buffer.from(bytes);size+=chunk.length;checksum=crc(checksum,chunk);sha.update(chunk);await write(chunk);}
  if(before){const after=await fs.promises.stat(entry.file);if(size!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new Error('导出期间附件发生变化，请刷新后重试');}
  checksum=(checksum^0xffffffff)>>>0;
  const descriptor=Buffer.alloc(16);descriptor.writeUInt32LE(0x08074b50);descriptor.writeUInt32LE(checksum,4);descriptor.writeUInt32LE(size,8);descriptor.writeUInt32LE(size,12);await write(descriptor);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x808,8);central.writeUInt16LE(33,14);central.writeUInt32LE(checksum,16);central.writeUInt32LE(size,20);central.writeUInt32LE(size,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(start,42);directory.push(Buffer.concat([central,name]));manifest.push({name:entry.name,size,sha256:sha.digest('hex')});
 }
 try{
  await once(output,'open');owned=true;
  for(const entry of entries)await add(entry);
  await add({name:'文件校验清单.json',content:Buffer.from(JSON.stringify(manifest,null,2))});
  const start=offset;for(const row of directory)await write(row);const size=offset-start;
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(directory.length,8);end.writeUInt16LE(directory.length,10);end.writeUInt32LE(size,12);end.writeUInt32LE(start,16);await write(end);
  output.end();await once(output,'close');if(streamError)throw streamError;return {bytes:offset,files:manifest.length};
 }catch(error){output.destroy();if(!output.closed)await once(output,'close').catch(()=>{});if(owned)await fs.promises.rm(destination,{force:true});throw error;}
}
module.exports={writeZip};
