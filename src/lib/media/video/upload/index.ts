/**
 * LA PORTA DEL MODULO DI CARICAMENTO VIDEO.
 *
 * È quello che l'interfaccia (V11 Galleria, V12 News) importa. Il resto —
 * `LettoreBlob`, la classe Dexie, la classe in memoria — resta raggiungibile dai
 * singoli file per chi deve iniettare qualcosa, ma non fa parte della superficie
 * che una schermata usa.
 *
 * Il giro di una schermata è questo, e sono quattro chiamate:
 *
 * ```ts
 * const archivio = await creaArchivioCaricamenti()
 * const dip = { archivio, intestazioni: async () => ({ authorization: `Bearer ${token()}` }) }
 *
 * await potaArchivioCaricamenti(dip)          // all'avvio: niente resta per sempre
 * await riprendiCaricamentiVideo(dip)         // al rientro: ciò che era a metà
 * const daSeguire = await jobDaSeguire(dip)   // e ciò che il server sta convertendo
 *
 * const messo = await accodaCaricamentoVideo(dip, { …, file })   // riga + file vivo: torna subito
 * if (messo.ok) await caricaVideo(dip, messo.riga.jobId, { segnale, alProgresso })
 * ```
 *
 * `accodaCaricamentoVideo` NON aspetta la copia dei byte in IndexedDB: parte in background
 * e si ferma da sola quando non serve più (trasferimento finito, video tolto). Il resto del
 * giro di una schermata, oltre alle quattro chiamate:
 *
 *  · `annullaCaricamentoVideo(dip, jobId)` — «Rimuovi»: ferma insieme il trasferimento TUS e la
 *    copia in background, anche se chi annulla non ha il segnale con cui il trasferimento è partito;
 *  · `concludiCaricamentoVideo(dip, jobId)` — l'apertura dell'intento ha risposto che i byte
 *    sono già sul server: la riga passa a «caricato» e la copia in background si ferma;
 *  · `dip.rinnovaFirma` — facoltativa: se lo Storage rifiuta la firma a metà trasferimento la
 *    libreria la chiama e prosegue dallo stesso offset (galleria: `POST /api/video-uploads/[id]/firma`).
 */

export type { ArchivioCaricamentiVideo } from './archivio'
export { creaArchivioCaricamenti } from './crea-archivio'
export {
  accodaCaricamentoVideo,
  annullaCaricamentoVideo,
  caricaVideo,
  concludiCaricamentoVideo,
  jobDaSeguire,
  potaArchivioCaricamenti,
  riprendiCaricamentiVideo,
  type DipendenzeCaricamentoVideo,
  type EsitoAccodamento,
  type EsitoCaricamentoVideo,
  type IngressoAccodamento,
  type JobDaSeguire,
  type OpzioniCaricamento,
} from './caricamento'
export {
  STATI_CARICAMENTO_VIDEO,
  TTL_CARICAMENTI_MS,
  caricamentiDaRiprendere,
  caricamentiDaSeguire,
  type CaricamentoVideoLocale,
  type StatoCaricamentoVideo,
} from './stato'
