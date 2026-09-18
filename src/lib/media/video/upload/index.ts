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
 * const messo = await accodaCaricamentoVideo(dip, { …, file })
 * if (messo.ok) await caricaVideo(dip, messo.riga.jobId, { segnale, alProgresso })
 * ```
 */

export type { ArchivioCaricamentiVideo } from './archivio'
export { creaArchivioCaricamenti } from './crea-archivio'
export {
  accodaCaricamentoVideo,
  annullaCaricamentoVideo,
  caricaVideo,
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
