'use client'

import { useEffect, useState } from 'react'
import { logClient, nomeErrore } from '@/lib/logging/client'

export const ROTTA_INFO_ANNO = '/api/iscrizione/info-anno'

export interface QuotaPubblica {
  /** `null` = per tutte le fasce. */
  fascia: string | null
  importo: number
}
export interface DocumentoPubblico {
  codice: string
  titolo: string
}
export interface InfoAnno {
  quote: QuotaPubblica[]
  moduli: DocumentoPubblico[]
}

/** Solo la forma: una risposta che non la rispetta vale «nessuna informazione», mai un importo inventato. */
export function infoAnnoValida(payload: unknown): InfoAnno | null {
  const data = (payload as { data?: { quote?: unknown; moduli?: unknown } } | null)?.data
  if (!data || !Array.isArray(data.quote) || !Array.isArray(data.moduli)) return null
  const quote = data.quote
    .filter(
      (q): q is QuotaPubblica =>
        q !== null && typeof q === 'object' &&
        typeof (q as QuotaPubblica).importo === 'number' && Number.isFinite((q as QuotaPubblica).importo) &&
        (q as QuotaPubblica).importo > 0 &&
        ((q as QuotaPubblica).fascia === null || typeof (q as QuotaPubblica).fascia === 'string'),
    )
    .map((q) => ({ fascia: q.fascia, importo: q.importo }))
  const moduli = data.moduli
    .filter(
      (m): m is DocumentoPubblico =>
        m !== null && typeof m === 'object' &&
        typeof (m as DocumentoPubblico).codice === 'string' &&
        typeof (m as DocumentoPubblico).titolo === 'string' && (m as DocumentoPubblico).titolo.length > 0,
    )
    .map((m) => ({ codice: m.codice, titolo: m.titolo }))
  return { quote, moduli }
}

/**
 * Quota di nuova iscrizione e documenti dell'anno per cui la famiglia si iscrive. Accessoria: un guasto, un 4xx
 * o una forma strana NON fermano il modulo — si registra e il pannello resta senza quota e senza elenco.
 * Nessun `setState` sincrono nell'effetto: lo stato è legato alla chiave `sede + anno` e si legge solo se coincide.
 */
export function useInfoAnno({ sedeId, annoId }: { sedeId: string | null; annoId: string | null }): InfoAnno | null {
  const chiave = sedeId && annoId ? `${sedeId}|${annoId}` : null
  const [stato, setStato] = useState<{ chiave: string; info: InfoAnno | null } | null>(null)

  useEffect(() => {
    if (!sedeId || !annoId || !chiave) return
    let annullato = false
    const fine = (info: InfoAnno | null) => {
      if (!annullato) setStato({ chiave, info })
    }
    fetch(`${ROTTA_INFO_ANNO}?scuola_id=${encodeURIComponent(sedeId)}&anno_id=${encodeURIComponent(annoId)}`)
      .then(async (r) => {
        if (!r.ok) {
          logClient({ livello: 'warn', evento: 'fetch', messaggio: 'iscrizione-info-anno-non-caricata', stato: r.status })
          return fine(null)
        }
        const info = infoAnnoValida(await r.json().catch(() => null))
        if (!info) logClient({ livello: 'warn', evento: 'fetch', messaggio: 'iscrizione-info-anno-corpo-inatteso' })
        fine(info)
      })
      .catch((err: unknown) => {
        logClient({ livello: 'warn', evento: 'fetch', messaggio: `iscrizione-info-anno-non-caricata: ${nomeErrore(err)}` })
        fine(null)
      })
    return () => {
      annullato = true
    }
  }, [sedeId, annoId, chiave])

  return stato !== null && stato.chiave === chiave ? stato.info : null
}
