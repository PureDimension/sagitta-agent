import { z } from "zod";

const sessionIdSchema = z.intersection(z.string(), z.unknown());
const stateSchema = z.object({
  enabled: z.boolean().readonly(),
  mode: z.union([z.literal("auto"), z.literal("chat")]).readonly(),
  idleSince: z.union([z.number(), z.null()]).readonly(),
  injectedAt: z.union([z.number(), z.null()]).readonly(),
  ready: z.boolean().readonly(),
  hasPendingWork: z.boolean().readonly(),
  stoppedByProtocol: z.boolean().readonly(),
  agentStatus: z.string().readonly(),
  degraded: z.boolean().readonly(),
  degradedReason: z.union([z.string(), z.null()]).readonly()
});
const taskSchema = z.object({
  text: z.string().readonly(),
  done: z.boolean().readonly()
});
const pendingRequestSchema = z.object({
  title: z.string().readonly(),
  hasCheckbox: z.boolean().readonly(),
  body: z.string().readonly(),
  type: z.union([z.literal("need"), z.literal("notify")]).readonly(),
  needHumanId: z.string().readonly()
}).readonly();
const needHumanResolutionSchema = z.object({
  needHumanId: z.string().readonly(),
  taskId: z.string().readonly(),
  type: z.union([z.literal("need"), z.literal("notify")]).readonly(),
  status: z.string().readonly()
}).readonly();
const tasksSchema = z.object({
  path: z.string().readonly(),
  updatedAt: z.union([z.number(), z.null()]).readonly(),
  source: z.union([z.literal("cloud"), z.literal("file"), z.literal("file-stale")]).readonly().optional(),
  sections: z.array(z.object({
    title: z.string().readonly(),
    items: z.array(taskSchema).readonly()
  }).readonly()).readonly(),
  pendingRequests: z.array(pendingRequestSchema).readonly().optional(),
  error: z.string().readonly().optional()
});
const remoteMethod = (id, method, parameters, result, sourceLocation) => ({
  id: `@sagitta/auto-advance#sagittaAutoAdvance/${method}`,
  service: "sagittaAutoAdvance",
  namespace: "sagittaAutoAdvance",
  method,
  invocation: { kind: "direct" },
  parameters,
  result: { mode: "strict", typeSymbol: result.typeSymbol, schema: result.schema },
  sourceLocation
});
const lookupAgent = {
  name: "agent",
  wire: "agentId",
  source: "lookup",
  lookup: "agent",
  codec: { mode: "strict", typeSymbol: "@deepseek-ai/dsh-session/types#SessionId", schema: sessionIdSchema }
};
const jsonBoolean = {
  name: "enabled",
  wire: "enabled",
  source: "json",
  codec: { mode: "strict", typeSymbol: "@sagitta/auto-advance#boolean", schema: z.boolean() }
};
const jsonNeedHumanId = {
  name: "needHumanId",
  wire: "needHumanId",
  source: "json",
  codec: { mode: "strict", typeSymbol: "@sagitta/auto-advance#string", schema: z.string() }
};

export const TYPERT = {
  package: "@sagitta/auto-advance",
  face: "host",
  schemas: [],
  invocations: [
    remoteMethod("getState", "getState", [lookupAgent], { typeSymbol: "@sagitta/auto-advance/client#AutoAdvanceState", schema: stateSchema }, { file: "lib/service.js", line: 227, column: 3 }),
    remoteMethod("setMode", "setMode", [lookupAgent, jsonBoolean], { typeSymbol: "@sagitta/auto-advance/client#AutoAdvanceState", schema: stateSchema }, { file: "lib/service.js", line: 231, column: 3 }),
    remoteMethod("getTasks", "getTasks", [], { typeSymbol: "@sagitta/auto-advance/client#TaskSnapshot", schema: tasksSchema }, { file: "lib/service.js", line: 248, column: 3 }),
    remoteMethod("resolveNeedHuman", "resolveNeedHuman", [jsonNeedHumanId], { typeSymbol: "@sagitta/auto-advance/client#NeedHumanResolution", schema: needHumanResolutionSchema }, { file: "lib/service.js", line: 449, column: 3 })
  ],
  model: {
    services: [{
      description: "Per-session autonomous continuation controller for Sagitta.",
      summary: "Per-session autonomous continuation controller for Sagitta.",
      tags: [],
      jsDoc: "/** Per-session autonomous continuation controller for Sagitta. */",
      key: "sagittaAutoAdvance",
      exportName: "AutoAdvanceService",
      members: [
        { kind: "method", name: "getState", signature: "@Remote('getState') getState(agent: Agent): AutoAdvanceState", summary: "Read one session's current autonomous-continuation state." },
        { kind: "method", name: "setMode", signature: "@Remote('setMode') setMode(agent: Agent, enabled: boolean): AutoAdvanceState", summary: "Persist and apply the session's autonomous-continuation mode." },
        { kind: "method", name: "getTasks", signature: "@Remote('getTasks') getTasks(): TaskSnapshot", summary: "Read the configured Markdown task list." },
        { kind: "method", name: "resolveNeedHuman", signature: "@Remote('resolveNeedHuman') resolveNeedHuman(needHumanId: string): NeedHumanResolution", summary: "Resolve a notify need-human from the Ripple floating panel." }
      ],
      types: [
        { name: "AutoAdvanceState", declaration: "export interface AutoAdvanceState { readonly enabled: boolean; readonly mode: 'auto' | 'chat'; readonly idleSince: number | null; readonly injectedAt: number | null; readonly ready: boolean; readonly hasPendingWork: boolean; readonly stoppedByProtocol: boolean; readonly agentStatus: string; readonly degraded: boolean; readonly degradedReason: string | null; }" },
        { name: "TaskSnapshot", declaration: "export interface TaskSnapshot { readonly path: string; readonly updatedAt: number | null; readonly source?: 'cloud' | 'file' | 'file-stale'; readonly sections: readonly { readonly title: string; readonly items: readonly { readonly text: string; readonly done: boolean; }[]; }[]; readonly pendingRequests?: readonly { readonly title: string; readonly hasCheckbox: boolean; readonly body: string; readonly type: 'need' | 'notify'; readonly needHumanId: string; }[]; readonly error?: string; }" },
        { name: "NeedHumanResolution", declaration: "export interface NeedHumanResolution { readonly needHumanId: string; readonly taskId: string; readonly type: 'need' | 'notify'; readonly status: string; }" }
      ]
    }],
    events: [],
    objects: []
  }
};

export default TYPERT;
