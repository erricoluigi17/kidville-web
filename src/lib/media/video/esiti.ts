import type { SupabaseClient } from '@supabase/supabase-js'

import it from '../../../../messages/it/shared.json'
import { aBlocchi, ID_PER_QUERY } from '@/lib/db/blocchi'
import { logEvento } from '@/lib/logging/logger'
import { staffScuola } from '@/lib/notifiche/destinatari'
import { notificaEvento } from '@/lib/notifiche/triggers'

import {
  CHIAVI_MESSAGGIO_VIDEO,
  codiceMessaggioVideo,
  codiceMostrabileDelJob,
  type CodiceMostratoVideo,
} from './contratto'
import { codiceDi, schemaAssente, type EsitoRpc } from './outbox/rpc'

/**
 * GLI ESITI DI UN VIDEO DI GALLERIA — la marca «una volta sola», i testi che l'insegnante e la
 * segreteria leggono, e la scansione dei video la cui conversione è fallita.
 *
 * ─── PERCHÉ QUESTO MODULO E NON UN PEZZO DEL PUBBLICATORE ───────────────────────────────────
 *
 * Gli esiti hanno DUE produttori che non si conoscono fra loro: il pubblicatore
 * (`@/lib/gallery/pubblicazione-video-automatica`: «pubblicato», «non pubblicato», «la pubblicazione
 * non è riuscita») e la scansione qui sotto (la conversione è fallita, e nessun evento dell'outbox
 * lo dice: `video_job_fail` non ne accoda nessuno). Se i testi e la regola «una notifica, una
 * volta» stessero in uno solo dei due, l'altro ne scriverebbe una copia, e due copie della stessa
 * frase divergono il giorno in cui se ne corregge una. Qui c'è una copia sola, e la usano entrambi.
 *
 * ─── UNA MARCA SOLA, E CHI MANDA LE NOTIFICHE È CHI LA VINCE ────────────────────────────────
 *
 * `video_intent_esito_segna` scrive `esito_notificato` con un `UPDATE … WHERE esito_notificato IS
 * NULL` dentro il lock dell'intento: `segnato` è vero UNA SOLA VOLTA per intento. Le notifiche
 * partono SOLO per chi riceve `segnato: true` (spec §8.4). Così un processo che muore fra la RPC
 * di pubblicazione e le notifiche le recupera al giro dopo (la marca è ancora libera), e nessuna
 * notifica parte due volte, nemmeno quando la scansione della retention e quella del runner si
 * incrociano sullo stesso intento.
 *
 * ⚠️ Il prezzo, dichiarato: se la marca è scritta e il processo muore PRIMA di accodare le
 * notifiche, quelle notifiche non partono più. Il contenuto è comunque in galleria (o l'errore è
 * comunque nell'elenco dell'insegnante, che lo mostra come «non pubblicato»): si perde l'avviso,
 * non il dato, ed è il verso giusto in cui sbagliare — l'alternativa è una notifica doppia.
 *
 * ─── COSA NON ENTRA MAI NEI TESTI E NEI LOG ─────────────────────────────────────────────────
 *
 * Né i nomi dei bambini, né quelli dei file, né i loro identificativi: i testi che dipendono da una
 * quantità ricevono un NUMERO, mai l'elenco. I log portano uuid dell'intento, conteggi e codici.
 * Il corpo di una conversione fallita è la frase del catalogo (`messages/it/shared.json`), la
 * STESSA che legge l'insegnante a schermo: una frase sola per lo stesso fatto.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * I TESTI (italiano: il corpo di una notifica persistita non si traduce, vedi `tipi.ts`)
 * ──────────────────────────────────────────────────────────────────────────── */

export const TITOLO_VIDEO_PUBBLICATO = 'Video pubblicato'
export const TITOLO_VIDEO_NON_PUBBLICATO = 'Video non pubblicato'
export const TITOLO_AVVISO_LIBERATORIA = 'Video pubblicato senza liberatoria'

export const CORPO_VIDEO_PUBBLICATO = 'Il tuo video è stato pubblicato in galleria.'
export const CORPO_VIDEO_NESSUN_DESTINATARIO =
  'Il video non è stato pubblicato: nessuno dei bambini scelti è ancora nella sede.'
