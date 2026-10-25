import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import TimerService from '@deepseek-ai/cordis-plugin-timer';

/** 使用真实 DSH 注册、参数/输出校验和错误转换；测试无需启动 LLM。 */
export async function createToolContext(
  directory,
) {
  const ctx = new Context();
  ctx.provide('profileContext', { dir: directory });
  try {
    await ctx.plugin(SystemPrompt, {}).await();
    await ctx.plugin(ToolRuntime, {}).await();
    await ctx.plugin(AgentRegistry).await();
    await ctx.plugin(TimerService).await();
    return ctx;
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}
