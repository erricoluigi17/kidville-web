import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * IL TRASPORTO DEI BYTE — la scelta fra TUS e PUT nativa, e la firma che si rinnova senza riaprire niente.
 *
 * ─── CHE COSA TIENE FERMO QUESTO FILE ───────────────────────────────────────────────────────
 *  1. **Oggi il trasporto è sempre TUS.** `put-nativo` esce solo se un trasporto REGISTRATO (la PR 3)
 *     lo è davvero e dice di essere disponibile: nessun ramo nativo mezzo fatto, e un `disponibile()`
 *     che lancia vale «no».
 *  2. **Il rinnovo della firma passa da `POST /api/video-uploads/[id]/firma`**, mai dalla riapertura
 *     dell'intento (190 aperture per 44 job, misurate prima della PR 2).
 *  3. **Una credenziale arrivata tardi non si consegna**: dopo un logout, un cambio di sede o lo
 *     smontaggio, la firma rinnovata non arriva a TUS.
 *  4. **Nei log, mai la firma.**
 */

const h = vi.hoisted(() => ({ logClient: vi.fn() }))
vi.mock('@/lib/logging/client', () => ({
  logClient: h.logClient,
  nomeErrore: (e: unknown) => (e instanceof Error ? e.constructor.name : 'Sconosciuto'),
}))

import { dipendenzeTus, registraTrasporto, rinnovaFirmaTus, scegliTrasporto, trasportoTus } from '@/lib/media/video/trasporto'
import type { TrasportoVideo } from '@/lib/media/video/trasporto'

const INTENTO = '11111111-0000-4000-8000-000000000011'
const JOB = '22222222-0000-4000-8000-000000000022'
const ALTRO_JOB = '99999999-0000-4000-8000-000000000099'
const COORDINATE = {
  protocollo: 'tus' as const,
  endpoint: 'https://esempio.supabase.co/storage/v1/upload/resumable/sign',
  bucket: 'video_originals' as const,
  percorso: 'aaaa1111-0000-4000-8000-000000000001/abc.mp4',
  contentType: 'video/mp4',
  dimensioneBloccoByte: 6 * 1024 * 1024 as 6291456,
}

const tra = (minuti: number) => new Date(Date.now() + minuti * 60_000).toISOString()
const risposta = (stato: number, corpo: unknown): Response =>
  ({ ok: stato >= 200 && stato < 300, status: stato, json: async () => corpo }) as unknown as Response
const rispostaFirma = (firma: string, scadeIl = tra(120)) => risposta(200, { jobId: JOB, caricamento: COORDINATE, firma, scadeIl })

const archivio = {} as never

function dipendenze(opzioni: {
  rete: (url: string, init?: RequestInit) => Promise<Response>
  iniziale?: { firma: string; scadeIl: string | null } | null
  ancora?: () => boolean
}) {
  return dipendenzeTus({
    archivio,
    jobId: JOB,
    intentId: INTENTO,
    iniziale: opzioni.iniziale,
    ancora: opzioni.ancora ?? (() => true),
    rete: opzioni.rete,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('scegliTrasporto — oggi il TUS, e il nativo solo se qualcuno si registra', () => {
  const nativo = (disponibile: () => boolean): TrasportoVideo => ({
    nome: 'put-nativo',
    disponibile,
    dipendenze: () => {
      throw new Error('non si deve chiamare')
    },
  })

  it('senza nessun trasporto registrato risponde il TUS', () => {
    expect(scegliTrasporto()).toBe(trasportoTus)
    expect(scegliTrasporto().nome).toBe('tus')
    expect(trasportoTus.disponibile()).toBe(true)
  })

  it('un trasporto nativo registrato E disponibile vince; tolto, torna il TUS', () => {
    const tolto = registraTrasporto(nativo(() => true))
    expect(scegliTrasporto().nome).toBe('put-nativo')
    tolto()
    expect(scegliTrasporto().nome).toBe('tus')
  })

  it('un trasporto nativo NON disponibile non si sceglie', () => {
    const tolto = registraTrasporto(nativo(() => false))
    expect(scegliTrasporto().nome).toBe('tus')
    tolto()
  })

  it('un `disponibile()` che lancia vale «no», e lascia una riga', () => {
    const tolto = registraTrasporto(nativo(() => {
      throw new TypeError('plugin non risponde')
    }))
    expect(scegliTrasporto().nome).toBe('tus')
    tolto()
    expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'warn', messaggio: 'video-trasporto-non-verificabile' }))
  })

  it('un trasporto registrato che si chiama «tus» non scavalca quello di serie: conta solo il nativo', () => {
    const finto: TrasportoVideo = { nome: 'tus', disponibile: () => true, dipendenze: () => ({}) as never }
    const tolto = registraTrasporto(finto)
    expect(scegliTrasporto()).toBe(trasportoTus)
    tolto()
  })
})

