import { logClient, nomeErrore } from '@/lib/logging/client'
import { erroreDaRisposta } from '@/lib/ui/esito-fetch'
import { conCorrezioneNelCorpo, type InviaConCorrezione } from '@/lib/ui/correzione-fetch'
import type {
  DettaglioVotazione,
  DettaglioVotazioneRisposta,
  ElencoVotazioniRisposta,
  GenitoreScheda,
  GenitoriSedeRisposta,
  RiepilogoVotazione,
} from '@/lib/votazioni/tipi'

/**
 * VOTAZIONI · LE CHIAMATE DELLA SEGRETERIA.
 *
 * Un posto solo per ciò che la schermata CHIEDE al server, e per come lo racconta nel log del client. Ogni
 * rifiuto lascia una riga (stato HTTP compreso: «loggare uno status senza il corpo è il bug», ma qui il corpo
 * è già nel testo di catalogo che `erroreDaRisposta` restituisce) e ogni lettura fallita è un ESITO, mai un
 * elenco vuoto: «non c'è niente» e «non ho potuto leggere» sono due fatti diversi e la segreteria li vede
 * diversi.
 *
 * Le risposte sono corpi NUDI (`ElencoVotazioniRisposta`, `DettaglioVotazioneRisposta`…, vedi `tipi.ts`); solo
 * `GET /api/admin/sections/scoped`, che è una route più vecchia, li avvolge in `{ success, data }`.
 */

const ROUTE = '/admin/votazioni'

export type LetturaElenco =
  | { esito: 'ok'; disponibile: boolean; votazioni: RiepilogoVotazione[] }
  | { esito: 'errore' }

export async function leggiElenco(scuolaId: string): Promise<LetturaElenco> {
  try {
    const res = await fetch(`/api/admin/votazioni?${new URLSearchParams({ scuolaId }).toString()}`)
    if (!res.ok) {
      const e = await erroreDaRisposta(res, '')
      // Le tabelle non ci sono su questo ambiente: la GET lo dice con un 200 `disponibile: false`, ma un 503
      // dichiarato vale lo stesso avviso, non un «guasto».
      if (res.status === 503 && e.codice === 'VOTAZIONI_NON_DISPONIBILI') {
        return { esito: 'ok', disponibile: false, votazioni: [] }
      }
      logClient({ livello: 'error', evento: 'fetch', messaggio: 'votazioni-elenco-respinto', route: ROUTE, stato: res.status })
      return { esito: 'errore' }
    }
    const corpo = (await res.json()) as Partial<ElencoVotazioniRisposta>
    return {
      esito: 'ok',
      disponibile: corpo.disponibile !== false,
      votazioni: Array.isArray(corpo.votazioni) ? corpo.votazioni : [],
    }
  } catch (e) {
    logClient({ livello: 'error', evento: 'fetch', messaggio: `votazioni-elenco-fallito: ${nomeErrore(e)}`, route: ROUTE })
    return { esito: 'errore' }
  }
}

export type LetturaDettaglio =
  | { esito: 'ok'; votazione: DettaglioVotazione }
  | { esito: 'non-trovata' }
  | { esito: 'errore' }

export async function leggiDettaglio(votazioneId: string): Promise<LetturaDettaglio> {
  try {
    const res = await fetch(`/api/admin/votazioni/${encodeURIComponent(votazioneId)}`)
    if (res.status === 404) return { esito: 'non-trovata' }
    if (!res.ok) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: 'votazioni-dettaglio-respinto', route: ROUTE, stato: res.status })
      return { esito: 'errore' }
    }
    const corpo = (await res.json()) as Partial<DettaglioVotazioneRisposta>
    if (!corpo.votazione) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: 'votazioni-dettaglio-senza-corpo', route: ROUTE, stato: res.status })
      return { esito: 'errore' }
    }
    return { esito: 'ok', votazione: corpo.votazione }
  } catch (e) {
    logClient({ livello: 'error', evento: 'fetch', messaggio: `votazioni-dettaglio-fallito: ${nomeErrore(e)}`, route: ROUTE })
    return { esito: 'errore' }
  }
}

/** Una classe della sede, come la offre `GET /api/admin/sections/scoped`. */
export interface ClasseDellaSede {
  id: string
  nome: string
  /** `sections.school_type`: nido, infanzia, primaria. Qualunque altro valore finisce in «Altre classi». */
  grado: string
}

export type LetturaClassi = { esito: 'ok'; classi: ClasseDellaSede[] } | { esito: 'errore' }

interface GruppoSedeRisposta {
  scuolaId: string
  sezioni?: { id: string; name: string; school_type: string }[]
}

