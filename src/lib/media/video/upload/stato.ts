import { mimeBase } from '@/lib/gallery/limiti'

import type { CanaleVideo, CoordinateCaricamentoVideo } from '../contratto'

/**
 * LO STATO DI UN CARICAMENTO VIDEO *SUL DISPOSITIVO* — cioè la metà del problema
 * che nessun database del server può risolvere.
 *
 * ─── PERCHÉ ESISTE UN SECONDO ELENCO DI STATI ───────────────────────────────
 *
 * `video_jobs.status` (`STATI_JOB_VIDEO` nel contratto) racconta che cosa sta
 * facendo il SERVER: in coda, in conversione, pronto, rifiutato. Non può
 * raccontare che cosa sta facendo il TELEFONO, perché finché i byte non sono
 * arrivati il server non sa nemmeno che esistono: per lui il job è fermo su
 * `awaiting_upload` sia mentre la rete carica a 40 kB/s sia mentre l'app è
 * chiusa da tre giorni.
 *
 * Quei due casi sul telefono sono opposti: nel primo non si fa niente, nel
 * secondo si riprende. Servono cinque stati locali, e sono locali davvero —
 * nessuno di loro viene mai spedito da nessuna parte.
 *
 * ─── IL CRITERIO CHE HA DECISO IL DISEGNO ───────────────────────────────────
 *
 * «Chi carica un video di 180 secondi da un telefono chiude l'app, e al ritorno
 * deve ritrovare il lavoro, non ricominciarlo.» Perché sia vero servono tre
 * cose su un supporto che sopravvive al processo:
 *
 *  1. i BYTE, finché non sono tutti arrivati (altrimenti la ripresa non ha
 *     niente da spedire: il `File` scelto da un `<input>` muore con la pagina);
 *  2. l'URL della sessione TUS, che è l'unica cosa che distingue «riprendi da
 *     870 MB» da «ricomincia da zero»;
 *  3. il RIFERIMENTO AL JOB (`jobId`, `intentId`, canale), che serve DOPO il
 *     completamento — quando i byte non servono più ma la conversione è ancora
 *     in corso sul server, e senza questa riga lo schermo non avrebbe niente da
 *     mostrare né niente da interrogare.
 *
 * ─── COSA NON CI STA, E NON È UNA DIMENTICANZA ──────────────────────────────
 *
 * Il TOKEN di sessione. L'upload TUS si autentica con il bearer del genitore, e
 * conservarlo accanto ai byte renderebbe la ripresa indipendente da tutto —
 * anche dalla scadenza della sessione, anche da chi ha in mano il telefono. Le
 * intestazioni si chiedono al momento di partire (`intestazioni()` in
 * `caricamento.ts`): il lock `CHIAVI_RIGA_CARICAMENTO` esiste per impedire che
 * qualcuno le aggiunga qui per comodità.
 */

/** Gli stati locali, nell'ordine in cui si attraversano. */
export const STATI_CARICAMENTO_VIDEO = [
  /** La riga c'è, i byte pure, nessuna richiesta è ancora partita. */
  'da_caricare',
  /** Una sessione TUS è aperta: o sta spedendo, o è ferma e va ripresa. */
  'in_corso',
  /** Tutti i byte sono sullo Storage. Il server ha il job; i byte locali no. */
  'caricato',
  /** L'ha fermato una persona. Non si riprende, e non resta niente sul server. */
  'annullato',
  /** Non si riproverà: riprovare gli stessi byte non può funzionare. */
  'fallito',
] as const
export type StatoCaricamentoVideo = (typeof STATI_CARICAMENTO_VIDEO)[number]

/** La riga che vive su IndexedDB. Metadati soltanto: i byte stanno a parte. */
export interface CaricamentoVideoLocale {
  /** Chiave primaria: è il `jobId` del server, così le due sponde si parlano. */
  jobId: string
  intentId: string
  canale: CanaleVideo
  ownerId?: string | null
  scuolaId?: string | null
  chiaveIdempotenza: string
  /**
   * Il nome scelto da chi carica. Resta SUL DISPOSITIVO, dove è già: serve alla
   * schermata per dire quale dei tre video è a metà. Non esce di qui e non entra
   * MAI in un log — `IMG_bambina-rossi.mov` è anagrafica di un minore, e in
   * `app_log` resterebbe trenta giorni interrogabile in SQL.
   */
  nome: string
  dimensioneByte: number
  /** Il solo container, senza il suffisso dei codec: è ciò che va allo Storage. */
  mime: string
  stato: StatoCaricamentoVideo
  /** L'ultimo offset confermato dallo Storage. Indicativo: l'autorità è la HEAD. */
  offsetByte: number
  /** L'URL della sessione TUS. È questo campo a rendere possibile la ripresa. */
  urlTus: string | null
  /** Dove spedire, con che blocco, con che `contentType`: dal contratto. */
  coordinate: CoordinateCaricamentoVideo
  /** Il codice mostrabile dell'ultimo esito negativo, o `null`. */
  codice: string | null
  creatoIl: string
  aggiornatoIl: string
}

/**
 * L'ELENCO CHIUSO DELLE CHIAVI — un lock, non una comodità.
 *
 * Serve a rendere deliberato l'atto di aggiungere un campo a ciò che finisce su
 * disco: il campo che verrebbe naturale aggiungere è `intestazioni`, ed è
 * esattamente quello che non deve esserci. Un test che confrontasse la riga con
 * `toMatchObject` non vedrebbe mai una chiave in più.
 */
