/**
 * SIDI / Piattaforma Unica — client per la cooperazione applicativa ministeriale
 * (P5.3, DL-049). Specchio del boundary Aruba (`src/lib/aruba/client.ts`):
 * credenziali risolte lato server (password via `password_ref` → env, mai in
 * chiaro), ambiente DEMO/PROD, **trasmissione gated**.
 *
 * ⚠️ La trasmissione reale richiede l'**accreditamento ministeriale** del software
 * (credenziali/canali di cooperazione applicativa), oggi non disponibile. Finché
 * non accreditati, `sidiTransmit` ritorna 503 esplicito (mai un successo finto),
 * esattamente come la verifica live Aruba/SDI (DL-004/DL-017). Gli endpoint e i
 * tracciati sono placeholder sostituibili.
 */

export type SidiFlusso = 'fase_a' | 'frequentanti' | 'piattaforma_unica'

export interface SidiConfig {
  codice_meccanografico?: string
  username?: string
  password_ref?: string
  abilitato?: boolean
  ambiente?: string
}

export interface SidiCredentials {
  username: string
  password: string
  codiceMeccanografico: string
}

export type SidiTransmitResult =
  | { ok: true; ricevuta: string }
  | { ok: false; motivo: 'non_configurato' | 'non_accreditato' | 'errore'; messaggio: string; httpStatus: number }

/** Base URL per ambiente (placeholder sostituibili al tracciato reale). */
export function sidiBaseUrls(ambiente?: string): { ws: string } {
  if (ambiente === 'production' || ambiente === 'produzione') {
    return { ws: 'https://sidi.pubblica.istruzione.it/ws' }
  }
  return { ws: 'https://demo-sidi.pubblica.istruzione.it/ws' }
}

/**
 * Risolve le credenziali lato server: username dal config (o env), password dal
 * nome env in `password_ref` (o `SIDI_PASSWORD`), codice meccanografico dal
 * config (o env). Null se incompleto.
 */
export function resolveSidiCredentials(config: SidiConfig): SidiCredentials | null {
  const username = config.username || process.env.SIDI_USERNAME
  const password =
    (config.password_ref ? process.env[config.password_ref] : undefined) || process.env.SIDI_PASSWORD
  const codiceMeccanografico = config.codice_meccanografico || process.env.SIDI_CODICE_MECCANOGRAFICO
  if (!username || !password || !codiceMeccanografico) return null
  return { username, password, codiceMeccanografico }
}

/**
 * Trasmette un flusso al SIDI. **Gated**: 503 `non_configurato` se non abilitato
 * o credenziali assenti; 503 `non_accreditato` se configurato ma l'accreditamento
 * ministeriale non è ancora attivo (stato corrente del progetto). Quando
 * accreditati, qui andrà la `fetch` verso `sidiBaseUrls(...).ws` per flusso.
 */
export async function sidiTransmit(
  config: SidiConfig,
  flusso: SidiFlusso,
  payload: string
): Promise<SidiTransmitResult> {
  const creds = resolveSidiCredentials(config)
  if (!config.abilitato || !creds) {
    console.warn(
      `[SIDI] trasmissione ${flusso} gated: non_configurato (abilitato=${Boolean(config.abilitato)})`
    )
    return {
      ok: false,
      motivo: 'non_configurato',
      messaggio: 'Interoperabilità SIDI non configurata o credenziali mancanti',
      httpStatus: 503,
    }
  }
  // Accreditamento ministeriale non ancora ottenuto → egress gated.
  console.warn(`[SIDI] trasmissione ${flusso} gated: non_accreditato (payload ${payload.length} byte)`)
  return {
    ok: false,
    motivo: 'non_accreditato',
    messaggio: 'Trasmissione SIDI non disponibile: accreditamento ministeriale in corso',
    httpStatus: 503,
  }
}
