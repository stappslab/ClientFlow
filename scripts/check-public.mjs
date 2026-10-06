import {execFileSync} from 'node:child_process';
import path from 'node:path';

const gitOptions=process.argv.includes('--trust-workspace')?['-c',`safe.directory=${process.cwd().replaceAll('\\','/')}`]:[];
const files=execFileSync('git',[...gitOptions,'ls-files','--cached','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
if(!files.length)throw Error('No staged files to inspect.');
const issues=[];
const privatePath=/(^|\/)(node_modules|dist|\.firebase|test-results|private|confidential|attachments|backups|exports|\.codex|\.agents|\.aws)(\/|$)|(^|\/)\.env(?!\.example$)|\.(pdf|log|pem|key|p12|pfx)$|(^|\/)\.firebaserc$|service.?account|credentials|secrets?\.json/i;
const patterns=[
 ['private key',/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
 ['GitHub token',/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
 ['Google API key',/\bAIza[0-9A-Za-z_-]{35}\b/],
 ['AWS access key',/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
 ['credential in URL',/\b(?:https?|smtps?):\/\/[^\s/@:]+:[^\s/@]+@/],
 ['production Firebase identifier',new RegExp(['clientflow-'+'44452','136848'+'262254'].join('|'))],
 ['private planning reference',new RegExp(['BUSINESS_'+'COST_COMPARISON','PAYMENT_'+'OPTIONS','IMPROVEMENT_'+'PROPOSALS','PROJECT_'+'STATUS','ClientFlow_'+'PRD'].join('|'),'i')]
];
for(const file of files){
 if(privatePath.test(file)||(file.endsWith('.md')&&path.basename(file)!=='README.md'))issues.push(`${file}: private file path`);
 const content=execFileSync('git',[...gitOptions,'show',`:${file}`],{encoding:'utf8',maxBuffer:20*1024*1024});
 for(const [label,pattern] of patterns)if(pattern.test(content))issues.push(`${file}: ${label}`);
}
if(issues.length){console.error(issues.join('\n'));process.exitCode=1;}
else console.log(`Public-content check passed for ${files.length} staged files. Review staged changes manually before publication.`);
