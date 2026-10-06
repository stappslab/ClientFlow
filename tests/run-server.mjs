import {spawn} from 'node:child_process';
await import('./server.mjs');
const child=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5174','--strictPort'],{windowsHide:true,stdio:'ignore',env:{...process.env,VITE_EMULATORS:'true',VITE_SERVER_MODE:'true',VITE_APP_CHECK_SITE_KEY:'',VITE_PORTAL_ENDPOINT:'http://127.0.0.1:5001/demo-clientflow/europe-west3/clientPortal'}});
try{let ready=false;for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:5174')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}if(!ready)throw Error('Emulator browser server did not start.');await import('./browser-server.mjs');}finally{child.kill();await new Promise(r=>{if(child.exitCode!==null)r();else child.once('exit',r);});}
