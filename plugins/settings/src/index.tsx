import React, { useEffect, useState, type FormEvent } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type { TaskSettingsUpdate, TaskSettingsView } from '../../task/src/settings/service.js';

async function request(
  ctx: Context,
  method: 'readTask' | 'saveTask',
  input?: TaskSettingsUpdate,
): Promise<TaskSettingsView> {
  const args = method === 'saveTask' ? { input } : {};
  const connection = ctx.get('connection') as ConnectionHandle;
  const result = await connection.rpc.call('/api', `sagittaSettings/${method}`, { args });
  if (!result.ok) throw new Error(result.error.message);
  return result.value as TaskSettingsView;
}

function SagittaSettings(
  { ctx }: { ctx: Context },
) {
  const [view, setView] = useState<TaskSettingsView>();
  const [mode, setMode] = useState<'local' | 'custom'>('local');
  const [busy, setBusy] = useState(false);
  const [clearPassword, setClearPassword] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    request(ctx, 'readTask').then((
      result,
    ) => {
      if (!active) return;
      setView(result);
      setMode(result.config.mode);
    }).catch((
      cause: Error,
    ) => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [ctx]);

  async function submit(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const text = (
      name: string,
    ) => String(fields.get(name) ?? '');
    const input: TaskSettingsUpdate = mode === 'local' ? { mode, directory: text('directory') } : {
      mode, host: text('host'), port: Number(text('port')), database: text('database'),
      user: text('user'), ssl: fields.has('ssl'), caFile: text('caFile') || undefined,
    };
    if (input.mode === 'custom' && (clearPassword || text('password'))) {
      input.password = clearPassword ? '' : text('password');
    }

    setBusy(true);
    setError('');
    setSaved(false);
    try {
      setView(await request(ctx, 'saveTask', input));
      setClearPassword(false);
      setRevision(revision + 1);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!view) return <p role={error ? 'alert' : 'status'}>{error || '正在读取 Sagitta 配置…'}</p>;
  const custom = view.config.mode === 'custom' ? view.config : undefined;
  return <form className="sagitta-settings" onSubmit={submit} onChange={() => setSaved(false)}>
    <style>{`
.sagitta-settings { max-width: 640px; color: var(--dsw-alias-label-primary); }
.sagitta-settings fieldset { border: 0; padding: 0; margin: 0; display: grid; gap: 16px; min-width: 0; }
.sagitta-settings label { display: grid; gap: 6px; }
.sagitta-settings label:has([type=checkbox]) { display: flex; align-items: center; gap: 8px; }
.sagitta-settings input:not([type=checkbox]), .sagitta-settings select, .sagitta-settings button { font: inherit; color: inherit; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l3); border-radius: 8px; padding: 8px 12px; width: 100%; box-sizing: border-box; }
.sagitta-settings button { width: auto; justify-self: start; cursor: pointer; }
`}</style>
    <h2>任务数据库</h2>
    <p>目录和证书路径均位于运行 DSH 的设备。保存后请手动重启 DSH。</p>
    <fieldset disabled={busy} key={revision}>
      <label>数据库位置<select value={mode} onChange={(
        event,
      ) => { setMode(event.target.value as 'local' | 'custom'); setClearPassword(false); }}>
        <option value="local">本地目录（自动初始化并按需启动）</option>
        <option value="custom">自定义 PostgreSQL 连接</option>
      </select></label>
      {mode === 'local' ? <label>数据库目录<input name="directory" required defaultValue={view.config.mode === 'local' ? view.config.directory : ''} /></label> : <>
        {([
          ['host', '主机名或 IP', '127.0.0.1'], ['port', '端口', 5432],
          ['database', '数据库名称', 'sagitta_tasks'], ['user', '用户名', 'sagitta'],
        ] as const).map((
          [name, label, value],
        ) => <label key={name}>{label}<input name={name} type={name === 'port' ? 'number' : 'text'} min={1} max={65535} required defaultValue={custom?.[name] ?? value} /></label>)}
        <label>密码<input name="password" type="password" autoComplete="new-password" disabled={clearPassword} placeholder={view.passwordConfigured ? '已配置；留空保留' : '尚未配置；可留空'} /></label>
        <label><input type="checkbox" checked={clearPassword} onChange={(
          event,
        ) => setClearPassword(event.target.checked)} />清空已保存的密码</label>
        <label><input name="ssl" type="checkbox" defaultChecked={custom?.ssl} />启用 TLS 并验证服务器证书</label>
        <label>CA 证书文件路径（可选）<input name="caFile" defaultValue={custom?.caFile ?? ''} /></label>
      </>}
      <button type="submit">{busy ? '保存中…' : '保存配置'}</button>
    </fieldset>
    {error && <p role="alert">{error}</p>}
    {saved && <p role="status">已保存。请在当前工作结束后手动重启 DSH。</p>}
  </form>;
}

export const inject = ['slots', 'connection'];

export function apply(
  ctx: Context,
) {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'sagitta', order: 15, label: () => 'Sagitta 设置', inject: () => ({ ctx }),
  }, SagittaSettings));
}