describe('rinnovaFirmaTus — una richiesta per intento, mai la riapertura', () => {
  it('fa una POST su `/api/video-uploads/<intento>/firma` col solo job nel corpo', async () => {
    const rete = vi.fn(async () => rispostaFirma('firma-nuova'))
    const firma = await rinnovaFirmaTus(rete, { intentId: INTENTO, jobId: JOB })

    expect(firma?.firma).toBe('firma-nuova')
    const [url, init] = rete.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`/api/video-uploads/${INTENTO}/firma`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ jobId: JOB })
  })

  it('un 409 («il job non aspetta più i byte») è «niente da firmare»: `null`, con il codice nel log', async () => {
    const rete = vi.fn(async () => risposta(409, { error: 'x', codice: 'VIDEO_GIA_CONCLUSO' }))
    expect(await rinnovaFirmaTus(rete, { intentId: INTENTO, jobId: JOB })).toBeNull()
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({
        livello: 'warn',
        campi: expect.objectContaining({ motivo: 'rifiutata', stato_http: 409, codice: 'VIDEO_GIA_CONCLUSO' }),
      }),
    )
  })

  it('una rete caduta è `null` e lascia una riga: una ripresa che non rinnova non riprende', async () => {
    const rete = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    expect(await rinnovaFirmaTus(rete, { intentId: INTENTO, jobId: JOB })).toBeNull()
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ campi: expect.objectContaining({ motivo: 'rete' }) }),
    )
  })

  it('un 200 che non rispetta il contratto è un difetto NOSTRO: `null` e una riga `error`', async () => {
    const rete = vi.fn(async () => risposta(200, { jobId: JOB, firma: '' }))
    expect(await rinnovaFirmaTus(rete, { intentId: INTENTO, jobId: JOB })).toBeNull()
    expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error' }))
  })

  it('la firma non entra MAI in un log', async () => {
    const rete = vi.fn(async () => rispostaFirma('FIRMA-SEGRETA-DA-NON-LOGGARE'))
    await rinnovaFirmaTus(rete, { intentId: INTENTO, jobId: JOB })
    await rinnovaFirmaTus(vi.fn(async () => risposta(200, { jobId: JOB, firma: 'FIRMA-SEGRETA-DA-NON-LOGGARE' })), { intentId: INTENTO, jobId: JOB })
    expect(JSON.stringify(h.logClient.mock.calls)).not.toContain('FIRMA-SEGRETA')
  })
})

