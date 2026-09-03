window.__ModuleLoader__.load({
  id: "@sagitta/auto-advance",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const inject = ["remote", "sessions"];
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
          for (const item of section.items) if (item === null || typeof item.text !== "string" || typeof item.done !== "boolean") throw new Error("invalid task item");
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
      .saa-task-main { min-width: 0; flex: 1 1 auto; }
      .saa-task-text { color: #bdcbe0; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
      .saa-task-meta { display: flex; align-items: center; gap: 7px; margin-top: 6px; }
      .saa-task-status { display: inline-flex; align-items: center; gap: 4px; padding: 3px 7px; border-radius: 999px; background: rgba(255,255,255,.07); color: #b9c7d8; font-size: 10px; font-weight: 650; white-space: nowrap; }
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
      .saa-task-updated { color: #73859c; font-size: 10px; }
      .saa-empty, .saa-error { padding: 13px; border-radius: 11px; background: rgba(255,255,255,.04); color: #899bb2; }
      .saa-stale { margin: -2px 0 8px; color: #ffc17e; font-size: 10px; }
      .saa-raw { max-width: 100%; box-sizing: border-box; margin: 0; padding: 13px; border: 1px solid rgba(148,171,201,.13); border-radius: 11px; background: rgba(0,0,0,.16); color: #bdcbe0; font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; }
      .saa-error { color: #ffaaa8; }
      @keyframes saa-panel-in { from { opacity: 0; } to { opacity: 1; } }
      @keyframes saa-spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .saa-panel, .saa-ball, .saa-project, .saa-toggle, .saa-close { animation: none; transition: none; } .saa-task-icon[data-status="in_progress"] { animation: none; } }
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
      let order = 0;
      const allowLegacyStatusGuess = snapshot?.source === "file-stale";
      for (const section of Array.isArray(snapshot?.sections) ? snapshot.sections : []) {
        const title = safeText(section?.title).trim() || "未分类";
        if (isReportInboxSection(title)) continue;
        const items = (Array.isArray(section?.items) ? section.items : []).map((item) => normalizeTask(item, order++, allowLegacyStatusGuess));
        if (items.length === 0) continue;
        if (isLegacyFlatSection(title, items)) {
          for (const item of items) {
            const project = item.project || item.text;
            groups.set(`${project}\u0000${item.order}`, { title: project, items: [item], order: item.order });
          }
          continue;
        }
        for (const item of items) {
          const project = item.project || title;
          const key = project.toLocaleLowerCase();
          const group = groups.get(key) ?? { title: project, items: [], order: item.order };
          group.items.push(item);
          groups.set(key, group);
        }
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
            const meta = STATUS_META[task.status] ?? STATUS_META.waiting;
            const project = createElement("li", { class: "saa-project" });
            const projectHead = createElement("div", { class: "saa-project-head" });
            projectHead.append(createElement("span", { class: "saa-project-mark", "aria-hidden": "true" }), createElement("span", { class: "saa-project-name", title: group.title }, group.title));
            const taskRow = createElement("div", { class: "saa-task" });
            const taskMain = createElement("div", { class: "saa-task-main" });
            taskMain.append(createElement("div", { class: "saa-task-text" }, task.text));
            const taskMeta = createElement("div", { class: "saa-task-meta" });
            const taskStatus = createElement("span", { class: "saa-task-status", "data-status": task.status });
            taskStatus.append(createElement("span", { class: "saa-task-icon", "data-status": task.status, "aria-hidden": "true" }, meta.icon), document.createTextNode(meta.label));
            taskMeta.append(taskStatus);
            if (task.updatedAt !== null) taskMeta.append(createElement("span", { class: "saa-task-updated" }, `更新于 ${new Date(task.updatedAt).toLocaleDateString()}`));
            taskMain.append(taskMeta);
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
      ctx.effect(() => async () => {
        disposeUi();
        await disposeRemote();
      }, "sagitta-auto-advance: floating window");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
