import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { haRuolo, haUnRuolo, type AppRole, type AppUser } from '@/lib/auth/predicati-ruolo'
import { logEvento } from '@/lib/logging/logger'
import {
  calcolaScadenza,
  dataRomaDi,
  leggiTermini,
  limitePer,
  type Deadlines,
  type LockTipo,
} from '@/lib/primaria/timelock'

/**
 * CHI PUÒ MODIFICARE O ELIMINARE UNA VOCE DELLA PRIMARIA, E FINO A QUANDO.
 *
 * Le regole (spec 2026-09-24, «2 Primaria» + «Convenzioni di esecuzione»):
 *
 *  · CHI — l'autore della voce (l'id lo passa il chiamante: `maestra_id`,
 *    `creato_da`, `caricato_da`…), oppure Segreteria e Direzione
 *    (`segreteria`/`admin`/`coordinator`). Un impreparato dichiarato dal GENITORE
 *    lo può togliere anche qualunque docente della classe (`utenti_sezioni`).
 *  · FINO A QUANDO — il termine di `timelock.ts` sulla DATA DI ROMA dell'evento:
 *    2 giorni, 15 per le prove scritte/pratiche, valori per sede da
 *    `admin_settings`. Il termine vale per TUTTI, Segreteria e Direzione comprese.
 *  · OLTRE IL TERMINE — solo con uno sblocco in `sblocchi_audit`: per la VOCE
 *    (`entita_tipo` = tipo, `entita_id` = id) oppure per il GIORNO della classe
 *    (`entita_tipo` = 'giorno', `section_id`, `data`). Per registro e firma vale
 *    anche lo sblocco per SLOT (`entita_tipo` = 'registro', sezione + data + ora),
 *    lo stesso che legge `primaria/registro:POST`. Lo sblocco per VOCE copre
 *    solo la sua `dataEvento`: una `nuovaDataEvento` oltre il termine chiede in
 *    più lo sblocco del giorno (o dello slot) di quella data.
 *
 * ⚠️ QUESTO MODULO NON VERIFICA LA SEDE. Lo scope (`assertSezioneInScope`) resta
 * al chiamante, PRIMA di chiamare qui: «è Segreteria» non vuol dire «è Segreteria
 * di quella classe».
 */

export type TipoVoce = 'registro' | 'firma' | 'valutazione' | 'nota' | 'impreparato' | 'allegato'

/** I ruoli che possono modificare/eliminare anche le voci altrui (sempre entro il termine). */
const RUOLI_STAFF: readonly AppRole[] = ['segreteria', 'admin', 'coordinator']

/**
 * Le colonne che il database E2E della CI (progetto separato, non migrato) può
 * non avere: `section_id`/`data`/`ora_lezione` di `sblocchi_audit`. `42703` è la
 * forma di Postgres su una SELECT, `PGRST204` quella dello schema cache.
 */
const COLONNA_ASSENTE = new Set(['42703', 'PGRST204'])

export interface VocePrimaria {
  tipo: TipoVoce
  /** L'uuid della riga (registro_orario, firme_docenti, valutazioni, note_disciplinari, giustifiche_didattiche, allegati_registro). */
  id: string
  /** Chi ha scritto la voce. `null` = nessun autore noto: resta solo lo staff. */
  autoreId: string | null
  /** La classe della voce: serve allo sblocco per giorno e ai docenti della classe. */
  sectionId: string
  /** La sede della classe: da qui si leggono i termini (`admin_settings`). */
  scuolaId: string | null
  /**
   * La data dell'evento, `YYYY-MM-DD` (convenzioni della spec): lezione, firma e
   * allegato = `registro_orario.data`; impreparato = `data`; valutazione e nota =
   * data di Roma di `creato_il` (vedi `dataEventoDaIstante`).
   */
  dataEvento: string
  /** Se la modifica SPOSTA la data, anche la nuova: il termine si controlla su entrambe. */
  nuovaDataEvento?: string | null
  /** `scritto_pratico` = 15 giorni (predefinito). Assente = `classe_orale`. */
  lockTipo?: LockTipo
  /** Solo impreparati: `'genitore'` apre la rimozione ai docenti della classe. */
  origine?: string | null
  /** Solo registro/firma: l'ora della campanella, per lo sblocco per slot. */
  oraLezione?: number | null
}

export type EsitoNegato =
  | { ok: false; stato: 403; codice: 'VOCE_NON_AUTORE' }
  | { ok: false; stato: 423; codice: 'VOCE_BLOCCATA'; giorniLimite: number }
  | { ok: false; stato: 500; codice: 'LETTURA_FALLITA' }

export type EsitoPermessoVoce = { ok: true } | EsitoNegato

