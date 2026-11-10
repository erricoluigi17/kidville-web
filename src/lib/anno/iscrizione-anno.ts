import type { SupabaseClient } from '@supabase/supabase-js'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { segnalaErroreAnnoGestito } from '@/lib/logging/context'
import { schemaAnnoIndietro } from '@/lib/anno/schema'
import { codiceAnnoDa, type CodiceAnno } from '@/lib/anno/tipi'
import { annoVisibileDiSede, finestraDiSede, leggiFinestraDiSede, scriviFrequenza } from '@/lib/anno/frequenze'
import { STATO_ISCRITTO, STATO_RITIRATO } from '@/lib/alunni/stato'
import type { AppUser } from '@/lib/auth/predicati-ruolo'
import { controllaVoceEliminabile } from '@/lib/pagamenti/voce-eliminabile'
import { ritiraPendingPagamento } from '@/lib/pagamenti/notifiche-storiche'
import { oggiRoma } from '@/lib/storici/retroattivita'
import { dataCivile } from '@/i18n/config'
import { politicaNotificaServizio } from '@/lib/storici/notifiche-servizi'

/**
 * L'ISCRIZIONE ALL'ANNO PROSSIMO: l'unica porta TypeScript per le funzioni SQL che la scrivono (PR 4.5).
 *
 * Una conferma o una domanda per un anno che non è quello in corso non cambia un dato dell'anno in corso: scrive una
 * FREQUENZA `in_attesa` nell'anno aperto e la voce della sua quota (`anno_registra_frequenza`, `anno_quota_voce`, migrazione
 * M45c). Chi chiama (domanda accolta 4.5.8, conferme 4.5.6, import 4.5.9) passa da qui e da nessun'altra parte.
 *
 * Le funzioni di questo modulo NON LANCIANO MAI e rispondono con un esito:
 *  · `{ ok: true, …campi del jsonb }`: scritta;
 *  · `{ ok: true, saltata: 'schema-indietro' }`: il database non ha ancora la funzione (la CI, la finestra del deploy). Il
 *    chiamante prosegue come oggi, senza errore e senza rumore: un `info` e basta;
 *  · `{ ok: false, codice }`: un codice dell'anno (`ANNO_NON_APERTO`, `SEDE_DIVERSA`…) o `SCRITTURA_FALLITA` per ogni altro guasto.
 *
 * ⚠️ Nei log: uuid, codici e booleani. Mai un nome, un codice fiscale, un importo, il testo di un errore di Postgres (che può
 * riportare la riga intera): del guasto si logga il solo SQLSTATE.
 */

export type QuotaEsito = 'creata' | 'collegata' | 'gia_collegata' | 'piu_voci' | 'senza_listino' | 'scheda_archiviata'

/** I campi del jsonb di `anno_registra_frequenza`. `quota` è NULL per una frequenza già chiusa (ritirata): non le nasce una voce. */
export type RisultatoRegistra = {
  frequenza_id: string
  creata: boolean
  quota: QuotaEsito | null
  pagamento_id: string | null
  posti_oltre: boolean
  /** C'è solo (e vale `true`) se la frequenza esisteva già viva con un'altra sezione: quella chiesta NON è stata applicata (4.5.15, M4). */
  sezione_ignorata?: boolean
  /** Solo se era `ritirato` e questa chiamata l'ha riaperta (4.5.16). Le strade che riaprono sono due: `anno_registra_frequenza` (conferma, domanda, import) e `riapriFrequenzaProssima` (il ritorno da «Riporta»). */
  riaperta?: boolean
  /** Solo se era `trasferito` o `uscito`: non si riapre, la domanda è stata collegata e la voce non nasce (4.5.16). */
  chiusa?: boolean
}

export type CodiceIscrizione = CodiceAnno | 'SCRITTURA_FALLITA'
export type EsitoRegistra =
  | ({ ok: true } & RisultatoRegistra)
  | { ok: true; saltata: 'schema-indietro' }
  | { ok: false; codice: CodiceIscrizione }

export type RegistraFrequenzaArgs = {
  alunnoId: string
  annoSedeId: string
  tipo: 'conferma' | 'nuova'
  origine: 'domanda' | 'conferma' | 'segreteria' | 'import'
  domandaId?: string | null
  sectionId?: string | null
  /** AAAA-MM-GG; assente = l'inizio dell'anno. */
  dataIngresso?: string | null
  /** Lista bianca lato SQL: ogni chiave non ammessa è ignorata. */
  campi?: Record<string, unknown>
  /** Chi ha fatto il gesto (`utenti.id`): finisce in `pagamenti.creato_da` della voce nuova. Assente = autore vuoto, come prima. */
  da?: string | null
}

const OPERAZIONE = 'anno/iscrizione-anno:registraFrequenzaPerAnno'

type ErrorePg = { code?: string | null; message?: string | null } | null | undefined

type EsitoFallito = { ok: true; saltata: 'schema-indietro' } | { ok: false; codice: CodiceIscrizione }

/** Un errore che ha fermato la scrittura: dell'anno → warn col codice; schema indietro → info; altro → logErrore col solo SQLSTATE. */
function esitoDaErrore(error: ErrorePg, operazione: string, tipoRifiuto = 'frequenza-anno-non-registrata'): EsitoFallito {
  if (schemaAnnoIndietro(error)) {
    logEvento('anno-scolastico', 'info', { tipo: 'iscrizione-anno-schema-indietro', operazione, error_code: error?.code ?? undefined })
    return { ok: true, saltata: 'schema-indietro' }
  }
  const codice = codiceAnnoDa(error?.message)
  if (codice) {
    logEvento('anno-scolastico', 'warn', { tipo: tipoRifiuto, error_code: codice, operazione })
    // Gestito qui, fail-open: la rete di `withRoute` non deve tradurlo se la route risponde 500 per altro.
    segnalaErroreAnnoGestito(codice)
    return { ok: false, codice }
  }
  // Solo il codice di Postgres: il messaggio di un CHECK riporta la riga intera.
  logErrore({ operazione }, new Error(`iscrizione-anno:${error?.code ?? 'senza-codice'}`))
  return { ok: false, codice: 'SCRITTURA_FALLITA' }
}

const eRisultato = (d: unknown): d is RisultatoRegistra =>
  typeof d === 'object' && d !== null && typeof (d as RisultatoRegistra).frequenza_id === 'string'

/**
 * L'esito della voce della quota, con la voce se c'è: i soli uuid e il codice dell'esito. `senza_listino` e `piu_voci` sono a `warn`
 * (4.5.15, I1): la famiglia ha confermato e nessuna voce è nata, o ce n'è più d'una da guardare: qualcuno deve accorgersene.
 */
function logEsitoQuota(esito: QuotaEsito, operazione: string, pagamentoId: string | null | undefined): void {
  logEvento('anno-scolastico', esito === 'senza_listino' || esito === 'piu_voci' ? 'warn' : 'info', {
    tipo: 'quota-anno-voce',
    esito,
    operazione,
    entita_id: pagamentoId ?? undefined,
  })
}

/**
 * Registra la frequenza `(alunno, anno aperto)` e fa nascere (o collega) la voce della quota. Idempotente: rifatta con gli
 * stessi argomenti restituisce la stessa frequenza (`creata: false`). Mai blocca per i posti: `posti_oltre` è un avviso.
 */
