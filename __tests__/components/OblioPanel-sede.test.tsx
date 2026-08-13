import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'

import itAdminAltro from '../../messages/it/adminAltro.json'
import enAdminAltro from '../../messages/en/adminAltro.json'
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'

expect.extend(toHaveNoViolations)

/**
 * W3-E · R72 — Il pannello «Diritto all'oblio» non diceva la sede.
 *
 * È la lista di persone più pericolosa che abbiamo: la riga si clicca, si digita
 * un nominativo e un minore (più i suoi genitori) viene ANONIMIZZATO in modo
 * IRREVERSIBILE. Fino al 2026-07-31 la riga mostrava cognome, nome, classe e
 * genitori — e basta. Con tre plessi e classi omonime («2 ANNI» esiste in due
 * sedi), la Direzione multi-sede vedeva in un'unica lista i candidati di tutte
 * le sedi senza alcun modo di distinguerli.
 *
 * Qui si asserisce che la sede è scritta DOVE si decide: sulla riga della lista
 * e nel riquadro di conferma, quello con la casella da digitare.
 */

vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => h.sedi(),
}))

const h = vi.hoisted(() => ({
  sedi: () => ({
    sedi: [] as { id: string; nome: string }[],
    selezionate: [] as string[],
    effettive: [] as string[],
    sedeCorrente: null as string | null,
    reFetchKey: '',
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
  }),
}))

function conSedi(elenco: { id: string; nome: string }[]) {
  h.sedi = () => ({
    sedi: elenco,
    selezionate: [],
    effettive: elenco.map((s) => s.id),
    sedeCorrente: elenco.length === 1 ? elenco[0].id : null,
    reFetchKey: elenco.map((s) => s.id).join(','),
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
  })
}

const CANDIDATI = [
  { id: 'alu-a', nome: 'Alfa', cognome: 'Rossi', classe_sezione: '2 ANNI', stato: 'ritirato', scuola_id: SEDE_A, genitori: [{ id: 'p-a', nome: 'Anna Rossi' }] },
  { id: 'alu-b', nome: 'Beta', cognome: 'Rossi', classe_sezione: '2 ANNI', stato: 'ritirato', scuola_id: SEDE_B, genitori: [{ id: 'p-b', nome: 'Bruna Rossi' }] },
]

const fetchMock = vi.fn()

/**
 * Il corpo del dry-run, con i conteggi che dal 2026-08-12 rendono onesto l'avviso.
 * Due pagelle e un certificato medico: sono i numeri che la Direzione deve leggere
 * PRIMA di digitare il nominativo, e la ragione per cui questo riquadro esiste.
 */
const DRY_RUN = {
  alunno: 1,
  parents: 1,
  parents_non_anonimizzati: 0,
  file_da_rimuovere: 3,
  pagelle: 2,
  certificati_medici: 1,
  foto_solo_sue: 3,
  foto_di_gruppo: 4,
  foto_non_rimovibili: 0,
  articoli_pubblici: 0,
  allegati_chat: 5,
  nominativo_conferma: 'ROSSI BETA',
}

/** Il dry-run risponde `dry`, l'elenco dei candidati risponde `CANDIDATI`. */
function conDryRun(dry: Record<string, unknown>) {
  fetchMock.mockImplementation((url: string) => {
    if (String(url).includes('/api/admin/gdpr/erase')) {
      return Promise.resolve({ ok: true, json: async () => dry })
    }
    return Promise.resolve({ ok: true, json: async () => CANDIDATI })
  })
}

/** Il dry-run CADE (500), l'elenco dei candidati risponde lo stesso. */
function conDryRunRotto(stato = 500) {
  fetchMock.mockImplementation((url: string) => {
    if (String(url).includes('/api/admin/gdpr/erase')) {
      return Promise.resolve({ ok: false, status: stato, json: async () => ({ error: 'Errore interno' }) })
    }
    return Promise.resolve({ ok: true, json: async () => CANDIDATI })
  })
}

/** Il bottone rosso che lancia l'anonimizzazione irreversibile. */
const bottoneRosso = () => screen.getByRole('button', { name: itAdminAltro.oblioBtnAnonimizza })

