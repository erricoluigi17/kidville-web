// Pubblicazione modelli (DL-030). Helper puri per link pubblico e controllo accessi.

export interface PublishableModel {
  published_at?: string | null
  access_mode?: 'public' | 'authenticated' | string | null
  public_token?: string | null
}

/** Path pubblico condivisibile di un modello pubblicato. */
export function publicFormUrl(token: string): string {
  return `/m/${token}`
}

/** True se il modello è pubblicato (link attivo). */
export function modelloPubblicato(model: PublishableModel): boolean {
  return !!model.published_at
}

/**
 * True se l'accesso è consentito per la modalità configurata:
 *  - `public` (o assente): sempre;
 *  - `authenticated`: solo con una sessione/identità valida.
 */
export function accessoConsentito(model: PublishableModel, hasSession: boolean): boolean {
  return model.access_mode === 'authenticated' ? hasSession : true
}
