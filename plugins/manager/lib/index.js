import { Service } from "@deepseek-ai/cordis";
import { Config } from "./config.js";
import { resolveCredentials } from "./credentials.js";
import { deployWorker as runWorkerDeployment } from "./deploy.js";
import { requestWorker } from "./request.js";

const name = "sagitta-manager";
const namespace = "sagitta-manager";
const inject = ["settings", "credentials"];

class SagittaManagerService extends Service {
  // The scope is a constructor argument on purpose: a published service always
  // has a live settings scope. Registering after `super()` would publish a
  // service that any later registration failure leaves scope-less but alive.
  constructor(ctx, scope) {
    super(ctx, name);
    this.scope = scope;
  }

  async apiConfig() {
    const config = this.scope.get();
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
    const config = this.scope.get();
    const credentials = await resolveCredentials(this.ctx, config);
    return requestWorker({ ...config, ...credentials }, path, init);
  }

  async deployWorker() {
    return runWorkerDeployment({ ctx: this.ctx, config: this.scope.get() });
  }
}

function apply(ctx, config) {
  const scope = ctx.settings.register(namespace, Config, { base: config });
  const service = new SagittaManagerService(ctx, scope);

  if (scope.get().repoPath === "") return;
  service.deployWorker().catch((error) => {
    ctx.logger.warn("sagitta-manager automatic deployment failed; settings remain available: %s", error.message);
  });
}

export { Config, apply, inject, name };
