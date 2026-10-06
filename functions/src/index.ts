import {initializeApp} from 'firebase-admin/app';
import {getFirestore,FieldValue,Timestamp} from 'firebase-admin/firestore';
import {onCall,onRequest,HttpsError} from 'firebase-functions/v2/https';
import {onSchedule} from 'firebase-functions/v2/scheduler';
import {defineSecret,defineString,defineBoolean} from 'firebase-functions/params';
import {createHash,randomBytes} from 'node:crypto';
import nodemailer from 'nodemailer';
import {normalizeProject,makeProject,publicProject,changePlan,type Project,type Store,type Task,type Comment,type Suggestion} from '../../src/domain.ts';
import type {ProjectPatch} from '../../src/patches.ts';
import {BACKUP_MAX_BYTES,restoredProject} from '../../src/backup.ts';
import {processEmailItem} from './email.ts';

initializeApp();
const db=getFirestore(),region='europe-west3';
const smtp=defineSecret('SMTP_URL'),from=defineString('EMAIL_FROM',{default:''}),origin=defineString('APP_ORIGIN',{default:'http://127.0.0.1:5173'});
const enforceAppCheck=defineBoolean('ENFORCE_APP_CHECK',{default:false});
const runtime={region,maxInstances:3,timeoutSeconds:60,memory:'256MiB' as const,concurrency:20};
const options={...runtime,enforceAppCheck};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const clean=(value:unknown,max:number)=>{if(typeof value!=='string'||value.length>max)throw new HttpsError('invalid-argument','Invalid text length.');return value.trim();};
const identifier=(value:unknown)=>{const s=clean(value,100);if(!/^[A-Za-z0-9_-]+$/.test(s))throw new HttpsError('invalid-argument','Invalid identifier.');return s;};
const fail=(message:string):never=>{throw new HttpsError('permission-denied',message);};
function identity(request:any,verified=false):string {if(!request.auth)fail('Sign in first.');if(verified&&!request.auth.token.email_verified)fail('Verify your email before sharing or inviting.');return request.auth.uid;}
function admin(request:any){identity(request);if(!request.auth.token.admin||!request.auth.token.firebase?.sign_in_second_factor)fail('Administrator access requires MFA.');}
function projectRef(owner:string,id:string){return db.doc(`accounts/${owner}/projects/${id}`);}
async function consume(operation:string,keys:string[],limit:number,seconds=60){
 const control=await db.doc('operations/control').get();if(control.data()?.disabled?.includes(operation))throw new HttpsError('unavailable','This operation is temporarily unavailable.');
 const slot=Math.floor(Date.now()/1000/seconds);const refs=keys.map(k=>db.doc(`rateLimits/${hash(operation+':'+k+':'+slot)}`));
 await db.runTransaction(async tx=>{const docs=await tx.getAll(...refs);if(docs.some(d=>(d.data()?.count||0)>=limit))throw new HttpsError('resource-exhausted',`Try again in ${seconds} seconds.`,{retryAfter:seconds});docs.forEach((d,i)=>tx.set(refs[i],{count:(d.data()?.count||0)+1,expiresAt:Timestamp.fromMillis((slot+2)*seconds*1000)}));});
}
function countTask(t:Task|undefined,columns:Project['columns']) {const done=!!t&&columns.some(c=>c.id===t.column&&c.done);return {total:t&&!t.deletedAt?1:0,done:t&&!t.deletedAt&&done?1:0,publicTotal:t?.visible&&!t.deletedAt?1:0,publicDone:t?.visible&&!t.deletedAt&&done?1:0};}
function publicTask(t:Task){return {id:t.id,title:t.title,column:t.column,number:t.number,rank:t.rank};}
function publicHeader(p:Project,pro=false){return {name:p.name,status:p.status,guestComments:p.guestComments&&!p.frozen,columns:p.columns.filter(c=>(p.publicColumnCounts?.[c.id]||0)>0).map(c=>({id:c.id,name:c.publicName||c.name,color:c.color,done:c.done})),counts:{done:p.counts?.publicDone||0,total:p.counts?.publicTotal||0},...(p.branding&&pro?{branding:p.branding}:{})};}
function summary(p:Project){const {tasks,comments,suggestions,...rest}=p;return {...rest,schema:3,revision:p.revision||0,taskSequence:p.taskSequence||0,counts:p.counts||{total:0,done:0,publicTotal:0,publicDone:0}};}
async function migrate(owner:string){
 const projects=await db.collection(`accounts/${owner}/projects`).get();
 for(const snapshot of projects.docs){const old=snapshot.data();if(old.schema===3)continue;
  const lock=db.doc(`migrationLocks/${owner}_${snapshot.id}`);
  await db.runTransaction(async tx=>{const l=await tx.get(lock);if((l.data()?.until||0)>Date.now())throw new HttpsError('unavailable','Workspace migration is in progress. Retry shortly.');tx.set(lock,{until:Date.now()+600000});});
  try {const current=await snapshot.ref.get();if(current.data()?.schema===3)continue;
   const p=normalizeProject(current.data() as Project),writes:{path:string;value:unknown}[]=[];
   // Retain the untouched legacy document for recovery; writes stay blocked until schema 3.
   await db.doc(`accounts/${owner}/migrationBackups/${p.id}`).set(current.data()!);
   for(const kind of ['tasks','comments','suggestions'] as const)for(const item of p[kind])writes.push({path:`${snapshot.ref.path}/${kind}/${item.id}`,value:item});
   const visible=new Set(p.tasks.filter(t=>t.visible&&!t.deletedAt).map(t=>t.id));
   p.publicColumnCounts={};for(const t of p.tasks)if(visible.has(t.id)){p.publicColumnCounts[t.column]=(p.publicColumnCounts[t.column]||0)+1;writes.push({path:`publicProjects/${owner}_${p.id}/tasks/${t.id}`,value:publicTask(t)});}
   for(const c of p.comments)if(c.audience==='client'&&!c.moderated&&(!c.task||visible.has(c.task)))writes.push({path:`publicProjects/${owner}_${p.id}/comments/${c.id}`,value:{id:c.id,task:c.task,author:c.author,content:c.content,created:c.created,guest:!!c.guest}});
   for(let i=0;i<writes.length;i+=350){const batch=db.batch();writes.slice(i,i+350).forEach(w=>batch.set(db.doc(w.path),w.value as any));await batch.commit();}
   p.counts=p.tasks.reduce((a,t)=>{const c=countTask(t,p.columns);for(const k of Object.keys(a) as (keyof typeof a)[])a[k]+=c[k];return a;},{total:0,done:0,publicTotal:0,publicDone:0});
   await db.doc(`publicProjects/${owner}_${p.id}`).set(publicHeader(p,(await db.doc(`accounts/${owner}`).get()).data()?.plan==='pro'));
   await snapshot.ref.set(summary(p));
  }finally{await lock.delete();}
 }
 const account=db.doc(`accounts/${owner}`);await db.runTransaction(async tx=>{const a=await tx.get(account);if(a.exists)tx.update(account,{schema:3});});
}
export const migrateWorkspace=onCall({...options,timeoutSeconds:300},async request=>{
 const owner=identity(request),account=await db.doc(`accounts/${owner}`).get();if(!account.exists||account.data()?.schema===3)return {schema:3};await consume('migrate',[owner],4,600);
 const lock=db.doc(`workspaceMigrationLocks/${owner}`);await db.runTransaction(async tx=>{const l=await tx.get(lock);if(l.data()?.until>Date.now())throw new HttpsError('unavailable','Workspace migration is in progress.');tx.set(lock,{until:Date.now()+600000});});
 try{await migrate(owner);return {schema:3};}finally{await lock.delete();}
});

