async function resolveCredential(ctx, ref) {
  const value = await ctx.credentials.resolve(ref);
  if (value === undefined) throw new Error(`sagitta-manager credential is not configured: ${ref}`);
  return value;
}

export async function resolveCredentials(ctx, config) {
  const [accessId, accessSecret, uploadToken] = await Promise.all([
    resolveCredential(ctx, config.accessIdRef),
    resolveCredential(ctx, config.accessSecretRef),
    resolveCredential(ctx, config.uploadTokenRef)
  ]);
  return { accessId, accessSecret, uploadToken };
}
