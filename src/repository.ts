import {collection,doc,onSnapshot,runTransaction,type Unsubscribe} from 'firebase/firestore';
import {db,serverMode} from './firebase';
import {commitNormalized} from './normalized-repository';
import {accountFor,changesBetween,emptyStore,type Account} from './cloud-model';
import {normalizeProject,type Project,type Store} from './domain';

export interface CloudWorkspace {store:Store; revision:number;schema?:number}
export function subscribeWorkspace(userId:string,receive:(value:CloudWorkspace)=>void,fail:(error:Error)=>void):Unsubscribe {
 let account:Account|null=null,projects:Project[]=[],ready=false;
 const emit=()=>{if(account&&ready)receive({store:{version:2,plan:account.plan,notifications:account.notifications,projects},revision:account.revision});};
 const stopAccount=onSnapshot(doc(db,'accounts',userId),snapshot=>{account=snapshot.exists()?snapshot.data() as Account:accountFor(emptyStore(),0);emit();},fail);
 const stopProjects=onSnapshot(collection(db,'accounts',userId,'projects'),snapshot=>{projects=snapshot.docs.map(d=>normalizeProject(d.data() as Project)).sort((a,b)=>a.created-b.created);ready=true;emit();},fail);
 return ()=>{stopAccount();stopProjects();};
}
export async function commitWorkspace(userId:string,before:CloudWorkspace,next:Store):Promise<number> {
 if(serverMode)return commitNormalized(userId,before,next);
 const changed=changesBetween(before.store,next);
 const revision=before.revision+1;
 await runTransaction(db,async transaction=>{
  const ref=doc(db,'accounts',userId),snapshot=await transaction.get(ref);
  const current=snapshot.exists()?snapshot.data() as Account:null;
  if((current?.revision??0)!==before.revision)throw Error('This workspace changed in another tab. Wait for it to refresh and try again.');
  if(current&&current.plan!==next.plan)throw Error('Your plan changed. Refresh before continuing.');
  transaction.set(ref,accountFor(next,revision));
  for(const project of changed){
   // Keep the currently deployed legacy schema until the server migration is enabled.
   const {taskSequence,branding,frozen,revision,ownerId,schema,loaded,counts,publicColumnCounts,...legacy}=project;
   transaction.set(doc(db,'accounts',userId,'projects',project.id),legacy);
  }
 });
 return revision;
}