/** Quello che una GET dice alla UI per ciascuna voce. */
export interface StatoVoce {
  /** Il bottone Modifica/Elimina si mostra: autorizzato E (entro il termine O sbloccato). */
  modificabile: boolean
  /** Oltre il termine e senza sblocco: la Direzione vede «Sblocca». Vale per chiunque guardi. */
  bloccata: boolean
  /** Il limite in giorni che si applica alla voce (per il testo «oltre N giorni»). */
  giorniLimite: number
}

export type EsitoBatch =
  | { ok: true; esiti: Map<string, StatoVoce> }
  | { ok: false; stato: 500; codice: 'LETTURA_FALLITA' }

/** La chiave con cui la variante batch indicizza gli esiti: tipo + id. */
export function chiaveVoce(tipo: TipoVoce, id: string): string {
  return `${tipo}:${id}`
}

/** Data dell'evento di valutazioni e note: la data di ROMA di `creato_il`. */
export function dataEventoDaIstante(creatoIl: string): string {
  return dataRomaDi(creatoIl)
}

const LETTURA_FALLITA = { ok: false, stato: 500, codice: 'LETTURA_FALLITA' } as const

function codiceDi(err: unknown): string {
  return (err as { code?: string } | null)?.code ?? ''
}

function logGuasto(esito: string, err: unknown, campi: Record<string, string | number | null> = {}): void {
  logEvento('registro', 'error', { operazione: 'primaria/permesso-voce', esito, ...campi }, err)
}

/** Le date da controllare per una voce: l'evento e, se la modifica la sposta, la nuova. */
function dateDi(voce: VocePrimaria): string[] {
  const date = [voce.dataEvento]
  if (voce.nuovaDataEvento && voce.nuovaDataEvento !== voce.dataEvento) date.push(voce.nuovaDataEvento)
  return date
}

// ─── I pezzi, ciascuno con UNA lettura al massimo per tutto il lotto ─────────

/** Chi è autorizzato, a prescindere dal termine. Una lettura sola (`utenti_sezioni`), e solo se serve. */
async function autorizzate(
  supabase: SupabaseClient,
  utente: AppUser,
  voci: readonly VocePrimaria[],
): Promise<{ ok: true; chiavi: Set<string> } | { ok: false }> {
  const chiavi = new Set<string>()
  const staff = haUnRuolo(utente, RUOLI_STAFF)
  const daClasse: VocePrimaria[] = []
  for (const v of voci) {
    if (staff || (v.autoreId != null && v.autoreId === utente.id)) chiavi.add(chiaveVoce(v.tipo, v.id))
    else if (v.tipo === 'impreparato' && v.origine === 'genitore' && haRuolo(utente, 'educator')) daClasse.push(v)
  }
  if (daClasse.length === 0) return { ok: true, chiavi }

  const sezioni = [...new Set(daClasse.map((v) => v.sectionId))]
  const { data, error } = await supabase
    .from('utenti_sezioni')
    .select('section_id')
    .eq('utente_id', utente.id)
    .in('section_id', sezioni)
  if (error) {
    logGuasto('docenti-classe-non-letti', error, { n: sezioni.length })
    return { ok: false }
  }
  const mie = new Set(((data ?? []) as { section_id: string }[]).map((r) => r.section_id))
  for (const v of daClasse) if (mie.has(v.sectionId)) chiavi.add(chiaveVoce(v.tipo, v.id))
  return { ok: true, chiavi }
}

/** I termini di ogni sede del lotto (di solito una). */
async function terminiPerSede(
  supabase: SupabaseClient,
  voci: readonly VocePrimaria[],
): Promise<{ ok: true; perSede: Map<string, Deadlines> } | { ok: false }> {
  const perSede = new Map<string, Deadlines>()
  for (const scuolaId of new Set(voci.map((v) => v.scuolaId ?? ''))) {
    const letti = await leggiTermini(supabase, scuolaId || null)
    if (!letti.ok) {
      logGuasto('termini-non-letti', letti.error, { scuola_id: scuolaId || null })
      return { ok: false }
    }
    perSede.set(scuolaId, letti.termini)
  }
  return { ok: true, perSede }
}

interface Oltre {
  voce: VocePrimaria
  /** Le date della voce che superano il termine. */
  date: string[]
}

/**
 * Le voci oltre il termine che uno sblocco copre. Due letture al massimo:
 * per entità (`entita_id in …`) e per giorno/slot (`section_id`+`data in …`).
 */
