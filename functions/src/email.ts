import {randomUUID} from 'node:crypto';
import type {Firestore,DocumentReference} from 'firebase-admin/firestore';

// SMTP has no exactly-once guarantee. An expired delivery attempt is held for
// operator review instead of automatically sending a potentially duplicate email.
export async function processEmailItem(db:Firestore,ref:DocumentReference,send:(v:any)=>Promise<void>,allowed:(v:any)=>Promise<boolean>,now=Date.now()){
 const lease=randomUUID();
 const item=await db.runTransaction(async tx=>{const doc=await tx.get(ref),v=doc.data();if(!v||!['pending','processing'].includes(v.status))return null;
  if(v.status==='processing'){if(v.leaseUntil?.toMillis()>now)return null;if(v.deliveryStarted){tx.update(ref,{status:'uncertain',leaseUntil:new Date(now)});return null;}}
  tx.update(ref,{status:'processing',lease,leaseUntil:new Date(now+300000),deliveryStarted:false});return v;
 });if(!item)return;
 async function finish(value:Record<string,unknown>){await db.runTransaction(async tx=>{const latest=await tx.get(ref);if(latest.data()?.lease===lease)tx.update(ref,{...value,leaseUntil:new Date(0)});});}
 let started=false;
 try {
  if(!await allowed(item)){await finish({status:'suppressed'});return;}
  await ref.update({deliveryStarted:true});started=true;await send({...item,id:ref.id});await finish({status:'sent',sent:new Date()});
 }catch(error){const code=(error as {responseCode?:number}).responseCode,attempts=(item.attempts||0)+1;
  const deferred=!started&&(error as {code?:string}).code==='resource-exhausted';
  await finish({attempts:deferred?item.attempts||0:attempts,status:deferred?'pending':started?(code&&code>=400&&code<500&&attempts<5?'pending':code&&code>=500?'failed':'uncertain'):attempts<5?'pending':'failed'});
 }
}
