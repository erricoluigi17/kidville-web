import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import it from '../../../messages/it/shared.json'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
import type { AppUser } from '@/lib/auth/predicati-ruolo'
import { formaConfronto, scuoleDiUtente } from '@/lib/auth/scope'
import { erroreAnno } from '@/lib/anno/errori'
import { schemaAnnoIndietro } from '@/lib/anno/schema'
import { codiceDaMessaggio } from '@/lib/anno/tipi'
import { logScrittura } from '@/lib/audit/scrittura'
import { segnalaErroreLoggato } from '@/lib/logging/context'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { CODICI_ERRORE } from '@/lib/ui/esito-fetch'

/**
 * LE ROUTE DELLE IMPOSTAZIONI DELL'ANNO (PR 4.2, compito 4.2.4) — ciò che hanno in comune.
 *
 * Quattro route (`GET`/`PATCH /api/admin/anni/[annoSedeId]` e `POST …/apri-iscrizioni`) chiamano le
 * funzioni SQL di `anno_impostazioni_sede.sql`. La REGOLA sta nel database (le date, i prerequisiti,
 * gli stati ammessi); qui stanno solo tre cose:
 *  · il PERIMETRO: l'`anni_sede` nominato dev'essere di una sede dell'utente;
 *  · il DEGRADO: sul database della CI le funzioni e la tabella non ci sono ancora (503, mai 500);
 *  · la TRADUZIONE: il codice d'errore del database diventa una risposta HTTP (`erroreAnno` ne è l'unico
 *    posto) con in più i dettagli che il `DETAIL` porta (il motivo, l'elenco, i conteggi) e un log.
 *
 * Nei log passano solo uuid, date, numeri, booleani e codici: il `DETAIL` non è mai copiato per intero
 * (è JSON del database) e i conteggi per tabella sono numeri, non righe.
 */

const CATALOGO_IT = it as Record<string, string>

function frase(codice: keyof typeof CODICI_ERRORE): string {
  return CATALOGO_IT[CODICI_ERRORE[codice]]
}

type ErroreDb = { code?: string; message?: string; details?: string | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATA = /^\d{4}-\d{2}-\d{2}$/
/** Un codice del database (`fuori_periodo`, `ultimo_giorno_aperto`, un nome di tabella): minuscole e trattini bassi. */
const CODICE_MINUSCOLO = /^[a-z][a-z0-9_]{0,63}$/

const STATI_ANNO = new Set(['in_preparazione', 'iscrizioni_aperte', 'corrente', 'in_chiusura', 'chiuso'])
const PREREQUISITI = ['quota_conferma', 'quota_nuova', 'moduli_conferma', 'moduli_nuova']

// ── Piccoli lettori: ciò che non ha la forma attesa non entra né nella risposta né nel log ──────────

const uuidDa = (v: unknown): string | undefined => (typeof v === 'string' && UUID.test(v) ? v : undefined)
const dataDa = (v: unknown): string | undefined => (typeof v === 'string' && DATA.test(v) ? v : undefined)
const codiceDa = (v: unknown): string | undefined =>
  typeof v === 'string' && CODICE_MINUSCOLO.test(v) ? v : undefined
const numeroDa = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** Toglie le chiavi `undefined`: un campo di log assente non è un campo vuoto. */
function senzaVuoti<T extends Record<string, string | number | boolean | undefined>>(o: T) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Record<string, string | number | boolean>
}

/** Un evento del dominio `anno-scolastico`, senza i campi che non hanno valore. */
function evento(livello: 'info' | 'warn', campi: Record<string, string | number | boolean | undefined>): void {
  logEvento('anno-scolastico', livello, senzaVuoti(campi))
}

/**
 * Il `DETAIL` del database (JSON come testo). Illeggibile = `null` e una riga `info` che lo dice:
 * la risposta resta quella del codice, solo senza i dettagli.
 */
