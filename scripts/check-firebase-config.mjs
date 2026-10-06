import {auth} from '../src/firebase.ts';
const url=new URL('https://identitytoolkit.googleapis.com/v1/projects');
url.searchParams.set('key',auth.config.apiKey);
const response=await fetch(url);
const config=await response.json();
if(!response.ok)throw Error(config.error?.message||'Firebase configuration check failed.');
const domains=config.authorizedDomains||[];
for(const domain of ['localhost','127.0.0.1']){
 if(!domains.includes(domain))throw Error('Missing Firebase authorized domain: '+domain);
}
console.log('Firebase web configuration is valid; localhost and 127.0.0.1 are authorized.');