async function sbloccate(
  supabase: SupabaseClient,
  oltre: readonly Oltre[],
): Promise<{ ok: true; chiavi: Map<string, 'voce' | 'giorno' | 'slot'> } | { ok: false }> {
  const chiavi = new Map<string, 'voce' | 'giorno' | 'slot'>()
  if (oltre.length === 0) return { ok: true, chiavi }

  // ── 1. Per voce ──────────────────────────────────────────────────────────
  const ids = [...new Set(oltre.map((o) => o.voce.id))]
  const perVoce = await supabase
    .from('sblocchi_audit')
    .select('entita_tipo, entita_id')
    .in('entita_id', ids)
  if (perVoce.error) {
    logGuasto('sblocchi-per-voce-non-letti', perVoce.error, { n: ids.length })
    return { ok: false }
  }
  const coppie = new Set(
    ((perVoce.data ?? []) as { entita_tipo: string; entita_id: string | null }[])
      .filter((r) => r.entita_id)
      .map((r) => `${r.entita_tipo}:${r.entita_id}`),
  )
  // Lo sblocco per VOCE copre la voce DOVE STA, cioè `dataEvento`, e basta. Se la
  // modifica la sposta su un'altra data anch'essa oltre il termine, quella data
  // va coperta a parte (giorno, o slot per registro/firma): altrimenti un solo
  // sblocco del 07/09 basterebbe a riscrivere la voce su un giorno di tre mesi
  // prima. Stessa regola del passo 2: OGNI data oltre il termine è coperta.
  const restanti: Oltre[] = []
  for (const o of oltre) {
    const k = chiaveVoce(o.voce.tipo, o.voce.id)
    if (!coppie.has(k)) {
      restanti.push(o)
      continue
    }
    const residue = o.date.filter((d) => d !== o.voce.dataEvento)
    if (residue.length === 0) chiavi.set(k, 'voce')
    else restanti.push({ voce: o.voce, date: residue })
  }
  if (restanti.length === 0) return { ok: true, chiavi }

  // ── 2. Per giorno della classe (e per slot, registro/firma) ────────────────
  const sezioni = [...new Set(restanti.map((o) => o.voce.sectionId))]
  const date = [...new Set(restanti.flatMap((o) => o.date))]
  const perGiorno = await supabase
    .from('sblocchi_audit')
    .select('entita_tipo, section_id, data, ora_lezione')
    .in('entita_tipo', ['giorno', 'registro'])
    .in('section_id', sezioni)
    .in('data', date)
  if (perGiorno.error) {
    if (COLONNA_ASSENTE.has(codiceDi(perGiorno.error))) {
      // DB non migrato (E2E della CI): lì «colonna assente» vale «nessuno sblocco
      // per giorno o per slot», cioè lo stato di prima. Non è un guasto, ma si
      // dichiara: un 423 lì non deve sembrare un registro sbloccato e poi negato.
      logEvento('registro', 'info', {
        operazione: 'primaria/permesso-voce',
        esito: 'sblocco-per-giorno-non-disponibile-schema',
        n: restanti.length,
      }, perGiorno.error)
      return { ok: true, chiavi }
    }
    logGuasto('sblocchi-per-giorno-non-letti', perGiorno.error, { n: restanti.length })
    return { ok: false }
  }
  const righe = (perGiorno.data ?? []) as {
    entita_tipo: string
    section_id: string | null
    data: string | null
    ora_lezione: number | null
  }[]
  for (const o of restanti) {
    const v = o.voce
    const conSlot = (v.tipo === 'registro' || v.tipo === 'firma') && v.oraLezione != null
    let viaSlot = false
    // OGNI data oltre il termine deve essere coperta: spostare una voce su un
    // giorno sbloccato non autorizza a toglierla da un giorno che non lo è.
    const coperte = o.date.every((d) =>
      righe.some((r) => {
        if (r.section_id !== v.sectionId || String(r.data).slice(0, 10) !== d) return false
        if (r.entita_tipo === 'giorno') return true
        if (conSlot && r.entita_tipo === 'registro' && Number(r.ora_lezione) === Number(v.oraLezione)) {
          viaSlot = true
          return true
        }
        return false
      }),
    )
    if (coperte) chiavi.set(chiaveVoce(v.tipo, v.id), viaSlot ? 'slot' : 'giorno')
  }
  return { ok: true, chiavi }
}

/** Il calcolo del termine di una voce: le date oltre, e il limite. */
function oltreTermine(voce: VocePrimaria, termini: Deadlines, adesso: Date): { date: string[]; giorniLimite: number } {
  const giorniLimite = limitePer(termini, voce.lockTipo ?? 'classe_orale')
  const date = dateDi(voce).filter((d) => calcolaScadenza(d, giorniLimite, adesso).locked)
  return { date, giorniLimite }
}

// ─── Le due porte ────────────────────────────────────────────────────────────

/**
 * Può `utente` modificare/eliminare questa voce ADESSO?
 *
 * L'ordine conta: prima CHI (403, senza leggere sblocchi), poi il TERMINE (423).
 * Un guasto di lettura è 500 `LETTURA_FALLITA`, mai un 423 travestito: dire
 * «bloccata, chiedi lo sblocco» su una voce che il dirigente ha già sbloccato è
 * il guasto che `primaria/registro:POST` ha già pagato una volta.
 */
