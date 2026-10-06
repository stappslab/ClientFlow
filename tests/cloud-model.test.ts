import {test} from 'node:test';
import assert from 'node:assert/strict';
import {accountFor,changesBetween,emptyStore} from '../src/cloud-model.ts';
import {makeProject,seed} from '../src/domain.ts';
test('Cloud starts empty, does not import local demo projects',()=>{assert.deepEqual(emptyStore(),{version:2,plan:'free',projects:[],notifications:[]});});
test('Cloud changes isolate changed projects and preserve authoritative plan',()=>{const before=seed(),next=structuredClone(before);assert.equal(changesBetween(before,next).length,0);next.projects[0].tasks[0].title='New title';assert.equal(changesBetween(before,next).length,1);next.plan='pro';assert.throws(()=>changesBetween(before,next),/server/);});
test('Cloud rejects deleting history and extra active Free projects',()=>{const before=seed(),next=structuredClone(before);next.projects=[];assert.throws(()=>changesBetween(before,next),/Archive/);next.projects=[...before.projects,makeProject('Second')];assert.throws(()=>changesBetween(before,next),/one active/);});
test('Slot follows oldest active project, closes when completed',()=>{const store=seed();assert.equal(accountFor(store,2).activeProjectId,store.projects[0].id);store.projects[0].status='completed';assert.equal(accountFor(store,3).activeProjectId,'');});