export const CORPO_VIDEO_PUBBLICAZIONE_NON_RIUSCITA =
  'Non siamo riusciti a pubblicare il video: apri la galleria e premi «Riprova».'

/** Dove porta la notifica a chi ha caricato da un'area docente, e dove a chi lavora in segreteria. */
export const LINK_GALLERIA_DOCENTE = '/teacher/gallery'
export const LINK_GALLERIA_SEGRETERIA = '/admin/gallery'

/** Chi, oltre a chi ha caricato, riceve l'avviso di un video pubblicato senza liberatoria (§7). */
export const RUOLI_AVVISO_LIBERATORIA = ['admin', 'coordinator', 'segreteria'] as const

/** «Pubblicato senza N bambini»: il numero di chi non è più nella sede, mai i nomi. */
export function corpoPubblicatoSenzaBambini(nUsciti: number): string {
  return nUsciti === 1
    ? `${CORPO_VIDEO_PUBBLICATO} 1 bambino non è più nella sede e non lo vedrà.`
    : `${CORPO_VIDEO_PUBBLICATO} ${nUsciti} bambini non sono più nella sede e non lo vedranno.`
}

/** L'avviso di sicurezza: SOLO il numero di bambini rimasti senza liberatoria. */
export function corpoAvvisoLiberatoria(nSenzaLiberatoria: number): string {
  return nSenzaLiberatoria === 1
    ? 'Un video è stato pubblicato in galleria con 1 bambino senza liberatoria fotografica.'
    : `Un video è stato pubblicato in galleria con ${nSenzaLiberatoria} bambini senza liberatoria fotografica.`
}

const CATALOGO_IT = it as Record<string, string>

/**
 * I codici mostrabili per cui la frase del catalogo ha qualcosa da dire a chi ha caricato un video che
 * NON è stato convertito: il file (formato, durata, peso, protezione, leggibilità), il guasto nostro, il
 * file arrivato che non è quello scelto, il caricamento mai concluso. Tutti gli altri — i conflitti di
 * coda, i rifiuti di bordo, «l'app da aggiornare» — sono vocabolario che non descrive questo fatto, e per
 * loro vale la frase generica della conversione non riuscita.
 */
const CODICI_CON_FRASE_PROPRIA: ReadonlySet<CodiceMostratoVideo> = new Set<CodiceMostratoVideo>([
  'VIDEO_FILE_NON_VALIDO',
  'VIDEO_TROPPO_GRANDE',
  'VIDEO_TROPPO_LUNGO',
  'VIDEO_FORMATO_NON_SUPPORTATO',
  'VIDEO_PROTETTO',
  'VIDEO_NON_LEGGIBILE',
  'VIDEO_CONVERSIONE_NON_RIUSCITA',
  'VIDEO_GUASTO_NOSTRO',
  'VIDEO_NON_TROVATO',
  'VIDEO_ORIGINALE_NON_COINCIDE',
])

/**
 * La frase di una conversione fallita: quella del catalogo per il codice mostrabile (la regola #37 l'ha già
 * decisa: un job ritentato ed esaurito legge «problema nostro», un file difettoso il suo difetto), con il
 * ripiego sulla frase generica. Mai una stringa vuota: una notifica senza corpo non dice niente.
 */
export function corpoConversioneFallita(codice: CodiceMostratoVideo | null): string {
  const scelto: CodiceMostratoVideo =
    codice !== null && CODICI_CON_FRASE_PROPRIA.has(codice) ? codice : 'VIDEO_CONVERSIONE_NON_RIUSCITA'
  return (
    CATALOGO_IT[CHIAVI_MESSAGGIO_VIDEO[scelto]] ??
    'La preparazione di questo video non è riuscita e il filmato non è stato pubblicato.'
  )
}

/** Ciò che l'insegnante deve sapere di un video, in ognuno dei casi della spec §7. */
export type EsitoPerDocente =
  | { tipo: 'pubblicato'; nUsciti: number }
  | { tipo: 'nessun-destinatario' }
  | { tipo: 'pubblicazione-non-riuscita' }
  | { tipo: 'conversione-fallita'; codice: CodiceMostratoVideo | null }

