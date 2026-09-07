window.__ModuleLoader__.load({
  id: "@sagitta/auto-advance",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const inject = ["remote", "sessions", "slots"];
    const REMOTE = {
      package: "@sagitta/auto-advance",
      descriptors: [
        {
          id: "@sagitta/auto-advance#sagittaAutoAdvance/getState",
          service: "sagittaAutoAdvance",
          namespace: "sagittaAutoAdvance",
          method: "getState",
          invocation: { kind: "direct" },
          parameters: [{ name: "agent", wire: "agentId", source: "lookup", lookup: "agent", codec: { mode: "strict", typeSymbol: "@deepseek-ai/dsh-session/types#SessionId", schema: stringSchema() } }],
          result: { mode: "strict", typeSymbol: "@sagitta/auto-advance/client#AutoAdvanceState", schema: stateSchema() }
        },
        {
          id: "@sagitta/auto-advance#sagittaAutoAdvance/setMode",
          service: "sagittaAutoAdvance",
          namespace: "sagittaAutoAdvance",
          method: "setMode",
          invocation: { kind: "direct" },
          parameters: [
            { name: "agent", wire: "agentId", source: "lookup", lookup: "agent", codec: { mode: "strict", typeSymbol: "@deepseek-ai/dsh-session/types#SessionId", schema: stringSchema() } },
            { name: "enabled", wire: "enabled", source: "json", codec: { mode: "strict", typeSymbol: "@sagitta/auto-advance#boolean", schema: booleanSchema() } }
          ],
          result: { mode: "strict", typeSymbol: "@sagitta/auto-advance/client#AutoAdvanceState", schema: stateSchema() }
        },
        {
          id: "@sagitta/auto-advance#sagittaAutoAdvance/getTasks",
          service: "sagittaAutoAdvance",
          namespace: "sagittaAutoAdvance",
          method: "getTasks",
          invocation: { kind: "direct" },
          parameters: [{ name: "agent", wire: "agentId", source: "lookup", lookup: "agent", codec: { mode: "strict", typeSymbol: "@deepseek-ai/dsh-session/types#SessionId", schema: stringSchema() } }],
          result: { mode: "strict", typeSymbol: "@sagitta/auto-advance/client#TaskSnapshot", schema: tasksSchema() }
        },
        {
          id: "@sagitta/auto-advance#sagittaAutoAdvance/getAsyncWorks",
          service: "sagittaAutoAdvance",
          namespace: "sagittaAutoAdvance",
          method: "getAsyncWorks",
          invocation: { kind: "direct" },
          parameters: [{ name: "agent", wire: "agentId", source: "lookup", lookup: "agent", codec: { mode: "strict", typeSymbol: "@deepseek-ai/dsh-session/types#SessionId", schema: stringSchema() } }],
          result: { mode: "strict", typeSymbol: "@sagitta/auto-advance/client#AsyncWorkSnapshot", schema: asyncWorksSchema() }
        },
        {
          id: "@sagitta/auto-advance#sagittaAutoAdvance/resolveNeedHuman",
          service: "sagittaAutoAdvance",
          namespace: "sagittaAutoAdvance",
          method: "resolveNeedHuman",
          invocation: { kind: "direct" },
          parameters: [{ name: "needHumanId", wire: "needHumanId", source: "json", codec: { mode: "strict", typeSymbol: "@sagitta/auto-advance#string", schema: stringSchema() } }],
          result: { mode: "strict", typeSymbol: "@sagitta/auto-advance/client#NeedHumanResolution", schema: needHumanResolutionSchema() }
        }
      ]
    };

    function strictSchema(parse) {
      return { _zod: {}, parse };
    }
    function stringSchema() {
      return strictSchema((value) => {
        if (typeof value !== "string") throw new Error("expected string");
        return value;
      });
    }
    function booleanSchema() {
      return strictSchema((value) => {
        if (typeof value !== "boolean") throw new Error("expected boolean");
        return value;
      });
    }
    function stateSchema() {
      return strictSchema((value) => {
        if (value === null || typeof value !== "object" || typeof value.enabled !== "boolean" || (value.mode !== "auto" && value.mode !== "chat") || (value.idleSince !== null && typeof value.idleSince !== "number") || (value.injectedAt !== null && typeof value.injectedAt !== "number") || typeof value.ready !== "boolean" || typeof value.hasPendingWork !== "boolean" || typeof value.stoppedByProtocol !== "boolean" || typeof value.agentStatus !== "string" || typeof value.degraded !== "boolean" || (value.degradedReason !== null && typeof value.degradedReason !== "string")) throw new Error("invalid autonomous-continuation state");
        return value;
      });
    }
    function tasksSchema() {
      return strictSchema((value) => {
        if (value === null || typeof value !== "object" || typeof value.path !== "string" || (value.updatedAt !== null && typeof value.updatedAt !== "number") || !Array.isArray(value.sections) || (value.source !== undefined && !["cloud", "file", "file-stale"].includes(value.source))) throw new Error("invalid task snapshot");
        for (const section of value.sections) {
          if (section === null || typeof section.title !== "string" || !Array.isArray(section.items)) throw new Error("invalid task section");
          for (const item of section.items) {
            if (item === null || typeof item.text !== "string" || typeof item.done !== "boolean") throw new Error("invalid task item");
            if (item.acceptance !== undefined && typeof item.acceptance !== "string") throw new Error("invalid task acceptance");
            if (item.kind !== undefined && typeof item.kind !== "string") throw new Error("invalid task kind");
            if (item.status !== undefined && typeof item.status !== "string") throw new Error("invalid task status");
            if (item.updatedAt !== undefined && item.updatedAt !== null && typeof item.updatedAt !== "number") throw new Error("invalid task updatedAt");
            if (item.project !== undefined && typeof item.project !== "string") throw new Error("invalid task project");
            if (item.task_id !== undefined && typeof item.task_id !== "string") throw new Error("invalid task id");
            if (item.blockedReason !== undefined && item.blockedReason !== null && typeof item.blockedReason !== "string") throw new Error("invalid blocked reason");
          }
        }
        if (value.pendingRequests !== undefined) {
          if (!Array.isArray(value.pendingRequests)) throw new Error("invalid pending request list");
          for (const request of value.pendingRequests) {
            if (request === null || typeof request.title !== "string" || typeof request.hasCheckbox !== "boolean" || typeof request.body !== "string") throw new Error("invalid pending request");
            if ((request.type !== "need" && request.type !== "notify") || typeof request.needHumanId !== "string") throw new Error("invalid typed pending request");
          }
        }
        if (value.pendingRequestsError !== undefined && typeof value.pendingRequestsError !== "string") throw new Error("invalid pending request error");
        return value;
      });
    }
    function needHumanResolutionSchema() {
      return strictSchema((value) => {
        if (value === null || typeof value !== "object" || typeof value.needHumanId !== "string" || typeof value.taskId !== "string" || (value.type !== "need" && value.type !== "notify") || typeof value.status !== "string") throw new Error("invalid need-human resolution");
        return value;
      });
    }
    function asyncWorksSchema() {
      return strictSchema((value) => {
        if (value === null || typeof value !== "object" || !Array.isArray(value.running) || !Array.isArray(value.recent)) throw new Error("invalid async-work snapshot");
        for (const work of value.running) {
          if (work === null || typeof work !== "object" || typeof work.work_id !== "string" || typeof work.task_id !== "string" || typeof work.kind !== "string" || typeof work.desc !== "string" || typeof work.started_at !== "string" || !Number.isInteger(work.timeout_ms) || work.status !== "running") throw new Error("invalid running async-work");
        }
        for (const work of value.recent) {
          if (work === null || typeof work !== "object" || typeof work.work_id !== "string" || typeof work.task_id !== "string" || typeof work.kind !== "string" || typeof work.desc !== "string" || typeof work.started_at !== "string" || typeof work.ended_at !== "string" || !Number.isInteger(work.timeout_ms) || !["completed", "failed", "cancelled", "expired"].includes(work.status) || (work.reason !== null && typeof work.reason !== "string")) throw new Error("invalid recent async-work");
        }
        return value;
      });
    }

    const IN_PROGRESS_META = Object.freeze({ label: "进行中", icon: "⟳", priority: 4 });
    const COMPLETED_META = Object.freeze({ label: "已完成", icon: "✓", priority: 2 });
    const STATUS_META = Object.freeze({
      open: Object.freeze({ label: "待认领", icon: "□", priority: 1 }),
      in_progress: IN_PROGRESS_META,
      blocked: Object.freeze({ label: "阻塞中", icon: "🔒", priority: 3 }),
      completed: COMPLETED_META,
      done: COMPLETED_META,
      waiting: Object.freeze({ label: "等待中", icon: "◷", priority: 1 })
    });
    const STATUS_ALIASES = Object.freeze({ done: "completed" });
    const STATUS_DETECTORS = Object.freeze([
      Object.freeze({ status: "in_progress", pattern: /(?:🔄|进行中|推进中|开发中|处理中|执行中|active|running)/iu }),
      Object.freeze({ status: "blocked", pattern: /(?:🚩|阻塞|阻碍|blocked|block)/iu }),
      Object.freeze({ status: "completed", pattern: /(?:✅|已完成|完成|结案|closed|done|completed)/iu }),
      Object.freeze({ status: "waiting", pattern: /(?:⏳|🕒|等待|待处理|待确认|pending|waiting|todo)/iu })
    ]);
    const STATUS_PRIORITY = Object.freeze(Object.fromEntries(Object.entries(STATUS_META).map(([status, meta]) => [status, meta.priority])));

    const STYLE = `
      [data-sagitta-auto-advance] { --saa-bg: #111821; --saa-surface: #182230; --saa-surface-raised: #202d3d; --saa-border: rgba(154,174,201,.22); --saa-text: #edf4ff; --saa-muted: #91a2b8; --saa-brand: #6e9eff; color: var(--saa-text); font-family: -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif; color-scheme: dark; }
      .saa-ball { position: fixed; z-index: 2147483000; right: 24px; bottom: 24px; width: 56px; height: 56px; box-sizing: border-box; padding: .7rem; border: 1px solid rgba(255,255,255,.28); border-radius: 50%; background: linear-gradient(145deg,#367df2 0%,#7357d9 100%); box-shadow: 0 9px 24px rgba(0,0,0,.35), 0 0 0 4px rgba(83,133,241,.08); color: #fff; cursor: grab; display: flex; align-items: center; justify-content: center; font-size: 1.45rem; line-height: 1; touch-action: none; user-select: none; transition: box-shadow .18s ease, filter .18s ease; }
      .saa-ball[hidden], .saa-panel[hidden] { display: none; }
      .saa-ball:hover { filter: brightness(1.08); box-shadow: 0 12px 30px rgba(0,0,0,.42), 0 0 0 5px rgba(83,133,241,.12); }
      .saa-ball:active { cursor: grabbing; box-shadow: 0 6px 18px rgba(0,0,0,.38), 0 0 0 3px rgba(83,133,241,.1); }
      .saa-ball[data-mode="chat"] { background: linear-gradient(145deg,#4b596a 0%,#263342 100%); }
      .saa-panel { position: fixed; z-index: 2147482999; left: 0; top: 0; width: min(368px, calc(100vw - 24px)); max-height: min(620px, calc(100vh - 24px)); max-height: min(620px, calc(100dvh - 24px)); display: flex; flex-direction: column; overflow: hidden; box-sizing: border-box; padding: 18px; border: 1px solid var(--saa-border); border-radius: 20px; background: linear-gradient(155deg,rgba(27,38,53,.98),rgba(14,21,30,.98)); box-shadow: 0 22px 64px rgba(0,0,0,.48), 0 0 0 1px rgba(255,255,255,.025) inset; backdrop-filter: blur(18px); font-size: 13px; line-height: 1.45; animation: saa-panel-in .18s ease-out both; will-change: left,top; }
      .saa-head { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 14px; margin: -2px -2px 16px; padding: 2px; cursor: grab; touch-action: none; user-select: none; }
      .saa-head:active { cursor: grabbing; }
      .saa-head-main { min-width: 0; }
      .saa-eyebrow { display: block; margin-bottom: 3px; color: var(--saa-brand); font-size: 10px; font-weight: 700; letter-spacing: .12em; line-height: 1; text-transform: uppercase; }
      .saa-title { overflow: hidden; color: #f7faff; font-size: 16px; font-weight: 700; letter-spacing: -.01em; text-overflow: ellipsis; white-space: nowrap; }
      .saa-subtitle { margin-top: 4px; color: var(--saa-muted); font-size: 11px; }
      .saa-session { margin-top: 5px; overflow: hidden; color: #c7d7ed; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
      .saa-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 6px; }
      .saa-toggle, .saa-close { border: 0; cursor: pointer; font: inherit; transition: background .18s ease, color .18s ease, opacity .18s ease; }
      .saa-toggle { border-radius: 999px; padding: 7px 11px; color: #fff; background: #316fe0; font-size: 11px; font-weight: 650; white-space: nowrap; }
      .saa-toggle:hover { background: #4282f0; }
      .saa-toggle[data-enabled="false"] { background: #3a4859; color: #b7c4d3; }
      .saa-toggle:disabled { opacity: .55; cursor: wait; }
      .saa-close { width: 30px; height: 30px; border-radius: 9px; padding: 0; color: #aebdd0; background: rgba(255,255,255,.07); font-size: 17px; line-height: 30px; }
      .saa-close:hover { color: #fff; background: rgba(255,255,255,.14); }
      .saa-close:focus-visible, .saa-toggle:focus-visible, .saa-ball:focus-visible { outline: 2px solid #86adff; outline-offset: 3px; }
      .saa-status { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); flex: 0 0 auto; gap: 7px; }
      .saa-status-row { min-width: 0; padding: 9px 10px; border: 1px solid rgba(148,171,201,.1); border-radius: 11px; background: rgba(255,255,255,.045); color: var(--saa-muted); font-size: 11px; }
      .saa-status-row strong { display: block; margin-bottom: 2px; color: #8395ac; font-size: 10px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
      .saa-status-row span { display: block; overflow: hidden; color: #e7eef8; font-size: 12px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
      .saa-queue-hint { grid-column: 1 / -1; margin-top: 1px; padding: 8px 10px; border: 1px solid rgba(110,158,255,.2); border-radius: 10px; background: rgba(83,135,234,.1); color: #bcd2f5; font-size: 11px; }
      .saa-task-title { display: flex; flex: 0 0 auto; align-items: baseline; justify-content: space-between; gap: 8px; margin: 19px 0 9px; color: #f7faff; font-size: 13px; font-weight: 700; }
      .saa-pending-heading { margin-top: 3px; }
      .saa-pending-list { display: grid; gap: 7px; margin: 0 0 4px; padding: 0; list-style: none; }
      .saa-pending-item { display: flex; align-items: flex-start; gap: 9px; padding: 10px 11px; border: 1px solid rgba(110,158,255,.24); border-radius: 12px; background: linear-gradient(145deg,rgba(83,135,234,.14),rgba(255,255,255,.045)); }
      .saa-pending-item[data-type="notify"] { border-color: rgba(230,174,84,.34); background: linear-gradient(145deg,rgba(230,174,84,.14),rgba(255,255,255,.045)); }
      .saa-pending-checkbox { width: 17px; flex: 0 0 auto; color: #8cb5ff; font-size: 17px; line-height: 1.35; }
      .saa-pending-item[data-type="notify"] .saa-pending-checkbox { color: #f2c56f; }
      .saa-pending-content { min-width: 0; flex: 1 1 auto; }
      .saa-pending-item-title { color: #edf4ff; font-size: 12px; font-weight: 650; line-height: 1.45; overflow-wrap: anywhere; }
      .saa-pending-body { margin-top: 3px; color: #aebed4; font-size: 11px; line-height: 1.45; overflow-wrap: anywhere; }
      .saa-pending-resolve { flex: 0 0 auto; border: 1px solid rgba(242,197,111,.42); border-radius: 8px; padding: 5px 8px; color: #ffe0a0; background: rgba(230,174,84,.12); cursor: pointer; font: inherit; font-size: 11px; white-space: nowrap; }
      .saa-pending-resolve:hover { background: rgba(230,174,84,.22); }
      .saa-pending-resolve:disabled { opacity: .55; cursor: wait; }
      .saa-pending-resolve:focus-visible { outline: 2px solid #f2c56f; outline-offset: 2px; }
      .saa-pending-empty { margin-bottom: 4px; }
      .saa-task-count { color: var(--saa-muted); font-size: 11px; font-weight: 500; }
      .saa-task-scroll { min-height: 0; max-height: min(26rem, 52dvh); flex: 0 1 auto; overflow: auto; overscroll-behavior: contain; scrollbar-color: rgba(142,164,194,.35) transparent; scrollbar-width: thin; }
      .saa-project-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
      .saa-project { overflow: hidden; border: 1px solid rgba(148,171,201,.13); border-radius: 13px; background: rgba(255,255,255,.04); transition: border-color .18s ease, background .18s ease; }
      .saa-project:hover { border-color: rgba(124,164,238,.34); background: rgba(255,255,255,.06); }
      .saa-project-head { display: flex; align-items: center; gap: 8px; padding: 10px 11px 7px; }
      .saa-project-mark { width: 5px; height: 5px; flex: 0 0 auto; border-radius: 50%; background: var(--saa-brand); box-shadow: 0 0 8px rgba(110,158,255,.7); }
      .saa-project-name { min-width: 0; overflow: hidden; color: #e9f1fc; font-size: 12px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
      .saa-task { display: flex; align-items: flex-start; gap: 9px; padding: 0 11px 11px; }
      .saa-task[data-kind="temp"] .saa-task-text { color: #d4b6ff; }
      .saa-task-main { min-width: 0; flex: 1 1 auto; }
      .saa-task-text { color: #bdcbe0; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
      .saa-task-project { margin-top: 3px; color: #8295ad; font-size: 10px; overflow-wrap: anywhere; }
      .saa-task-meta { display: flex; align-items: center; gap: 7px; margin-top: 6px; }
      .saa-task-status { display: inline-flex; align-items: center; gap: 4px; padding: 3px 7px; border-radius: 999px; background: rgba(255,255,255,.07); color: #b9c7d8; font-size: 10px; font-weight: 650; white-space: nowrap; }
      .saa-task-kind { display: inline-flex; align-items: center; border-radius: 999px; padding: 3px 7px; background: rgba(171,120,235,.18); color: #d4b6ff; font-size: 10px; font-weight: 700; }
      .saa-task-icon { display: inline-flex; width: 14px; height: 14px; align-items: center; justify-content: center; font-size: 12px; line-height: 1; }
      .saa-task-icon[data-status="open"] { color: #9fbfff; }
      .saa-task-icon[data-status="in_progress"] { color: #70a4ff; animation: saa-spin 1.4s linear infinite; }
      .saa-task-icon[data-status="blocked"] { color: #ffb870; font-size: 11px; }
      .saa-task-icon[data-status="completed"], .saa-task-icon[data-status="done"] { color: #65d6a0; font-size: 14px; font-weight: 700; }
      .saa-task-icon[data-status="waiting"] { color: #9eacc0; }
      .saa-task-status[data-status="open"] { background: rgba(83,135,234,.11); color: #aac5ff; }
      .saa-task-status[data-status="in_progress"] { background: rgba(83,135,234,.15); color: #8cb5ff; }
      .saa-task-status[data-status="blocked"] { background: rgba(232,151,68,.14); color: #ffc17e; }
      .saa-task-status[data-status="completed"], .saa-task-status[data-status="done"] { background: rgba(72,188,130,.13); color: #82dfb1; }
      .saa-task-status[data-status="waiting"] { background: rgba(148,165,187,.13); color: #bec9d7; }
      .saa-task-card-list { display: grid; gap: 7px; margin: 0 0 5px; padding: 0; list-style: none; }
      .saa-task-card { display: flex; align-items: flex-start; gap: 9px; padding: 10px 11px; border: 1px solid rgba(148,171,201,.15); border-radius: 12px; background: rgba(255,255,255,.04); }
      .saa-task-card[data-status="in_progress"] { border-color: rgba(110,158,255,.27); background: linear-gradient(145deg,rgba(83,135,234,.12),rgba(255,255,255,.035)); }
      .saa-task-card[data-status="blocked"] { border-color: rgba(232,151,68,.3); background: linear-gradient(145deg,rgba(232,151,68,.11),rgba(255,255,255,.035)); }
      .saa-task-card[data-status="open"] { border-color: rgba(110,158,255,.18); }
      .saa-task-card[data-kind="temp"] { border-color: rgba(171,120,235,.46); background: linear-gradient(145deg,rgba(171,120,235,.17),rgba(255,255,255,.035)); }
      .saa-task-card .saa-task-icon { margin-top: 2px; }
      .saa-status-heading { margin-top: 14px; }
      .saa-status-empty { margin-bottom: 5px; padding: 9px 11px; font-size: 11px; }
      .saa-task-acceptance { margin-top: 6px; color: #aebed4; font-size: 10px; line-height: 1.45; overflow-wrap: anywhere; }
      .saa-task-acceptance strong { color: #d1def1; font-weight: 650; }
      .saa-task-acceptance[data-empty="true"] { color: #788aa1; }
      .saa-task-blocked-reason { margin-top: 4px; color: #ffc17e; font-size: 10px; line-height: 1.4; overflow-wrap: anywhere; }
      .saa-task-updated { color: #73859c; font-size: 10px; }
      .saa-empty, .saa-error { padding: 13px; border-radius: 11px; background: rgba(255,255,255,.04); color: #899bb2; }
      .saa-stale { margin: -2px 0 8px; color: #ffc17e; font-size: 10px; }
      .saa-raw { max-width: 100%; box-sizing: border-box; margin: 0; padding: 13px; border: 1px solid rgba(148,171,201,.13); border-radius: 11px; background: rgba(0,0,0,.16); color: #bdcbe0; font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; }
      .saa-error { color: #ffaaa8; }
      @keyframes saa-panel-in { from { opacity: 0; } to { opacity: 1; } }
      @keyframes saa-spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .saa-panel, .saa-ball, .saa-project, .saa-toggle, .saa-close { animation: none; transition: none; } .saa-task-icon[data-status="in_progress"] { animation: none; } }
    `;
    const ASYNC_WORK_HEADER_STYLE = `
      [data-sagitta-async-work-header] { position: relative; color: var(--dsw-alias-label-primary, #edf4ff); font-family: -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif; }
      .saw-trigger { min-height: 28px; color: var(--dsw-alias-label-tertiary, #9aaabd); background: transparent; border: 0; border-radius: 6px; padding: 3px 5px; display: inline-flex; align-items: center; gap: 5px; cursor: pointer; font: inherit; font-size: 12px; line-height: 18px; white-space: nowrap; }
      .saw-trigger:hover, .saw-trigger:focus-visible { color: var(--dsw-alias-label-secondary, #d5e0ef); background: var(--dsw-alias-fill-l1, rgba(255,255,255,.06)); }
      .saw-trigger[data-running="true"] { color: var(--dsw-alias-label-secondary, #d5e0ef); }
      .saw-trigger-icon { color: #77a7ff; font-size: 14px; line-height: 1; }
      .saw-trigger[data-running="true"] .saw-trigger-icon { animation: saw-spin 1.4s linear infinite; }
      .saw-trigger-count { color: inherit; font-variant-numeric: tabular-nums; }
      .saw-popover { z-index: 100; box-sizing: border-box; position: absolute; top: calc(100% + 5px); left: 0; width: 370px; max-width: min(420px, calc(100vw - 32px)); max-height: min(480px, calc(100vh - 140px)); overflow: auto; padding: 5px; border: 1px solid var(--dsw-alias-border-l2, rgba(148,171,201,.25)); border-radius: 12px; background: var(--dsw-specific-menu, #182230); box-shadow: var(--dsw-shadow-lv3, 0 18px 48px rgba(0,0,0,.35)); }
      .saw-heading { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin: 5px 7px 4px; color: var(--dsw-alias-label-secondary, #d5e0ef); font-size: 11px; font-weight: 700; }
      .saw-heading + .saw-heading { margin-top: 10px; }
      .saw-heading-count { color: var(--dsw-alias-label-tertiary, #899bb2); font-weight: 500; }
      .saw-row { display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto; align-items: start; gap: 6px; padding: 7px; border-radius: 8px; color: var(--dsw-alias-label-primary, #edf4ff); font-size: 12px; line-height: 17px; }
      .saw-row:hover { background: var(--dsw-alias-fill-l1, rgba(255,255,255,.05)); }
      .saw-row[data-terminal="true"] { color: var(--dsw-alias-label-tertiary, #9aaabd); }
      .saw-status { width: 14px; color: #77a7ff; text-align: center; }
      .saw-row[data-status="completed"] .saw-status { color: #62d49a; }
      .saw-row[data-status="failed"] .saw-status { color: #ff8585; }
      .saw-row[data-status="cancelled"] .saw-status { color: #e7b45e; }
      .saw-row[data-status="expired"] .saw-status { color: #c19aff; }
      .saw-kind { max-width: 90px; overflow: hidden; padding: 0 5px; border-radius: 4px; background: var(--dsw-alias-fill-l2, rgba(255,255,255,.09)); color: var(--dsw-alias-label-secondary, #c3d0df); font-size: 10px; line-height: 17px; text-overflow: ellipsis; white-space: nowrap; }
      .saw-main { min-width: 0; }
      .saw-desc { overflow: hidden; color: inherit; text-overflow: ellipsis; white-space: nowrap; }
      .saw-task { margin-top: 1px; overflow: hidden; color: var(--dsw-alias-label-tertiary, #899bb2); font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
      .saw-reason { margin-top: 1px; overflow: hidden; color: #d9b976; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
      .saw-duration { color: var(--dsw-alias-label-tertiary, #899bb2); font-variant-numeric: tabular-nums; white-space: nowrap; }
      .saw-empty { padding: 8px 7px; color: var(--dsw-alias-label-tertiary, #899bb2); font-size: 11px; }
      .saw-trigger:focus-visible { outline: 2px solid var(--dsw-alias-focus, #86adff); outline-offset: 2px; }
      @keyframes saw-spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .saw-trigger[data-running="true"] .saw-trigger-icon { animation: none; } }
    `;

    function statusFromValue(value, done, allowLegacyGuess = false) {
      const explicit = safeText(value).trim().toLowerCase();
      const canonical = STATUS_ALIASES[explicit] ?? explicit;
      if (Object.prototype.hasOwnProperty.call(STATUS_META, canonical)) return canonical;
      if (allowLegacyGuess) {
        for (const detector of STATUS_DETECTORS) if (detector.pattern.test(safeText(value))) return detector.status;
      }
      return done === true ? "completed" : "open";
    }

    function startsLikeStatus(value) {
      return /^(?:✅|🔄|🚩|⏳|🕒|进行中|推进中|开发中|处理中|执行中|阻塞|阻碍|完成|结案|等待|待处理|待确认|running|blocked|completed|done|waiting|todo|pending)/iu.test(value.trim());
    }

    function splitStatusSuffix(value) {
      const text = safeText(value).trim();
      for (const [opening, closing] of [["（", "）"], ["(", ")"]]) {
        let start = text.indexOf(opening);
        while (start >= 0) {
          const suffix = text.slice(start + 1);
          if (suffix.endsWith(closing) && startsLikeStatus(suffix.slice(0, -1))) {
            return { text: text.slice(0, start).trim(), status: suffix.slice(0, -1).trim() };
          }
          start = text.indexOf(opening, start + 1);
        }
      }
      return { text, status: "" };
    }

    function parseTaskDate(value) {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      const text = safeText(value);
      const full = /(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):?(\d{2})?)?/u.exec(text);
      if (full !== null) return new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3]), Number(full[4] ?? 0), Number(full[5] ?? 0)).getTime();
      const short = /(?:^|\D)(\d{1,2})-(\d{1,2})(?:\D|$)/u.exec(text);
      if (short !== null) return new Date(new Date().getFullYear(), Number(short[1]) - 1, Number(short[2])).getTime();
      return null;
    }

    function normalizeTask(item, order, allowLegacyStatusGuess = false) {
      const rawText = safeText(item?.text).trim();
      const hasExplicitStatus = safeText(item?.status).trim().length > 0;
      const split = allowLegacyStatusGuess && !hasExplicitStatus ? splitStatusSuffix(rawText) : { text: rawText, status: "" };
      const status = hasExplicitStatus
        ? statusFromValue(item.status, item?.done === true)
        : statusFromValue(split.status, item?.done === true, allowLegacyStatusGuess);
      return {
        text: split.text || rawText || "未命名事项",
        status,
        updatedAt: parseTaskDate(item?.updatedAt ?? rawText),
        acceptance: safeText(item?.acceptance).trim(),
        kind: safeText(item?.kind ?? item?.type).trim().toLowerCase() || "task",
        blockedReason: safeText(item?.blockedReason).trim(),
        order,
        project: safeText(item?.project ?? item?.projectName ?? item?.group).trim()
      };
    }

    function isLegacyFlatSection(title, items) {
      return items.length > 1 && /(?:^tasks?$|任务|项目管理|项目清单|项目列表)/iu.test(title);
    }

    function isReportInboxSection(title) {
      return /(?:§\s*2\b|汇报箱|需\s*涟漪\s*确认\s*[\/／]\s*行动|非阻塞说明)/iu.test(title);
    }

    function rawTaskContent(snapshot) {
      const raw = snapshot?.raw ?? snapshot?.markdown ?? snapshot?.content;
      return typeof raw === "string" ? raw.trim() : "";
    }

    function pendingRequestItems(snapshot) {
      if (!Array.isArray(snapshot?.pendingRequests)) return [];
      return snapshot.pendingRequests.filter((request) => request !== null && typeof request === "object" && typeof request.title === "string");
    }

    function pendingRequestType(request) {
      return request?.type === "notify" ? "notify" : "need";
    }

    function isTempTask(task) {
      const kind = safeText(task?.kind).trim().toLowerCase();
      return kind === "temp" || kind === "temporary";
    }

    function acceptanceSummary(value) {
      const lines = safeText(value).split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0);
      if (lines.length === 0) return "";
      const summary = lines.map((line) => {
        const checkbox = /^[-*]\s+\[([ xX])\]\s*(.*)$/u.exec(line);
        if (checkbox === null) return line;
        return `${checkbox[1].toLowerCase() === "x" ? "✓" : "□"} ${checkbox[2]}`;
      }).join(" · ");
      return summary.length > 240 ? `${summary.slice(0, 237)}…` : summary;
    }

    function normalizedTaskItems(snapshot) {
      const items = [];
      let order = 0;
      const allowLegacyStatusGuess = snapshot?.source === "file-stale";
      for (const section of Array.isArray(snapshot?.sections) ? snapshot.sections : []) {
        const title = safeText(section?.title).trim() || "未分类";
        if (isReportInboxSection(title)) continue;
        const sectionItems = (Array.isArray(section?.items) ? section.items : []).map((item) => normalizeTask(item, order++, allowLegacyStatusGuess));
        if (sectionItems.length === 0) continue;
        const legacyFlat = isLegacyFlatSection(title, sectionItems);
        for (const item of sectionItems) {
          const project = item.project || (legacyFlat ? item.text : title) || "未分类";
          items.push({
            ...item,
            project,
            groupKey: legacyFlat ? `${project}\u0000${item.order}` : project.toLocaleLowerCase()
          });
        }
      }
      return items;
    }

    function chooseLatest(items) {
      return items.reduce((latest, candidate) => {
        if (latest === undefined) return candidate;
        const priorityDelta = STATUS_PRIORITY[candidate.status] - STATUS_PRIORITY[latest.status];
        if (priorityDelta !== 0) return priorityDelta > 0 ? candidate : latest;
        const candidateDate = candidate.updatedAt ?? Number.NEGATIVE_INFINITY;
        const latestDate = latest.updatedAt ?? Number.NEGATIVE_INFINITY;
        if (candidateDate !== latestDate) return candidateDate > latestDate ? candidate : latest;
        return candidate.order > latest.order ? candidate : latest;
      }, undefined);
    }

    function taskGroups(snapshot) {
      const groups = new Map();
      for (const item of normalizedTaskItems(snapshot)) {
        const key = item.groupKey;
        const group = groups.get(key) ?? { title: item.project, items: [], order: item.order };
        group.items.push(item);
        groups.set(key, group);
      }
      return [...groups.values()]
        .map((group) => ({ ...group, latest: chooseLatest(group.items) }))
        .sort((first, second) => {
          const priorityDelta = STATUS_PRIORITY[second.latest.status] - STATUS_PRIORITY[first.latest.status];
          if (priorityDelta !== 0) return priorityDelta;
          const firstDate = first.latest.updatedAt ?? Number.NEGATIVE_INFINITY;
          const secondDate = second.latest.updatedAt ?? Number.NEGATIVE_INFINITY;
          return secondDate - firstDate || second.latest.order - first.latest.order;
        });
    }

    function tasksByStatus(snapshot, status) {
      return normalizedTaskItems(snapshot)
        .filter((task) => task.status === status)
        .sort((first, second) => (second.updatedAt ?? Number.NEGATIVE_INFINITY) - (first.updatedAt ?? Number.NEGATIVE_INFINITY) || first.order - second.order);
    }

    function formatDuration(since) {
      if (since === null || since === undefined) return "未计时";
      const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000));
      const minutes = Math.floor(seconds / 60);
      return minutes > 0 ? `${minutes}分${seconds % 60}秒` : `${seconds}秒`;
    }
    function formatTime(value) {
      return value === null || value === undefined ? "暂无" : new Date(value).toLocaleString();
    }
    function currentSessionId(ctx) {
      return ctx.sessions.list.getSnapshot().current;
    }
    /** 当前激活会话的人类可读名：优先会话标题，其次工作目录名，兜底短 id。 */
    function currentSessionLabel(ctx) {
      const snapshot = ctx.sessions.list.getSnapshot();
      const id = snapshot?.current;
      if (id === undefined) return "未选择";
      const entry = snapshot?.byId?.[id];
      const label = entry?.displayTitle ?? entry?.title ?? entry?.cwd;
      return safeText(label).trim() || shortSessionId(id);
    }
    function shortSessionId(value) {
      const text = safeText(value).trim();
      return text.length > 8 ? `…${text.slice(-8)}` : text || "未选择";
    }
    function safeText(value) {
      return typeof value === "string" ? value : "";
    }
    function asyncWorkSnapshot(value) {
      const snapshot = value?.value ?? value;
      if (snapshot === null || typeof snapshot !== "object") return { running: [], recent: [] };
      return {
        running: Array.isArray(snapshot.running) ? snapshot.running : [],
        recent: Array.isArray(snapshot.recent) ? snapshot.recent : []
      };
    }

    function asyncWorkDuration(work, now, terminal) {
      const started = Date.parse(safeText(work?.started_at));
      const ended = terminal ? Date.parse(safeText(work?.ended_at)) : now;
      if (!Number.isFinite(started) || !Number.isFinite(ended)) return "0秒";
      const seconds = Math.max(0, Math.floor((ended - started) / 1000));
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      if (hours > 0) return `${hours}小时${minutes % 60}分`;
      if (minutes > 0) return `${minutes}分${seconds % 60}秒`;
      return `${seconds}秒`;
    }

    function asyncWorkStatus(status) {
      const labels = {
        running: "运行中",
        completed: "已完成",
        failed: "失败",
        cancelled: "已取消",
        expired: "已过期"
      };
      return (labels[status] ?? safeText(status)) || "未知";
    }

    function shortWorkId(value) {
      const text = safeText(value).trim();
      return text.length > 10 ? `…${text.slice(-10)}` : text || "未知";
    }

    function createAsyncWorkHeaderAction(remoteApi) {
      const React = require("react");
      const h = React.createElement;
      const terminalStatuses = new Set(["completed", "failed", "cancelled", "expired"]);

      function AsyncWorkHeaderAction({ sessionId }) {
        const [snapshot, setSnapshot] = React.useState(null);
        const [open, setOpen] = React.useState(false);
        const [now, setNow] = React.useState(() => Date.now());
        const rootRef = React.useRef(null);
        const triggerRef = React.useRef(null);

        React.useEffect(() => {
          let stopped = false;
          const refresh = async () => {
            if (typeof remoteApi?.getAsyncWorks !== "function" || !safeText(sessionId).trim()) {
              if (!stopped) setSnapshot({ running: [], recent: [] });
              return;
            }
            try {
              const result = await remoteApi.getAsyncWorks(sessionId);
              if (result?.ok === false) throw new Error(result.error?.message ?? "异步工作读取失败");
              if (!stopped) setSnapshot(asyncWorkSnapshot(result));
            } catch (error) {
              if (!stopped) setSnapshot((current) => current ?? { running: [], recent: [] });
              console.warn("sagitta-auto-advance: async-work header refresh failed", error);
            }
          };
          void refresh();
          const poll = window.setInterval(refresh, 2000);
          return () => {
            stopped = true;
            window.clearInterval(poll);
          };
        }, [sessionId]);

        const running = snapshot?.running ?? [];
        const recent = snapshot?.recent ?? [];
        const total = running.length + recent.length;
        React.useEffect(() => {
          if (total === 0 && open) setOpen(false);
        }, [total, open]);
        React.useEffect(() => {
          if (!open || running.length === 0) return undefined;
          setNow(Date.now());
          const timer = window.setInterval(() => setNow(Date.now()), 1000);
          return () => window.clearInterval(timer);
        }, [open, running.length]);
        React.useEffect(() => {
          if (!open) return undefined;
          const onPointerDown = (event) => {
            if (!rootRef.current?.contains(event.target)) setOpen(false);
          };
          const onKeyDown = (event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            setOpen(false);
            triggerRef.current?.focus();
          };
          document.addEventListener("pointerdown", onPointerDown);
          document.addEventListener("keydown", onKeyDown);
          return () => {
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
          };
        }, [open]);

        if (total === 0) return null;

        const workRow = (work, terminal) => {
          const status = safeText(work?.status);
          const duration = asyncWorkDuration(work, now, terminal);
          const reason = safeText(work?.reason).trim();
          return h("div", {
            className: "saw-row",
            "data-status": status,
            "data-terminal": String(terminal),
            key: `${terminal ? "recent" : "running"}-${safeText(work?.work_id)}`,
            title: reason || safeText(work?.desc)
          },
          h("span", { className: "saw-status", "aria-hidden": "true" }, terminal ? (status === "completed" ? "✓" : status === "failed" ? "!" : status === "expired" ? "⌛" : "×") : "⟳"),
          h("span", { className: "saw-kind", title: safeText(work?.kind) }, safeText(work?.kind) || "async"),
          h("span", { className: "saw-main" },
            h("span", { className: "saw-desc" }, safeText(work?.desc) || "未命名工作"),
            h("span", { className: "saw-task" }, `task ${shortWorkId(work?.task_id)} · ${asyncWorkStatus(status)}`),
            terminal && reason.length > 0 ? h("span", { className: "saw-reason" }, reason) : null
          ),
          h("span", { className: "saw-duration", title: terminal ? "工作耗时" : "已运行" }, duration));
        };

        const heading = (label, count) => h("div", { className: "saw-heading" },
          h("span", {}, label), h("span", { className: "saw-heading-count" }, `${count} 项`));
        const rows = [];
        if (running.length > 0) {
          rows.push(heading("运行中", running.length));
          rows.push(...running.map((work) => workRow(work, false)));
        }
        if (recent.length > 0) {
          rows.push(heading("最近结束", recent.length));
          rows.push(...recent.filter((work) => terminalStatuses.has(work?.status)).map((work) => workRow(work, true)));
        }
        return h("div", {
          ref: rootRef,
          "data-sagitta-async-work-header": "root",
          onMouseEnter: () => setOpen(true),
          onMouseLeave: () => setOpen(false)
        },
        h("button", {
          ref: triggerRef,
          type: "button",
          className: "saw-trigger",
          "data-running": String(running.length > 0),
          "aria-expanded": String(open),
          "aria-haspopup": "dialog",
          "aria-label": `异步工作：${running.length > 0 ? `${running.length} 项运行中，` : ""}${total} 项`,
          onClick: () => {
            setNow(Date.now());
            setOpen((current) => !current);
          }
        }, h("span", { className: "saw-trigger-icon", "aria-hidden": "true" }, "⟳"), h("span", { className: "saw-trigger-count" }, `${total} 异步工作`)),
        open ? h("div", { className: "saw-popover", role: "dialog", "aria-label": "异步工作列表" }, rows) : null);
      }

      return AsyncWorkHeaderAction;
    }

    function mountHeaderAction(ctx, remoteApi) {
      if (typeof ctx?.slots?.inject !== "function" || typeof ctx?.slots?.register !== "function") return () => {};
      let style;
      if (typeof document !== "undefined" && document.head && document.querySelector("style[data-sagitta-async-work-header-style]") === null) {
        style = createElement("style", { "data-sagitta-async-work-header-style": "true" });
        style.textContent = ASYNC_WORK_HEADER_STYLE;
        document.head.append(style);
      }
      const component = createAsyncWorkHeaderAction(remoteApi);
      const disposeInjection = ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
        name: "conversation.session.header.actions",
        id: "sagitta-async-work",
        order: 30
      }, component));
      return () => {
        disposeInjection?.();
        style?.remove();
      };
    }

    function createElement(tag, attrs = {}, text) {
      const element = document.createElement(tag);
      for (const [key, value] of Object.entries(attrs)) {
        if (key === "class") element.className = value;
        else if (key === "text") element.textContent = value;
        else element.setAttribute(key, value);
      }
      if (text !== undefined) element.textContent = text;
      return element;
    }

    function appendTaskDetails(container, task, showProject = true) {
      container.append(createElement("div", { class: "saa-task-text" }, task.text));
      if (showProject && task.project) container.append(createElement("div", { class: "saa-task-project" }, `项目：${task.project}`));
      const acceptance = acceptanceSummary(task.acceptance);
      container.append(createElement("div", {
        class: "saa-task-acceptance",
        "data-empty": String(acceptance.length === 0),
        title: safeText(task.acceptance).trim()
      }, `期望目标：${acceptance || "暂无 checklist"}`));
      if (task.status === "blocked" && task.blockedReason.length > 0) {
        container.append(createElement("div", { class: "saa-task-blocked-reason" }, `原因：${task.blockedReason}`));
      }
      const meta = STATUS_META[task.status] ?? STATUS_META.waiting;
      const taskMeta = createElement("div", { class: "saa-task-meta" });
      const taskStatus = createElement("span", { class: "saa-task-status", "data-status": task.status });
      taskStatus.append(createElement("span", { class: "saa-task-icon", "data-status": task.status, "aria-hidden": "true" }, meta.icon), document.createTextNode(meta.label));
      taskMeta.append(taskStatus);
      if (isTempTask(task)) taskMeta.append(createElement("span", { class: "saa-task-kind", title: "临时任务，仅用于辅助推进" }, "temp"));
      if (task.updatedAt !== null) taskMeta.append(createElement("span", { class: "saa-task-updated" }, `更新于 ${new Date(task.updatedAt).toLocaleDateString()}`));
      container.append(taskMeta);
    }

    function appendTaskCard(container, task) {
      const card = createElement("li", {
        class: "saa-task-card",
        "data-status": task.status,
        "data-kind": isTempTask(task) ? "temp" : "task"
      });
      const icon = createElement("span", { class: "saa-task-icon", "data-status": task.status, "aria-hidden": "true" }, (STATUS_META[task.status] ?? STATUS_META.waiting).icon);
      const main = createElement("div", { class: "saa-task-main" });
      appendTaskDetails(main, task, true);
      card.append(icon, main);
      container.append(card);
    }

    function appendTaskStatusSection(container, title, items, emptyText) {
      const heading = createElement("div", { class: "saa-task-title saa-status-heading" });
      heading.append(createElement("span", {}, title), createElement("span", { class: "saa-task-count" }, `${items.length} 项`));
      container.append(heading);
      if (items.length === 0) {
        container.append(createElement("div", { class: "saa-empty saa-status-empty" }, emptyText));
        return;
      }
      const list = createElement("ul", { class: "saa-task-card-list" });
      for (const task of items) appendTaskCard(list, task);
      container.append(list);
    }

    function mount(ctx, remoteApi) {
      if (typeof document === "undefined" || !document.body) return () => {};
      const style = createElement("style", { "data-sagitta-auto-advance": "style" });
      style.textContent = STYLE;
      document.head.append(style);
      const root = createElement("div", { "data-sagitta-auto-advance": "root" });
      const ball = createElement("button", { class: "saa-ball", type: "button", "aria-label": "打开 Sagitta 自主推进面板", "aria-expanded": "false" }, "✦");
      const panel = createElement("section", { class: "saa-panel", hidden: "", "aria-label": "Sagitta 自主推进", "aria-hidden": "true" });
      root.append(ball, panel);
      document.body.append(root);

      let open = false;
      let moving = false;
      let moved = false;
      let pointerId;
      let dragTarget;
      let startX = 0;
      let startY = 0;
      let startLeft = 0;
      let startTop = 0;
      let startWidth = 0;
      let startHeight = 0;
      let ballPosition;
      let ballSize;
      let panelSize;
      let busy = false;
      let lastState;
      let tasks;
      let taskScrollTop = 0;
      let resolvingNeedHumanId;

      const EDGE_GAP = 8;

      function viewportSize() {
        const visualViewport = window.visualViewport;
        return {
          width: Math.max(1, visualViewport?.width ?? window.innerWidth),
          height: Math.max(1, visualViewport?.height ?? window.innerHeight)
        };
      }

      function clampPosition(left, top, width, height) {
        const viewport = viewportSize();
        const maxLeft = Math.max(EDGE_GAP, viewport.width - width - EDGE_GAP);
        const maxTop = Math.max(EDGE_GAP, viewport.height - height - EDGE_GAP);
        return {
          left: Math.min(maxLeft, Math.max(EDGE_GAP, left)),
          top: Math.min(maxTop, Math.max(EDGE_GAP, top))
        };
      }

      function samePosition(first, second) {
        return first !== undefined && Math.abs(first.left - second.left) < 0.5 && Math.abs(first.top - second.top) < 0.5;
      }

      function applyPosition(element, position) {
        element.style.left = `${position.left}px`;
        element.style.top = `${position.top}px`;
        element.style.right = "auto";
        element.style.bottom = "auto";
      }

      function syncBallAnchor() {
        if (ball.hidden && ballPosition !== undefined) return;
        const rect = ball.getBoundingClientRect();
        ballSize = { width: rect.width, height: rect.height };
        const current = ballPosition ?? { left: rect.left, top: rect.top };
        ballPosition = clampPosition(current.left, current.top, ballSize.width, ballSize.height);
        applyPosition(ball, ballPosition);
      }

      function placePanelAtBall() {
        if (panel.hidden || ballPosition === undefined || ballSize === undefined) return;
        const rect = panel.getBoundingClientRect();
        panelSize = { width: rect.width, height: rect.height };
        const ballRight = ballPosition.left + ballSize.width;
        const ballBottom = ballPosition.top + ballSize.height;
        const gap = 12;
        const viewport = viewportSize();
        const aboveSpace = ballPosition.top - gap - EDGE_GAP;
        const belowSpace = viewport.height - ballBottom - gap - EDGE_GAP;
        const top = aboveSpace >= panelSize.height || aboveSpace >= belowSpace
          ? ballPosition.top - panelSize.height - gap
          : ballBottom + gap;
        const left = ballRight - panelSize.width;
        const next = clampPosition(left, top, panelSize.width, panelSize.height);
        applyPosition(panel, next);
      }

      function clampAll() {
        syncBallAnchor();
        if (!panel.hidden) placePanelAtBall();
      }

      async function resolveNotify(button, request) {
        const needHumanId = safeText(request?.needHumanId).trim();
        if (busy || pendingRequestType(request) !== "notify" || needHumanId.length === 0) return;
        busy = true;
        resolvingNeedHumanId = needHumanId;
        render();
        try {
          const result = await remoteApi.resolveNeedHuman(needHumanId);
          if (result?.ok === false) throw new Error(result.error?.message ?? "通知确认失败");
          await refresh(true);
        } catch (error) {
          console.warn("sagitta-auto-advance: notify resolve failed", error);
        } finally {
          busy = false;
          resolvingNeedHumanId = undefined;
          render();
        }
      }

      function appendPendingSection(container, requests, type) {
        const isNotify = type === "notify";
        const heading = createElement("div", { class: "saa-task-title saa-pending-heading" });
        heading.append(
          createElement("span", {}, isNotify ? "📢 待你确认" : "🔔 待你处理"),
          createElement("span", { class: "saa-task-count" }, `${requests.length} 项`)
        );
        container.append(heading);
        if (requests.length === 0) {
          container.append(createElement("div", { class: "saa-empty saa-pending-empty" }, isNotify ? "暂无待确认通知" : "暂无待处理需求"));
          return;
        }
        const pendingList = createElement("ul", { class: "saa-pending-list" });
        for (const request of requests) {
          const requestTitle = request.title.trim() || (isNotify ? "未命名通知" : "未命名需求");
          const requestBody = safeText(request.body).trim();
          const requestType = pendingRequestType(request);
          const requestItem = createElement("li", { class: "saa-pending-item", "data-type": requestType });
          requestItem.append(createElement("span", { class: "saa-pending-checkbox", "aria-hidden": "true" }, isNotify ? "📢" : "•"));
          const requestContent = createElement("div", { class: "saa-pending-content" });
          requestContent.append(createElement("div", { class: "saa-pending-item-title" }, requestTitle));
          if (requestBody.length > 0) requestContent.append(createElement("div", { class: "saa-pending-body" }, requestBody));
          requestItem.append(requestContent);
          if (isNotify) {
            const needHumanId = safeText(request.needHumanId).trim();
            const resolve = createElement("button", {
              class: "saa-pending-resolve",
              type: "button",
              "aria-label": `确认通知：${requestTitle}`
            }, resolvingNeedHumanId === needHumanId ? "确认中…" : "确认");
            resolve.disabled = busy || needHumanId.length === 0;
            resolve.title = needHumanId.length === 0 ? "缺少 need-human id，无法确认" : "确认后自动关闭通知";
            resolve.addEventListener("click", () => { void resolveNotify(resolve, request); });
            requestItem.append(resolve);
          }
          pendingList.append(requestItem);
        }
        container.append(pendingList);
      }

      function render() {
        // PointerEvent.clientX/Y, getBoundingClientRect(), and fixed left/top
        // are all CSS pixels. Keeping one coordinate space avoids dpr/zoom drift.
        syncBallAnchor();
        ball.dataset.mode = lastState?.mode ?? "chat";
        ball.textContent = lastState?.enabled ? "✦" : "…";
        ball.setAttribute("aria-expanded", String(open));
        ball.setAttribute("aria-label", open ? "Sagitta 自主推进面板已打开" : "打开 Sagitta 自主推进面板");
        ball.hidden = open;
        panel.hidden = !open;
        panel.setAttribute("aria-hidden", String(!open));
        const previousTaskScroll = panel.querySelector(".saa-task-scroll");
        if (previousTaskScroll) taskScrollTop = previousTaskScroll.scrollTop;
        panel.replaceChildren();
        const head = createElement("div", { class: "saa-head" });
        const headMain = createElement("div", { class: "saa-head-main" });
        headMain.append(
          createElement("span", { class: "saa-eyebrow" }, "SAGITTA / AGENT CONTROL"),
          createElement("div", { class: "saa-title" }, "自主推进"),
          createElement("div", { class: "saa-subtitle" }, "只读任务摘要 · 任务驱动自主推进"),
          createElement("div", { class: "saa-session" }, `当前作用会话：${currentSessionLabel(ctx)}`)
        );
        const actions = createElement("div", { class: "saa-actions" });
        const toggle = createElement("button", { class: "saa-toggle", type: "button", "data-enabled": String(lastState?.enabled === true) }, lastState?.enabled ? "已开启" : "已关闭");
        toggle.disabled = busy || currentSessionId(ctx) === undefined;
        toggle.addEventListener("click", () => toggleMode(toggle));
        const close = createElement("button", { class: "saa-close", type: "button", "aria-label": "收起 Sagitta 自主推进面板" }, "×");
        close.addEventListener("click", () => {
          open = false;
          render();
        });
        actions.append(toggle, close);
        head.append(headMain, actions);
        panel.append(head);

        const status = createElement("div", { class: "saa-status" });
        status.append(
          row("模式", lastState?.mode === "auto" ? "自主推进" : "自由聊天"),
          row("任务驱动", lastState?.enabled ? (lastState?.ready ? "等待任务检查" : "无可推进任务") : "已熄火"),
          row("上次注入", formatTime(lastState?.injectedAt)),
          row("条件", lastState?.degraded ? `云端降级：${lastState.degradedReason || "稍后重试"}` : lastState?.hasPendingWork ? "有待处理工作" : lastState?.ready ? "可推进" : "暂不可推进")
        );
        if (lastState?.agentStatus !== "idle" || lastState?.hasPendingWork) {
          status.append(createElement("div", { class: "saa-queue-hint" }, "输入会排队，agent 空闲后处理"));
        }
        panel.append(status);
        const groups = taskGroups(tasks);
        const rawContent = rawTaskContent(tasks);
        const pending = pendingRequestItems(tasks);
        const needs = pending.filter((request) => pendingRequestType(request) === "need");
        const notifications = pending.filter((request) => pendingRequestType(request) === "notify");
        const taskScroll = createElement("div", { class: "saa-task-scroll" });
        if (tasks?.pendingRequestsError) {
          taskScroll.append(createElement("div", { class: "saa-error saa-pending-empty" }, `⚠ 待处理需求暂不可用：${tasks.pendingRequestsError}`));
        }
        appendPendingSection(taskScroll, needs, "need");
        appendPendingSection(taskScroll, notifications, "notify");
        const allTasks = normalizedTaskItems(tasks);
        const inProgressTasks = tasksByStatus(tasks, "in_progress");
        const blockedTasks = tasksByStatus(tasks, "blocked");
        const openTasks = tasksByStatus(tasks, "open");
        const otherTempTasks = allTasks.filter((task) => isTempTask(task) && !["in_progress", "blocked", "open"].includes(task.status));
        const stateTitle = createElement("div", { class: "saa-task-title" });
        stateTitle.append(createElement("span", {}, "任务状态"), createElement("span", { class: "saa-task-count" }, `${allTasks.length} 个任务`));
        taskScroll.append(stateTitle);
        appendTaskStatusSection(taskScroll, "进行中", inProgressTasks, "暂无进行中任务");
        appendTaskStatusSection(taskScroll, "阻塞中", blockedTasks, "暂无阻塞任务");
        appendTaskStatusSection(taskScroll, "可推进", openTasks, "暂无可推进任务");
        if (otherTempTasks.length > 0) appendTaskStatusSection(taskScroll, "临时任务", otherTempTasks, "暂无临时任务");
        const taskTitle = createElement("div", { class: "saa-task-title" });
        taskTitle.append(createElement("span", {}, "项目进度"), createElement("span", { class: "saa-task-count" }, `${groups.length} 个项目`));
        taskScroll.append(taskTitle);
        if (tasks?.source === "file-stale") taskScroll.append(createElement("div", { class: "saa-stale" }, "⚠ file-stale：云端任务暂不可用，以下仅供展示"));
        if (tasks?.error) taskScroll.append(createElement("div", { class: "saa-error" }, tasks.error));
        else if (groups.length === 0 && rawContent) taskScroll.append(createElement("pre", { class: "saa-raw" }, rawContent));
        else if (groups.length === 0) taskScroll.append(createElement("div", { class: "saa-empty" }, "暂无任务"));
        else {
          const list = createElement("ul", { class: "saa-project-list" });
          for (const group of groups) {
            const task = group.latest;
            const project = createElement("li", { class: "saa-project" });
            const projectHead = createElement("div", { class: "saa-project-head" });
            projectHead.append(createElement("span", { class: "saa-project-mark", "aria-hidden": "true" }), createElement("span", { class: "saa-project-name", title: group.title }, group.title));
            const taskRow = createElement("div", { class: "saa-task", "data-kind": isTempTask(task) ? "temp" : "task" });
            const taskMain = createElement("div", { class: "saa-task-main" });
            appendTaskDetails(taskMain, task, false);
            taskRow.append(taskMain);
            project.append(projectHead, taskRow);
            list.append(project);
          }
          taskScroll.append(list);
        }
        panel.append(taskScroll);
        taskScroll.scrollTop = taskScrollTop;
        head.addEventListener("pointerdown", (event) => {
          if (event.target?.closest?.("button")) return;
          startDrag("panel", event);
        });
        clampAll();
      }
      function row(label, value) {
        const line = createElement("div", { class: "saa-status-row" });
        line.append(createElement("strong", {}, label), createElement("span", {}, value));
        return line;
      }
      function startDrag(target, event) {
        if (event.button !== undefined && event.button !== 0) return;
        syncBallAnchor();
        moving = true;
        moved = false;
        dragTarget = target;
        pointerId = event.pointerId;
        const element = target === "ball" ? ball : panel;
        startX = event.clientX;
        startY = event.clientY;
        startLeft = ballPosition.left;
        startTop = ballPosition.top;
        startWidth = ballSize.width;
        startHeight = ballSize.height;
        element.setPointerCapture?.(pointerId);
        event.preventDefault();
      }

      function endDrag(event, activate) {
        if (!moving || event.pointerId !== pointerId) return;
        const element = dragTarget === "ball" ? ball : panel;
        moving = false;
        element.releasePointerCapture?.(pointerId);
        const shouldOpen = activate && dragTarget === "ball" && !moved;
        dragTarget = undefined;
        if (shouldOpen) {
          open = true;
          render();
        }
      }

      panel.addEventListener("pointerdown", (event) => {
        if (event.target?.closest?.("button")) return;
        if (event.target === panel) startDrag("panel", event);
      });

      async function toggleMode(button) {
        const sessionId = currentSessionId(ctx);
        if (sessionId === undefined || busy) return;
        busy = true;
        button.disabled = true;
        try {
          const result = await remoteApi.setMode(sessionId, lastState?.enabled !== true);
          if (result?.ok === false) throw new Error(result.error?.message ?? "模式切换失败");
          lastState = result?.value ?? result;
          render();
        } catch (error) {
          console.warn("sagitta-auto-advance: mode toggle failed", error);
        } finally {
          busy = false;
          render();
        }
      }
      async function refresh(forceTasks = false) {
        const sessionId = currentSessionId(ctx);
        if (sessionId === undefined) {
          lastState = undefined;
          render();
          return;
        }
        try {
          const result = await remoteApi.getState(sessionId);
          if (result?.ok === false) throw new Error(result.error?.message ?? "状态读取失败");
          lastState = result?.value ?? result;
          if (forceTasks || tasks === undefined) {
            const taskResult = await remoteApi.getTasks(sessionId);
            if (taskResult?.ok === false) throw new Error(taskResult.error?.message ?? "任务读取失败");
            tasks = taskResult?.value ?? taskResult;
          }
        } catch (error) {
          console.warn("sagitta-auto-advance: refresh failed", error);
        }
        render();
      }
      function pointerMove(event) {
        if (!moving || event.pointerId !== pointerId) return;
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        if (Math.abs(dx) + Math.abs(dy) > 5) moved = true;
        if (!moved) return;
        const position = clampPosition(startLeft + dx, startTop + dy, startWidth, startHeight);
        ballPosition = position;
        ballSize = { width: startWidth, height: startHeight };
        if (!ball.hidden) applyPosition(ball, position);
        if (!panel.hidden) placePanelAtBall();
      }
      function pointerDown(event) {
        startDrag("ball", event);
      }
      ball.addEventListener("pointerdown", pointerDown);
      ball.addEventListener("click", () => {
        // Pointerup opens the panel for a normal mouse/touch activation. This
        // also covers keyboard activation while keeping a drag from opening it.
        if (!open && !moving && !moved) {
          open = true;
          render();
        }
        moved = false;
      });
      ball.addEventListener("pointermove", pointerMove);
      ball.addEventListener("pointerup", (event) => endDrag(event, true));
      ball.addEventListener("pointercancel", (event) => endDrag(event, false));
      panel.addEventListener("pointermove", pointerMove);
      panel.addEventListener("pointerup", (event) => endDrag(event, false));
      panel.addEventListener("pointercancel", (event) => endDrag(event, false));
      const resize = () => clampAll();
      window.addEventListener("resize", resize);
      window.visualViewport?.addEventListener("resize", resize);
      const poll = window.setInterval(() => refresh(false), 1000);
      const taskPoll = window.setInterval(() => refresh(true), 5000);
      render();
      void refresh(true);
      return () => {
        window.clearInterval(poll);
        window.clearInterval(taskPoll);
        window.removeEventListener("resize", resize);
        window.visualViewport?.removeEventListener("resize", resize);
        ball.removeEventListener("pointerdown", pointerDown);
        ball.removeEventListener("pointermove", pointerMove);
        panel.removeEventListener("pointermove", pointerMove);
        root.remove();
        style.remove();
      };
    }

    async function apply(ctx) {
      const disposeRemote = await ctx.remote.$mount(REMOTE);
      const remoteApi = ctx.get("remote.sagittaAutoAdvance");
      if (remoteApi === undefined) throw new Error("sagitta-auto-advance: RPC namespace failed to mount");
      const disposeUi = mount(ctx, remoteApi);
      const disposeHeader = mountHeaderAction(ctx, remoteApi);
      ctx.effect(() => async () => {
        disposeUi();
        disposeHeader();
        await disposeRemote();
      }, "sagitta-auto-advance: floating window and async-work header");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
