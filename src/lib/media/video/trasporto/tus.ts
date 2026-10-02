import { logClient, nomeErrore } from '@/lib/logging/client'

import { schemaRispostaFirmaVideo } from '../contratto'
import type { DipendenzeCaricamentoVideo } from '../upload'
import type {
  FirmaDelTrasporto,
  IngressoTrasporto,
  ReteTrasporto,
  TrasportoVideo,
} from './interfaccia'

/**
 * IL TRASPORTO A BLOCCHI (TUS) — l'unico che c'è.
 *
 * L'upload TUS si autentica con una firma che vale due ore (`x-signature`), coniata dalla route
 * con la chiave di servizio: il browser allo Storage non presenta mai un token di sessione. Un
 * originale da un gigabyte su una rete mobile ne dura di più, e una ripresa che avviene ore o
 * giorni dopo la chiusura dell'app non ha nessuna firma in mano. Qui sta tutto ciò che riguarda
 * quella firma, in un posto solo: la schermata della Galleria e le News la rinnovano con la
 * stessa chiamata.
 *
 * ─── IL RINNOVO NON RIAPRE L'INTENTO ────────────────────────────────────────────────────────
 * Fino alla PR 2 l'unico modo di avere una firma nuova era RIAPRIRE l'intento con la stessa
 * chiave di idempotenza: l'apertura restituiva lo stesso job con una firma fresca, ma costava
 * un'apertura intera — i cancelli, la RPC, il `info` sullo Storage — 190 volte per 44 job
 * (misurate prima della PR 2). Adesso è `POST /api/video-uploads/[id]/firma` con `{ jobId }`, che
 * verifica soltanto che il job aspetti ancora i suoi byte e firma di nuovo il SUO percorso.
 *
 * ⚠️ La firma sta in MEMORIA, in questa chiusura, mai nella riga su IndexedDB: sarebbe una
 * credenziale lasciata sul disco (il lock `CHIAVI_RIGA_CARICAMENTO` esiste per impedirlo).
 */

/** Quanto prima della scadenza si rinnova: una PATCH da 6 MiB in volo non deve scoprirlo a metà. */
const MARGINE_RINNOVO_MS = 15_000

const json = (corpo: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(corpo),
})

/**
 * Chiede al server una firma nuova per il job. Risponde `null` quando non c'è più niente da
 * firmare — il job non aspetta più i byte (409 `VIDEO_GIA_CONCLUSO`), l'intento è di un altro,
 * la sessione è scaduta, la rete è giù — e di ogni caso lascia una riga, perché una ripresa che
 * non riesce a rinnovare è una ripresa che non riprende, e senza quella riga nessuno sa perché.
 *
 * Nei log passano solo l'uuid del job, un enumerato e lo stato HTTP: mai la firma, mai il
 * percorso (porta l'uuid di chi carica).
 */
