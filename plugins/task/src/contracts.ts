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
