import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { MouseEvent } from 'react'

/**
 * APRIRE UN DOCUMENTO FIRMATO NELL'APP 1.1 (spec 2026-09-24, compito NAT3g).
 *
 * Il difetto: nella WebView Capacitor `window.open` torna `null` senza lanciare, e il
 * ramo «bloccato» mostrava un link `target="_blank"` che nella WebView non apre niente.
 * Curriculum, scansione della domanda d'iscrizione, documento d'identità del
 * personale: tre pulsanti muti nell'app, e poi un link muto.
 *
 * Qui si misura che:
 *  1. nell'app NON si apre nessuna scheda e il documento passa da `apriDocumento`
 *     (anteprima di sistema), con la URL FIRMATA e un nome senza pezzi del percorso;
 *  2. l'esito dell'helper si traduce in `aperto` / `errore` (mai `bloccato`);
 *  3. sul web resta tutto com'era: scheda aperta nel gesto, `location.replace`;
 *  4. il link del ripiego, sul web, non viene toccato (niente `preventDefault`); nell'app
 *     ferma la navigazione e apre l'anteprima, e dice al pannello quando non ha
 *     consegnato niente.
 */

const h = vi.hoisted(() => ({
  nativo: false,
  apriDocumento: vi.fn(),
  logClient: vi.fn(),
}))

vi.mock('@/lib/push/native-register', () => ({ isNativeApp: () => h.nativo }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: () => 'TypeError' }))
vi.mock('@/lib/native/scarica', async (importOriginal) => {
  const originale = await importOriginal<typeof import('@/lib/native/scarica')>()
  return { ...originale, apriDocumento: h.apriDocumento }
})

import { apriDocumentoFirmato, apriLinkNellApp } from '@/lib/ui/apri-documento-firmato'

const URL_FIRMATA = 'https://storage.esempio.invalid/object/sign/cv/aaaa/Curriculum%20Persona.pdf?token=xyz'
const PERCORSO = 'aaaa/Curriculum Persona.pdf'

const fetchMock = vi.fn()

function firmaOk() {
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ url: URL_FIRMATA }) })
}

function richiesta() {
  return apriDocumentoFirmato({
    endpoint: '/api/admin/candidature',
    path: PERCORSO,
    headers: { 'x-sedi': 'sede-finta' },
    route: '/admin/candidature',
    etichetta: 'candidatura-cv',
  })
}

function finestraFinta() {
  const w = {
    closed: false,
    opener: {} as unknown,
    location: { replace: vi.fn() },
    close: vi.fn(() => { w.closed = true }),
  }
  return w
}

beforeEach(() => {
  vi.clearAllMocks()
  h.nativo = false
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('apriDocumentoFirmato · nell’app 1.1', () => {
  beforeEach(() => {
    h.nativo = true
    firmaOk()
  })

  it('NON apre nessuna scheda e passa la URL firmata all’anteprima di sistema', async () => {
    const open = vi.fn(() => finestraFinta())
    vi.stubGlobal('open', open)
    h.apriDocumento.mockResolvedValue({ esito: 'nativo-anteprima' })

    const esito = await richiesta()

    expect(open).not.toHaveBeenCalled()
    expect(esito).toEqual({ esito: 'aperto' })
    expect(h.apriDocumento).toHaveBeenCalledTimes(1)
    const input = h.apriDocumento.mock.calls[0][0]
    expect(input.sorgente).toBe(URL_FIRMATA)
    // Il nome è l'etichetta con l'estensione VERA: il pezzo del percorso (che può
    // portare il nome della persona) non arriva sul dispositivo.
    expect(input.nomeFile).toBe('candidatura-cv.pdf')
    expect(input.etichetta).toBe('candidatura-cv')
    // La firma è stata chiesta con il percorso e con lo scope di sede.
    const [indirizzo, init] = fetchMock.mock.calls[0]
    expect(decodeURIComponent(String(indirizzo))).toContain(`doc=${PERCORSO}`)
    expect((init as RequestInit).headers).toEqual({ 'x-sedi': 'sede-finta' })
  })

  it('il foglio di condivisione (ripiego visibile) vale come aperto', async () => {
    h.apriDocumento.mockResolvedValue({ esito: 'nativo-file', motivo: 'anteprima-OS-PLUG-FLVW-0013' })
    expect(await richiesta()).toEqual({ esito: 'aperto' })
    h.apriDocumento.mockResolvedValue({ esito: 'ripiego-condivisione', motivo: 'http-500' })
    expect(await richiesta()).toEqual({ esito: 'aperto' })
  })

  it('un’anteprima che non consegna niente è un ERRORE, mai «bloccato» col link muto', async () => {
    h.apriDocumento.mockResolvedValue({ esito: 'non-riuscito', motivo: 'http-403' })
    expect(await richiesta()).toEqual({ esito: 'errore', stato: null })
    h.apriDocumento.mockResolvedValue({ esito: 'ripiego-appunti' })
    expect(await richiesta()).toEqual({ esito: 'errore', stato: null })
  })

  it('una firma rifiutata non arriva all’helper e resta l’errore con lo stato del server', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({ codice: 'CANDIDATURA_NON_TROVATA' }) })
    expect(await richiesta()).toEqual({ esito: 'errore', stato: 404 })
    expect(h.apriDocumento).not.toHaveBeenCalled()
  })
})

