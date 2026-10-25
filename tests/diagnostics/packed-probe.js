// 测试入口由验收脚本复制到隔离 profile 内，使用该 DSH 的原生模块解析。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

export default class PackedProbe {
  static inject = ['agentPresets', 'agents', 'tools', 'systemPrompt', 'timer', 'sessions', 'sagittaReady'];

  constructor(
    ctx,
  ) {
    ctx.timeout(() => {
      void this.verify(ctx).catch(async (
        error,
      ) => {
        await writeFile(process.env.SAGITTA_TEST_RESULT, JSON.stringify({ error: error.stack }));
      });
    }, 0);
  }

  async verify(
    ctx,
  ) {
    await ctx.loader.await();
    assert.equal((await ctx.agentPresets.resolve('sagitta')).broken, undefined);
    const statePath = join(process.env.DSH_HOME, 'acceptance-state.json');
    const resume = process.env.SAGITTA_TEST_PHASE === 'resume';
    const state = resume ? JSON.parse(await readFile(statePath, 'utf8')) : { sessionId: `session-${randomUUID()}` };
    const selection = { provider: 'deepseek-official', model: 'deepseek-flash' };
    const setup = async (
      agentCtx,
    ) => {
      await ctx.agentPresets.mount(agentCtx, 'sagitta');
      installModelSelection(agentCtx, { current: selection, assembled: undefined });
    };
    const handle = resume
      ? await ctx.agents.resume({ resumeSessionId: state.sessionId, agentOptions: selection, setup })
      : await ctx.agents.create({ sessionId: state.sessionId, meta: { cwd: process.cwd(), agentPreset: 'sagitta' }, agentOptions: selection, setup });
    const agent = handle.agent;
    const names = ctx.tools.schemas(agent).map((
      tool,
    ) => tool.name);
    assert.ok(names.includes('task_create'));
    const call = async (
      name,
      args,
    ) => {
      const result = await ctx.tools.execute({ name, arguments: args, agent, callId: randomUUID(), signal: new AbortController().signal });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return result.value;
    };
    if (resume) {
      const current = await call('task_get', { taskId: state.taskId });
      assert.equal(current.task.status, 'in_progress');
      await call('task_complete', { taskId: state.taskId });
      assert.equal((await call('task_get', { taskId: state.taskId })).task.status, 'done');
      await call('project_delete', { projectId: state.projectId });
    } else {
      const project = await call('project_create', { name: '打包版本验收项目', description: '隔离测试' });
      const task = await call('task_create', { projectId: project.id, kind: 'normal', title: '重启恢复验收', claimImmediately: true });
      state.projectId = project.id;
      state.taskId = task.id;
      const context = await ctx.systemPrompt.assemble({ scope: agent, agent });
      assert.ok(JSON.stringify(context).includes('重启恢复验收'));
      if (process.env.SAGITTA_TEST_ENV_FILE) {
        agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '这是一轮隔离验收。只调用 project_list 工具一次，简短报告项目名称即可。不要执行其他操作。' }] }));
        await agent.whenIdle();
        const events = Array.from({ length: agent.session.seq }, (
          _,
          index,
        ) => agent.session.eventAt(index));
        const end = events.findLast((
          event,
        ) => event.type === 'turn/end');
        assert.equal(end?.data.reason.kind, 'completed', JSON.stringify(end));
        const toolCall = events.find((
          event,
        ) => event.type === 'tool/call' && event.data.name === 'project_list');
        assert.ok(toolCall, '模型应真实调用项目工具');
        assert.ok(events.some((
          event,
        ) => event.type === 'tool/result' && event.data.message.toolCallId === toolCall.data.callId
          && !event.data.message.isError), '模型调用应取得成功的工具结果');
      }
      await writeFile(statePath, JSON.stringify(state));
    }
    await ctx.sessions.flush(agent.session);
    await handle.dispose();
    await writeFile(process.env.SAGITTA_TEST_RESULT, JSON.stringify({ ok: true, phase: resume ? 'resume' : 'create', sessionId: state.sessionId, taskId: state.taskId, toolCount: names.length }));
  }
}
