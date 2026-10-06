const response=await fetch('http://127.0.0.1:5173');
if(!response.ok)throw Error('HTTP '+response.status);
const html=await response.text();
if(!html.includes('/src/main.tsx'))throw Error('Unexpected server content.');
console.log('ClientFlow dev server is ready: HTTP '+response.status);
