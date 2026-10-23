import type { RepositoryResult } from '../repository-result.js';

/** 操作层统一将存储结果转换为业务结果或明确错误。 */
export function requireFound<T>(
  result: RepositoryResult<T>,
  subject: '项目' | '任务'
): T {
  if (result.state === 'missing') throw new Error(`${subject}不存在`);
  if (result.state === 'archived') throw new Error(`${subject}已归档`);

  return result.value;
}