export const exportProject=onCall(options,async request=>{
 const uid=identity(request),owner=identifier(request.data.owner||uid),id=identifier(request.data.projectId);await consume('export',[uid],300,600);
 const ref=projectRef(owner,id),doc=await ref.get(),p=doc.data() as Project;
 if(!p||uid!==owner&&!p.members.some(m=>m.uid===uid))fail('Project unavailable.');
 if(p.schema!==3)throw new HttpsError('failed-precondition','Migrate before exporting.');
 const revision=`${doc.updateTime?.seconds}.${doc.updateTime?.nanoseconds}`;
 if(request.data.revision&&revision!==request.data.revision)throw new HttpsError('aborted','Project changed during export. Retry the export.');
 if(!request.data.kind)return {project:{...p,tasks:[],comments:[],suggestions:[]},revision};
 const kind=request.data.kind;if(!['tasks','comments','suggestions'].includes(kind))throw new HttpsError('invalid-argument','Invalid export collection.');
 let query=ref.collection(kind).orderBy('__name__').limit(200);if(request.data.after)query=query.startAfter(identifier(request.data.after));const page=await query.get();
 return {items:page.docs.map(d=>d.data()),next:page.size===200?page.docs.at(-1)!.id:''};
});

export const restoreProject=onCall({...options,timeoutSeconds:300},async request=>{
 const uid=identity(request,true),restoreId=identifier(request.data.restoreId),job=db.doc(`restoreJobs/${uid}_${restoreId}`);await consume('restore',[uid],200,600);
 if(request.data.action==='upload'){
  const {index,total}=request.data,chunk=cleanChunk(request.data.chunk);
  if(!Number.isInteger(total)||total<1||total>140||!Number.isInteger(index)||index<0||index>=total)throw new HttpsError('invalid-argument','Invalid backup upload.');
  await db.runTransaction(async tx=>{const part=job.collection('chunks').doc(String(index)),[existing,page]=await tx.getAll(job,part),v=existing.data();
   if(v&&v.status!=='uploading'||v&&v.total!==total)throw new HttpsError('failed-precondition','Restore upload is closed.');
   if(page.exists){if(page.data()?.hash!==hash(chunk))throw new HttpsError('already-exists','Upload page already exists.');return;}
   const bytes=(v?.bytes||0)+Buffer.byteLength(chunk);if(bytes>BACKUP_MAX_BYTES)throw new HttpsError('resource-exhausted','Backup exceeds 20 MB.');
   tx.set(part,{chunk,hash:hash(chunk),expiresAt:Timestamp.fromMillis(Date.now()+86400000)});tx.set(job,{uid,total,bytes,status:'uploading',received:(v?.received||0)+1,expiresAt:Timestamp.fromMillis(Date.now()+86400000)});
  });return {uploaded:true};
 }
 if(request.data.action!=='finish')throw new HttpsError('invalid-argument','Invalid restore action.');
 const state=await db.runTransaction(async tx=>{const s=await tx.get(job),v=s.data();if(!v||v.received!==v.total)throw new HttpsError('failed-precondition','Backup upload is incomplete.');if(v.status==='complete')return v;if(v.until>Date.now())throw new HttpsError('unavailable','Restore is in progress.');tx.update(job,{status:'restoring',until:Date.now()+600000});return v;});
 if(state.status==='complete')return {projectId:state.projectId};
 try {
  const parts=await job.collection('chunks').get(),json=parts.docs.sort((a,b)=>Number(a.id)-Number(b.id)).map(d=>d.data().chunk).join('');
  let counter=0;const p=restoredProject(JSON.parse(json),{uid,name:request.auth!.token.name||'Project owner',email:request.auth!.token.email||''},restoreId,()=>hash(restoreId+':'+counter++));
  p.counts={total:0,done:0,publicTotal:0,publicDone:0};p.publicColumnCounts={};const writes:{path:string;value:any}[]=[];
  const ref=projectRef(uid,p.id);if((await ref.get()).exists)throw new HttpsError('already-exists','Restore destination already exists.');
  for(const kind of ['tasks','comments','suggestions'] as const)for(const item of p[kind])writes.push({path:`${ref.path}/${kind}/${item.id}`,value:item});
  const visible=new Set<string>();for(const t of p.tasks){const c=countTask(t,p.columns);for(const k of Object.keys(p.counts) as (keyof typeof c)[])p.counts[k]+=c[k];if(t.visible&&!t.deletedAt){visible.add(t.id);p.publicColumnCounts[t.column]=(p.publicColumnCounts[t.column]||0)+1;writes.push({path:`publicProjects/${uid}_${p.id}/tasks/${t.id}`,value:publicTask(t)});}}
  for(const c of p.comments)if(c.audience==='client'&&!c.moderated&&(!c.task||visible.has(c.task)))writes.push({path:`publicProjects/${uid}_${p.id}/comments/${c.id}`,value:{id:c.id,task:c.task,author:c.author,content:c.content,created:c.created,guest:!!c.guest}});
  for(let i=0;i<writes.length;i+=350){const batch=db.batch();writes.slice(i,i+350).forEach(w=>batch.set(db.doc(w.path),w.value));await batch.commit();}
  await db.runTransaction(async tx=>{const accountRef=db.doc(`accounts/${uid}`),[a,destination]=await tx.getAll(accountRef,ref);if(destination.exists)throw new HttpsError('already-exists','Restore destination already exists.');if(!a.exists)tx.set(accountRef,{schema:3,plan:'free',revision:1,activeProjectId:'',notifications:[]});tx.set(ref,summary(p));tx.set(db.doc(`publicProjects/${uid}_${p.id}`),publicHeader(p));tx.update(job,{status:'complete',until:0,projectId:p.id});tx.set(db.doc(`restoreAudit/${uid}_${restoreId}`),{uid,projectId:p.id,sourceHash:hash(json),bytes:state.bytes,createdAt:Timestamp.now()});});
  await db.recursiveDelete(job.collection('chunks')).catch(()=>{});return {projectId:p.id};
 }catch(e){if((await job.get()).data()?.status!=='complete')await job.update({status:'uploading',until:0});if(e instanceof HttpsError)throw e;throw new HttpsError('invalid-argument',e instanceof Error?e.message:'Invalid backup.');}
});
function cleanChunk(value:unknown){if(typeof value!=='string'||value.length>150000)throw new HttpsError('invalid-argument','Invalid upload page.');return value;}