function leggiDettaglio(error: ErroreDb, operazione: string): Record<string, unknown> | null {
  if (typeof error.details !== 'string' || error.details === '') return null
  try {
    const d: unknown = JSON.parse(error.details)
    return d !== null && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : null
  } catch {
    evento('info', {
      tipo: 'dettaglio-errore-illeggibile',
      operazione,
      error_code: codiceDaMessaggio(error.message) ?? undefined,
    })
    return null
  }
}

// ── Degrado e guasti ─────────────────────────────────────────────────────────────────────────

/**
 * 503: il database non ha (ancora) lo schema dell'anno. Succede sul database della CI e nella finestra del
 * deploy; non è un guasto di nessuno, quindi `info` e non `error`.
 */
export function impostazioniNonDisponibili(error: ErroreDb, operazione: string): NextResponse {
  evento('info', {
    tipo: 'impostazioni-schema-indietro',
    operazione,
    error_code: typeof error.code === 'string' ? error.code : undefined,
  })
  // Degrado previsto, già loggato qui a `info`: segnato come «già loggato» perché `withRoute` non ci aggiunga
  // un `error` per il 5xx (M10). Ogni altro 503 non passa da qui e resta com'è.
  segnalaErroreLoggato()
  return NextResponse.json(
    { error: frase('CALENDARIO_NON_DISPONIBILE'), codice: 'CALENDARIO_NON_DISPONIBILE' },
    { status: 503 },
  )
}

/** Un guasto vero (non un rifiuto del database, non lo schema indietro): `logErrore` e 500. */
function guasto(error: unknown, operazione: string, lettura: boolean): NextResponse {
  logErrore({ operazione, stato: 500 }, error)
  return lettura
    ? NextResponse.json({ error: frase('LETTURA_FALLITA'), codice: 'LETTURA_FALLITA' }, { status: 500 })
    : NextResponse.json({ error: frase('SCRITTURA_FALLITA'), codice: 'SCRITTURA_FALLITA' }, { status: 500 })
}

// ── L'anno nominato dalla route, dentro il perimetro dell'utente ─────────────────────────────

/**
 * L'anno nominato dall'URL (`anni_sede.id`, GIÀ validato come uuid dalla route) è di una sede dell'utente?
 * `null` se sì; altrimenti la risposta da restituire: 404 `ANNO_NON_TROVATO` se la riga non c'è, 403
 * `SEDE_NON_ACCESSIBILE` (con un `warn`) se è di un'altra sede, 503 se il database non ha lo schema
 * dell'anno, 500 se la lettura è fallita. Il nome segue la convenzione `assert…InScope`: è il gate che il
 * lock `isolamento-sede-coverage` riconosce, e le funzioni SQL ricevono proprio l'id che ha verificato.
 */
export async function assertAnnoSedeInScope(
  supabase: SupabaseClient,
  user: AppUser,
  annoSedeId: string,
  operazione: string,
): Promise<NextResponse | null> {
  const { data, error } = await supabase.from('anni_sede').select('id, scuola_id').eq('id', annoSedeId).maybeSingle()
  if (error) {
    if (schemaAnnoIndietro(error)) return impostazioniNonDisponibili(error, operazione)
    return guasto(error, `${operazione}:lettura`, true)
  }
  const riga = data as { id: string; scuola_id: string } | null
  if (!riga) {
    return NextResponse.json({ error: frase('ANNO_NON_TROVATO'), codice: 'ANNO_NON_TROVATO' }, { status: 404 })
  }

  const sedi = await scuoleDiUtente(supabase, user)
  if (!sedi.some((s) => formaConfronto(s) === formaConfronto(riga.scuola_id))) {
    logEvento('multi_sede', 'warn', {
      operazione,
      esito: 'anno-fuori-sede',
      utente: user.id,
      ruolo: user.role,
      sede_id: riga.scuola_id,
    })
    return rifiutoSede('SEDE_NON_ACCESSIBILE')
  }
  return null
}

