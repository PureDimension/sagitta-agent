import z from "@deepseek-ai/schemastery";

export const Config = z.object({
  workerApiUrl: z.string().default("").description("Sagitta Worker 运行时 API 根地址；部署和请求时必填。"),
  proxy: z.string().default("http://127.0.0.1:7897").description("HTTP CONNECT 代理；空串表示直连。"),
  scriptName: z.string().default("sagitta-memory").description("Cloudflare Worker 脚本名。"),
  cfAccountId: z.string().default("").description("Cloudflare 账户 ID；部署 Worker 时必填。"),
  repoPath: z.string().default("").description("包含 worker/worker.js 的仓库路径；空串显式关闭自动部署。"),
  codexModel: z.string().default("gpt-5.6-luna").description("codex 派单默认模型；codex-dispatch 位于 preset 层无法注册 settings，故归此处统一配置。"),
  accessIdRef: z.string().default("SAGITTA_ACCESS_ID").description("Cloudflare Access Client ID 凭据引用名。"),
  accessSecretRef: z.string().default("SAGITTA_ACCESS_SECRET").description("Cloudflare Access Client Secret 凭据引用名。"),
  uploadTokenRef: z.string().default("SAGITTA_UPLOAD_TOKEN").description("Cloudflare API 上传 Token 凭据引用名。")
});
