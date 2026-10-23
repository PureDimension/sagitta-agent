import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

function nonEmptyString(value) {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result === "" ? undefined : result;
}

export async function resolveDeployBindings(referencePath, env = process.env) {
  const reference = JSON.parse(await readFile(referencePath, "utf8"));
  if (!Array.isArray(reference.bindings)) {
    throw new Error(`worker deployment reference has no bindings array: ${referencePath}`);
  }

  return reference.bindings.map((binding, index) => {
    if (binding === null || typeof binding !== "object") {
      throw new Error(`worker deployment binding ${index} is invalid`);
    }
    const name = nonEmptyString(binding.name);
    if (name === undefined) throw new Error(`worker deployment binding ${index} has no name`);

    if (binding.type === "secret_text") {
      if (binding.fromEnv !== undefined && typeof binding.fromEnv !== "string") {
        throw new Error(`secret binding ${name} has an invalid fromEnv`);
      }
      let value = binding.fromEnv === undefined ? undefined : nonEmptyString(env[binding.fromEnv]);
      if (value === undefined && binding.generate === true) value = randomBytes(32).toString("hex");
      if (value === undefined) throw new Error(`secret binding ${name} has no value`);
      return { name, type: "secret_text", text: value };
    }

    if (binding.type === "d1") {
      const id = nonEmptyString(binding.id);
      if (id === undefined) throw new Error(`d1 binding ${name} has no id`);
      return { name, type: "d1", id };
    }

    throw new Error(`unknown worker deployment binding type: ${String(binding.type)}`);
  });
}