export async function verificaPermessoVoce(
  supabase: SupabaseClient,
  utente: AppUser,
  voce: VocePrimaria,
  adesso: Date = new Date(),
): Promise<EsitoPermessoVoce> {
  const campi = { entita_tipo: voce.tipo, sezione: voce.sectionId }

  const aut = await autorizzate(supabase, utente, [voce])
  if (!aut.ok) return LETTURA_FALLITA
  if (!aut.chiavi.has(chiaveVoce(voce.tipo, voce.id))) {
    logEvento('registro', 'info', { operazione: 'primaria/permesso-voce', esito: 'voce-non-autore', ...campi })
    return { ok: false, stato: 403, codice: 'VOCE_NON_AUTORE' }
  }

  const ter = await terminiPerSede(supabase, [voce])
  if (!ter.ok) return LETTURA_FALLITA
  const { date, giorniLimite } = oltreTermine(voce, ter.perSede.get(voce.scuolaId ?? '') as Deadlines, adesso)
  if (date.length === 0) return { ok: true }

  const sb = await sbloccate(supabase, [{ voce, date }])
  if (!sb.ok) return LETTURA_FALLITA
  const via = sb.chiavi.get(chiaveVoce(voce.tipo, voce.id))
  if (via) {
    // Un successo che si logga: senza, «nessun log» non distingue «mai sbloccata»
    // da «sbloccata e passata».
    logEvento('registro', 'info', {
      operazione: 'primaria/permesso-voce',
      esito: 'voce-oltre-termine-autorizzata',
      azione: via,
      ...campi,
    })
    return { ok: true }
  }
  logEvento('registro', 'info', {
    operazione: 'primaria/permesso-voce',
    esito: 'voce-bloccata',
    giorni_limite: giorniLimite,
    ...campi,
  })
  return { ok: false, stato: 423, codice: 'VOCE_BLOCCATA', giorniLimite }
}

/**
 * La variante per gli ELENCHI: per ogni voce `{ modificabile, bloccata }`, con
 * al più una lettura dei termini per sede, una di `utenti_sezioni` e due di
 * `sblocchi_audit` per tutto il lotto — non N per voce.
 */
export async function statoVoci(
  supabase: SupabaseClient,
  utente: AppUser,
  voci: readonly VocePrimaria[],
  adesso: Date = new Date(),
): Promise<EsitoBatch> {
  const esiti = new Map<string, StatoVoce>()
  if (voci.length === 0) return { ok: true, esiti }

  const aut = await autorizzate(supabase, utente, voci)
  if (!aut.ok) return LETTURA_FALLITA
  const ter = await terminiPerSede(supabase, voci)
  if (!ter.ok) return LETTURA_FALLITA

  const oltre: Oltre[] = []
  const limiti = new Map<string, number>()
  for (const v of voci) {
    const { date, giorniLimite } = oltreTermine(v, ter.perSede.get(v.scuolaId ?? '') as Deadlines, adesso)
    limiti.set(chiaveVoce(v.tipo, v.id), giorniLimite)
    if (date.length > 0) oltre.push({ voce: v, date })
  }
  const sb = await sbloccate(supabase, oltre)
  if (!sb.ok) return LETTURA_FALLITA

  const inOltre = new Set(oltre.map((o) => chiaveVoce(o.voce.tipo, o.voce.id)))
  for (const v of voci) {
    const k = chiaveVoce(v.tipo, v.id)
    const bloccata = inOltre.has(k) && !sb.chiavi.has(k)
    esiti.set(k, {
      modificabile: aut.chiavi.has(k) && !bloccata,
      bloccata,
      giorniLimite: limiti.get(k) as number,
    })
  }
  return { ok: true, esiti }
}

/**
 * La risposta HTTP di un permesso negato: codice stabile per la UI, testo senza
 * prosa di PostgREST. Il chiamante la restituisce così com'è.
 */
export function rispostaPermessoNegato(esito: EsitoNegato): NextResponse {
  if (esito.stato === 403) {
    return NextResponse.json(
      { error: 'Puoi modificare o eliminare solo le voci che hai scritto tu.', codice: 'VOCE_NON_AUTORE' },
      { status: 403 },
    )
  }
  if (esito.stato === 423) {
    return NextResponse.json(
      {
        error: `Voce bloccata: superato il termine di ${esito.giorniLimite} giorni. Serve lo sblocco della Direzione.`,
        codice: 'VOCE_BLOCCATA',
        giorniLimite: esito.giorniLimite,
        locked: true,
      },
      { status: 423 },
    )
  }
  return NextResponse.json(
    { error: 'Verifica dei permessi non riuscita. Riprova.', codice: 'LETTURA_FALLITA' },
    { status: 500 },
  )
}
