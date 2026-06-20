export const MU_RUNTIME = {
  canonicalAgent: 'iros',
  canonicalUi: 'iroschat',
  appName: 'Mu',
  runtimeName: 'mu-on-iros-ui',
  legacyDisabled: true,

  disabledLegacyRoutes: [
    'mu_full',
    'mui',
    'muai',
    'SofiaChatShell',
  ],
} as const;

export function isCanonicalMuAgent(agent?: string | null) {
  return String(agent ?? '').trim() === MU_RUNTIME.canonicalAgent;
}

export function isLegacyMuSurface(name?: string | null) {
  const s = String(name ?? '').trim();
  return (MU_RUNTIME.disabledLegacyRoutes as readonly string[]).includes(s);
}
