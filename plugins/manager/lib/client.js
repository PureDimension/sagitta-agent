window.__ModuleLoader__.load({
  id: "@sagitta/manager",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const { jsx, jsxs } = require("react/jsx-runtime");

    const name = "sagitta-manager";
    const namespace = "sagitta-manager";
    const inject = ["slots", "settingsScope"];
    const fields = [
      { key: "workerApiUrl", label: "Worker API 地址", hint: "Sagitta Worker 运行时 API 根地址。" },
      { key: "proxy", label: "HTTP 代理", hint: "留空表示直连；默认使用本机 7897 端口。" },
      { key: "scriptName", label: "Worker 脚本名", hint: "Cloudflare Worker 脚本名。" },
      { key: "cfAccountId", label: "Cloudflare 账户 ID", hint: "部署 Worker 使用的 Cloudflare 账户 ID；非密钥。" },
      { key: "repoPath", label: "仓库路径", hint: "部署时读取 worker/worker.js；留空表示关闭自动部署。" },
      { key: "codexModel", label: "codex 默认模型", hint: "codex 派单使用的默认模型。" },
      { key: "accessIdRef", label: "Access Client ID 引用名", hint: "凭据域中 Access Client ID 的引用名。" },
      { key: "accessSecretRef", label: "Access Client Secret 引用名", hint: "凭据域中 Access Client Secret 的引用名。" },
      { key: "uploadTokenRef", label: "Worker 上传 Token 引用名", hint: "凭据域中 Cloudflare 上传 Token 的引用名。" }
    ];
    const credentialFields = [
      { key: "accessId", refKey: "accessIdRef", label: "Access Client ID", hint: "留空保持当前凭据；明文不会回显。" },
      { key: "accessSecret", refKey: "accessSecretRef", label: "Access Client Secret", hint: "留空保持当前凭据；明文不会回显。" },
      { key: "uploadToken", refKey: "uploadTokenRef", label: "Worker 上传 Token", hint: "留空保持当前凭据；明文不会回显。" }
    ];
    const styleText = `
      .sagitta-manager-card { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-3); border-radius: 12px; list-style: none; color: var(--dsw-alias-label-primary); }
      .sagitta-manager-header { width: 100%; padding: 14px 16px; border: 0; color: inherit; background: transparent; text-align: left; }
      .sagitta-manager-title { display: block; font-size: 15px; font-weight: 600; line-height: 1.4; }
      .sagitta-manager-description, .sagitta-manager-hint, .sagitta-manager-readonly, .sagitta-manager-error { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.5; }
      .sagitta-manager-description { display: block; margin-top: 4px; }
      .sagitta-manager-body { margin: 0 16px; border-top: 1px solid var(--dsw-alias-border-l2); padding-bottom: 8px; }
      .sagitta-manager-field { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; }
      .sagitta-manager-field + .sagitta-manager-field { border-top: 1px solid var(--dsw-alias-border-l2); }
      .sagitta-manager-field-head { display: flex; align-items: center; gap: 8px; }
      .sagitta-manager-label { min-width: 0; color: var(--dsw-alias-label-primary); flex: 1; font-size: 13px; font-weight: 500; line-height: 1.5; }
      .sagitta-manager-overridden, .sagitta-manager-pending, .sagitta-manager-secret-state { border-radius: 999px; padding: 1px 8px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-module-platform); font-size: 11px; line-height: 17px; }
      .sagitta-manager-secret-state.is-unset { color: var(--dsw-alias-label-tertiary); background: transparent; }
      .sagitta-manager-reset { border: 0; padding: 0; color: var(--dsw-alias-label-secondary); background: transparent; cursor: pointer; font: inherit; font-size: 12px; }
      .sagitta-manager-reset:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
      .sagitta-manager-input { height: 34px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 0 12px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-3); font: inherit; font-size: 13px; }
      .sagitta-manager-input:focus-visible { border-color: var(--dsw-alias-brand-primary); outline: none; }
      .sagitta-manager-input:disabled, .sagitta-manager-reset:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
      .sagitta-manager-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; border-top: 1px solid var(--dsw-alias-border-l2); padding: 12px 0 4px; }
      .sagitta-manager-footer button { border: 1px solid transparent; border-radius: 8px; padding: 5px 14px; cursor: pointer; font: inherit; font-size: 13px; line-height: 1.5; }
      .sagitta-manager-discard { border-color: var(--dsw-alias-border-l2) !important; color: var(--dsw-alias-label-secondary); background: transparent; }
      .sagitta-manager-save { color: var(--dsw-alias-bg-layer-3); background: var(--dsw-alias-label-primary); }
      .sagitta-manager-footer button:disabled { opacity: .4; cursor: default; }
      .sagitta-manager-error { min-width: 0; margin: 0; color: var(--dsw-alias-label-error); flex: 1; }
    `;

    function installStyles() {
      if (document.querySelector("style[data-sagitta-manager]") !== null) return;
      const style = document.createElement("style");
      style.dataset.sagittaManager = "true";
      style.textContent = styleText;
      document.head.appendChild(style);
    }

    function useScopeSnapshot(scope) {
      return React.useSyncExternalStore(
        (listener) => scope.subscribe(listener),
        () => scope.getSnapshot(),
        () => scope.getSnapshot()
      );
    }

    function fieldValue(snapshot, key) {
      const value = snapshot.value?.[key];
      return typeof value === "string" ? value : "";
    }

    function userHas(snapshot, key) {
      return snapshot.user !== undefined && Object.hasOwn(snapshot.user, key);
    }

    function errorMessage(error) {
      return error instanceof Error ? error.message : String(error);
    }

    function ManagerCard({ scope, api, remote }) {
      const snapshot = useScopeSnapshot(scope);
      const allFields = [...fields, ...credentialFields];
      const [drafts, setDrafts] = React.useState(() => Object.fromEntries(allFields.map(({ key }) => [key, ""])));
      const [staged, setStaged] = React.useState(() => new Set());
      const [baseRevision, setBaseRevision] = React.useState(snapshot.revision);
      const [saving, setSaving] = React.useState(false);
      const [error, setError] = React.useState("");
      const [credentialViews, setCredentialViews] = React.useState(() => Object.fromEntries(credentialFields.map(({ key }) => [key, {
        ref: "",
        configured: false,
        writable: false,
        error: ""
      }])));
      const [credentialReload, setCredentialReload] = React.useState(0);
      const writable = snapshot.status === "ready" && snapshot.writable === true;
      const credentialRefs = credentialFields.map((field) => {
        const value = staged.has(field.refKey) ? drafts[field.refKey] : fieldValue(snapshot, field.refKey);
        return typeof value === "string" ? value.trim() : "";
      });
      const credentialRefsKey = credentialRefs.join("\u0000");

      React.useEffect(() => {
        if (staged.size !== 0) return;
        setDrafts(Object.fromEntries(allFields.map(({ key }) => [key, ""])));
        setBaseRevision(snapshot.revision);
      }, [snapshot.revision, snapshot.status, staged.size]);

      React.useEffect(() => {
        let disposed = false;
        async function readCredentials() {
          for (let index = 0; index < credentialFields.length; index += 1) {
            const field = credentialFields[index];
            const ref = credentialRefs[index];
            if (ref === "") {
              setCredentialViews((current) => ({ ...current, [field.key]: { ref, configured: false, writable: false, error: "" } }));
              continue;
            }
            setCredentialViews((current) => ({ ...current, [field.key]: { ref, configured: false, writable: true, error: "" } }));
            try {
              const response = await api.credentials.describe({ refs: [ref] });
              if (!response.result.ok) throw new Error(`credential describe failed: ${ref}`);
              const view = response.result.value.credentials[ref];
              if (disposed) return;
              const currentSnapshot = scope.getSnapshot();
              const currentValue = staged.has(field.refKey) ? drafts[field.refKey] : fieldValue(currentSnapshot, field.refKey);
              if (ref !== (typeof currentValue === "string" ? currentValue.trim() : "")) continue;
              setCredentialViews((current) => ({ ...current, [field.key]: {
                ref,
                configured: view?.configured === true,
                writable: view?.writable ?? true,
                error: ""
              } }));
            } catch (readError) {
              if (disposed) return;
              setCredentialViews((current) => ({ ...current, [field.key]: {
                ref,
                configured: false,
                writable: false,
                error: errorMessage(readError)
              } }));
              setError(errorMessage(readError));
            }
          }
        }
        void readCredentials();
        return () => {
          disposed = true;
        };
      }, [api, scope, credentialRefsKey, credentialReload]);

      React.useEffect(() => remote.$on("credentials/reference-updated", (ref) => {
        if (credentialRefs.includes(ref)) setCredentialReload((current) => current + 1);
      }), [remote, credentialRefsKey]);

      if (snapshot.status === "unavailable") return null;

      const edit = (key, value) => {
        if (staged.size === 0) setBaseRevision(snapshot.revision);
        setDrafts((current) => ({ ...current, [key]: value }));
        setStaged((current) => new Set(current).add(key));
        setError("");
      };

      const reset = (key) => {
        if (staged.size === 0) setBaseRevision(snapshot.revision);
        setDrafts((current) => ({ ...current, [key]: typeof snapshot.base?.[key] === "string" ? snapshot.base[key] : "" }));
        setStaged((current) => new Set(current).add(key));
        setError("");
      };

      const discard = () => {
        setStaged(new Set());
        setError("");
      };

      const save = async () => {
        if (!writable || saving || staged.size === 0) return;
        if (snapshot.revision !== baseRevision) {
          setError("配置已被其他页面修改，请先丢弃草稿并重新编辑。");
          return;
        }
        setSaving(true);
        setError("");
        try {
          let landed = true;
          for (const field of fields) {
            if (!staged.has(field.key)) continue;
            const value = drafts[field.key].trim();
            if (value === "") await scope.unset(field.key);
            else await scope.set(field.key, value);
            const after = scope.getSnapshot();
            landed = landed && (value === "" ? !userHas(after, field.key) : after.user?.[field.key] === value);
          }
          if (!landed) throw new Error("配置未保存，请检查设置服务后重试。");
          const current = scope.getSnapshot();
          for (const field of credentialFields) {
            if (!staged.has(field.key)) continue;
            const value = drafts[field.key].trim();
            if (value === "") continue;
            const ref = fieldValue(current, field.refKey).trim();
            if (ref === "") throw new Error(`${field.label} 没有有效的引用名`);
            await api.credentials.set({ ref, value });
          }
          setCredentialReload((currentReload) => currentReload + 1);
          setStaged(new Set());
        } catch (saveError) {
          setError(errorMessage(saveError));
        } finally {
          setSaving(false);
        }
      };

      return jsx("li", { className: "sagitta-manager-card", children: [
        jsxs("header", { className: "sagitta-manager-header", children: [
          jsx("span", { className: "sagitta-manager-title", children: "Sagitta Manager" }),
          jsx("span", { className: "sagitta-manager-description", children: "统一管理 Worker 地址、代理、部署来源与凭据。" })
        ] }),
        jsxs("div", { className: "sagitta-manager-body", children: [
          fields.map((field) => jsxs("div", { className: "sagitta-manager-field", children: [
            jsxs("div", { className: "sagitta-manager-field-head", children: [
              jsx("label", { className: "sagitta-manager-label", htmlFor: `sagitta-manager-${field.key}`, children: field.label }),
              staged.has(field.key) ? jsx("span", { className: "sagitta-manager-pending", children: "未保存" }) : userHas(snapshot, field.key) ? jsx("span", { className: "sagitta-manager-overridden", children: "已覆盖" }) : null,
              userHas(snapshot, field.key) ? jsx("button", { className: "sagitta-manager-reset", type: "button", disabled: !writable || saving, onClick: () => reset(field.key), children: "重置" }) : null
            ] }),
            jsx("input", { className: "sagitta-manager-input", id: `sagitta-manager-${field.key}`, type: "text", value: staged.has(field.key) ? drafts[field.key] : fieldValue(snapshot, field.key), disabled: !writable || saving, onChange: (event) => edit(field.key, event.target.value) }),
            jsx("p", { className: "sagitta-manager-hint", children: field.hint })
          ] }, field.key)),
          credentialFields.map((field, index) => {
            const view = credentialViews[field.key];
            const configured = view.configured === true;
            const canWrite = writable && view.writable === true && credentialRefs[index] !== "";
            return jsxs("div", { className: "sagitta-manager-field", children: [
              jsxs("div", { className: "sagitta-manager-field-head", children: [
                jsx("label", { className: "sagitta-manager-label", htmlFor: `sagitta-manager-${field.key}`, children: field.label }),
                jsx("span", { className: `sagitta-manager-secret-state${configured ? "" : " is-unset"}`, children: configured ? "已配置" : "未配置" }),
                staged.has(field.key) ? jsx("span", { className: "sagitta-manager-pending", children: "未保存" }) : null
              ] }),
              jsx("input", { className: "sagitta-manager-input", id: `sagitta-manager-${field.key}`, type: "password", autoComplete: "off", value: staged.has(field.key) ? drafts[field.key] : "", disabled: !canWrite || saving, onChange: (event) => edit(field.key, event.target.value) }),
              jsx("p", { className: "sagitta-manager-hint", children: view.error || field.hint })
            ] }, field.key);
          }),
          !writable ? jsx("p", { className: "sagitta-manager-readonly", children: "本部署的设置为只读。" }) : null,
          jsxs("footer", { className: "sagitta-manager-footer", children: [
            error ? jsx("p", { className: "sagitta-manager-error", role: "status", children: error }) : null,
            jsx("button", { className: "sagitta-manager-discard", type: "button", disabled: saving || staged.size === 0, onClick: discard, children: "丢弃" }),
            jsx("button", { className: "sagitta-manager-save", type: "button", disabled: !writable || saving || staged.size === 0, onClick: () => void save(), children: saving ? "保存中…" : "保存" })
          ] })
        ] })
      ] });
    }

    function apply(ctx) {
      installStyles();
      const scope = ctx.settingsScope.bind({ namespace });
      const { api } = ctx.get("connection");
      const remote = ctx.remote;
      ctx.slots.inject("settings.plugin.item", function* () {
        yield ctx.slots.register({
          name: "settings.plugin.item",
          key: namespace,
          locale: namespace,
          inject: () => ({ scope, api, remote })
        }, ManagerCard);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = name;
    return module.exports;
  }
});
