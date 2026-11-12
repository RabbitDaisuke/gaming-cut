import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
// Static deployment: validate the shipped files; no packages or bundler required.
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (path.endsWith('.js')) {
      const checked = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
      if (checked.status !== 0) throw Error(checked.stderr || path);
    }
  }
}
await walk('dist');
// Provide the exact corresponding source on static hosts, without a ZIP dependency.
const entries=[];
async function collect(dir=''){
  for(const e of await readdir(dir||'.',{withFileTypes:true})){
    if(['.git','node_modules','.DS_Store'].includes(e.name))continue;
    const path=dir?dir+'/'+e.name:e.name;
    if(path==='dist/source.zip'||path.endsWith('.tar.gz'))continue;
    if(e.isDirectory())await collect(path);
    else if(e.isFile())entries.push({name:path,data:await readFile(path)});
  }
}
await collect();entries.sort((a,b)=>a.name.localeCompare(b.name));
let offset=0;const local=[],central=[];
for(const {name,data} of entries){
  const filename=Buffer.from(name,'utf8'),crc=crc32(data),header=Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(33,12);
  header.writeUInt32LE(crc,14);header.writeUInt32LE(data.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(filename.length,26);
  local.push(header,filename,data);
  const item=Buffer.alloc(46);item.writeUInt32LE(0x02014b50);item.writeUInt16LE(20,4);item.writeUInt16LE(20,6);item.writeUInt16LE(0x800,8);item.writeUInt16LE(33,14);
  item.writeUInt32LE(crc,16);item.writeUInt32LE(data.length,20);item.writeUInt32LE(data.length,24);item.writeUInt16LE(filename.length,28);item.writeUInt32LE(offset,42);
  central.push(item,filename);offset+=header.length+filename.length+data.length;
}
const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
await writeFile('dist/source.zip',Buffer.concat([...local,directory,end]));
const html = await readFile('dist/index.html', 'utf8');
for (const [, target] of html.matchAll(/(?:src|href)="\.\/([^"?]+)(?:\?[^" ]*)?"/g)) {
  if (!(await stat(join('dist', target))).isFile()) throw Error('Missing asset: ' + target);
}
await stat('dist/assets/rainbow-glitter.png');
console.log('Build complete: dist/ (static, no dependencies)');
