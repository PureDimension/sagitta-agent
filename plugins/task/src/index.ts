import { Service, type Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-app-boot';
import { join } from 'node:path';
import { taskConfig, type TaskPluginConfig } from './config.js';
import { prepareLocalDatabase } from './database-management/local.js';
import { connectTaskDatabase } from './runtime/connection.js';
import { checkTaskSchema, initializeTaskSchema } from './schema.js';
import { TaskRepositories } from './repository/index.js';
import { createTransactionRunner } from './transaction.js';
import { ProjectOperations } from './service/operations/project.js';
import { TaskOperations } from './service/operations/task.js';
import { registerProjectTools } from './adapters/tools/project.js';
import { registerTaskTools } from './adapters/tools/task.js';
import { registerTaskGuidance } from './adapters/guidance.js';
import { registerTaskWorkContext } from './adapters/work-context.js';
import { registerTaskMaintenance } from './adapters/maintenance.js';
import { TaskRenewal } from './service/automation/renewal.js';
import { TaskReclamation } from './service/automation/reclamation.js';

/** 连接、业务装配和工具注册；配置变更由 DSH 卸载后重新初始化。 */
export default class TaskPlugin {
  static inject = ['tools', 'systemPrompt', 'agents', 'timer'];
  static Config = taskConfig;

  constructor(
    private readonly ctx: Context,
    private readonly config: TaskPluginConfig,
  ) {}

  async *[Service.init]() {
    const { ctx, config } = this;
    const directory = join(ctx.profileContext.dir, 'sagitta-task');

    try {
      // 原生 effect 统一持有资源：初始化中途失败也会撤销注册、关闭连接池。
      yield await ctx.effect(async function* () {
        const connection = config.mode === 'local'
          ? await prepareLocalDatabase(config.directory, (
            message,
          ) => ctx.logger.info(message))
          : config;
        ctx.logger.info(`连接任务数据库：${connection.host}:${connection.port}/${connection.database}`);
        const database = await connectTaskDatabase(connection, directory, (
          error
        ) => ctx.logger.error(error));
        yield () => database.close();
        if (config.mode === 'local') {
          ctx.logger.info('检查并初始化本地任务表');
          await initializeTaskSchema(database);
        }
        await checkTaskSchema(database);

        const repository = new TaskRepositories(database);
        const transaction = createTransactionRunner(database);
        const projects = new ProjectOperations(repository, transaction);
        const tasks = new TaskOperations(repository, transaction);

        yield* registerProjectTools(ctx, projects);
        yield* registerTaskTools(ctx, tasks);
        yield registerTaskGuidance(ctx);
        yield* registerTaskWorkContext(ctx, tasks);
        yield* registerTaskMaintenance(ctx, new TaskRenewal(repository), new TaskReclamation(transaction));
      }, 'Sagitta task initialization');

      ctx.logger.info('Sagitta 任务数据库检查通过，主动工具已注册');
    } catch (error) {
      ctx.logger.error('Sagitta 任务插件初始化失败', error);
    }
  }
}
