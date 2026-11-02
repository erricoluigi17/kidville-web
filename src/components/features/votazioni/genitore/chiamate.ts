import { erroreDaRisposta } from '@/lib/ui/esito-fetch'
import { logClient, nomeErrore } from '@/lib/logging/client'
import type { SchedaGenitore, SchedeGenitoreRisposta, VotoRisposta } from '@/lib/votazioni/tipi'

/**
 * LE DUE CHIAMATE DEL GENITORE ALLE VOTAZIONI — fuori dai componenti, perché le fanno in due
 * (la pagina e la card in home) e perché una funzione pura che restituisce un ESITO si prova senza
 * montare niente.
 *
 * ── L'IDENTITÀ ──────────────────────────────────────────────────────────────────
 * Come ogni altra schermata genitore: l'header `x-user-id` con l'id di sessione. Il server, però, non
 * si fida del client: l'elettore è sempre `auth.user.id`, e il body del voto non ha un campo per chi
 * vota (`votoSchema` scarta quelli che non conosce).
 *
 * ── GLI ERRORI ──────────────────────────────────────────────────────────────────
 * Le schermate delle famiglie traducono il `codice`, mai la prosa del server (lock
 * `errori-server-schermate-famiglia`): `erroreDaRisposta` restituisce la frase di catalogo se il
 * codice è dichiarato, altrimenti il `fallback` del componente, già tradotto.
 *
 * ── I LOG ───────────────────────────────────────────────────────────────────────
 * Solo codici e numeri: nessun nome, nessun id di persona, nessuna chiave che contenga «voto» (la
 * redazione la oscurerebbe). I successi li registra il server.
 */

export const ROTTA_VOTAZIONI = '/parent/votazioni'

/** Il codice con cui il server dice «la votazione non è più aperta». */
export const CODICE_VOTAZIONE_CHIUSA = 'VOTAZIONE_CHIUSA'

export type EsitoLettura =
  | { tipo: 'ok'; schede: SchedaGenitore[] }
  | { tipo: 'errore'; messaggio: string }

/**
 * `GET /api/parent/votazioni`. Non lancia mai.
 *
 * `disponibile: false` (schema assente, DB non migrato) diventa «nessuna scheda»: per chi guarda è la
 * stessa cosa, e la card in home non deve poter mostrare una scheda che il server ha dichiarato assente.
 * Un corpo che non ha la forma del contratto è un ERRORE, non un elenco vuoto: «nessuna votazione» detto
 * a una famiglia per un corpo illeggibile sarebbe una bugia.
 */
export async function leggiSchede(parentId: string, fallback: string): Promise<EsitoLettura> {
  try {
    const res = await fetch('/api/parent/votazioni', { headers: { 'x-user-id': parentId } })
    if (!res.ok) {
      const e = await erroreDaRisposta(res, fallback)
      logClient({
        livello: 'warn',
        evento: 'fetch',
        messaggio: 'votazioni-elenco-rifiutato',
        route: ROTTA_VOTAZIONI,
        stato: e.stato,
        campi: { error_code: e.codice ?? 'senza_codice' },
      })
      return { tipo: 'errore', messaggio: e.testo }
    }
    const corpo = (await res.json()) as Partial<SchedeGenitoreRisposta> | null
    if (!corpo || typeof corpo.disponibile !== 'boolean' || !Array.isArray(corpo.schede)) {
      logClient({
        livello: 'warn',
        evento: 'fetch',
        messaggio: 'votazioni-elenco-forma-inattesa',
        route: ROTTA_VOTAZIONI,
        stato: res.status,
      })
      return { tipo: 'errore', messaggio: fallback }
    }
    return { tipo: 'ok', schede: corpo.disponibile ? corpo.schede : [] }
  } catch (err) {
    logClient({
      livello: 'warn',
      evento: 'fetch',
      messaggio: `votazioni-elenco-non-letto: ${nomeErrore(err)}`,
      route: ROTTA_VOTAZIONI,
    })
    return { tipo: 'errore', messaggio: fallback }
  }
}

export type EsitoInvio =
  /** Il server ha scritto il voto; `sceltaAttuale` è quella che dichiara lui. */
  | { tipo: 'registrato'; sceltaAttuale: string }
  /** 409 `VOTAZIONE_CHIUSA`: scaduta o chiusa a mano mentre la pagina era aperta. */
  | { tipo: 'chiusa'; messaggio: string }
  /** Ogni altro rifiuto, o la rete caduta: la scelta di prima resta quella di prima. */
  | { tipo: 'rifiutato'; messaggio: string }

/**
 * `POST /api/parent/votazioni/{votazioneId}/voto` con `{ ambito, sectionId, candidatoId }`. Non lancia mai.
 * `sectionId` è `null` per la scheda d'istituto (lo schema lo accetta: in uscita è sempre `null`).
 */
export async function inviaVoto(
  parentId: string,
  scheda: Pick<SchedaGenitore, 'votazioneId' | 'ambito' | 'sectionId'>,
  candidatoId: string,
  fallback: string,
): Promise<EsitoInvio> {
  try {
    const res = await fetch(`/api/parent/votazioni/${scheda.votazioneId}/voto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': parentId },
      body: JSON.stringify({ ambito: scheda.ambito, sectionId: scheda.sectionId, candidatoId }),
    })
    if (!res.ok) {
      const e = await erroreDaRisposta(res, fallback)
      logClient({
        livello: 'warn',
        evento: 'fetch',
        messaggio: 'votazioni-scheda-rifiutata',
        route: ROTTA_VOTAZIONI,
        stato: e.stato,
        campi: { error_code: e.codice ?? 'senza_codice', tipo: scheda.ambito },
      })
      return e.codice === CODICE_VOTAZIONE_CHIUSA
        ? { tipo: 'chiusa', messaggio: e.testo }
        : { tipo: 'rifiutato', messaggio: e.testo }
    }
    // 200: la scheda è scritta. Un corpo illeggibile non la annulla: si tiene ciò che si è inviato.
    let sceltaAttuale = candidatoId
    try {
      const corpo = (await res.json()) as Partial<VotoRisposta> | null
      if (typeof corpo?.sceltaAttuale === 'string') sceltaAttuale = corpo.sceltaAttuale
    } catch (err) {
      logClient({
        livello: 'warn',
        evento: 'fetch',
        messaggio: `votazioni-esito-illeggibile: ${nomeErrore(err)}`,
        route: ROTTA_VOTAZIONI,
        stato: res.status,
      })
    }
    return { tipo: 'registrato', sceltaAttuale }
  } catch (err) {
    logClient({
      livello: 'warn',
      evento: 'fetch',
      messaggio: `votazioni-scheda-non-inviata: ${nomeErrore(err)}`,
      route: ROTTA_VOTAZIONI,
    })
    return { tipo: 'rifiutato', messaggio: fallback }
  }
}
