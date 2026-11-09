'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { logClient, nomeErrore } from '@/lib/logging/client'

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  GLI ANNI CHE IL MODULO PUBBLICO OFFRE (PR 4.5, compito 4.5.7)           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Una volta nota la sede, il wizard chiede a `GET /api/iscrizione/anni` quali anni accettano domande. Se sono
 * almeno due la famiglia sceglie (passo «anno»); se è uno solo non c'è niente da chiedere e la domanda lo porta
 * lo stesso; se nessuno, le iscrizioni sono chiuse.
 *
 * ── LA REGOLA CHE NON SI DEROGA: UN GUASTO DI QUESTA LETTURA NON FERMA MAI UN INVIO ──
 * L'elenco degli anni è un'aggiunta. Rete giù, 429, 500, corpo strano, database non migrato (l'E2E della CI):
 * in tutti questi casi il modulo si comporta come prima di questa modifica — nessun passo in più, nessun
 * `anno_id` nel POST, e sarà il server a decidere l'anno. Si LOGGA (un `catch` che non logga è un bug), ma non
 * si mostra niente alla famiglia. L'unica notizia che si dà in pagina è «chiuse», e solo quando il server ha
 * detto esplicitamente `chiuso: true`.
 *
 * ── PERCHÉ NON SI TOCCA LA FORMA DEI PASSI MENTRE L'ELENCO È IN VOLO ──
 * Vale quanto scritto in `EnrollmentWizard` per le sedi: far cambiare forma a `steps` sotto le mani del
 * genitore è il difetto che congelava il modulo. `inCaricamento` serve a chi decide la forma; `attendi()` a chi
 * sta per cambiare passo e deve sapere se il passo «anno» esiste.
 */

export const ROTTA_ANNI = '/api/iscrizione/anni'

export interface AnnoPubblicoVoce {
  anno_id: string
  etichetta_breve: string
  ingresso: 'durante' | 'inizio'
}

interface EsitoAnni {
  /** La sede a cui si riferisce questo esito: un esito vecchio di un'altra sede non vale. */
  sede: string
  anni: AnnoPubblicoVoce[]
  scelta: boolean
  chiuso: boolean
}

/**
 * Estrae l'elenco dalla risposta di `/api/iscrizione/anni`, scartando le voci di forma inattesa.
 * `null` = il corpo non contiene l'elenco (non è un guasto da mostrare: si degrada a «nessuna scelta»).
 */
export function anniValidi(payload: unknown): { anni: AnnoPubblicoVoce[]; scelta: boolean; chiuso: boolean } | null {
  const data = (payload as { data?: { anni?: unknown; scelta?: unknown; chiuso?: unknown } } | null)?.data
  if (!data || !Array.isArray(data.anni)) return null
  const anni = data.anni
    .filter(
      (a): a is AnnoPubblicoVoce =>
        a !== null && typeof a === 'object' &&
        typeof (a as AnnoPubblicoVoce).anno_id === 'string' && (a as AnnoPubblicoVoce).anno_id.length > 0 &&
        typeof (a as AnnoPubblicoVoce).etichetta_breve === 'string' && (a as AnnoPubblicoVoce).etichetta_breve.length > 0 &&
        ((a as AnnoPubblicoVoce).ingresso === 'durante' || (a as AnnoPubblicoVoce).ingresso === 'inizio'),
    )
    .map((a) => ({ anno_id: a.anno_id, etichetta_breve: a.etichetta_breve, ingresso: a.ingresso }))
  // `scelta` si ricalcola dalle voci buone: il server lo dice, ma una sola voce non è mai una scelta.
  return { anni, scelta: data.scelta === true && anni.length > 1, chiuso: data.chiuso === true }
}

export interface AnniPubblici {
  anni: AnnoPubblicoVoce[]
  /** Almeno due anni: il passo «anno» esiste. */
  scelta: boolean
  /** Il server ha detto che nessun anno accetta domande. */
  chiuso: boolean
  /** L'elenco di questa sede non è ancora arrivato (mai vero se la sede non è nota). */
  inCaricamento: boolean
  /**
   * Si risolve quando l'elenco in volo è arrivato (o è fallito): mai rifiuta. Porta ciò che serve a chi sta
   * per cambiare passo, che col suo `anni` di render sarebbe in ritardo di un giro.
   */
  attendi: () => Promise<{ scelta: boolean; chiuso: boolean }>
  /** Richiede l'elenco da capo (dopo un rifiuto `ANNO_NON_OFFERTO`). L'elenco vecchio resta finché non arriva il nuovo. */
  ricarica: () => void
}

export function useAnniPubblici({ sedeId }: { sedeId: string | null }): AnniPubblici {
  const [esito, setEsito] = useState<EsitoAnni | null>(null)
  const [tentativo, setTentativo] = useState(0)
  const inVolo = useRef<Promise<{ scelta: boolean; chiuso: boolean }>>(
    Promise.resolve({ scelta: false, chiuso: false }),
  )

  useEffect(() => {
    if (!sedeId) return
    let annullato = false
    const nessuna = { anni: [] as AnnoPubblicoVoce[], scelta: false, chiuso: false }
    const concludi = (lista: { anni: AnnoPubblicoVoce[]; scelta: boolean; chiuso: boolean }) => {
      if (!annullato) setEsito({ sede: sedeId, ...lista })
      return { scelta: lista.scelta, chiuso: lista.chiuso }
    }
    inVolo.current = fetch(`${ROTTA_ANNI}?scuola_id=${encodeURIComponent(sedeId)}`)
      .then(async (r) => {
        if (!r.ok) {
          // `!r.ok` non è un'eccezione: il `catch` qui sotto non scatterebbe.
          logClient({ livello: 'warn', evento: 'fetch', messaggio: 'iscrizione-anni-non-caricati', stato: r.status })
          return concludi(nessuna)
        }
        const lista = anniValidi(await r.json())
        if (lista === null) {
          logClient({ livello: 'warn', evento: 'fetch', messaggio: 'iscrizione-anni-corpo-inatteso', stato: r.status })
          return concludi(nessuna)
        }
        return concludi(lista)
      })
      .catch((err) => {
        logClient({
          livello: 'warn',
          evento: 'fetch',
          messaggio: `iscrizione-anni-non-caricati: ${nomeErrore(err)}`,
          stack: err instanceof Error ? err.stack : undefined,
        })
        return concludi(nessuna)
      })
    return () => {
      annullato = true
    }
  }, [sedeId, tentativo])

  const attendi = useCallback(() => inVolo.current, [])
  const ricarica = useCallback(() => setTentativo((n) => n + 1), [])

  const valido = esito !== null && esito.sede === sedeId
  return {
    anni: valido ? esito.anni : [],
    scelta: valido ? esito.scelta : false,
    chiuso: valido ? esito.chiuso : false,
    inCaricamento: sedeId !== null && !valido,
    attendi,
    ricarica,
  }
}