// ── Il risultato di una funzione che scrive ──────────────────────────────────────────────────

/** Il `jsonb` di una funzione di scrittura, se ha la forma attesa (un oggetto con `cambiato`). */
export function risultatoScrittura(data: unknown): (Record<string, unknown> & { cambiato: boolean }) | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  const o = data as Record<string, unknown>
  return typeof o.cambiato === 'boolean' ? (o as Record<string, unknown> & { cambiato: boolean }) : null
}

/** Una funzione ha risposto senza errore ma con un valore che non è quello atteso: guasto, non 200. */
export function rispostaNonRiconosciuta(operazione: string): NextResponse {
  return guasto(new Error('risposta della funzione non riconosciuta'), operazione, false)
}

// ── I log di successo: uuid, date, booleani, nessuna riga di bambino ─────────────────────────

export type ChiHaAgito = { utente: string; annoSedeId: string }

export function logConfineSpostato(chi: ChiHaAgito, r: Record<string, unknown>): void {
  evento('info', {
    tipo: 'anno-confine-spostato',
    anno_sede_id: chi.annoSedeId,
    utente: chi.utente,
    successivo_anno_sede_id: uuidDa(r.successivo_anno_sede_id),
    fine_precedente: dataDa(r.fine_precedente),
    fine_nuova: dataDa(r.fine_nuova),
    inizio_successivo_precedente: dataDa(r.inizio_successivo_precedente),
    inizio_successivo_nuovo: dataDa(r.inizio_successivo_nuovo),
  })
}

export function logDateImpostate(chi: ChiHaAgito, r: Record<string, unknown>): void {
  evento('info', {
    tipo: 'anno-date-impostate',
    anno_sede_id: chi.annoSedeId,
    utente: chi.utente,
    ultimo_giorno_aperto: dataDa(r.ultimo_giorno_aperto),
    ultimo_giorno_aperto_precedente: dataDa(r.ultimo_giorno_aperto_precedente),
    prepara_successivo_dal: dataDa(r.prepara_successivo_dal),
    prepara_successivo_dal_precedente: dataDa(r.prepara_successivo_dal_precedente),
  })
}

export function logDomandeImpostate(chi: ChiHaAgito, aperte: boolean): void {
  evento('info', {
    tipo: 'anno-domande-impostate',
    anno_sede_id: chi.annoSedeId,
    utente: chi.utente,
    aperte,
  })
}

export function logIscrizioniAperte(chi: ChiHaAgito): void {
  evento('info', {
    tipo: 'anno-iscrizioni-aperte',
    anno_sede_id: chi.annoSedeId,
    utente: chi.utente,
  })
}

// ── La traccia di chi e quando (audit_scritture_docente) ──────────────────────────────────────

type ValoriTraccia = { prima: Record<string, unknown>; dopo: Record<string, unknown> }

/**
 * Una riga nel registro delle scritture per ogni modifica RIUSCITA e con `cambiato: true`: chi, quando e
 * i valori prima/dopo (solo uuid, date, stati, booleani). Il log `info` di sopra vive pochi giorni su Vercel;
 * questa resta. `logScrittura` non lancia mai e, se l'inserimento fallisce, lo registra da sé: la risposta
 * della route non cambia. La sede si rilegge dalla riga (un utente con più sedi non ha «la sua»).
 */
