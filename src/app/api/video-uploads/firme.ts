import type { SupabaseClient } from '@supabase/supabase-js'

import { mimeBase } from '@/lib/gallery/limiti'
import {
  BUCKET_ORIGINALI_VIDEO,
  DIMENSIONE_BLOCCO_TUS_BYTE,
  type CoordinateCaricamentoVideo,
  type CoordinatePutVideo,
} from '@/lib/media/video/contratto'
import { SUPABASE_URL } from '@/lib/supabase/public-config'

/**
 * LE FIRME DI CARICAMENTO DELLA PIPELINE VIDEO — come si conia il permesso di scrivere UN originale
 * nel bucket privato, per le tre porte che lo fanno.
 *
 * ─── CHI LA USA ──────────────────────────────────────────────────────────────────────────────
 *  · `POST /api/video-uploads` — la firma con cui il telefono (o il browser) spedisce i byte, TUS
 *    oppure PUT, subito dopo l'apertura;
 *  · `POST /api/video-uploads/[id]/firma` — una firma TUS nuova per un job che aspetta ancora il
 *    suo file, senza riaprire l'intento (190 aperture per 44 job, misurate prima della PR 2);
 *  · `POST /api/video-uploads/rinnovo` — un URL di PUT nuovo, per chi ha solo il token di rinnovo.
 *
 * Stanno qui e non dentro una route per la stessa ragione di `cancello.ts`: un file di route può
 * esportare solo i metodi HTTP, e tre copie di «come si firma» divergerebbero alla prima modifica —
 * è il genere di divergenza che qui costa una PUT senza `upsert: false`, cioè un originale che
 * chiunque abbia l'URL potrebbe sovrascrivere.
 *
 * ─── PERCHÉ LA ROTTA TUS *FIRMATA* E NON QUELLA COL TOKEN DI SESSIONE ────────────────────────
 * `storage.objects` ha RLS accesa e ZERO policy: un upload presentato con il JWT di sessione
 * dell'utente prende 403 al primo byte, e quella policy le nostre migrazioni non potrebbero
 * nemmeno scriverla (la tabella è di `supabase_storage_admin`). Perciò il browser non presenta
 * MAI un token di sessione allo Storage: si conia una firma con la chiave di servizio, e il client
 * la spedisce nell'intestazione `x-signature` su `/storage/v1/upload/resumable/sign`, registrata
 * fuori da RLS. La misura sta nella testata di `20260916190200_video_intent_lifecycle.sql`.
 *
 * ─── L'URL FIRMATO È UN SEGRETO ──────────────────────────────────────────────────────────────
 * Porta il token di scrittura nella query: chi lo ha può caricare quel percorso per due ore. Non
 * si logga MAI — né l'URL, né il suo token — e il corpo d'errore del provider (che serve a
 * diagnosticare) torna al chiamante come `errore`, perché sia lui a registrarlo col suo nome di
 * operazione.
 */

/**
 * Quanto valgono le coordinate. È la durata dichiarata dal servizio per una firma di caricamento
 * (due ore), **non una misura fatta qui**: serve al client per sapere quando chiedere una firma
 * nuova invece di insistere su una scaduta.
 */
export const VALIDITA_FIRMA_SECONDI = 2 * 60 * 60

/** La rotta TUS che autentica con `x-signature`, cioè l'unica che non passa da RLS. */
const ENDPOINT_TUS = `${SUPABASE_URL}/storage/v1/upload/resumable/sign`

/**
 * L'estensione dal MIME **validato**, mai dal nome del file.
 *
 * Un video di galleria si chiama `recita-bambina-rossi.mov`: è anagrafica di un
 * minore, e finirebbe nella chiave dell'oggetto — quindi in `app_log` ogni volta
 * che qualcosa logga un percorso. Del nome serve solo l'estensione, e quella si
 * ricava dal tipo. L'elenco copre i contenitori di `@/lib/media/video/limiti`;
 * ciò che non si riconosce resta `bin`, perché l'autorità su che cosa sia davvero
 * il file è ffprobe e arriva dopo.
 */
export function estensioneVideoDaMime(mime: string): string {
  switch (mimeBase(mime)) {
    case 'video/mp4': return 'mp4'
    case 'video/quicktime': return 'mov'
    case 'video/x-m4v':
    case 'video/m4v': return 'm4v'
    case 'video/webm': return 'webm'
    case 'video/x-matroska': return 'mkv'
    case 'video/3gpp': return '3gp'
    case 'video/3gpp2': return '3g2'
    case 'video/x-msvideo': return 'avi'
    case 'video/x-ms-wmv':
    case 'video/x-ms-asf': return 'wmv'
    case 'video/mpeg': return 'mpg'
    case 'video/mp2t': return 'ts'
    case 'video/x-flv': return 'flv'
    case 'video/ogg': return 'ogv'
    case 'video/mj2': return 'mj2'
    default: return 'bin'
  }
}

