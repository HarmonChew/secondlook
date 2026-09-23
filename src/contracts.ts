import { z } from 'zod';

export const idSchema=z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const commandSchema=z.object({command:z.string().min(1),args:z.array(z.string()).default([]),cwd:z.string().default('.'),timeoutMs:z.number().int().min(100).max(3600000).default(120000),envRefs:z.record(z.string(),z.string()).default({})});
export type Command=z.infer<typeof commandSchema>;
export const profileSchema=z.object({schemaVersion:z.literal(1),id:idSchema,name:z.string().min(1),install:z.array(commandSchema).default([]),service:commandSchema.extend({healthPath:z.string().startsWith('/').default('/'),startupTimeoutMs:z.number().min(100).max(300000).default(30000),fixedPort:z.number().int().min(1024).max(65535).optional()}),baseURL:z.string().default('http://127.0.0.1:{{port}}'),checks:z.array(z.object({id:idSchema,name:z.string(),required:z.boolean().default(true),command:commandSchema})).default([]),source:z.object({include:z.array(z.string()).min(1).default(['**/*']),exclude:z.array(z.string()).default([])}).default({include:['**/*'],exclude:[]})});
export type ProjectProfile=z.infer<typeof profileSchema>;
export const modelSelectionSchema=z.object({provider:z.string().min(1).max(100),id:z.string().min(1).max(200)}).strict();
export type ModelSelection=z.infer<typeof modelSelectionSchema>;
export type ModelProviderInfo={id:string;name:string;apiKeyEnv:string;configured:boolean;models:Array<{id:string;name:string;contextWindow:number;maxTokens:number;reasoning:boolean}>};
const actionBase={id:idSchema,label:z.string().min(1)};
export const actionSchema=z.discriminatedUnion('type',[
 z.object({...actionBase,type:z.literal('fill'),selector:z.string(),value:z.string()}),
 z.object({...actionBase,type:z.literal('click'),selector:z.string()}),
 z.object({...actionBase,type:z.literal('reload')}),
 z.object({...actionBase,type:z.literal('capture')}),
 z.object({...actionBase,type:z.literal('assert'),selector:z.string(),condition:z.enum(['text','value','visible','count']),expected:z.union([z.string(),z.number(),z.boolean()]),role:z.enum(['precondition','expectation']).default('expectation')})
]);
export type ScenarioAction=z.infer<typeof actionSchema>;
export const scenarioSchema=z.object({id:idSchema,name:z.string().min(1),revision:z.number().int().positive(),route:z.string().startsWith('/'),identityRef:idSchema.optional(),viewport:z.object({width:z.number().int().min(320).max(2560),height:z.number().int().min(300).max(2000)}).default({width:1280,height:800}),fixture:z.object({mode:z.enum(['isolated-test','simulated','live-test']),description:z.string(),reset:z.object({path:z.string().startsWith('/'),body:z.unknown().optional()}).optional(),headersRefs:z.record(z.string(),z.string()).default({}),mocks:z.array(z.object({url:z.string(),status:z.number().int().min(100).max(599).default(200),json:z.unknown()})).default([])}),setupActions:z.array(actionSchema).default([]),actions:z.array(actionSchema).min(1),regressionAssertionId:idSchema.optional()}).superRefine((s,ctx)=>{const ids=[...s.setupActions,...s.actions].map(a=>a.id);if(new Set(ids).size!==ids.length)ctx.addIssue({code:'custom',message:'Action IDs must be unique'});if(s.regressionAssertionId&&!s.actions.some(a=>a.id===s.regressionAssertionId&&a.type==='assert'&&a.role==='expectation'))ctx.addIssue({code:'custom',message:'Regression assertion must reference an expectation action'});});
export type ScenarioDefinition=z.infer<typeof scenarioSchema>;
export const policySchema=z.object({repairLimit:z.number().int().min(0).max(3).default(1),infrastructureRetries:z.number().int().min(0).max(2).default(1),requiredCheckIds:z.array(idSchema).default([]),approvalBefore:z.array(z.enum(['install','implement','verify','preview'])).default([])});
export type Policy=z.infer<typeof policySchema>;
export const candidateSchema=z.object({workspaceId:idSchema,baseCommit:z.string(),snapshotId:idSchema,sourceDigest:z.string().length(64)});
export type CandidateRef=z.infer<typeof candidateSchema>;
export const evidenceContextSchema=z.object({candidate:candidateSchema,scenarioId:idSchema,scenarioRevision:z.number().int().positive(),scenarioDigest:z.string(),projectProfileDigest:z.string(),checksDigest:z.string(),environmentDigest:z.string()});
export type EvidenceContext=z.infer<typeof evidenceContextSchema>;
export const artifactSchema=z.object({id:idSchema,artifactType:z.enum(['evidence','check','feedback','decision','agent-result','file']),schemaVersion:z.literal(1),contentRevision:z.number().int().positive(),runId:idSchema,attemptId:idSchema.optional(),createdAt:z.string(),inputArtifactIds:z.array(idSchema),context:evidenceContextSchema.optional(),payloadDigest:z.string().length(64),payload:z.record(z.string(),z.unknown())});
export type Artifact<T=Record<string,unknown>>=Omit<z.infer<typeof artifactSchema>,'payload'>&{payload:T};
export const actionResultSchema=z.object({id:z.string(),label:z.string(),type:z.string(),status:z.enum(['passed','failed','not-run']),expected:z.unknown().optional(),actual:z.unknown().optional(),error:z.string().optional(),durationMs:z.number()});
export type ActionResult=z.infer<typeof actionResultSchema>;
export const evidenceSchema=z.object({side:z.enum(['baseline','candidate']),outcome:z.enum(['passed','assertion_failed','environment_error','execution_error','cancelled']),reproduced:z.boolean(),actions:z.array(actionResultSchema),files:z.array(idSchema),observation:z.string(),limitations:z.array(z.string()),startedAt:z.string(),finishedAt:z.string()});
export type EvidencePayload=z.infer<typeof evidenceSchema>;
export const checkResultSchema=z.object({checkId:z.string(),version:z.string(),status:z.enum(['passed','failed','blocked']),summary:z.string(),details:z.string().optional(),fileIds:z.array(idSchema).default([])});
export type VerificationResult=z.infer<typeof checkResultSchema>;
export const runSchema=z.object({id:idSchema,title:z.string(),request:z.string(),kind:z.enum(['bugfix','feature']),status:z.enum(['queued','running','blocked','paused','failed','complete','cancelled']),phase:z.enum(['PREPARE','CAPTURE_BASELINE','IMPLEMENT','VERIFY_CANDIDATE','READY_FOR_REVIEW']),blockingReason:z.string().nullable(),repository:z.string(),baseCommit:z.string(),driverId:z.string(),model:modelSelectionSchema.optional(),demo:z.boolean(),profile:profileSchema,scenarios:z.array(scenarioSchema).min(1),policy:policySchema,approvedAt:z.string(),profileDigest:z.string(),createdAt:z.string(),updatedAt:z.string(),workspace:z.object({id:idSchema,baselinePath:z.string().optional(),candidatePath:z.string(),branch:z.string()}).optional(),candidate:candidateSchema.optional(),baseline:candidateSchema.optional(),reviewRevision:z.number().int().positive(),repairCount:z.number().int().nonnegative(),implementationAttempts:z.number().int().nonnegative(),evidenceIds:z.array(idSchema),checkIds:z.array(idSchema),feedbackIds:z.array(idSchema),acceptance:z.object({artifactId:idSchema,sourceDigest:z.string(),reviewRevision:z.number(),acceptedAt:z.string()}).optional(),pendingApproval:z.object({operation:z.enum(['install','implement','verify','preview']),key:z.string()}).optional(),approvedOperations:z.array(z.string()),sourceStale:z.boolean().default(false),lastError:z.string().optional()});
export type Run=z.infer<typeof runSchema>;
export type RunKind=Run['kind'];export type RunStatus=Run['status'];export type Phase=Run['phase'];
export const createRunSchema=z.object({title:z.string().min(1).max(160),request:z.string().min(1).max(12000),kind:z.enum(['bugfix','feature']),repository:z.string().min(1),baseRef:z.string().default('HEAD'),driverId:z.string().default('codex'),model:modelSelectionSchema.optional(),profile:profileSchema,scenarios:z.array(scenarioSchema).min(1).max(20),policy:policySchema.default({repairLimit:1,infrastructureRetries:1,requiredCheckIds:[],approvalBefore:[]}),approved:z.literal(true)}).refine((input)=>input.driverId==='pi'?input.model!==undefined:input.model===undefined,{path:['model'],message:'model is required for the pi driver and must be omitted for other drivers'});
export type CreateRunInput=z.infer<typeof createRunSchema>;
export type StageAttempt={id:string;runId:string;phase:Phase;status:'running'|'passed'|'failed'|'cancelled'|'interrupted';startedAt:string;finishedAt?:string;error?:string};
export type ActivityEvent={id:number;runId:string;at:string;type:string;message:string;data?:unknown};
export type Operation={id:string;runId?:string;kind:string;status:'pending'|'done'|'needs-reconciliation';payload:Record<string,unknown>;createdAt:string;result?:Record<string,unknown>};
export type ProcessRecord={id:string;runId:string;pid:number;identity:string;token:string;command:string;args:string[];cwd:string;logPath:string;status:'running'|'stopped'|'unknown';startedAt:string};
export type ExecutionEvent={type:string;message:string;data?:Record<string,unknown>};
export const agentResultSchema=z.object({outcome:z.enum(['completed','blocked']),summary:z.string(),reason:z.string().optional(),usage:z.object({inputTokens:z.number(),outputTokens:z.number(),cachedInputTokens:z.number().optional()}).optional()});
export type AgentExecutionResult=z.infer<typeof agentResultSchema>;
export type AgentExecutionRequest={runId:string;attemptId:string;workspacePath:string;request:string;kind:RunKind;attemptNumber:number;feedback:string[];scenarioSummary:string;demo:boolean;dataDir:string;model?:ModelSelection;source?:ProjectProfile['source']};
export interface AgentDriver{id:string;execute(request:AgentExecutionRequest,context:{signal:AbortSignal;emit:(event:ExecutionEvent)=>Promise<void>}):Promise<AgentExecutionResult>;}
export type VerificationContext={run:Run;candidate:CandidateRef;workspacePath:string;signal:AbortSignal;execute:(command:Command)=>Promise<{exitCode:number;output:string;logPath:string}>};
export interface VerificationCheck{id:string;version:string;run(context:VerificationContext):Promise<VerificationResult>;}
export type ScenarioDiscoveryContext={repository:string;profile:ProjectProfile};
export interface ScenarioProvider{id:string;listScenarios(context:ScenarioDiscoveryContext):Promise<ScenarioDefinition[]>;}
export type FilePayload={relativePath:string;mediaType:string;name:string;size:number;sha256:string};
export type RunDetail={run:Run;artifacts:Artifact[];events:ActivityEvent[];attempts:StageAttempt[];diff:string};
