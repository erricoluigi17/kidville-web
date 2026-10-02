import type { TrasportoVideo as NomeTrasportoVideo } from '../contratto'
import type { ArchivioCaricamentiVideo, DipendenzeCaricamentoVideo } from '../upload'

/**
 * IL TRASPORTO DEI BYTE — la cucitura fra «un video è stato aperto» e «i byte sono sullo Storage».
 *
 * ─── PERCHÉ ESISTE UN'INTERFACCIA, SE OGGI C'È UN SOLO TRASPORTO ────────────────────────────
 * Il contratto conosce già due modi di far arrivare l'originale (`TRASPORTI_VIDEO`): `tus`, il
 * caricamento a blocchi che fanno il browser e le app 1.0/1.1, e `put-nativo`, la PUT sola che
 * l'app 1.2 manda dal sistema operativo anche a app chiusa (PR 3). La schermata non deve sapere
 * quale dei due sta usando: chiede `scegliTrasporto()` e ne legge il `nome` per dichiararlo
 * all'apertura. Questo file è quel punto di aggancio, e nient'altro.
 *
 * ⚠️ NON C'È ALCUN RAMO NATIVO MEZZO FATTO, ed è deciso (spec §11). `scegliTrasporto()` risponde
 * `put-nativo` solo se un trasporto REGISTRATO dice di essere disponibile, e oggi nessuno si
 * registra. La PR 3 scriverà il proprio trasporto e lo registrerà: finché non c'è, un `if` che
 * parla di PUT dentro la schermata sarebbe codice che nessuno esegue e nessuno prova.
 *
 * ─── COSA STA QUI DENTRO, E COSA NO ─────────────────────────────────────────────────────────
 * `dipendenze()` restituisce ciò che la libreria di caricamento (`@/lib/media/video/upload`,
 * `caricaVideo`) chiede per spostare i byte di UN job: l'archivio, le intestazioni con cui
 * autenticare l'invio e il rinnovo della firma. Quella libreria è il trasporto a blocchi: un
 * trasporto che non la usa — la PUT nativa — la sostituirà allargando questa interfaccia nella
 * PR 3, con il suo esito e i suoi stati. Allargarla adesso, senza nessuno che la provi, vorrebbe
 * dire inventarli.
 */

export type { NomeTrasportoVideo }

/** La `fetch` che il chiamante inietta: nel browser è quella del browser. */
export type ReteTrasporto = (url: string, init?: RequestInit) => Promise<Response>

/** Una firma di caricamento e l'istante (ISO) in cui smette di valere; `null` se non lo si sa. */
export interface FirmaDelTrasporto {
  firma: string
  scadeIl: string | null
}

/** Ciò che serve a un trasporto per portare i byte di UN job già aperto. */
export interface IngressoTrasporto {
  archivio: ArchivioCaricamentiVideo
  jobId: string
  /** L'intento del job: il rinnovo della firma parla per intento (`POST /api/video-uploads/[id]/firma`). */
  intentId: string
  /**
   * La firma con cui il server ha aperto il job, quando c'è. Alla ripresa — dopo una chiusura
   * dell'app, o a pagina ricaricata — non c'è: la prima richiesta ne chiede una nuova.
   */
  iniziale?: FirmaDelTrasporto | null
  /**
   * Il contesto (utente e sede) è ancora quello di quando è partito il giro? Se no, nessuna
   * credenziale viene consegnata: una firma arrivata tardi, dopo un logout o un cambio di
   * sede, non serve più a nessuno e non deve arrivare allo Storage.
   */
  ancora: () => boolean
  rete: ReteTrasporto
}

export interface TrasportoVideo {
  /** Il nome nel contratto: è ciò che l'apertura dichiara (`trasporto`). */
  readonly nome: NomeTrasportoVideo
  /** Questo trasporto può partire adesso, su questo dispositivo? */
  disponibile(): boolean
  /** Come la libreria di caricamento autentica e rinnova l'invio di UN job. */
  dipendenze(ingresso: IngressoTrasporto): DipendenzeCaricamentoVideo
}