describe('dipendenzeTus — le intestazioni si rinnovano da sole, e una volta sola', () => {
  it('con la firma iniziale ancora valida le intestazioni non costano una richiesta', async () => {
    const rete = vi.fn()
    const dip = dipendenze({ rete, iniziale: { firma: 'firma-iniziale', scadeIl: tra(120) } })
    expect(await dip.intestazioni()).toEqual({ 'x-signature': 'firma-iniziale' })
    expect(await dip.intestazioni()).toEqual({ 'x-signature': 'firma-iniziale' })
    expect(rete).not.toHaveBeenCalled()
  })

  it('alla ripresa, senza nessuna firma in mano, la PRIMA richiesta ne chiede una e le altre la riusano', async () => {
    const rete = vi.fn(async () => rispostaFirma('firma-di-ripresa'))
    const dip = dipendenze({ rete })
    expect(await dip.intestazioni()).toEqual({ 'x-signature': 'firma-di-ripresa' })
    expect(await dip.intestazioni()).toEqual({ 'x-signature': 'firma-di-ripresa' })
    expect(rete).toHaveBeenCalledTimes(1)
  })

  it('una firma in scadenza (entro il margine) si rinnova prima di partire', async () => {
    const rete = vi.fn(async () => rispostaFirma('firma-fresca'))
    const dip = dipendenze({ rete, iniziale: { firma: 'firma-in-scadenza', scadeIl: new Date(Date.now() + 5_000).toISOString() } })
    expect(await dip.intestazioni()).toEqual({ 'x-signature': 'firma-fresca' })
    expect(rete).toHaveBeenCalledTimes(1)
  })

  it('una firma senza data si tratta come scaduta: nel dubbio si rinnova', async () => {
    const rete = vi.fn(async () => rispostaFirma('firma-fresca'))
    const dip = dipendenze({ rete, iniziale: { firma: 'firma-senza-data', scadeIl: null } })
    expect(await dip.intestazioni()).toEqual({ 'x-signature': 'firma-fresca' })
  })

  it('`rinnovaFirma` forza il rinnovo (lo Storage ha rifiutato la firma) e da lì le intestazioni sono le nuove', async () => {
    const rete = vi.fn(async () => rispostaFirma('firma-nuova'))
    const dip = dipendenze({ rete, iniziale: { firma: 'firma-vecchia', scadeIl: tra(120) } })
    expect(await dip.rinnovaFirma!(JOB)).toEqual({ 'x-signature': 'firma-nuova' })
    expect(await dip.intestazioni()).toEqual({ 'x-signature': 'firma-nuova' })
    expect(rete).toHaveBeenCalledTimes(1)
    expect((rete.mock.calls[0] as unknown as [string])[0]).toBe(`/api/video-uploads/${INTENTO}/firma`)
  })

  it('due rinnovi che si incrociano fanno UNA richiesta sola', async () => {
    let completa!: (r: Response) => void
    const rete = vi.fn(() => new Promise<Response>((risolvi) => { completa = risolvi }))
    const dip = dipendenze({ rete })
    const a = dip.intestazioni()
    const b = dip.rinnovaFirma!(JOB)
    completa(rispostaFirma('firma-unica'))
    expect(await a).toEqual({ 'x-signature': 'firma-unica' })
    expect(await b).toEqual({ 'x-signature': 'firma-unica' })
    expect(rete).toHaveBeenCalledTimes(1)
  })

  it('un rinnovo chiesto per un ALTRO job non si consegna a questo', async () => {
    const rete = vi.fn()
    const dip = dipendenze({ rete })
    await expect(dip.rinnovaFirma!(ALTRO_JOB)).rejects.toThrow('JobDiverso')
    expect(rete).not.toHaveBeenCalled()
  })

  it('se non c’è più niente da firmare le intestazioni rifiutano, e la libreria ricade nel rifiuto di sempre', async () => {
    const rete = vi.fn(async () => risposta(409, { error: 'x', codice: 'VIDEO_GIA_CONCLUSO' }))
    const dip = dipendenze({ rete })
    await expect(dip.intestazioni()).rejects.toThrow('FirmaNonDisponibile')
    // E il rinnovo fallito non resta «in corso»: il prossimo giro riprova invece di aspettare per sempre.
    await expect(dip.rinnovaFirma!(JOB)).rejects.toThrow('FirmaNonDisponibile')
    expect(rete).toHaveBeenCalledTimes(2)
  })

  it('con il contesto cambiato non si chiede nemmeno la firma', async () => {
    const rete = vi.fn()
    const dip = dipendenze({ rete, ancora: () => false })
    await expect(dip.intestazioni()).rejects.toThrow('ContestoCambiato')
    expect(rete).not.toHaveBeenCalled()
  })

  it('UN RINNOVO ARRIVATO TARDI — dopo un logout o un cambio di sede — NON consegna la credenziale', async () => {
    let completa!: (r: Response) => void
    const rete = vi.fn(() => new Promise<Response>((risolvi) => { completa = risolvi }))
    let contestoValido = true
    const dip = dipendenze({ rete, ancora: () => contestoValido })

    const inVolo = dip.rinnovaFirma!(JOB)
    contestoValido = false // la persona esce (o cambia sede) mentre la risposta è in viaggio
    completa(rispostaFirma('FIRMA-ARRIVATA-TARDI'))

    await expect(inVolo).rejects.toThrow('FirmaNonDisponibile')
    // E nemmeno una richiesta successiva la trova: la firma tardiva non è stata tenuta.
    contestoValido = true
    rete.mockImplementationOnce(async () => risposta(409, { error: 'x', codice: 'VIDEO_GIA_CONCLUSO' }))
    await expect(dip.intestazioni()).rejects.toThrow('FirmaNonDisponibile')
  })
})
