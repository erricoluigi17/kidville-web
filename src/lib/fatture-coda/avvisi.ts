import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { enqueueNotifiche } from '@/lib/push/enqueue'
import { staffScuola } from '@/lib/notifiche/destinatari'
import { sediReali } from '@/lib/scuole/reali'
import { codaAssente } from '@/lib/fatture-coda/api'
import { MAX_DURATION_BLOCCO_S } from '@/lib/pagamenti/lotto-fatture'
import { LINK_CODA_FATTURE, categoria, componiAvvisi, zFattiCoda } from '@/lib/fatture-coda/avvisi-testi'

/**
 * ─── GLI AVVISI DELLA CODA FATTURE: PRENDERLI E SPEDIRLI (consegna 2c) ─────────────
 *
 * Prende i fatti nuovi con `fatture_coda_avvisi_prendi` (che li segna come avvisati nella
 * stessa transazione), compone i testi con `avvisi-testi.ts` e accoda una notifica per
 * destinatario: campanella al prossimo polling, push al prossimo `notifiche-dispatch`.
 * NON LANCIA MAI: la chiamano la route del giro, a giro finito, e quella della sospensione,
 * a stato già scritto — il loro esito non dipende da qui. Al più una volta: un inserimento
 * fallito dopo la RPC è un avviso perso, e lo registra `enqueueNotifiche`.
 */

export const OPERAZIONE_AVVISI = 'fatture-coda/avvisi'
/** Oltre questo tempo dall'inizio della route del giro gli avvisi aspettano il giro dopo (restano da avvisare). */
export const LIMITE_AVVISI_MS = MAX_DURATION_BLOCCO_S * 1_000 - 20_000
/** Quanti errori al più per chiamata (la funzione ne accetta da 1 a 500). */
export const ERRORI_PER_CHIAMATA = 200

export type EsitoAvvisiCodice =
  | 'spediti'
  | 'nessuno'
  | 'rinviati'
  | 'non-disponibili'
  | 'non-letti'
  | 'illeggibili'
  | 'eccezione'

export interface EsitoAvvisi {
  esito: EsitoAvvisiCodice
  avvisi: number
  /** Inserimenti tentati, uno per destinatario (l'esito di ciascuno lo registra `enqueueNotifiche`). */
  tentate: number
}

const esito = (e: EsitoAvvisiCodice, avvisi = 0, tentate = 0): EsitoAvvisi => ({ esito: e, avvisi, tentate })

export async function spedisciAvvisiCoda(
  sb: SupabaseClient,
  opzioni: { operazione: string; attore?: string | null; inizioMs?: number },
): Promise<EsitoAvvisi> {
  const base = { operazione: OPERAZIONE_AVVISI, azione: opzioni.operazione }
  try {
    if (opzioni.inizioMs !== undefined && Date.now() - opzioni.inizioMs > LIMITE_AVVISI_MS) {
      logEvento('fattura', 'info', { ...base, esito: 'avvisi-rinviati', ms: Date.now() - opzioni.inizioMs })
      return esito('rinviati')
    }

    const { data, error } = await sb.rpc('fatture_coda_avvisi_prendi', { p_limite: ERRORI_PER_CHIAMATA })
    if (error) {
      if (codaAssente(error)) {
        // `warn`, come le POST della coda sullo stesso caso (`coda-assente`): in produzione è
        // la migrazione che manca, e gli avvisi tacerebbero a ogni tick col battito verde.
        logEvento('fattura', 'warn', { ...base, esito: 'avvisi-non-disponibili' }, error)
        return esito('non-disponibili')
      }
      logEvento('fattura', 'error', { ...base, esito: 'avvisi-non-letti' }, error)
      return esito('non-letti')
    }

    const letti = zFattiCoda.safeParse(data)
    if (!letti.success) {
      // I fatti sono GIÀ segnati come avvisati: questo è un avviso perso, e va gridato.
      logEvento('fattura', 'error', { ...base, esito: 'avvisi-illeggibili' }, letti.error)
      return esito('illeggibili')
    }
    const fatti = letti.data
    if (fatti.errori.length === 0 && fatti.fini.length === 0 && !fatti.pausa && !fatti.sospensione) {
      logEvento('fattura', 'info', { ...base, esito: 'avvisi-nessuno' })
      return esito('nessuno')
    }

    // Gli admin servono per i «da verificare», le anomalie, la pausa, la sospensione e la
    // ripresa; per i soli errori da correggere no, e la lettura non si fa.
    const servonoAdmin =
      fatti.pausa !== null ||
      fatti.sospensione !== null ||
      fatti.errori.some((e) => categoria(e.codice) !== 'da_correggere')
    const admin = servonoAdmin ? await adminReali(sb) : []
    const avvisi = componiAvvisi(fatti, { adesso: new Date(), admin, attore: opzioni.attore ?? null })

    let tentate = 0
    for (const a of avvisi) {
      for (const utente of a.destinatari) {
        tentate++
        try {
          // Uno per destinatario: `creato_da` non ha FK, e un accodante cancellato farebbe
          // fallire sulla FK di `notifiche` l'INSERT intera di una chiamata con più utenti.
          await enqueueNotifiche(sb, {
            utenteIds: [utente],
            tipo: a.tipo,
            titolo: a.titolo,
            corpo: a.corpo,
            link: LINK_CODA_FATTURE,
            entitaTipo: a.entitaTipo,
            entitaId: a.entitaId,
            bufferMin: 0,
            // Nessuno `scuolaId`, di proposito: senza sede nessun interruttore (decisione 21).
          })
        } catch (err) {
          logEvento('fattura', 'error', { ...base, esito: 'avviso-non-accodato', tipo: a.tipo }, err)
        }
      }
    }

    logEvento(
      'fattura',
      'info',
      {
        ...base,
        esito: 'avvisi-spediti',
        avvisi: avvisi.length,
        tentate,
        admin: admin.length,
        errori: fatti.errori.length,
        fini: fatti.fini.length,
        pausa: fatti.pausa !== null,
        sospesa: fatti.sospensione?.evento === 'sospesa',
        ripresa: fatti.sospensione?.evento === 'ripresa',
      },
      undefined,
      { distingui: ['azione'] },
    )
    return esito('spediti', avvisi.length, tentate)
  } catch (err) {
    logEvento('fattura', 'error', { ...base, esito: 'avvisi-eccezione' }, err)
    return esito('eccezione')
  }
}

/**
 * Gli admin delle sedi REALI: `sediReali` esclude la sede di collaudo, `staffScuola` unisce sede
 * primaria e ponte `utenti_scuole` (l'unica lettura ammessa dal lock `destinatari-con-ponte`) e
 * registra da sé i propri guasti. Vuoto ⇒ gli avvisi agli admin di questa chiamata sono persi,
 * e lo dice il `warn`.
 */
async function adminReali(sb: SupabaseClient): Promise<string[]> {
  const sedi = await sediReali(sb, OPERAZIONE_AVVISI)
  const ids = new Set<string>()
  for (const s of sedi.reali) for (const id of await staffScuola(sb, s.id, ['admin'])) ids.add(id)
  if (ids.size === 0) {
    logEvento('fattura', 'warn', { operazione: OPERAZIONE_AVVISI, esito: 'admin-non-risolti' }, sedi.error ?? undefined)
  }
  return [...ids]
}