/**
 * Le classi della SEDE. La route risponde con un gruppo per ogni sede dell'utente: qui si tiene SOLO quello della
 * sede della votazione, perché una classe di un'altra sede non si offre mai (il server la rifiuterebbe con
 * `VOTAZIONE_CLASSE_FUORI_SEDE`, ma la segreteria non deve nemmeno vederla).
 */
export async function leggiClassi(scuolaId: string): Promise<LetturaClassi> {
  try {
    const res = await fetch('/api/admin/sections/scoped')
    if (!res.ok) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: 'votazioni-classi-respinte', route: ROUTE, stato: res.status })
      return { esito: 'errore' }
    }
    const corpo = (await res.json()) as { data?: GruppoSedeRisposta[] }
    const gruppo = (corpo.data ?? []).find((g) => g.scuolaId === scuolaId)
    const classi = (gruppo?.sezioni ?? []).map((s) => ({ id: s.id, nome: s.name, grado: s.school_type }))
    return { esito: 'ok', classi }
  } catch (e) {
    logClient({ livello: 'error', evento: 'fetch', messaggio: `votazioni-classi-fallite: ${nomeErrore(e)}`, route: ROUTE })
    return { esito: 'errore' }
  }
}

export type RicercaGenitori = { esito: 'ok'; genitori: GenitoreScheda[] } | { esito: 'errore' }

export async function cercaGenitori(scuolaId: string, q: string): Promise<RicercaGenitori> {
  try {
    const res = await fetch(`/api/admin/votazioni/genitori?${new URLSearchParams({ scuolaId, q }).toString()}`)
    if (!res.ok) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: 'votazioni-genitori-respinti', route: ROUTE, stato: res.status })
      return { esito: 'errore' }
    }
    const corpo = (await res.json()) as Partial<GenitoriSedeRisposta>
    return { esito: 'ok', genitori: Array.isArray(corpo.genitori) ? corpo.genitori : [] }
  } catch (e) {
    logClient({ livello: 'error', evento: 'fetch', messaggio: `votazioni-genitori-falliti: ${nomeErrore(e)}`, route: ROUTE })
    return { esito: 'errore' }
  }
}

export type EsitoScrittura =
  | { ok: true; res: Response }
  | { ok: false; testo: string; codice: string | null; stato: number | undefined }

/**
 * Una scrittura (POST, PATCH, DELETE) con il suo racconto: il testo di un rifiuto è sempre quello del CATALOGO
 * (per `codice`) o il ripiego di chi chiama, mai la prosa grezza del server; la rete caduta è un esito a sé, con
 * il ripiego e nessun codice. `evento` dà il nome alla riga di log (`<evento>-respinta` / `<evento>-fallita`).
 */
export async function scrivi(
  metodo: 'POST' | 'PATCH' | 'DELETE',
  url: string,
  corpo: unknown,
  ripiego: string,
  evento: string,
  /** PR 4.9: la pagina che sa registrare una correzione su un anno chiuso (`useCorrezioneAnno`). */
  inviaConCorrezione?: InviaConCorrezione,
): Promise<EsitoScrittura> {
  try {
    const init: RequestInit =
      corpo === undefined
        ? { method: metodo }
        : { method: metodo, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) }
    const res = inviaConCorrezione
      ? await inviaConCorrezione((correzione) => fetch(url, correzione ? conCorrezioneNelCorpo(init, correzione) : init))
      : await fetch(url, init)
    if (!res.ok) {
      const e = await erroreDaRisposta(res, ripiego)
      logClient({ livello: 'error', evento: 'fetch', messaggio: `${evento}-respinta`, route: ROUTE, stato: res.status })
      return { ok: false, testo: e.testo, codice: e.codice, stato: e.stato }
    }
    return { ok: true, res }
  } catch (e) {
    logClient({ livello: 'error', evento: 'fetch', messaggio: `${evento}-fallita: ${nomeErrore(e)}`, route: ROUTE })
    return { ok: false, testo: ripiego, codice: null, stato: undefined }
  }
}

/** L'id della votazione appena creata, dal corpo del 201; `null` se il corpo non lo porta (si va avanti lo stesso). */
export async function idCreato(res: Response): Promise<string | null> {
  try {
    const corpo = (await res.json()) as { id?: unknown }
    return typeof corpo.id === 'string' && corpo.id !== '' ? corpo.id : null
  } catch (e) {
    logClient({ livello: 'warn', evento: 'fetch', messaggio: `votazioni-crea-corpo-illeggibile: ${nomeErrore(e)}`, route: ROUTE, stato: res.status })
    return null
  }
}
