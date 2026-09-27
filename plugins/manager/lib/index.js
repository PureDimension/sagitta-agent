import { Service } from "@deepseek-ai/cordis";
import { Config } from "./config.js";
import { resolveCredentials } from "./credentials.js";
import { deployWorker as runWorkerDeployment } from "./deploy.js";
import { requestWorker } from "./request.js";

const name = "sagitta-manager";
const namespace = "sagitta-manager";

class SagittaManagerService extends Service {
  constructor(ctx) {
    super(ctx, name);
    this.scope = undefined;
  }

  async apiConfig() {
    if (this.scope === undefined) throw new Error("sagitta-manager settings scope is unavailable");
    const config = this.scope.get();
    if (config === undefined) throw new Error("sagitta-manager settings are unavailable");
    const credentials = await resolveCredentials(this.ctx, config);
    return {
      workerApiUrl: config.workerApiUrl,
      proxy: config.proxy,
      scriptName: config.scriptName,
      cfAccountId: config.cfAccountId,
      repoPath: config.repoPath,
      codexModel: config.codexModel,
      accessId: credentials.accessId,
      accessSecret: credentials.accessSecret,
      uploadToken: credentials.uploadToken
    };
  }

  async request(path, init) {
    if (this.scope === undefined) throw new Error("sagitta-manager settings scope is unavailable");
    const config = this.scope.get();
    if (config === undefined) throw new Error("sagitta-manager settings are unavailable");
    const credentials = await resolveCredentials(this.ctx, config);
    return requestWorker({ ...config, ...credentials }, path, init);
  }

  async deployWorker() {
    if (this.scope === undefined) throw new Error("sagitta-manager settings scope is unavailable");
    const config = this.scope.get();
    if (config === undefined) throw new Error("sagitta-manager settings are unavailable");
    return runWorkerDeployment({ ctx: this.ctx, config });
  }
}

function apply(ctx, config) {
  const service = new SagittaManagerService(ctx);
  ctx.effect(() => () => {
    service.scope = undefined;
  }, "sagitta-manager: service cleanup");

  return ctx.inject(["settings"], (settingsCtx) => {
    const scope = settingsCtx.settings.register(namespace, Config, { base: config });
    service.scope = scope;
    settingsCtx.effect(() => () => {
      if (service.scope === scope) service.scope = undefined;
    }, "sagitta-manager: settings scope cleanup");

    if (scope.get().repoPath === "") return;
    return service.deployWorker();
  });
}

export { Config, apply, name };
