import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
const port=5173;
const check=createServer();
check.once('error',()=>{console.error('Port 5173 is occupied. Run npm run dev -- --port 5174.');process.exitCode=1;});
check.listen(port,'127.0.0.1',()=>{check.close(()=>{const child=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort'],{detached:true,stdio:'ignore',windowsHide:true});child.unref();console.log('ClientFlow: http://127.0.0.1:5173 (PID '+child.pid+')');});});
