window.__ModuleLoader__.load({
  id: "@sagitta/manager",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const react = require("react");
    const react_jsx_runtime = require("react/jsx-runtime");
    const { jsx, jsxs } = react_jsx_runtime;

    const name = "sagitta-manager";
    const namespace = "sagitta-manager";
    const inject = ["slots", "settingsScope"];
    const RESTART_UNAVAILABLE = "restart-unavailable";
    const FIELDS = [
      { field: "workerApiUrl", label: "Worker API 地址", hint: "Sagitta Worker 运行时 API 根地址；memory、task 和健康检查从这里派生。", secret: false },
      { field: "cfAccountId", label: "CF 账户 ID", hint: "Worker direct PUT 部署使用的 Cloudflare 账户 ID；非 secret。", secret: false },
      { field: "cfScriptName", label: "Worker 脚本名", hint: "Worker direct PUT 部署使用的 Cloudflare Worker 脚本名；非 secret。", secret: false },
      { field: "workerUploadToken", label: "Worker 部署 Token", hint: "仅 updater 部署 Worker 使用；输入框不会回填已存 Token。", secret: true },
      { field: "accessClientId", label: "Access Client ID", hint: "Cloudflare Access 服务令牌 Client ID；memory/auto-advance 访问 worker 的网关放行凭据（CF-Access-Client-Id 头）。", secret: true },
      { field: "accessClientSecret", label: "Access Client Secret", hint: "与 accessClientId 成对的 Secret；网关放行后 worker 免 Bearer。", secret: true },
      { field: "d1ReadToken", label: "D1 读 Token", hint: "memory recall/list/search 与 task list/get 使用（Bearer 语义；Access 已配时可不填）。", secret: true },
      { field: "d1WriteToken", label: "D1 写 Token", hint: "memory remember/consolidate/verify 与 task 写操作使用。", secret: true }
    ];
    const EMPTY_SCOPE_SNAPSHOT = { status: "unavailable", value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: "memory" };
    const COPY = { title: "Sagitta Manager", description: "统一管理 Sagitta Worker 与 D1 访问配置。", configured: "已配置", notConfigured: "未配置", health: "Worker 健康状态", healthNotConfigured: "未配置地址", healthChecking: "检查中…", healthOk: "正常", healthFailed: "不可用", save: "保存", saveRestart: "保存并重启", saving: "保存中…", clear: "清除", saved: "配置已保存。", restartUnavailable: "配置已保存，请手动重启 DSH（dsh --profile web）。", readOnly: "本部署的设置为只读。", saveFailed: "配置未保存，请检查设置服务后重试。" };
    const STYLE = `.sagitta-manager-card{list-style:none;padding:16px;border:1px solid var(--dsw-alias-border-l2,rgba(128,144,164,.25));border-radius:12px;color:var(--dsw-alias-label-primary,#e8edf5);background:var(--dsw-alias-bg-layer-3,#1d2430)}.sagitta-manager-header h3{margin:0;font-size:15px}.sagitta-manager-header p,.sagitta-manager-health,.sagitta-manager-field-foot,.sagitta-manager-readonly,.sagitta-manager-message{color:var(--dsw-alias-label-tertiary,#9aa8ba);font-size:12px;line-height:1.5}.sagitta-manager-header p{margin:4px 0 14px}.sagitta-manager-health{display:flex;justify-content:space-between;gap:12px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04))}.sagitta-manager-health strong{color:inherit;font-weight:600}.sagitta-manager-fields{margin-top:8px}.sagitta-manager-field{display:grid;gap:6px;padding:11px 0;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,144,164,.18))}.sagitta-manager-field-head,.sagitta-manager-field-foot,.sagitta-manager-actions{display:flex;align-items:center;justify-content:space-between;gap:8px}.sagitta-manager-field-head label{font-size:13px;font-weight:600}.sagitta-manager-badge{padding:1px 7px;border-radius:999px;font-size:11px}.sagitta-manager-badge.is-configured{color:#8ed9ae;background:rgba(73,177,111,.14)}.sagitta-manager-badge.is-unconfigured{color:var(--dsw-alias-label-tertiary,#9aa8ba);background:rgba(128,144,164,.12)}.sagitta-manager-field input{min-width:0;height:32px;padding:0 9px;border:1px solid var(--dsw-alias-border-l2,rgba(128,144,164,.3));border-radius:7px;color:inherit;background:var(--dsw-alias-bg-layer-3,#1d2430);font:inherit}.sagitta-manager-field input:focus-visible{border-color:var(--dsw-alias-brand-primary,#6e9eff);outline:2px solid var(--dsw-alias-brand-primary,#6e9eff);outline-offset:1px}.sagitta-manager-field-foot{align-items:flex-start}.sagitta-manager-field-foot span{flex:1}.sagitta-manager-field-foot button,.sagitta-manager-actions button{border:1px solid var(--dsw-alias-border-l2,rgba(128,144,164,.3));border-radius:7px;padding:4px 10px;color:inherit;background:transparent;cursor:pointer;font:inherit;font-size:12px}.sagitta-manager-actions{justify-content:flex-end;margin-top:13px}.sagitta-manager-actions button:last-child{border-color:var(--dsw-alias-label-primary,#e8edf5);color:var(--dsw-alias-bg-layer-3,#1d2430);background:var(--dsw-alias-label-primary,#e8edf5)}.sagitta-manager-field button:disabled,.sagitta-manager-actions button:disabled{opacity:.45;cursor:default}.sagitta-manager-readonly,.sagitta-manager-message{margin:10px 0 0}.sagitta-manager-message{color:var(--dsw-alias-label-secondary,#c7d0dc)}`;
    function installStyles() { if (typeof document === "undefined" || document.querySelector("style[data-sagitta-manager]") !== null) return; const style = document.createElement("style"); style.dataset.sagittaManager = "true"; style.textContent = STYLE; document.head.appendChild(style); }

    function safeString(value) { return typeof value === "string" ? value : ""; }
    function isConfigured(value) { return safeString(value).trim().length > 0; }
    function useExternalSnapshot(source, fallback) {
      const getSnapshot = react.useCallback(() => source?.getSnapshot?.() ?? fallback, [source, fallback]);
      const subscribe = react.useCallback((listener) => source?.subscribe?.(listener) ?? (() => {}), [source]);
      return react.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    }
    function currentSecretState(describe, scopeSnapshot, field) {
      const mirrorSnapshot = describe?.getSnapshot?.();
      const row = mirrorSnapshot?.view?.namespaces?.find((entry) => entry.ns === namespace);
      const descriptorSecret = row?.secrets?.find((entry) => entry.path?.length === 1 && entry.path[0] === field);
      if (descriptorSecret !== undefined) return descriptorSecret.set === true;
      const scopeSecret = scopeSnapshot?.secrets?.find?.((entry) => entry.path?.length === 1 && entry.path[0] === field);
      if (scopeSecret !== undefined) return scopeSecret.set === true;
      return isConfigured(scopeSnapshot?.value?.[field]);
    }
    function healthEndpoint(apiUrl) {
      if (!isConfigured(apiUrl)) return undefined;
      try { return new URL("health", `${apiUrl.replace(/\/+$/, "")}/`).toString(); } catch { return undefined; }
    }
    function useWorkerHealth(apiUrl) {
      const [health, setHealth] = react.useState(() => ({ kind: apiUrl ? "checking" : "not-configured" }));
      react.useEffect(() => {
        const endpoint = healthEndpoint(apiUrl);
        if (endpoint === undefined) { setHealth({ kind: "not-configured" }); return undefined; }
        const controller = new AbortController();
        setHealth({ kind: "checking" });
        if (typeof fetch !== "function") { setHealth({ kind: "failed" }); return () => controller.abort(); }
        fetch(endpoint, { method: "GET", signal: controller.signal })
          .then((response) => setHealth({ kind: response.ok ? "ok" : "failed" }))
          .catch((error) => { if (error?.name !== "AbortError") setHealth({ kind: "failed" }); });
        return () => controller.abort();
      }, [apiUrl]);
      return health;
    }
    function healthText(health) {
      switch (health.kind) { case "ok": return COPY.healthOk; case "checking": return COPY.healthChecking; case "failed": return COPY.healthFailed; default: return COPY.healthNotConfigured; }
    }
    function requestHostRestart(reason, adapter) {
      if (typeof adapter !== "function") return RESTART_UNAVAILABLE;
      try { return adapter(reason); } catch { return RESTART_UNAVAILABLE; }
    }
    function fieldRow(field, value, configuredState, draft, writable, onEdit, onClear) {
      const id = `sagitta-manager-${field.field}`;
      return jsxs("div", { className: "sagitta-manager-field", children: [
        jsxs("div", { className: "sagitta-manager-field-head", children: [
          jsx("label", { htmlFor: id, children: field.label }),
          jsx("span", { className: `sagitta-manager-badge ${configuredState ? "is-configured" : "is-unconfigured"}`, children: configuredState ? COPY.configured : COPY.notConfigured })
        ] }),
        jsx("input", { id, type: field.secret ? "password" : "text", autoComplete: field.secret ? "new-password" : "off", value: draft, disabled: !writable, onChange: (event) => onEdit(field.field, event.target.value), "aria-label": field.label }),
        jsxs("div", { className: "sagitta-manager-field-foot", children: [
          jsx("span", { children: field.secret ? field.hint : `${field.hint} 当前值：${safeString(value) || COPY.notConfigured}` }),
          jsx("button", { type: "button", disabled: !writable, onClick: () => onClear(field.field), children: COPY.clear })
        ] })
      ] });
    }
    function ManagerCard(props) {
      const scope = props.scope;
      const snapshot = useExternalSnapshot(scope, EMPTY_SCOPE_SNAPSHOT);
      const value = snapshot.value && typeof snapshot.value === "object" ? snapshot.value : {};
      const [drafts, setDrafts] = react.useState(() => ({ workerApiUrl: "", cfAccountId: "", cfScriptName: "", workerUploadToken: "", d1ReadToken: "", d1WriteToken: "" }));
      const [staged, setStaged] = react.useState(() => new Set());
      const [saving, setSaving] = react.useState(false);
      const [message, setMessage] = react.useState("");
      const workerApiUrl = safeString(value.workerApiUrl);
      const cfAccountId = safeString(value.cfAccountId);
      const cfScriptName = safeString(value.cfScriptName);
      const health = useWorkerHealth(workerApiUrl);
      const writable = snapshot.writable === true && snapshot.status === "ready";
      react.useEffect(() => { if (snapshot.status !== "ready" || staged.size > 0) return; setDrafts((previous) => ({ ...previous, workerApiUrl, cfAccountId, cfScriptName })); }, [snapshot.status, snapshot.revision, staged.size, workerApiUrl, cfAccountId, cfScriptName]);
      const edit = (field, text) => {
        setMessage(""); setDrafts((previous) => ({ ...previous, [field]: text }));
        setStaged((previous) => { const next = new Set(previous); if (text.length === 0) next.delete(field); else next.add(field); return next; });
      };
      const clear = async (field) => {
        if (!writable || typeof scope?.unset !== "function") return;
        setSaving(true); setMessage("");
        try {
          await scope.unset(field); setDrafts((previous) => ({ ...previous, [field]: "" }));
          setStaged((previous) => { const next = new Set(previous); next.delete(field); return next; }); setMessage(COPY.saved);
        } catch { setMessage(COPY.saveFailed); } finally { setSaving(false); }
      };
      const save = async (restart) => {
        if (!writable || typeof scope?.set !== "function" || saving) return RESTART_UNAVAILABLE;
        setSaving(true); setMessage("");
        try {
          for (const field of FIELDS) { const draft = safeString(drafts[field.field]); if (draft.length > 0 && staged.has(field.field)) await scope.set(field.field, draft); }
          const current = scope.getSnapshot?.()?.value;
          setStaged(new Set()); setDrafts((previous) => ({ ...previous, workerApiUrl: safeString(current?.workerApiUrl), cfAccountId: safeString(current?.cfAccountId), cfScriptName: safeString(current?.cfScriptName), workerUploadToken: "", d1ReadToken: "", d1WriteToken: "" }));
          if (!restart) { setMessage(COPY.saved); return "saved"; }
          const result = await Promise.resolve(requestHostRestart("sagitta-manager settings saved", props.requestHostRestart));
          setMessage(result === "restarted" || result === true ? COPY.saved : COPY.restartUnavailable); return result;
        } catch { setMessage(COPY.saveFailed); return "save-failed"; } finally { setSaving(false); }
      };
      if (snapshot.status === "unavailable") return null;
      return jsx("li", { className: "sagitta-manager-card", children: [
        jsxs("header", { className: "sagitta-manager-header", children: [jsx("h3", { children: COPY.title }), jsx("p", { children: COPY.description })] }),
        jsxs("div", { className: "sagitta-manager-health", role: "status", children: [jsx("strong", { children: COPY.health }), jsx("span", { children: healthText(health) })] }),
        jsx("div", { className: "sagitta-manager-fields", children: FIELDS.map((field) => fieldRow(field, value[field.field], field.secret ? currentSecretState(props.describe, snapshot, field.field) : isConfigured(value[field.field]), drafts[field.field], writable && !saving, edit, clear)) }),
        snapshot.writable !== true ? jsx("p", { className: "sagitta-manager-readonly", children: COPY.readOnly }) : null,
        message ? jsx("p", { className: "sagitta-manager-message", role: "status", children: message }) : null,
        jsxs("footer", { className: "sagitta-manager-actions", children: [
          jsx("button", { type: "button", disabled: !writable || saving || staged.size === 0, onClick: () => void save(false), children: saving ? COPY.saving : COPY.save }),
          jsx("button", { type: "button", disabled: !writable || saving, onClick: () => void save(true), children: saving ? COPY.saving : COPY.saveRestart })
        ] })
      ] });
    }
    class ManagerCardController {
      constructor(ctx, scope, describe, restartAdapter) { this.ctx = ctx; this.scope = scope; this.describe = describe; this.restartAdapter = restartAdapter; }
      inject() { return { scope: this.scope, describe: this.describe, requestHostRestart: this.restartAdapter }; }
    }
    function apply(ctx) {
      installStyles();
      const scope = ctx.settingsScope.bind({ namespace });
      const describe = ctx.settingsScope.describe?.();
      const controller = new ManagerCardController(ctx, scope, describe, undefined);
      ctx.slots.inject("settings.plugin.item", function* () {
        yield ctx.slots.register({ name: "settings.plugin.item", key: namespace, locale: namespace, inject: () => controller.inject() }, ManagerCard);
      });
    }
    exports.ManagerCard = ManagerCard;
    exports.apply = apply;
    exports.inject = inject;
    exports.name = name;
    exports.namespace = namespace;
    exports.requestHostRestart = requestHostRestart;
    return module.exports;
  }
});
