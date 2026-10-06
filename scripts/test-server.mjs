import {spawn} from 'node:child_process';
import path from 'node:path';
import {readdir} from 'node:fs/promises';
import './build-functions.mjs';
const env={...process.env,XDG_CONFIG_HOME:path.resolve('.firebase/emulator-config'),FIREBASE_EMULATORS_PATH:path.resolve('.firebase/emulators')};delete env.DEBUG;
try{const base=path.resolve('.firebase/java21'),jdk=(await readdir(base)).find(n=>n.startsWith('jdk-'));if(jdk){env.JAVA_HOME=path.join(base,jdk);env.Path=path.join(env.JAVA_HOME,'bin')+path.delimiter+(env.Path||env.PATH||'');delete env.PATH;}}catch{}
const child=spawn(process.execPath,['node_modules/firebase-tools/lib/bin/firebase.js','emulators:exec','--only','firestore,auth,functions','--project','demo-clientflow','node --experimental-strip-types tests/run-server.mjs'],{stdio:'inherit',windowsHide:true,env});child.on('exit',code=>{process.exitCode=code??1;});child.on('error',e=>{console.error(e.message);process.exitCode=1;});