beforeEach(() => {
  vi.clearAllMocks()
  conSedi([
    { id: SEDE_A, nome: NOME_SEDE_A },
    { id: SEDE_B, nome: NOME_SEDE_B },
  ])
  conDryRun(DRY_RUN)
  vi.stubGlobal('fetch', fetchMock)
})

import { OblioPanel } from '@/components/features/admin/settings/OblioPanel'

describe('OblioPanel — la sede accanto al candidato', () => {
  it('con due sedi attive OGNI riga porta il nome del suo plesso', async () => {
    const { container } = render(<OblioPanel userId="dir-1" />)
    await waitFor(() => expect(screen.getByText(/Rossi Beta/)).toBeInTheDocument())

    const righe = Array.from(container.querySelectorAll('aside button'))
    expect(righe).toHaveLength(2)
    // Le due righe sono omonime (Rossi/Rossi, «2 ANNI»/«2 ANNI»): l'UNICA cosa
    // che le distingue è la sede.
    expect(within(righe[0] as HTMLElement).getByText(NOME_SEDE_A)).toBeInTheDocument()
    expect(within(righe[1] as HTMLElement).getByText(NOME_SEDE_B)).toBeInTheDocument()
  })

  it('il riquadro di conferma dice la sede del bambino che si sta per anonimizzare', async () => {
    const { container } = render(<OblioPanel userId="dir-1" />)
    await waitFor(() => expect(screen.getByText(/Rossi Beta/)).toBeInTheDocument())

    fireEvent.click(screen.getByText(/Rossi Beta/))
    const dettaglio = await waitFor(() => {
      const s = container.querySelector('section')
      expect(s?.textContent).toContain('ROSSI BETA') // il dry-run è arrivato
      return s as HTMLElement
    })
    expect(within(dettaglio).getByText(NOME_SEDE_B)).toBeInTheDocument()
    expect(within(dettaglio).queryByText(NOME_SEDE_A)).not.toBeInTheDocument()
  })

  it('con una sola sede accessibile la sede non compare: sarebbe solo rumore', async () => {
    conSedi([{ id: SEDE_A, nome: NOME_SEDE_A }])
    fetchMock.mockImplementation(() => Promise.resolve({ ok: true, json: async () => [CANDIDATI[0]] }))
    render(<OblioPanel userId="dir-1" />)
    await waitFor(() => expect(screen.getByText(/Rossi Alfa/)).toBeInTheDocument())
    expect(screen.queryByText(NOME_SEDE_A)).not.toBeInTheDocument()
  })

  it('sede sconosciuta (uuid non fra le accessibili): lo dice, non tace', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve({ ok: true, json: async () => [{ ...CANDIDATI[0], scuola_id: null }] }),
    )
    render(<OblioPanel userId="dir-1" />)
    await waitFor(() => expect(screen.getByText(/Rossi Alfa/)).toBeInTheDocument())
    expect(screen.getByText(itAdminAltro.ricevutiSedeSconosciuta)).toBeInTheDocument()
  })

  it('le chiavi usate esistono in ENTRAMBI i cataloghi', () => {
    for (const k of ['oblioSede', 'ricevutiSedeSconosciuta']) {
      expect(itAdminAltro).toHaveProperty(k)
      expect(enAdminAltro).toHaveProperty(k)
    }
    expect(Object.keys(itAdminAltro).sort()).toEqual(Object.keys(enAdminAltro).sort())
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// «QUESTA OPERAZIONE DISTRUGGE» — l'avviso che mancava.
//
// IL DIFETTO, misurato il 2026-08-12. Il pannello faceva confermare
// un'anonimizzazione IRREVERSIBILE mostrando una riga sola sui documenti: «file
// da rimuovere: 3». Dentro quel numero, e accanto a quel numero, se ne vanno le
// PAGELLE del bambino e i suoi CERTIFICATI MEDICI — è ciò che dichiara
// `REGISTRO_BUCKET_OBLIO` alla voce `pagelle`. La Direzione non lo leggeva da
// nessuna parte: non era nascosto, semplicemente non era scritto.
//
// Il difetto non è un dato non cancellato. È un consenso raccolto su
// un'informazione mancante, che è la cosa che questa schermata produce.
// ═════════════════════════════════════════════════════════════════════════════

/** La `li` dell'elenco il cui testo è esattamente quello atteso. */
const voce = (testo: string) =>
  screen.getByText(
    (_c, el) => el?.tagName === 'LI' && (el.textContent ?? '').replace(/\s+/g, ' ').trim() === testo,
  )

/** Le voci dell'elenco «DISTRUGGE», nell'ordine in cui stanno a schermo. */
function elencoDistrugge(container: HTMLElement): string[] {
  const titolo = within(container).getByText(itAdminAltro.oblioDistruggeTitolo)
  const riquadro = titolo.closest('div') as HTMLElement
  const primaLista = riquadro.querySelector('ul') as HTMLElement
  return Array.from(primaLista.querySelectorAll('li')).map((li) =>
    (li.textContent ?? '').replace(/\s+/g, ' ').trim(),
  )
}

describe('OblioPanel — che cosa distrugge, detto prima della conferma', () => {
  it('PAGELLE e CERTIFICATI MEDICI sono le prime due voci dell’elenco', async () => {
    const { container } = render(<OblioPanel userId="dir-1" />)
    await waitFor(() => expect(screen.getByText(/Rossi Beta/)).toBeInTheDocument())

    const righe = elencoDistrugge(container)
    // Non è ordine estetico: sono le due voci che cambiano la decisione di chi
    // conferma. In fondo a un elenco di nove righe non le legge nessuno.
    expect(righe[0]).toContain(itAdminAltro.oblioDistruggePagelle)
    expect(righe[1]).toContain(itAdminAltro.oblioDistruggeCertificati)
    expect(righe.length).toBeGreaterThan(5)
  })

  it('i conteggi VERI del dry-run stanno accanto alle voci', async () => {
    render(<OblioPanel userId="dir-1" />)
    await waitFor(() => expect(screen.getByText(/Rossi Beta/)).toBeInTheDocument())

    fireEvent.click(screen.getByText(/Rossi Beta/))
    // «Pagelle: 2» e «Certificati medici: 1»: il numero e la cosa, sulla stessa
    // riga. È la differenza fra «file da rimuovere: 3» e sapere che cosa sono.
    await waitFor(() => expect(voce('Pagelle: 2')).toBeInTheDocument())
    expect(voce('Certificati medici: 1')).toBeInTheDocument()
    expect(voce(`${itAdminAltro.oblioDistruggeChat} 5`)).toBeInTheDocument()
  })

  it('le foto di GRUPPO hanno un numero loro: il file resta, esce solo il tag', async () => {
    const { container } = render(<OblioPanel userId="dir-1" />)
    await waitFor(() => expect(screen.getByText(/Rossi Beta/)).toBeInTheDocument())
    fireEvent.click(screen.getByText(/Rossi Beta/))
    await waitFor(() => expect(voce('Pagelle: 2')).toBeInTheDocument())

    // Le 4 foto di gruppo NON stanno nell'elenco delle distruzioni: dentro c'è
    // l'immagine di altri bambini e si toglie soltanto il collegamento. Sommarle
    // alle 3 «solo sue» annuncerebbe una distruzione che non avviene.
    expect(elencoDistrugge(container).join(' | ')).not.toContain(itAdminAltro.oblioDistruggeFotoGruppo)
    expect(screen.getByText(itAdminAltro.oblioDistruggeFotoGruppo).textContent).toContain('4')
  })

  it('prima di scegliere un bambino non c’è nessun numero inventato', async () => {
    const { container } = render(<OblioPanel userId="dir-1" />)
    await waitFor(() => expect(screen.getByText(/Rossi Beta/)).toBeInTheDocument())
    // Nessun dry-run è ancora partito: l'elenco dice CHE COSA, non QUANTO. Uno
    // zero qui sarebbe un conteggio mai misurato presentato come misura.
    for (const riga of elencoDistrugge(container)) {
      expect(riga, `numero comparso senza dry-run: «${riga}»`).not.toMatch(/\d/)
    }
  })

  it('una lettura non riuscita dice «non misurato», non «0»', async () => {
    // Il server risponde `null` quando la `SELECT` è fallita: PostgREST non
    // lancia, e uno zero al posto di «non lo so» è la rassicurazione falsa per
    // cui questo riquadro è stato scritto.
    conDryRun({ ...DRY_RUN, pagelle: null })
    render(<OblioPanel userId="dir-1" />)
    await waitFor(() => expect(screen.getByText(/Rossi Beta/)).toBeInTheDocument())
    fireEvent.click(screen.getByText(/Rossi Beta/))

    await waitFor(() =>
      expect(
        voce(`${itAdminAltro.oblioDistruggePagelle} ${itAdminAltro.oblioDistruggeNonMisurato}`),
      ).toBeInTheDocument(),
    )
    expect(screen.queryByText('Pagelle: 0')).not.toBeInTheDocument()
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // SE LA MISURA CADE, L'AVVISO NON PUÒ TORNARE MUTO (2026-08-13).
  //
  // Il pannello faceva `if (res.ok) setDry(j)` senza ramo `else`. MISURATO con
  // il dry-run a 500: `{ voci: ["Pagelle:", "Certificati medici:", …],
  // nonMisuratoVisibile: false, bottoneDisabilitato: false }`. Cioè la schermata
  // era IDENTICA a «non ho ancora scelto nessuno», la parola «non misurato» non
  // compariva proprio nel caso in cui nulla era stato misurato, e
  // l'anonimizzazione irreversibile partiva lo stesso digitando il nominativo
  // (che il fallback fornisce comunque, senza dry-run).
  //
  // Il presidio «`null` non è zero» copriva solo il `null` che il SERVER manda
  // di proposito, non il fallimento dell'intera misura — il caso più probabile.
  // ═══════════════════════════════════════════════════════════════════════════
  it('dry-run a 500: lo dice, invece di sembrare «non ho ancora scelto nessuno»', async () => {
    conDryRunRotto()
    const { container } = render(<OblioPanel userId="dir-1" />)
    await waitFor(() => expect(screen.getByText(/Rossi Beta/)).toBeInTheDocument())
    fireEvent.click(screen.getByText(/Rossi Beta/))

    // Il riquadro rosso, con `role="alert"`: chi legge con uno screen reader non
    // «vede» che i numeri non sono arrivati.
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('alert').textContent).toContain(itAdminAltro.oblioMisuraFallita)

    // E ogni voce misurabile dice «non misurato»: prima non lo diceva NESSUNA.
    const righe = elencoDistrugge(container)
    expect(righe.filter((r) => r.includes(itAdminAltro.oblioDistruggeNonMisurato)).length).toBeGreaterThan(3)
    expect(righe.join(' | '), 'uno zero inventato al posto di «non lo so»').not.toMatch(/:\s0\b/)
  })

  it('dry-run a 500: il bottone rosso NON si può premere', async () => {
    conDryRunRotto()
    render(<OblioPanel userId="dir-1" />)
    await waitFor(() => expect(screen.getByText(/Rossi Beta/)).toBeInTheDocument())
    fireEvent.click(screen.getByText(/Rossi Beta/))
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())

    // Il nominativo arriva dal fallback anche senza dry-run: prima bastava
    // questo per far partire un'anonimizzazione irreversibile.
    fireEvent.change(screen.getByPlaceholderText(itAdminAltro.oblioPlaceholderNome), {
      target: { value: 'ROSSI BETA' },
    })
    expect(bottoneRosso()).toBeDisabled()

    fireEvent.click(bottoneRosso())
    const esecuzioni = fetchMock.mock.calls.filter(
      (c) => String(c[0]).includes('/api/admin/gdpr/erase') && String(c[1]?.body ?? '').includes('execute'),
    )
    expect(esecuzioni, 'un oblio è partito con la misura caduta').toHaveLength(0)
  })

  it('con la misura riuscita il bottone si sblocca (controllo positivo)', async () => {
    // Senza questa riga il test qui sopra sarebbe verde anche su un bottone
    // spento per sempre, cioè su un pannello rotto.
    render(<OblioPanel userId="dir-1" />)
    await waitFor(() => expect(screen.getByText(/Rossi Beta/)).toBeInTheDocument())
    fireEvent.click(screen.getByText(/Rossi Beta/))
    await waitFor(() => expect(voce('Pagelle: 2')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText(itAdminAltro.oblioPlaceholderNome), {
      target: { value: 'ROSSI BETA' },
    })
    expect(bottoneRosso()).toBeEnabled()
  })

  it('«Riprova la misura» rifà il dry-run', async () => {
    // Bloccare la conferma senza dare una via d'uscita fermerebbe un oblio
    // legittimo su un guasto passeggero.
    conDryRunRotto()
    render(<OblioPanel userId="dir-1" />)
    await waitFor(() => expect(screen.getByText(/Rossi Beta/)).toBeInTheDocument())
    fireEvent.click(screen.getByText(/Rossi Beta/))
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())

    conDryRun(DRY_RUN)
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.oblioMisuraRiprova }))
    await waitFor(() => expect(voce('Pagelle: 2')).toBeInTheDocument())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // TRE DISALLINEAMENTI FRA ETICHETTA E NUMERO (2026-08-13).
  // ═══════════════════════════════════════════════════════════════════════════
  it('il conteggio parziale si legge «almeno N», non «N»', async () => {
    // `file_da_rimuovere` conta i documenti d'identità; gli allegati che solo la
    // domanda d'iscrizione conosce si trovano eseguendo. La route lo chiamava
    // «una STIMA» in un commento che nessun operatore legge.
    render(<OblioPanel userId="dir-1" />)
    await waitFor(() => expect(screen.getByText(/Rossi Beta/)).toBeInTheDocument())
    fireEvent.click(screen.getByText(/Rossi Beta/))
    await waitFor(() =>
      expect(voce(`${itAdminAltro.oblioDistruggeIscrizione} almeno 3`)).toBeInTheDocument(),
    )
  })

  it('lo stesso numero non compare due volte con due nomi diversi', async () => {
    // «File personali rimossi: 3» e «Documento d'identità e domanda
    // d'iscrizione: 3» erano lo stesso 3, e chi leggeva non aveva modo di
    // saperlo: sembravano 6 file.
    const { container } = render(<OblioPanel userId="dir-1" />)
    await waitFor(() => expect(screen.getByText(/Rossi Beta/)).toBeInTheDocument())
    fireEvent.click(screen.getByText(/Rossi Beta/))
    await waitFor(() => expect(voce('Pagelle: 2')).toBeInTheDocument())
    expect(container.textContent).not.toContain('File personali rimossi')
  })

  it('senza genitori orfani la riga delle CREDENZIALI sparisce', async () => {
    // `obliaPdfCredenziali` gira solo dentro `anonimizzaParent`, cioè solo sugli
    // adulti rimasti senza altri figli iscritti. Con zero orfani il riquadro
    // annunciava comunque «PDF delle credenziali dei genitori anonimizzati»
    // mentre non ne spariva nessuno — e il pannello quel numero ce l'aveva già.
    conDryRun({ ...DRY_RUN, parents: 0, parents_non_anonimizzati: 2 })
    const { container } = render(<OblioPanel userId="dir-1" />)
    await waitFor(() => expect(screen.getByText(/Rossi Beta/)).toBeInTheDocument())
    fireEvent.click(screen.getByText(/Rossi Beta/))
    await waitFor(() => expect(voce('Pagelle: 2')).toBeInTheDocument())
    expect(elencoDistrugge(container).join(' | ')).not.toContain(itAdminAltro.oblioDistruggeCredenziali)
  })

  it('con un genitore orfano la riga delle CREDENZIALI c’è (controllo positivo)', async () => {
    const { container } = render(<OblioPanel userId="dir-1" />)
    await waitFor(() => expect(screen.getByText(/Rossi Beta/)).toBeInTheDocument())
    fireEvent.click(screen.getByText(/Rossi Beta/))
    await waitFor(() => expect(voce('Pagelle: 2')).toBeInTheDocument())
    expect(elencoDistrugge(container).join(' | ')).toContain(itAdminAltro.oblioDistruggeCredenziali)
  })

  it('le foto che l’oblio NON riesce a togliere hanno una riga loro, e solo quando ci sono', async () => {
    // Una foto in cui è l'unico ritratto e il cui indirizzo non è riconoscibile
    // resta nell'archivio: annunciarla fra le distruzioni sarebbe una promessa
    // vuota, tacerla nasconderebbe un oblio parziale.
    render(<OblioPanel userId="dir-1" />)
    await waitFor(() => expect(screen.getByText(/Rossi Beta/)).toBeInTheDocument())
    fireEvent.click(screen.getByText(/Rossi Beta/))
    await waitFor(() => expect(voce('Pagelle: 2')).toBeInTheDocument())
    expect(screen.queryByText(itAdminAltro.oblioDistruggeFotoTrattenute)).not.toBeInTheDocument()

    conDryRun({ ...DRY_RUN, foto_non_rimovibili: 2 })
    fireEvent.click(screen.getByText(/Rossi Alfa/))
    await waitFor(() =>
      expect(screen.getByText(itAdminAltro.oblioDistruggeFotoTrattenute).textContent).toContain('2'),
    )
  })

  it('accanto alle distruzioni c’è che cosa RESTA (obbligo decennale compreso)', async () => {
    render(<OblioPanel userId="dir-1" />)
    await waitFor(() => expect(screen.getByText(/Rossi Beta/)).toBeInTheDocument())
    expect(screen.getByText(itAdminAltro.oblioRestaTitolo)).toBeInTheDocument()
    expect(voce(itAdminAltro.oblioRestaPagamenti)).toBeInTheDocument()
    expect(voce(itAdminAltro.oblioRestaPresenze)).toBeInTheDocument()
    expect(voce(itAdminAltro.oblioRestaProtocollo)).toBeInTheDocument()
    expect(voce(itAdminAltro.oblioRestaAudit)).toBeInTheDocument()
  })

  it('le chiavi dell’avviso esistono in ENTRAMBI i cataloghi', () => {
    const chiavi = [
      'oblioDistruggeTitolo', 'oblioDistruggePagelle', 'oblioDistruggeCertificati',
      'oblioDistruggeGalleria', 'oblioDistruggeFotoGruppo', 'oblioDistruggeNews',
      'oblioDistruggeChat', 'oblioDistruggeIscrizione', 'oblioDistruggeCredenziali',
      'oblioDistruggeNotifiche', 'oblioDistruggeMotivoAssenza', 'oblioDistruggeNonMisurato',
      'oblioDistruggeAlmeno', 'oblioDistruggeFotoTrattenute',
      'oblioMisuraFallita', 'oblioMisuraRiprova',
      'oblioRestaTitolo', 'oblioRestaPagamenti', 'oblioRestaPresenze', 'oblioRestaProtocollo',
      'oblioRestaAudit',
    ]
    for (const k of chiavi) {
      expect(itAdminAltro, `manca in messages/it/adminAltro.json: ${k}`).toHaveProperty(k)
      expect(enAdminAltro, `manca in messages/en/adminAltro.json: ${k}`).toHaveProperty(k)
    }
  })

  it('nessuna violazione axe, con e senza il dry-run a schermo', async () => {
    const { container } = render(<OblioPanel userId="dir-1" />)
    await waitFor(() => expect(screen.getByText(/Rossi Beta/)).toBeInTheDocument())
    expect(await axe(container)).toHaveNoViolations()

    fireEvent.click(screen.getByText(/Rossi Beta/))
    await waitFor(() => expect(voce('Pagelle: 2')).toBeInTheDocument())
    expect(await axe(container)).toHaveNoViolations()
  })

  it('nessuna violazione axe nemmeno con la misura FALLITA (markup nuovo)', async () => {
    // ⚠️ E axe in jsdom NON misura il contrasto: la regola `color-contrast` non
    // gira, quindi questa riga NON dice niente sui colori. Quel presidio è
    // aritmetico e sta in `__tests__/a11y/oblio-avviso-contrasto.test.ts`.
    conDryRunRotto()
    const { container } = render(<OblioPanel userId="dir-1" />)
    await waitFor(() => expect(screen.getByText(/Rossi Beta/)).toBeInTheDocument())
    fireEvent.click(screen.getByText(/Rossi Beta/))
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(await axe(container)).toHaveNoViolations()
  })
})
