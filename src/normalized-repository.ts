import {collection,doc,getDocs,onSnapshot,query,where,orderBy,limit,startAfter,type Unsubscribe,type QueryDocumentSnapshot} from 'firebase/firestore';
import {httpsCallable} from 'firebase/functions';
import {db,functions} from './firebase';
import {accountFor,emptyStore,type Account} from './cloud-model';
import {normalizeProject,uid,type Project,type Store,type Comment,type Task} from './domain';
import {projectPatch} from './patches';
import type {CloudWorkspace} from './repository';
export interface WorkspaceSubscription {close:Unsubscribe;select:(owner:string,id:string)=>void;thread:(task:string)=>void;moreComments:()=>Promise<void>;moreTasks:()=>Promise<void>}
export async function command<T=unknown>(name:string,payload:unknown):Promise<T>{if(typeof navigator!=='undefined'&&navigator.onLine===false)throw Error('You are offline. Reconnect before retrying this change.');const response=await httpsCallable(functions,name,{timeout:name==='restoreProject'||name==='migrateWorkspace'?310000:70000})(payload);return response.data as T;}
const commitIds=new WeakMap<Store,Map<string,string>>();
export function subscribeNormalized(userId:string,receive:(value:CloudWorkspace)=>void,fail:(error:Error)=>void):WorkspaceSubscription {
 let closed=false,account:Account|null=null,ownReady=false,membersReady=false,notifications:Store['notifications']=[];const projects=new Map<string,Project>(),stops:Unsubscribe[]=[],memberStops=new Map<string,Unsubscribe>();
 let active='',taskStop:Unsubscribe|undefined,commentStop:Unsubscribe|undefined,suggestionStop:Unsubscribe|undefined,thread='',taskLimit=1000,commentCursor:QueryDocumentSnapshot|undefined;
 const emit=()=>{if(!closed&&account&&ownReady&&membersReady)receive({store:{version:2,plan:account.plan,preferences:(account as Account&{preferences:Store['preferences']}).preferences,notifications,projects:[...projects.values()].sort((a,b)=>a.created-b.created)},revision:account.revision,schema:3});};
 const merge=(key:string,value:Project)=>{const existing=projects.get(key);projects.set(key,value.schema===3?{...value,id:key,ownerId:value.ownerId,loaded:existing?.loaded??false,tasks:existing?.tasks||[],comments:existing?.comments||[],suggestions:existing?.suggestions||[]}:normalizeProject(value));};
 stops.push(onSnapshot(doc(db,'accounts',userId),snapshot=>{account=snapshot.exists()?snapshot.data() as Account:accountFor(emptyStore(),0);emit();},fail));
 stops.push(onSnapshot(collection(db,'accounts',userId,'projects'),snap=>{const own=new Set<string>();snap.forEach(d=>{own.add(d.id);merge(d.id,d.data() as Project);});for(const [key,p] of projects)if(!p.ownerId&&!own.has(key))projects.delete(key);ownReady=true;emit();},fail));
 stops.push(onSnapshot(query(collection(db,'accounts',userId,'notifications'),orderBy('created','desc'),limit(50)),snap=>{notifications=snap.docs.map(d=>d.data() as Store['notifications'][number]);emit();},fail));
 const awaitingMembers=new Set<string>();
 stops.push(onSnapshot(collection(db,'users',userId,'memberships'),snap=>{const present=new Set<string>();for(const d of snap.docs){const m=d.data(),key=`${m.owner}:${m.projectId}`;present.add(key);if(!memberStops.has(key)){awaitingMembers.add(key);memberStops.set(key,onSnapshot(doc(db,'accounts',m.owner,'projects',m.projectId),p=>{if(p.exists())merge(key,{...p.data(),ownerId:m.owner} as Project);else projects.delete(key);awaitingMembers.delete(key);membersReady=!awaitingMembers.size;emit();},()=>{projects.delete(key);awaitingMembers.delete(key);membersReady=!awaitingMembers.size;emit();}));}}for(const [key,stop] of memberStops)if(!present.has(key)){stop();memberStops.delete(key);awaitingMembers.delete(key);projects.delete(key);}membersReady=!awaitingMembers.size;emit();},fail));
 function threadListener(){commentStop?.();commentCursor=undefined;if(!active)return;const [owner,id]=active.split(':');commentStop=onSnapshot(query(collection(db,'accounts',owner,'projects',id,'comments'),where('task','==',thread),orderBy('created','desc'),limit(50)),snap=>{const p=projects.get(owner===userId?id:active);if(!p)return;const incoming=snap.docs.map(d=>d.data() as Comment);const ids=new Set(incoming.map(c=>c.id));p.comments=[...p.comments.filter(c=>c.task!==thread||!ids.has(c.id)),...incoming.reverse()];commentCursor=snap.docs.at(-1);emit();},fail);}
 function taskListener(){taskStop?.();if(!active)return;const [owner,id]=active.split(':'),index=owner===userId?id:active;taskStop=onSnapshot(query(collection(db,'accounts',owner,'projects',id,'tasks'),orderBy('number'),limit(taskLimit)),snap=>{const p=projects.get(index);if(!p)return;p.tasks=snap.docs.map(d=>d.data() as Task);p.loaded=true;emit();},fail);}
 return {
  close:()=>{closed=true;stops.forEach(s=>s());memberStops.forEach(s=>s());taskStop?.();commentStop?.();suggestionStop?.();},
  select:(owner,id)=>{const key=`${owner}:${id}`;if(active===key)return;active=key;taskStop?.();commentStop?.();suggestionStop?.();taskLimit=1000;const index=owner===userId?id:key;if(!projects.get(index)||projects.get(index)?.schema!==3)return;
   taskListener();
   suggestionStop=onSnapshot(query(collection(db,'accounts',owner,'projects',id,'suggestions'),limit(100)),snap=>{const p=projects.get(index);if(p){p.suggestions=snap.docs.map(d=>d.data() as Project['suggestions'][number]);emit();}},fail);threadListener();
  },
  thread:task=>{thread=task;threadListener();},
  moreComments:async()=>{if(!active||!commentCursor)return;const [owner,id]=active.split(':'),p=projects.get(owner===userId?id:active);const snap=await getDocs(query(collection(db,'accounts',owner,'projects',id,'comments'),where('task','==',thread),orderBy('created','desc'),startAfter(commentCursor),limit(50)));if(p){const ids=new Set(p.comments.map(c=>c.id));p.comments.push(...snap.docs.map(d=>d.data() as Comment).filter(c=>!ids.has(c.id)));commentCursor=snap.docs.at(-1);emit();}},
  moreTasks:async()=>{if(!active)return;taskLimit+=500;taskListener();}
 };
}
export async function commitNormalized(userId:string,before:CloudWorkspace,next:Store):Promise<number> {
 if(next.plan!==before.store.plan)throw Error('Plans are controlled by the server.');
 let ids=commitIds.get(next);if(!ids){ids=new Map();commitIds.set(next,ids);}
 for(const p of next.projects){const old=before.store.projects.find(x=>x.id===p.id);if(JSON.stringify(old)===JSON.stringify(p))continue;const projectId=p.ownerId?p.id.split(':').at(-1)!:p.id;const previous=old?{...old,id:projectId}:undefined;if(!ids.has(p.id))ids.set(p.id,uid());await command('projectCommand',{owner:p.ownerId||userId,projectId,requestId:ids.get(p.id),patch:projectPatch(previous,{...p,id:projectId})});}
 if(JSON.stringify(next.preferences)!==JSON.stringify(before.store.preferences)&&next.preferences)await command('accountCommand',{action:'preferences',preferences:next.preferences});
 for(const n of next.notifications)if(n.read&&!before.store.notifications.find(x=>x.id===n.id)?.read)await command('accountCommand',{action:'readNotification',id:n.id});
 return before.revision;
}
