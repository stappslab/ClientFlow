import test from 'node:test';
import assert from 'node:assert/strict';
import {templateProject,publicProject} from '../src/domain.ts';
import {validateBackup,restoredProject} from '../src/backup.ts';
test('Backup round trip keeps all tasks, comments, numbering and private content',()=>{
 const p=templateProject('Backup','website');p.tasks[0].description='Private';p.tasks[1].visible=false;p.comments.push({id:'comment',task:p.tasks[0].id,author:'Owner',content:'Private discussion',created:new Date().toISOString(),audience:'internal'});
 const copy=validateBackup(JSON.parse(JSON.stringify(p)));assert.equal(copy.tasks.length,4);assert.equal(copy.tasks[0].description,'Private');assert.equal(copy.comments.length,1);assert.equal(copy.taskSequence,4);assert.equal(copy.tasks[1].visible,false);
});
test('Restore is a new archived copy with remapped references and no inherited access',()=>{
 const p=templateProject('Backup','website');p.members.push({id:'old-member',uid:'previous-user',name:'Alex',email:'alex@example.com',collaborating:true,role:'editor'});p.tasks[0].assignee='old-member';p.comments.push({id:'comment',task:p.tasks[0].id,author:'Owner',content:'Hello',created:new Date().toISOString(),audience:'client'});p.suggestions.push({id:'suggestion',task:p.tasks[0].id,author:'Alex',changes:{column:p.columns[1].id},reason:'Review',revision:0,status:'pending'});
 const restored=restoredProject(p,{uid:'new-owner',name:'New owner',email:'new@example.com'});assert.notEqual(restored.id,p.id);assert.equal(restored.status,'archived');assert.notEqual(restored.tasks[0].id,p.tasks[0].id);assert.equal(restored.comments[0].task,restored.tasks[0].id);assert.equal(restored.suggestions[0].changes.column,restored.columns[1].id);assert.equal(restored.members[1].collaborating,false);assert.equal(restored.members[1].uid,undefined);assert.equal(restored.members[0].uid,'new-owner');assert.equal(p.status,'active');
});
test('Malformed, duplicate and dangling backup data are rejected',()=>{
 const p=templateProject('Backup','website');assert.throws(()=>validateBackup({...p,tasks:[p.tasks[0],p.tasks[0]]}));assert.throws(()=>validateBackup({...p,tasks:[{...p.tasks[0],column:'missing'}]}));assert.throws(()=>validateBackup({...p,tasks:[{...p.tasks[0],rank:Infinity}]}));assert.throws(()=>validateBackup({...p,columns:[]}));assert.throws(()=>validateBackup({...p,tasks:[{...p.tasks[0],deletedAt:'invalid'}]}));
});
test('Backup restores deterministic entity identifiers for an interrupted job',()=>{
 const p=templateProject('Backup','website');let index=0;const a=restoredProject(p,undefined,'restore',()=>`entity-${index++}`);index=0;const b=restoredProject(p,undefined,'restore',()=>`entity-${index++}`);assert.deepEqual(a.tasks,b.tasks);assert.deepEqual(a.columns,b.columns);
});
test('Public progress uses authoritative counts for a partially loaded project',()=>{
 const p=templateProject('Paged','website');p.schema=3;p.loaded=true;p.counts={done:300,total:1200,publicDone:250,publicTotal:1000};assert.deepEqual(publicProject(p).counts,{done:250,total:1000});
});
