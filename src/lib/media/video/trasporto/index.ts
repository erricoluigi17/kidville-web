/**
 * LA PORTA DEL MODULO DI TRASPORTO — quello che le schermate importano.
 *
 * ```ts
 * const trasporto = scegliTrasporto()                  // oggi sempre `trasportoTus`
 * apri({ …, trasporto: trasporto.nome })               // lo dichiara all'apertura
 * const dip = trasporto.dipendenze({ archivio, jobId, intentId, iniziale, ancora, rete })
 * await caricaVideo(dip, jobId)
 * ```
 *
 * Il rinnovo della firma (`rinnovaFirmaTus`) è esportato a parte perché le News, che non passano
 * dalla schermata della Galleria, lo chiamano con le loro dipendenze: la chiamata è una sola.
 */

export type {
  FirmaDelTrasporto,
  IngressoTrasporto,
  NomeTrasportoVideo,
  ReteTrasporto,
  TrasportoVideo,
} from './interfaccia'
export { registraTrasporto, scegliTrasporto } from './scegli'
export { dipendenzeTus, rinnovaFirmaTus, trasportoTus } from './tus'
