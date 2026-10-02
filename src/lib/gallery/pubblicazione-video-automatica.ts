// =============================================================================
// LA PUBBLICAZIONE AUTOMATICA DI UN VIDEO IN GALLERIA — lato server (PR 2 «server e web»).
//
// ─── IL DIFETTO CHE CHIUDE ───────────────────────────────────────────────────
//
// Fino al 2026-10-02 i bambini di un video vivevano solo nella memoria della pagina, e a
// pubblicare era il browser quando il job era `ready`: se la pagina era chiusa il video restava
// convertito e mai pubblicato (11 casi misurati il 01/10). Ora i destinatari stanno sull'intento
// (`video_galleria_intent_apri`), e quando la conversione finisce `video_job_ready` accoda nella
// STESSA transazione l'evento `gallery.auto_publish`. Questo modulo è ciò che lo consegna.
//
// ─── DOVE GIRA, E CHI LO CHIAMA ──────────────────────────────────────────────
//
// `pubblicaVideoGalleria(supabase, intentId)` è l'UNICA porta, e la chiama SOLO il destinatario
// dell'outbox registrato per `gallery.auto_publish` (`src/lib/media/video/outbox/destinatari.ts`):
// la consuma il runner, subito dopo il `ready` e a ogni giro, mai la retention (spec §8.1). Il
// claim con lease impedisce il doppio lavoro; l'idempotenza della RPC impedisce i doppioni.
//
// ─── L'ORDINE, E PERCHÉ NON SI SCAMBIA ───────────────────────────────────────
//
//  1. si legge l'intento. Lo stato decide la strada: `confirmed` è il caso normale; `published` è il
//     recupero di un processo morto fra la RPC e le notifiche (#45); `action_required` è il recupero
//     di uno morto fra «pubblicazione fallita» e le sue notifiche; tutto il resto — revocato,
//     annullato — è «niente da fare» e l'evento si consegna (#80);
//  2. RIVERIFICHE (spec §8.2), tutte in TypeScript e tutte PRIMA della copia: l'autore non attivo non
//     ferma niente (si pubblica comunque e si logga); i bambini usciti dal perimetro (trasferiti,
//     cancellati, archiviati, dimenticati) si TOLGONO dai destinatari; se non resta nessuno e non è un
//     broadcast il video NON si pubblica; chi ha perso la liberatoria RESTA fra i destinatari e si conta
//     per l'avviso (decisione del titolare: il video esce comunque, e la sicurezza lo sa);
//  3. la COPIA nel bucket della galleria (percorso deterministico, `./video-pubblicazione`), e SOLO se
//     è riuscita — anche col 409 «esiste già» di pari dimensione — la RPC `video_galleria_pubblica`,
//     con il percorso che la copia ha RESTITUITO (#40, #46): la RPC data l'uscita in lavorazione a
//     «adesso» senza poter verificare da SQL che la copia esista, e se la si chiamasse dopo un fallimento
//     il file di lavoro sparirebbe senza che in galleria ce ne sia uno;
//  4. la MARCA `video_intent_esito_segna` — con `created` vero O falso — e SOLO se `segnato` è vero:
//     le famiglie, l'esito all'insegnante, l'eventuale avviso di liberatoria (spec §8.4).
//
// ─── I FALLIMENTI (spec §8.5) ────────────────────────────────────────────────
//
// Un guasto transitorio (la copia, la RPC, una lettura) NON chiude l'evento: si restituisce `da-ripetere`
// con un codice, e il backoff dell'outbox ripete. Se l'evento ha più di 60 MINUTI (dalla sua nascita, che
// il «Riprova» riporta a «adesso») l'ultimo guasto è definitivo: `video_intent_pubblicazione_fallita`
// (`PUBBLICAZIONE_NON_RIUSCITA`), marca `fallito`, notifica con «Riprova», evento chiuso. L'età si guarda
// DOPO un tentativo fallito e non prima: un evento rimasto fermo un'ora per un runner spento ha comunque
// diritto a un tentativo.
//
// Non è un guasto che può passare un job finito male DOPO l'evento (`failed`, `rejected`, `cancelled`: il
// trigger d'arrivo porta a `rejected` anche un job `ready` il cui originale è stato sostituito). Non c'è
// niente da pubblicare, e ritentare un'ora per poi dire «pubblicazione non riuscita» sarebbe dire il falso
// sulla causa: l'evento si consegna subito, e l'esito a chi ha caricato lo scrive la scansione degli esiti
// (`@/lib/media/video/esiti`) col difetto vero.
//
// La copia che una pubblicazione definitivamente fallita lascia in `gallery` non si toglie da qui: nessuna
// riga la nomina, e la spazzata degli orfani di `retention-galleria` la porta via dopo 24 ore (spec §8.3).
// Toglierla subito vorrebbe dire una `remove` sul percorso di un video che la RPC potrebbe aver già pubblicato
// con una risposta persa per strada.
//
// ─── COSA NON ESCE MAI DA QUI ────────────────────────────────────────────────
//
// Né i nomi dei bambini né i loro identificativi: si leggono `id`, `stato` e `consenso_privacy` e basta (mai
// `nome` e `cognome`: non servono), e nei log vanno soltanto l'uuid dell'intento, i conteggi e i codici. Nemmeno
// il percorso del file, che porta con sé chi ha caricato.
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { eNonPiuIscritto } from '@/lib/alunni/stato'
import { profiloStaffRevocato, type AppRole } from '@/lib/auth/predicati-ruolo'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { aBlocchi, ID_PER_QUERY } from '@/lib/db/blocchi'
import { colonnaSedeAssente, degradoSedeLecito } from '@/lib/forms/degrado-sede'
import { leggiVive } from '@/lib/gallery/cestino'
import { logEvento, type Valore } from '@/lib/logging/logger'
import type { CodiceEsitoVideo } from '@/lib/media/video/contratto'
import {
  codiceDaInoltrare,
  notificaAvvisoLiberatoria,
  notificaEsitoDocente,
  segnaEsito,
} from '@/lib/media/video/esiti'
import type { EsitoRpc } from '@/lib/media/video/outbox/rpc'

