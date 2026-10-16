import crx3 from 'crx3';
import { mkdir,chmod,readFile } from 'node:fs/promises';
await mkdir('../artifacts',{recursive:true});await mkdir('../data/extension-keys',{recursive:true});
await crx3(['dist/manifest.json'],{keyPath:'../data/extension-keys/manyvo.pem',crxPath:'../artifacts/manyvo-yandex.crx',zipPath:'../artifacts/manyvo-yandex.zip'});
await chmod('../data/extension-keys/manyvo.pem',0o600);
const bytes=await readFile('../artifacts/manyvo-yandex.crx');if(bytes.subarray(0,4).toString()!=='Cr24'||bytes.readUInt32LE(4)!==3)throw new Error('Not a CRX3 package');
console.log('Packaged artifacts/manyvo-yandex.crx and .zip. Signing key stays in ignored data/.');
