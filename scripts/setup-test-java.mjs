import {mkdir,readdir} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';

const folder=path.resolve('.firebase/java21');
await mkdir(folder,{recursive:true});
if((await readdir(folder)).some(name=>name.startsWith('jdk-'))){console.log('Portable test JDK already exists.');process.exit(0);}
const archive=path.resolve('.firebase/java21.zip');
console.log('Downloading the official Microsoft OpenJDK 21 portable archive for local emulator tests.');
const response=await fetch('https://aka.ms/download-jdk/microsoft-jdk-21-windows-x64.zip');
if(!response.ok||!response.body)throw Error('JDK download failed: HTTP '+response.status);
await pipeline(Readable.fromWeb(response.body),createWriteStream(archive));
await new Promise((resolve,reject)=>{const child=spawn('tar',['-xf',archive,'-C',folder],{stdio:'inherit',windowsHide:true});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('Archive extraction failed.')));});
console.log('Portable JDK ready in .firebase/java21; system Java settings are unchanged.');
