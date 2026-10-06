import {useEffect,useRef,useState} from 'react';
import {createUserWithEmailAndPassword,GoogleAuthProvider,onAuthStateChanged,sendEmailVerification,sendPasswordResetEmail,signInWithEmailAndPassword,signInWithPopup,signOut,updateProfile,type User} from 'firebase/auth';
import {LogIn,ArrowLeft,Mail} from 'lucide-react';
import {auth,serverMode} from './firebase';
import {command,subscribeNormalized,type WorkspaceSubscription} from './normalized-repository';
import {commitWorkspace,subscribeWorkspace,type CloudWorkspace} from './repository';
import type {Store} from './domain';
import App from './App';
import Portal from './Portal';

function errorMessage(error:unknown):string {
 const code=(error as {code?:string}).code;
 const messages:Record<string,string>={
  'auth/invalid-credential':'Email or password is incorrect.',
  'auth/email-already-in-use':'An account already exists with this email.',
  'auth/weak-password':'Choose a password with at least 8 characters.',
  'auth/invalid-email':'Enter a valid email address.',
  'auth/popup-blocked':'Your browser blocked the sign-in popup. Allow popups and try again.',
  'auth/popup-closed-by-user':'Google sign-in was cancelled.',
  'auth/unauthorized-domain':'This domain is not authorized in Firebase Authentication.',
  'auth/operation-not-allowed':'Enable this sign-in provider in Firebase Authentication.',
  'auth/network-request-failed':'Could not connect. Check your internet connection.',
  'auth/too-many-requests':'Too many attempts. Please try again later.',
  'permission-denied':'Firestore access rules are not deployed yet, or access was denied.'
 };
 return messages[code||'']||(error instanceof Error?error.message:'Something went wrong. Please try again.');
}

const migrations=new Map<string,Promise<unknown>>();
function migrateOnce(userId:string){let promise=migrations.get(userId);if(!promise){promise=command('migrateWorkspace',{}).finally(()=>migrations.delete(userId));migrations.set(userId,promise);}return promise;}
function Workspace({user}:{user:User}){
 const [workspace,setWorkspace]=useState<CloudWorkspace|null>(null),[error,setError]=useState(''),[retry,setRetry]=useState(0);
 const latest=useRef<CloudWorkspace|null>(null),subscription=useRef<WorkspaceSubscription|null>(null);
 useEffect(()=>{let cancelled=false,stop:(()=>void)|undefined;
  const receive=(value:CloudWorkspace)=>{latest.current=value;setWorkspace(value);setError('');};
  const start=async()=>{try{if(serverMode){await migrateOnce(user.uid);if(cancelled)return;subscription.current=subscribeNormalized(user.uid,receive,e=>setError(errorMessage(e)));stop=subscription.current.close;}else stop=subscribeWorkspace(user.uid,receive,e=>setError(errorMessage(e)));}catch(e){if(!cancelled)setError(errorMessage(e));}};
  void start();return()=>{cancelled=true;stop?.();subscription.current=null;};
 },[user.uid,retry]);
 async function change(next:Store,base?:Store){if(!latest.current)throw Error('Workspace is still loading.');const before={...latest.current,store:base||latest.current.store};try{const revision=await commitWorkspace(user.uid,before,next);if(!serverMode){const value={store:next,revision};latest.current=value;setWorkspace(value);}}catch(e){throw Error(errorMessage(e));}}
 if(error)return <div className="account-screen"><div className="account-panel"><h1>Workspace unavailable</h1><p role="alert">{error}</p><div className="actions"><button onClick={()=>setRetry(x=>x+1)}>Retry</button><button onClick={()=>void signOut(auth)}>Sign out</button></div></div></div>;
 if(!workspace)return <div className="account-screen" role="status">Loading your workspace...</div>;
 return <App key={user.uid} remote={{store:workspace.store,change,userId:user.uid,userName:user.displayName||user.email||'Project owner',userEmail:user.email||'',verified:user.emailVerified,server:serverMode,select:(owner,id)=>subscription.current?.select(owner,id),thread:task=>subscription.current?.thread(task),moreComments:()=>subscription.current?.moreComments()||Promise.resolve(),moreTasks:()=>subscription.current?.moreTasks()||Promise.resolve(),verify:async()=>{await sendEmailVerification(user);},signOut:()=>signOut(auth)}}/>;
}

