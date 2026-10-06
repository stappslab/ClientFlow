import {spawn} from 'node:child_process';
import path from 'node:path';
import {readdir} from 'node:fs/promises';
const env={...process.env,XDG_CONFIG_HOME:path.join(process.cwd(),'.firebase','emulator-config'),FIREBASE_EMULATORS_PATH:path.join(process.cwd(),'.firebase','emulators')};
delete env.DEBUG;
try {
 const folder=path.resolve('.firebase/java21');
 const name=(await readdir(folder)).find(name=>name.startsWith('jdk-'));
 if(name){env.JAVA_HOME=path.join(folder,name);env.Path=path.join(env.JAVA_HOME,'bin')+path.delimiter+(env.Path||env.PATH||'');delete env.PATH;}
}catch{}
const child=spawn(process.execPath,['node_modules/firebase-tools/lib/bin/firebase.js','emulators:exec','--only','firestore,auth','--project','demo-clientflow','node --experimental-strip-types tests/firestore.rules.mjs'],{stdio:'inherit',windowsHide:true,env});
child.on('exit',code=>{process.exitCode=code??1;});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
