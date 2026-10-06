import {normalizeProject,uid,type Project,type Task,type Column,type Member,type Sprint,type Comment,type Suggestion} from './domain.ts';

export const BACKUP_MAX_BYTES=20*1024*1024;
const text=(value:unknown,max:number)=>{if(typeof value!=='string'||value.length>max)throw Error('Invalid backup text.');return value;};
const id=(value:unknown)=>{const s=text(value,100);if(!/^[A-Za-z0-9_-]+$/.test(s))throw Error('Invalid backup identifier.');return s;};
const bool=(value:unknown)=>{if(typeof value!=='boolean')throw Error('Invalid backup flag.');return value;};
const date=(value:unknown)=>{const s=text(value,40);if(s&&!Number.isFinite(Date.parse(s)))throw Error('Invalid backup date.');return s;};
function rows<T>(value:unknown,parse:(v:any)=>T,max=50000):T[]{if(!Array.isArray(value)||value.length>max)throw Error('Invalid backup collection.');const result=value.map(parse),ids=result.map(v=>(v as {id:string}).id);if(new Set(ids).size!==ids.length)throw Error('Duplicate backup identifiers.');return result;}
const priorities=['Low','Medium','High','Urgent'];
function task(v:any):Task {
 if(!priorities.includes(v.priority)||!Number.isInteger(v.revision)||v.revision<0||v.number!==undefined&&(!Number.isSafeInteger(v.number)||v.number<1)||v.rank!==undefined&&!Number.isFinite(v.rank))throw Error('Invalid backup task.');
 const t:Task={id:id(v.id),title:text(v.title,160),description:text(v.description,8000),column:id(v.column),priority:v.priority,deadline:date(v.deadline),assignee:v.assignee?id(v.assignee):'',visible:bool(v.visible),sprint:v.sprint?id(v.sprint):'',revision:v.revision};
 if(!t.title.trim()||t.deadline&&!/^\d{4}-\d{2}-\d{2}$/.test(t.deadline))throw Error('Invalid task title or deadline.');
 if(v.number!==undefined)t.number=v.number;if(v.rank!==undefined)t.rank=v.rank;if(v.deletedAt)t.deletedAt=date(v.deletedAt);return t;
}
export function validateBackup(value:unknown):Project {
 if(!value||typeof value!=='object'||JSON.stringify(value).length>BACKUP_MAX_BYTES)throw Error('Invalid or oversized backup.');
 const v=value as any;
 const columns=rows<Column>(v.columns,c=>{if(!/^#[0-9a-f]{6}$/i.test(c.color)||!Number.isInteger(c.limit)||c.limit<0||c.limit>999)throw Error('Invalid backup column.');return {id:id(c.id),name:text(c.name,60),publicName:text(c.publicName||'',60),color:c.color,done:bool(c.done),limit:c.limit};},40);
 if(!columns.length||columns.some(c=>!c.name.trim()))throw Error('Keep at least one named column.');
 const members=rows<Member>(v.members,m=>({id:id(m.id),name:text(m.name,80),email:text(m.email,254),collaborating:bool(m.collaborating)}),10000);
 if(!members.some(m=>m.id==='owner'))throw Error('Backup has no owner.');
 const sprints=rows<Sprint>(v.sprints,s=>{if(!['planned','active','completed'].includes(s.status))throw Error('Invalid sprint.');return {id:id(s.id),name:text(s.name,80),start:date(s.start),end:date(s.end),status:s.status};},10000);
 const tasks=rows(v.tasks,task),columnIds=new Set(columns.map(c=>c.id)),memberIds=new Set(members.map(m=>m.id)),sprintIds=new Set(sprints.map(s=>s.id)),taskMap=new Map(tasks.map(t=>[t.id,t]));
 if(tasks.some(t=>!columnIds.has(t.column)&&!t.deletedAt||t.assignee&&!memberIds.has(t.assignee)||t.sprint&&!sprintIds.has(t.sprint)))throw Error('Backup task references missing data.');
 const comments=rows<Comment>(v.comments,c=>{if(!['internal','client'].includes(c.audience)||!c.created||c.task&&!taskMap.has(c.task))throw Error('Invalid backup conversation.');return {id:id(c.id),task:c.task?id(c.task):'',author:text(c.author,254),content:text(c.content,4000),audience:c.audience,created:date(c.created),guest:!!c.guest,awaitingReply:!!c.awaitingReply,moderated:!!c.moderated};});
 const suggestions=rows<Suggestion>(v.suggestions,s=>{const original=taskMap.get(s.task);if(!original||!['pending','accepted','rejected'].includes(s.status)||!Number.isInteger(s.revision)||s.revision<0||!s.changes||Object.keys(s.changes).some(k=>!['title','description','column','priority','deadline','assignee','sprint','visible'].includes(k)))throw Error('Invalid backup suggestion.');const proposed=task({...original,...s.changes});if(!columnIds.has(proposed.column)||proposed.assignee&&!memberIds.has(proposed.assignee)||proposed.sprint&&!sprintIds.has(proposed.sprint))throw Error('Invalid suggestion references.');return {id:id(s.id),task:id(s.task),author:text(s.author,254),changes:s.changes,reason:text(s.reason,2000),revision:s.revision,status:s.status};});
 if(!['active','completed','archived'].includes(v.status)||!Number.isFinite(v.created))throw Error('Invalid backup project.');
 const p:Project={id:id(v.id),name:text(v.name,100),description:text(v.description,8000),status:v.status,created:v.created,columns,members,sprints,tasks,comments,suggestions,guestComments:bool(v.guestComments)};
 if(!p.name.trim())throw Error('Invalid project name.');if(v.taskSequence!==undefined&&(!Number.isSafeInteger(v.taskSequence)||v.taskSequence<0))throw Error('Invalid task sequence.');p.taskSequence=v.taskSequence||0;
 return normalizeProject(p);
}
export function restoredProject(backup:unknown,owner?:{uid:string;name:string;email:string},projectId:string=uid(),newId:()=>string=uid):Project {
 const p=validateBackup(backup),columnIds=new Map(p.columns.map(c=>[c.id,newId()])),taskIds=new Map(p.tasks.map(t=>[t.id,newId()])),sprintIds=new Map(p.sprints.map(s=>[s.id,newId()]));
 p.id=projectId;p.status='archived';p.created=Date.now();p.revision=0;p.frozen=false;
 p.columns.forEach(c=>c.id=columnIds.get(c.id)!);p.sprints.forEach(s=>s.id=sprintIds.get(s.id)!);
 p.members.forEach(m=>{m.collaborating=m.id==='owner';if(m.id==='owner'&&owner){m.uid=owner.uid;m.name=owner.name;m.email=owner.email;}});
 p.tasks.forEach(t=>{t.id=taskIds.get(t.id)!;t.column=columnIds.get(t.column)||p.columns[0].id;t.sprint=sprintIds.get(t.sprint)||'';});
 p.comments.forEach(c=>{c.id=newId();c.task=taskIds.get(c.task)||'';});
 p.suggestions.forEach(s=>{s.id=newId();s.task=taskIds.get(s.task)!;if(s.changes.column)s.changes.column=columnIds.get(s.changes.column)||p.columns[0].id;if(s.changes.sprint)s.changes.sprint=sprintIds.get(s.changes.sprint)||'';});
 return p;
}
