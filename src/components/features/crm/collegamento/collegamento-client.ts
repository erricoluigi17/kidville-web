import { erroreDaRisposta } from '@/lib/ui/esito-fetch'
import { logClient, nomeErrore } from '@/lib/logging/client'

/**
 * CRM della segreteria · le chiamate del collegamento con le domande di iscrizione.
 *
 * Fuori dai componenti per due ragioni: un effetto può chiamarle e fare `setState` solo nel `.then`
 * (la regola `set-state-in-effect` vieta di farlo nel corpo dell'effetto), e nessuna di loro LANCIA mai
 * — ogni guasto torna come `{ ok: false, testo }`, già loggato. Chi le chiama non ha un `catch` da
 * dimenticare.
 *
 * `testo` è il messaggio del CATALOGO se il server ha dichiarato un codice (`GIA_COLLEGATO`,
 * `CRM_NON_INSTALLATO`…), altrimenti stringa vuota: il componente ci mette la sua frase generica, già
 * tradotta. La prosa del server non si mostra mai (nasce italiana).
 *
 * 🔴 NIENTE DATI DI UNA FAMIGLIA NEI LOG. Qui passano nomi di bambini e di genitori: nei log finiscono
 * solo il nome dell'operazione e lo stato HTTP, mai un valore letto dalla risposta.
 */

const ROTTA = '/admin/crm'

/** Una riga dell'elenco delle domande: il minimo per scegliere (vedi `GET /api/admin/crm/domande`). */
export interface RigaDomanda {
  domandaId: string
  figlio: number
  nome: string | null
  cognome: string | null
  dataNascita: string | null
  genitore: string | null
  ricevutaIl: string | null
  stato: string | null
  giaCollegato: boolean
}

/** Un bambino della scheda, quanto basta per offrirlo all'associazione. */
export interface BambinoLibero {
  id: string
  nome: string | null
}

export type EsitoChiamata<T> = { ok: true; dati: T } | { ok: false; testo: string }

type Operazione = 'domande-lette' | 'bambini-letti' | 'domanda-collegata' | 'domanda-scollegata'

const testoOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)

async function chiama(
  operazione: Operazione,
  url: string,
  init: { metodo: 'GET' | 'PUT' | 'DELETE'; corpo?: unknown },
  leggiCorpo: boolean,
): Promise<EsitoChiamata<unknown>> {
  try {
    const res = await fetch(url, {
      method: init.metodo,
      ...(init.corpo !== undefined
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.corpo) }
        : {}),
    })
    if (!res.ok) {
      const e = await erroreDaRisposta(res, '')
      logClient({
        livello: 'error',
        evento: 'fetch',
        messaggio: `crm-collegamento-${operazione}-respinto`,
        route: ROTTA,
        stato: e.stato,
      })
      return { ok: false, testo: e.testo }
    }
    return { ok: true, dati: leggiCorpo ? await res.json() : null }
  } catch (e) {
    // Rete caduta, o 200 con un corpo che non è JSON: il nome dell'errore basta, il resto è dato altrui.
    logClient({
      livello: 'error',
      evento: 'fetch',
      messaggio: `crm-collegamento-${operazione}-fallito: ${nomeErrore(e)}`,
      route: ROTTA,
    })
    return { ok: false, testo: '' }
  }
}

function rigaValida(r: unknown): RigaDomanda | null {
  if (typeof r !== 'object' || r === null) return null
  const o = r as Record<string, unknown>
  if (typeof o.domandaId !== 'string' || typeof o.figlio !== 'number' || !Number.isInteger(o.figlio)) return null
  return {
    domandaId: o.domandaId,
    figlio: o.figlio,
    nome: testoOrNull(o.nome),
    cognome: testoOrNull(o.cognome),
    dataNascita: testoOrNull(o.dataNascita),
    genitore: testoOrNull(o.genitore),
    ricevutaIl: testoOrNull(o.ricevutaIl),
    stato: testoOrNull(o.stato),
    giaCollegato: o.giaCollegato === true,
  }
}

/** `GET /api/admin/crm/domande` — `q` per cercare, `domandaId` per puntare una domanda sola. */
export async function leggiDomande(
  scuolaId: string,
  q: string,
  domandaId?: string,
): Promise<EsitoChiamata<RigaDomanda[]>> {
  const parametri = new URLSearchParams({ scuolaId })
  if (q !== '') parametri.set('q', q)
  if (domandaId) parametri.set('domandaId', domandaId)
  const esito = await chiama('domande-lette', `/api/admin/crm/domande?${parametri}`, { metodo: 'GET' }, true)
  if (!esito.ok) return esito
  const data = (esito.dati as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) {
    logClient({ livello: 'error', evento: 'fetch', messaggio: 'crm-collegamento-domande-forma-inattesa', route: ROTTA })
    return { ok: false, testo: '' }
  }
  return { ok: true, dati: data.map(rigaValida).filter((r): r is RigaDomanda => r !== null) }
}

/**
 * I bambini di una scheda che NON hanno ancora una domanda. Legge `GET /api/admin/crm/schede/[id]`
 * (contratto della Sessione 2: `{ scheda, bambini, … }`); accetta anche il corpo avvolto in `data`.
 */
export async function leggiBambiniLiberi(schedaId: string): Promise<EsitoChiamata<BambinoLibero[]>> {
  const esito = await chiama('bambini-letti', `/api/admin/crm/schede/${encodeURIComponent(schedaId)}`, { metodo: 'GET' }, true)
  if (!esito.ok) return esito
  const corpo = esito.dati as { bambini?: unknown; data?: { bambini?: unknown } } | null
  const bambini = corpo?.bambini ?? corpo?.data?.bambini
  if (!Array.isArray(bambini)) {
    logClient({ livello: 'error', evento: 'fetch', messaggio: 'crm-collegamento-bambini-forma-inattesa', route: ROTTA })
    return { ok: false, testo: '' }
  }
  const liberi: BambinoLibero[] = []
  for (const b of bambini as Record<string, unknown>[]) {
    if (typeof b?.id !== 'string') continue
    // «Libero» = senza domanda. Un valore assente o strano NON conta come libero: in dubbio non si offre.
    if (b.domanda_id !== null) continue
    liberi.push({ id: b.id, nome: testoOrNull(b.nome) })
  }
  return { ok: true, dati: liberi }
}

const rottaCollegamento = (schedaId: string, bambinoId: string) =>
  `/api/admin/crm/schede/${encodeURIComponent(schedaId)}/bambini/${encodeURIComponent(bambinoId)}/collegamento`

/** `PUT …/collegamento` — la sede la decide il server dalla scheda: il corpo porta solo domanda e figlio. */
export async function collegaDomanda(
  schedaId: string,
  bambinoId: string,
  domandaId: string,
  figlio: number,
): Promise<EsitoChiamata<null>> {
  const esito = await chiama(
    'domanda-collegata',
    rottaCollegamento(schedaId, bambinoId),
    { metodo: 'PUT', corpo: { domandaId, figlio } },
    false,
  )
  return esito.ok ? { ok: true, dati: null } : esito
}

/** `DELETE …/collegamento` — l'esito del bambino resta com'è, cambia solo il legame. */
export async function scollegaDomanda(schedaId: string, bambinoId: string): Promise<EsitoChiamata<null>> {
  const esito = await chiama('domanda-scollegata', rottaCollegamento(schedaId, bambinoId), { metodo: 'DELETE' }, false)
  return esito.ok ? { ok: true, dati: null } : esito
}