export async function registraFrequenzaPerAnno(supabase: SupabaseClient, a: RegistraFrequenzaArgs): Promise<EsitoRegistra> {
  try {
    const { data, error } = await supabase.rpc('anno_registra_frequenza', {
      p_alunno: a.alunnoId,
      p_anno_sede: a.annoSedeId,
      p_tipo: a.tipo,
      p_origine: a.origine,
      p_domanda: a.domandaId ?? null,
      p_section: a.sectionId ?? null,
      p_data_ingresso: a.dataIngresso ?? null,
      p_campi: a.campi ?? null,
      // solo se c'è: un chiamante che non lo passa (la domanda pubblica) manda gli stessi argomenti di prima
      ...(a.da ? { p_da: a.da } : {}),
    })
    if (error) return esitoDaErrore(error, OPERAZIONE)
    if (!eRisultato(data)) {
      logErrore({ operazione: OPERAZIONE }, new Error('iscrizione-anno:risposta-inattesa'))
      return { ok: false, codice: 'SCRITTURA_FALLITA' }
    }

    logEvento('anno-scolastico', 'info', {
      tipo: 'frequenza-anno-registrata',
      esito: data.creata ? 'creata' : 'esistente',
      operazione: OPERAZIONE,
      entita_id: data.frequenza_id,
      posti_oltre: data.posti_oltre === true,
      sezione_ignorata: data.sezione_ignorata === true,
      riaperta: data.riaperta === true,
      chiusa: data.chiusa === true,
    })
    if (data.quota) logEsitoQuota(data.quota, OPERAZIONE, data.pagamento_id)
    return { ok: true, ...data }
  } catch (err) {
    // il client ha lanciato (rete, configurazione): chi chiama non deve cadere per questo
    logErrore({ operazione: OPERAZIONE }, err)
    return { ok: false, codice: 'SCRITTURA_FALLITA' }
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 4.5.6 · la conferma per l'anno prossimo e il «non rinnova»
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** I campi del jsonb di `anno_conferma`. */
export type RisultatoConferma = {
  frequenza_id: string
  creata: boolean
  cambia_grado: boolean
  retta_personalizzata_precedente: boolean
  quota: QuotaEsito | null
  pagamento_id: string | null
  posti_oltre: boolean
  /** Come in `RisultatoRegistra`: la sezione chiesta non è stata applicata (la riga c'era viva con un'altra). */
  sezione_ignorata?: boolean
  /** La conferma ha riaperto una frequenza ritirata (4.5.16). */
  riaperta?: boolean
}
export type EsitoConferma = ({ ok: true } & RisultatoConferma) | EsitoFallito

export type ConfermaArgs = {
  /** La frequenza VIVA dell'anno in corso. */
  frequenzaId: string
  /** `anni_sede.id` dell'anno con le iscrizioni aperte. */
  annoSedeNuovoId: string
  /** Assente = la continuazione della sezione di partenza (o nessuna). */
  sectionId?: string | null
  /** Chi conferma (`utenti.id`). */
  da: string
  /** La spunta «va alla primaria»: con questa la sezione è obbligatoria (`SEZIONE_OBBLIGATORIA`). */
  cambiaGrado?: boolean
}

const OP_CONFERMA = 'anno/iscrizione-anno:confermaIscrizione'

const eConferma = (d: unknown): d is RisultatoConferma =>
  typeof d === 'object' && d !== null && typeof (d as RisultatoConferma).frequenza_id === 'string'

/**
 * La famiglia conferma l'iscrizione all'anno aperto: nasce la frequenza `in_attesa` (e la voce della quota) senza toccare un dato
 * dell'anno in corso. Idempotente. Non lancia mai. Mai blocca per i posti (`posti_oltre` è un avviso).
 */
export async function confermaIscrizione(supabase: SupabaseClient, a: ConfermaArgs): Promise<EsitoConferma> {
  try {
    const { data, error } = await supabase.rpc('anno_conferma', {
      p_frequenza: a.frequenzaId,
      p_anno_sede_nuovo: a.annoSedeNuovoId,
      p_section: a.sectionId ?? null,
      p_da: a.da,
      p_cambia_grado: a.cambiaGrado === true,
    })
    if (error) return esitoDaErrore(error, OP_CONFERMA, 'conferma-anno-non-registrata')
    if (!eConferma(data)) {
      logErrore({ operazione: OP_CONFERMA }, new Error('iscrizione-anno:risposta-inattesa'))
      return { ok: false, codice: 'SCRITTURA_FALLITA' }
    }
    logEvento('anno-scolastico', 'info', {
      tipo: 'conferma-anno-registrata',
      esito: data.creata ? 'creata' : 'esistente',
      operazione: OP_CONFERMA,
      entita_id: data.frequenza_id,
      utente: a.da,
      cambia_grado: data.cambia_grado === true,
      posti_oltre: data.posti_oltre === true,
      sezione_ignorata: data.sezione_ignorata === true,
      riaperta: data.riaperta === true,
    })
    if (data.quota) logEsitoQuota(data.quota, OP_CONFERMA, data.pagamento_id)
    return { ok: true, ...data }
  } catch (err) {
    logErrore({ operazione: OP_CONFERMA }, err)
    return { ok: false, codice: 'SCRITTURA_FALLITA' }
  }
}

export const MOTIVI_NON_RINNOVA = ['altra_scuola', 'trasloco', 'fine_ciclo', 'motivi_economici', 'altro'] as const
export type MotivoNonRinnova = (typeof MOTIVI_NON_RINNOVA)[number]

export type RisultatoNonRinnova = { frequenza_id: string; non_rinnova: boolean; cambiato: boolean }
export type EsitoNonRinnova = ({ ok: true } & RisultatoNonRinnova) | EsitoFallito

export type NonRinnovaArgs = {
  /** La frequenza di PARTENZA (quella dell'anno in corso). */
  frequenzaId: string
  attivo: boolean
  /** Un codice dell'elenco chiuso, o assente. Mai testo libero. */
  motivo?: string | null
  da: string
}

const OP_NON_RINNOVA = 'anno/iscrizione-anno:segnaNonRinnova'

const eNonRinnova = (d: unknown): d is RisultatoNonRinnova =>
  typeof d === 'object' && d !== null && typeof (d as RisultatoNonRinnova).frequenza_id === 'string'
  && typeof (d as RisultatoNonRinnova).non_rinnova === 'boolean'

/** Segna (o toglie) il «no» della famiglia sulla frequenza di partenza. Non lancia mai. */
export async function segnaNonRinnova(supabase: SupabaseClient, a: NonRinnovaArgs): Promise<EsitoNonRinnova> {
  try {
    const { data, error } = await supabase.rpc('anno_non_rinnova', {
      p_frequenza: a.frequenzaId,
      p_attivo: a.attivo,
      p_motivo: a.attivo ? (a.motivo ?? null) : null,
      p_da: a.da,
    })
    if (error) return esitoDaErrore(error, OP_NON_RINNOVA, 'non-rinnova-non-registrato')
    if (!eNonRinnova(data)) {
      logErrore({ operazione: OP_NON_RINNOVA }, new Error('iscrizione-anno:risposta-inattesa'))
      return { ok: false, codice: 'SCRITTURA_FALLITA' }
    }
    logEvento('anno-scolastico', 'info', {
      tipo: 'non-rinnova-registrato',
      esito: data.non_rinnova ? 'segnato' : 'tolto',
      operazione: OP_NON_RINNOVA,
      entita_id: data.frequenza_id,
      utente: a.da,
      cambiato: data.cambiato === true,
      // il codice del motivo (elenco chiuso) sta sotto `entita_tipo`: `motivo` è una radice di testo libero e verrebbe redatta
      entita_tipo: data.non_rinnova && a.motivo ? a.motivo : undefined,
    })
    return { ok: true, ...data }
  } catch (err) {
    logErrore({ operazione: OP_NON_RINNOVA }, err)
    return { ok: false, codice: 'SCRITTURA_FALLITA' }
  }
}

export type AnnoDellaDomanda =
  | { tipo: 'attivo' | 'aperto'; annoSedeId: string; annoId: string }
  | { tipo: 'schema-indietro' }
  | { tipo: 'non-aperto' }

type RigaAnnoSede = { id: string; anno_id: string; stato: string }

const OP_ANNO = 'anno/iscrizione-anno:annoDellaDomanda'

/**
 * A che anno della sede appartiene una domanda. `annoId` è `anni_scolastici.id` (quello che il modulo pubblico manda), oppure
 * `null` = «come oggi»: l'anno attivo della sede.
 *  · l'anno è l'attivo                       → `attivo` (ma se è l'attivo NON ancora cominciato della finestra del passaggio → `aperto`);
 *  · l'anno ha le iscrizioni aperte          → `aperto` (la domanda diventa una frequenza dell'anno prossimo);
 *  · ogni altro anno, o uno che la sede non ha → `non-aperto`;
 *  · lo schema dell'anno non c'è (la CI)      → `schema-indietro`: il chiamante fa come oggi.
 * Non guarda `domande_aperte`: se la sede riceve domande per quell'anno lo decide la route pubblica. NON LANCIA MAI. Un guasto
 * (non di schema) con `annoId` nullo dà `schema-indietro` — il comportamento di oggi, che non perde una domanda vera —, con un
 * anno esplicito dà `non-aperto`; in tutti e due i casi `logErrore` col solo SQLSTATE.
 */
export async function annoDellaDomanda(
  supabase: SupabaseClient,
  scuolaId: string,
  annoId: string | null,
): Promise<AnnoDellaDomanda> {
  const guasto = (codice: string | null | undefined): AnnoDellaDomanda => {
    logErrore({ operazione: OP_ANNO }, new Error(`iscrizione-anno:${codice ?? 'senza-codice'}`))
    return annoId === null ? { tipo: 'schema-indietro' } : { tipo: 'non-aperto' }
  }
  try {
    const attivo = await supabase.rpc('anno_attivo', { p_scuola: scuolaId })
    if (attivo.error) {
      if (schemaAnnoIndietro(attivo.error)) {
        logEvento('anno-scolastico', 'info', { tipo: 'iscrizione-anno-schema-indietro', operazione: OP_ANNO, error_code: attivo.error.code ?? undefined })
        return { tipo: 'schema-indietro' }
      }
      return guasto(attivo.error.code)
    }
    const idAttivo = typeof attivo.data === 'string' ? attivo.data : null

    const anni = await supabase.from('anni_sede').select('id, anno_id, stato').eq('scuola_id', scuolaId)
    if (anni.error) {
      if (schemaAnnoIndietro(anni.error)) {
        logEvento('anno-scolastico', 'info', { tipo: 'iscrizione-anno-schema-indietro', operazione: OP_ANNO, error_code: anni.error.code ?? undefined })
        return { tipo: 'schema-indietro' }
      }
      return guasto(anni.error.code)
    }
    const righe = (anni.data ?? []) as RigaAnnoSede[]

    const riga = annoId === null
      ? righe.find((r) => r.id === idAttivo)
      : righe.find((r) => r.anno_id === annoId)
    if (!riga) return { tipo: 'non-aperto' }
    if (riga.id === idAttivo) {
      // (giro 4, NB3) Nella FINESTRA fra la conferma del passaggio e l'inizio, l'anno attivo è il nuovo e non è ancora cominciato: una domanda
      // per lui vale come una per l'anno prossimo (`aperto`): scheda «in arrivo» e frequenza dell'anno nuovo con ingresso all'inizio, come il
      // `POST` della segreteria. Come «attivo» nascerebbe `iscritto` nella classe VECCHIA e il 01/09 la ricopia non lo prenderebbe.
      const finestra = await finestraDiSede(supabase, scuolaId)
      if (finestra && finestra.attivo === riga.id) return { tipo: 'aperto', annoSedeId: riga.id, annoId: riga.anno_id }
      return { tipo: 'attivo', annoSedeId: riga.id, annoId: riga.anno_id }
    }
    if (riga.stato === 'iscrizioni_aperte') return { tipo: 'aperto', annoSedeId: riga.id, annoId: riga.anno_id }
    return { tipo: 'non-aperto' }
  } catch (err) {
    logErrore({ operazione: OP_ANNO }, err)
    return annoId === null ? { tipo: 'schema-indietro' } : { tipo: 'non-aperto' }
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 4.5.15 · togliere una conferma: la frequenza si ritira, la voce della quota si toglie solo se la contabilità lo permette
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Che cosa è successo alla voce della quota di una frequenza ritirata:
 *  · `tolta`         la voce c'era, nessuna guardia la tratteneva ed è stata eliminata (con la riga di audit);
 *  · `resta-pagata`  la voce c'è e ha incassi, fatture o una transazione: resta, rimborso e storno si fanno dalla contabilità;
 *  · `nessuna`       alla frequenza non era collegata nessuna voce;
 *  · `errore`        la voce non si è riusciti a togliere (guasto): la frequenza resta ritirata, un `warn` lo registra.
 */
export type EsitoQuotaRitiro = 'tolta' | 'resta-pagata' | 'nessuna' | 'errore'

export type RisultatoRitiro = {
  frequenza_id: string
  /** `false` se era già ritirata prima di questa chiamata (si è solo ripresa la voce, se c'era ancora). */
  ritirata: boolean
  quota: EsitoQuotaRitiro
}
export type EsitoRitiro = ({ ok: true } & RisultatoRitiro) | EsitoFallito

export type RitiroArgs = {
  /** La frequenza dell'anno NUOVO (non quella di partenza). */
  frequenzaId: string
  /** Chi la ritira: serve al contesto delle notifiche e all'audit. */
  attore: AppUser
}

const OP_RITIRO = 'anno/iscrizione-anno:ritiraConferma'
const OP_CHIUSURA = 'anno/iscrizione-anno:chiudiFrequenzeAperte'

type RigaDaChiudere = {
  id: string
  alunno_id: string
  anno_sede_id: string
  scuola_id: string
  stato: string
  origine: string | null
  quota_pagamento_id: string | null
}
/** Le origini che il «Ritira la conferma» accetta (4.5.16, B); `recupero` è la riga storica dell'anno in corso e non si ritira. */
const ORIGINI_RITIRABILI: readonly string[] = ['conferma', 'domanda', 'segreteria', 'import']
const COLONNE_CHIUSURA = 'id, alunno_id, anno_sede_id, scuola_id, stato, origine, quota_pagamento_id'

/**
 * La frequenza (viva) di un anno non ancora in corso passa a `ritirato` e la voce della sua quota si toglie, se si può.
 * Le guardie sono quelle dell'eliminazione di una voce (`controllaVoceEliminabile`): incassi, fatture, transazioni, coda delle
 * fatture. In più una voce già `pagato` o con `importo_pagato` > 0 resta comunque. Nessun rimborso automatico.
 * Niente stati a metà: se la voce non si toglie per un guasto, la frequenza RESTA ritirata e l'esito dice `errore`.
 */
async function ritiraEToglieQuota(
  supabase: SupabaseClient, f: RigaDaChiudere, attore: AppUser, operazione: string,
): Promise<EsitoRitiro> {
  let ritirata = false
  if (f.stato === 'in_attesa' || f.stato === 'iscritto') {
    const scritta = await scriviFrequenza(supabase, {
      alunnoId: f.alunno_id,
      annoSedeId: f.anno_sede_id,
      campi: { stato: STATO_RITIRATO, data_uscita: oggiRoma() },
      annoNonAttivo: true,
    })
    if (!scritta.ok) return { ok: false, codice: codiceAnnoDa(scritta.codice) ?? 'SCRITTURA_FALLITA' }
    if ('saltata' in scritta) {
      // Anno non scrivibile, schema indietro, riga sparita: la frequenza NON è stata ritirata, e si dice.
      logEvento('anno-scolastico', 'warn', { tipo: 'ritiro-conferma-non-scritto', operazione, entita_id: f.id })
      return { ok: false, codice: 'SCRITTURA_FALLITA' }
    }
    ritirata = true
  } else if (f.stato !== STATO_RITIRATO) {
    // trasferito / uscito: un'altra storia, che da qui non si tocca.
    return { ok: false, codice: 'FREQUENZA_NON_VIVA' }
  }

  const quota = await togliQuota(supabase, f, attore, operazione)
  logEvento('anno-scolastico', quota === 'errore' ? 'warn' : 'info', {
    tipo: 'conferma-ritirata',
    esito: quota,
    operazione,
    entita_id: f.id,
    utente: attore.id,
    ritirata,
  })
  return { ok: true, frequenza_id: f.id, ritirata, quota }
}

async function togliQuota(supabase: SupabaseClient, f: RigaDaChiudere, attore: AppUser, operazione: string): Promise<EsitoQuotaRitiro> {
  if (!f.quota_pagamento_id) return 'nessuna'
  const voceId = f.quota_pagamento_id
  try {
    const c = await controllaVoceEliminabile(supabase, voceId, { sedi: [f.scuola_id], perSostituzione: false, operazione })
    if (!c.ok) {
      if ('guasto' in c) return 'errore'
      // La voce non c'è più (404): niente da togliere. Ogni altro rifiuto è contabilità che la trattiene.
      return c.stato === 404 ? 'nessuna' : 'resta-pagata'
    }
    const pagata = c.voce.stato === 'pagato' || Number(c.voce.importo_pagato ?? 0) > 0
    if (pagata) return 'resta-pagata'
    // Una voce con i ticket di una ricarica non è una quota: non si tocca da qui.
    if (c.ticket > 0) return 'errore'

    const { error } = await supabase.from('pagamenti').delete().eq('id', voceId)
    if (error) {
      // Un incasso o una fattura arrivati fra la guardia e la DELETE: il freno del database rifiuta, la voce resta.
      logEvento('anno-scolastico', 'warn', { tipo: 'quota-ritiro-non-tolta', operazione, entita_id: voceId, error_code: error.code ?? undefined })
      return error.code === '23503' ? 'resta-pagata' : 'errore'
    }

    // La voce è già cancellata: da qui niente cambia l'esito. Ogni fallimento si dice, nessuno lo cambia.
    try {
      await ritiraPendingPagamento(supabase, {
        pagamentoId: voceId,
        alunnoId: (c.voce.alunno_id as string | null) ?? null,
        scuolaId: (c.voce.scuola_id as string | null) ?? null,
        operazione: politicaNotificaServizio(attore, String(c.voce.periodo_competenza ?? c.voce.scadenza ?? c.voce.creato_il ?? '')),
      })
    } catch (err) {
      logEvento('anno-scolastico', 'warn', { tipo: 'quota-ritiro-avviso-non-ritirato', operazione, entita_id: voceId }, err)
    }
    const audit = await supabase.from('registro_modifiche').insert({
      azione: 'elimina_pagamento',
      tabella_interessata: 'pagamenti',
      record_id: voceId,
      vecchio_valore: c.voce,
      nuovo_valore: { motivo: 'ritiro-conferma-anno', frequenza_id: f.id },
      utente_id: attore.id,
    })
    if (audit.error) {
      logEvento('anno-scolastico', 'error', { tipo: 'quota-ritiro-audit-non-scritto', operazione, entita_id: voceId, error_code: audit.error.code ?? undefined })
    }
    return 'tolta'
  } catch (err) {
    logErrore({ operazione }, err)
    return 'errore'
  }
}

/**
 * «Ritira la conferma»: la frequenza dell'anno nuovo passa a `ritirato`; la voce della quota si toglie se la contabilità lo
 * permette. Poi si può dire «Non rinnova» o rifare «Conferma» (stessa riga, vedi `anno_conferma`).
 * Vale per ogni frequenza dell'anno aperto di origine `conferma`, `domanda`, `segreteria` o `import` (4.5.16, B) PURCHÉ il bambino
 * abbia una frequenza VIVA nell'anno attivo: la schermata «Conferme» mostra anche i «Nuovi», e il bottone c'è sulla loro riga
 * solo quando il bambino frequenta. Chi non frequenta ancora (arriva l'anno prossimo) ha la sua iscrizione e basta: si toglie
 * archiviandolo dalla scheda, e `FREQUENZA_NON_DI_CONFERMA` lo dice (il codice resta quello di prima, il testo no).
 * Idempotente: su una già ritirata non riscrive niente e riprova solo a togliere la voce, se c'è ancora. Non lancia mai.
 */
export async function ritiraConferma(supabase: SupabaseClient, a: RitiroArgs): Promise<EsitoRitiro> {
  try {
    const riga = await supabase.from('frequenze').select(COLONNE_CHIUSURA).eq('id', a.frequenzaId).maybeSingle()
    if (riga.error) return esitoDaErrore(riga.error, OP_RITIRO, 'ritiro-conferma-non-letto')
    const f = riga.data as RigaDaChiudere | null
    if (!f) return { ok: false, codice: 'PARAMETRO_MANCANTE' }
    if (!ORIGINI_RITIRABILI.includes(f.origine ?? '')) return { ok: false, codice: 'FREQUENZA_NON_DI_CONFERMA' }

    const anno = await supabase.from('anni_sede').select('stato').eq('id', f.anno_sede_id).maybeSingle()
    if (anno.error) return esitoDaErrore(anno.error, OP_RITIRO, 'ritiro-conferma-non-letto')
    if ((anno.data as { stato?: string } | null)?.stato !== 'iscrizioni_aperte') return { ok: false, codice: 'ANNO_NON_APERTO' }

    // «Frequenta» si controlla per OGNI origine (4.5.17, C): una riga riaperta da una nuova domanda di chi era uscito conserva
    // `origine = 'conferma'` ma il bambino non frequenta, e ritirarla lascerebbe una scheda «in arrivo» senza arrivo.
    const lettura_fallita = (e: ErrorePg): EsitoFallito => {
      if (schemaAnnoIndietro(e)) return esitoDaErrore(e, OP_RITIRO, 'ritiro-conferma-non-letto')
      logEvento('anno-scolastico', 'warn', { tipo: 'ritiro-conferma-frequenza-non-letta', operazione: OP_RITIRO, error_code: e?.code ?? undefined })
      return { ok: false, codice: 'SCRITTURA_FALLITA' }
    }
    // Una domanda, un inserimento della segreteria, un import: si ritira da qui solo se il bambino FREQUENTA (frequenza viva
    // nell'anno attivo). Altrimenti arriva l'anno prossimo, e si toglie archiviandolo. Una lettura che fallisce NON è un «no».
    const attivo = await supabase.rpc('anno_attivo', { p_scuola: f.scuola_id })
    if (attivo.error) return lettura_fallita(attivo.error)
    const idAttivo = typeof attivo.data === 'string' ? attivo.data : null
    let frequenta = false
    if (idAttivo) {
      const viva = await supabase
        .from('frequenze')
        .select('id')
        .eq('alunno_id', f.alunno_id)
        .eq('anno_sede_id', idAttivo)
        .in('stato', ['in_attesa', 'iscritto'])
        .limit(1)
      if (viva.error) return lettura_fallita(viva.error)
      frequenta = ((viva.data ?? []) as unknown[]).length > 0
    }
    if (!frequenta) return { ok: false, codice: 'FREQUENZA_NON_DI_CONFERMA' }

    return await ritiraEToglieQuota(supabase, f, a.attore, OP_RITIRO)
  } catch (err) {
    logErrore({ operazione: OP_RITIRO }, err)
    return { ok: false, codice: 'SCRITTURA_FALLITA' }
  }
}

export type RisultatoChiusura = {
  /** Le frequenze di anni aperti che erano vive e ora sono ritirate. */
  chiuse: number
  /** Le voci di quota tolte. */
  voci_tolte: number
  /** Le voci rimaste perché pagate (o fatturate): la segreteria deve saperlo, rimborso e storno sono suoi. */
  voci_pagate_rimaste: number
  /**
   * (Riattiva, giro 11) Le voci di quota rimaste su frequenze GIÀ ritirate dell'anno che la scheda mostra (dopo il 01/09 sono della contabilità, non di «Riprova»).
   * La route lo dice alla segreteria invece di rispondere «riuscita» e basta.
   */
  voci_alla_contabilita: number
  /** Le frequenze per cui la chiusura o la voce non sono riuscite (guasto), più una per ogni lettura caduta (4.5.16, E): un log per ognuna. */
  non_riuscite: number
}

/**
 * Archiviare un bambino chiude, con la stessa regola del «Ritira la conferma», le frequenze VIVE degli anni NON in corso
 * (`in_preparazione`, `iscrizioni_aperte`): conferme, iscrizioni di una domanda, inserimenti della segreteria. Vale anche per
 * un bambino `in_arrivo`. Non lancia mai e non blocca l'archiviazione: ne riporta il conteggio.
 */
export async function chiudiFrequenzeAperte(
  supabase: SupabaseClient,
  a: { alunnoId: string; attore: AppUser; scuolaId?: string | null; ancheAnnoVisibile?: boolean },
): Promise<RisultatoChiusura> {
  const esito: RisultatoChiusura = { chiuse: 0, voci_tolte: 0, voci_pagate_rimaste: 0, voci_alla_contabilita: 0, non_riuscite: 0 }
  try {
    const anni = await supabase.from('anni_sede').select('id').in('stato', ['in_preparazione', 'iscrizioni_aperte'])
    if (anni.error) {
      // Una lettura caduta NON è «niente da chiudere» (4.5.16, E): conta come non riuscita, perché chi archivia lo deve sapere.
      // Lo schema indietro (la CI, un ambiente a metà) invece non ha niente da chiudere, e resta 0 senza guasti.
      if (!schemaAnnoIndietro(anni.error)) {
        logErrore({ operazione: OP_CHIUSURA }, new Error(`anni_sede:${anni.error.code ?? 'senza-codice'}`))
        esito.non_riuscite++
      }
      return esito
    }
    const idAnni = ((anni.data ?? []) as Array<{ id: string }>).map((x) => x.id)
    // (giro 3, NB2) Nella finestra fra la conferma del passaggio e l'inizio l'anno ATTIVO è il nuovo, `corrente` ma non ancora cominciato:
    // non è né «in preparazione» né «iscrizioni aperte», e la sua frequenza (nata dal passaggio o dalla segreteria) resterebbe viva dopo
    // l'archiviazione. Si chiude anche lei: quella dell'anno VISIBILE la chiude la scrittura della scheda, qui sotto nella route.
    // (Riattiva, giro 9, O-a) Una lettura della finestra CADUTA non è «fuori dalla finestra»: l'anno nuovo non entrerebbe e la route risponderebbe 200
    // pulito con l'iscrizione ancora viva. Conta come non riuscita (la segreteria vede «Riprova»), e le altre chiusure proseguono.
    const lettura = await leggiFinestraDiSede(supabase, a.scuolaId)
    if (lettura.guasto) esito.non_riuscite++
    const finestra = lettura.finestra
    if (finestra && !idAnni.includes(finestra.attivo)) idAnni.push(finestra.attivo)
    // (Riattiva, giro 10, S9-1) «Riprova» su una scheda GIÀ archiviata: dal 01/09 l'anno nuovo è `corrente` e non è più fra quelli letti qui sopra, ma una frequenza
    // ancora viva nell'anno che la scheda mostra è proprio ciò che «Riprova» deve chiudere. Solo per il ramo «già archiviato» della route.
    // Di quell'anno si chiude SOLO ciò che è ancora vivo: la voce di una frequenza già ritirata è della contabilità, non di «Riprova».
    let annoSoloVive: string | null = null
    if (a.ancheAnnoVisibile && a.scuolaId) {
      const visibile = await annoVisibileDiSede(supabase, a.scuolaId)
      if (visibile && !idAnni.includes(visibile)) { idAnni.push(visibile); annoSoloVive = visibile }
    }
    if (idAnni.length === 0) return esito

    const righe = await supabase
      .from('frequenze')
      .select(COLONNE_CHIUSURA)
      .eq('alunno_id', a.alunnoId)
      .in('anno_sede_id', idAnni)
      .in('stato', ['in_attesa', 'iscritto', STATO_RITIRATO])
    if (righe.error) {
      if (!schemaAnnoIndietro(righe.error)) {
        logErrore({ operazione: OP_CHIUSURA }, new Error(`frequenze:${righe.error.code ?? 'senza-codice'}`))
        esito.non_riuscite++
      }
      return esito
    }
    for (const f of (righe.data ?? []) as RigaDaChiudere[]) {
      // Una già ritirata con la voce ancora lì (un ritiro finito a metà): si riprende la voce. Senza voce, niente da fare.
      if (f.stato === STATO_RITIRATO && !f.quota_pagamento_id) continue
      if (f.stato === STATO_RITIRATO && f.anno_sede_id === annoSoloVive) { esito.voci_alla_contabilita++; continue }
      const r = await ritiraEToglieQuota(supabase, f, a.attore, OP_CHIUSURA)
      if (!r.ok || 'saltata' in r) { esito.non_riuscite++; continue }
      if (r.ritirata) esito.chiuse++
      if (r.quota === 'tolta') esito.voci_tolte++
      else if (r.quota === 'resta-pagata') esito.voci_pagate_rimaste++
      else if (r.quota === 'errore') esito.non_riuscite++
    }
    return esito
  } catch (err) {
    logErrore({ operazione: OP_CHIUSURA }, err)
    return { ...esito, non_riuscite: esito.non_riuscite + 1 }
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 4.5.15 (I3) · riattivare è il contrario di archiviare
// ─────────────────────────────────────────────────────────────────────────────────────────────

const OP_RIPRISTINO = 'anno/iscrizione-anno:iscrizioniDelBambino'
const OP_FINESTRA = 'anno/iscrizione-anno:riattivaNellaFinestra'
const STATI_FREQUENZA_CHIUSI: readonly string[] = [STATO_RITIRATO, 'trasferito', 'uscito']

/** Una frequenza di un anno che viene (in preparazione o con le iscrizioni aperte) di un bambino. */
export type FrequenzaDellAnnoCheViene = {
  id: string
  anno_sede_id: string
  stato: string
  tipo: 'conferma' | 'nuova' | null
  origine: string | null
  /** Chiusa (ritirata, trasferita, uscita): da riaprire. */
  chiusa: boolean
}

export type IscrizioniDelBambino =
  | { ok: true; haFrequenzaAttiva: boolean; prossime: FrequenzaDellAnnoCheViene[] }
  | { ok: false }

type RigaAttiva = { id: string; stato: string; data_uscita: string | null }

/**
 * Una riga dell'anno attivo conta come «ha la frequenza attiva» tranne una chiusa PRIMA dell'archiviazione (4.5.16, C): se la
 * `data_uscita` è precedente al giorno di Roma di `archiviatoIl`, quel bambino non frequentava più quando è stato archiviato (è
 * un ex alunno tornato `in_arrivo` e riarchiviato), e a riattivarlo deve tornare `in_arrivo`, non `iscritto`.
 * Con `data_uscita` NULL, con la stessa data o senza `archiviatoIl` la riga conta, come prima.
 * LIMITE NOTO: un bambino archiviato, tornato e riarchiviato NELLO STESSO giorno ha una `data_uscita` uguale al giorno
 * dell'archiviazione, e la sua riga conta come attiva: la distinzione non si può fare con le sole date.
 */
function contaComeFrequenzaAttiva(righe: RigaAttiva[], archiviatoIl: string | null): boolean {
  const giornoArchiviazione = archiviatoIl ? dataCivile(new Date(archiviatoIl)) : null
  return righe.some((r) => {
    if (!STATI_FREQUENZA_CHIUSI.includes(r.stato)) return true
    if (!giornoArchiviazione || !r.data_uscita) return true
    return r.data_uscita >= giornoArchiviazione
  })
}

/**
 * Che cosa ha il bambino nell'anno attivo e negli anni che vengono. Serve a «Riporta fra gli iscritti»: chi NON ha la
 * frequenza dell'anno attivo e ne ha una in un anno che viene (viva o chiusa dall'archiviazione) è un bambino «in arrivo», e
 * torna `in_arrivo` con la sua iscrizione riaperta; chi l'ha torna `iscritto` e la conferma dell'anno dopo, se la segreteria
 * vuole, si rifà. NON LANCIA MAI: `{ ok: false }` = non so (un `warn` col solo codice), e il chiamante si ferma.
 * `annoAttivoId` assente (la sede non ha un anno attivo) conta come «ha la frequenza attiva»: non c'è un ritorno da inventare.
 */
export async function iscrizioniDelBambino(
  supabase: SupabaseClient,
  a: { alunnoId: string; annoAttivoId: string | null; archiviatoIl?: string | null },
): Promise<IscrizioniDelBambino> {
  try {
    if (!a.annoAttivoId) return { ok: true, haFrequenzaAttiva: true, prossime: [] }
    const attiva = await supabase.from('frequenze').select('id, stato, data_uscita').eq('alunno_id', a.alunnoId).eq('anno_sede_id', a.annoAttivoId)
    if (attiva.error) {
      // schema indietro (la CI): nessun anno, nessun ritorno da inventare
      if (schemaAnnoIndietro(attiva.error)) return { ok: true, haFrequenzaAttiva: true, prossime: [] }
      logEvento('anno-scolastico', 'warn', { tipo: 'iscrizioni-bambino-non-lette', operazione: OP_RIPRISTINO, error_code: attiva.error.code ?? undefined })
      return { ok: false }
    }
    const anni = await supabase.from('anni_sede').select('id').in('stato', ['in_preparazione', 'iscrizioni_aperte'])
    if (anni.error) {
      logEvento('anno-scolastico', 'warn', { tipo: 'iscrizioni-bambino-non-lette', operazione: OP_RIPRISTINO, error_code: anni.error.code ?? undefined })
      return { ok: false }
    }
    const idAnni = ((anni.data ?? []) as Array<{ id: string }>).map((x) => x.id)
    let prossime: FrequenzaDellAnnoCheViene[] = []
    if (idAnni.length > 0) {
      const righe = await supabase
        .from('frequenze')
        .select('id, anno_sede_id, stato, tipo, origine')
        .eq('alunno_id', a.alunnoId)
        .in('anno_sede_id', idAnni)
      if (righe.error) {
        logEvento('anno-scolastico', 'warn', { tipo: 'iscrizioni-bambino-non-lette', operazione: OP_RIPRISTINO, error_code: righe.error.code ?? undefined })
        return { ok: false }
      }
      prossime = ((righe.data ?? []) as Array<Omit<FrequenzaDellAnnoCheViene, 'chiusa'>>)
        .filter((f) => f.origine !== 'recupero')
        .map((f) => ({ ...f, chiusa: STATI_FREQUENZA_CHIUSI.includes(f.stato) }))
    }
    return { ok: true, haFrequenzaAttiva: contaComeFrequenzaAttiva((attiva.data ?? []) as RigaAttiva[], a.archiviatoIl ?? null), prossime }
  } catch (err) {
    logErrore({ operazione: OP_RIPRISTINO }, err)
    return { ok: false }
  }
}

export type EsitoIscrizioneProssima = { ok: true; ha: boolean } | { ok: false }

/**
 * Il bambino ha una frequenza VIVA (`in_attesa`, `iscritto`) in un anno che viene (in preparazione o con le iscrizioni aperte)?
 * Serve all'eliminazione definitiva (4.5.16, D): chi ha un'iscrizione per l'anno prossimo non si elimina prima di averlo
 * archiviato, anche se la sua scheda dice `ritirato` (la tendina non archivia). NON LANCIA MAI: `{ ok: false }` = non so, e chi
 * chiama RIFIUTA (una lettura caduta non è «niente iscrizione»). Schema indietro (la CI) = nessun anno, quindi `ha: false`.
 */
export async function haIscrizioneVivaProssima(supabase: SupabaseClient, alunnoId: string): Promise<EsitoIscrizioneProssima> {
  try {
    const anni = await supabase.from('anni_sede').select('id').in('stato', ['in_preparazione', 'iscrizioni_aperte'])
    if (anni.error) {
      if (schemaAnnoIndietro(anni.error)) return { ok: true, ha: false }
      logEvento('anno-scolastico', 'warn', { tipo: 'iscrizione-prossima-non-letta', operazione: OP_RIPRISTINO, error_code: anni.error.code ?? undefined })
      return { ok: false }
    }
    const idAnni = ((anni.data ?? []) as Array<{ id: string }>).map((x) => x.id)
    if (idAnni.length === 0) return { ok: true, ha: false }
    const righe = await supabase
      .from('frequenze')
      .select('id')
      .eq('alunno_id', alunnoId)
      .in('anno_sede_id', idAnni)
      .in('stato', ['in_attesa', 'iscritto'])
      .limit(1)
    if (righe.error) {
      if (schemaAnnoIndietro(righe.error)) return { ok: true, ha: false }
      logEvento('anno-scolastico', 'warn', { tipo: 'iscrizione-prossima-non-letta', operazione: OP_RIPRISTINO, error_code: righe.error.code ?? undefined })
      return { ok: false }
    }
    return { ok: true, ha: ((righe.data ?? []) as unknown[]).length > 0 }
  } catch (err) {
    logErrore({ operazione: OP_RIPRISTINO }, err)
    return { ok: false }
  }
}

export type EsitoRiapertura =
  | { ok: true; riaperta: boolean }
  | { ok: false; codice: CodiceIscrizione }

/**
 * PRIMO PASSO del ritorno di un bambino «in arrivo»: la frequenza di un anno che viene, chiusa dall'archiviazione, torna `in_attesa`
 * (senza uscita; il trigger la porta a `iscritto` se moduli e quota sono a posto). Una frequenza già viva (una riattivazione
 * finita a metà) non si tocca. NON LANCIA MAI. La voce della quota NON nasce qui: `anno_quota_voce` non ne crea una per una scheda
 * archiviata, e a questo punto la scheda lo è ancora. Dopo aver scritto la scheda si chiama `ricreaQuotaProssima`.
 */
export async function riapriFrequenzaProssima(
  supabase: SupabaseClient,
  a: { alunnoId: string; frequenza: FrequenzaDellAnnoCheViene },
): Promise<EsitoRiapertura> {
  try {
    const f = a.frequenza
    if (!f.chiusa) return { ok: true, riaperta: false }
    const r = await scriviFrequenza(supabase, {
      alunnoId: a.alunnoId, annoSedeId: f.anno_sede_id, campi: { stato: STATO_ISCRITTO, data_uscita: null }, annoNonAttivo: true,
    })
    if (!r.ok) return { ok: false, codice: r.codice as CodiceIscrizione }
    if ('saltata' in r) return { ok: false, codice: 'SCRITTURA_FALLITA' }
    return { ok: true, riaperta: true }
  } catch (err) {
    logErrore({ operazione: OP_RIPRISTINO }, err)
    return { ok: false, codice: 'SCRITTURA_FALLITA' }
  }
}

export type EsitoFrequenzeDellaFinestra =
  | { ok: true; nellaFinestra: false }
  | {
      ok: true
      nellaFinestra: true
      annoVisibileId: string
      /** La frequenza dell'anno che si vede è `ritirato` e l'ha chiusa QUESTA archiviazione (la data d'uscita è il giorno dell'archiviazione). */
      visibileChiusaDallArchiviazione: boolean
      /** La frequenza dell'anno nuovo (non `recupero`) che QUESTA archiviazione ha chiuso, se c'era. */
      nuovaChiusaDallArchiviazione: (FrequenzaDellAnnoCheViene & { section_id: string | null }) | null
      /** L'anno che si vede ha una frequenza VIVA (`in_attesa`, `iscritto`): il bambino non è «in arrivo». */
      visibileViva: boolean
      /** La frequenza dell'anno nuovo (non `recupero`) ancora VIVA, se c'è: il bambino è «in arrivo» con la sua iscrizione già aperta. */
      nuovaViva: (FrequenzaDellAnnoCheViene & { section_id: string | null }) | null
    }
  | { ok: false }

/** Una `ritirato` è «chiusa da questa archiviazione» se la sua uscita non è PRECEDENTE al giorno dell'archiviazione (stessa regola di `contaComeFrequenzaAttiva`, 4.5.16 C). */
function chiusaDaQuestaArchiviazione(r: { stato: string; data_uscita: string | null }, giorno: string | null): boolean {
  if (r.stato !== STATO_RITIRATO) return false
  // Senza `archiviato_il` (il solo ritiro dalla tendina) non c'è nessuna archiviazione da disfare: niente si riapre.
  if (!giorno) return false
  if (!r.data_uscita) return true
  return r.data_uscita >= giorno
}

/**
 * (chiusura 4.8, «Riattiva» nella finestra) Fra la conferma del passaggio e l'inizio l'anno attivo è il NUOVO e l'anno che si vede è il
 * vecchio. L'archiviazione di quei giorni chiude le frequenze vive di TUTTI E DUE (NB2): «Riattiva» disfa esattamente quella, cioè riapre
 * SOLO le frequenze che quell'archiviazione ha chiuso (`ritirato` con la data d'uscita del giorno dell'archiviazione), e le riapre con la
 * classe che avevano. Una `ritirato` chiusa prima (l'ex alunno tornato «in arrivo»), una `uscito` o `trasferito` (le uscite del passaggio:
 * la strada è la «Conferma tardiva») non sono dell'archiviazione e non si toccano. Fuori dalla finestra non cambia niente.
 * NON LANCIA MAI: `{ ok: false }` = non so.
 */
export async function frequenzeDellaFinestra(
  supabase: SupabaseClient,
  a: { alunnoId: string; scuolaId: string | null; archiviatoIl: string | null },
): Promise<EsitoFrequenzeDellaFinestra> {
  try {
    // Le due letture si fanno QUI e non con `finestraDiSede`, che in dubbio risponde `null` («non sono nella finestra»): per questa riattivazione
    // un guasto non è «fuori dalla finestra», perché si scriverebbe sull'anno sbagliato. Guasto → `ok: false` e la route si ferma senza scrivere.
    if (!a.scuolaId) return { ok: true, nellaFinestra: false }
    // Una dopo l'altra: se la prima manca (schema indietro) la seconda non parte.
    const att = await supabase.rpc('anno_attivo', { p_scuola: a.scuolaId })
    const vis = att.error ? { data: null, error: null } : await supabase.rpc('anno_visibile_oggi', { p_scuola: a.scuolaId })
    const guasto = att.error ?? vis.error
    if (guasto) {
      if (schemaAnnoIndietro(guasto)) return { ok: true, nellaFinestra: false }
      logEvento('anno-scolastico', 'warn', { tipo: 'finestra-non-letta', operazione: OP_FINESTRA, error_code: guasto.code ?? undefined })
      return { ok: false }
    }
    if (typeof att.data !== 'string' || typeof vis.data !== 'string' || att.data === vis.data) return { ok: true, nellaFinestra: false }
    const finestra = { attivo: att.data, visibile: vis.data }
    const giorno = a.archiviatoIl ? dataCivile(new Date(a.archiviatoIl)) : null
    const vecchie = await supabase.from('frequenze').select('stato, data_uscita').eq('alunno_id', a.alunnoId).eq('anno_sede_id', finestra.visibile)
    if (vecchie.error) {
      if (schemaAnnoIndietro(vecchie.error)) return { ok: true, nellaFinestra: false }
      logEvento('anno-scolastico', 'warn', { tipo: 'finestra-frequenze-non-lette', operazione: OP_FINESTRA, error_code: vecchie.error.code ?? undefined })
      return { ok: false }
    }
    const nuove = await supabase
      .from('frequenze')
      .select('id, anno_sede_id, stato, tipo, origine, data_uscita, section_id')
      .eq('alunno_id', a.alunnoId)
      .eq('anno_sede_id', finestra.attivo)
    if (nuove.error) {
      logEvento('anno-scolastico', 'warn', { tipo: 'finestra-frequenze-non-lette', operazione: OP_FINESTRA, error_code: nuove.error.code ?? undefined })
      return { ok: false }
    }
    const righeVecchie = (vecchie.data ?? []) as Array<{ stato: string; data_uscita: string | null }>
    const visibileChiusa = righeVecchie.some((r) => chiusaDaQuestaArchiviazione(r, giorno))
    const righeNuove = ((nuove.data ?? []) as Array<Omit<FrequenzaDellAnnoCheViene, 'chiusa'> & { data_uscita: string | null; section_id: string | null }>)
      .filter((f) => f.origine !== 'recupero')
    const chiusaNuova = righeNuove.filter((f) => chiusaDaQuestaArchiviazione(f, giorno))[0]
    const vivaNuova = righeNuove.filter((f) => !STATI_FREQUENZA_CHIUSI.includes(f.stato))[0]
    return {
      ok: true,
      nellaFinestra: true,
      annoVisibileId: finestra.visibile,
      visibileChiusaDallArchiviazione: visibileChiusa,
      nuovaChiusaDallArchiviazione: chiusaNuova
        ? { id: chiusaNuova.id, anno_sede_id: chiusaNuova.anno_sede_id, stato: chiusaNuova.stato, tipo: chiusaNuova.tipo, origine: chiusaNuova.origine, chiusa: true, section_id: chiusaNuova.section_id }
        : null,
      visibileViva: righeVecchie.some((r) => !STATI_FREQUENZA_CHIUSI.includes(r.stato)),
      nuovaViva: vivaNuova
        ? { id: vivaNuova.id, anno_sede_id: vivaNuova.anno_sede_id, stato: vivaNuova.stato, tipo: vivaNuova.tipo, origine: vivaNuova.origine, chiusa: false, section_id: vivaNuova.section_id }
        : null,
    }
  } catch (err) {
    logErrore({ operazione: OP_FINESTRA }, err)
    return { ok: false }
  }
}

/**
 * (chiusura 4.8, quarto giro, k) Il NOME della classe ricordata si cerca solo dentro lo stesso anno in cui la classe stava: le classi «N anni» si
 * chiamano uguale in anni diversi, e un nome cercato nell'anno sbagliato trova un'altra classe in silenzio. Vero se la classe `sectionId` appartiene
 * allo stesso anno scolastico di `annoSedeId` (l'anno su cui si scrive). Senza `sectionId` (un'archiviazione di prima che non lo ricordava) o con una
 * classe che non c'è più non c'è modo di verificare: vero, come è sempre stato. NON LANCIA MAI; `{ ok: false }` = non so, e la route si ferma.
 */
export async function classeRicordataDelloStessoAnno(
  supabase: SupabaseClient,
  a: { sectionId: string | null; annoSedeId: string | null },
): Promise<{ ok: true; stesso: boolean } | { ok: false }> {
  try {
    if (!a.sectionId || !a.annoSedeId) return { ok: true, stesso: true }
    const sez = await supabase.from('sections').select('anno_id').eq('id', a.sectionId)
    if (sez.error) {
      logEvento('anno-scolastico', 'warn', { tipo: 'anno-classe-ricordata-non-letto', operazione: OP_FINESTRA, error_code: sez.error.code ?? undefined })
      return { ok: false }
    }
    const annoClasse = ((sez.data ?? []) as Array<{ anno_id: string | null }>)[0]?.anno_id ?? null
    if (!annoClasse) return { ok: true, stesso: true }
    const anno = await supabase.from('anni_sede').select('anno_id').eq('id', a.annoSedeId)
    if (anno.error) {
      logEvento('anno-scolastico', 'warn', { tipo: 'anno-classe-ricordata-non-letto', operazione: OP_FINESTRA, error_code: anno.error.code ?? undefined })
      return { ok: false }
    }
    const annoScrittura = ((anno.data ?? []) as Array<{ anno_id: string | null }>)[0]?.anno_id ?? null
    if (!annoScrittura) return { ok: true, stesso: true }
    return { ok: true, stesso: annoClasse === annoScrittura }
  } catch (err) {
    logErrore({ operazione: OP_FINESTRA }, err)
    return { ok: false }
  }
}

/**
 * (chiusura 4.8, quinto giro) La scheda è ANCORA archiviata dal passaggio? Sì se il passaggio confermato dell'anno attivo ha chiuso la frequenza `uscito` di
 * questo bambino e `archiviato_il` è del passaggio (la funzione SQL `anno_alunno_archiviato_dal_passaggio` lo decide: non più tardi della conferma, o
 * a mezzogiorno dell'uscita). Chi è uscito col passaggio, poi è tornato con una domanda e infine è stato archiviato dalla segreteria NON è «archiviato
 * dal passaggio»: la sua archiviazione è dopo la conferma, e «Riattiva» la disfa. Vale nella finestra e dopo il 01/09. La route non legge nessuna
 * `passaggi_anno*` (la porta è una sola): chiede alla funzione. NON LANCIA MAI; `{ ok: false }` = non so, e chi chiama si ferma prima di scrivere.
 */
export async function archiviatoDalPassaggio(
  supabase: SupabaseClient,
  a: { alunnoId: string; annoAttivoId: string | null },
): Promise<{ ok: true; si: boolean } | { ok: false }> {
  try {
    if (!a.annoAttivoId) return { ok: true, si: false }
    const r = await supabase.rpc('anno_alunno_archiviato_dal_passaggio', { p_alunno: a.alunnoId, p_anno_sede: a.annoAttivoId })
    if (r.error) {
      if (schemaAnnoIndietro(r.error)) return { ok: true, si: false }
      logEvento('anno-scolastico', 'warn', { tipo: 'uscita-passaggio-non-letta', operazione: OP_FINESTRA, error_code: r.error.code ?? undefined })
      return { ok: false }
    }
    return { ok: true, si: r.data === true }
  } catch (err) {
    logErrore({ operazione: OP_FINESTRA }, err)
    return { ok: false }
  }
}

/**
 * La frequenza dell'anno NUOVO che l'archiviazione ha chiuso (già letta da `frequenzeDellaFinestra`) torna viva, con la classe che ha ancora:
 * l'archiviazione nella finestra le lascia la sua classe (la scheda archiviata non la porta, lo garantisce `alunni_riallinea_da_frequenze`).
 * Nessun nome di classe cercato, nessuna riga del passaggio letta. NON LANCIA MAI; `{ ok: false }` = non riaperta (e il guasto è nel log).
 */
export async function riapriFrequenzaNuovaDellaFinestra(
  supabase: SupabaseClient,
  a: { alunnoId: string; frequenza: FrequenzaDellAnnoCheViene & { section_id: string | null } },
): Promise<{ ok: true; senzaClasse: boolean } | { ok: false }> {
  try {
    const r = await scriviFrequenza(supabase, {
      alunnoId: a.alunnoId, annoSedeId: a.frequenza.anno_sede_id, campi: { stato: STATO_ISCRITTO, data_uscita: null }, annoNonAttivo: true,
    })
    if (!r.ok || 'saltata' in r) {
      logEvento('anno-scolastico', 'error', { tipo: 'finestra-frequenza-nuova-non-riaperta', operazione: OP_FINESTRA, frequenza: a.frequenza.id })
      return { ok: false }
    }
    return { ok: true, senzaClasse: a.frequenza.section_id === null }
  } catch (err) {
    logErrore({ operazione: OP_FINESTRA }, err)
    return { ok: false }
  }
}

/**
 * (chiusura 4.8, terzo giro) FUORI dalla finestra: la frequenza dell'anno attivo che l'archiviazione ha chiuso, se tiene ancora la sua classe
 * (dalla finestra in poi la tiene), dà il NOME di quella classe. «Riattiva» scrive con quello, risolto nello stesso anno in cui la sezione sta: non
 * cerca per nome nell'anno nuovo una classe che potrebbe essere un'altra con lo stesso nome (le classi «N anni»). Senza una frequenza così
 * (archiviato fuori dalla finestra: la frequenza ha perso la classe) `nome: null` e resta il ripiego di sempre, il nome ricordato.
 * NON LANCIA MAI; `{ ok: false }` = non so, e chi chiama si ferma prima di scrivere.
 */
export async function classeDellaFrequenzaChiusa(
  supabase: SupabaseClient,
  a: { alunnoId: string; annoSedeId: string; archiviatoIl: string | null },
): Promise<{ ok: true; nome: string | null } | { ok: false }> {
  try {
    const giorno = a.archiviatoIl ? dataCivile(new Date(a.archiviatoIl)) : null
    const righe = await supabase.from('frequenze').select('section_id, stato, data_uscita').eq('alunno_id', a.alunnoId).eq('anno_sede_id', a.annoSedeId)
    if (righe.error) {
      if (schemaAnnoIndietro(righe.error)) return { ok: true, nome: null }
      logEvento('anno-scolastico', 'warn', { tipo: 'classe-frequenza-chiusa-non-letta', operazione: OP_FINESTRA, error_code: righe.error.code ?? undefined })
      return { ok: false }
    }
    const chiusa = ((righe.data ?? []) as Array<{ section_id: string | null; stato: string; data_uscita: string | null }>)
      .find((r) => r.section_id !== null && chiusaDaQuestaArchiviazione(r, giorno))
    if (!chiusa?.section_id) return { ok: true, nome: null }
    const sezione = await supabase.from('sections').select('name').eq('id', chiusa.section_id)
    if (sezione.error) {
      logEvento('anno-scolastico', 'warn', { tipo: 'classe-frequenza-chiusa-non-letta', operazione: OP_FINESTRA, error_code: sezione.error.code ?? undefined })
      return { ok: false }
    }
    const nome = ((sezione.data ?? []) as Array<{ name: string | null }>)[0]?.name ?? null
    return { ok: true, nome: nome && nome.trim() !== '' ? nome : null }
  } catch (err) {
    logErrore({ operazione: OP_FINESTRA }, err)
    return { ok: false }
  }
}

/**
 * (Riattiva, giro 10, R10-c) La classe della frequenza VIVA di un anno: la riprova di una «Riattiva» rimasta a metà, dopo il 01/09, trova la frequenza già
 * riaperta con la sua classe e la scheda no. La scheda deve seguire la frequenza, come fa lo specchio. `nome: null` = nessuna frequenza viva con una classe.
 */
export async function classeDellaFrequenzaViva(
  supabase: SupabaseClient,
  a: { alunnoId: string; annoSedeId: string },
): Promise<{ ok: true; nome: string | null } | { ok: false }> {
  try {
    const righe = await supabase.from('frequenze').select('section_id, stato').eq('alunno_id', a.alunnoId).eq('anno_sede_id', a.annoSedeId).in('stato', ['in_attesa', 'iscritto'])
    if (righe.error) {
      if (schemaAnnoIndietro(righe.error)) return { ok: true, nome: null }
      logEvento('anno-scolastico', 'warn', { tipo: 'classe-frequenza-viva-non-letta', operazione: OP_FINESTRA, error_code: righe.error.code ?? undefined })
      return { ok: false }
    }
    const viva = ((righe.data ?? []) as Array<{ section_id: string | null }>).find((r) => r.section_id !== null)
    if (!viva?.section_id) return { ok: true, nome: null }
    const sezione = await supabase.from('sections').select('name').eq('id', viva.section_id)
    if (sezione.error) {
      logEvento('anno-scolastico', 'warn', { tipo: 'classe-frequenza-viva-non-letta', operazione: OP_FINESTRA, error_code: sezione.error.code ?? undefined })
      return { ok: false }
    }
    const nome = ((sezione.data ?? []) as Array<{ name: string | null }>)[0]?.name ?? null
    return { ok: true, nome: nome && nome.trim() !== '' ? nome : null }
  } catch (err) {
    logErrore({ operazione: OP_FINESTRA }, err)
    return { ok: false }
  }
}

/**
 * SECONDO PASSO: la voce della quota rinasce (idempotente: se c'è già la riprende, `gia_collegata`). Non blocca il ritorno: il
 * bambino è già `in_arrivo` con la sua iscrizione, e una voce che non nasce (l'anno non ha le iscrizioni aperte, nessun listino)
 * si genera dalla pagina delle conferme. Torna l'esito della voce, `null` se la registrazione non è riuscita (il guasto è nel log).
 */
export async function ricreaQuotaProssima(
  supabase: SupabaseClient,
  a: { alunnoId: string; frequenza: FrequenzaDellAnnoCheViene; attoreId?: string | null },
): Promise<QuotaEsito | null> {
  const r = await generaQuotaProssima(supabase, a)
  return r ? r.quota : null
}

/**
 * Come `ricreaQuotaProssima`, ma riporta anche l'uuid della voce (la route «Genera la quota» delle Conferme lo risponde, 4.5.16 F).
 * Chi chiama verifica PRIMA che la frequenza sia viva: da 4.5.16 `anno_registra_frequenza` su una frequenza ritirata la RIAPRE.
 * NON LANCIA MAI; `null` = non riuscita (il guasto è nel log) o nessuna voce toccata.
 */
export async function generaQuotaProssima(
  supabase: SupabaseClient,
  a: { alunnoId: string; frequenza: FrequenzaDellAnnoCheViene; attoreId?: string | null },
): Promise<{ quota: QuotaEsito; pagamento_id: string | null } | null> {
  try {
    const f = a.frequenza
    const tipo = f.tipo === 'conferma' ? 'conferma' : 'nuova'
    const origine = (['domanda', 'conferma', 'segreteria', 'import'] as const).find((o) => o === f.origine) ?? 'segreteria'
    const q = await registraFrequenzaPerAnno(supabase, { alunnoId: a.alunnoId, annoSedeId: f.anno_sede_id, tipo, origine, da: a.attoreId ?? null })
    if (!q.ok || 'saltata' in q || !q.quota) return null
    return { quota: q.quota, pagamento_id: q.pagamento_id ?? null }
  } catch (err) {
    logErrore({ operazione: OP_RIPRISTINO }, err)
    return null
  }
}
