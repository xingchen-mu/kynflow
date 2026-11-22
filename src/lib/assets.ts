// Vite fills BASE_URL in; node:test imports have no import.meta.env.
const env = (import.meta as { env?: { BASE_URL?: string } }).env;

/** Public brand icon, rebased so the static demo also works below a subpath. */
export const brandIconUrl = `${env?.BASE_URL ?? '/'}brand/kynflow-icon.png`;