import { notificaGenitoriGalleria } from './notifica-genitori'
import { studentiSenzaConsenso } from './privacy'
import { copiaVideoInGalleria } from './video-pubblicazione'

/**
 * I codici che QUESTO modulo scrive da sé nel database (`video_intent_pubblicazione_fallita`), dichiarati
 * come elenco perché il lock del contratto (`__tests__/lib/video-contratto.test.ts`) li legga come una
 * FONTE: è ciò che ha tolto `PUBBLICAZIONE_NON_RIUSCITA` dalla deroga dei codici dichiarati in anticipo
 * (secondario #23). `satisfies` fa sì che un nome che il contratto non dichiara non compili.
 */
export const CODICI_PUBBLICAZIONE_VIDEO = [
  'NESSUN_DESTINATARIO',
  'PUBBLICAZIONE_NON_RIUSCITA',
] as const satisfies readonly CodiceEsitoVideo[]
export type CodicePubblicazioneVideo = (typeof CODICI_PUBBLICAZIONE_VIDEO)[number]

/** Dopo quanti minuti dalla nascita dell'evento un guasto transitorio diventa definitivo (spec §8.5). */
export const MINUTI_ATTESA_MASSIMA_PUBBLICAZIONE = 60
const ETA_MASSIMA_MS = MINUTI_ATTESA_MASSIMA_PUBBLICAZIONE * 60_000

/** L'etichetta dei log quando il chiamante non ne dà una sua. */
const OPERAZIONE_PREDEFINITA = 'video-pubblicazione-automatica'

export type EsitoPubblicazioneVideo =
  /** Il video è in galleria (lo ha pubblicato questa chiamata, `creato`, oppure un'altra già prima). */
  | { esito: 'pubblicato'; creato: boolean; segnato: boolean; recupero: boolean }
  /** Niente da fare: l'intento non è più pubblicabile (revocato, annullato) o lo è già stato con la marca scritta. */
  | { esito: 'gia-concluso'; stato: string }
  /** Non si pubblica, e l'insegnante lo sa (o lo sa già per la marca di un altro): evento chiuso. */
  | { esito: 'non-pubblicato'; codice: CodicePubblicazioneVideo; segnato: boolean }
  /** Un guasto che può passare: l'evento non si chiude, e l'outbox lo riprova col suo backoff. */
  | { esito: 'da-ripetere'; codice: string }

export type OpzioniPubblicazioneVideo = {
  /** `video_outbox.created_at` dell'evento: da lì si contano i 60 minuti. Assente = giovane. */
  eventoCreatoIl?: string
  /** Quante volte l'evento è stato preso, questa compresa: solo per i log. */
  tentativi?: number
  /** Come si presentano le righe di log (`video-runner` quando consegna il runner). */
  operazione?: string
  /** L'orologio: parametro perché il test lo fissa senza congelare il tempo del processo. */
  adesso?: () => number
}

/* ────────────────────────────────────────────────────────────────────────────
 * LE RIGHE CHE SI LEGGONO
 * ──────────────────────────────────────────────────────────────────────────── */

type RigaIntento = {
  id: string
  owner_id: string
  scuola_id: string | null
  channel: string
  status: string
  revision: number
  pubblicazione_automatica: boolean
  /** ⚠️ Identificativi di minori: mai in un log, mai in una risposta. */
  tag_alunni: string[] | null
  broadcast: boolean
  classi_destinatarie: string[] | null
  n_tag: number
  esito_notificato: string | null
  pubblicazione_errore: string | null
}
const COLONNE_INTENTO =
  'id, owner_id, scuola_id, channel, status, revision, pubblicazione_automatica, tag_alunni, broadcast, classi_destinatarie, n_tag, esito_notificato, pubblicazione_errore'

type RigaJob = {
  id: string
  status: string
  output_bucket: string | null
  output_path: string | null
  output_size: number | string | null
  output_deleted_at: string | null
}
const COLONNE_JOB = 'id, status, output_bucket, output_path, output_size, output_deleted_at'

type Contesto = {
  supabase: SupabaseClient
  intentId: string
  operazione: string
  eventoCreatoIl: string | undefined
  tentativi: number | null
  adesso: () => number
}

type Letto<T> =
  | { ok: true; valore: T }
  /** `conclusoDa`: lo stato terminale del job (`failed`, `rejected`, `cancelled`), quando il guasto NON può passare. */
  | { ok: false; codice: string; errore?: unknown; conclusoDa?: string }

/** Una riga di log di questo modulo: sempre sul canale `galleria`, sempre con l'intento, una riga per intento al giorno. */
function log(
  ctx: Contesto,
  livello: 'info' | 'warn' | 'error',
  campi: Record<string, Valore>,
  errore?: unknown,
): void {
  logEvento(
    'galleria',
    livello,
    { operazione: ctx.operazione, intent_id: ctx.intentId, ...campi },
    errore,
    { distingui: ['intent_id'] },
  )
}

