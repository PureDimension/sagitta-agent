/** 说明更新方式；追加保留传入文本的原样格式。 */
export type DescriptionWriteMode = 'replace' | 'append';

/** 对外项目数据；归档内容由 Repository 截断。 */
export interface Project {
  id: string;
  name: string;
  description: string;
}

/** bigint 序号以字符串传递，避免超出 JavaScript 的安全整数范围。 */
export interface Task {
  id: string;
  projectId: string;
  kind: 'normal' | 'temp';
  title: string;
  description: string;
  status: 'open' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
}

/** 本次认领凭据，仅在认领成功及所属会话的工作上下文中提供。 */
export interface ClaimedTask extends Task {
  claimId: string;
}

export interface ClaimedProject extends Project {
  tasks: ClaimedTask[];
}

/** 认领身份由插件运行环境提供。 */
export interface TaskOwner {
  deviceId: string;
  sessionId: string;
}

/** 内部权限检查使用；过期情况由数据库时间计算，不向 AI 暴露。 */
export interface TaskClaim extends TaskOwner {
  expired: boolean;
}

/** 立即认领时必须同时提供当前设备和会话。 */
export type CreateTaskOptions =
  | { claimImmediately?: false }
  | { claimImmediately: true; owner: TaskOwner };

interface TaskContent {
  projectId: string;
  title: string;
  description?: string;
}

/** 临时任务必须带当前身份，正式任务可选择立即认领。 */
export type CreateTaskInput =
  | (TaskContent & { kind: 'normal' } & CreateTaskOptions)
  | (TaskContent & { kind: 'temp'; owner: TaskOwner });

/** 已有单任务的统一操作入口；查看详情沿用原来的读取权限。 */
export type TaskOperation =
  | { action: 'get'; taskId: string }
  | { action: 'update'; taskId: string; owner: TaskOwner; description: string; mode?: DescriptionWriteMode }
  | { action: 'claim' | 'release' | 'complete' | 'block' | 'cancel' | 'delete'; taskId: string; owner: TaskOwner };

/** task 保存回收前的内容，owner 供接入层定位原认领会话。 */
export interface ExpiredTask {
  kind: 'expired';
  task: Task;
  owner: TaskOwner;
  message: string;
}

export type TaskOperationResult =
  | { kind: 'success'; value: Task | ClaimedTask | void }
  | ExpiredTask;
