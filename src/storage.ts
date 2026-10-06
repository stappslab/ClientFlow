import {makeProject,normalizeProject,seed,type Store,type Priority,type Status} from './domain';
const KEY='clientflow.react.v2';
export function load():Store {
 try {
  const value=JSON.parse(localStorage.getItem(KEY)||'null');
  if(value?.version===2&&Array.isArray(value.projects)){value.projects=value.projects.map(normalizeProject);return value;}
  const old=JSON.parse(localStorage.getItem('clientflow.prototype.v1')||'null');
  if(old&&typeof old.name==='string'&&Array.isArray(old.columns)&&old.columns.length&&Array.isArray(old.tasks)){
   const project=makeProject(old.name);
   project.description=String(old.description||'');
   project.status=['active','completed','archived'].includes(old.status)?old.status as Status:'active';
   project.columns=old.columns.map((c:{id:string;name:string;color:string;done?:boolean})=>({id:c.id,name:c.name,color:c.color,done:!!c.done,limit:0}));
   project.tasks=old.tasks.map((t:{id:string;title:string;description?:string;column:string;priority:Priority;deadline?:string;visible:boolean})=>({id:t.id,title:t.title,description:t.description||'',column:t.column,priority:t.priority,deadline:t.deadline||'',visible:t.visible,assignee:'',sprint:'',revision:0}));
   return {version:2,plan:'free',projects:[project],notifications:[]};
  }
 }catch{}
 const store=seed();store.projects=store.projects.map(normalizeProject);return store;
}
export function persist(store:Store){localStorage.setItem(KEY,JSON.stringify(store));}