export const CHIAVI_RIGA_CARICAMENTO = [
  'jobId',
  'intentId',
  'canale',
  'ownerId',
  'scuolaId',
  'chiaveIdempotenza',
  'nome',
  'dimensioneByte',
  'mime',
  'stato',
  'offsetByte',
  'urlTus',
  'coordinate',
  'codice',
  'creatoIl',
  'aggiornatoIl',
] as const satisfies readonly (keyof CaricamentoVideoLocale)[]

/**
 * Quanto a lungo una riga resta sul dispositivo.
 *
 * Sette giorni, lo stesso numero che il piano dà alla ritenzione degli originali
 * sul server («Originali riusciti: sette giorni dalla verifica. Falliti o
 * abbandonati: TTL separato sette giorni»). Un solo valore per tutti gli stati,
 * e la ragione è che oltre quella soglia i due casi coincidono: un `caricato` di
 * otto giorni fa ha un job che il server ha già concluso o buttato, e un
 * `in_corso` di otto giorni fa è un originale che nessuno riprenderà — con
 * attaccati fino a due gigabyte di Blob sul telefono di un genitore.
 */
export const TTL_CARICAMENTI_MS = 7 * 24 * 60 * 60 * 1000

interface IngressoNuovoCaricamento {
  jobId: string
  intentId: string
  canale: CanaleVideo
  ownerId?: string | null
  scuolaId?: string | null
  chiaveIdempotenza: string
  nome: string
  dimensioneByte: number
  mime: string
  coordinate: CoordinateCaricamentoVideo
  adesso: Date
}

/**
 * La riga appena nata.
 *
 * ⚠️ `mimeBase` QUI E NON PIÙ AVANTI. Il tipo che arriva da un `<input file>` o
 * da `MediaRecorder` porta i parametri del produttore
 * (`video/mp4;codecs=avc1.42E01E,mp4a.40.2`), e quel valore andrà a finire in due
 * posti che i parametri non li tollerano: il confronto col `contentType` delle
 * coordinate e l'header `contentType` dei metadati TUS, che lo Storage confronta
 * con `allowed_mime_types` per uguaglianza. Il 2026-09-09 la stessa `PUT` su
 * questo Storage ha dato 400 `invalid_mime_type` con il suffisso e 200 senza.
 * Normalizzando in un punto solo i due non possono divergere.
 */
export function nuovoCaricamento(dati: IngressoNuovoCaricamento): CaricamentoVideoLocale {
  const istante = dati.adesso.toISOString()
  return {
    jobId: dati.jobId,
    intentId: dati.intentId,
    canale: dati.canale,
    ownerId: dati.ownerId ?? null,
    scuolaId: dati.scuolaId ?? null,
    chiaveIdempotenza: dati.chiaveIdempotenza,
    nome: dati.nome,
    dimensioneByte: dati.dimensioneByte,
    mime: mimeBase(dati.mime),
    stato: 'da_caricare',
    offsetByte: 0,
    urlTus: null,
    coordinate: dati.coordinate,
    codice: null,
    creatoIl: istante,
    aggiornatoIl: istante,
  }
}

/** Gli stati in cui restano byte da spedire: sono i soli che si ripescano. */
const RIPESCABILI = new Set<StatoCaricamentoVideo>(['da_caricare', 'in_corso'])

/** Che cosa riprendere al rientro nell'app. */
export function caricamentiDaRiprendere(
  righe: readonly CaricamentoVideoLocale[],
): CaricamentoVideoLocale[] {
  return righe.filter((r) => RIPESCABILI.has(r.stato))
}

/**
 * Che cosa tornare a interrogare al rientro nell'app.
 *
 * È la seconda metà del criterio d'accettazione, e la più facile da dimenticare:
 * un caricamento COMPLETO non è un lavoro finito. Sul server la conversione dura
 * minuti, e se il telefono non conserva il riferimento al job, chi riapre l'app
 * vede una galleria senza il suo video e senza niente che spieghi perché.
 */
export function caricamentiDaSeguire(
  righe: readonly CaricamentoVideoLocale[],
): CaricamentoVideoLocale[] {
  return righe.filter((r) => r.stato === 'caricato')
}

/** Le righe ferme da più del TTL, in qualunque stato: nessuna resta orfana. */
export function caricamentiDaPotare(
  righe: readonly CaricamentoVideoLocale[],
  oraMs: number,
  ttlMs: number = TTL_CARICAMENTI_MS,
): CaricamentoVideoLocale[] {
  return righe.filter((r) => {
    const quando = Date.parse(r.aggiornatoIl)
    // Una data illeggibile è una riga che nessun criterio potrà mai potare: si
    // butta. Il contrario — tenerla per prudenza — è il modo in cui un deposito
    // di Blob da due gigabyte diventa permanente.
    if (Number.isNaN(quando)) return true
    return oraMs - quando >= ttlMs
  })
}


/** Le righe legacy senza autore/sede non vengono attribuite alla sessione corrente. */
export function caricamentoNelContesto(riga: CaricamentoVideoLocale, ownerId: string, scuolaId: string | null, canale: CanaleVideo): boolean {
  return riga.ownerId === ownerId && riga.scuolaId === scuolaId && riga.canale === canale
}
