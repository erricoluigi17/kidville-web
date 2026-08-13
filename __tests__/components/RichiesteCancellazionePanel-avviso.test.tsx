import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'

import itAdminAltro from '../../messages/it/adminAltro.json'

// =============================================================================
// «QUESTA OPERAZIONE DISTRUGGE» — anche sul canale che confermava alla cieca.
//
// IL DIFETTO, misurato il 2026-08-13. L'avviso era stato scritto per
// `OblioPanel` e montato solo lì. Sulla STESSA pagina (`/admin/gdpr`), dieci
// pixel più su, questo pannello evade la richiesta ex art. 17 presentata dalla
// famiglia — anonimizza il genitore e TUTTI i figli non più iscritti, in blocco,
// con una conferma sola — e continuava a mostrare quattro conteggi di persone e
// nemmeno una parola su pagelle, certificati medici, foto, allegati di chat o
// PDF delle credenziali. Gli stessi bucket, la stessa irreversibilità.
//
// Peggio dell'assenza: l'avviso stava SOTTO, legato alla selezione dell'altro
// pannello. Un operatore che confermava qui poteva leggere là sotto dei numeri
// che appartenevano a un bambino diverso.
//
// La tesi dell'elemento — «il difetto non è un dato non cancellato, è un
// consenso raccolto su un'informazione mancante» — restava in piedi, intatta,
// sul più pericoloso dei due canali.
// =============================================================================

const fetchMock = vi.fn()

const RICHIESTA = {
  id: 'req-1',
  creata_il: '2026-08-13T08:00:00Z',
  parent_nome: 'Genitore Prova',
  alunni_iscritti: 0,
  alunni_non_iscritti: 2,
  alunni_fuori_scope: 0,
}

/** Il dry-run: i conteggi di TUTTI i figli che verranno anonimizzati, sommati. */
const DRY_RUN = {
  dryrun: true,
  parent: 1,
  alunni_non_iscritti: 2,
  alunni_iscritti_mantenuti: 0,
  alunni_fuori_scope: 0,
  pagelle: 3,
  certificati_medici: 1,
  foto_solo_sue: 4,
  foto_di_gruppo: 2,
  foto_non_rimovibili: 0,
  articoli_pubblici: 1,
  allegati_chat: 5,
  file_da_rimuovere: 2,
}

function conDryRun(dry: Record<string, unknown>) {
  fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    if (init?.method === 'POST') return Promise.resolve({ ok: true, json: async () => dry })
    return Promise.resolve({ ok: true, json: async () => [RICHIESTA] })
  })
}

function conDryRunRotto() {
  fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    if (init?.method === 'POST') {
      return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'Errore interno' }) })
    }
    return Promise.resolve({ ok: true, json: async () => [RICHIESTA] })
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  conDryRun(DRY_RUN)
  vi.stubGlobal('fetch', fetchMock)
})

async function monta() {
  const { RichiesteCancellazionePanel } = await import(
    '@/components/features/admin/settings/RichiesteCancellazionePanel'
  )
  return render(<RichiesteCancellazionePanel userId="dir-1" />)
}

async function apriRichiesta() {
  const r = await monta()
  fireEvent.click(await screen.findByText('Genitore Prova'))
  return r
}

/** La `li` dell'elenco «DISTRUGGE» il cui testo è esattamente quello atteso. */
const voce = (testo: string) =>
  screen.getByText(
    (_c, el) => el?.tagName === 'LI' && (el.textContent ?? '').replace(/\s+/g, ' ').trim() === testo,
  )

/** Le voci dell'elenco «DISTRUGGE», nell'ordine in cui stanno a schermo. */
function elencoDistrugge(container: HTMLElement): string[] {
  const titolo = within(container).getByText(itAdminAltro.oblioDistruggeTitolo)
  const riquadro = titolo.closest('div') as HTMLElement
  const prima = riquadro.querySelector('ul') as HTMLElement
  return Array.from(prima.querySelectorAll('li')).map((li) =>
    (li.textContent ?? '').replace(/\s+/g, ' ').trim(),
  )
}

