import {onCLS,onINP,onLCP} from 'web-vitals';
type Measurement={name:string;value:number;timestamp:number};
const measurements:Measurement[]=[],events:Record<string,number>={};
const allowed=new Set(['project_created','task_created','portal_shared','free_slot_limit']);
function record(name:string,value:number){measurements.push({name,value,timestamp:Date.now()});if(measurements.length>100)measurements.shift();}
export function measureAction(name:string){const start=performance.now();return()=>record(name,performance.now()-start);}
export function recordEvent(name:string){if(allowed.has(name))events[name]=(events[name]||0)+1;}
export function diagnostics(){return {measurements:[...measurements],events:{...events},online:navigator.onLine};}
export function initializeMeasurements(){if(location.hash.startsWith('#portal='))return;onCLS(m=>record('CLS',m.value));onINP(m=>record('INP',m.value));onLCP(m=>record('LCP',m.value));}
