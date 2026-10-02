// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * COME UN ESITO DELLA PIPELINE VIDEO DIVENTA UNA RISPOSTA HTTP — il numero e la frase di ogni codice.
 *
 * `src/app/api/video-uploads/risposte.ts` è il posto in cui un codice interno (`TOKEN_NON_VALIDO`,
 * `RIPROVA_NON_POSSIBILE`, `ORIGINALE_DIVERSO`…) diventa due cose per due pubblici diversi: al CLIENT
 * un codice mostrabile e la sua frase, al LOG il codice interno. Le route (apertura, elenco, firma,
 * rinnovo, runner, `PATCH`) lo usano tutte, ed è per questo che i numeri si fissano QUI, una volta,
 * invece di scoprirli uno alla volta in sei file di test.
 *
 * ─── LA TABELLA È SCRITTA PER ESTESO ─────────────────────────────────────────
 * Un test che ricavasse i numeri dalla stessa mappa che prova sarebbe verde anche con la mappa
 * sbagliata. Qui ogni codice della PR 2 ha il suo numero scritto a mano, con il motivo accanto: è la
 * decisione del 2026-10-02, e chi la cambia deve cambiare anche questa riga.
 */

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))

vi.mock('@/lib/logging/logger', () => ({
  logEvento: h.logEvento,
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))

import {
  CHIAVI_MESSAGGIO_VIDEO,
  CODICI_BORDO_VIDEO,
  CODICI_ESITO_VIDEO,
  CODICI_MOSTRATI_VIDEO,
  codiceMessaggioVideo,
  type CodiceMostratoVideo,
} from '@/lib/media/video/contratto'
import itShared from '../../messages/it/shared.json'
import { rispostaEsitoRpc, rispostaVideo, statoHttpVideo } from '@/app/api/video-uploads/risposte'

const catIt = itShared as Record<string, string>

beforeEach(() => {
  h.logEvento.mockClear()
})

/** Il numero HTTP che ogni codice della PR 2 deve avere, e il perché in una riga. */
const STATI_PR2: Array<[string, number, string]> = [
  // ── I destinatari e la pubblicazione
  ['DESTINATARI_MANCANTI', 400, 'una richiesta incompleta (deciso dalla spec)'],
  ['BROADCAST_CON_TAG', 400, 'come POST /api/gallery, che è lo stesso rifiuto'],
  ['NESSUN_DESTINATARIO', 422, 'richiesta giusta, risultato non pubblicabile'],
  ['PUBBLICAZIONE_NON_RIUSCITA', 500, 'un guasto nostro'],
  ['RIPROVA_NON_POSSIBILE', 409, 'un rifiuto ordinario (deciso dalla spec)'],
  ['NON_AUTOMATICA', 409, 'come INVALID_STATE: l’intento non è nello stato giusto'],
  // ── Il rinnovo e il file arrivato
  ['TOKEN_NON_VALIDO', 404, 'UNIFORME: assente, sconosciuto, scaduto o revocato non si distinguono'],
  ['ORIGINALE_DIVERSO', 422, 'il file non è utilizzabile, come le verifiche dell’uscita'],
  ['ORIGINALE_SOSTITUITO', 409, 'due processi si sono incrociati'],
  // ── Il runner
  ['CAPACITA_PIENA', 409, '«non ora»: un tetto pieno non è un guasto'],
  ['GIA_SORVEGLIATO', 409, 'come LEASE_ACTIVE'],
  ['POST_FALLITO', 503, 'la rete fra il database e il runner, come SANDBOX_UNAVAILABLE'],
  ['URL_ASSENTE', 500, 'configurazione mancante: un incidente'],
  // ── Difetti di chi chiama una RPC
  ['TAG_NON_DELL_INTENTO', 500, 'il guardiano della privacy: deve fare rumore'],
  ['FILE_URL_NON_VALIDO', 500, 'un percorso composto male dal pubblicatore'],
  ['FINALIZE_RIFIUTATO', 500, 'un rifiuto muto non dovrebbe esistere'],
  // ── I due `error_code` che SQL scrive da solo
  ['UPLOAD_ABBANDONATO', 404, 'un caricamento scaduto è un caricamento che non c’è più'],
  ['CONVERSIONE_INCAGLIATA', 500, 'una coda ferma una settimana è un guasto nostro'],
]

describe('video-uploads · il numero HTTP di ogni codice della PR 2', () => {
  it.each(STATI_PR2)('%s → %i (%s)', (codice, atteso) => {
    expect(statoHttpVideo(codice)).toBe(atteso)
  })

  it('un codice che non si riconosce, o assente, è un guasto: 500 — mai un rifiuto inventato', () => {
    for (const ignoto of ['CODICE_MAI_VISTO', 'PGRST204', '', null, undefined]) {
      expect(statoHttpVideo(ignoto), String(ignoto)).toBe(500)
    }
  })

  it('la tabella copre OGNI codice del contratto con un numero 4xx o 5xx', () => {
    // Il `Record` è totale per il compilatore; qui lo si guarda a runtime, perché un `?? 500`
    // implicito vale come decisione solo se qualcuno l'ha presa. Non si prova che il numero sia
    // «giusto» (lo fanno le righe sopra e quelle del runner): si prova che non sia 200 o un refuso.
    for (const codice of [...CODICI_ESITO_VIDEO, ...CODICI_BORDO_VIDEO]) {
      const stato = statoHttpVideo(codice)
      expect(stato >= 400 && stato <= 599, `${codice} → ${stato}`).toBe(true)
    }
  })

  it('i dieci del runner e i guasti nostri restano 5xx; i rifiuti ordinari restano 4xx', () => {
    // La distinzione che conta davvero: 409 e 500 non si mescolano. Una riga `error` per un rifiuto
    // ordinario è una segnalazione notturna per qualcosa che ha funzionato; una riga `warn` per un
    // guasto vero lo nasconde.
    for (const codice of ['BUILD_DOWNLOAD_FAILED', 'ENCODE_FAILED', 'OUTPUT_UPLOAD_FAILED', 'CONVERSION_TIMEOUT']) {
      expect(statoHttpVideo(codice), codice).toBeGreaterThanOrEqual(500)
    }
    for (const codice of ['INVALID_STATE', 'REVISION_MISMATCH', 'LEASE_ACTIVE', 'RETRY_NOT_DUE']) {
      expect(statoHttpVideo(codice), codice).toBe(409)
    }
    expect(statoHttpVideo('CLIENT_UPDATE_REQUIRED')).toBe(409)
  })
})

describe('video-uploads · la frase di ogni codice mostrabile', () => {
  it.each([...CODICI_MOSTRATI_VIDEO].filter((c) => c !== 'SEDE_DA_SPECIFICARE'))(
    '%s esce con la sua frase italiana e il suo codice, nello stato che gli si dà',
    async (codice) => {
      const risposta = rispostaVideo(codice as CodiceMostratoVideo, 418)
      expect(risposta.status).toBe(418)
      const corpo = (await risposta.json()) as { error: string; codice: string }
      // La STESSA stringa che legge un utente italiano: le due strade non possono divergere.
      expect(corpo.error).toBe(catIt[CHIAVI_MESSAGGIO_VIDEO[codice as CodiceMostratoVideo]])
      expect(corpo.error.trim().length).toBeGreaterThan(10)
      expect(corpo.codice).toBe(codice)
    },
  )

  it('la sede ambigua passa dal costruttore che esiste già: una frase sola per lo stesso rifiuto', async () => {
    const risposta = rispostaVideo('SEDE_DA_SPECIFICARE', 400)
    expect(risposta.status).toBe(400)
    expect(((await risposta.json()) as { codice: string }).codice).toBe('SEDE_DA_SPECIFICARE')
  })
})

describe('video-uploads · `rispostaEsitoRpc`: codice mostrabile al client, codice interno al log', () => {
  const corpoDi = async (codice: string) => {
    const risposta = rispostaEsitoRpc('gallery', 'video-uploads:PATCH', 'video_intent_pubblicazione_riprova', codice, {
      utente: 'u1',
    })
    return { stato: risposta.status, corpo: (await risposta.json()) as { error: string; codice: string } }
  }

  it('il «Riprova» arrivato tardi: 409, la frase del «Riprova non possibile», e `warn` nel log', async () => {
    const { stato, corpo } = await corpoDi('RIPROVA_NON_POSSIBILE')
    expect(stato).toBe(409)
    expect(corpo.codice).toBe('VIDEO_RIPROVA_NON_POSSIBILE')
    expect(corpo.error).toBe(catIt.erroreVideoRiprovaNonPossibile)
    expect(h.logEvento).toHaveBeenCalledWith(
      'galleria',
      'warn',
      expect.objectContaining({
        esito: 'rpc-rifiutata',
        tipo: 'video_intent_pubblicazione_riprova',
        error_code: 'RIPROVA_NON_POSSIBILE',
        stato: 409,
      }),
    )
  })

  it('i destinatari mancanti: 400 con la frase che dice cosa fare', async () => {
    const { stato, corpo } = await corpoDi('DESTINATARI_MANCANTI')
    expect(stato).toBe(400)
    expect(corpo.codice).toBe('VIDEO_DESTINATARI_MANCANTI')
    expect(corpo.error).toBe(catIt.erroreVideoDestinatariMancanti)
  })

  it('il token di rinnovo non valido risponde IDENTICO a «non trovato»: un 404 uniforme, senza indizi', async () => {
    // La spec lo chiede per token assente, sconosciuto, scaduto o revocato: chi indovina non deve
    // poter distinguere «non è mai esistito» da «è scaduto». Il corpo, lo stato e il codice sono gli
    // stessi di un intento che non c'è.
    const token = await corpoDi('TOKEN_NON_VALIDO')
    const nonTrovato = await corpoDi('NOT_FOUND')
    expect(token.stato).toBe(404)
    expect(token).toEqual(nonTrovato)
    expect(token.corpo.codice).toBe('VIDEO_NON_TROVATO')
  })

  it('il guardiano della privacy che scatta fa RUMORE: 500, `error` nel log, e la frase del ripiego a chi guarda', async () => {
    const { stato, corpo } = await corpoDi('TAG_NON_DELL_INTENTO')
    expect(stato).toBe(500)
    expect(corpo.codice).toBe('VIDEO_OPERAZIONE_NON_RIUSCITA')
    expect(h.logEvento).toHaveBeenCalledWith(
      'galleria',
      'error',
      expect.objectContaining({ error_code: 'TAG_NON_DELL_INTENTO', stato: 500 }),
    )
  })

  it('un tetto pieno non è un incidente: `warn`, non `error`', async () => {
    await corpoDi('CAPACITA_PIENA')
    expect(h.logEvento).toHaveBeenCalledWith('galleria', 'warn', expect.objectContaining({ error_code: 'CAPACITA_PIENA', stato: 409 }))
    h.logEvento.mockClear()
    // Una configurazione che manca, invece, sì (AGENTS §4).
    await corpoDi('URL_ASSENTE')
    expect(h.logEvento).toHaveBeenCalledWith('galleria', 'error', expect.objectContaining({ error_code: 'URL_ASSENTE', stato: 500 }))
  })

  it('il canale News logga sull’area `news`, la Galleria su `galleria`', () => {
    rispostaEsitoRpc('news', 'video-uploads:POST', 'video_intent_open', 'BAD_INPUT')
    expect(h.logEvento).toHaveBeenCalledWith('news', 'error', expect.objectContaining({ error_code: 'BAD_INPUT' }))
  })

  it('NESSUN codice interno esce verso il client: per ognuno il corpo porta solo un codice mostrabile e la sua frase', async () => {
    const mostrabili = new Set<string>(CODICI_MOSTRATI_VIDEO)
    for (const interno of [...CODICI_ESITO_VIDEO, ...CODICI_BORDO_VIDEO]) {
      const { stato, corpo } = await corpoDi(interno)
      const mostrato = codiceMessaggioVideo(interno)
      expect(mostrabili.has(corpo.codice), `${interno} → ${corpo.codice}`).toBe(true)
      expect(corpo.codice, interno).toBe(mostrato)
      expect(stato, interno).toBe(statoHttpVideo(interno))
      // Il nome interno non compare da nessuna parte nel corpo: è il vocabolario della pipeline.
      // Come PAROLA INTERA: i nomi mostrabili contengono spesso quelli interni
      // (`VIDEO_DESTINATARI_MANCANTI` contiene `DESTINATARI_MANCANTI`), e un `toContain` nudo
      // griderebbe al lupo su una risposta giusta.
      const comeParola = new RegExp(`(?<![A-Z0-9_])${interno}(?![A-Z0-9_])`)
      expect(comeParola.test(JSON.stringify(corpo)), `${interno} è uscito verso il client`).toBe(false)
      expect(corpo.error.trim().length, interno).toBeGreaterThan(10)
    }
  })

  it('un codice assente cade sul ripiego, mai su un corpo vuoto', async () => {
    const risposta = rispostaEsitoRpc('gallery', 'op', 'rpc', undefined)
    expect(risposta.status).toBe(500)
    const corpo = (await risposta.json()) as { codice: string; error: string }
    expect(corpo.codice).toBe('VIDEO_OPERAZIONE_NON_RIUSCITA')
    expect(corpo.error).toBe(catIt.erroreVideoOperazioneNonRiuscita)
    expect(h.logEvento).toHaveBeenCalledWith('galleria', 'error', expect.objectContaining({ error_code: 'SENZA_CODICE' }))
  })
})
