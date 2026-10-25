import type { Context } from '@deepseek-ai/cordis';
import { getDshRuntimeVersion, readProfileManifest, resolveBundleDir } from '@deepseek-ai/dsh-app-boot';
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { runPluginCommand } from '@deepseek-ai/dsh-plugin-manager/operations';
import z from '@deepseek-ai/schemastery';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const releasesUrl = 'https://github.com/PureDimension/sagitta-agent/releases';
const runtimePackage = '@sagitta/runtime';
const releaseSchema = z.object({
  tag: z.string().pattern(/^v[^/\\]+$/).required(),
  dirty: z.const(false).required(),
  dsh: z.string().required(),
  packages: z.object({
    runtime: z.object({
      file: z.string().pattern(/^sagitta-runtime-[\w.+-]+\.tgz$/).required(),
      sha256: z.string().pattern(/^[a-f0-9]{64}$/).required(),
    }).required(),
  }).required(),
});

async function request(
  url: string,
): Promise<Response> {
  // DSH 启动器已为全局 fetch 设置代理；这里仅限制单次请求时间。
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Sagitta 下载失败：HTTP ${response.status}，${url}`);
  return response;
}

/** 获取已编译的正式发布包；安装与依赖解析交给 DSH，不在使用端编译。 */
export async function prepareRelease(
  ctx: Context,
): Promise<{ directory: string; tag: string }> {
  const profile = ctx.profileContext;
  ctx.logger.info('检查 Sagitta 最新正式 Release');
  const release = releaseSchema(await (await request(`${releasesUrl}/latest/download/release.json`)).json());
  if (release.dsh !== getDshRuntimeVersion()) {
    throw new Error(`Sagitta ${release.tag} 需要 DSH ${release.dsh}，当前为 ${getDshRuntimeVersion()}`);
  }

  const version = release.tag.slice(1);
  const dependencies = readProfileManifest('sagitta', profile.dir).dependencies;
  if (dependencies?.[runtimePackage]) {
    const directory = resolveBundleDir('sagitta', runtimePackage, profile.installAnchor, profile.dir);
    const installed = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    if (installed.version === version) {
      ctx.logger.info('Sagitta %s 已安装，跳过下载和安装', release.tag);
      return { directory, tag: release.tag };
    }
  }

  const asset = release.packages.runtime;
  ctx.logger.info('下载 Sagitta %s 运行包', release.tag);
  const response = await request(`${releasesUrl}/download/${encodeURIComponent(release.tag)}/${asset.file}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(archive).digest('hex') !== asset.sha256) {
    throw new Error(`Sagitta ${release.tag} 运行包 SHA-256 不匹配`);
  }
  // pnpm 会保存本地包路径，因此下载缓存保留在 profile 中，供后续依赖安装复用。
  const filename = join(profile.dir, 'sagitta-releases', asset.file);
  await writeFileAtomic(filename, archive, { mode: 0o600, dirMode: 0o700 });
  ctx.logger.info('运行包校验通过，使用 DSH 安装接口安装');
  const result = await runPluginCommand({
    profile: profile.name, dir: profile.dir, installAnchor: profile.installAnchor,
    cwd: profile.cwd, home: profile.home,
  }, ['add', filename, '--save-exact', '--ignore-scripts', '--config.auto-install-peers=false'], {
    ...profile.packageManager,
    execution: 'service', outputBytes: 65_536, idleTimeoutMs: 120_000,
    onOutput: (
      text,
    ) => ctx.logger.info(text.trimEnd()),
  });
  if (result.exitCode !== 0) {
    throw new Error(`Sagitta 安装失败：${result.output}\n完整日志：${result.logPath}`);
  }

  // 刷新官方模块解析表，随后由原有 sagittaReady 依赖控制业务插件加载。
  await ctx.pluginPackages.refresh();
  const directory = resolveBundleDir('sagitta', runtimePackage, profile.installAnchor, profile.dir);
  const installed = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  if (installed.version !== version) throw new Error('已安装的 Sagitta 版本与 Release 不一致');
  return { directory, tag: release.tag };
}