/** Una RPC che non lancia mai: PostgREST ritorna `{ error }`, e un guasto di trasporto lancia — qui sono la stessa cosa. */
async function chiamaRpc(
  supabase: SupabaseClient,
  nome: string,
  argomenti: Record<string, unknown>,
): Promise<{ ok: true; dati: EsitoRpc | null } | { ok: false; errore: unknown }> {
  try {
    const { data, error } = await supabase.rpc(nome, argomenti)
    if (error) return { ok: false, errore: error }
    return { ok: true, dati: (data ?? null) as EsitoRpc | null }
  } catch (errore) {
    return { ok: false, errore }
  }
}

function codiceErrore(errore: unknown): string {
  const c = (errore as { code?: unknown } | null | undefined)?.code
  return typeof c === 'string' && c.length > 0 ? c : 'sconosciuto'
}

/* ────────────────────────────────────────────────────────────────────────────
 * LA PORTA
 * ──────────────────────────────────────────────────────────────────────────── */

export async function pubblicaVideoGalleria(
  supabase: SupabaseClient,
  intentId: string,
  opzioni: OpzioniPubblicazioneVideo = {},
): Promise<EsitoPubblicazioneVideo> {
  const ctx: Contesto = {
    supabase,
    intentId,
    operazione: opzioni.operazione ?? OPERAZIONE_PREDEFINITA,
    eventoCreatoIl: opzioni.eventoCreatoIl,
    tentativi: typeof opzioni.tentativi === 'number' ? opzioni.tentativi : null,
    adesso: opzioni.adesso ?? Date.now,
  }

  const letto = await leggiIntento(ctx)
  if (!letto.ok) {
    log(ctx, 'error', { esito: 'pubblicazione-intento-non-letto', error_code: letto.codice }, letto.errore)
    return { esito: 'da-ripetere', codice: letto.codice }
  }
  const intento = letto.valore

  if (intento.channel !== 'gallery' || !intento.pubblicazione_automatica || intento.scuola_id === null) {
    // Un evento `gallery.auto_publish` per un intento che non è di galleria o non è automatico non si può consegnare
    // mai: la RPC lo rifiuterebbe (`NON_AUTOMATICA`) a ogni giro. Si grida e si chiude, invece di bruciare venticinque
    // tentativi per arrivare in quarantena.
    log(ctx, 'error', { esito: 'pubblicazione-evento-fuori-contratto', stato: intento.status })
    return { esito: 'gia-concluso', stato: 'fuori-contratto' }
  }

  switch (intento.status) {
    case 'confirmed':
      return pubblicaDaConfermato(ctx, intento)
    case 'published':
      return recuperaPubblicato(ctx, intento)
    case 'action_required':
      return recuperaFallimento(ctx, intento)
    default:
      // Revocato, annullato, sostituito: l'insegnante ha cambiato idea fra il `ready` e adesso. Niente da pubblicare e
      // niente da notificare; l'evento si consegna (#80), altrimenti tornerebbe a ogni giro fino alla quarantena.
      log(ctx, 'info', { esito: 'pubblicazione-saltata', stato: intento.status })
      return { esito: 'gia-concluso', stato: intento.status }
  }
}

