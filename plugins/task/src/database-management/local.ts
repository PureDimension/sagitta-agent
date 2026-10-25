import { execFile, type ExecFileException } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { appendFile, readFile, realpath, rm } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { escapeIdentifier } from 'pg';
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { openDatabase } from '@sagitta/runtime/database';
import { databaseConfig, type TaskDatabaseConfig } from '../runtime/database-config.js';
import { preparePostgresRuntime } from './runtime.js';

const executeFile = promisify(execFile);
const processOptions = { timeout: 60_000, windowsHide: true };

/** 准备本地实例并返回连接配置；任务表初始化由外层继续处理。 */
export async function prepareLocalDatabase(
  directory: string,
  report: (
    message: string,
  ) => void,
): Promise<TaskDatabaseConfig> {
  const root = resolve(directory);
  const runtime = await preparePostgresRuntime(root, report);
  const dataDirectory = join(root, 'data');
  const configFile = join(root, 'connection.json');

  return withFileLock(configFile, async () => {
    let config: TaskDatabaseConfig;
    if (existsSync(configFile)) {
      config = databaseConfig(JSON.parse(await readFile(configFile, 'utf8')));
      if (!existsSync(join(dataDirectory, 'PG_VERSION'))) throw new Error('本地数据库数据不完整，请检查指定目录');
      report(`读取本地数据库配置：${configFile}`);
    } else {
      if (existsSync(dataDirectory)) throw new Error('已有数据库数据但缺少 connection.json，请先核对原配置');
      config = databaseConfig({ port: await findAvailablePort(), password: randomBytes(32).toString('base64url') });
      report(`初始化本地 PostgreSQL 数据：${dataDirectory}`);

      // 密码文件仅当前用户可读；初始化命令参数与日志均不包含密码正文。
      const passwordFile = join(root, 'init-password');
      await writeFileAtomic(passwordFile, `${config.password}\n`, { mode: 0o600 });
      try {
        const { stdout } = await executeFile(runtime.initdb, ['-D', dataDirectory, '-U', config.user,
          '--auth=scram-sha-256', '--encoding=UTF8', '--locale=C', `--pwfile=${passwordFile}`], processOptions);
        report(stdout.trim());
      } finally {
        await rm(passwordFile);
      }
      await appendFile(join(dataDirectory, 'postgresql.conf'),
        `\nlisten_addresses = '127.0.0.1'\nport = ${config.port}\nunix_socket_directories = ''\n`);
      await writeFileAtomic(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    }

    if (await isRunning(runtime.pg_ctl, dataDirectory)) {
      report('本地 PostgreSQL 已运行，复用现有实例');
    } else {
      report(`启动本地 PostgreSQL：127.0.0.1:${config.port}`);
      await executeFile(runtime.pg_ctl, ['-D', dataDirectory, '-l', join(root, 'postgres.log'), '-w', '-t', '30', 'start'], processOptions);
    }

    const admin = await openDatabase({ ...config, database: 'postgres' }, (
      error,
    ) => report(error.message));
    try {
      const result = await admin.query('SHOW data_directory');
      if (await realpath(result.rows[0].data_directory) !== await realpath(dataDirectory)) {
        throw new Error('连接到了其他 PostgreSQL 实例，停止本地数据库准备');
      }
      const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [config.database]);
      if (existing.rowCount === 0) {
        report(`创建数据库：${config.database}`);
        await admin.query(`CREATE DATABASE ${escapeIdentifier(config.database)}`);
      }
    } finally {
      await admin.close();
    }
    report(`本地数据库已就绪：${config.host}:${config.port}/${config.database}`);
    return config;
  }, { waitMs: 120_000 });
}

async function isRunning(
  control: string,
  dataDirectory: string,
): Promise<boolean> {
  try {
    await executeFile(control, ['-D', dataDirectory, 'status'], processOptions);
    return true;
  } catch (error) {
    if ((error as ExecFileException).code === 3) return false;
    throw error;
  }
}

async function findAvailablePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((
    done,
  ) => server.close(() => done()));
  return port;
}
