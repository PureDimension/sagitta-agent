import { Service } from '@deepseek-ai/cordis';
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include';
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot';
import z from '@deepseek-ai/schemastery';
import { load } from 'js-yaml';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const repository = 'https://github.com/PureDimension/sagitta-agent.git';

export default class Updater {
  static inject = ['agentPresets'];
  static Config = z.object({ branch: z.string().default('main') });

  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
  }

  async *[Service.init]() {
    const { ctx, config } = this;
    try {
      const directory = join(ctx.profileContext.dir, 'sagitta-source');
      const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY
        || process.env.all_proxy || process.env.HTTP_PROXY || process.env.http_proxy
        || process.env.PROXY || process.env.proxy;
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0',
        ...(proxy ? { https_proxy: proxy, http_proxy: proxy, npm_config_proxy: proxy, npm_config_https_proxy: proxy } : {}) };
      const run = async (command, args) => {
        try {
          return (await exec(command, args, { cwd: directory, env, timeout: 120000,
            maxBuffer: 1048576, windowsHide: true })).stdout.trim();
        } catch (error) {
          throw new Error(`${command} ${args[0]} failed (${error.code ?? error.signal}); check network/proxy or local checkout`);
        }
      };
      await mkdir(directory, { recursive: true });
      await run('git', ['init', '--quiet']);
      ctx.logger.info('Checking Sagitta branch %s', config.branch);
      await run('git', ['fetch', '--depth=1', repository, config.branch]);
      const commit = await run('git', ['rev-parse', 'FETCH_HEAD']);
      const manifest = JSON.parse(await run('git', ['show', `${commit}:package.json`]));
      if (manifest.engines?.dsh !== getDshRuntimeVersion()) {
        throw new Error(`Sagitta requires DSH ${manifest.engines?.dsh}; running ${getDshRuntimeVersion()}`);
      }
      await run('git', ['checkout', '--detach', commit]);
      const install = ['install', '--omit=dev', '--ignore-scripts', '--package-lock=false', '--no-audit', '--no-fund'];
      if (process.platform === 'win32') await run('cmd.exe', ['/d', '/s', '/c', `npm ${install.join(' ')}`]);
      else await run('npm', install);

      const { preset, plugins } = JSON.parse(await readFile(join(directory, 'sagitta.json'), 'utf8'));
      const standardUrl = import.meta.resolve('@deepseek-ai/dsh-web-app/presets/standard.patch.yml');
      const standard = load(await readFile(new URL(standardUrl), 'utf8'), { schema: entryListSchema });
      const rows = standard[0].insert[0].config.plugins;
      rows.find(row => row.id === 'persona').config.prefix = await readFile(join(directory, preset.prompt), 'utf8');
      const require = createRequire(join(directory, 'package.json'));
      for (const plugin of plugins) rows.push({ ...plugin, name: pathToFileURL(require.resolve(plugin.name)).href });
      yield await ctx.extend({ baseUrl: standardUrl }).agentPresets.register({
        id: preset.id, name: preset.name, description: preset.description, plugins: rows,
      });
      ctx.logger.info('Sagitta prepared from GitHub commit %s', commit);
    } catch (error) {
      console.error('Sagitta startup failed: %s', error.message);
    }
  }
}
