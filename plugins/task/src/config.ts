import z from '@deepseek-ai/schemastery';
import { databaseConfig } from './runtime/database-config.js';

/** 原生条件配置：本地模式只填目录，自定义模式填写连接字段。 */
export const taskConfig = z.intersect([
  z.object({
    mode: z.union([
      z.const('custom').description('自定义连接'),
      z.const('local').description('本地目录'),
    ]).default('custom').description('数据库位置'),
  }),
  z.union([
    z.object({
      mode: z.const('local').required(),
      directory: z.string().pattern(/\S/).required().description('本地数据库目录（程序、数据与连接配置）'),
    }),
    z.intersect([z.object({ mode: z.const('custom').default('custom') }), databaseConfig]),
  ]),
]).description('修改配置并保存后，请手动重启 DSH，让已有会话使用新配置。');

export type TaskPluginConfig = ReturnType<typeof taskConfig>;
