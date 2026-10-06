import {activeProject, type Project,type Store} from './domain.ts';
export interface Account {plan:Store['plan']; revision:number; activeProjectId:string; notifications:Store['notifications']}
export const emptyStore=():Store=>({version:2,plan:'free',projects:[],notifications:[]});
export function accountFor(store:Store,revision:number):Account {return {plan:store.plan,revision,activeProjectId:activeProject(store)||'',notifications:store.notifications};}
export function changesBetween(before:Store,next:Store):Project[] {
 if(before.plan!==next.plan)throw Error('Plan changes are managed by the server.');
 if(before.projects.some(p=>!next.projects.some(n=>n.id===p.id)))throw Error('Archive a project instead of deleting it.');
 if(next.plan==='free'&&next.projects.filter(p=>p.status==='active'&&!p.frozen&&!p.ownerId).length>1)throw Error('Free allows one active project.');
 if(next.plan==='free'&&next.projects.some(p=>p.members.filter(m=>m.collaborating).length>5))throw Error('Free allows five collaborating members per project.');
 return next.projects.filter(p=>JSON.stringify(p)!==JSON.stringify(before.projects.find(old=>old.id===p.id)));
}