export async function tracciaAnno(
  supabase: SupabaseClient,
  user: AppUser,
  annoSedeId: string,
  v: ValoriTraccia,
): Promise<void> {
  let scuolaId: string | undefined
  try {
    const { data, error } = await supabase.from('anni_sede').select('id, scuola_id').eq('id', annoSedeId).maybeSingle()
    if (error) {
      // La traccia si scrive lo stesso (con la sede dell'attore): la sede non letta si dice, non si ignora.
      evento('info', { tipo: 'anno-traccia-sede-non-letta', anno_sede_id: annoSedeId, utente: user.id, error_code: typeof error.code === 'string' ? error.code : undefined })
    } else {
      scuolaId = uuidDa((data as { scuola_id?: unknown } | null)?.scuola_id)
    }
  } catch (err) {
    evento('info', { tipo: 'anno-traccia-sede-non-letta', anno_sede_id: annoSedeId, utente: user.id })
    logErrore({ operazione: 'anno:traccia:sede', stato: 500 }, err)
  }
  await logScrittura(supabase, {
    attore: user,
    entitaTipo: 'anno_sede',
    entitaId: annoSedeId,
    azione: 'update',
    scuolaId,
    valorePrima: v.prima,
    valoreDopo: v.dopo,
  })
}

const campoData = (r: Record<string, unknown>, k: string) => dataDa(r[k]) ?? null

export const valoriConfine = (r: Record<string, unknown>): ValoriTraccia => ({
  prima: { fine: campoData(r, 'fine_precedente'), inizio_successivo: campoData(r, 'inizio_successivo_precedente') },
  dopo: { fine: campoData(r, 'fine_nuova'), inizio_successivo: campoData(r, 'inizio_successivo_nuovo') },
})

export const valoriDate = (r: Record<string, unknown>): ValoriTraccia => ({
  prima: {
    ultimo_giorno_aperto: campoData(r, 'ultimo_giorno_aperto_precedente'),
    prepara_successivo_dal: campoData(r, 'prepara_successivo_dal_precedente'),
  },
  dopo: {
    ultimo_giorno_aperto: campoData(r, 'ultimo_giorno_aperto'),
    prepara_successivo_dal: campoData(r, 'prepara_successivo_dal'),
  },
})

export const valoriDomande = (aperte: boolean): ValoriTraccia => ({
  prima: { domande_aperte: !aperte },
  dopo: { domande_aperte: aperte },
})

export const valoriApertura = (r: Record<string, unknown>): ValoriTraccia => ({
  prima: { stato: 'in_preparazione' },
  dopo: { stato: typeof r.stato === 'string' && STATI_ANNO.has(r.stato) ? r.stato : 'iscrizioni_aperte' },
})

// ── Il rifiuto del database, tradotto ────────────────────────────────────────────────────────

export type ContestoRifiuto = ChiHaAgito & {
  operazione: string
  /** Il `tipo` del warn per i rifiuti di stato e di prerequisiti: cambia fra «domande» e «iscrizioni». */
  tipoRifiuto: 'anno-domande-rifiutate' | 'anno-iscrizioni-rifiutate' | 'anno-date-rifiutate' | 'anno-confine-rifiutato'
  /** Solo per `domande`: il valore che si voleva impostare. */
  aperte?: boolean
  /** `true` per la `GET`: il guasto è «lettura» e non «scrittura». */
  lettura?: boolean
}

/**
 * Traduce l'errore di una funzione SQL. Ordine: schema indietro (503) → codice dell'anno con i dettagli del
 * `DETAIL` (409/422/404/400, e il log del rifiuto) → guasto vero (`logErrore`, 500). Non risponde mai 200.
 */
