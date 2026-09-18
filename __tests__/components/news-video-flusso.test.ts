import { describe, it, expect, vi, beforeEach } from 'vitest'

import { SEDE_A } from '../fixtures/sedi'

vi.mock('@/lib/logging/client', () => ({
  logClient: vi.fn(),
  nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'sconosciuto'),
}))

import { logClient } from '@/lib/logging/client'
import {
  ACCEPT_VIDEO_NEWS,
  annullaJobVideoNews,
  apriIntentoVideoNews,
  codiceMostrato,
  confermaIntentoVideoNews,
  leggiStatoIntentoVideoNews,
  preflightVideoNews,
  segnalaVideoCaricato,
} from '@/components/features/admin/news/video/flusso'
import {
  DIMENSIONE_BLOCCO_TUS_BYTE,
  BUCKET_ORIGINALI_VIDEO,
} from '@/lib/media/video/contratto'
import { MAX_VIDEO_DURATION_SECONDS, MAX_VIDEO_INPUT_BYTES } from '@/lib/media/video/limiti'

/**
 * IL FLUSSO CHE L'EDITOR DELLE COMUNICAZIONI PERCORRE PER UN VIDEO.
 *
 * Quattro cose si misurano qui, e ognuna ha già fatto danni altrove:
 *
 *  1. IL SUFFISSO DEI CODEC. `MediaRecorder` e diversi selettori Android
 *     consegnano `video/mp4;codecs=avc1.42E01E,mp4a.40.2`. Un confronto per
 *     uguaglianza lo respinge, e il 2026-09-08 su questa stessa app ha respinto
 *     33 caricamenti validi in un giorno. Il preflight non deve nemmeno
 *     sfiorarlo.
 *
 *  2. IL TETTO NON SI SCRIVE DUE VOLTE. I byte e i secondi vengono da
 *     `@/lib/media/video/limiti`: se domani il piano cambia i 2 GB, l'editor
 *     cambia con lui. Un `2_000_000_000` scritto qui sarebbe un secondo tetto
 *     che diverge al primo ripensamento.
 *
 *  3. IL CODICE DEL SERVER NON SI RIMAPPA. `codiceMessaggioVideo` traduce i
 *     codici INTERNI (`FILE_TOO_LARGE`) in codici mostrabili; dargli in pasto un
 *     codice già mostrabile (`VIDEO_TROPPO_GRANDE`) lo fa cadere sul ripiego
 *     generico — cioè trasforma «questo video supera i 2 GB» in «l’operazione non
 *     è riuscita», che non dice a nessuno cosa fare.
 *
 *  4. OGNI SCRITTURA DICHIARA LA SUA SEDE. Una News di plesso manda `scuolaId`;
 *     una «tutte le sedi» manda `null` **e** `ambitoGlobale: true`, che è l'unica
 *     combinazione che `schemaAperturaIntentVideo` accetta con `scuolaId` nullo.
 */

const UTENTE = '11111111-1111-4111-8111-111111111111'
const INTENTO = '33333333-3333-4333-8333-333333333333'
const JOB = '22222222-2222-4222-8222-222222222222'

function fileFinto(over: Partial<{ name: string; size: number; type: string }> = {}) {
  return {
    name: over.name ?? 'recita.mp4',
    size: over.size ?? 12_345_678,
    type: over.type ?? 'video/mp4',
  }
}

function rispostaApertura() {
  return {
    intentId: INTENTO,
    revisione: 1,
    canale: 'news',
    scadenzaCaricamentoIl: '2026-09-18T12:00:00.000Z',
    job: [
      {
        jobId: JOB,
        chiaveIdempotenza: 'chiave-1',
        caricamento: {
          protocollo: 'tus',
          endpoint: 'https://esempio.supabase.co/storage/v1/upload/resumable/sign',
          bucket: BUCKET_ORIGINALI_VIDEO,
          percorso: `${UTENTE}/abc.mp4`,
          contentType: 'video/mp4',
          dimensioneBloccoByte: DIMENSIONE_BLOCCO_TUS_BYTE,
        },
        firma: 'firma-finta',
      },
    ],
  }
}

