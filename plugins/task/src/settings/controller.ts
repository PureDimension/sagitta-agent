import type { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { TaskSettingsService, type TaskSettingsUpdate } from './service.js';

/** 宿主级设置入口，与会话内的任务插件实例分开挂载。 */
export default class SagittaSettings extends TypertRemoteService {
  static inject = ['configEditor', 'profileContext'];

  private readonly tasks: TaskSettingsService;

  constructor(
    ctx: Context,
  ) {
    super(ctx, 'sagittaSettings');
    this.tasks = new TaskSettingsService(ctx.configEditor, ctx.profileContext);
  }

  @Remote
  readTask() {
    return this.tasks.read();
  }

  @Remote
  saveTask(
    input: TaskSettingsUpdate,
  ) {
    return this.tasks.save(input);
  }
}