export function rispostaErroreImpostazioni(error: ErroreDb, ctx: ContestoRifiuto): NextResponse {
  if (schemaAnnoIndietro(error)) return impostazioniNonDisponibili(error, ctx.operazione)

  const codice = codiceDaMessaggio(error.message)
  const base = { anno_sede_id: ctx.annoSedeId, utente: ctx.utente }
  let dettagli: Record<string, unknown> | undefined

  switch (codice) {
    case 'CONFINE_CON_RIGHE': {
      // I conteggi per tabella: numeri, mai le righe. Nel log, una riga per tabella (`entita_tipo` = il nome, `righe` = il conteggio).
      const d = leggiDettaglio(error, ctx.operazione)
      const tabelle: Record<string, number> = {}
      if (d?.tabelle !== null && typeof d?.tabelle === 'object') {
        for (const [nome, n] of Object.entries(d.tabelle as Record<string, unknown>)) {
          if (codiceDa(nome) && numeroDa(n) !== undefined) tabelle[nome] = n as number
        }
      }
      const righe = numeroDa(d?.righe)
      const senzaCompetenza = numeroDa(d?.senza_competenza)
      const dal = dataDa(d?.dal)
      const al = dataDa(d?.al)
      evento('warn', {
        tipo: 'anno-confine-rifiutato',
        ...base,
        nuova_fine: dataDa(d?.nuova_fine),
        dal,
        al,
        righe,
        senza_competenza: senzaCompetenza,
      })
      // Una riga per tabella: il NOME sta come valore di `entita_tipo` (chiave in chiaro) e non dentro il nome
      // di una chiave, perché `redact` decide sulla chiave (`note_disciplinari` conterrebbe «note»).
      for (const [nome, n] of Object.entries(tabelle)) {
        evento('warn', { tipo: 'anno-confine-rifiutato-tabella', ...base, entita_tipo: nome, righe: n })
      }
      dettagli = senzaVuoti({ righe, senza_competenza: senzaCompetenza, dal, al })
      dettagli.tabelle = tabelle
      break
    }
    case 'CONFINE_NON_VALIDO': {
      const d = leggiDettaglio(error, ctx.operazione)
      const motivo = codiceDa(d?.motivo)
      // `motivo` è radice di testo libero per `redact`: il motivo in codice va sotto `esito`.
      evento('warn', { tipo: 'anno-rifiuto', ...base, operazione: ctx.operazione, error_code: codice, esito: motivo ?? 'rifiutato' })
      dettagli = senzaVuoti({ motivo })
      break
    }
    case 'DATE_NON_VALIDE': {
      const d = leggiDettaglio(error, ctx.operazione)
      const motivo = codiceDa(d?.motivo)
      const campo = codiceDa(d?.campo)
      // `motivo` è una radice di testo libero per `redact` (sparirebbe): il motivo in codice va sotto `esito`,
      // il campo (`ultimo_giorno_aperto`, …) sotto `entita_tipo`. Nella risposta HTTP restano `motivo` e `campo`.
      evento('warn', { tipo: 'anno-date-rifiutate', ...base, esito: motivo, entita_tipo: campo })
      dettagli = senzaVuoti({ motivo, campo })
      break
    }
    case 'PREREQUISITI_MANCANTI': {
      const d = leggiDettaglio(error, ctx.operazione)
      const mancano = Array.isArray(d?.mancano)
        ? (d.mancano as unknown[]).filter((m): m is string => typeof m === 'string' && PREREQUISITI.includes(m))
        : []
      evento('warn', { tipo: ctx.tipoRifiuto, ...base, n_mancanti: mancano.length })
      dettagli = { mancano }
      break
    }
    case 'STATO_NON_AMMESSO': {
      const d = leggiDettaglio(error, ctx.operazione)
      const stato = typeof d?.stato === 'string' && STATI_ANNO.has(d.stato) ? d.stato : undefined
      evento('warn', { tipo: ctx.tipoRifiuto, ...base, stato, aperte: ctx.aperte })
      dettagli = senzaVuoti({ stato })
      break
    }
    default:
      // CONFINE_NON_VALIDO, ANNO_IN_CHIUSURA, ANNO_NON_TROVATO, PARAMETRO_MANCANTE e ogni altro codice:
      // senza questa riga restava solo l'`info`/`warn` di withRoute, senza la sede e senza chi ha chiesto.
      if (codice !== null) {
        evento('warn', {
          tipo: 'anno-rifiuto',
          ...base,
          operazione: ctx.operazione,
          error_code: codice,
          esito: 'rifiutato',
        })
      }
      break
  }

  return erroreAnno(error, ctx.operazione, dettagli) ?? guasto(error, ctx.operazione, ctx.lettura === true)
}
