import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true,channel:'chromium'});
try{
 const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});await page.goto('http://127.0.0.1:5173');await page.getByRole('button',{name:'Open local demo',exact:true}).tap();
 await page.locator('.board').evaluate(el=>el.scrollIntoView({block:'center'}));const handle=page.getByRole('button',{name:'Move Launch checklist',exact:true});await handle.scrollIntoViewIfNeeded();const source=await handle.boundingBox(),destination=await page.locator('.column').nth(1).boundingBox();assert.ok(source&&destination);
 const start={x:source.x+source.width/2,y:source.y+source.height/2},end={x:Math.min(375,destination.x+30),y:Math.min(800,destination.y+100)},cdp=await page.context().newCDPSession(page);
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[start]});for(let i=1;i<=15;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:start.x+(end.x-start.x)*i/15,y:start.y+(end.y-start.y)*i/15}]});await page.waitForTimeout(20);}await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await page.getByRole('button',{name:'Undo move',exact:true}).waitFor();await page.waitForFunction(()=>{const p=JSON.parse(localStorage.getItem('clientflow.react.v2')).projects[0];return p.tasks.find(t=>t.title==='Launch checklist').column===p.columns[1].id;});await page.getByRole('button',{name:'Undo move',exact:true}).tap();await page.screenshot({path:'test-results/touch-board.png'});console.log('Mobile touch drag and undo passed.');
}finally{await browser.close();}
