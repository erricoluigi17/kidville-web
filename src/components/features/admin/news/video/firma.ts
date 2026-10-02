import type { ArchivioCaricamentiVideo, DipendenzeCaricamentoVideo } from '@/lib/media/video/upload'

/**
 * LA FIRMA TUS DI UN JOB DI NEWS, RINNOVABILE.
 *
 * L'upload TUS si autentica con una firma che vale due ore (`x-signature`, coniata dalla
 * route all'apertura dell'intento): un originale da un gigabyte su una rete mobile ne dura di
 * più, e a metà strada lo Storage comincia a rifiutarla. Qui sta tutto ciò che la riguarda,
 * perché due punti del componente — il giro di un video nuovo e la ripresa al rientro nella
 * pagina — la gestivano con due copie dello stesso codice.
 *
 * ─── DUE VIE AL RINNOVO, UNA SOLA COSA DA FARE ──────────────────────────────
 *
 *  · PROATTIVA: `intestazioni()` risponde con la firma che ha finché manca più del margine
 *    alla scadenza, e la rinnova da sé quando sta per scadere;
 *  · REATTIVA: se lo Storage la rifiuta lo stesso (401/403 a trasferimento avviato), la
 *    libreria chiama `rinnovaFirma` e prosegue dallo stesso offset invece di restituire il video
 *    alla persona come «interrotto».
 *
 * Tutte e due fanno lo stesso lavoro, `rinnova()`, e se si incrociano ne parte UNO solo: due
 * rinnovi insieme sarebbero due aperture dell'intento per la stessa firma.
 *
 * ─── COME SI RINNOVA: IL PERCORSO ATTUALE DELLE NEWS ───────────────────────
 *
 * Per le News il rinnovo è ancora la riapertura dell'intento con la stessa chiave di
 * idempotenza (`apriIntentoVideoNews`), che restituisce lo STESSO job con una firma nuova.
 * La galleria passa invece da `POST /api/video-uploads/[id]/firma`, che non riapre niente:
 * le News potranno usarla cambiando una funzione sola, `rinnova`, che è l'unica cosa che qui
 * dipende dal canale.
 *
 * ⚠️ La firma sta in MEMORIA, in questa chiusura, mai nella riga su IndexedDB: sarebbe una
 * credenziale lasciata sul disco (il lock `CHIAVI_RIGA_CARICAMENTO` esiste per impedirlo).
 */

/** Quanto prima della scadenza si rinnova: una PATCH da 6 MiB in volo non deve scoprirlo a metà. */
const MARGINE_RINNOVO_MS = 15_000

/** La firma di un job e il suo istante di scadenza (ISO), com'è nella risposta di apertura. */
export interface FirmaDelJob {
  firma: string
  scadeIl: string | null
}

export interface OpzioniDipendenzeNews {
  archivio: ArchivioCaricamentiVideo
  jobId: string
  /** La firma con cui l'intento è stato aperto: vale finché non sta per scadere. */
  iniziale: FirmaDelJob
  /** Il contesto (utente e sede) è ancora quello di quando è partito il giro? Se no, niente firma: il giro si ferma. */
  ancora: () => boolean
  /**
   * Chiede una firma nuova per QUESTO job. Risponde `null` quando non c'è più niente da
   * firmare — il job non aspetta più i byte, l'intento si è chiuso, la rete è giù.
   */
  rinnova: () => Promise<FirmaDelJob | null>
}

/** Le intestazioni TUS di una firma. */
function intestazioniDi(firma: string): Record<string, string> {
  return { 'x-signature': firma }
}

/**
 * Le dipendenze con cui la libreria di caricamento carica UN video di News: l'archivio, le
 * intestazioni (che si rinnovano da sole in prossimità della scadenza) e `rinnovaFirma`
 * (che la libreria chiama quando lo Storage rifiuta la firma).
 */
export function dipendenzeCaricamentoNews(opzioni: OpzioniDipendenzeNews): DipendenzeCaricamentoVideo {
  const { archivio, ancora, rinnova } = opzioni
  let firma = opzioni.iniziale.firma
  let scade = Date.parse(opzioni.iniziale.scadeIl ?? '') || 0

  /** Il rinnovo in volo: chi arriva mentre c'è già uno aspetta quello, non ne fa partire un secondo. */
  let inCorso: Promise<Record<string, string>> | null = null

  const rinnovaUnaVolta = (): Promise<Record<string, string>> => {
    inCorso ??= (async () => {
      const nuova = await rinnova()
      // Il rinnovo ha aspettato la rete: se nel frattempo la persona ha cambiato sede o
      // lasciato la pagina, la firma di questo giro non serve più a nessuno.
      if (!ancora() || !nuova) throw new Error('FirmaNonDisponibile')
      firma = nuova.firma
      scade = Date.parse(nuova.scadeIl ?? '') || 0
      return intestazioniDi(firma)
    })().finally(() => {
      inCorso = null
    })
    return inCorso
  }

  return {
    archivio,
    intestazioni: async () => {
      if (!ancora()) throw new Error('ContestoCambiato')
      if (scade <= Date.now() + MARGINE_RINNOVO_MS) return rinnovaUnaVolta()
      return intestazioniDi(firma)
    },
    // La libreria chiama con il job che sta caricando: queste dipendenze sono di UN job, e una
    // firma rinnovata per un altro non va consegnata a questo.
    rinnovaFirma: (jobId) =>
      jobId === opzioni.jobId ? rinnovaUnaVolta() : Promise.reject(new Error('JobDiverso')),
  }
}
