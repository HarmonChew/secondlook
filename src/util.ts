import { createHash,randomUUID } from 'node:crypto';
import { resolve,relative,isAbsolute } from 'node:path';
export const uid=()=>randomUUID();
export const now=()=>new Date().toISOString();
export function stable(value:unknown):string{if(value===null||typeof value!=='object')return JSON.stringify(value)??'null';if(Array.isArray(value))return '['+value.map(stable).join(',')+']';return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable((value as Record<string,unknown>)[k])).join(',')+'}';}
export const digest=(value:unknown)=>createHash('sha256').update(typeof value==='string'?value:stable(value)).digest('hex');
export function inside(root:string,path:string){const rel=relative(resolve(root),resolve(path));return rel!==''&&!rel.startsWith('..')&&!isAbsolute(rel);}
export function safeRelative(root:string,path:string){const full=resolve(root,path);if(full!==resolve(root)&&!inside(root,full))throw new Error('Path escapes approved directory');return full;}
export const errorText=(error:unknown)=>error instanceof Error?error.message:String(error);
export function redact(text:string,values:string[]=[]) {let result=text;for(const value of values.filter(v=>v.length>=4))result=result.split(value).join('[REDACTED]');return result.replace(/\b(sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{12,})/g,'[REDACTED]');}
export function assertNotAborted(signal:AbortSignal){if(signal.aborted)throw new DOMException('Execution cancelled','AbortError');}