/**
 * Il tipo dall'estensione del percorso: il percorso inverso di `estensioneVideoDaMime`, per i job
 * che non hanno un tipo dichiarato (le News non lo scrivono: lo scrive solo l'apertura dei video di
 * Galleria con destinatari). Serve a `[id]/firma`, che non riceve un corpo con il tipo e deve
 * comunque dire allo Storage quale `Content-Type` registrare. `bin`, o un'estensione che non si
 * riconosce, restituisce `application/octet-stream`: l'autorità sul contenuto è ffprobe.
 */
export function mimeDaEstensione(percorso: string): string {
  const estensione = (percorso.split('.').pop() ?? '').toLowerCase()
  switch (estensione) {
    case 'mp4': return 'video/mp4'
    case 'mov': return 'video/quicktime'
    case 'm4v': return 'video/x-m4v'
    case 'webm': return 'video/webm'
    case 'mkv': return 'video/x-matroska'
    case '3gp': return 'video/3gpp'
    case '3g2': return 'video/3gpp2'
    case 'avi': return 'video/x-msvideo'
    case 'wmv': return 'video/x-ms-wmv'
    case 'mpg': return 'video/mpeg'
    case 'ts': return 'video/mp2t'
    case 'flv': return 'video/x-flv'
    case 'ogv': return 'video/ogg'
    case 'mj2': return 'video/mj2'
    default: return 'application/octet-stream'
  }
}

/** Le coordinate con cui il client spedisce i byte di questo file in TUS. */
export function coordinateTus(percorso: string, mime: string): CoordinateCaricamentoVideo {
  return {
    protocollo: 'tus',
    endpoint: ENDPOINT_TUS,
    bucket: BUCKET_ORIGINALI_VIDEO,
    percorso,
    contentType: mime,
    dimensioneBloccoByte: DIMENSIONE_BLOCCO_TUS_BYTE,
  }
}

/** L'istante in cui una firma appena coniata smette di valere. */
export function scadenzaFirma(adesso: number = Date.now()): string {
  return new Date(adesso + VALIDITA_FIRMA_SECONDI * 1000).toISOString()
}

export type EsitoFirmaTus = { ok: true; firma: string; scadeIl: string } | { ok: false; errore: unknown }
export type EsitoFirmaPut = { ok: true; caricamento: CoordinatePutVideo; scadeIl: string } | { ok: false; errore: unknown }

/**
 * La firma TUS di un percorso: il token da presentare come `x-signature`.
 *
 * Chi chiama la registra nel suo log se manca, col suo nome di operazione. Qui non si logga: non
 * c'è un'operazione da nominare, e un `catch` che non logga sarebbe un bug — quindi niente `catch`:
 * `createSignedUploadUrl` di storage-js non lancia, ritorna `{ error }`.
 */
export async function firmaTus(supabase: SupabaseClient, percorso: string): Promise<EsitoFirmaTus> {
  const { data, error } = await supabase.storage.from(BUCKET_ORIGINALI_VIDEO).createSignedUploadUrl(percorso)
  if (error || !data?.token) return { ok: false, errore: error ?? new Error('Firma mancante') }
  return { ok: true, firma: data.token, scadeIl: scadenzaFirma() }
}

/**
 * L'URL di PUT firmato di un percorso, SENZA upsert.
 *
 * ⚠️ `{ upsert: false }` è scritto per esteso anche se oggi è il comportamento di default della
 * libreria: è la proprietà che regge il token di rinnovo — una seconda PUT sullo stesso percorso
 * prende 409 invece di sovrascrivere l'originale già arrivato — e una proprietà di sicurezza non
 * si affida a un default che una versione futura potrebbe cambiare. Lo prova un test (l'argomento
 * passato a `createSignedUploadUrl`).
 *
 * `mime` è il tipo dichiarato all'apertura: lo Storage lo registra sull'oggetto (`content-type`).
 */
export async function firmaPut(supabase: SupabaseClient, percorso: string, mime: string): Promise<EsitoFirmaPut> {
  const { data, error } = await supabase
    .storage.from(BUCKET_ORIGINALI_VIDEO)
    .createSignedUploadUrl(percorso, { upsert: false })
  if (error || !data?.signedUrl) return { ok: false, errore: error ?? new Error('URL firmato mancante') }
  return {
    ok: true,
    caricamento: {
      protocollo: 'put',
      url: data.signedUrl,
      metodo: 'PUT',
      intestazioni: { 'content-type': mime },
    },
    scadeIl: scadenzaFirma(),
  }
}
