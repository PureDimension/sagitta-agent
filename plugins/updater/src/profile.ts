import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/cordis-plugin-loader';
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry';
import { composeEntries, readProfilePatches } from '@deepseek-ai/dsh-app-boot';
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { isMap, isSeq, parseDocument, Scalar, visit } from 'yaml';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const presetEntryId = 'preset-sagitta';

/** 保存到 DSH 原生 profile；任务插件仍保留自己的 Config 和初始化逻辑。 */
export async function preparePresetProfile(
  ctx: Context,
  definition: PresetDefinition,
  managedPluginIds: string[],
): Promise<void> {
  const profile = ctx.profileContext;
  const entry = [...ctx.loader.entries()].find((
    candidate,
  ) => candidate.options.id === presetEntryId && candidate.parent.tree.ctx.fiber.entry?.id === 'include');
  if (!entry) throw new Error('缺少 Sagitta 预设声明，请重新安装 Updater');

  await withFileLock(join(profile.dir, 'package.json'), async () => {
    const current = composeEntries([readProfilePatches('sagitta', profile)]).find((
      candidate,
    ) => candidate.id === presetEntryId);
    if (current?.name !== '@deepseek-ai/dsh-agent-preset') throw new Error('Sagitta 预设声明不匹配');

    const source = await readFile(profile.patchPath, 'utf8');
    // 与官方配置编辑器一样保留 YAML 注释及 !!js 条件表达式。
    const document = parseDocument(source, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (
      value: string,
    ) => value }] });
    if (document.errors[0]) throw document.errors[0];
    if (!isSeq(document.contents)) throw new Error('DSH profile patch 必须是 YAML 列表');
    const index = document.contents.items.findLastIndex((
      item,
      index,
    ) => isMap(item) && document.getIn([index, 'id']) === presetEntryId && !item.has('insert'));

    const previous: PresetDefinition['plugins'] = current.config.plugins;
    // 仅首次配置空声明时填入官方默认组合；已有配置以本地清单为基础。
    const plugins = index < 0 && previous.length === 0 ? [...definition.plugins] : [...previous];
    for (const plugin of definition.plugins) {
      if (!managedPluginIds.includes(plugin.id!)) continue;
      const position = plugins.findIndex((
        existing,
      ) => existing.id === plugin.id);
      if (position < 0) {
        plugins.push(plugin);
        continue;
      }

      const config = { ...plugin.config, ...plugins[position].config };
      // 身份正文随发布更新；数据库连接等其他同名配置继续保留用户值。
      if (plugin.id === 'persona') config.prefix = plugin.config.prefix;
      plugins[position] = { ...plugin, config };
    }

    const config = { ...definition, plugins };

    if (!isDeepStrictEqual(current.config, config)) {
      if (index < 0) document.add({ id: presetEntryId, config });
      else document.setIn([index, 'config'], config);
      visit(document, { Map(
        _key,
        node,
      ) {
        if (node.items.length !== 1 || typeof node.get('__jsExpr') !== 'string') return;
        const expression = new Scalar(node.get('__jsExpr'));
        expression.tag = 'tag:yaml.org,2002:js';
        return expression;
      } });
      await writeFileAtomic(profile.patchPath, String(document), { mode: 0o600 });
      ctx.logger.info('Sagitta 预设与插件配置已保存：%s', profile.patchPath);
    }

    // 此时声明仍在等待 sagittaReady；只更新该条目，避免等待包含 Updater 自身的全局重载。
    await entry.update({ config });
  });
}
