import { formattaIstante } from '@/i18n/config'
import { logClient } from '@/lib/logging/client'
import { erroreDaRisposta } from '@/lib/ui/esito-fetch'
import type { AzioneRow, EsitoAzione, MotivoPerdita, TipoAzione } from '@/lib/crm/tipi'

/**
 * CRM della segreteria · il lato BROWSER dei richiami: le chiamate alle route
 * `/api/admin/crm/azioni` e `/api/admin/crm/persone`, con il loro esito reso un VALORE.
 *
 * Nessuna funzione qui lancia e nessuna tocca lo stato di React: ognuna restituisce `pronta`/`ok` o
 * un errore già con il suo testo. È la forma che `react-hooks/set-state-in-effect` accetta (la
 * lettura sta fuori dal componente, il `setState` nel `.then`) e quella che permette di provare la
 * logica di rete senza montare niente.
 *
 * ⚠️ NIENTE DATI DI UNA FAMIGLIA NEI LOG. Il nome, il telefono, il motivo e la nota scritti dalla
 * segreteria passano di qui in entrata e in uscita: nei log finiscono solo la rotta, lo status e
 * l'operazione.
 */

export const ROTTA_AZIONI = '/api/admin/crm/azioni'
export const ROTTA_PERSONE = '/api/admin/crm/persone'

/** Una persona a cui si può affidare un richiamo (la risposta di `persone`). */
export type PersonaRichiamo = { id: string; nome: string; cognome: string; ruolo: string }

/** Quanto serve a chiamare una famiglia, e niente di più (lo stesso che la route restituisce). */
export type SchedaMinima = { id: string; genitore_nome: string | null; telefono1: string | null }

/** Un richiamo aperto, come lo restituisce `GET …/azioni`. */
export type AzioneElenco = AzioneRow & { in_ritardo: boolean; scheda: SchedaMinima }

/** La «prossima azione» nata da un esito, come la restituisce `PATCH …/azioni/[id]`. */
export type ProssimaAzione = {
  id: string
  tipo: TipoAzione
  giorno: string
  scadenza: string
  responsabile: string
}

/** Gli avvisi che la route allega a un 200 quando una scrittura accessoria non è riuscita. */
export const AVVISI_ESITO = ['PROSSIMA_NON_PIANIFICATA', 'BAMBINI_NON_AGGIORNATI'] as const
export type AvvisoEsito = (typeof AVVISI_ESITO)[number]

/** Ciò che la route dice dopo un esito. */
export type RisultatoEsito = {
  esito: EsitoAzione
  prossima: ProssimaAzione | null
  bambiniAggiornati: number
  avvisi: AvvisoEsito[]
}

/** Che cosa si sa di una lettura. `testo` è la frase del catalogo del server, se ne ha una. */
export type Lettura<T> = { tipo: 'pronta'; dati: T } | { tipo: 'errore'; testo: string | null }

/** Che cosa si sa di una scrittura. */
export type Scrittura<T> =
  | { tipo: 'ok'; dati: T }
  | { tipo: 'errore'; testo: string | null; codice: string | null; stato: number | undefined }

/** Il corpo di un esito: il motivo c'è solo per `non_interessato`. */
export type CorpoEsito = { esito: EsitoAzione; motivoPerdita?: MotivoPerdita; motivoNota?: string }

const senzaRete = () => typeof navigator !== 'undefined' && navigator.onLine === false

/**
 * Perché una chiamata non è arrivata. Senza rete il telefono lo sa già: nessun log. Con la rete
 * «accesa» è un `warn` e non un `error`: il logger globale per la stessa fetch ne scrive già uno.
 */
function segnalaRete(operazione: string): void {
  if (senzaRete()) return
  logClient({ livello: 'warn', evento: 'fetch', messaggio: `richiami CRM non raggiunti: ${operazione}`, route: ROTTA_AZIONI })
}

/** Gli errori di merito (4xx) il server li ha già registrati; gli altri (5xx, status illeggibile) si segnalano. */
function segnalaStato(operazione: string, stato: number | undefined): void {
  if (stato !== undefined && stato >= 400 && stato < 500) return
  logClient({
    livello: 'warn',
    evento: 'fetch',
    messaggio: `richiami CRM: risposta inattesa: ${operazione}`,
    route: ROTTA_AZIONI,
    stato,
  })
}

async function leggi<T>(url: string, operazione: string, estrai: (corpo: unknown) => T | null): Promise<Lettura<T>> {
  const res = await fetch(url, { cache: 'no-store' }).catch(() => null)
  if (!res) {
    segnalaRete(operazione)
    return { tipo: 'errore', testo: null }
  }
  if (!res.ok) {
    const e = await erroreDaRisposta(res, '')
    segnalaStato(operazione, e.stato)
    return { tipo: 'errore', testo: e.testo || null }
  }
  const dati = estrai(await res.json().catch(() => null))
  if (dati === null) {
    logClient({
      livello: 'warn',
      evento: 'fetch',
      messaggio: `richiami CRM: risposta non leggibile: ${operazione}`,
      route: ROTTA_AZIONI,
      stato: res.status,
    })
    return { tipo: 'errore', testo: null }
  }
  return { tipo: 'pronta', dati }
}

