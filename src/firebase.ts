import {initializeApp} from 'firebase/app';
import {connectAuthEmulator,getAuth} from 'firebase/auth';
import {connectFirestoreEmulator,getFirestore} from 'firebase/firestore';
import {connectFunctionsEmulator,getFunctions} from 'firebase/functions';
import {initializeAppCheck,ReCaptchaEnterpriseProvider} from 'firebase/app-check';
import {firebaseConfiguration} from './firebase-config';

// Firebase web configuration identifies the project; access is enforced by rules.
const emulator=import.meta.env.VITE_EMULATORS==='true',config=firebaseConfiguration(import.meta.env),projectId=config.projectId;
const app=initializeApp(config);
export const auth=getAuth(app);
export const db=getFirestore(app);
export const functions=getFunctions(app,'europe-west3');
export const serverMode=import.meta.env.VITE_SERVER_MODE==='true'||import.meta.env.VITE_EMULATORS==='true';
export const portalEndpoint=import.meta.env.VITE_PORTAL_ENDPOINT||(emulator?`http://127.0.0.1:5001/${projectId}/europe-west3/clientPortal`:`https://europe-west3-${projectId}.cloudfunctions.net/clientPortal`);
if(import.meta.env.VITE_EMULATORS==='true'){
 connectAuthEmulator(auth,'http://127.0.0.1:9099',{disableWarnings:true});
 connectFirestoreEmulator(db,'127.0.0.1',8080);
 connectFunctionsEmulator(functions,'127.0.0.1',5001);
}
if(import.meta.env.VITE_APP_CHECK_SITE_KEY)initializeAppCheck(app,{provider:new ReCaptchaEnterpriseProvider(import.meta.env.VITE_APP_CHECK_SITE_KEY),isTokenAutoRefreshEnabled:true});
