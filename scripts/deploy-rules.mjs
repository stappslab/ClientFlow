import {spawn} from 'node:child_process';
const env={...process.env};
delete env.DEBUG;
const project=process.argv[2];
if(!project||project.startsWith('-'))throw Error('Usage: node scripts/deploy-rules.mjs <firebase-project-id>');
const child=spawn(process.execPath,['node_modules/firebase-tools/lib/bin/firebase.js','deploy','--only','firestore:rules','--project',project,'--non-interactive'],{stdio:'inherit',windowsHide:true,env});
child.on('exit',code=>{process.exitCode=code??1;});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
