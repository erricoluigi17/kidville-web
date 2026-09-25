/**
 * IL CESTINO DEL REGISTRO DELLA PRIMARIA — i giorni di custodia, in un posto solo.
 *
 * Allegati del registro (`allegati_registro`) e documenti del fascicolo
 * (`student_documents`) non si cancellano subito: «Elimina» li mette nel cestino
 * (`eliminato_il`), si possono ripristinare per 7 giorni, poi la purga toglie riga
 * e file (spec 2026-09-24, «2 Primaria»). Lo stesso vale per il file SOSTITUITO e
 * per gli allegati di una lezione eliminata.
 *
 * ─── PERCHÉ UN MODULO PURO ──────────────────────────────────────────────────
 * Il numero lo leggono DUE lati: la purga (server, cron) che lo APPLICA e la
 * schermata del cestino (client) che lo PROMETTE («Restano 3 giorni»). Il
 * cestino della galleria ha dovuto ripeterlo in due file perché il suo modulo
 * importa il logger del server; qui niente import, così client e server leggono
 * la STESSA costante e non c'è niente da tenere allineato.
 *
 * ⚠️ Chi cambia questo numero cambia anche il cron della purga
 * (`…_cestino_registro_cron.sql`) se lo porta scritto: il lock della purga lo
 * confronta con questo.
 *
 * Dal 2026-09-25 lo stesso modulo porta anche il SECONDO termine, quello di
 * conservazione degli allegati del registro (`GIORNI_CONSERVAZIONE_ALLEGATI_REGISTRO`,
 * in fondo): stessa purga, stesso cron, un numero diverso.
 */
export const GIORNI_CESTINO_REGISTRO = 7

const GIORNO_MS = 24 * 60 * 60 * 1000

function istante(v: Date | string): number {
  return typeof v === 'string' ? Date.parse(v) : v.getTime()
}

/**
 * L'istante in cui una voce messa nel cestino a `eliminatoIl` diventa purgabile.
 * Sette giorni di 24 ore sull'istante, non sulla data: è lo stesso conto che fa
 * la purga (`eliminato_il < now() - interval '7 days'`), e un cambio d'ora non lo
 * sposta. `null` se l'istante non è leggibile.
 */
export function scadenzaCestino(eliminatoIl: Date | string): Date | null {
  const t = istante(eliminatoIl)
  if (Number.isNaN(t)) return null
  return new Date(t + GIORNI_CESTINO_REGISTRO * GIORNO_MS)
}

/**
 * I giorni INTERI che restano per ripristinare: arrotondati PER DIFETTO.
 *
 * La regola è una sola: la schermata non promette MAI più tempo di quello vero.
 * Chi legge «2 giorni» può tornare fra 40 ore; se ne restavano 30, al ritorno la
 * purga può aver già tolto riga e file, e non c'è un annulla. Promettere meno è
 * innocuo: si ripristina prima del necessario. Quindi a 30 ore si legge «1».
 *
 * Il prezzo, dichiarato: sotto le 24 ore il risultato è 0 anche se la voce è
 * ANCORA ripristinabile. Quel caso lo distingue la UI, non questa funzione:
 * `giorniResiduiCestino(…) === 0 && !cestinoScaduto(…)` vuol dire «meno di un
 * giorno», e va scritto così, mai «0 giorni» (che direbbe il falso nell'altro
 * verso: tutto perso quando invece si fa ancora in tempo).
 *
 * Da scaduto, o con un istante illeggibile, è 0.
 */
export function giorniResiduiCestino(eliminatoIl: Date | string, adesso: Date = new Date()): number {
  const scadenza = scadenzaCestino(eliminatoIl)
  if (!scadenza) return 0
  const restano = scadenza.getTime() - adesso.getTime()
  if (restano <= 0) return 0
  return Math.floor(restano / GIORNO_MS)
}

/** Vero se la voce nel cestino è oltre la custodia (purgabile, non più ripristinabile). */
export function cestinoScaduto(eliminatoIl: Date | string, adesso: Date = new Date()): boolean {
  const scadenza = scadenzaCestino(eliminatoIl)
  if (!scadenza) return false
  return adesso.getTime() >= scadenza.getTime()
}

/**
 * La soglia ISO della purga: si purgano le righe con `eliminato_il` PRIMA di
 * questo istante (`.lt('eliminato_il', sogliaPurgaCestinoRegistro())`).
 */
export function sogliaPurgaCestinoRegistro(adesso: Date = new Date()): string {
  return new Date(adesso.getTime() - GIORNI_CESTINO_REGISTRO * GIORNO_MS).toISOString()
}

