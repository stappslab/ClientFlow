const demo={apiKey:'demo-only-key',authDomain:'demo-clientflow.firebaseapp.com',projectId:'demo-clientflow',storageBucket:'demo-clientflow.firebasestorage.app',messagingSenderId:'123456789',appId:'1:123456789:web:0000000000000000000000'};
const fields={apiKey:'VITE_FIREBASE_API_KEY',authDomain:'VITE_FIREBASE_AUTH_DOMAIN',projectId:'VITE_FIREBASE_PROJECT_ID',storageBucket:'VITE_FIREBASE_STORAGE_BUCKET',messagingSenderId:'VITE_FIREBASE_MESSAGING_SENDER_ID',appId:'VITE_FIREBASE_APP_ID'} as const;
export function firebaseConfiguration(env:Record<string,string|boolean|undefined>){
 if(env.VITE_EMULATORS==='true')return {...demo};
 if(!Object.values(fields).some(key=>env[key]))return {...demo};
 const result={...demo};for(const [field,key] of Object.entries(fields)){const value=env[key];if(typeof value!=='string'||!value.trim())throw Error(`Incomplete Firebase configuration: ${key} is required. No production fallback was used.`);result[field as keyof typeof result]=value.trim();}
 return result;
}
