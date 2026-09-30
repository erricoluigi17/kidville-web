import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import itAdminComunicazioni from '../../messages/it/adminComunicazioni.json'
import enAdminComunicazioni from '../../messages/en/adminComunicazioni.json'

/**
 * IL REGISTRO DI VIGILANZA NON DEVE RACCONTARE PIÙ DI QUELLO CHE È SUCCESSO.
 *
 * `chat_vigilanza_accessi.azione` ammette due valori (`CHECK (azione IN
 * ('lettura','ricerca'))`), quindi anche chi guarda soltanto dei CONTEGGI —
 * `admin/chat/docenti-senza-push:GET`, la scheda «Maestre senza notifiche» —
 * scrive `lettura`. Prima quella riga si leggeva «Ha aperto una conversazione ·
 * Su che cosa: — · Quanti: 137», tre volte per apertura con tre sedi: sembrava
 * che qualcuno avesse letto centotrentasette messaggi di famiglie.
 *
 * Qui si collauda la distinzione, e insieme il suo confine: una riga CON
 * `threadId` deve continuare a dire «Ha aperto una conversazione», altrimenti la
 * correzione avrebbe spento il registro invece di renderlo esatto.
 */

const h = vi.hoisted(() => ({ fetchMock: vi.fn(), logClient: vi.fn() }))

vi.mock('@/lib/logging/client', () => ({
  logClient: h.logClient,
  nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'sconosciuto'),
}))

import { RegistroVigilanza } from '@/components/features/admin/messaggi/RegistroVigilanza'

const CONTEGGI = {
  id: 'r1',
  lettoIl: '2026-09-30T08:00:00.000Z',
  azione: 'lettura',
  esito: 'ok',
  operatore: { id: 'u1', nome: 'Verdi Ada', ruolo: 'coordinator' },
  threadId: null,
  alunno: null,
  nMessaggi: 137,
  termine: null,
  ip: '203.0.113.9',
}

const CONVERSAZIONE = {
  ...CONTEGGI,
  id: 'r2',
  threadId: 'f1f1f1f1-0000-4000-8000-000000000001',
  alunno: { nome: 'Alfa Rossi', classe: '2 ANNI' },
  nMessaggi: 12,
}

const risposta = (data: unknown[]) =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ success: true, data, totale: data.length }),
  } as Response)

beforeEach(() => {
  vi.clearAllMocks()
  h.fetchMock.mockImplementation(() => risposta([CONTEGGI, CONVERSAZIONE]))
  vi.stubGlobal('fetch', h.fetchMock)
})

describe('RegistroVigilanza — la riga dei soli conteggi', () => {
  it('una `lettura` SENZA thread non dice «ha aperto una conversazione»', async () => {
    render(<RegistroVigilanza />)
    expect(await screen.findByText(itAdminComunicazioni.registroAzioneElencoNotifiche)).toBeInTheDocument()
    const riga = screen.getByText(itAdminComunicazioni.registroAzioneElencoNotifiche).closest('tr') as HTMLElement
    expect(riga.textContent ?? '').not.toContain(itAdminComunicazioni.registroAzioneLettura)
  })

  it('e i suoi «Quanti» dicono che sono messaggi CONTEGGIATI, non letti', async () => {
    render(<RegistroVigilanza />)
    await screen.findByText(itAdminComunicazioni.registroAzioneElencoNotifiche)
    const riga = screen.getByText(itAdminComunicazioni.registroAzioneElencoNotifiche).closest('tr') as HTMLElement
    // ICU: «137 messaggi conteggiati».
    expect(riga.textContent ?? '').toMatch(/137 messaggi conteggiati/)
  })

  it('una `lettura` CON thread continua a dire «ha aperto una conversazione»', async () => {
    // Il confine della correzione: se anche questa riga cambiasse etichetta, il
    // registro avrebbe smesso di distinguere la spiata vera.
    //
    // ⚠️ La ricerca è dentro la TABELLA: la stessa frase è anche un'opzione della
    // tendina «Tutte le azioni», e `getByText` a pagina intera trova due nodi.
    render(<RegistroVigilanza />)
    await screen.findByText(itAdminComunicazioni.registroAzioneElencoNotifiche)
    const tabella = within(screen.getByRole('table'))
    const riga = tabella.getByText(itAdminComunicazioni.registroAzioneLettura).closest('tr') as HTMLElement
    expect(riga.textContent ?? '').toContain('Alfa Rossi')
    // Qui «Quanti» è il numero nudo: sono messaggi davvero aperti.
    expect(riga.textContent ?? '').not.toMatch(/messaggi conteggiati/)
  })

  it('una `ricerca` resta una ricerca, e i suoi «Quanti» restano il numero nudo', async () => {
    h.fetchMock.mockImplementation(() => risposta([{ ...CONTEGGI, azione: 'ricerca', termine: 'febbre', nMessaggi: 12 }]))
    render(<RegistroVigilanza />)
    // La presenza si aspetta, l'assenza si guarda dopo: un `queryBy` su una
    // pagina ancora vuota è vero per il motivo sbagliato.
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
    const tabella = within(screen.getByRole('table'))
    expect(tabella.getByText(itAdminComunicazioni.registroAzioneRicerca)).toBeInTheDocument()
    expect(tabella.queryByText(itAdminComunicazioni.registroAzioneElencoNotifiche)).not.toBeInTheDocument()
    // Anche una ricerca non ha `threadId`: la regola dei soli conteggi guarda PURE l'azione.
    const riga = tabella.getByText(itAdminComunicazioni.registroAzioneRicerca).closest('tr') as HTMLElement
    expect(riga.textContent ?? '').toContain('12')
    expect(riga.textContent ?? '').not.toMatch(/conteggiati/)
  })

  it('una lettura con thread e ZERO messaggi dice «0», non «—»', async () => {
    h.fetchMock.mockImplementation(() => risposta([{ ...CONVERSAZIONE, nMessaggi: 0 }]))
    render(<RegistroVigilanza />)
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
    const tabella = within(screen.getByRole('table'))
    const riga = tabella.getByText(itAdminComunicazioni.registroAzioneLettura).closest('tr') as HTMLElement
    const celle = Array.from(riga.querySelectorAll('td')).map((c) => (c.textContent ?? '').trim())
    expect(celle).toContain('0')
  })

  it('il sottotitolo nomina anche la consultazione dei conteggi', async () => {
    render(<RegistroVigilanza />)
    await waitFor(() => expect(h.fetchMock).toHaveBeenCalled())
    expect(screen.getByText(itAdminComunicazioni.registroSottotitolo)).toBeInTheDocument()
    expect(itAdminComunicazioni.registroSottotitolo).toMatch(/conteggi/i)
  })

  it('le chiavi nuove esistono in entrambi i cataloghi', () => {
    for (const k of ['registroAzioneElencoNotifiche', 'registroQuantiConteggiati']) {
      expect(itAdminComunicazioni, `manca in it: ${k}`).toHaveProperty(k)
      expect(enAdminComunicazioni, `manca in en: ${k}`).toHaveProperty(k)
    }
  })
})