/**
 * LA CONSERVAZIONE DEGLI ALLEGATI DEL REGISTRO — un termine diverso dal cestino,
 * e lo stesso posto.
 *
 * DECISIONE DEL TITOLARE (2026-09-25): gli allegati del registro della primaria
 * (`allegati_registro`, bucket `registro-allegati`) si cancellano DEFINITIVAMENTE
 * 365 giorni dopo il CARICAMENTO (`creato_il`), vivi o nel cestino che siano. Vale
 * SOLO per il registro: i documenti del fascicolo (`student_documents`) non hanno
 * questo termine, e non vanno raggiunti da qui.
 *
 * I due termini non si sommano e non si confondono: il cestino conta dall'istante
 * dell'ELIMINAZIONE (`eliminato_il`), la conservazione da quello del CARICAMENTO.
 * Il primo che scade vince: un allegato caricato 364 giorni fa e cestinato ieri
 * sparisce fra un giorno, non fra sei. E la schermata lo dice: il cestino degli
 * allegati promette `ripristinabileFinoAlAllegato` (il minimo dei due), non la sola
 * custodia, e il ripristino rifiuta un allegato oltre la conservazione.
 *
 * Sta qui, accanto a `GIORNI_CESTINO_REGISTRO`, per la stessa ragione: modulo puro,
 * un numero solo, e il lock `cestino-registro-giorni-un-numero-solo` vieta una
 * seconda dichiarazione in `src/`.
 */
export const GIORNI_CONSERVAZIONE_ALLEGATI_REGISTRO = 365

/**
 * La soglia ISO della conservazione: si purgano gli allegati con `creato_il` PRIMA
 * di questo istante (`.lt('creato_il', sogliaConservazioneAllegatiRegistro())`).
 * Giorni di 24 ore sull'istante, come la soglia del cestino.
 */
export function sogliaConservazioneAllegatiRegistro(adesso: Date = new Date()): string {
  return new Date(adesso.getTime() - GIORNI_CONSERVAZIONE_ALLEGATI_REGISTRO * GIORNO_MS).toISOString()
}

/**
 * L'istante in cui un allegato caricato a `creatoIl` esce per conservazione.
 * `null` se l'istante non è leggibile.
 */
export function scadenzaConservazioneAllegato(creatoIl: Date | string): Date | null {
  const t = istante(creatoIl)
  if (Number.isNaN(t)) return null
  return new Date(t + GIORNI_CONSERVAZIONE_ALLEGATI_REGISTRO * GIORNO_MS)
}

/**
 * Vero se l'allegato caricato a `creatoIl` è oltre il termine di conservazione:
 * la purga può averne già tolto il file, quindi non si elenca e non si ripristina.
 *
 * `creato_il` NULL (lo schema lo permette) NON è scaduto: è la stessa regola della
 * purga, il cui `.lt('creato_il', …)` non prende i NULL. Un'età che la riga non
 * dichiara non si inventa né da una parte né dall'altra.
 */
export function conservazioneAllegatoScaduta(
  creatoIl: Date | string | null | undefined,
  adesso: Date = new Date(),
): boolean {
  if (creatoIl == null) return false
  const scadenza = scadenzaConservazioneAllegato(creatoIl)
  if (!scadenza) return false
  return adesso.getTime() >= scadenza.getTime()
}

/**
 * FINO A QUANDO SI RIPRISTINA UN ALLEGATO DEL REGISTRO: il PRIMO dei due termini che
 * scade. La custodia del cestino conta dall'eliminazione, la conservazione dal
 * caricamento: un allegato caricato 360 giorni fa e cestinato ieri lo distrugge la
 * conservazione fra cinque giorni, non il cestino fra sei. Promettere la data del
 * cestino sarebbe il «Ripristina» che la purga smentisce.
 *
 * Senza un `creato_il` leggibile vale la sola custodia (vedi
 * `conservazioneAllegatoScaduta`). `null` se nemmeno l'eliminazione è leggibile.
 */
export function ripristinabileFinoAlAllegato(
  eliminatoIl: Date | string,
  creatoIl: Date | string | null | undefined,
): Date | null {
  const cestino = scadenzaCestino(eliminatoIl)
  if (!cestino) return null
  const conservazione = creatoIl == null ? null : scadenzaConservazioneAllegato(creatoIl)
  if (!conservazione) return cestino
  return conservazione.getTime() < cestino.getTime() ? conservazione : cestino
}

/**
 * I giorni INTERI che restano per ripristinare un allegato del registro, per
 * DIFETTO come `giorniResiduiCestino` (la schermata non promette mai più tempo di
 * quello vero), ma sul termine che scade PRIMA (`ripristinabileFinoAlAllegato`).
 */
export function giorniResiduiAllegatoNelCestino(
  eliminatoIl: Date | string,
  creatoIl: Date | string | null | undefined,
  adesso: Date = new Date(),
): number {
  const scadenza = ripristinabileFinoAlAllegato(eliminatoIl, creatoIl)
  if (!scadenza) return 0
  const restano = scadenza.getTime() - adesso.getTime()
  if (restano <= 0) return 0
  return Math.floor(restano / GIORNO_MS)
}

/**
 * Il filtro PostgREST (per `.or(…)`) che tiene gli allegati ANCORA DENTRO il termine di
 * conservazione: `creato_il` NULL (la purga non li prende) oppure dalla soglia in poi.
 * È il complemento esatto di `.lt('creato_il', sogliaConservazioneAllegatiRegistro())`
 * della purga: ciò che la purga può togliere, il cestino non lo elenca e il ripristino
 * non lo riporta indietro. Il valore va fra virgolette: l'istante ISO porta `:` e `.`.
 */
export function filtroEntroConservazioneAllegati(adesso: Date = new Date()): string {
  return `creato_il.is.null,creato_il.gte."${sogliaConservazioneAllegatiRegistro(adesso)}"`
}
