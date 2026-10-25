import type { InferValue, ValueSchemaSpec } from '@deepseek-ai/dsh-tools';
import type { TaskOperationResult } from '../../contracts.js';

export const projectSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    description: { type: 'string', required: true },
  },
} as const satisfies ValueSchemaSpec;

export const taskSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    projectId: { type: 'string', required: true },
    claimId: { type: 'string', description: '本次认领凭据；认领成功时返回，供跨模块资源访问使用。' },
    kind: { type: 'string', enum: ['normal', 'temp'], required: true },
    title: { type: 'string', required: true },
    description: { type: 'string', required: true },
    status: { type: 'string', enum: ['open', 'in_progress', 'blocked', 'done', 'cancelled'], required: true },
  },
} as const satisfies ValueSchemaSpec;

export const messageSchema = {
  type: 'object', additionalProperties: false,
  properties: { message: { type: 'string', required: true } },
} as const satisfies ValueSchemaSpec;

export const taskResultSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['success', 'expired'], required: true },
    task: { oneOf: [taskSchema, { type: 'null' }], required: true },
    message: { type: 'string', required: true },
  },
} as const satisfies ValueSchemaSpec;

/** 共用模型展示；结构化结果仍由 DSH 校验并保留，供原生工具及 PTC 使用。 */
export function jsonOutput<const S extends ValueSchemaSpec>(
  schema: S,
) {
  return {
    schema,
    render(
      _args: unknown,
      value: InferValue<S>,
    ) {
      return [{ type: 'text' as const, text: JSON.stringify(value) }];
    },
  };
}

/** 到期时 task 是回收前的内容；内部 owner 仅用于后续通知路由。 */
export function formatTaskResult(
  result: TaskOperationResult,
  successMessage: string,
): InferValue<typeof taskResultSchema> {
  if (result.kind === 'expired') {
    return { kind: 'expired', task: result.task, message: result.message };
  }

  return { kind: 'success', task: result.value ?? null, message: successMessage };
}
