import {build} from 'esbuild';
await build({entryPoints:['functions/src/index.ts'],outfile:'functions/lib/index.js',bundle:true,platform:'node',format:'esm',target:'node22',packages:'external'});
console.log('Functions bundle built. No deployment performed.');
