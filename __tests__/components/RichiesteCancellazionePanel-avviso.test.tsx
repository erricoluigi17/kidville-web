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

// =============================================================================
// IL REGISTRO DELLA PRIMARIA NON SI ANONIMIZZA (titolare, 2026-10-08 · 2026-10-09).
//
// La richiesta si evade lo stesso — come per i figli ancora iscritti — ma i figli
// col registro della primaria restano. Il pannello lo dice in TRE punti: nella
// riga dell'elenco (prima di aprire), nel dry-run (prima di digitare ANONIMIZZA)
// e dopo l'evasione, quando la richiesta è già sparita dall'elenco e chi risponde
// alla famiglia deve poter citare il numero.
// =============================================================================
describe('RichiesteCancellazionePanel — i figli col registro della primaria', () => {
  /** GET → la richiesta; POST dryrun → `dry`; POST execute → `esito`; dopo l'evasione l'elenco è vuoto. */
  function conRegistro(richiesta: Record<string, unknown>, dry: Record<string, unknown>, esito: Record<string, unknown>) {
    let evasa = false
    fetchMock.mockImplementation((_url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST') {
        if (String(init.body ?? '').includes('execute')) {
          evasa = true
          return Promise.resolve({ ok: true, json: async () => esito })
        }
        return Promise.resolve({ ok: true, json: async () => dry })
      }
      return Promise.resolve({ ok: true, json: async () => (evasa ? [] : [richiesta]) })
    })
  }

  it('la riga dell’elenco dice quanti figli restano per il registro', async () => {
    conRegistro({ ...RICHIESTA, alunni_non_iscritti: 1, alunni_registro_primaria: 1 }, DRY_RUN, { ok: true })
    await monta()
    const riga = (await screen.findByText('Genitore Prova')).closest('button') as HTMLElement
    // Il verbo concorda col numero DENTRO il plurale: «1 figlio ha», «2 figli hanno».
    expect(within(riga).getByText(/^1 figlio ha il registro della primaria: non si anonimizza$/)).toBeInTheDocument()
  })

  it('registro non misurato nell’elenco: lo dice, non tace e non scrive zero', async () => {
    conRegistro({ ...RICHIESTA, alunni_registro_primaria: null }, DRY_RUN, { ok: true })
    await monta()
    const riga = (await screen.findByText('Genitore Prova')).closest('button') as HTMLElement
    expect(within(riga).getByText(itAdminAltro.richiesteFigliRegistroNonMisurato)).toBeInTheDocument()
  })

  it('controllo: senza figli col registro la riga non aggiunge niente', async () => {
    conRegistro({ ...RICHIESTA, alunni_registro_primaria: 0 }, DRY_RUN, { ok: true })
    await monta()
    const riga = (await screen.findByText('Genitore Prova')).closest('button') as HTMLElement
    expect(within(riga).queryByText(/registro della primaria/)).not.toBeInTheDocument()
  })

  it('il dry-run lo dice PRIMA della conferma, con il numero, e solo per il SUO gruppo', async () => {
    conRegistro(RICHIESTA, { ...DRY_RUN, alunni_non_iscritti: 1, alunni_registro_primaria: 1 }, { ok: true })
    await apriRichiesta()
    const riga = await screen.findByText(/ESCLUSI dall’anonimizzazione: 1\./)
    expect(riga.textContent).toContain('la loro scheda resta intatta')
    // La frase falsa della prima versione: «gli altri figli si anonimizzano lo
    // stesso» — i figli iscritti NON si anonimizzano.
    expect(document.body.textContent).not.toMatch(/altri figli si anonimizzano/)
  })

  it('il dry-run dice che l’ACCOUNT del genitore resta, quando resta', async () => {
    conRegistro(RICHIESTA, { ...DRY_RUN, alunni_non_iscritti: 1, alunni_registro_primaria: 1, account_mantenuti: 1 }, { ok: true })
    await apriRichiesta()
    const riga = await screen.findByText(/Account di accesso del genitore: RESTA/)
    expect(riga.textContent).toContain('scheda anagrafica si anonimizza comunque')
  })

  it('account non misurato nel dry-run: lo dice', async () => {
    conRegistro(RICHIESTA, { ...DRY_RUN, account_mantenuti: null }, { ok: true })
    await apriRichiesta()
    expect(await screen.findByText(itAdminAltro.richiesteAccountNonMisurato)).toBeInTheDocument()
  })

  it('controllo: account liberato (0) → nessuna riga sull’account', async () => {
    conRegistro(RICHIESTA, { ...DRY_RUN, account_mantenuti: 0 }, { ok: true })
    await apriRichiesta()
    await waitFor(() => expect(voce('Pagelle: 3')).toBeInTheDocument())
    expect(screen.queryByText(/Account di accesso del genitore/)).not.toBeInTheDocument()
  })

  it('dopo l’evasione resta a schermo quanti figli non sono stati anonimizzati, e perché', async () => {
    conRegistro(RICHIESTA, { ...DRY_RUN, alunni_non_iscritti: 1, alunni_registro_primaria: 2 }, { ok: true, alunni: 1, alunni_registro_primaria: 2 })
    await apriRichiesta()
    await waitFor(() => expect(voce('Pagelle: 3')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('ANONIMIZZA'), { target: { value: 'ANONIMIZZA' } })
    fireEvent.click(bottoneRosso())
    const avviso = await screen.findByRole('status')
    expect(avviso.textContent).toContain(itAdminAltro.richiesteEvasaTitolo)
    expect(avviso.textContent).toContain('2 figli non sono stati anonimizzati')
    // La richiesta è evasa: è sparita dall'elenco, il numero no.
    await waitFor(() => expect(screen.queryByText('Genitore Prova')).not.toBeInTheDocument())
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('controllo: un’evasione senza esclusi non mostra il riquadro', async () => {
    conRegistro(RICHIESTA, DRY_RUN, { ok: true, alunni: 2, alunni_registro_primaria: 0 })
    await apriRichiesta()
    await waitFor(() => expect(voce('Pagelle: 3')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('ANONIMIZZA'), { target: { value: 'ANONIMIZZA' } })
    fireEvent.click(bottoneRosso())
    await waitFor(() => expect(screen.queryByText('Genitore Prova')).not.toBeInTheDocument())
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})

describe('RichiesteCancellazionePanel — dopo l’evasione: l’account che resta', () => {
  it('account_mantenuti 1 → il riquadro di esito lo dice, anche senza figli col registro', async () => {
    fetchMock.mockImplementation((_url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST') {
        if (String(init.body ?? '').includes('execute')) {
          return Promise.resolve({ ok: true, json: async () => ({ ok: true, alunni_registro_primaria: 0, account_mantenuti: 1 }) })
        }
        return Promise.resolve({ ok: true, json: async () => ({ ...DRY_RUN, account_mantenuti: 1 }) })
      }
      return Promise.resolve({ ok: true, json: async () => [RICHIESTA] })
    })
    await apriRichiesta()
    await waitFor(() => expect(voce('Pagelle: 3')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('ANONIMIZZA'), { target: { value: 'ANONIMIZZA' } })
    fireEvent.click(bottoneRosso())
    const avviso = await screen.findByRole('status')
    expect(avviso.textContent).toContain('il suo account di accesso (email e nome) resta')
    expect(avviso.textContent).not.toMatch(/non (è stato|sono stati) anonimizzat/)
  })
})

describe('RichiesteCancellazionePanel — oblio parziale per una chiave condivisa', () => {
  it('chiavi_condivise_escluse > 0 → il riquadro di esito dice il motivo', async () => {
    fetchMock.mockImplementation((_url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST') {
        if (String(init.body ?? '').includes('execute')) {
          return Promise.resolve({ ok: true, json: async () => ({ ok: true, alunni_registro_primaria: 0, account_mantenuti: 0, chiavi_condivise_escluse: 2 }) })
        }
        return Promise.resolve({ ok: true, json: async () => DRY_RUN })
      }
      return Promise.resolve({ ok: true, json: async () => [RICHIESTA] })
    })
    await apriRichiesta()
    await waitFor(() => expect(voce('Pagelle: 3')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('ANONIMIZZA'), { target: { value: 'ANONIMIZZA' } })
    fireEvent.click(bottoneRosso())
    const avviso = await screen.findByRole('status')
    expect(avviso.textContent).toContain(itAdminAltro.oblioParzialeChiaviCondivise)
  })
})