describe('apriDocumentoFirmato · sul web resta com’era', () => {
  it('scheda aperta nel gesto, poi `location.replace` sulla URL firmata; nessuna anteprima', async () => {
    firmaOk()
    const finestra = finestraFinta()
    const open = vi.fn(() => finestra)
    vi.stubGlobal('open', open)

    const esito = await richiesta()

    expect(open).toHaveBeenCalledWith('', '_blank')
    expect(finestra.location.replace).toHaveBeenCalledWith(URL_FIRMATA)
    expect(finestra.opener).toBeNull()
    expect(esito).toEqual({ esito: 'aperto' })
    expect(h.apriDocumento).not.toHaveBeenCalled()
  })

  it('finestra bloccata → `bloccato` con la URL, come prima', async () => {
    firmaOk()
    vi.stubGlobal('open', vi.fn(() => null))
    expect(await richiesta()).toEqual({ esito: 'bloccato', url: URL_FIRMATA })
    expect(h.apriDocumento).not.toHaveBeenCalled()
  })
})

describe('apriLinkNellApp · il link del ripiego e gli allegati della Segreteria', () => {
  function evento() {
    return { preventDefault: vi.fn() } as unknown as MouseEvent<HTMLElement> & { preventDefault: ReturnType<typeof vi.fn> }
  }

  it('sul WEB non tocca niente: il browser apre la scheda come ieri', () => {
    const e = evento()
    const onNonConsegnato = vi.fn()
    apriLinkNellApp(URL_FIRMATA, 'candidatura-cv', { onNonConsegnato })(e)
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(h.apriDocumento).not.toHaveBeenCalled()
  })

  it('nell’APP ferma la navigazione e apre l’anteprima; col nome mostrato tiene l’estensione vera', async () => {
    h.nativo = true
    h.apriDocumento.mockResolvedValue({ esito: 'nativo-anteprima' })
    const e = evento()
    const onNonConsegnato = vi.fn()
    apriLinkNellApp(URL_FIRMATA, 'compito-allegato', { nomeMostrato: 'Scheda compiti', onNonConsegnato })(e)
    expect(e.preventDefault).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(h.apriDocumento).toHaveBeenCalledTimes(1))
    expect(h.apriDocumento.mock.calls[0][0]).toMatchObject({
      sorgente: URL_FIRMATA,
      nomeFile: 'Scheda compiti.pdf',
      etichetta: 'compito-allegato',
    })
    await Promise.resolve()
    expect(onNonConsegnato).not.toHaveBeenCalled()
  })

  it('nell’APP, senza nome mostrato, il file prende l’etichetta (mai il pezzo del percorso)', async () => {
    h.nativo = true
    h.apriDocumento.mockResolvedValue({ esito: 'nativo-anteprima' })
    apriLinkNellApp(URL_FIRMATA, 'anagrafica-documento')(evento())
    await vi.waitFor(() => expect(h.apriDocumento).toHaveBeenCalledTimes(1))
    expect(h.apriDocumento.mock.calls[0][0].nomeFile).toBe('anagrafica-documento.pdf')
  })

  it('nell’APP un’apertura che non consegna niente lo dice al pannello; annullata no', async () => {
    h.nativo = true
    const onNonConsegnato = vi.fn()
    h.apriDocumento.mockResolvedValue({ esito: 'non-riuscito', motivo: 'foglio-file-non-aperto' })
    apriLinkNellApp(URL_FIRMATA, 'scadenze-documento', { onNonConsegnato })(evento())
    await vi.waitFor(() => expect(onNonConsegnato).toHaveBeenCalledTimes(1))

    const annullata = vi.fn()
    h.apriDocumento.mockResolvedValue({ esito: 'non-riuscito', motivo: 'annullato' })
    apriLinkNellApp(URL_FIRMATA, 'scadenze-documento', { onNonConsegnato: annullata })(evento())
    await vi.waitFor(() => expect(h.apriDocumento).toHaveBeenCalledTimes(2))
    await new Promise((r) => setTimeout(r, 0))
    expect(annullata).not.toHaveBeenCalled()
  })
})
