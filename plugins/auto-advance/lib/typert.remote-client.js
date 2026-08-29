import { z } from "zod";

const sessionIdSchema = z.intersection(z.string(), z.unknown());
const stateSchema = z.object({
  enabled: z.boolean().readonly(),
  mode: z.union([z.literal("auto"), z.literal("chat")]).readonly(),
  idleSince: z.union([z.number(), z.null()]).readonly(),
  injectedAt: z.union([z.number(), z.null()]).readonly(),
  ready: z.boolean().readonly(),
  hasPendingWork: z.boolean().readonly(),
  stoppedByProtocol: z.boolean().readonly()
});
const taskSchema = z.object({
  text: z.string().readonly(),
  done: z.boolean().readonly()
});
const pendingRequestSchema = z.object({
  title: z.string().readonly(),
  hasCheckbox: z.boolean().readonly(),
  body: z.string().readonly()
}).readonly();
const tasksSchema = z.object({
  path: z.string().readonly(),
  updatedAt: z.union([z.number(), z.null()]).readonly(),
  sections: z.array(z.object({
    title: z.string().readonly(),
    items: z.array(taskSchema).readonly()
  }).readonly()).readonly(),
  pendingRequests: z.array(pendingRequestSchema).readonly().optional(),
  error: z.string().readonly().optional()
});

export const TYPERT_REMOTE = {
  package: "@sagitta/auto-advance",
  descriptors: [
    {
      id: "@sagitta/auto-advance#sagittaAutoAdvance/getState",
      service: "sagittaAutoAdvance",
      namespace: "sagittaAutoAdvance",
      method: "getState",
      invocation: { kind: "direct" },
      parameters: [{ name: "agent", wire: "agentId", source: "lookup", lookup: "agent", codec: { mode: "strict", typeSymbol: "@deepseek-ai/dsh-session/types#SessionId", schema: sessionIdSchema } }],
      result: { mode: "strict", typeSymbol: "@sagitta/auto-advance/client#AutoAdvanceState", schema: stateSchema }
    },
    {
      id: "@sagitta/auto-advance#sagittaAutoAdvance/setMode",
      service: "sagittaAutoAdvance",
      namespace: "sagittaAutoAdvance",
      method: "setMode",
      invocation: { kind: "direct" },
      parameters: [
        { name: "agent", wire: "agentId", source: "lookup", lookup: "agent", codec: { mode: "strict", typeSymbol: "@deepseek-ai/dsh-session/types#SessionId", schema: sessionIdSchema } },
        { name: "enabled", wire: "enabled", source: "json", codec: { mode: "strict", typeSymbol: "@sagitta/auto-advance#boolean", schema: z.boolean() } }
      ],
      result: { mode: "strict", typeSymbol: "@sagitta/auto-advance/client#AutoAdvanceState", schema: stateSchema }
    },
    {
      id: "@sagitta/auto-advance#sagittaAutoAdvance/getTasks",
      service: "sagittaAutoAdvance",
      namespace: "sagittaAutoAdvance",
      method: "getTasks",
      invocation: { kind: "direct" },
      parameters: [],
      result: { mode: "strict", typeSymbol: "@sagitta/auto-advance/client#TaskSnapshot", schema: tasksSchema }
    }
  ]
};

export default TYPERT_REMOTE;
