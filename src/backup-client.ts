import {command} from './normalized-repository';
import {BACKUP_MAX_BYTES,validateBackup} from './backup';
import {uid,type Project,type Store} from './domain';
import {auth} from './firebase';
const restoreSessions=new Map<string,{id:string;uploaded:number[];created:number}>();
export async function exportProject(p:Project,userId:string):Promise<Project>{
 const owner=p.ownerId||userId,projectId=p.ownerId?p.id.split(':').at(-1)!:p.id;
 const first=await command<{project:Project;revision:string}>('exportProject',{owner,projectId});
 const result={...first.project,tasks:[],comments:[],suggestions:[]} as Project;
 for(const kind of ['tasks','comments','suggestions'] as const){let after='';do{const page=await command<{items:any[];next:string}>('exportProject',{owner,projectId,kind,after,revision:first.revision});(result[kind] as any[]).push(...page.items);after=page.next;}while(after);}
 await command('exportProject',{owner,projectId,revision:first.revision});validateBackup(result);return result;
}
export async function exportWorkspace(store:Store,userId:string){const projects:Project[]=[];for(const p of store.projects)if(!p.ownerId)projects.push(await exportProject(p,userId));return {format:'clientflow-workspace',version:1,exportedAt:new Date().toISOString(),projects,preferences:store.preferences};}
export async function restoreCloud(backup:unknown):Promise<string>{
 const value=validateBackup(backup),json=JSON.stringify(value);if(new TextEncoder().encode(json).length>BACKUP_MAX_BYTES)throw Error('Backup exceeds 20 MB.');
 const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(json)))].map(b=>b.toString(16).padStart(2,'0')).join(''),key=`clientflow.restore.${auth.currentUser?.uid}.${digest}`;
 let session=restoreSessions.get(key);if(!session){try{session=JSON.parse(sessionStorage.getItem(key)||'null');}catch{}}
 if(!session||Date.now()-session.created>=86400000)session={id:uid(),uploaded:[],created:Date.now()};restoreSessions.set(key,session);
 const chunks=[];for(let i=0;i<json.length;i+=150000)chunks.push(json.slice(i,i+150000));
 for(let index=0;index<chunks.length;index++)if(!session.uploaded.includes(index)){await command('restoreProject',{restoreId:session.id,action:'upload',index,total:chunks.length,chunk:chunks[index]});session.uploaded.push(index);try{sessionStorage.setItem(key,JSON.stringify(session));}catch{}}
 const result=await command<{projectId:string}>('restoreProject',{restoreId:session.id,action:'finish'});restoreSessions.delete(key);try{sessionStorage.removeItem(key);}catch{}return result.projectId;
}
