import { readFile } from 'node:fs/promises';
import type { PoolConfig } from 'pg';
import z from '@deepseek-ai/schemastery';

/** 连接已有 PostgreSQL；凭据由调用方的配置存储管理。 */
export const databaseConfig = z.object({
  host: z.string().pattern(/\S/).default('127.0.0.1').description('数据库主机名或 IP'),
  port: z.number().step(1).min(1).max(65535).default(5432).description('数据库端口'),
  database: z.string().pattern(/\S/).default('sagitta_tasks').description('数据库名称'),
  user: z.string().pattern(/\S/).default('sagitta').description('数据库用户名'),
  password: z.string().role('secret').default('').description('数据库密码'),
  ssl: z.boolean().default(false).description('启用 TLS 并验证服务器证书'),
  caFile: z.string().description('可选：自定义 CA 证书文件路径'),
}).required();

export type TaskDatabaseConfig = ReturnType<typeof databaseConfig>;

export async function createPoolConfig(
  config: TaskDatabaseConfig,
): Promise<PoolConfig> {
  if (config.caFile && !config.ssl) throw new Error('使用 CA 证书时须启用 TLS');

  const { host, port, database, user, password } = config;
  const ssl: PoolConfig['ssl'] = config.ssl ? { rejectUnauthorized: true } : false;
  if (ssl && config.caFile) ssl.ca = await readFile(config.caFile, 'utf8');

  return { host, port, database, user, password, ssl };
}
