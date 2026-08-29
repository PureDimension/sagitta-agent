import {
  Config,
  DEFAULT_BRANCH,
  DEFAULT_REPO_PATH,
  normalizeRepos
} from "./config.js";
import { checkRepository, runUpdateCheck } from "./git.js";
import { runStartupMaintenance } from "./service.js";

const name = "sagitta-updater";
// The manager service is the only source of Worker credentials. The service
// itself still handles a missing context defensively for degraded startup.
const inject = ["sagitta-manager"];

function apply(ctx, config) {
  // apply() must return immediately; all Git/package/network work is queued.
  queueMicrotask(() => {
    void runStartupMaintenance({ ctx, config, logger: ctx?.logger }).catch(() => {
      // Startup maintenance is strictly best-effort.
    });
  });
}

export {
  Config,
  DEFAULT_BRANCH,
  DEFAULT_REPO_PATH,
  apply,
  checkRepository,
  inject,
  name,
  normalizeRepos,
  runUpdateCheck,
  runStartupMaintenance
};