export async function rinnovaFirmaTus(
  rete: ReteTrasporto,
  dati: { intentId: string; jobId: string },
): Promise<FirmaDelTrasporto | null> {
  let res: Response
  try {
    res = await rete(`/api/video-uploads/${encodeURIComponent(dati.intentId)}/firma`, json({ jobId: dati.jobId }))
  } catch (err) {
    logClient({
      livello: 'warn',
      evento: 'fetch',
      messaggio: `video-firma-non-rinnovata: job=${dati.jobId}`,
      campi: { motivo: 'rete', error_code: nomeErrore(err) },
    })
    return null
  }

  const corpo: unknown = await res.json().catch((err: unknown) => {
    logClient({
      livello: 'warn',
      evento: 'fetch',
      messaggio: `video-firma-risposta-illeggibile: job=${dati.jobId}`,
      campi: { stato_http: res.status, error_code: nomeErrore(err) },
    })
    return null
  })

  if (!res.ok) {
    // `stato_http` in `campi` e non `stato`: il 4xx di una route NOSTRA lo registra già il server
    // (`firma-negata`) e `logClient` lo sopprimerebbe — ma qui l'evento è un altro, «la ripresa
    // non ha potuto rinnovare», e dal server non lo vede nessuno.
    const codice = typeof (corpo as { codice?: unknown } | null)?.codice === 'string'
      ? String((corpo as { codice: string }).codice)
      : 'SENZA_CODICE'
    logClient({
      livello: 'warn',
      evento: 'fetch',
      messaggio: `video-firma-non-rinnovata: job=${dati.jobId}`,
      campi: { motivo: 'rifiutata', stato_http: res.status, codice },
    })
    return null
  }

  const letta = schemaRispostaFirmaVideo.safeParse(corpo)
  if (!letta.success) {
    // Un 200 che non rispetta il contratto è un difetto NOSTRO: meglio dire «non lo so» che
    // consegnare allo Storage una credenziale di cui non si conosce la forma.
    logClient({
      livello: 'error',
      evento: 'fetch',
      messaggio: `video-firma-fuori-contratto: job=${dati.jobId}`,
      campi: { campi_errati: letta.error.issues.length },
    })
    return null
  }
  return { firma: letta.data.firma, scadeIl: letta.data.scadeIl }
}

/**
 * Le dipendenze con cui la libreria di caricamento carica UN job: l'archivio, le intestazioni
 * (che si rinnovano da sole in prossimità della scadenza) e `rinnovaFirma` (che la libreria
 * chiama quando lo Storage rifiuta la firma a metà trasferimento).
 *
 * Le due vie al rinnovo fanno lo stesso lavoro, e se si incrociano ne parte UNO solo: due
 * rinnovi insieme sarebbero due richieste per la stessa firma, su una route con un tetto.
 */
export function dipendenzeTus(ingresso: IngressoTrasporto): DipendenzeCaricamentoVideo {
  const { archivio, ancora, rete, jobId, intentId } = ingresso
  let firma = ingresso.iniziale?.firma ?? ''
  let scade = Date.parse(ingresso.iniziale?.scadeIl ?? '') || 0

  /** Il rinnovo in volo: chi arriva mentre c'è già uno aspetta quello, non ne fa partire un secondo. */
  let inCorso: Promise<Record<string, string>> | null = null

  const rinnova = (): Promise<Record<string, string>> => {
    inCorso ??= (async () => {
      const nuova = await rinnovaFirmaTus(rete, { intentId, jobId })
      // Il rinnovo ha aspettato la rete: se nel frattempo la persona ha cambiato sede o lasciato
      // la pagina, la firma di questo giro non serve più a nessuno e NON si consegna a TUS.
      if (!ancora() || !nuova) throw new Error('FirmaNonDisponibile')
      firma = nuova.firma
      scade = Date.parse(nuova.scadeIl ?? '') || 0
      return { 'x-signature': firma }
    })().finally(() => {
      inCorso = null
    })
    return inCorso
  }

  return {
    archivio,
    intestazioni: async () => {
      if (!ancora()) throw new Error('ContestoCambiato')
      // Nessuna firma, o in scadenza: se ne chiede una. È il caso di ogni ripresa a pagina nuova.
      if (!firma || scade <= Date.now() + MARGINE_RINNOVO_MS) return rinnova()
      return { 'x-signature': firma }
    },
    // La libreria chiama con il job che sta caricando: queste dipendenze sono di UN job, e una
    // firma rinnovata per un altro non va consegnata a questo.
    rinnovaFirma: (id) => (id === jobId ? rinnova() : Promise.reject(new Error('JobDiverso'))),
  }
}

export const trasportoTus: TrasportoVideo = {
  nome: 'tus',
  // Il browser ha sempre `XMLHttpRequest`, e le app 1.0/1.1 non conoscono altro.
  disponibile: () => true,
  dipendenze: dipendenzeTus,
}
