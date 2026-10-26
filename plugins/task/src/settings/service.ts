import type { ConfigEditor } from '@deepseek-ai/dsh-config-editor';
import { composeEntries, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot';
import { taskConfig, type TaskPluginConfig } from '../config.js';

type PublicConfig<Config> = Config extends { password: string } ? Omit<Config, 'password'> : Config;
export type TaskSettingsConfig = PublicConfig<TaskPluginConfig>;
export type TaskSettingsUpdate = TaskSettingsConfig & { password?: string };

export interface TaskSettingsView {
  config: TaskSettingsConfig;
  passwordConfigured: boolean;
}

interface PresetConfig extends Record<string, unknown> {
  plugins: { id?: string; config?: Parameters<typeof taskConfig>[0] }[];
}

/** GUI 后端：配置仍由原生预设持有，文件锁、保存和加载交给 ConfigEditor。 */
export class TaskSettingsService {
  constructor(
    private readonly editor: Pick<ConfigEditor, 'entries' | 'edit'>,
    private readonly profile: ProfileContext,
  ) {}

  read(): TaskSettingsView {
    this.preset();
    const config = taskConfig(this.task(this.configuration()).config);
    if (config.mode === 'local') {
      return { config: { mode: 'local', directory: config.directory }, passwordConfigured: false };
    }

    const { password, ...fields } = config;
    return { config: fields, passwordConfigured: password.length > 0 };
  }

  async save(
    input: TaskSettingsUpdate,
  ): Promise<TaskSettingsView> {
    await this.editor.edit(this.preset(), () => {
      // 读取持久配置；原生 Loader 中的实例可能仍使用保存前的配置。
      const preset = this.configuration();
      const task = this.task(preset);
      const previous = taskConfig(task.config);
      // 未提交密码表示保留；显式空字符串表示清空。密码只在服务端合并。
      const password = input.password === undefined && previous.mode === 'custom'
        ? previous.password : input.password;
      const config = taskConfig(input.mode === 'local'
        ? { mode: 'local', directory: input.directory }
        : { ...input, password });

      return { ...preset, plugins: preset.plugins.map((
        plugin,
      ) => plugin === task ? { ...plugin, config } : plugin) };
    });

    return this.read();
  }

  private preset() {
    const entry = this.editor.entries().find((
      candidate,
    ) => candidate.options.id === 'preset-sagitta');
    if (!entry) throw new Error('Sagitta 预设尚未就绪');
    return entry;
  }

  private configuration(): PresetConfig {
    const preset = composeEntries([readProfilePatches('sagitta', this.profile)]).find((
      candidate,
    ) => candidate.id === 'preset-sagitta');
    if (!preset) throw new Error('Sagitta 预设尚未就绪');
    return preset.config as PresetConfig;
  }

  private task(
    preset: PresetConfig,
  ) {
    const plugin = preset.plugins.find((
      candidate,
    ) => candidate.id === 'sagitta-task');
    if (!plugin) throw new Error('Sagitta 预设未配置任务插件');
    return plugin;
  }
}