async function leggiIntento(ctx: Contesto): Promise<Letto<RigaIntento>> {
  try {
    const { data, error } = await ctx.supabase
      .from('video_intents')
      .select(COLONNE_INTENTO)
      .eq('id', ctx.intentId)
      .maybeSingle()
    if (error) return { ok: false, codice: 'INTENTO_NON_LETTO', errore: error }
    if (!data) return { ok: false, codice: 'INTENTO_ASSENTE' }
    return { ok: true, valore: data as unknown as RigaIntento }
  } catch (errore) {
    return { ok: false, codice: 'INTENTO_NON_LETTO', errore }
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * IL CASO NORMALE: l'intento è `confirmed`
 * ──────────────────────────────────────────────────────────────────────────── */

async function pubblicaDaConfermato(ctx: Contesto, intento: RigaIntento): Promise<EsitoPubblicazioneVideo> {
  const scuolaId = intento.scuola_id as string
  // Gli id vengono dal database e sono minuscoli: si normalizzano comunque, perché il percorso della copia è composto da
  // loro e la RPC lo confronta con `p_owner_id::text` (minuscolo) — un'iniziale maiuscola fa `FILE_URL_NON_VALIDO` (#46).
  const ownerId = intento.owner_id.toLowerCase()

  const job = await leggiJob(ctx)
  if (!job.ok) {
    if (job.conclusoDa !== undefined) {
      // Il job è finito male DOPO l'evento (l'originale sostituito o diverso, per esempio): non c'è niente da pubblicare e ritentare per
      // un'ora non lo cambierebbe. L'evento si consegna, e l'esito a chi ha caricato lo dà la scansione degli esiti (marca `fallito` e
      // notifica col difetto vero: «il video che ci è arrivato non corrisponde», non un generico «pubblicazione non riuscita»).
      log(ctx, 'warn', { esito: 'pubblicazione-saltata', stato: `job-${job.conclusoDa}` })
      return { esito: 'gia-concluso', stato: `job-${job.conclusoDa}` }
    }
    return transitorio(ctx, intento, job.codice, job.errore)
  }

  await riverificaAutore(ctx, intento)

  // ── 2. I BAMBINI NEL PERIMETRO, E LA LIBERATORIA ──
  const tag = [...new Set((intento.tag_alunni ?? []).map((id) => id.toLowerCase()))]
  const perimetro = await leggiPerimetro(ctx, scuolaId, tag)
  if (!perimetro.ok) return transitorio(ctx, intento, perimetro.codice, perimetro.errore)
  const { effettivi, senzaLiberatoria } = perimetro.valore

  if (!intento.broadcast && effettivi.length === 0) {
    // Nessuno vedrebbe questo video: non si pubblica (decisione del titolare). Non è un guasto da ritentare — riprovare
    // darebbe lo stesso rifiuto — ed è per questo che l'elenco non offre il «Riprova» con questo codice.
    return chiudiConFallimento(ctx, intento, 'NESSUN_DESTINATARIO')
  }

  // ── 3. LA COPIA, E SOLO SE È RIUSCITA LA RPC ──
  const copia = await copiaVideoInGalleria(ctx.supabase, {
    bucketSorgente: job.valore.output_bucket as string,
    percorsoSorgente: job.valore.output_path as string,
    byte: job.valore.output_size === null ? null : Number(job.valore.output_size),
    ownerId,
    intentId: ctx.intentId.toLowerCase(),
    operazione: ctx.operazione,
  })
  if (!copia.ok) return transitorio(ctx, intento, copia.codice)

  const pubblicata = await chiamaRpc(ctx.supabase, 'video_galleria_pubblica', {
    p_intent_id: ctx.intentId,
    p_revision: intento.revision,
    p_owner_id: ownerId,
    p_scuola_id: scuolaId,
    // Il percorso che la copia ha RESTITUITO, mai uno ricomposto qui: è quello che esiste davvero (#40).
    p_file_url: copia.percorso,
    p_tag_effettivi: effettivi,
  })
  if (!pubblicata.ok) return transitorio(ctx, intento, 'RPC_PUBBLICA_FALLITA', pubblicata.errore)
  if (pubblicata.dati?.ok !== true) {
    // `TAG_NON_DELL_INTENTO` è un oblio arrivato fra la riverifica e la RPC: il giro dopo rilegge l'intento senza quel
    // bambino. Gli altri rifiuti (revoca, stato) si risolvono allo stesso modo, rileggendo.
    return transitorio(ctx, intento, codiceDaInoltrare(pubblicata.dati?.code, 'PUBBLICAZIONE_RIFIUTATA'))
  }

  const creato = pubblicata.dati.created === true
  // `n_tag_effettivi` è ciò che la RPC ha scritto (o, per `created: false`, ciò che c'è già): la differenza con `n_tag` è
  // «pubblicato senza N bambini». Un broadcast non ha bambini da togliere.
  const nEffettivi =
    typeof pubblicata.dati.n_tag_effettivi === 'number' ? pubblicata.dati.n_tag_effettivi : effettivi.length
  const nUsciti = intento.broadcast ? 0 : Math.max(0, intento.n_tag - nEffettivi)

  // ── 4. LA MARCA, E SOLO CHI LA VINCE NOTIFICA ──
  const marca = await segnaEsito(ctx.supabase, ctx.intentId, 'pubblicato', ctx.operazione)
  if (!marca.ok) {
    // La riga di galleria c'è e la marca no: il giro dopo trova l'intento `published` e riprende da qui (recupero).
    return { esito: 'da-ripetere', codice: marca.codice }
  }

  let famiglie: number | null = null
  if (marca.segnato) {
    famiglie = await avvisa(ctx, {
      intento,
      scuolaId,
      ownerId,
      destinatari: { tag: effettivi, classi: intento.classi_destinatarie },
      nUsciti,
      senzaLiberatoria,
    })
  }

  log(ctx, 'info', {
    esito: 'pubblicazione-automatica-riuscita',
    sede_id: scuolaId,
    n_tag: intento.n_tag,
    n_tag_effettivi: nEffettivi,
    n_usciti: nUsciti,
    n_senza_liberatoria: senzaLiberatoria,
    broadcast: intento.broadcast,
    creato,
    segnato: marca.segnato,
    famiglie_avvisate: famiglie,
    recupero: false,
    n_tentativi: ctx.tentativi,
  })
  return { esito: 'pubblicato', creato, segnato: marca.segnato, recupero: false }
}

/**
 * Le notifiche di un video pubblicato: le famiglie, l'esito a chi ha caricato, e — se qualcuno ha perso la liberatoria —
 * l'avviso. Si chiama SOLO con la marca appena vinta. Non lancia: il video è già in galleria, e un guasto di preparazione
 * delle notifiche non può trasformarsi in un guasto della pubblicazione.
 *
 * Risponde quante famiglie ha raggiunto (`null` se la preparazione dell'avviso alle famiglie è fallita).
 */
async function avvisa(
  ctx: Contesto,
  d: {
    intento: RigaIntento
    scuolaId: string
    ownerId: string
    /** `null` = non si sa a chi è stato mostrato (recupero senza la riga di galleria): niente avviso alle famiglie. */
    destinatari: { tag: readonly string[]; classi: readonly string[] | null } | null
    nUsciti: number
    senzaLiberatoria: number
  },
): Promise<number | null> {
  let famiglie: number | null = null
  try {
    if (d.destinatari !== null) {
      famiglie = await notificaGenitoriGalleria(ctx.supabase, {
        scuolaId: d.scuolaId,
        uploadedBy: d.ownerId,
        tagAlunni: d.destinatari.tag,
        classi: d.destinatari.classi,
        operazione: ctx.operazione,
      })
    }
    await notificaEsitoDocente(ctx.supabase, {
      intentId: ctx.intentId,
      ownerId: d.ownerId,
      scuolaId: d.scuolaId,
      esito: { tipo: 'pubblicato', nUsciti: d.nUsciti },
      operazione: ctx.operazione,
    })
    if (d.nUsciti > 0) {
      // Solo il numero. Una volta per intento: questa riga si scrive solo a marca vinta.
      log(ctx, 'warn', {
        esito: 'pubblicato-senza-bambini-usciti',
        sede_id: d.scuolaId,
        n_usciti: d.nUsciti,
        n_tag: d.intento.n_tag,
      })
    }
    if (d.senzaLiberatoria > 0) {
      await notificaAvvisoLiberatoria(ctx.supabase, {
        intentId: ctx.intentId,
        ownerId: d.ownerId,
        scuolaId: d.scuolaId,
        nSenzaLiberatoria: d.senzaLiberatoria,
        operazione: ctx.operazione,
      })
    }
  } catch (errore) {
    // Non dovrebbe succedere (nessuna delle tre lancia), ma «non dovrebbe» non è un presidio: il video è pubblicato e la
    // marca è scritta, quindi si LOGGA e si prosegue — il giro dopo non rifarebbe comunque queste notifiche.
    log(ctx, 'error', { esito: 'pubblicazione-avvisi-eccezione', sede_id: d.scuolaId }, errore)
  }
  return famiglie
}

/* ────────────────────────────────────────────────────────────────────────────
 * IL RECUPERO: l'intento è già `published` (un processo è morto dopo la RPC, #45)
 * ──────────────────────────────────────────────────────────────────────────── */

async function recuperaPubblicato(ctx: Contesto, intento: RigaIntento): Promise<EsitoPubblicazioneVideo> {
  if (intento.esito_notificato !== null) {
    // La marca c'è: le notifiche sono partite (o le ha mandate chi l'ha vinta). Non c'è altro da fare.
    log(ctx, 'info', { esito: 'pubblicazione-saltata', stato: 'published' })
    return { esito: 'gia-concluso', stato: 'published' }
  }

  // NIENTE COPIA E NIENTE RPC: il video è in galleria. Se la purga ha già tolto l'uscita in lavorazione (la RPC la data a
  // «adesso»), la copia riceverebbe un 404 sulla sorgente a ogni giro e dopo 60 minuti arriverebbe un «non pubblicato» per
  // un video già pubblicato. Si va dritti alla marca.
  const scuolaId = intento.scuola_id as string
  const ownerId = intento.owner_id.toLowerCase()

  // A chi è stato mostrato lo dice la RIGA di galleria: l'intento ha già svuotato `tag_alunni` (la RPC lo minimizza).
  const media = await leggiMediaPubblicato(ctx, scuolaId, ownerId)
  if (!media.ok) {
    // UNA RIGA DI LOG PROPRIA, SEMPRE (#153), come ogni altro guasto transitorio (`transitorio`): `warn` finché l'evento è giovane e si
    // ripete, `error` quando smette di esserlo. Prima la riga c'era solo oltre l'ora: una lettura che falliva dentro l'ora tornava
    // `da-ripetere` senza lasciare niente in `app_log` da parte di questo modulo, e un guasto di quaranta minuti si sarebbe visto soltanto
    // come un evento dell'outbox con troppi tentativi — senza il codice, senza l'intento.
    const definitiva = eVecchio(ctx)
    log(
      ctx,
      definitiva ? 'error' : 'warn',
      { esito: 'recupero-media-non-letta', error_code: media.codice, n_tentativi: ctx.tentativi, definitiva },
      media.errore,
    )
    if (!definitiva) return { esito: 'da-ripetere', codice: media.codice }
    // Dopo un'ora si smette di aspettare la lettura: si marca e si avvisa l'insegnante, e l'avviso alle famiglie si perde (la riga
    // `error` qui sopra lo dice). Un'ora senza poter leggere una riga non è una condizione da assecondare all'infinito.
  }
  const letta = media.ok ? media.valore : null

  const marca = await segnaEsito(ctx.supabase, ctx.intentId, 'pubblicato', ctx.operazione)
  if (!marca.ok) return { esito: 'da-ripetere', codice: marca.codice }

  let famiglie: number | null = null
  let nUsciti = 0
  let senzaLiberatoria = 0
  if (marca.segnato) {
    if (letta !== null) {
      nUsciti = letta.broadcast ? 0 : Math.max(0, intento.n_tag - letta.tag.length)
      // La liberatoria si ricalcola sullo stato di OGGI: è la stessa regola, e il numero è ciò che sta a cuore a chi legge l'avviso.
      const consensi = await leggiPerimetro(ctx, scuolaId, letta.tag)
      if (consensi.ok) {
        senzaLiberatoria = consensi.valore.senzaLiberatoria
      } else {
        // Senza la lettura dei consensi l'avviso di liberatoria non parte: si dice, perché è un avviso di sicurezza.
        log(ctx, 'error', { esito: 'recupero-liberatoria-non-letta', error_code: consensi.codice }, consensi.errore)
      }
    }
    famiglie = await avvisa(ctx, {
      intento,
      scuolaId,
      ownerId,
      destinatari: letta === null ? null : { tag: letta.tag, classi: letta.classi },
      nUsciti,
      senzaLiberatoria,
    })
  }

  log(ctx, 'info', {
    esito: 'pubblicazione-automatica-riuscita',
    sede_id: scuolaId,
    n_tag: intento.n_tag,
    n_usciti: nUsciti,
    n_senza_liberatoria: senzaLiberatoria,
    segnato: marca.segnato,
    famiglie_avvisate: famiglie,
    recupero: true,
    n_tentativi: ctx.tentativi,
  })
  return { esito: 'pubblicato', creato: false, segnato: marca.segnato, recupero: true }
}

type MediaPubblicato = { tag: string[]; broadcast: boolean; classi: string[] | null }

async function leggiMediaPubblicato(
  ctx: Contesto,
  scuolaId: string,
  ownerId: string,
): Promise<Letto<MediaPubblicato | null>> {
  try {
    // SOLO LE RIGHE VIVE (`leggiVive`, il lock del cestino lo pretende per ogni lettura di questa tabella): un video che
    // l'insegnante ha già messo nel cestino non è visibile a nessuno, e annunciarlo alle famiglie sarebbe annunciare un
    // contenuto che non c'è. `leggiVive` sopravvive anche al database E2E non migrato, che `eliminato_il` non ce l'ha.
    const { data, error } = await leggiVive(
      (vive) =>
        vive(
          ctx.supabase
            .from('galleria_media_v2')
            .select('id, tag_students, is_broadcast, target_classes')
            .eq('upload_id', ctx.intentId)
            .eq('uploaded_by', ownerId)
            .eq('scuola_id', scuolaId),
        ).maybeSingle(),
      ctx.operazione,
    )
    if (error) return { ok: false, codice: 'MEDIA_NON_LETTO', errore: error }
    if (!data) {
      // La riga non c'è più (cestino, o già purgato): il video non è visibile a nessuno e non c'è chi avvisare.
      log(ctx, 'warn', { esito: 'recupero-media-assente', sede_id: scuolaId })
      return { ok: true, valore: null }
    }
    const riga = data as unknown as {
      tag_students: string[] | null
      is_broadcast: boolean | null
      target_classes: string[] | null
    }
    return {
      ok: true,
      valore: {
        tag: (riga.tag_students ?? []).map((id) => id.toLowerCase()),
        broadcast: riga.is_broadcast === true,
        classi: riga.target_classes ?? null,
      },
    }
  } catch (errore) {
    return { ok: false, codice: 'MEDIA_NON_LETTO', errore }
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * IL RECUPERO: l'intento è `action_required` (un processo è morto fra «fallita» e le notifiche)
 * ──────────────────────────────────────────────────────────────────────────── */

async function recuperaFallimento(ctx: Contesto, intento: RigaIntento): Promise<EsitoPubblicazioneVideo> {
  if (intento.esito_notificato !== null) {
    // Il caso normale: la pubblicazione è fallita, l'esito è stato segnato e notificato. L'evento si consegna (#80).
    log(ctx, 'info', { esito: 'pubblicazione-saltata', stato: 'action_required' })
    return { esito: 'gia-concluso', stato: 'action_required' }
  }
  // Fallita e MAI notificata: l'insegnante vedrebbe «non pubblicato» nell'elenco e nessun avviso. Si completa la strada, con il
  // codice che la prima volta ha lasciato scritto sull'intento (la RPC è idempotente su un intento già `action_required`).
  const codice: CodicePubblicazioneVideo =
    intento.pubblicazione_errore === 'NESSUN_DESTINATARIO' ? 'NESSUN_DESTINATARIO' : 'PUBBLICAZIONE_NON_RIUSCITA'
  return chiudiConFallimento(ctx, intento, codice)
}

/* ────────────────────────────────────────────────────────────────────────────
 * I FALLIMENTI
 * ──────────────────────────────────────────────────────────────────────────── */

/** L'evento ha più di sessanta minuti? Dalla sua nascita (il «Riprova» la riporta a «adesso»). */
function eVecchio(ctx: Contesto): boolean {
  if (ctx.eventoCreatoIl === undefined) return false
  const nato = Date.parse(ctx.eventoCreatoIl)
  return Number.isFinite(nato) && ctx.adesso() - nato > ETA_MASSIMA_MS
}

/**
 * Un guasto che può passare. Dentro l'ora si restituisce `da-ripetere` (il backoff dell'outbox fa il resto); oltre, il guasto è
 * definitivo e si chiude come «pubblicazione non riuscita», con il «Riprova».
 */
async function transitorio(
  ctx: Contesto,
  intento: RigaIntento,
  codice: string,
  errore?: unknown,
): Promise<EsitoPubblicazioneVideo> {
  const definitiva = eVecchio(ctx)
  log(
    ctx,
    definitiva ? 'error' : 'warn',
    { esito: 'pubblicazione-automatica-fallita', error_code: codice, n_tentativi: ctx.tentativi, definitiva },
    errore,
  )
  if (definitiva) return chiudiConFallimento(ctx, intento, 'PUBBLICAZIONE_NON_RIUSCITA')
  return { esito: 'da-ripetere', codice }
}

/**
 * La pubblicazione non esce, e l'insegnante lo deve sapere: `video_intent_pubblicazione_fallita` (l'intento passa ad
 * `action_required` con il codice), la marca `fallito`, e — solo con la marca vinta — la notifica.
 *
 * Le tre RPC sono idempotenti nell'ordine in cui si chiamano: un processo che muore a metà riparte da qui al giro dopo
 * (l'intento `action_required` senza marca lo riprende `recuperaFallimento`).
 */
async function chiudiConFallimento(
  ctx: Contesto,
  intento: RigaIntento,
  codice: CodicePubblicazioneVideo,
): Promise<EsitoPubblicazioneVideo> {
  const fallita = await chiamaRpc(ctx.supabase, 'video_intent_pubblicazione_fallita', {
    p_intent_id: ctx.intentId,
    p_codice: codice,
  })
  if (!fallita.ok) {
    log(ctx, 'error', { esito: 'pubblicazione-fallita-non-scritta', error_code: codiceErrore(fallita.errore) }, fallita.errore)
    return { esito: 'da-ripetere', codice: 'RPC_FALLITA_NON_SCRITTA' }
  }
  if (fallita.dati?.ok !== true) {
    // `INTENT_PUBLISHED`, `INTENT_REVOKED`, `INVALID_STATE`: lo stato è cambiato sotto di noi (qualcuno ha pubblicato o ritirato il
    // video mentre si decideva). Non si marca niente: il giro dopo rilegge l'intento e prende la strada giusta.
    const codiceRpc = typeof fallita.dati?.code === 'string' ? fallita.dati.code : 'sconosciuto'
    log(ctx, 'warn', { esito: 'pubblicazione-fallita-rifiutata', error_code: codiceRpc })
    return { esito: 'da-ripetere', codice: codiceDaInoltrare(codiceRpc, 'STATO_CAMBIATO') }
  }

  const marca = await segnaEsito(ctx.supabase, ctx.intentId, 'fallito', ctx.operazione)
  if (!marca.ok) return { esito: 'da-ripetere', codice: marca.codice }

  if (marca.segnato) {
    const scuolaId = intento.scuola_id as string
    await notificaEsitoDocente(ctx.supabase, {
      intentId: ctx.intentId,
      ownerId: intento.owner_id.toLowerCase(),
      scuolaId,
      esito: { tipo: codice === 'NESSUN_DESTINATARIO' ? 'nessun-destinatario' : 'pubblicazione-non-riuscita' },
      operazione: ctx.operazione,
    })
    if (codice === 'NESSUN_DESTINATARIO') {
      log(ctx, 'warn', { esito: 'non-pubblicato-nessun-destinatario', sede_id: scuolaId, n_tag: intento.n_tag })
    }
  }
  return { esito: 'non-pubblicato', codice, segnato: marca.segnato }
}

/* ────────────────────────────────────────────────────────────────────────────
 * LE RIVERIFICHE E LE LETTURE DI CONTORNO
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Il job di un intento di galleria è uno solo (`SINGLE_JOB_CHANNEL`): deve essere `ready`, con l'uscita ancora lì.
 *
 * Tre stati dicono «non qui, e non ancora»: `awaiting_upload`, `queued`, `processing` — un guasto che può passare, si ripete. Tre dicono
 * «mai»: `failed`, `rejected`, `cancelled` — terminali, e un job `ready` non ci torna. Dopo `ready` ci si può arrivare davvero: il trigger
 * d'arrivo porta a `rejected` un job con l'originale cambiato anche da `ready` (`ORIGINALE_SOSTITUITO`).
 */
async function leggiJob(ctx: Contesto): Promise<Letto<RigaJob>> {
  try {
    const { data, error } = await ctx.supabase
      .from('video_jobs')
      .select(COLONNE_JOB)
      .eq('intent_id', ctx.intentId)
    if (error) return { ok: false, codice: 'JOB_NON_LETTO', errore: error }
    const righe = (data ?? []) as unknown as RigaJob[]
    if (righe.length !== 1) return { ok: false, codice: righe.length === 0 ? 'JOB_ASSENTE' : 'JOB_NON_UNICO' }
    const job = righe[0]
    if (job.status === 'failed' || job.status === 'rejected' || job.status === 'cancelled') {
      return { ok: false, codice: 'JOB_CONCLUSO', conclusoDa: job.status }
    }
    if (job.status !== 'ready') return { ok: false, codice: 'JOB_NON_PRONTO' }
    if (job.output_bucket === null || job.output_path === null || job.output_deleted_at !== null) {
      return { ok: false, codice: 'USCITA_ASSENTE' }
    }
    return { ok: true, valore: job }
  } catch (errore) {
    return { ok: false, codice: 'JOB_NON_LETTO', errore }
  }
}

type Perimetro = {
  /** I bambini scelti che sono ancora nella sede e iscritti: a loro, e solo a loro, il video è mostrato. */
  effettivi: string[]
  /** Quanti fra gli effettivi non hanno la liberatoria fotografica (la regola di `./privacy`: conta dal secondo bambino in poi). */
  senzaLiberatoria: number
}

/**
 * Chi, fra i bambini scelti, è ancora nel perimetro della sede e iscritto, e quanti di loro hanno perso la liberatoria.
 *
 * UNA SOLA LETTURA di `id`, `stato` e `consenso_privacy`: né `nome` né `cognome`, che non servono e non devono entrare in
 * memoria. La regola della liberatoria è `studentiSenzaConsenso` di `./privacy` (una regola in un posto solo); la lettura è
 * propria perché `alunniSenzaConsenso` restituisce i NOMI, e perché su un guasto di lettura darebbe «tutti senza consenso» —
 * giusto per un 422, falso per un avviso alla Direzione. Qui un guasto è un guasto, e il giro dopo riprova.
 *
 * Il filtro di sede è `scuola_id` dell'intento. Se la colonna non c'è (il database E2E non migrato) si degrada come
 * `assertTagStudentsInScope`: solo quando c'è al più una sede reale, mai in un impianto multi-sede.
 */
async function leggiPerimetro(ctx: Contesto, scuolaId: string, tag: string[]): Promise<Letto<Perimetro>> {
  if (tag.length === 0) return { ok: true, valore: { effettivi: [], senzaLiberatoria: 0 } }

  type RigaAlunno = { id: string; stato: string | null; consenso_privacy: boolean | null }
  const righe: RigaAlunno[] = []
  try {
    for (const blocco of aBlocchi(tag, ID_PER_QUERY)) {
      let esito: { data: unknown; error: { code?: string } | null } = await ctx.supabase
        .from('alunni')
        .select('id, stato, consenso_privacy')
        .in('id', blocco)
        .eq('scuola_id', scuolaId)
      if (colonnaSedeAssente(esito.error)) {
        if (!(await degradoSedeLecito(ctx.supabase, ctx.operazione))) {
          log(ctx, 'error', { esito: 'perimetro-degrado-negato', sede_id: scuolaId })
          return { ok: false, codice: 'VERIFICA_SEDE_NEGATA' }
        }
        esito = await ctx.supabase.from('alunni').select('id, stato, consenso_privacy').in('id', blocco)
      }
      if (esito.error) return { ok: false, codice: 'PERIMETRO_NON_LETTO', errore: esito.error }
      righe.push(...((esito.data ?? []) as RigaAlunno[]))
    }
  } catch (errore) {
    return { ok: false, codice: 'PERIMETRO_NON_LETTO', errore }
  }

  const dentro = new Map(righe.map((r) => [r.id.toLowerCase(), r]))
  // Un bambino che non torna indietro non è della sede (trasferito, cancellato); uno che torna ma non frequenta più
  // (`ritirato`, o archiviato per l'oblio) esce comunque. `eNonPiuIscritto` è l'allowlist del repo: uno stato mai visto non lo toglie.
  const effettivi = tag.filter((id) => {
    const riga = dentro.get(id)
    return riga !== undefined && !eNonPiuIscritto(riga.stato)
  })
  const consensi: Record<string, boolean> = {}
  for (const id of effettivi) consensi[id] = dentro.get(id)?.consenso_privacy === true
  return { ok: true, valore: { effettivi, senzaLiberatoria: studentiSenzaConsenso(effettivi, consensi).length } }
}

/**
 * Chi ha caricato. Se è disattivato o non ha più la sede il video si pubblica COMUNQUE (decisione del titolare): la riverifica
 * serve a dirlo nei log, `autore-non-attivo`, non a fermare niente. Una lettura che fallisce non ferma niente neppure lei: `warn`
 * `autore-non-letto`, e si prosegue.
 *
 * Non restituisce niente, ed è voluto (#152). Prima restituiva il ruolo, che sceglieva il collegamento delle notifiche
 * (`/admin/gallery` per lo staff): e lo staff che aveva caricato finiva in una pagina senza il «Riprova». L'esito a chi ha caricato porta
 * ora sempre all'area docente (`LINK_GALLERIA_DOCENTE`), quindi nessuna notifica deve più sapere CHI ha caricato — e le strade di
 * recupero (`published`, `action_required`) non leggono più `utenti`: la riverifica la fa solo la strada di `confirmed`, l'unica che
 * pubblica.
 */
async function riverificaAutore(ctx: Contesto, intento: RigaIntento): Promise<void> {
  type RigaAutore = {
    id: string
    ruolo?: string | null
    role?: string | null
    scuola_id?: string | null
    archiviato_il?: string | null
  }
  const leggi = async (colonne: string) =>
    (await ctx.supabase.from('utenti').select(colonne).eq('id', intento.owner_id).maybeSingle()) as unknown as {
      data: RigaAutore | null
      error: { code?: string } | null
    }

  try {
    let esito = await leggi('id, ruolo, role, scuola_id, archiviato_il')
    // `archiviato_il` può non esserci (database E2E non migrato): PostgREST fallisce l'intera SELECT. Si rilegge senza.
    if (colonnaSedeAssente(esito.error)) esito = await leggi('id, ruolo, role, scuola_id')
    if (esito.error) {
      log(ctx, 'warn', { esito: 'autore-non-letto', error_code: codiceErrore(esito.error) }, esito.error)
      return
    }
    const riga = esito.data
    // Il ruolo serve qui e basta: `scuoleDiUtente` calcola le sedi dell'autore secondo il suo ruolo.
    await segnalaAutoreNonAttivo(ctx, intento, riga, riga?.ruolo ?? riga?.role ?? null)
  } catch (errore) {
    log(ctx, 'warn', { esito: 'autore-non-letto' }, errore)
  }
}

/** Il log `autore-non-attivo`: archiviato (profilo revocato) oppure senza più la sede dell'intento. Solo booleani e l'uuid della sede. */
async function segnalaAutoreNonAttivo(
  ctx: Contesto,
  intento: RigaIntento,
  riga: { id: string; scuola_id?: string | null; archiviato_il?: string | null } | null,
  ruolo: string | null,
): Promise<void> {
  const archiviato = riga === null ? true : profiloStaffRevocato(riga.archiviato_il)
  const sedi =
    riga === null
      ? []
      : await scuoleDiUtente(ctx.supabase, {
          id: riga.id,
          role: (ruolo ?? 'educator') as AppRole,
          scuola_id: riga.scuola_id ?? null,
        })
  const sedeDelVideo = (intento.scuola_id ?? '').toLowerCase()
  const conSede = sedeDelVideo !== '' && sedi.some((s) => s.toLowerCase() === sedeDelVideo)
  if (archiviato || !conSede) {
    log(ctx, 'info', { esito: 'autore-non-attivo', sede_id: intento.scuola_id, archiviato, con_sede: conSede })
  }
}
