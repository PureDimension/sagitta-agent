/** 复用 DSH 的颜色变量，使设置页跟随宿主的浅色、深色主题。 */
export const styles = `
.sagitta-settings {
  max-width: 640px;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 1.6;
}
.sagitta-settings h2 { margin: 0 0 8px; font-size: 18px; font-weight: 600; }
.sagitta-settings .intro { margin: 0 0 24px; color: var(--dsw-alias-label-tertiary); font-size: 13px; }
.sagitta-settings fieldset {
  display: grid;
  gap: 20px;
  min-width: 0;
  margin: 0;
  padding: 20px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: 20px;
  background: var(--dsw-alias-settings-card-fill);
}
.sagitta-settings label { display: grid; gap: 8px; font-size: 13px; font-weight: 500; }
.sagitta-settings input:not([type=checkbox]), .sagitta-settings select {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  min-height: 42px;
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  color: inherit;
  font: inherit;
  font-weight: 400;
}
.sagitta-settings input::placeholder { color: var(--dsw-alias-label-dimmed); }
.sagitta-settings input:focus-visible, .sagitta-settings select:focus-visible, .sagitta-settings button:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color);
  outline-offset: 2px;
}
.sagitta-settings .connection-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.sagitta-settings label:has([type=checkbox]) { display: flex; align-items: center; gap: 10px; font-weight: 400; }
.sagitta-settings input[type=checkbox] { margin: 0; accent-color: var(--dsw-alias-state-business-primary); }
.sagitta-settings .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding-top: 4px; }
.sagitta-settings .actions span { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.sagitta-settings button {
  padding: 9px 18px;
  border: 0;
  border-radius: 12px;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
  font: inherit;
  font-weight: 500;
  cursor: pointer;
}
.sagitta-settings button:hover:enabled { background: var(--dsw-alias-button-primary-hover); }
.sagitta-settings input:disabled, .sagitta-settings button:disabled, .sagitta-settings select:disabled { opacity: 0.5; cursor: default; }
.sagitta-settings .error { color: var(--dsw-alias-state-error-primary); font-size: 13px; }
.sagitta-settings .success { color: var(--dsw-alias-state-success-primary); font-size: 13px; }
@media (max-width: 520px) {
  .sagitta-settings fieldset { padding: 16px; }
  .sagitta-settings .connection-fields { grid-template-columns: 1fr; }
}
`;