/** Titolo e corpo della notifica a chi ha caricato. Pura: si prova su una tabella di casi. */
export function testoEsitoDocente(esito: EsitoPerDocente): { titolo: string; corpo: string } {
  switch (esito.tipo) {
    case 'pubblicato':
      return {
        titolo: TITOLO_VIDEO_PUBBLICATO,
        corpo: esito.nUsciti > 0 ? corpoPubblicatoSenzaBambini(esito.nUsciti) : CORPO_VIDEO_PUBBLICATO,
      }
    case 'nessun-destinatario':
      return { titolo: TITOLO_VIDEO_NON_PUBBLICATO, corpo: CORPO_VIDEO_NESSUN_DESTINATARIO }
    case 'pubblicazione-non-riuscita':
      return { titolo: TITOLO_VIDEO_NON_PUBBLICATO, corpo: CORPO_VIDEO_PUBBLICAZIONE_NON_RIUSCITA }
    case 'conversione-fallita':
      return { titolo: TITOLO_VIDEO_NON_PUBBLICATO, corpo: corpoConversioneFallita(esito.codice) }
  }
}

/** La galleria da cui riaprire il video: la Direzione e la segreteria hanno la loro, l'insegnante la sua. */
export function linkGalleria(ruolo: string | null | undefined): string {
  return ruolo === 'admin' || ruolo === 'coordinator' || ruolo === 'segreteria'
    ? LINK_GALLERIA_SEGRETERIA
    : LINK_GALLERIA_DOCENTE
}

/* ────────────────────────────────────────────────────────────────────────────
 * LA MARCA
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Un codice che l'outbox accetta (`^[A-Z][A-Z0-9_]{0,79}$`): un codice PostgREST come `42P01` comincia con
 * una cifra, e una risposta SQL imprevista potrebbe avere una forma qualunque. Il codice grezzo non si butta
 * (finisce nel log); qui si compone quello che può viaggiare in `video_outbox_fail`.
 */
export function codiceDaInoltrare(grezzo: unknown, ripiego: string): string {
  if (typeof grezzo !== 'string') return ripiego
  const pulito = grezzo
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .slice(0, 80)
  if (pulito === '') return ripiego
  return /^[A-Z]/.test(pulito) ? pulito : `E_${pulito}`.slice(0, 80)
}

export type EsitoMarca = { ok: true; segnato: boolean } | { ok: false; codice: string }

/**
 * Scrive la marca delle notifiche d'esito (`video_intent_esito_segna`). `segnato: true` vuol dire «tocca a te»:
 * chi lo riceve manda le notifiche, chi riceve `false` (un altro l'ha già segnato) non manda niente.
 *
 * Non lancia mai. Una marca che non si riesce a scrivere è un `{ ok: false }` con un codice, e CHI CHIAMA NON
 * NOTIFICA: «non so se qualcuno l'ha già fatto» non vale «nessuno l'ha fatto», e il giro dopo riprova.
 */
