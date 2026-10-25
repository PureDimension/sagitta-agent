import { Service, type Context } from '@deepseek-ai/cordis';
import { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include';
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry';
import { load } from 'js-yaml';
import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { preparePresetProfile, presetEntryId } from './profile.js';
import { prepareRelease } from './release.js';

// 复用官方预设中单个插件的类型，保持与注册接口一致。
type PresetPlugin = PresetDefinition['plugins'][number];
// 本仓库 sagitta.json 的结构；读取后由 updater 组合为 DSH 预设。
interface SagittaConfig {
  preset: Pick<PresetDefinition, 'id' | 'name' | 'description'> & { prompt: string };
  plugins: PresetPlugin[];
}

export default class Updater {
  static inject = ['loader', 'pluginPackages'];

  constructor(
    private readonly ctx: Context,
  ) {}

  async *[Service.init]() {
    const { ctx } = this;
    try {
      const { directory, tag } = await prepareRelease(ctx);
      const { preset, plugins }: SagittaConfig = JSON.parse(
        await readFile(join(directory, 'sagitta.json'), 'utf8'),
      );
      const { prompt, ...definition } = preset;
      const require = createRequire(join(directory, 'package.json'));
      // 读取官方预设的一份副本，在内存中替换 persona 并追加 Sagitta 插件。
      const standardUrl = import.meta.resolve('@deepseek-ai/dsh-web-app/presets/standard.patch.yml');
      const standard = load(await readFile(new URL(standardUrl), 'utf8'), {
        schema: entryListSchema,
      }) as PatchOptions[];
      const presetPlugins: PresetPlugin[] = standard[0].insert![0].config.plugins;
      const persona = presetPlugins.find((
        plugin
      ) => plugin.id === 'persona');
      if (!persona) throw new Error('DSH standard preset is missing persona');
      persona.config.prefix = await readFile(join(directory, prompt), 'utf8');
      for (const plugin of plugins) {
        if (!plugin.id) throw new Error('Sagitta 插件必须声明稳定的 id，才能关联用户配置');
        const entry = require.resolve(plugin.name);
        await access(entry);
        const name = pathToFileURL(entry).href;
        presetPlugins.push({ ...plugin, name });
      }
      // 更新白名单：Sagitta 身份提示词，以及发布清单显式登记的业务插件。
      const managedPluginIds = ['persona', ...plugins.map((
        plugin,
      ) => plugin.id!)];
      await preparePresetProfile(ctx, {
        ...definition,
        plugins: presetPlugins,
      }, managedPluginIds);
      yield ctx.on('loader/partial-dispose', (
        entry,
      ) => {
        if (entry.options.id === presetEntryId) {
          ctx.logger.info('Sagitta 配置发生变化；请手动重启 DSH，让已有会话使用新配置');
        }
      });
      // 官方预设声明等待这个就绪信号，确保安装、配置准备完成后才加载业务插件。
      yield ctx.provide('sagittaReady', true);
      ctx.logger.info('Sagitta 准备完成：%s；以后修改插件配置并保存后，请手动重启 DSH', tag);
    } catch (error) {
      ctx.logger.error('Sagitta startup failed', error);
    }
  }
}