export const projectCommand=onCall(options,async request=>{
 const uid=identity(request),owner=identifier(request.data.owner||uid),id=identifier(request.data.projectId),requestId=identifier(request.data.requestId),patch=request.data.patch as ProjectPatch;
 if(!patch||!Array.isArray(patch.tasks)||!Array.isArray(patch.comments)||!Array.isArray(patch.suggestions)||patch.tasks.length+patch.comments.length+patch.suggestions.length>100)throw new HttpsError('invalid-argument','Command is too large.');
 await consume('write',[uid],120);const ref=projectRef(owner,id),accountRef=db.doc(`accounts/${owner}`),receipt=db.doc(`commandReceipts/${hash(uid+requestId)}`);
 return db.runTransaction(async tx=>{
  const [accountDoc,projectDoc,receiptDoc]=await tx.getAll(accountRef,ref,receipt);
  if(receiptDoc.exists)return receiptDoc.data()!.result;
  const account=accountDoc.data()||{plan:'free',activeProjectId:'',revision:0},old=projectDoc.exists?projectDoc.data() as Project:undefined;
  if(old&&old.schema!==3)throw new HttpsError('failed-precondition','Migrate this workspace before editing.');
  const isOwner=uid===owner,member=old?.members.find(m=>m.uid===uid);
  if(!isOwner&&!member)fail('You are not a member of this project.');
  if(old&&(old.status!=='active'||old.frozen&&account.plan!=='pro')){
   if(!isOwner||Object.keys(patch.metadata).some(k=>k!=='status')||patch.tasks.length||patch.comments.length||patch.suggestions.length)fail('This project is read-only.');
   if(old.frozen&&account.plan!=='pro')fail('Renew Pro to reactivate this frozen project.');
  }
  if(!isOwner&&(!member?.collaborating||Object.keys(patch.metadata).length))fail('Only the owner can change project settings.');
  if(!old&&!isOwner)fail('Only an owner can create a project.');
  const metadataKeys=['id','name','description','status','created','columns','members','sprints','guestComments','branding'];
  if(Object.keys(patch.metadata).some(k=>!metadataKeys.includes(k)))throw new HttpsError('invalid-argument','Unsupported project setting.');
  if(old&&Object.keys(patch.metadata).length&&(old.revision||0)!==patch.revision)throw new HttpsError('aborted','Project settings changed. Reload and retry.');
  const p={...(old||makeProject('New project')),...patch.metadata,id} as Project;
  p.name=clean(p.name,100);p.description=clean(p.description,8000);if(!p.name||!['active','completed','archived'].includes(p.status)||typeof p.guestComments!=='boolean'||!Array.isArray(p.columns)||p.columns.length<1||p.columns.length>40||!Array.isArray(p.members)||!Array.isArray(p.sprints))throw new HttpsError('invalid-argument','Invalid project.');
  if(old&&p.created!==old.created)fail('Creation date cannot change.');if(!old)p.created=Date.now();
  if(p.branding&&account.plan!=='pro')fail('Custom branding requires Pro.');
  if(p.branding){p.branding.name=clean(p.branding.name,80);if(!/^#[0-9a-f]{6}$/i.test(p.branding.color))throw new HttpsError('invalid-argument','Invalid brand color.');}
  const columnIds=new Set<string>();for(const c of p.columns){if(Object.keys(c).some(k=>!['id','name','publicName','color','done','limit'].includes(k)))throw new HttpsError('invalid-argument','Invalid column fields.');identifier(c.id);c.name=clean(c.name,60);c.publicName=clean(c.publicName||'',60);if(!c.name||columnIds.has(c.id)||!/^#[0-9a-f]{6}$/i.test(c.color)||typeof c.done!=='boolean'||!Number.isInteger(c.limit)||c.limit<0||c.limit>999)throw new HttpsError('invalid-argument','Invalid column.');columnIds.add(c.id);}
  if(p.members.filter(m=>m.id==='owner').length!==1||!p.members.find(m=>m.id==='owner')?.collaborating)fail('Keep the project owner.');
  if(old&&JSON.stringify(p.members.map(m=>({id:m.id,uid:m.uid,email:m.email})))!==JSON.stringify(old.members.map(m=>({id:m.id,uid:m.uid,email:m.email}))))fail('Use invitations to add real members.');
  if(!old){p.members=[{id:'owner',uid:owner,name:clean(request.auth!.token.name||'Project owner',80),email:request.auth!.token.email||'',collaborating:true}];}
  for(const m of p.members){if(m.role&&!['member','editor'].includes(m.role)||typeof m.collaborating!=='boolean'||m.ownStatus!==undefined&&typeof m.ownStatus!=='boolean')throw new HttpsError('invalid-argument','Invalid member permission.');}
  if(account.plan==='free'&&p.members.filter(m=>m.collaborating).length>5)fail('Free allows five collaborating members, including the owner.');
  const slot=account.activeProjectId||'';
  if(p.status==='active'&&account.plan==='free'&&!p.frozen&&slot&&slot!==id)fail('Free allows one active project.');
  const entityRefs=[...patch.tasks.map(x=>ref.collection('tasks').doc(identifier(x.id))),...patch.comments.map(x=>ref.collection('comments').doc(identifier(x.id))),...patch.suggestions.map(x=>ref.collection('suggestions').doc(identifier(x.id)))];
  const entityDocs=entityRefs.length?await tx.getAll(...entityRefs):[];let cursor=0;
  let counts={...(old?.counts||{total:0,done:0,publicTotal:0,publicDone:0})},sequence=old?.taskSequence||0;
  let publicColumnCounts={...(old?.publicColumnCounts||{})};
  const changedTasks=new Map<string,Task>();const taskWrites:{ref:any;task:Task}[]=[],commentWrites:{ref:any;comment:Comment}[]=[],suggestionWrites:{ref:any;suggestion:Suggestion}[]=[];
  for(const change of patch.tasks){const snap=entityDocs[cursor++],previous=snap.exists?snap.data() as Task:undefined;
   if((previous?.revision??-1)!==(change.before?.revision??-1))throw new HttpsError('aborted','This task changed. Reload it before retrying.');
   const t=change.after;const keys=['id','title','description','column','priority','deadline','assignee','visible','sprint','revision','number','rank','deletedAt'];
   if(!t||Object.keys(t).some(k=>!keys.includes(k))||t.id!==change.id)throw new HttpsError('invalid-argument','Invalid task fields.');
   if(!isOwner&&member?.role!=='editor'){
    if(!previous||!member?.ownStatus||previous.assignee!==member.id||Object.keys(t).some(k=>!['column','rank','revision'].includes(k)&&JSON.stringify((t as any)[k])!==JSON.stringify((previous as any)[k])))fail('You can only change the status of your assigned task.');
   }
   t.title=clean(t.title,160);t.description=clean(t.description,8000);
   if(!t.title||!columnIds.has(t.column)||!['Low','Medium','High','Urgent'].includes(t.priority)||typeof t.visible!=='boolean'||!Number.isFinite(t.rank)||typeof t.deadline!=='string'||typeof t.assignee!=='string'||typeof t.sprint!=='string'||t.deletedAt!==undefined&&(typeof t.deletedAt!=='string'||!Number.isFinite(Date.parse(t.deletedAt)))||t.deadline&&!/^\d{4}-\d{2}-\d{2}$/.test(t.deadline)||t.assignee&&!p.members.some(m=>m.id===t.assignee)&&t.assignee!==previous?.assignee||t.sprint&&!p.sprints.some(s=>s.id===t.sprint))throw new HttpsError('invalid-argument','Invalid task.');
   t.revision=(previous?.revision??-1)+1;t.number=previous?.number||++sequence;
   const a=countTask(previous,old?.columns||p.columns),b=countTask(t,p.columns);for(const k of Object.keys(counts) as (keyof typeof counts)[])counts[k]+=b[k]-a[k];
   if(previous?.visible&&!previous.deletedAt)publicColumnCounts[previous.column]=(publicColumnCounts[previous.column]||0)-1;
   if(t.visible&&!t.deletedAt)publicColumnCounts[t.column]=(publicColumnCounts[t.column]||0)+1;
   changedTasks.set(t.id,t);taskWrites.push({ref:snap.ref,task:t});
  }
  // Only column changes need a full task scan; ordinary writes read their own task.
  if(old&&JSON.stringify(old.columns)!==JSON.stringify(p.columns)){
   const all=await tx.get(ref.collection('tasks'));counts={total:0,done:0,publicTotal:0,publicDone:0};
   const tasks=new Map(all.docs.map(d=>[d.id,d.data() as Task]));changedTasks.forEach((t,id)=>tasks.set(id,t));
   publicColumnCounts={};for(const t of tasks.values()){if(!columnIds.has(t.column)&&!t.deletedAt)throw new HttpsError('failed-precondition','Move tasks before deleting their column.');const c=countTask(t,p.columns);for(const k of Object.keys(counts) as (keyof typeof counts)[])counts[k]+=c[k];if(t.visible&&!t.deletedAt)publicColumnCounts[t.column]=(publicColumnCounts[t.column]||0)+1;}
  }
  for(const change of patch.comments){const snap=entityDocs[cursor++],previous=snap.exists?snap.data() as Comment:undefined,c=change.after;
   if(Object.keys(c).some(k=>!['id','task','author','content','audience','created','guest','awaitingReply','moderated'].includes(k)))throw new HttpsError('invalid-argument','Unsupported comment field.');
   if(previous){if(!isOwner||Object.keys(c).some(k=>k!=='moderated'&&JSON.stringify((c as any)[k])!==JSON.stringify((previous as any)[k])))fail('Only the owner can moderate an existing comment.');}
   else {c.author=isOwner?request.auth!.token.name||'Project owner':member!.name;c.created=new Date().toISOString();c.guest=false;c.awaitingReply=false;}
   c.content=clean(c.content,4000);if(c.id!==change.id||!c.content||!['internal','client'].includes(c.audience))throw new HttpsError('invalid-argument','Invalid comment.');
   if(c.task){const task=changedTasks.get(c.task)||(await tx.get(ref.collection('tasks').doc(identifier(c.task)))).data() as Task|undefined;if(!task||task.deletedAt||c.audience==='client'&&!task.visible)fail('Task is not available for this conversation.');}
   commentWrites.push({ref:snap.ref,comment:c});
  }
  for(const change of patch.suggestions){const snap=entityDocs[cursor++],previous=snap.exists?snap.data() as Suggestion:undefined,s=change.after;
   if(Object.keys(s).some(k=>!['id','task','author','changes','reason','revision','status'].includes(k)))throw new HttpsError('invalid-argument','Unsupported suggestion field.');
   if(s.id!==change.id||!['pending','accepted','rejected'].includes(s.status)||Object.keys(s.changes).some(k=>!['title','description','column','priority','deadline','assignee','sprint','visible'].includes(k)))throw new HttpsError('invalid-argument','Invalid suggestion.');
   s.reason=clean(s.reason,2000);
   if(previous){if(!isOwner||JSON.stringify({...s,status:previous.status})!==JSON.stringify(previous))fail('Only the owner can decide a suggestion.');if(previous.status!=='pending')throw new HttpsError('failed-precondition','Suggestion was already decided.');
    const before=patch.tasks.find(t=>t.id===s.task)?.before||(await tx.get(ref.collection('tasks').doc(identifier(s.task)))).data() as Task|undefined;
    if(s.status==='accepted'&&(!before||before.revision!==s.revision||!changedTasks.has(s.task)||Object.entries(s.changes).some(([key,v])=>JSON.stringify((changedTasks.get(s.task) as any)[key])!==JSON.stringify(v))))throw new HttpsError('aborted','Suggestion conflicts with the current task.');
   }else {if(s.status!=='pending')fail('New suggestions must be pending.');const t=(await tx.get(ref.collection('tasks').doc(identifier(s.task)))).data();if(!t||t.deletedAt||t.revision!==s.revision)throw new HttpsError('aborted','Task changed. Reload it.');s.author=isOwner?request.auth!.token.name||'Project owner':member!.name;}
   suggestionWrites.push({ref:snap.ref,suggestion:s});
  }
  const replies=commentWrites.filter(w=>w.comment.audience==='client'&&!w.comment.guest);
  const awaiting=replies.length?await tx.get(ref.collection('comments').where('awaitingReply','==',true).limit(100)):null;
  p.revision=(old?.revision||0)+(Object.keys(patch.metadata).length?1:0);p.counts=counts;p.taskSequence=sequence;p.publicColumnCounts=publicColumnCounts;
  const summaryUpdates:Record<string,unknown>={counts,taskSequence:sequence,publicColumnCounts};if(Object.keys(patch.metadata).length){Object.assign(summaryUpdates,patch.metadata,{revision:p.revision});}
  if(old)tx.update(ref,summaryUpdates);else tx.set(ref,summary(p));
  if(!accountDoc.exists)tx.set(accountRef,{plan:'free',schema:3,revision:1,activeProjectId:p.status==='active'?id:'',notifications:[]});
  else if(account.plan==='free'&&((p.status==='active'&&!p.frozen&&!slot)||(p.status!=='active'&&slot===id)))tx.update(accountRef,{activeProjectId:p.status==='active'?id:'',revision:FieldValue.increment(1)});
  for(const {ref:taskRef,task:t} of taskWrites){tx.set(taskRef,t);const pub=db.doc(`publicProjects/${owner}_${id}/tasks/${t.id}`);if(t.visible&&!t.deletedAt)tx.set(pub,publicTask(t));else tx.delete(pub);}
  for(const {ref:commentRef,comment:c} of commentWrites){tx.set(commentRef,c);const pub=db.doc(`publicProjects/${owner}_${id}/comments/${c.id}`);if(c.audience==='client'&&!c.moderated)tx.set(pub,{id:c.id,task:c.task,author:c.author,content:c.content,guest:!!c.guest,created:c.created});else tx.delete(pub);}
  for(const {ref:suggestionRef,suggestion:s} of suggestionWrites)tx.set(suggestionRef,s);
  awaiting?.docs.filter(d=>replies.some(r=>r.comment.task===d.data().task)).forEach(d=>tx.update(d.ref,{awaitingReply:false}));
  const notifications:{target:string;text:string;task:string;immediate:boolean}[]=[];
  for(const w of taskWrites){const previous=patch.tasks.find(t=>t.id===w.task.id)?.before;if(w.task.assignee&&w.task.assignee!==previous?.assignee){const target=p.members.find(m=>m.id===w.task.assignee)?.uid;if(target)notifications.push({target,text:'A task was assigned to you',task:w.task.id,immediate:true});}}
  if(commentWrites.some(w=>!w.comment.moderated))notifications.push({target:owner,text:'New project conversation',task:commentWrites[0].comment.task,immediate:false});
  for(const w of suggestionWrites){const target=w.suggestion.status==='pending'?owner:old?.members.find(m=>m.name===w.suggestion.author)?.uid;if(target)notifications.push({target,text:w.suggestion.status==='pending'?'New change suggestion':`Suggestion ${w.suggestion.status}`,task:w.suggestion.task,immediate:false});}
  for(let i=0;i<notifications.length;i++){const n=notifications[i],key=hash(uid+requestId+i);tx.set(db.doc(`accounts/${n.target}/notifications/${key}`),{id:key,text:n.text,projectId:owner===n.target?id:`${owner}:${id}`,taskId:n.task,read:false,created:new Date().toISOString()});if(n.immediate)tx.set(db.doc(`emailOutbox/${key}`),{uid:n.target,projectId:owner===n.target?id:`${owner}:${id}`,subject:n.text,immediate:true,to:null,url:null,status:'pending',created:Timestamp.now(),attempts:0});}
  const pubRef=db.doc(`publicProjects/${owner}_${id}`);
  tx.set(pubRef,publicHeader(p,account.plan==='pro'));
  const result={revision:p.revision};tx.set(receipt,{uid,result,expiresAt:Timestamp.fromMillis(Date.now()+86400000)});
  return result;
 });
});

export const shareProject=onCall(options,async request=>{
 const uid=identity(request,true),id=identifier(request.data.projectId);await consume('share',[uid],10,600);
 const pRef=projectRef(uid,id),token=randomBytes(32).toString('base64url'),ref=db.doc(`portalTokens/${hash(token)}`);
 const raw=request.data.action;if(!['rotate','revoke'].includes(raw))throw new HttpsError('invalid-argument','Invalid sharing action.');
 if(request.data.expiresDays!==undefined&&(!Number.isInteger(request.data.expiresDays)||request.data.expiresDays<1||request.data.expiresDays>365))throw new HttpsError('invalid-argument','Expiration must be 1–365 days.');
 await db.runTransaction(async tx=>{const pDoc=await tx.get(pRef);if(!pDoc.exists)fail('Project unavailable.');const p=pDoc.data() as Project;
  const old=await tx.get(db.doc(`portalOwners/${uid}_${id}`));
  if(raw==='revoke'){if(old.data()?.hash)tx.delete(db.doc(`portalTokens/${old.data()!.hash}`));tx.delete(db.doc(`portalOwners/${uid}_${id}`));return;}
  if(p.schema!==3)throw new HttpsError('failed-precondition','Migrate before sharing.');
  if(!p.publicColumnCounts)throw new HttpsError('failed-precondition','Public projection is not ready.');
  if(old.data()?.hash)tx.delete(db.doc(`portalTokens/${old.data()!.hash}`));
  tx.set(ref,{owner:uid,projectId:id,createdAt:Timestamp.now(),expiresAt:request.data.expiresDays?Timestamp.fromMillis(Date.now()+Math.min(365,Math.max(1,Number(request.data.expiresDays)))*86400000):null});
  tx.set(db.doc(`portalOwners/${uid}_${id}`),{hash:hash(token)});
 });
 return raw==='revoke'?{revoked:true}:{url:`${origin.value()}/#portal=${token}`};
});

export const clientPortal=onRequest({...options,cors:true},async (req,res)=>{
 res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow','X-Content-Type-Options':'nosniff'});
 try {
  if(req.method!=='POST'){res.status(405).end();return;}const token=clean(req.body?.token,100);if(!/^[A-Za-z0-9_-]{40,100}$/.test(token)){res.status(404).json({error:'Link unavailable.'});return;}
  const ip=hash(req.ip||'unknown'),session=hash(clean(req.body.session||'',100));await consume('portal',[ip,hash(token)],120);
  const tokenDoc=await db.doc(`portalTokens/${hash(token)}`).get(),link=tokenDoc.data();
  if(!link||link.expiresAt&&link.expiresAt.toMillis()<Date.now()){res.status(404).json({error:'Link unavailable or revoked.'});return;}
  const pRef=projectRef(link.owner,link.projectId),pDoc=await pRef.get(),p=pDoc.data() as Project|undefined;
  if(!p||p.schema!==3){res.status(404).json({error:'Link unavailable.'});return;}
  const publicRef=db.doc(`publicProjects/${link.owner}_${link.projectId}`);
  if(req.body.action==='comment'){
   await consume('guestComment',[ip,hash(token),session],5,60);
   const name=clean(req.body.name,80),content=clean(req.body.content,4000),task=clean(req.body.task||'',100),requestId=identifier(req.body.requestId);
   if(!name||!content||/https?:\/\/|www\./i.test(content))throw new HttpsError('invalid-argument','Use plain text without links.');
   const commentRef=pRef.collection('comments').doc(hash(hash(token)+requestId));
   await db.runTransaction(async tx=>{const [latest,stillValid,existing]=await tx.getAll(pRef,tokenDoc.ref,commentRef);const current=latest.data() as Project;
    if(!stillValid.exists||stillValid.data()?.expiresAt&&stillValid.data()!.expiresAt.toMillis()<Date.now())fail('Link revoked.');
    if(!current.guestComments||current.status!=='active'||current.frozen)fail('Comments are unavailable.');if(existing.exists)return;
    if(task){const taskDoc=await tx.get(pRef.collection('tasks').doc(identifier(task)));if(!taskDoc.data()?.visible||taskDoc.data()?.deletedAt)fail('Task unavailable.');}
    const duplicateRef=db.doc(`guestDuplicates/${hash(hash(token)+session+content)}`),duplicate=await tx.get(duplicateRef);if(duplicate.data()?.expiresAt?.toMillis()>Date.now())throw new HttpsError('already-exists','This comment was already posted.');
    const c={id:commentRef.id,task,author:name,content,audience:'client',guest:true,awaitingReply:true,created:new Date().toISOString()};tx.set(commentRef,c);tx.set(publicRef.collection('comments').doc(c.id),{id:c.id,task,author:name,content,guest:true,created:c.created});tx.set(duplicateRef,{expiresAt:Timestamp.fromMillis(Date.now()+3600000)});
    tx.set(db.doc(`accounts/${link.owner}/notifications/${c.id}`),{id:c.id,text:'Client comment awaiting reply',projectId:link.projectId,taskId:task,read:false,created:c.created});
    tx.set(db.doc(`emailOutbox/${c.id}`),{uid:link.owner,projectId:link.projectId,subject:'Client comment awaiting reply',immediate:true,to:null,url:null,status:'pending',created:Timestamp.now(),attempts:0});tx.update(pRef,{exportEpoch:FieldValue.increment(1)});
   });
   res.json({posted:true});return;
  }
  const after=clean(req.body.after||'',100),thread=clean(req.body.task||'',100);let q=publicRef.collection('tasks').orderBy('__name__').limit(100);if(after)q=q.startAfter(after);
  const [header,tasks,comments]=await Promise.all([publicRef.get(),q.get(),publicRef.collection('comments').where('task','==',thread).orderBy('created','desc').limit(30).get()]);
  const visibleComments=[];for(const c of comments.docs){const value=c.data();if(value.task){const t=await pRef.collection('tasks').doc(value.task).get();if(!t.data()?.visible||t.data()?.deletedAt)continue;}visibleComments.push(value);}
  res.json({...header.data(),tasks:tasks.docs.map(d=>d.data()),comments:visibleComments.reverse(),next:tasks.size===100?tasks.docs.at(-1)!.id:null});
 }catch(error){const e=error as HttpsError,status=e.code==='resource-exhausted'?429:e.code==='permission-denied'?403:e.code==='invalid-argument'?400:e.code==='already-exists'?409:503;if(status===429)res.set('Retry-After','60');res.status(status).json({error:status===503?'Temporarily unavailable. Please retry.':e.message});}
});

async function enqueueEmail(uid:string,subject:string,projectId:string,immediate=true,invite?:{email:string;url:string}){
 const user=await db.doc(`accounts/${uid}`).get(),prefs=user.data()?.preferences;
 if(!invite&&(prefs?.email===false||prefs?.mutedProjects?.includes(projectId)))return;
 await consume('emailQueue',[uid],50,86400);
 const id=randomBytes(16).toString('hex');await db.doc(`emailOutbox/${id}`).set({uid,subject,projectId,immediate,to:invite?.email||null,url:invite?.url||null,status:'pending',created:Timestamp.now(),attempts:0});
}
export const inviteMember=onCall(options,async request=>{
 const owner=identity(request,true),id=identifier(request.data.projectId),email=clean(request.data.email,254).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new HttpsError('invalid-argument','Invalid email.');
 await consume('invite',[owner],20,86400);const ref=projectRef(owner,id),token=randomBytes(32).toString('base64url');
 await db.runTransaction(async tx=>{const [p,a]=await tx.getAll(ref,db.doc(`accounts/${owner}`));if(!p.exists||p.data()!.status!=='active'||p.data()!.frozen)fail('Project is read-only.');if(p.data()!.members.some((m:any)=>m.uid&&m.email.toLowerCase()===email))throw new HttpsError('already-exists','Already a member.');if(a.data()?.plan!=='pro'&&p.data()!.members.filter((m:any)=>m.collaborating).length>=5)fail('Free allows five collaborating members.');tx.set(db.doc(`invitations/${hash(token)}`),{owner,projectId:id,email,expiresAt:Timestamp.fromMillis(Date.now()+7*86400000),status:'pending'});});
 const url=`${origin.value()}/#invite=${token}`;let emailDelivery='queued';try{await enqueueEmail(owner,'ClientFlow project invitation',id,true,{email,url});}catch{emailDelivery='not-queued';}return {url,emailDelivery};
});
export const acceptInvitation=onCall(options,async request=>{
 const uid=identity(request,true),token=clean(request.data.token,100);await consume('acceptInvite',[uid],20,600);const invitation=db.doc(`invitations/${hash(token)}`);
 return db.runTransaction(async tx=>{const invite=await tx.get(invitation),v=invite.data()!;if(!v||v.status!=='pending'||v.expiresAt.toMillis()<Date.now())fail('Invitation expired or unavailable.');if(request.auth!.token.email?.toLowerCase()!==v.email)fail('Sign in with the invited email.');
  const ref=projectRef(v.owner,v.projectId),[pDoc,account]=await tx.getAll(ref,db.doc(`accounts/${v.owner}`)),p=pDoc.data() as Project;
  if(!p||p.status!=='active'||p.frozen)fail('Project is read-only.');if(account.data()?.plan!=='pro'&&p.members.filter(m=>m.collaborating).length>=5)fail('This project has reached its Free member limit.');
  const previous=p.members.find(m=>m.email.toLowerCase()===v.email),members=p.members.filter(m=>m.uid!==uid&&m.email.toLowerCase()!==v.email);members.push({id:previous?.id||uid,uid,email:v.email,name:request.auth!.token.name||v.email,role:'member',collaborating:true});tx.update(ref,{members,revision:FieldValue.increment(1)});tx.set(db.doc(`users/${uid}/memberships/${v.owner}_${v.projectId}`),{owner:v.owner,projectId:v.projectId});tx.update(invitation,{status:'accepted'});return {projectId:v.projectId};
 });
});
export const removeMember=onCall({...options,timeoutSeconds:300},async request=>{
 const owner=identity(request),id=identifier(request.data.projectId),memberUid=identifier(request.data.uid);if(memberUid===owner)fail('Cannot remove owner.');
 await consume('removeMember',[owner],20,600);const ref=projectRef(owner,id);
 await db.runTransaction(async tx=>{const p=await tx.get(ref);if(p.data()?.status!=='active'||p.data()?.frozen)fail('Read-only project.');tx.update(ref,{members:p.data()!.members.filter((m:any)=>m.uid!==memberUid),revision:FieldValue.increment(1)});tx.delete(db.doc(`users/${memberUid}/memberships/${owner}_${id}`));});
 // Revoke access first; then unassign in bounded transactions without overwriting
 // concurrent task content. Repeating removal resumes any interrupted cleanup.
 while(true){const count=await db.runTransaction(async tx=>{const tasks=await tx.get(ref.collection('tasks').where('assignee','==',memberUid).limit(200));tasks.docs.forEach(d=>tx.update(d.ref,{assignee:'',revision:FieldValue.increment(1)}));if(tasks.size)tx.update(ref,{exportEpoch:FieldValue.increment(1)});return tasks.size;});if(count<200)break;}
 return {removed:true};
});
export const accountCommand=onCall(options,async request=>{
 const uid=identity(request);await consume('account',[uid],30,60);const action=request.data.action;
 if(action==='preferences'){const p=request.data.preferences;if(!p||Object.keys(p).some(k=>!['email','digest','mutedProjects','timezone'].includes(k))||typeof p.email!=='boolean'||!['daily','weekly','off'].includes(p.digest)||!Array.isArray(p.mutedProjects)||p.mutedProjects.length>1000||p.mutedProjects.some((x:unknown)=>typeof x!=='string'||x.length>210)||typeof p.timezone!=='string')throw new HttpsError('invalid-argument','Invalid preferences.');try{new Intl.DateTimeFormat('en',{timeZone:p.timezone});}catch{throw new HttpsError('invalid-argument','Invalid timezone.');}const ref=db.doc(`accounts/${uid}`);await db.runTransaction(async tx=>{const a=await tx.get(ref);tx.set(ref,{...(!a.exists?{schema:3,plan:'free',revision:1,activeProjectId:'',notifications:[]}:{}),preferences:p},{merge:true});});return {saved:true};}
 if(action==='readNotification'){await db.doc(`accounts/${uid}/notifications/${identifier(request.data.id)}`).update({read:true});return {saved:true};}
 if(action==='deleteRequest'){await db.doc(`deletionRequests/${uid}`).set({uid,status:'requested',requestedAt:Timestamp.now()});return {requested:true};}
 fail('Unsupported account command.');
});
export const adminCommand=onCall(options,async request=>{
 admin(request);await consume('admin',[request.auth!.uid],20,60);
 if(request.data.action==='list'){const a=await db.collection('accounts').limit(100).get();return a.docs.map(d=>({uid:d.id,plan:d.data().plan,revision:d.data().revision}));}
 if(request.data.action==='control'){const allowed=['guestComment','portal','invite','emailQueue','write'];const disabled=request.data.disabled;if(!Array.isArray(disabled)||disabled.some(x=>!allowed.includes(x)))throw new HttpsError('invalid-argument','Invalid control.');await db.doc('operations/control').set({disabled});return {saved:true};}
 if(request.data.action==='plan'){
  const owner=identifier(request.data.uid),plan=request.data.plan;if(!['free','pro'].includes(plan))throw new HttpsError('invalid-argument','Invalid plan.');
  await db.runTransaction(async tx=>{const accountRef=db.doc(`accounts/${owner}`),account=await tx.get(accountRef),projects=await tx.get(db.collection(`accounts/${owner}/projects`));if(projects.size>350)throw new HttpsError('failed-precondition','Use the paginated lifecycle job for large accounts.');
   const store:Store={version:2,plan:account.data()?.plan||'free',notifications:[],projects:projects.docs.map(d=>({...d.data(),tasks:[],comments:[],suggestions:[]}) as unknown as Project)},next=changePlan(store,plan);
   next.projects.forEach(p=>tx.update(projectRef(owner,p.id),{frozen:!!p.frozen,members:p.members,revision:FieldValue.increment(1)}));tx.update(accountRef,{plan,activeProjectId:plan==='free'?next.projects.find(p=>p.status==='active'&&!p.frozen)?.id||'':'',revision:FieldValue.increment(1)});tx.set(db.collection('adminAudit').doc(),{actor:request.auth!.uid,owner,action:'plan',plan,created:Timestamp.now()});
  });return {saved:true};
 }
 fail('Unsupported administrator command.');
});

export const deliverEmails=onSchedule({...runtime,schedule:'every 15 minutes',secrets:[smtp]},async()=>{
 if(!smtp.value()||!from.value())return;const pending=await db.collection('emailOutbox').where('status','==','pending').limit(50).get(),processing=await db.collection('emailOutbox').where('status','==','processing').limit(50).get();
 const transport=nodemailer.createTransport(smtp.value());
 for(const item of [...pending.docs,...processing.docs]){
  await processEmailItem(db,item.ref,async v=>{
   const {getAuth}=await import('firebase-admin/auth');const to=v.to||(await getAuth().getUser(v.uid)).email;if(!to)throw Error('Recipient has no email.');
   // No task names, private comments or bearer tokens in general notification emails.
   await transport.sendMail({from:from.value(),to,messageId:`<${v.id}@clientflow.invalid>`,subject:v.subject,text:v.url?`You have been invited to a ClientFlow project.\n${v.url}`:`${v.subject}\nOpen ClientFlow: ${origin.value()}`});
  },async v=>{const account=await db.doc(`accounts/${v.uid}`).get(),prefs=account.data()?.preferences;if(!v.to&&(prefs?.email===false||prefs?.mutedProjects?.includes(v.projectId)))return false;await consume('emailSend',['global'],500,86400);return true;});
 }
 transport.close();
});
export const sendDigests=onSchedule({...runtime,timeoutSeconds:300,schedule:'every 15 minutes'},async()=>{
 const cursor=db.doc('operations/digestCursor');let after=(await cursor.get()).data()?.after||'';const deadline=Date.now()+120000;
 do {let q=db.collection('accounts').where('preferences.email','==',true).orderBy('__name__').limit(300);if(after)q=q.startAfter(after);const accounts=await q.get();
  for(const account of accounts.docs){const p=account.data().preferences;if(!p||p.digest==='off')continue;const parts=Object.fromEntries(new Intl.DateTimeFormat('en',{timeZone:p.timezone||'UTC',hour:'2-digit',hourCycle:'h23',weekday:'short',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(x=>[x.type,x.value]));if(parts.hour!=='09'||p.digest==='weekly'&&parts.weekday!=='Mon')continue;
   const key=`${parts.year}-${parts.month}-${parts.day}`,receipt=db.doc(`digestReceipts/${account.id}_${key}`);if((await receipt.get()).exists)continue;
   const notifications=await account.ref.collection('notifications').where('read','==',false).limit(20).get();if(!notifications.docs.some(d=>!p.mutedProjects?.includes(d.data().projectId)))continue;
   try{await consume('emailQueue',[account.id],50,86400);}catch{continue;}
   await db.runTransaction(async tx=>{if((await tx.get(receipt)).exists)return;tx.set(db.doc(`emailOutbox/${hash(account.id+key)}`),{uid:account.id,projectId:'',subject:'Your ClientFlow activity digest',immediate:true,to:null,url:null,status:'pending',attempts:0,created:Timestamp.now()});tx.set(receipt,{created:Timestamp.now(),expiresAt:Timestamp.fromMillis(Date.now()+8*86400000)});});
  }
  after=accounts.size===300?accounts.docs.at(-1)!.id:'';await cursor.set({after});
 }while(after&&Date.now()<deadline);
});
