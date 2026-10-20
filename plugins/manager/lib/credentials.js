async function resolveCredential(ctx, ref) {
  const resolved = await ctx.credentials.resolve(ref);
  if (resolved === undefined) throw new Error(`sagitta-manager credential is not configured: ${ref}`);
  if (typeof resolved.value !== "string" || resolved.value === "") throw new Error(`sagitta-manager credential is empty: ${ref}`);
  return resolved.value;
}

export async function resolveCredentials(ctx, config) {
  const [accessId, accessSecret, uploadToken] = await Promise.all([
    resolveCredential(ctx, config.accessIdRef),
    resolveCredential(ctx, config.accessSecretRef),
    resolveCredential(ctx, config.uploadTokenRef)
  ]);
  return { accessId, accessSecret, uploadToken };
}
