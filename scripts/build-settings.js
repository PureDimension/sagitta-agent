import { build } from 'esbuild';

// 沿用 DSH 浏览器模块格式；React 由宿主提供，后端代码只以类型导入。
await build({
  entryPoints: ['plugins/settings/src/index.tsx'],
  outfile: 'plugins/settings/dist/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  external: ['react'],
  banner: { js: `window.__ModuleLoader__.load({ id: '@sagitta/runtime', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;` },
  footer: { js: 'return module.exports; } });' },
});