/** I richiami aperti: di una sede (fino a oggi) o di una scheda (tutti). */
export function leggiAzioni(p: {
  scuolaId: string
  responsabile?: string | null
  schedaId?: string
}): Promise<Lettura<AzioneElenco[]>> {
  const q = new URLSearchParams({ scuolaId: p.scuolaId })
  if (p.responsabile) q.set('responsabile', p.responsabile)
  if (p.schedaId) q.set('schedaId', p.schedaId)
  return leggi(`${ROTTA_AZIONI}?${q.toString()}`, 'elenco', (corpo) => {
    const dati = (corpo as { data?: unknown } | null)?.data
    return Array.isArray(dati) ? (dati as AzioneElenco[]) : null
  })
}

/** Le persone a cui si può affidare un richiamo, in questa sede. */
export function leggiPersone(scuolaId: string): Promise<Lettura<PersonaRichiamo[]>> {
  const q = new URLSearchParams({ scuolaId })
  return leggi(`${ROTTA_PERSONE}?${q.toString()}`, 'persone', (corpo) => {
    const dati = (corpo as { data?: unknown } | null)?.data
    return Array.isArray(dati) ? (dati as PersonaRichiamo[]) : null
  })
}

async function scrivi<T>(
  url: string,
  metodo: 'POST' | 'PATCH',
  corpo: unknown,
  operazione: string,
  estrai: (dati: unknown) => T,
): Promise<Scrittura<T>> {
  const res = await fetch(url, {
    method: metodo,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  }).catch(() => null)
  if (!res) {
    segnalaRete(operazione)
    return { tipo: 'errore', testo: null, codice: null, stato: undefined }
  }
  if (!res.ok) {
    const e = await erroreDaRisposta(res, '')
    segnalaStato(operazione, e.stato)
    return { tipo: 'errore', testo: e.testo || null, codice: e.codice, stato: e.stato }
  }
  const json = (await res.json().catch(() => null)) as { data?: unknown } | null
  return { tipo: 'ok', dati: estrai(json?.data ?? null) }
}

const soloAvvisiNoti = (avvisi: unknown): AvvisoEsito[] =>
  Array.isArray(avvisi) ? avvisi.filter((a): a is AvvisoEsito => (AVVISI_ESITO as readonly unknown[]).includes(a)) : []

/** Segna un richiamo come fatto. Un secondo clic (o un collega) risponde 409 `GIA_FATTA`. */
export function segnaFatta(azioneId: string, corpo: CorpoEsito): Promise<Scrittura<RisultatoEsito>> {
  return scrivi(`${ROTTA_AZIONI}/${azioneId}`, 'PATCH', { azione: 'fatta', ...corpo }, 'fatta', (dati) => {
    const d = (dati ?? {}) as {
      esito?: EsitoAzione
      prossima?: ProssimaAzione | null
      bambini_aggiornati?: number
      avvisi?: unknown
    }
    return {
      esito: d.esito ?? corpo.esito,
      prossima: d.prossima ?? null,
      bambiniAggiornati: typeof d.bambini_aggiornati === 'number' ? d.bambini_aggiornati : 0,
      avvisi: soloAvvisiNoti(d.avvisi),
    }
  })
}

/** Sposta un richiamo a un altro giorno (e, se serve, un'altra ora o un'altra persona). */
export function spostaAzione(
  azioneId: string,
  corpo: { giorno: string; ora?: string; responsabile?: string },
): Promise<Scrittura<{ scadenza: string }>> {
  return scrivi(`${ROTTA_AZIONI}/${azioneId}`, 'PATCH', { azione: 'sposta', ...corpo }, 'sposta', (dati) => ({
    scadenza: String((dati as { scadenza?: unknown } | null)?.scadenza ?? ''),
  }))
}

/** Cancella un richiamo (resta nello storico). */
export function cancellaAzione(azioneId: string): Promise<Scrittura<null>> {
  return scrivi(`${ROTTA_AZIONI}/${azioneId}`, 'PATCH', { azione: 'cancella' }, 'cancella', () => null)
}

/** Aggiunge a mano un «da richiamare» alle 10:30 del giorno scelto. */
export function creaRichiamo(corpo: {
  schedaId: string
  giorno: string
  responsabile: string
}): Promise<Scrittura<{ id: string }>> {
  return scrivi(ROTTA_AZIONI, 'POST', corpo, 'crea', (dati) => ({
    id: String((dati as { id?: unknown } | null)?.id ?? ''),
  }))
}

/** `Nome Cognome`, senza spazi in più se uno dei due manca. */
export function nomePersona(p: Pick<PersonaRichiamo, 'nome' | 'cognome'>): string {
  return [p.nome, p.cognome].filter(Boolean).join(' ')
}

/**
 * «martedì 3 novembre, 10:30» — il momento di un richiamo, nel fuso di Roma e nella lingua dell'interfaccia.
 * Mai `toLocale…String` sul `Date`: userebbe il fuso del dispositivo, non quello di chi chiama.
 */
export function formattaQuando(iso: string, locale: string): string {
  return formattaIstante(iso, locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  })
}