/** Un `fetch` finto che registra le chiamate e risponde con ciò che gli si dà. */
function finestra(risposte: Array<{ ok: boolean; status: number; corpo: unknown }>) {
  const chiamate: Array<{ url: string; init: RequestInit | undefined }> = []
  let i = 0
  const fetchFinto = (url: string | URL | Request, init?: RequestInit) => {
    chiamate.push({ url: String(url), init })
    const r = risposte[Math.min(i++, risposte.length - 1)]
    return Promise.resolve({
      ok: r.ok,
      status: r.status,
      json: () => Promise.resolve(r.corpo),
    } as unknown as Response)
  }
  return { chiamate, dip: { fetch: fetchFinto as unknown as typeof fetch, userId: UTENTE } }
}

beforeEach(() => {
  vi.mocked(logClient).mockClear()
})

describe('il preflight del video, prima che parta un solo byte', () => {
  it('l’accept comprende i video e NON è un elenco di tipi esatti', () => {
    expect(ACCEPT_VIDEO_NEWS).toContain('video/*')
  })

  it('accetta il MIME col suffisso dei codec', () => {
    const esito = preflightVideoNews(fileFinto({ type: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2' }), 40)
    expect(esito.ok).toBe(true)
    // Al server va il tipo BASE: `estensioneVideoDaMime` e il `contentType` delle
    // coordinate non tollerano i parametri del produttore.
    expect(esito.ok && esito.mime).toBe('video/mp4')
  })

  it('accetta un file che il selettore consegna senza tipo', () => {
    const esito = preflightVideoNews(fileFinto({ type: '' }), null)
    expect(esito.ok).toBe(true)
    expect(esito.ok && esito.mime).toBe('application/octet-stream')
  })

  it('rifiuta oltre il tetto dei byte, con il codice che dice cosa fare', () => {
    const esito = preflightVideoNews(fileFinto({ size: MAX_VIDEO_INPUT_BYTES + 1 }), 10)
    expect(esito).toEqual({ ok: false, codice: 'VIDEO_TROPPO_GRANDE' })
  })

  it('rifiuta un file vuoto', () => {
    expect(preflightVideoNews(fileFinto({ size: 0 }), 10)).toEqual({
      ok: false,
      codice: 'VIDEO_FILE_NON_VALIDO',
    })
  })

  it('rifiuta oltre il tetto dei secondi, quando il browser la durata la sa', () => {
    expect(preflightVideoNews(fileFinto(), MAX_VIDEO_DURATION_SECONDS + 0.5)).toEqual({
      ok: false,
      codice: 'VIDEO_TROPPO_LUNGO',
    })
  })

  it('NON rifiuta quando la durata non si è potuta misurare', () => {
    expect(preflightVideoNews(fileFinto(), null).ok).toBe(true)
  })

  it('accetta esattamente il tetto, che è incluso', () => {
    expect(preflightVideoNews(fileFinto({ size: MAX_VIDEO_INPUT_BYTES }), MAX_VIDEO_DURATION_SECONDS).ok).toBe(true)
  })
})

describe('il codice mostrabile che arriva dal server', () => {
  it('resta quello che è: non lo si passa da `codiceMessaggioVideo`', () => {
    expect(codiceMostrato({ codice: 'VIDEO_TROPPO_GRANDE' })).toBe('VIDEO_TROPPO_GRANDE')
    expect(codiceMostrato({ codice: 'VIDEO_APP_DA_AGGIORNARE' })).toBe('VIDEO_APP_DA_AGGIORNARE')
    expect(codiceMostrato({ codice: 'SEDE_DA_SPECIFICARE' })).toBe('SEDE_DA_SPECIFICARE')
  })

  it('un codice sconosciuto, o assente, ripiega senza lasciare la schermata muta', () => {
    expect(codiceMostrato({ codice: 'PGRST204' })).toBe('VIDEO_OPERAZIONE_NON_RIUSCITA')
    expect(codiceMostrato(null)).toBe('VIDEO_OPERAZIONE_NON_RIUSCITA')
    expect(codiceMostrato({})).toBe('VIDEO_OPERAZIONE_NON_RIUSCITA')
  })
})

describe('l’apertura dell’intento', () => {
  it('dichiara la sede, il canale e l’azione, e restituisce le coordinate', async () => {
    const { chiamate, dip } = finestra([{ ok: true, status: 200, corpo: rispostaApertura() }])
    const esito = await apriIntentoVideoNews(dip, {
      scuolaId: SEDE_A,
      ambitoGlobale: false,
      chiaveIdempotenza: 'chiave-1',
      file: fileFinto(),
      mime: 'video/mp4',
      durataSecondi: 40,
    })

    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    expect(esito.intentId).toBe(INTENTO)
    expect(esito.revisione).toBe(1)
    expect(esito.jobId).toBe(JOB)
    expect(esito.coordinate.dimensioneBloccoByte).toBe(DIMENSIONE_BLOCCO_TUS_BYTE)
    expect(esito.firma).toBe('firma-finta')

    const corpo = JSON.parse(String(chiamate[0].init?.body))
    expect(corpo.canale).toBe('news')
    expect(corpo.azione).toBe('attach_private')
    expect(corpo.scuolaId).toBe(SEDE_A)
    expect(corpo.ambitoGlobale).toBe(false)
    expect(corpo.targetId).toBeNull()
    expect(corpo.versioneTargetAttesa).toBeNull()
    expect(corpo.file).toHaveLength(1)
    expect(corpo.file[0].mime).toBe('video/mp4')
    expect(corpo.file[0].durataSecondi).toBe(40)
  })

  it('«tutte le sedi» manda `scuolaId: null` INSIEME a `ambitoGlobale: true`', async () => {
    const { chiamate, dip } = finestra([{ ok: true, status: 200, corpo: rispostaApertura() }])
    await apriIntentoVideoNews(dip, {
      scuolaId: null,
      ambitoGlobale: true,
      chiaveIdempotenza: 'chiave-1',
      file: fileFinto(),
      mime: 'video/mp4',
      durataSecondi: null,
    })
    const corpo = JSON.parse(String(chiamate[0].init?.body))
    expect(corpo.scuolaId).toBeNull()
    expect(corpo.ambitoGlobale).toBe(true)
    expect(corpo.file[0].durataSecondi).toBeNull()
  })

  it('un rifiuto del server porta al client il SUO codice, non un ripiego', async () => {
    const { dip } = finestra([
      { ok: false, status: 413, corpo: { error: 'prosa italiana del server', codice: 'VIDEO_TROPPO_GRANDE' } },
    ])
    const esito = await apriIntentoVideoNews(dip, {
      scuolaId: SEDE_A,
      ambitoGlobale: false,
      chiaveIdempotenza: 'chiave-1',
      file: fileFinto(),
      mime: 'video/mp4',
      durataSecondi: null,
    })
    expect(esito).toEqual({ ok: false, codice: 'VIDEO_TROPPO_GRANDE' })
  })

  it('una risposta che non rispetta il contratto non diventa coordinate a caso', async () => {
    const rotta = rispostaApertura()
    // Il blocco TUS è un valore solo: 6 MiB. Un altro numero significa upload che
    // ripartono da capo su rete mobile — e lo schema lo rifiuta.
    rotta.job[0].caricamento.dimensioneBloccoByte = 1024
    const { dip } = finestra([{ ok: true, status: 200, corpo: rotta }])
    const esito = await apriIntentoVideoNews(dip, {
      scuolaId: SEDE_A,
      ambitoGlobale: false,
      chiaveIdempotenza: 'chiave-1',
      file: fileFinto(),
      mime: 'video/mp4',
      durataSecondi: null,
    })
    expect(esito).toEqual({ ok: false, codice: 'VIDEO_OPERAZIONE_NON_RIUSCITA' })
    // Un contratto rotto è un difetto NOSTRO: non può passare in silenzio.
    expect(vi.mocked(logClient)).toHaveBeenCalled()
  })

  it('una rete caduta non lascia la schermata muta e lascia una riga di log', async () => {
    const dip = {
      fetch: (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch,
      userId: UTENTE,
    }
    const esito = await apriIntentoVideoNews(dip, {
      scuolaId: SEDE_A,
      ambitoGlobale: false,
      chiaveIdempotenza: 'chiave-1',
      file: fileFinto(),
      mime: 'video/mp4',
      durataSecondi: null,
    })
    expect(esito).toEqual({ ok: false, codice: 'VIDEO_OPERAZIONE_NON_RIUSCITA' })
    expect(vi.mocked(logClient)).toHaveBeenCalled()
  })

  it('il nome del file non finisce MAI in un log', async () => {
    const dip = {
      fetch: (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch,
      userId: UTENTE,
    }
    await apriIntentoVideoNews(dip, {
      scuolaId: SEDE_A,
      ambitoGlobale: false,
      chiaveIdempotenza: 'chiave-1',
      file: fileFinto({ name: 'recita-di-mario-rossi.mov' }),
      mime: 'video/quicktime',
      durataSecondi: null,
    })
    const scritto = JSON.stringify(vi.mocked(logClient).mock.calls)
    expect(scritto).not.toContain('mario')
    expect(scritto).not.toContain('recita')
  })
})

describe('le azioni sull’intento', () => {
  it('«caricato» dichiara i byte e il tipo rimisurati sul file', async () => {
    const { chiamate, dip } = finestra([{ ok: true, status: 200, corpo: { intentId: INTENTO, job: [] } }])
    const esito = await segnalaVideoCaricato(dip, INTENTO, JOB, { byte: 999, mime: 'video/mp4' })
    expect(esito.ok).toBe(true)
    expect(chiamate[0].url).toContain(`/api/video-uploads/${INTENTO}`)
    expect(chiamate[0].init?.method).toBe('PATCH')
    const corpo = JSON.parse(String(chiamate[0].init?.body))
    expect(corpo).toEqual({ azione: 'caricato', jobId: JOB, byte: 999, mime: 'video/mp4' })
  })

  it('«conferma» porta la revisione: è l’istante in cui la persona si impegna', async () => {
    const { chiamate, dip } = finestra([{ ok: true, status: 200, corpo: { intentId: INTENTO, job: [] } }])
    await confermaIntentoVideoNews(dip, INTENTO, 3)
    expect(JSON.parse(String(chiamate[0].init?.body))).toEqual({ azione: 'conferma', revisione: 3 })
  })

  it('«annulla-job» toglie un allegato solo, non l’intento', async () => {
    const { chiamate, dip } = finestra([{ ok: true, status: 200, corpo: { intentId: INTENTO, job: [] } }])
    await annullaJobVideoNews(dip, INTENTO, JOB)
    expect(JSON.parse(String(chiamate[0].init?.body))).toEqual({ azione: 'annulla-job', jobId: JOB })
  })
})

describe('la lettura dello stato, che è ciò che l’operatore guarda', () => {
  it('riporta gli stati dei job dell’intento', async () => {
    const { chiamate, dip } = finestra([
      {
        ok: true,
        status: 200,
        corpo: {
          intentId: INTENTO,
          revisione: 1,
          canale: 'news',
          statoIntent: 'confirmed',
          aggiornatoIl: '2026-09-18T10:00:00.000Z',
          job: [
            {
              jobId: JOB,
              intentId: INTENTO,
              canale: 'news',
              stato: 'processing',
              avanzamento: 60,
              codice: null,
              aggiornatoIl: '2026-09-18T10:00:00.000Z',
            },
          ],
        },
      },
    ])
    const esito = await leggiStatoIntentoVideoNews(dip, INTENTO)
    expect(chiamate[0].init?.method ?? 'GET').toBe('GET')
    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    expect(esito.job[0].stato).toBe('processing')
    expect(esito.job[0].avanzamento).toBe(60)
  })

  it('scarta uno stato fuori contratto invece di mostrarlo', async () => {
    const { dip } = finestra([
      {
        ok: true,
        status: 200,
        corpo: {
          intentId: INTENTO,
          job: [
            {
              jobId: JOB,
              intentId: INTENTO,
              canale: 'news',
              // Un job fallito SENZA codice lascerebbe la schermata senza niente da dire:
              // lo schema del contratto lo rifiuta, e qui non deve passare.
              stato: 'failed',
              avanzamento: null,
              codice: null,
              aggiornatoIl: '2026-09-18T10:00:00.000Z',
            },
          ],
        },
      },
    ])
    const esito = await leggiStatoIntentoVideoNews(dip, INTENTO)
    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    expect(esito.job).toHaveLength(0)
    expect(vi.mocked(logClient)).toHaveBeenCalled()
  })
})