export async function segnaEsito(
  supabase: SupabaseClient,
  intentId: string,
  esito: 'pubblicato' | 'fallito',
  operazione: string,
): Promise<EsitoMarca> {
  try {
    const { data, error } = await supabase.rpc('video_intent_esito_segna', {
      p_intent_id: intentId,
      p_esito: esito,
    })
    if (error) {
      logEvento(
        'galleria',
        'error',
        { operazione, esito: 'esito-non-segnato', intent_id: intentId, error_code: codiceDi(error) },
        error,
      )
      return { ok: false, codice: 'MARCA_NON_SCRITTA' }
    }
    const risposta = (data ?? null) as EsitoRpc | null
    if (risposta?.ok !== true) {
      logEvento('galleria', 'error', {
        operazione,
        esito: 'esito-non-segnato',
        intent_id: intentId,
        error_code: typeof risposta?.code === 'string' ? risposta.code : 'sconosciuto',
      })
      return { ok: false, codice: codiceDaInoltrare(risposta?.code, 'MARCA_RIFIUTATA') }
    }
    return { ok: true, segnato: risposta.segnato === true }
  } catch (errore) {
    logEvento(
      'galleria',
      'error',
      { operazione, esito: 'esito-non-segnato', intent_id: intentId },
      errore,
    )
    return { ok: false, codice: 'MARCA_NON_SCRITTA' }
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * LE NOTIFICHE
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Accoda la notifica d'esito a chi ha caricato il video (tipo `video_esito`: centro notifiche e push, subito).
 *
 * ⚠️ Da chiamare SOLO dopo aver ricevuto `segnato: true` da `segnaEsito`: è la marca a decidere chi manda cosa,
 * e questa funzione non la guarda. `entitaId` è l'INTENTO e non il bambino né il file: nessuna chiave di
 * raggruppamento porta un dato personale, e nessun debounce — ogni video ha il suo esito.
 *
 * Non lancia (`notificaEvento` non lancia mai): un avviso che non parte lascia la sua riga `error` in
 * `notifica`, e il video resta comunque dove deve stare.
 */
export async function notificaEsitoDocente(
  supabase: SupabaseClient,
  input: {
    intentId: string
    ownerId: string
    scuolaId: string
    /** `utenti.ruolo` di chi ha caricato: sceglie la galleria a cui porta il collegamento. `null` = l'area docente. */
    ruoloAutore: string | null
    esito: EsitoPerDocente
    operazione: string
  },
): Promise<void> {
  const { titolo, corpo } = testoEsitoDocente(input.esito)
  await notificaEvento(supabase, {
    tipo: 'video_esito',
    scuolaId: input.scuolaId,
    utenteIds: [input.ownerId],
    titolo,
    corpo,
    link: linkGalleria(input.ruoloAutore),
    entitaTipo: 'video',
    entitaId: input.intentId,
    bufferMin: 0,
  })
  // Evento critico ⇒ anche il SUCCESSO (AGENTS, regola 5): senza questa riga «nessun log» non distingue «l'insegnante è
  // stata avvisata» da «non è mai partito niente». `tipo` è il caso (in lista bianca), mai il testo.
  logEvento(
    'galleria',
    'info',
    {
      operazione: input.operazione,
      esito: 'esito-docente-accodato',
      tipo: input.esito.tipo,
      intent_id: input.intentId,
      sede_id: input.scuolaId,
    },
    undefined,
    { distingui: ['intent_id'] },
  )
}

/**
 * L'avviso di un video pubblicato con bambini che hanno perso la liberatoria fotografica (tipo
 * `video_liberatoria_revocata`, `sicurezza: true`): a chi ha caricato e ad `admin`, `coordinator` e
 * `segreteria` della sede. Il testo è SOLO il numero. Risponde quanti destinatari distinti ha cercato di
 * raggiungere. Da chiamare, come l'altra, solo con la marca appena vinta.
 *
 * Chi ha caricato riceve il collegamento della sua galleria, gli altri quello della segreteria: due
 * `notificaEvento` e non una, perché il collegamento è un campo della riga e non del destinatario.
 */
export async function notificaAvvisoLiberatoria(
  supabase: SupabaseClient,
  input: {
    intentId: string
    ownerId: string
    scuolaId: string
    ruoloAutore: string | null
    nSenzaLiberatoria: number
    operazione: string
  },
): Promise<number> {
  if (!(input.nSenzaLiberatoria > 0)) return 0
  const staff = await staffScuola(supabase, input.scuolaId, [...RUOLI_AVVISO_LIBERATORIA])
  const altri = [...new Set(staff)].filter((id) => id !== input.ownerId)
  const base = {
    tipo: 'video_liberatoria_revocata',
    scuolaId: input.scuolaId,
    titolo: TITOLO_AVVISO_LIBERATORIA,
    corpo: corpoAvvisoLiberatoria(input.nSenzaLiberatoria),
    entitaTipo: 'video',
    entitaId: input.intentId,
    bufferMin: 0,
  }
  await notificaEvento(supabase, {
    ...base,
    utenteIds: [input.ownerId],
    link: linkGalleria(input.ruoloAutore),
  })
  if (altri.length > 0) {
    await notificaEvento(supabase, { ...base, utenteIds: altri, link: LINK_GALLERIA_SEGRETERIA })
  }
  logEvento(
    'galleria',
    'warn',
    {
      operazione: input.operazione,
      esito: 'pubblicato-senza-liberatoria',
      intent_id: input.intentId,
      sede_id: input.scuolaId,
      n_senza_liberatoria: input.nSenzaLiberatoria,
      n_destinatari: 1 + altri.length,
    },
    undefined,
    { distingui: ['intent_id'] },
  )
  return 1 + altri.length
}

/* ────────────────────────────────────────────────────────────────────────────
 * LA SCANSIONE DELLE CONVERSIONI FALLITE (spec §8.5)
 * ──────────────────────────────────────────────────────────────────────────── */

/** Quanti intenti «in volo» si guardano per giro, e quanti esiti si notificano al massimo per giro. */
export const LIMITE_INTENTI_SCANSIONE = 200
export const LIMITE_ESITI_PER_GIRO = 20

export type EsitoScansioneEsiti = {
  /** `ok`, oppure perché non è partita: `schema-assente` (database E2E non migrato) o `lettura-fallita`. */
  esito: 'ok' | 'schema-assente' | 'lettura-fallita'
  /** Intenti con una conversione fallita e nessuna marca. */
  candidati: number
  /** Quelli per cui questo giro ha vinto la marca e ha accodato la notifica. */
  notificati: number
}

type IntentoInVolo = { id: string; owner_id: string; scuola_id: string | null }
type JobFallito = { id: string; intent_id: string; status: string; error_code: string | null; attempt: number | null }

/**
 * La scansione degli intenti automatici con un job `failed` o `rejected` e nessuna marca: li segna `fallito` e,
 * SOLO se la marca è andata, avvisa chi ha caricato.
 *
 * ─── PERCHÉ ESISTE ───────────────────────────────────────────────────────────────────────────
 * Quando una conversione fallisce non nasce nessun evento dell'outbox (`video_job_fail` non ne accoda): senza
 * questa scansione il video non esce e nessuno lo dice. La fanno il runner subito dopo ogni esito definitivo e a
 * ogni giro, e la retention a ogni giro: la marca decide chi vince, e il perdente non manda niente.
 *
 * ─── COME SI LEGGONO LE DUE LISTE ────────────────────────────────────────────────────────────
 * Due letture semplici e non un join incorporato: gli intenti `confirmed` e automatici senza marca (l'indice
 * parziale `video_intents_esiti_da_notificare_idx` è fatto per questa domanda) e, fra i loro job, quelli
 * definitivi. Un intento `cancelled` o `superseded` non si avvisa: l'ha chiesto qualcuno. Uno `action_required`
 * o `published` ha i job `ready`, e il suo esito lo chiude il pubblicatore.
 *
 * ─── IL TESTO ────────────────────────────────────────────────────────────────────────────────
 * Lo decide `codiceMostrabileDelJob` (regola #37): `failed` con `attempt > 1` è un guasto NOSTRO ritentato fino
 * all'esaurimento, `rejected` è il file (o l'originale arrivato diverso da quello scelto).
 *
 * Non lancia mai e non si ferma al primo guasto: un intento che non si riesce a segnare non ferma quelli che
 * stanno dietro, e verrà ritentato al giro dopo (la marca è ancora libera).
 */
export async function scansionaEsitiDiConversione(
  supabase: SupabaseClient,
  opzioni: { operazione: string; limite?: number },
): Promise<EsitoScansioneEsiti> {
  const { operazione } = opzioni
  const limite = opzioni.limite ?? LIMITE_ESITI_PER_GIRO
  try {
    const intenti = await supabase
      .from('video_intents')
      .select('id, owner_id, scuola_id')
      .eq('pubblicazione_automatica', true)
      .eq('status', 'confirmed')
      .is('esito_notificato', null)
      .order('updated_at', { ascending: true })
      .limit(LIMITE_INTENTI_SCANSIONE)
    if (intenti.error) return scansioneNonRiuscita(operazione, 'video_intents', intenti.error)

    const inVolo = (intenti.data ?? []) as unknown as IntentoInVolo[]
    if (inVolo.length === 0) return { esito: 'ok', candidati: 0, notificati: 0 }

    const falliti = new Map<string, JobFallito>()
    for (const blocco of aBlocchi(
      inVolo.map((i) => i.id),
      ID_PER_QUERY,
    )) {
      const jobs = await supabase
        .from('video_jobs')
        .select('id, intent_id, status, error_code, attempt')
        .in('intent_id', blocco)
        .in('status', ['failed', 'rejected'])
      if (jobs.error) return scansioneNonRiuscita(operazione, 'video_jobs', jobs.error)
      for (const job of (jobs.data ?? []) as unknown as JobFallito[]) {
        // Un intento di galleria ha un job solo (`SINGLE_JOB_CHANNEL`): se per un guasto ne avesse due vale il primo.
        if (!falliti.has(job.intent_id)) falliti.set(job.intent_id, job)
      }
    }

    const candidati = inVolo.filter((i) => falliti.has(i.id))
    if (candidati.length === 0) return { esito: 'ok', candidati: 0, notificati: 0 }

    const ruoli = await ruoliDegliAutori(supabase, [...new Set(candidati.map((c) => c.owner_id))], operazione)

    let notificati = 0
    for (const intento of candidati.slice(0, limite)) {
      const job = falliti.get(intento.id)
      if (job === undefined || intento.scuola_id === null) continue

      const marca = await segnaEsito(supabase, intento.id, 'fallito', operazione)
      // Marca non scritta: non si sa se qualcuno ha già avvisato, quindi NON si avvisa. Il giro dopo riprova.
      if (!marca.ok || !marca.segnato) continue

      const codice =
        codiceMostrabileDelJob({ status: job.status, error_code: job.error_code, attempt: job.attempt }) ??
        codiceMessaggioVideo(job.error_code)
      await notificaEsitoDocente(supabase, {
        intentId: intento.id,
        ownerId: intento.owner_id,
        scuolaId: intento.scuola_id,
        ruoloAutore: ruoli.get(intento.owner_id) ?? null,
        esito: { tipo: 'conversione-fallita', codice },
        operazione,
      })
      notificati += 1
    }

    // Il rumore di una scansione a vuoto (ogni cinque minuti, due consumatori) non serve a nessuno: si scrive solo quando
    // ha trovato qualcosa. «Nessun log» qui vuol dire «niente da notificare»; il battito della retention porta il conteggio.
    logEvento('cron', 'info', {
      operazione,
      esito: 'esiti-scansionati',
      n_candidati: candidati.length,
      n_notificati: notificati,
      n_oltre_il_limite: Math.max(0, candidati.length - limite),
    })
    return { esito: 'ok', candidati: candidati.length, notificati }
  } catch (errore) {
    logEvento('cron', 'error', { operazione, esito: 'esiti-scansione-eccezione' }, errore)
    return { esito: 'lettura-fallita', candidati: 0, notificati: 0 }
  }
}

/**
 * Le colonne che il database E2E non migrato non ha: `42703` (Postgres) e `PGRST204` (PostgREST). Accanto ai codici
 * di «la tabella non c'è» (`schemaAssente`) dicono la stessa cosa — lo schema video di questa PR non è qui — e non
 * sono un guasto da gridare.
 */
const COLONNA_ASSENTE = new Set(['42703', 'PGRST204'])

/** Una lettura della scansione che non è riuscita: lo schema che non c'è si dichiara, ogni altro guasto si grida. */
function scansioneNonRiuscita(operazione: string, tabella: string, errore: unknown): EsitoScansioneEsiti {
  if (schemaAssente(errore) || COLONNA_ASSENTE.has(codiceDi(errore))) {
    logEvento(
      'cron',
      'warn',
      { operazione, esito: 'esiti-schema-assente', error_code: codiceDi(errore) },
      errore,
    )
    return { esito: 'schema-assente', candidati: 0, notificati: 0 }
  }
  logEvento(
    'cron',
    'error',
    { operazione, esito: 'esiti-lettura-fallita', tipo: tabella, error_code: codiceDi(errore) },
    errore,
  )
  return { esito: 'lettura-fallita', candidati: 0, notificati: 0 }
}

/**
 * Il ruolo di chi ha caricato, per scegliere il collegamento. Una lettura che fallisce non ferma gli avvisi: il
 * collegamento ripiega sull'area docente, e il guasto lascia la sua riga.
 */
async function ruoliDegliAutori(
  supabase: SupabaseClient,
  ownerIds: string[],
  operazione: string,
): Promise<Map<string, string>> {
  const ruoli = new Map<string, string>()
  for (const blocco of aBlocchi(ownerIds, ID_PER_QUERY)) {
    const { data, error } = await supabase.from('utenti').select('id, ruolo').in('id', blocco)
    if (error) {
      logEvento(
        'cron',
        'warn',
        { operazione, esito: 'esiti-ruoli-non-letti', error_code: codiceDi(error) },
        error,
      )
      continue
    }
    for (const riga of (data ?? []) as unknown as { id: string; ruolo: string | null }[]) {
      if (typeof riga.ruolo === 'string') ruoli.set(riga.id, riga.ruolo)
    }
  }
  return ruoli
}
