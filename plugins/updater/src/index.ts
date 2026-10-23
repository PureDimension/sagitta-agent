import { Service, type Context } from '@deepseek-ai/cordis';
import { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include';
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry';
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot';
import { load } from 'js-yaml';
import { execFile, type ExecFileException } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

// 复用官方预设中单个插件的类型，保持与注册接口一致。
type PresetPlugin = PresetDefinition['plugins'][number];
// 本仓库 sagitta.json 的结构；读取后由 updater 组合为 DSH 预设。
interface SagittaConfig {
  preset: Pick<PresetDefinition, 'id' | 'name' | 'description'> & { prompt: string };
  plugins: PresetPlugin[];
}

// 将 Node 的回调式命令执行接口转换为可 await 的接口。
const execFileAsync = promisify(execFile);
const repository = 'https://github.com/PureDimension/sagitta-agent.git';
const updateBranch = 'stable';

export default class Updater {
  // Cordis 读取这个静态字段，等待预设注册服务就绪。
  static inject = ['agentPresets'];
  constructor(
    private readonly ctx: Context
  ) {}

  async *[Service.init]() {
    const { ctx } = this;
    try {
      const directory = join(ctx.profileContext.dir, 'sagitta-source');
      const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY
        || process.env.all_proxy || process.env.HTTP_PROXY || process.env.http_proxy
        || process.env.PROXY || process.env.proxy;
      const env = {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        ...(proxy ? { https_proxy: proxy, http_proxy: proxy,
          npm_config_proxy: proxy, npm_config_https_proxy: proxy } : {}),
      };
      const run = async (
        command: string,
        args: string[]
      ): Promise<string> => {
        try {
          const { stdout } = await execFileAsync(command, args, {
            cwd: directory, env, timeout: 120000,
            maxBuffer: 1048576, windowsHide: true,
          });
          return stdout.trim();
        } catch (error) {
          const failure = error as ExecFileException;
          throw new Error(`${command} ${args[0]} failed (${failure.code ?? failure.signal}); check network/proxy or local checkout`);
        }
      };
      await mkdir(directory, { recursive: true });
      await run('git', ['init', '--quiet']);
      ctx.logger.info('Checking Sagitta branch %s', updateBranch);
      await run('git', ['fetch', '--depth=1', repository, updateBranch]);
      const commit = await run('git', ['rev-parse', 'FETCH_HEAD']);
      const manifest = JSON.parse(await run('git', ['show', `${commit}:package.json`]));
      if (manifest.engines?.dsh !== getDshRuntimeVersion()) {
        throw new Error(`Sagitta requires DSH ${manifest.engines?.dsh}; running ${getDshRuntimeVersion()}`);
      }
      await run('git', ['checkout', '--detach', commit]);
      const { preset, plugins }: SagittaConfig = JSON.parse(
        await readFile(join(directory, 'sagitta.json'), 'utf8'),
      );
      const require = createRequire(join(directory, 'package.json'));
      // 记录构建成功的提交；同一提交的插件入口仍存在时，复用本地产物。
      const buildRecord = join(ctx.profileContext.dir, 'sagitta-built-commit');
      let needsBuild = true;
      try {
        if (await readFile(buildRecord, 'utf8') === commit) {
          for (const plugin of plugins) await access(require.resolve(plugin.name));
          needsBuild = false;
        }
      } catch {
        // 缺少构建记录或插件入口时，重新安装和编译。
      }
      if (needsBuild) {
        for (const args of [
          ['install', '--include=dev', '--ignore-scripts', '--package-lock=false', '--no-audit', '--no-fund'],
          ['run', 'build', '--if-present', '--ignore-scripts'],
        ]) {
          if (process.platform === 'win32') {
            await run('cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`]);
          } else {
            await run('npm', args);
          }
        }
        for (const plugin of plugins) await access(require.resolve(plugin.name));
        await writeFile(buildRecord, commit);
      }
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
      persona.config.prefix = await readFile(join(directory, preset.prompt), 'utf8');
      for (const plugin of plugins) {
        const name = pathToFileURL(require.resolve(plugin.name)).href;
        presetPlugins.push({ ...plugin, name });
      }
      // 将注册返回的注销函数交给 Cordis，在插件卸载时清理。
      yield await ctx.extend({ baseUrl: standardUrl }).agentPresets.register({
        id: preset.id, name: preset.name, description: preset.description,
        plugins: presetPlugins,
      });
      ctx.logger.info('Sagitta prepared from GitHub commit %s', commit);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Sagitta startup failed: %s', message);
    }
  }
}
