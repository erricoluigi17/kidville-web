// P4/DL-045 — Onboarding genitore: consensi GDPR obbligatori al primo accesso.

/** Consensi che il genitore DEVE accettare per completare l'onboarding. */
export const CONSENSI_RICHIESTI = ['privacy'] as const

/** Ritorna i consensi richiesti NON accettati (true = accettato). */
export function consensiMancanti(
  accepted: Record<string, boolean> | null | undefined,
  required: readonly string[],
): string[] {
  const a = accepted ?? {}
  return required.filter((k) => a[k] !== true)
}