const bottoneRosso = () => screen.getByRole('button', { name: itAdminAltro.oblioBtnAnonimizza })

describe('RichiesteCancellazionePanel — che cosa distrugge, detto prima della conferma', () => {
  it('l’avviso c’è, e PAGELLE e CERTIFICATI MEDICI sono le prime due voci', async () => {
    const { container } = await monta()
    await screen.findByText('Genitore Prova')
    const righe = elencoDistrugge(container)
    expect(righe[0]).toContain(itAdminAltro.oblioDistruggePagelle)
    expect(righe[1]).toContain(itAdminAltro.oblioDistruggeCertificati)
  })

  it('i numeri sono quelli di QUESTA richiesta, sommati su tutti i figli', async () => {
    await apriRichiesta()
    // «Pagelle: 3» sono le pagelle dei due bambini messe insieme: è l'operazione
    // che sta per essere confermata, non quella di un altro pannello.
    await waitFor(() => expect(voce('Pagelle: 3')).toBeInTheDocument())
    expect(voce('Certificati medici: 1')).toBeInTheDocument()
    expect(voce(`${itAdminAltro.oblioDistruggeChat} 5`)).toBeInTheDocument()
    // Il conteggio parziale si legge come tale.
    expect(voce(`${itAdminAltro.oblioDistruggeIscrizione} almeno 2`)).toBeInTheDocument()
  })

  it('prima di scegliere una richiesta non c’è nessun numero inventato', async () => {
    const { container } = await monta()
    await screen.findByText('Genitore Prova')
    for (const riga of elencoDistrugge(container)) {
      expect(riga, `numero comparso senza dry-run: «${riga}»`).not.toMatch(/\d/)
    }
  })

  it('una voce non misurata dice «non misurato», non «0»', async () => {
    // Sul canale in blocco basta UN figlio illeggibile perché il totale non
    // esista: sommare gli altri darebbe un numero più basso del vero.
    conDryRun({ ...DRY_RUN, pagelle: null })
    await apriRichiesta()
    await waitFor(() =>
      expect(
        voce(`${itAdminAltro.oblioDistruggePagelle} ${itAdminAltro.oblioDistruggeNonMisurato}`),
      ).toBeInTheDocument(),
    )
    expect(screen.queryByText('Pagelle: 0')).not.toBeInTheDocument()
  })

  it('accanto alle distruzioni c’è che cosa RESTA (obbligo decennale compreso)', async () => {
    await monta()
    await screen.findByText('Genitore Prova')
    expect(screen.getByText(itAdminAltro.oblioRestaTitolo)).toBeInTheDocument()
    expect(voce(itAdminAltro.oblioRestaPagamenti)).toBeInTheDocument()
  })
})

describe('RichiesteCancellazionePanel — la misura fallita blocca la conferma', () => {
  it('dry-run a 500: lo dice, e il bottone rosso non si può premere', async () => {
    conDryRunRotto()
    await apriRichiesta()
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('alert').textContent).toContain(itAdminAltro.oblioMisuraFallita)

    fireEvent.change(screen.getByPlaceholderText('ANONIMIZZA'), { target: { value: 'ANONIMIZZA' } })
    expect(bottoneRosso()).toBeDisabled()

    fireEvent.click(bottoneRosso())
    const esecuzioni = fetchMock.mock.calls.filter((c) =>
      String(c[1]?.body ?? '').includes('execute'),
    )
    expect(esecuzioni, 'un oblio in BLOCCO è partito con la misura caduta').toHaveLength(0)
  })

  it('con la misura riuscita il bottone si sblocca (controllo positivo)', async () => {
    await apriRichiesta()
    await waitFor(() => expect(voce('Pagelle: 3')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('ANONIMIZZA'), { target: { value: 'ANONIMIZZA' } })
    expect(bottoneRosso()).toBeEnabled()
  })

  it('«Riprova la misura» rifà il dry-run', async () => {
    conDryRunRotto()
    await apriRichiesta()
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())

    conDryRun(DRY_RUN)
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.oblioMisuraRiprova }))
    await waitFor(() => expect(voce('Pagelle: 3')).toBeInTheDocument())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
