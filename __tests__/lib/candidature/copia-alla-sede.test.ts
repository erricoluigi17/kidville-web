import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * L'INVIO DELLA COPIA ALLA CASELLA DEL PLESSO.
 *
 * ─── LE TRE COSE CHE QUESTO FILE DIFENDE ────────────────────────────────────
 *
 *  1. IL RIPIEGO NON È SILENZIOSO. Se una sede non ha l'email in anagrafica, la
 *     copia parte lo stesso su `CANDIDATURE_EMAIL_FALLBACK` — ma la riga è a
 *     livello `error`, non `info`. Un ripiego muto significa che per mesi le
 *     candidature di Aversa arrivano a info@ e nessuno se ne accorge: è
 *     esattamente la forma del guasto delle email delle credenziali, dove tutto
 *     «funzionava» e niente arrivava.
 *
 *  2. NON LANCIA MAI. Quando questa funzione parte la candidatura è GIÀ
 *     registrata. Un'email che non parte non deve poter trasformare un 201 in un
 *     500 — cioè non deve poter far credere a chi ha appena compilato quattro
 *     passi che il suo invio sia fallito.
 *
 *  3. NIENTE PII NEI LOG. Qui passano un nome, un'email e il percorso di un
 *     curriculum. Nei log finiscono solo uuid, booleani e conteggi. `cv_path` in
 *     particolare è la chiave di un gate: un percorso a log è un percorso che
 *     qualcuno può leggere.
 */

const sendEmailDetailed = vi.fn()
const logEvento = vi.fn()
const risolviContestoSede = vi.fn()

vi.mock('@/lib/email/send', () => ({
  sendEmailDetailed: (...a: unknown[]) => sendEmailDetailed(...a) as unknown,
}))
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => logEvento(...a) as unknown,
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))
vi.mock('@/lib/email/contesto', async (originale) => ({
  ...(await originale<typeof import('@/lib/email/contesto')>()),
  risolviContestoSede: (...a: unknown[]) => risolviContestoSede(...a) as unknown,
}))

import { inviaCopiaAllaSede } from '@/lib/candidature/copia-alla-sede'
import { contestoSenzaSede } from '@/lib/email/contesto'
import { SEDE_A, SEDE_B, NOME_SEDE_A } from '../../fixtures/sedi'

// ⚠️ L'uuid dalle FIXTURE, mai quello vero di un plesso. Il lock
// `migrazioni-senza-sede-cablata` lo pretende, e la prima stesura di questo file
// aveva cablato Giugliano: un uuid di produzione dentro un test è il seme di uno
// script che un giorno lo riusa credendolo finto.
const SCUOLA = SEDE_A
const ENTITA = '11111111-1111-1111-1111-111111111111'

const BASE = {
  scuoleIds: [SCUOLA],
  dati: { nome: 'Maria', cognome: 'Rossi', email: 'maria@e.it', posizioni: ['cuoca'] },
  consensi: { presa_visione_informativa: true },
  sediScelte: [NOME_SEDE_A],
  inviataIl: '19/08/2026, 10:30',
  entitaId: ENTITA,
  cvPath: null as string | null,
}

/** Un client Supabase finto: solo lo Storage, che è l'unica cosa che si usa. */
function supabaseCon(risposta: unknown) {
  return {
    storage: { from: () => ({ download: async () => risposta }) },
  } as never
}

/** I campi passati a `logEvento`: sono il TERZO argomento, cioè `c[2]`. */
function campiLoggati(): Record<string, unknown>[] {
  return logEvento.mock.calls.map((c) => (c[2] ?? {}) as Record<string, unknown>)
}

