import { NextResponse } from 'next/server'
import { puoCorreggereStorico } from '@/lib/storici/retroattivita'
import type { SupabaseClient } from '@supabase/supabase-js'
import { haRuolo, haUnRuolo, type AppRole, type AppUser } from '@/lib/auth/predicati-ruolo'
import { logEvento } from '@/lib/logging/logger'
import { chiusureIn, leggiQuadrimestri, type QuadrimestriLetti } from '@/lib/primaria/quadrimestre'
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
 * Le regole (spec 2026-09-24, «2 Primaria» + «Convenzioni di esecuzione»; per voti e
 * impreparati, spec 2026-11-04 `voti-data-storico-design`):
 *
 *  · CHI — l'autore della voce (l'id lo passa il chiamante: `maestra_id`,
 *    `creato_da`, `caricato_da`…), oppure Segreteria e Direzione
 *    (`segreteria`/`admin`/`coordinator`). Un impreparato dichiarato dal GENITORE
 *    lo può togliere anche qualunque docente della classe (`utenti_sezioni`).
 *  · FINO A QUANDO — il termine di `timelock.ts`: 2 giorni, 15 per le prove
 *    scritte/pratiche, valori per sede da `admin_settings`. Segreteria e Direzione
 *    possono correggere senza scadenza, dopo il gate di sede. Da quale giorno si conta
 *    dipende dalla voce:
 *      – VALUTAZIONE e IMPREPARATO DELLA DOCENTE (`contaDalSalvataggio`): dal giorno di
 *        Roma in cui sono state SALVATE (`giornoSalvataggio`, cioè `creato_il`; se manca,
 *        `dataEvento`). La data della prova la sceglie la docente e può essere
 *        retrodatata: se contasse il termine su quella, una prova di tre settimane fa
 *        nascerebbe già bloccata e un voto «datato ieri» si potrebbe ritoccare per mesi;
 *      – TUTTO IL RESTO (registro, firma, nota, allegato, impreparato del genitore): la
 *        DATA DI ROMA dell'evento, come sempre. Su queste voci il modulo non legge i periodi.
 *  · CONGELAMENTO — solo per le voci che contano dal salvataggio: se una delle loro date
 *    (la data dell'evento e, se la modifica la sposta, la nuova) cade in un quadrimestre
 *    il cui scrutinio è CHIUSO per la loro classe, la voce non si tocca nemmeno dentro il
 *    termine: 423 `QUADRIMESTRE_CHIUSO`. Spostare un voto da un quadrimestre aperto a uno
 *    chiuso, o all'inverso, vale come toccarlo. Un guasto nella lettura dei periodi o degli
 *    scrutini è 500 `LETTURA_FALLITA`, mai un 423 né un via libera. Periodi assenti o senza
 *    date non congelano niente (configurazione mancante: la voce resta come prima).
 *  · OLTRE IL TERMINE o CONGELATA — solo con uno sblocco in `sblocchi_audit`: per la VOCE
 *    (`entita_tipo` = tipo, `entita_id` = id) oppure per il GIORNO della classe
 *    (`entita_tipo` = 'giorno', `section_id`, `data`). Per registro e firma vale
 *    anche lo sblocco per SLOT (`entita_tipo` = 'registro', sezione + data + ora),
 *    lo stesso che legge `primaria/registro:POST`.
 *      – Per le voci che contano dal salvataggio lo sblocco per VOCE copre TUTTO: termine,
 *        congelamento e anche la data spostata; quello per GIORNO vale se è il giorno del
 *        SALVATAGGIO (non quello della prova) e riapre anche il congelamento;
 *      – ma il CONGELAMENTO lo riapre solo uno sblocco dato DOPO la chiusura dello scrutinio che
 *        lo causa (`sblocchi_audit.sbloccato_il` > `scrutini.chiuso_il`), per entrambe le forme di
 *        sblocco e per ciascun quadrimestre chiuso che la voce tocca (la data attuale e quella nuova
 *        di una modifica). Uno sblocco dato prima l'ha dato la Direzione per altro, a scrutinio
 *        aperto, e non scongela: per riaprire serve uno sblocco nuovo. Una chiusura senza `chiuso_il`
 *        non è superabile da nessuno sblocco (fail-closed; lo staff corregge comunque) e lo dice un
 *        log `info`. Il filtro di tempo vale SOLO per il congelamento: il termine e le voci che non
 *        si congelano si riaprono con qualunque sblocco, come prima;
 *      – per le altre lo sblocco per VOCE copre solo la sua `dataEvento`: una
 *        `nuovaDataEvento` oltre il termine chiede in più lo sblocco del giorno (o dello
 *        slot) di quella data.
 *    Se nessuno sblocco copre, il rifiuto è `QUADRIMESTRE_CHIUSO` per una voce congelata
 *    (vince anche quando è pure oltre il termine), altrimenti `VOCE_BLOCCATA`.
 *
 * ⚠️ QUESTO MODULO NON VERIFICA LA SEDE. Lo scope (`assertSezioneInScope`) resta
 * al chiamante, PRIMA di chiamare qui: «è Segreteria» non vuol dire «è Segreteria
 * di quella classe».
 *
 * ⚠️ NON VALIDA LE DATE. Il chiamante passa `dataEvento`, `nuovaDataEvento` e
 * `giornoSalvataggio` già in forma `YYYY-MM-DD` (zod nella route): una data in un'altra
 * forma non cade in nessun periodo e si leggerebbe come «non congelata».
 */

export type TipoVoce = 'registro' | 'firma' | 'valutazione' | 'nota' | 'impreparato' | 'allegato'

/** I ruoli che possono modificare/eliminare anche le voci altrui (senza scadenza). */
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
   * allegato = `registro_orario.data`; impreparato = `data`; nota = data di Roma di
   * `creato_il` (vedi `dataEventoDaIstante`); valutazione = la data della PROVA
   * (`data_evento`, scelta dalla docente e retrodatabile; per le righe nate prima della
   * colonna, il giorno di Roma di `creato_il`). Per valutazioni e impreparati della docente
   * NON è la data da cui corre il termine (quella è `giornoSalvataggio`): serve al congelamento.
   */
  dataEvento: string
  /**
   * Se la modifica SPOSTA la data, anche la nuova. Il termine delle voci che non contano dal
   * salvataggio si controlla su entrambe; il congelamento (valutazioni e impreparati della
   * docente) guarda entrambe le date.
   */
  nuovaDataEvento?: string | null
  /**
   * Solo valutazioni e impreparati della docente: il giorno di Roma di `creato_il`, da cui corre
   * il termine. Assente ⇒ si usa `dataEvento` (il comportamento di prima).
   */
  giornoSalvataggio?: string | null
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
  | { ok: false; stato: 423; codice: 'QUADRIMESTRE_CHIUSO' }
  | { ok: false; stato: 500; codice: 'LETTURA_FALLITA' }

export type EsitoPermessoVoce = { ok: true } | EsitoNegato

/** Quello che una GET dice alla UI per ciascuna voce. */
export interface StatoVoce {
  /** Il bottone Modifica/Elimina si mostra: autorizzato E non `bloccata` (entro il termine e non congelata, oppure sbloccata). */
  modificabile: boolean
  /**
   * Oltre il termine, oppure congelata dallo scrutinio chiuso (vedi `congelata`), e senza uno sblocco che la riapra:
   * la Direzione vede «Sblocca». Vale per chiunque guardi.
   */
  bloccata: boolean
  /** Il limite in giorni che si applica alla voce (per il testo «oltre N giorni»). */
  giorniLimite: number
  /**
   * Solo per le voci che contano dal salvataggio: la voce cade in un quadrimestre con lo scrutinio
   * chiuso e nessuno sblocco DATO DOPO LA CHIUSURA la riapre. Implica `bloccata`; la UI la distingue dal termine scaduto.
   */
  congelata?: boolean
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

/** Il rifiuto di una voce congelata: 423 `QUADRIMESTRE_CHIUSO`, con la riga di log che porta il codice. */
function rifiutoCongelata(campi: Record<string, string | number | null>): EsitoNegato {
  logEvento('registro', 'info', {
    operazione: 'primaria/permesso-voce',
    esito: 'voce-congelata',
    error_code: 'QUADRIMESTRE_CHIUSO',
    ...campi,
  })
  return { ok: false, stato: 423, codice: 'QUADRIMESTRE_CHIUSO' }
}

/** Le date da controllare per una voce: l'evento e, se la modifica la sposta, la nuova. */
function dateDi(voce: VocePrimaria): string[] {
  const date = [voce.dataEvento]
  if (voce.nuovaDataEvento && voce.nuovaDataEvento !== voce.dataEvento) date.push(voce.nuovaDataEvento)
  return date
}

/**
 * Il termine corre dal giorno in cui la voce è stata SALVATA, e la voce si può congelare: le
 * valutazioni e gli impreparati segnati dalla docente. L'impreparato dichiarato dal genitore
 * resta come prima (la data è quella del giorno che dichiara, non una scelta della docente).
 */
export function contaDalSalvataggio(voce: VocePrimaria): boolean {
  return voce.tipo === 'valutazione' || (voce.tipo === 'impreparato' && voce.origine !== 'genitore')
}

/** Il giorno da cui corre il termine di una voce che conta dal salvataggio. */
function giornoDelTermine(voce: VocePrimaria): string {
  return voce.giornoSalvataggio ?? voce.dataEvento
}

/** Le date su cui cercare uno sblocco: il giorno del salvataggio, o le date oltre il termine. */
function dateDaSbloccare(voce: VocePrimaria, oltre: readonly string[]): string[] {
  return contaDalSalvataggio(voce) ? [giornoDelTermine(voce)] : [...oltre]
}

/**
 * Il congelamento di una voce che conta dal salvataggio, PRIMA degli sblocchi.
 *
 * `congelata: false` se nessuna delle sue date (l'evento e, se la modifica la sposta, la nuova) cade in un quadrimestre con lo
 * scrutinio chiuso per la sua classe. Altrimenti `dopo` dice da quando uno sblocco la riapre: l'istante (ms) della chiusura PIÙ
 * RECENTE fra quelle che la congelano, e lo sblocco deve essere dato DOPO — uno sblocco per ciascuna chiusura, o, che è lo
 * stesso, uno solo dopo l'ultima. Uno sblocco dato prima non scongela: l'avrebbe dato la Direzione per altro, e a scrutinio
 * ancora aperto. `dopo: null` = una di quelle chiusure non ha una data leggibile (`chiuso_il` assente): nessuno sblocco la
 * supera (fail-closed), lo staff modifica comunque.
 */
type Congelamento = { congelata: false } | { congelata: true; dopo: number | null }

function congelamentoDi(letti: QuadrimestriLetti, voce: VocePrimaria): Congelamento {
  const chiusure = dateDi(voce).flatMap((d) => chiusureIn(letti, voce.scuolaId, voce.sectionId, d))
  if (chiusure.length === 0) return { congelata: false }
  let dopo = Number.NEGATIVE_INFINITY
  for (const chiusoIl of chiusure) {
    const t = chiusoIl ? Date.parse(chiusoIl) : Number.NaN
    if (Number.isNaN(t)) return { congelata: true, dopo: null }
    dopo = Math.max(dopo, t)
  }
  return { congelata: true, dopo }
}

/** Lo sblocco è stato dato DOPO l'istante `dopo`? Senza `dopo` (voce non congelata) qualunque sblocco vale; una data assente o illeggibile no. */
function datoDopo(sbloccatoIl: string | null | undefined, dopo: number | undefined): boolean {
  if (dopo === undefined) return true
  const t = sbloccatoIl ? Date.parse(sbloccatoIl) : Number.NaN
  return t > dopo
}

/** Un guasto dei DATI, non del database: uno scrutinio `chiuso` che non dice quando. Si dice a livello info (la voce resta chiusa). */
function logChiusuraSenzaData(campi: Record<string, string | number | null>): void {
  logEvento('registro', 'info', { operazione: 'primaria/permesso-voce', esito: 'scrutinio-chiuso-senza-data', ...campi })
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
  /** Le date da coprire con uno sblocco (vedi `dateDaSbloccare`). */
  date: string[]
  /**
   * Solo per le voci congelate: l'istante (ms) della chiusura più recente che le congela. Uno sblocco le riapre solo se
   * `sbloccato_il` è DOPO. Assente = nessun filtro di tempo (il termine si supera con qualunque sblocco).
   */
  dopo?: number
}

/**
 * Le voci oltre il termine, o congelate, che uno sblocco copre. Due letture al massimo:
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
    .select('entita_tipo, entita_id, sbloccato_il')
    .in('entita_id', ids)
  if (perVoce.error) {
    logGuasto('sblocchi-per-voce-non-letti', perVoce.error, { n: ids.length })
    return { ok: false }
  }
  const righeVoce = ((perVoce.data ?? []) as { entita_tipo: string; entita_id: string | null; sbloccato_il?: string | null }[])
    .filter((r) => r.entita_id)
  // Lo sblocco per VOCE copre la voce DOVE STA, cioè `dataEvento`, e basta. Se la
  // modifica la sposta su un'altra data anch'essa oltre il termine, quella data
  // va coperta a parte (giorno, o slot per registro/firma): altrimenti un solo
  // sblocco del 07/09 basterebbe a riscrivere la voce su un giorno di tre mesi
  // prima. Stessa regola del passo 2: OGNI data oltre il termine è coperta.
  // Fanno eccezione le voci che contano dal salvataggio (D9): il loro termine non
  // dipende dalle date dell'evento, quindi lo sblocco per voce copre anche la data
  // spostata, e non resta niente da coprire a parte.
  const restanti: Oltre[] = []
  for (const o of oltre) {
    const k = chiaveVoce(o.voce.tipo, o.voce.id)
    // Per una voce congelata lo sblocco conta solo se è stato dato dopo la chiusura (`o.dopo`).
    const sbloccataPerVoce = righeVoce.some(
      (r) => r.entita_tipo === o.voce.tipo && r.entita_id === o.voce.id && datoDopo(r.sbloccato_il, o.dopo),
    )
    if (!sbloccataPerVoce) {
      restanti.push(o)
      continue
    }
    const residue = contaDalSalvataggio(o.voce) ? [] : o.date.filter((d) => d !== o.voce.dataEvento)
    if (residue.length === 0) chiavi.set(k, 'voce')
    else restanti.push({ voce: o.voce, date: residue })
  }
  if (restanti.length === 0) return { ok: true, chiavi }

  // ── 2. Per giorno della classe (e per slot, registro/firma) ────────────────
  const sezioni = [...new Set(restanti.map((o) => o.voce.sectionId))]
  const date = [...new Set(restanti.flatMap((o) => o.date))]
  const perGiorno = await supabase
    .from('sblocchi_audit')
    .select('entita_tipo, section_id, data, ora_lezione, sbloccato_il')
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
    sbloccato_il?: string | null
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
        if (!datoDopo(r.sbloccato_il, o.dopo)) return false
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

/**
 * Il calcolo del termine di una voce: le date oltre, e il limite. Per le voci che contano dal
 * salvataggio la sola data che conta è il giorno del salvataggio (`[giorno]` se scaduto, altrimenti `[]`).
 */
function oltreTermine(voce: VocePrimaria, termini: Deadlines, adesso: Date): { date: string[]; giorniLimite: number } {
  const giorniLimite = limitePer(termini, voce.lockTipo ?? 'classe_orale')
  const scaduta = (d: string) => calcolaScadenza(d, giorniLimite, adesso).locked
  if (contaDalSalvataggio(voce)) {
    const giorno = giornoDelTermine(voce)
    return { date: scaduta(giorno) ? [giorno] : [], giorniLimite }
  }
  return { date: dateDi(voce).filter(scaduta), giorniLimite }
}

// ─── Le due porte ────────────────────────────────────────────────────────────

/**
 * Può `utente` modificare/eliminare questa voce ADESSO?
 *
 * L'ordine conta: prima CHI (403, senza leggere sblocchi), poi lo staff (passa prima di ogni
 * lettura di termini e periodi), poi il TERMINE e il CONGELAMENTO (423).
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

  if (puoCorreggereStorico(utente)) {
    logEvento('registro', 'info', { operazione: 'primaria/permesso-voce', esito: 'rettifica-staff-autorizzata', ...campi })
    return { ok: true }
  }

  const ter = await terminiPerSede(supabase, [voce])
  if (!ter.ok) return LETTURA_FALLITA
  const dalSalvataggio = contaDalSalvataggio(voce)
  const { date: oltre, giorniLimite } = oltreTermine(voce, ter.perSede.get(voce.scuolaId ?? '') as Deadlines, adesso)

  // Il congelamento riguarda solo le voci che contano dal salvataggio, e si legge solo per loro.
  // Senza sede non c'è dove cercare i periodi: la voce resta come prima.
  let congelamento: Congelamento = { congelata: false }
  if (dalSalvataggio && voce.scuolaId) {
    const q = await leggiQuadrimestri(supabase, { scuolaIds: [voce.scuolaId], sectionIds: [voce.sectionId] })
    if (!q.ok) return LETTURA_FALLITA
    congelamento = congelamentoDi(q.letti, voce)
  }
  const congelata = congelamento.congelata
  if (oltre.length === 0 && !congelata) return { ok: true }

  // Una chiusura senza data: nessuno sblocco può esserle posteriore. Non si leggono nemmeno.
  if (congelamento.congelata && congelamento.dopo === null) {
    logChiusuraSenzaData(campi)
    return rifiutoCongelata(campi)
  }

  const sb = await sbloccate(supabase, [
    { voce, date: dateDaSbloccare(voce, oltre), dopo: congelamento.congelata ? (congelamento.dopo ?? undefined) : undefined },
  ])
  if (!sb.ok) return LETTURA_FALLITA
  const via = sb.chiavi.get(chiaveVoce(voce.tipo, voce.id))
  if (via) {
    // Un successo che si logga: senza, «nessun log» non distingue «mai sbloccata»
    // da «sbloccata e passata».
    logEvento('registro', 'info', {
      operazione: 'primaria/permesso-voce',
      esito: congelata ? 'voce-congelata-autorizzata' : 'voce-oltre-termine-autorizzata',
      azione: via,
      ...campi,
    })
    return { ok: true }
  }
  if (congelata) return rifiutoCongelata(campi)
  logEvento('registro', 'info', {
    operazione: 'primaria/permesso-voce',
    esito: 'voce-bloccata',
    error_code: 'VOCE_BLOCCATA',
    giorni_limite: giorniLimite,
    ...campi,
  })
  return { ok: false, stato: 423, codice: 'VOCE_BLOCCATA', giorniLimite }
}

/**
 * La variante per gli ELENCHI: per ogni voce `{ modificabile, bloccata }` (e `congelata`
 * per quelle che contano dal salvataggio), con al più una lettura dei termini per sede,
 * una di `utenti_sezioni`, una dei periodi e una degli scrutini (tutte le sedi e le classi
 * del lotto insieme) e due di `sblocchi_audit` per tutto il lotto — non N per voce.
 */
export async function statoVoci(
  supabase: SupabaseClient,
  utente: AppUser,
  voci: readonly VocePrimaria[],
  adesso: Date = new Date(),
): Promise<EsitoBatch> {
  const esiti = new Map<string, StatoVoce>()
  if (voci.length === 0) return { ok: true, esiti }

  if (puoCorreggereStorico(utente)) {
    for (const v of voci) esiti.set(chiaveVoce(v.tipo, v.id), { modificabile: true, bloccata: false, giorniLimite: 0 })
    return { ok: true, esiti }
  }

  const aut = await autorizzate(supabase, utente, voci)
  if (!aut.ok) return LETTURA_FALLITA
  const ter = await terminiPerSede(supabase, voci)
  if (!ter.ok) return LETTURA_FALLITA

  // Una sola lettura dei quadrimestri per tutto il lotto. `chiusoIn` su una sede che non è stata
  // letta darebbe `false` in silenzio, quindi si passano TUTTE le sedi e TUTTE le classi delle voci
  // che contano dal salvataggio.
  let letti: QuadrimestriLetti | null = null
  const dalSalvataggio = voci.filter(contaDalSalvataggio)
  if (dalSalvataggio.length > 0) {
    const scuolaIds = [...new Set(dalSalvataggio.flatMap((v) => (v.scuolaId ? [v.scuolaId] : [])))]
    const sectionIds = [...new Set(dalSalvataggio.map((v) => v.sectionId))]
    const q = await leggiQuadrimestri(supabase, { scuolaIds, sectionIds })
    if (!q.ok) return LETTURA_FALLITA
    letti = q.letti
  }

  const daSbloccare: Oltre[] = []
  const richiedonoSblocco = new Set<string>()
  const limiti = new Map<string, number>()
  const congelateGrezze = new Set<string>()
  let chiusureSenzaData = 0
  for (const v of voci) {
    const k = chiaveVoce(v.tipo, v.id)
    const { date: oltre, giorniLimite } = oltreTermine(v, ter.perSede.get(v.scuolaId ?? '') as Deadlines, adesso)
    limiti.set(k, giorniLimite)
    const congelamento: Congelamento = letti != null && contaDalSalvataggio(v) ? congelamentoDi(letti, v) : { congelata: false }
    if (congelamento.congelata) congelateGrezze.add(k)
    if (oltre.length === 0 && !congelamento.congelata) continue
    richiedonoSblocco.add(k)
    if (congelamento.congelata && congelamento.dopo === null) {
      // Chiusura senza data: nessuno sblocco la supera, quindi non si cerca (la voce resta bloccata e congelata).
      chiusureSenzaData++
      continue
    }
    daSbloccare.push({
      voce: v,
      date: dateDaSbloccare(v, oltre),
      dopo: congelamento.congelata ? (congelamento.dopo ?? undefined) : undefined,
    })
  }
  if (chiusureSenzaData > 0) logChiusuraSenzaData({ n: chiusureSenzaData })
  const sb = await sbloccate(supabase, daSbloccare)
  if (!sb.ok) return LETTURA_FALLITA

  for (const v of voci) {
    const k = chiaveVoce(v.tipo, v.id)
    const bloccata = richiedonoSblocco.has(k) && !sb.chiavi.has(k)
    const stato: StatoVoce = {
      modificabile: aut.chiavi.has(k) && !bloccata,
      bloccata,
      giorniLimite: limiti.get(k) as number,
    }
    if (contaDalSalvataggio(v)) stato.congelata = congelateGrezze.has(k) && !sb.chiavi.has(k)
    esiti.set(k, stato)
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
    if (esito.codice === 'QUADRIMESTRE_CHIUSO') {
      return NextResponse.json(
        {
          error: 'Il quadrimestre di questa data ha lo scrutinio chiuso: serve lo sblocco della Direzione.',
          codice: 'QUADRIMESTRE_CHIUSO',
          locked: true,
        },
        { status: 423 },
      )
    }
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