function Invitation({user,token}:{user:User;token:string}){
 const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
 return <div className="account-screen"><section className="account-panel"><h1>Project invitation</h1><p>{user.email}</p>{message&&<p role="status">{message}</p>}<button className="primary" disabled={busy||!serverMode} onClick={async()=>{setBusy(true);try{if(!user.emailVerified){await user.reload();if(!user.emailVerified){await sendEmailVerification(user);setMessage('Check your verification email, then return and try again.');return;}}await command('acceptInvitation',{token});location.hash='';location.reload();}catch(e){setMessage(errorMessage(e));}finally{setBusy(false);}}}>{busy?'Please wait...':user.emailVerified?'Join project':'Verify email and join'}</button>{!serverMode&&<p role="alert">Invitations require the server-enabled workspace.</p>}<button onClick={()=>void signOut(auth)}>Use another account</button><button onClick={()=>{location.hash='';location.reload();}}>Cancel</button></section></div>;
}

export default function AuthGate(){
 const [user,setUser]=useState<User|null>(null),[loading,setLoading]=useState(true),[demo,setDemo]=useState(false),[mode,setMode]=useState<'login'|'register'|'reset'>('login'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[info,setInfo]=useState('');
 useEffect(()=>onAuthStateChanged(auth,user=>{setUser(user);setLoading(false);},e=>{setError(errorMessage(e));setLoading(false);}),[]);
 const portalToken=location.hash.startsWith('#portal=')?location.hash.slice(8):'';
 if(portalToken)return <Portal token={portalToken}/>;
 if(loading)return <div className="account-screen" role="status">Loading ClientFlow...</div>;
 if(user&&location.hash.startsWith('#invite='))return <Invitation user={user} token={location.hash.slice(8)}/>;
 if(user)return <Workspace user={user}/>;
 if(demo)return <><div className="demo-bar"><span>Local demo</span><button onClick={()=>setDemo(false)}><ArrowLeft size={15}/>Back to sign in</button></div><App/></>;
 return <div className="account-screen"><section className="account-panel"><a className="auth-brand" href="/">ClientFlow</a><h1>{mode==='register'?'Create your account':mode==='reset'?'Reset your password':'Welcome back'}</h1><form onSubmit={async e=>{
  e.preventDefault();if(busy)return;setBusy(true);setError('');setInfo('');
  const d=new FormData(e.currentTarget),email=String(d.get('email')).trim(),password=String(d.get('password')||'');
  try {
   if(mode==='reset'){await sendPasswordResetEmail(auth,email);setInfo('If an account exists for this email, a password reset link will arrive shortly.');}
   else if(mode==='register'){const result=await createUserWithEmailAndPassword(auth,email,password);await updateProfile(result.user,{displayName:String(d.get('name')).trim()});}
   else await signInWithEmailAndPassword(auth,email,password);
  }catch(e){setError(errorMessage(e));}finally{setBusy(false);}
 }}>{mode==='register'&&<label>Your name<input name="name" autoComplete="name" required maxLength={80} disabled={busy}/></label>}<label>Email<input name="email" type="email" autoComplete="email" required disabled={busy}/></label>{mode!=='reset'&&<label>Password<input name="password" type="password" autoComplete={mode==='register'?'new-password':'current-password'} minLength={mode==='register'?8:undefined} required disabled={busy}/></label>}{error&&<p className="auth-error" role="alert">{error}</p>}{info&&<p className="auth-info" role="status">{info}</p>}<button className="primary auth-submit" disabled={busy}>{mode==='reset'?<Mail size={17}/>:<LogIn size={17}/>} {busy?'Please wait...':mode==='register'?'Create account':mode==='reset'?'Send reset link':'Sign in'}</button></form>{mode!=='reset'&&<button className="google-button" disabled={busy} onClick={async()=>{setBusy(true);setError('');try{await signInWithPopup(auth,new GoogleAuthProvider());}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}}>Continue with Google</button>}<div className="auth-links"><button disabled={busy} onClick={()=>{setMode(mode==='login'?'register':'login');setError('');setInfo('');}}>{mode==='login'?'Create account':'Back to sign in'}</button>{mode==='login'&&<button disabled={busy} onClick={()=>{setMode('reset');setError('');setInfo('');}}>Forgot password?</button>}</div><button className="local-demo-button" disabled={busy} onClick={()=>setDemo(true)}>Open local demo</button></section></div>;
}