describe('inviaCopiaAllaSede', () => {
  beforeEach(() => {
    sendEmailDetailed.mockReset().mockResolvedValue({ ok: true, error: null, messageId: 'm1' })
    logEvento.mockReset()
    risolviContestoSede.mockReset().mockResolvedValue({
      ...contestoSenzaSede(NOME_SEDE_A),
      email: 'sede.alfa@example.invalid',
    })
    delete process.env.CANDIDATURE_EMAIL_FALLBACK
  })
  afterEach(() => {
    delete process.env.CANDIDATURE_EMAIL_FALLBACK
  })

  it('spedisce alla casella dichiarata nell’anagrafica della sede', async () => {
    await inviaCopiaAllaSede(supabaseCon({ data: null, error: null }), BASE)
    expect(sendEmailDetailed.mock.calls[0][0].to).toEqual(['sede.alfa@example.invalid'])
  })

  /**
   * ─── IL CASO CHE SI È ROTTO IN PRODUZIONE, E CHE QUI NON PUÒ PIÙ PASSARE ───
   *
   * Il 2026-08-20, commit `2e505bd`, questa funzione costruiva il destinatario
   * con `destinatari.join(', ')`. Resend risponde `422 «Invalid to field»` a una
   * stringa che contiene due indirizzi, e in produzione le uniche due
   * candidature rivolte a DUE plessi — arrivate alle 11:01:57 e alle 11:04:26 —
   * non sono state recapitate a nessuna casella di sede. Quelle a una sede sola
   * passavano: il guasto colpiva esattamente il caso per cui la funzione era
   * stata scritta.
   *
   * ⚠️ QUESTA ASSERZIONE NON È RIDONDANTE con quelle in
   * `__tests__/lib/email-send-destinatari.test.ts`, e la differenza è il motivo
   * per cui esiste. Là si verifica che `send.ts` sappia separare una stringa con
   * le virgole: è una RETE DI SICUREZZA, e una rete che funziona rende invisibile
   * l'errore di chi ci cade dentro. Rimettendo il `join` qui, quei test restano
   * verdi — l'ho misurato prima di scrivere questa riga.
   *
   * Solo un'asserzione sul CHIAMANTE, che pretende un array e non una stringa,
   * cade quando il `join` torna. È questa.
   */
  it('DUE plessi → il destinatario è un ELENCO, mai una stringa con le virgole', async () => {
    risolviContestoSede
      .mockResolvedValueOnce({ ...contestoSenzaSede('Alfa'), email: 'alfa@example.invalid' })
      .mockResolvedValueOnce({ ...contestoSenzaSede('Beta'), email: 'beta@example.invalid' })
    await inviaCopiaAllaSede(supabaseCon({ data: null, error: null }), {
      ...BASE,
      scuoleIds: [SCUOLA, SEDE_B],
      sediScelte: ['Alfa', 'Beta'],
    })
    const to = sendEmailDetailed.mock.calls[0][0].to
    expect(Array.isArray(to)).toBe(true)
    expect(to).toEqual(['alfa@example.invalid', 'beta@example.invalid'])
    // E la forma esatta che la produzione rifiuta, dichiarata a parte: se un
    // giorno `to` tornasse a essere una stringa, questa riga nomina il perché.
    expect(typeof to).not.toBe('string')
  })

  it('mette in «rispondi a» l’indirizzo di chi si è candidato', async () => {
    await inviaCopiaAllaSede(supabaseCon({ data: null, error: null }), BASE)
    expect(sendEmailDetailed.mock.calls[0][0].replyTo).toBe('maria@e.it')
  })

  it('anagrafica senza email → livello ERROR, non info: una configurazione mancante è un incidente', async () => {
    risolviContestoSede.mockResolvedValue(contestoSenzaSede('Kidville Beta'))
    process.env.CANDIDATURE_EMAIL_FALLBACK = 'ripiego@example.invalid'
    await inviaCopiaAllaSede(supabaseCon({ data: null, error: null }), BASE)
    expect(logEvento.mock.calls.filter((c) => c[1] === 'error').length).toBeGreaterThan(0)
    expect(sendEmailDetailed.mock.calls[0][0].to).toEqual(['ripiego@example.invalid'])
  })

  it('senza anagrafica E senza ripiego non spedisce, ma lo dice', async () => {
    risolviContestoSede.mockResolvedValue(contestoSenzaSede('Kidville Gamma'))
    const esito = await inviaCopiaAllaSede(supabaseCon({ data: null, error: null }), BASE)
    expect(sendEmailDetailed).not.toHaveBeenCalled()
    expect(esito.ok).toBe(false)
    expect(logEvento.mock.calls.some((c) => c[1] === 'error')).toBe(true)
  })

  it('allega il curriculum in base64, con un nome ricostruito e MAI il percorso del bucket', async () => {
    const contenuto = '%PDF-1.4 finto'
    const blob = { arrayBuffer: async () => new TextEncoder().encode(contenuto).buffer }
    await inviaCopiaAllaSede(supabaseCon({ data: blob, error: null }), {
      ...BASE,
      cvPath: 'candidature/abc123def456.pdf',
    })
    const allegati = sendEmailDetailed.mock.calls[0][0].attachments as { filename: string; content: string }[]
    expect(allegati).toHaveLength(1)
    expect(allegati[0].filename).toBe('curriculum-rossi-maria.pdf')
    // Il nome del bucket è un identificativo tecnico ed è la chiave di un gate:
    // non ha motivo di comparire in una casella di posta.
    expect(allegati[0].filename).not.toContain('abc123')
    expect(allegati[0].content).toBe(Buffer.from(contenuto).toString('base64'))
  })

  it('il nome dell’allegato regge gli accenti e gli spazi senza produrre un file illeggibile', async () => {
    const blob = { arrayBuffer: async () => new TextEncoder().encode('x').buffer }
    await inviaCopiaAllaSede(supabaseCon({ data: blob, error: null }), {
      ...BASE,
      dati: { ...BASE.dati, nome: "Maria Chiará", cognome: "D'Amòre" },
      cvPath: 'candidature/xyz.pdf',
    })
    const allegati = sendEmailDetailed.mock.calls[0][0].attachments as { filename: string }[]
    expect(allegati[0].filename).toBe('curriculum-d-amore-maria-chiara.pdf')
  })

  it('curriculum non scaricabile → l’email PARTE COMUNQUE, senza allegato, e il buco è a log', async () => {
    await inviaCopiaAllaSede(supabaseCon({ data: null, error: { message: 'Object not found' } }), {
      ...BASE,
      cvPath: 'candidature/abc123.pdf',
    })
    // Nessuna email è peggio di un'email senza allegato: perderebbe anche ciò
    // che si poteva consegnare.
    expect(sendEmailDetailed).toHaveBeenCalled()
    expect(sendEmailDetailed.mock.calls[0][0].attachments).toBeUndefined()
    expect(campiLoggati().some((c) => c.esito === 'curriculum-non-allegato')).toBe(true)
  })

  it('logga anche il SUCCESSO: senza, «nessun log» non distingue «tutte partite» da «niente è partito»', async () => {
    await inviaCopiaAllaSede(supabaseCon({ data: null, error: null }), BASE)
    expect(campiLoggati().map((c) => c.esito)).toContain('copia-sede-inviata')
  })

  it('un rifiuto per quota (429) si riporta come rinviabile: «non oggi» non è «non si può»', async () => {
    sendEmailDetailed.mockResolvedValue({ ok: false, error: 'quota esaurita', rinviabile: true })
    const esito = await inviaCopiaAllaSede(supabaseCon({ data: null, error: null }), BASE)
    expect(esito).toEqual({ ok: false, rinviabile: true })
    expect(campiLoggati().map((c) => c.esito)).toContain('copia-sede-non-inviata')
  })

  it('🔴 la quota esaurita GRIDA: qui «rinviabile» vuol dire PERSA, non «riprovo domani»', async () => {
    // Non c'è nessuna coda che riprovi: la candidatura è già registrata e questa
    // funzione finisce. Un `warn` fra mille avrebbe fatto sparire in silenzio il
    // curriculum che la segreteria doveva ricevere — e il caso si ripete su OGNI
    // candidatura fino a mezzanotte, quindi va distinto da «una casella non
    // risponde»: la cura è un'altra.
    sendEmailDetailed.mockResolvedValue({ ok: false, error: 'quota esaurita (429)', rinviabile: true })
    await inviaCopiaAllaSede(supabaseCon({ data: null, error: null }), BASE)
    const grido = logEvento.mock.calls.find(
      (c) => c[1] === 'error' && (c[2] as { esito?: string })?.esito === 'copia-sede-persa-per-quota',
    )
    expect(grido, 'la quota esaurita esce come un warning qualunque').toBeTruthy()
  })

  it('non lancia MAI: la candidatura è già registrata, e un’email non deve poterla annullare', async () => {
    sendEmailDetailed.mockRejectedValue(new Error('rete giù'))
    await expect(
      inviaCopiaAllaSede(supabaseCon({ data: null, error: null }), BASE),
    ).resolves.toMatchObject({ ok: false })
  })

  it('nei log NON finisce mai il nome, l’email o il percorso del curriculum', async () => {
    const blob = { arrayBuffer: async () => new TextEncoder().encode('x').buffer }
    await inviaCopiaAllaSede(supabaseCon({ data: blob, error: null }), {
      ...BASE,
      cvPath: 'candidature/abc123.pdf',
    })
    const tutto = JSON.stringify(logEvento.mock.calls)
    expect(tutto).not.toContain('Maria')
    expect(tutto).not.toContain('maria@e.it')
    expect(tutto).not.toContain('abc123')
  })
})
