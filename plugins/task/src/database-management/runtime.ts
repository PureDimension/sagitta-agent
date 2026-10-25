import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';

const embeddedVersion = '18.4.0-beta.17';
const installationTimeoutMs = 10 * 60_000;
const executeFile = promisify(execFile);

export interface PostgresRuntime {
  moduleUrl: string;
  postgres: string;
  initdb: string;
  pg_ctl: string;
}

/** 仅准备指定目录内的程序；数据库数据初始化和进程管理由上层负责。 */
export async function preparePostgresRuntime(
  directory: string,
  report: (
    message: string,
  ) => void,
): Promise<PostgresRuntime> {
  const root = resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });

  // 复用 DSH 跨进程文件锁，避免两个启动过程同时安装到同一目录。
  return withFileLock(join(root, 'runtime-install'), async () => {
    const runtimeDirectory = join(root, 'runtime');
    const readyFile = join(runtimeDirectory, 'ready');
    const platform = process.platform === 'win32' ? 'windows' : process.platform;
    const binaryPackage = `@embedded-postgres/${platform}-${process.arch}`;
    const require = createRequire(join(runtimeDirectory, 'package.json'));

    if (existsSync(readyFile)) {
      if (await readFile(readyFile, 'utf8') !== embeddedVersion) {
        throw new Error('本地 PostgreSQL 程序版本与当前实现不匹配，请显式处理升级');
      }
      report(`复用本地 PostgreSQL 程序：${runtimeDirectory}`);
    } else {
      await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
      if ((await readdir(runtimeDirectory)).length > 0) {
        throw new Error(`PostgreSQL 程序目录不完整，请检查后重试：${runtimeDirectory}`);
      }
      report(`准备本地 PostgreSQL 程序，首次需要下载：${runtimeDirectory}`);
      await writeFileAtomic(join(runtimeDirectory, 'package.json'), '{"private":true}\n', { mode: 0o600 });

      // 所有命令参数均由代码生成；Windows 的 npm.cmd 通过 cmd 执行。
      const args = ['install', '--ignore-scripts', '--no-save', '--package-lock=false', '--no-audit', '--no-fund',
        `embedded-postgres@${embeddedVersion}`, `${binaryPackage}@${embeddedVersion}`];
      const windows = process.platform === 'win32';
      await executeFile(windows ? 'cmd.exe' : 'npm', windows ? ['/d', '/s', '/c', `npm ${args.join(' ')}`] : args, {
        cwd: runtimeDirectory, timeout: installationTimeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
      });

      // 仅运行已选定平台包的符号链接恢复脚本，其余依赖安装脚本保持禁用。
      const binaryDirectory = dirname(dirname(require.resolve(binaryPackage)));
      await executeFile(process.execPath, [join(binaryDirectory, 'scripts/hydrate-symlinks.js')], {
        cwd: binaryDirectory, timeout: 30_000, windowsHide: true,
      });
    }

    const programs = await import(pathToFileURL(require.resolve(binaryPackage)).href) as
      Pick<PostgresRuntime, 'postgres' | 'initdb' | 'pg_ctl'>;
    const moduleUrl = pathToFileURL(require.resolve('embedded-postgres')).href;
    const { stdout } = await executeFile(programs.postgres, ['--version'], { timeout: 10_000, windowsHide: true });
    await writeFileAtomic(readyFile, embeddedVersion, { mode: 0o600 });
    report(`本地 PostgreSQL 程序已就绪：${stdout.trim()}`);
    return { moduleUrl, postgres: programs.postgres, initdb: programs.initdb, pg_ctl: programs.pg_ctl };
  }, { waitMs: installationTimeoutMs });
}
