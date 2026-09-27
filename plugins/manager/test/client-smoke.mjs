import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");

function loadClient(code) {
  let plugin;
  runInNewContext(code, {
    window: { __ModuleLoader__: { load({ factory }) {
      plugin = factory(() => ({}));
    } } },
    document: { querySelector: () => ({}) }
  });
  return plugin;
}

function applyClient(plugin) {
  const scope = {};
  const api = {};
  const remote = {};
  let registered = false;
  const services = {
    settingsScope: { bind(options) {
      assert.equal(options.namespace, "sagitta-manager");
      return scope;
    } },
    connection: { api },
    remote,
    slots: {
      inject(name, factory) {
        assert.equal(name, "settings.plugin.item");
        [...factory()];
      },
      register(options, component) {
        const props = options.inject();
        assert.equal(props.scope, scope);
        assert.equal(props.api, api);
        assert.equal(props.remote, remote);
        assert.equal(typeof component, "function");
        registered = true;
      }
    }
  };
  // Cordis permits explicit get(), but property access requires injection.
  const ctx = new Proxy({ get: (key) => services[key] }, {
    get(target, key) {
      if (key in target) return target[key];
      if (!plugin.inject.includes(key)) {
        throw new Error(`cannot get property "${key}" without inject`);
      }
      return services[key];
    }
  });
  plugin.apply(ctx);
  assert.equal(registered, true);
}

const plugin = loadClient(source);
assert.ok(plugin.inject.includes("connection"));
assert.ok(plugin.inject.includes("remote"));
const missingRemote = { ...plugin, inject: plugin.inject.filter((key) => key !== "remote") };
assert.throws(() => applyClient(missingRemote), /cannot get property "remote" without inject/);
applyClient(plugin);
console.log("manager client injection and settings registration: PASS");
