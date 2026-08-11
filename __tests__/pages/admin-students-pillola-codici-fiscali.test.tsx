import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

import itAdmin from '../../messages/it/adminStudents.json'
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi'

/**
 * LOCK · IL NUMERO SULLA PILLOLA DELLA LINGUETTA «CODICI FISCALI».
 *
 * ─── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
 * La riga che decide quel numero (`page.tsx`, opzione `codici` di `Tabs`) non era
 * protetta da NIENTE. Misurato l'11 agosto: rimettendo `count: codiciFiscali.totale`
 * al posto di `codiciFiscali.azionabili` — cioè annullando esattamente la
 * correzione — `npx vitest run __tests__/pages/ __tests__/components/` restava
 * verde su 25 file e 254 test. `azionabili` compariva solo nel test dell'HOOK, mai
 * su ciò che la linguetta MOSTRA: la definizione di invariante decorativa, cancello
 * la riga che il test dovrebbe proteggere e la suite non se ne accorge.
 *
 * ─── LE TRE COSE CHE TIENE FERME ─────────────────────────────────────────────
 * L'elenco di prova è MISTO apposta, e i tre numeri che ne escono sono diversi:
 *
 *   · 5 = i tre stati sommati (`totale`)      → il badge gonfio della prima stesura;
 *   · 1 = le sole righe `incoerente`          → il badge per difetto della seconda;
 *   · 2 = l'azionabile vero                   → i rossi PIÙ le righe su cui il
 *         pannello mostra il comando di scrittura.
 *
 * Il 2 non è una raffinatezza: misurato in produzione l'11 agosto, in sola lettura
 * e a soli conteggi, **1 alunno su 29 e 1 genitore su 50** non hanno il codice
 * fiscale ma hanno nome, cognome, data, sesso e comune di nascita — quindi la
 * proposta pronta, `priorita: 0` (in cima all'elenco) e «Applica» a schermo. Il
 * badge che contava i soli rossi li lasciava fuori: prometteva meno lavoro di
 * quello che il pannello sa davvero chiudere, sul codice fiscale di un minore.
 *
 * ─── E IL CONTROLLO POSITIVO ─────────────────────────────────────────────────
 * «Il badge non dice 5» passerebbe anche su una pagina che non rende niente, o su
 * un badge sparito. Perciò la sonda prima DIMOSTRA di avere in mano il nodo giusto
 * (esiste, sta dentro il bottone della linguetta, ed è quello che uno screen
 * reader legge come parte del suo nome), e solo dopo ne asserisce il contenuto.
 */

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'TypeError' }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  useParams: () => ({}),
  usePathname: () => '/admin/students',
}))
vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: [{ id: SEDE_A, nome: NOME_SEDE_A }],
    selezionate: [],
    effettive: [SEDE_A],
    sedeCorrente: null,
    reFetchKey: SEDE_A,
    epocaSede: 0,
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
  }),
}))

/* ── Codici FINTI: il repository è PUBBLICO. Le posizioni 7-8 devono essere
 *    cifre e qui sono lettere, quindi nessuna checksum li rende accettabili. ── */
const CF_ATTUALE = 'CODICEFINTO00001'
const CF_PROPOSTO = 'CODICEPROPOSTO01'

const base = {
  nome: 'Prova',
  cognome: 'Test',
  scuole_ids: [SEDE_A],
  motivi: [] as string[],
  non_verificabili: [] as string[],
  proposta_bloccata_da: null as 'luogo' | 'anagrafica' | null,
  proposta_combacia: false,
  priorita: 2 as 0 | 1 | 2,
}

/** ROSSO con la proposta: si sostituisce un codice. CONTA. */
const INCOERENTE = {
  ...base, tipo: 'alunno', id: 'aaaa1111-0000-4000-8000-000000000001',
  cognome: 'Bianchi', stato: 'incoerente',
  codice_attuale: CF_ATTUALE, motivi: ['data-nascita'],
  codice_proposto: CF_PROPOSTO, priorita: 0 as const,
}

/** GIALLO senza proposta: manca un dato per confrontare. NON conta. */
const NON_VERIFICABILE = {
  ...base, tipo: 'genitore', id: 'bbbb2222-0000-4000-8000-000000000002',
  cognome: 'Verdi', stato: 'non-verificabile',
  codice_attuale: CF_ATTUALE, non_verificabili: ['sesso', 'luogo-nascita'],
  codice_proposto: null, proposta_bloccata_da: 'luogo' as const, priorita: 1 as const,
}

/** GIALLO con la proposta che CONFERMA il codice: non c'è niente da scrivere. NON conta. */
const COMBACIA = {
  ...base, tipo: 'alunno', id: 'dddd4444-0000-4000-8000-000000000004',
  cognome: 'Adami', stato: 'non-verificabile',
  codice_attuale: CF_PROPOSTO, non_verificabili: ['luogo-nascita'],
  codice_proposto: CF_PROPOSTO, proposta_combacia: true, priorita: 0 as const,
}

/** NEUTRO senza proposta: «mai compilato» non è un errore. NON conta. */
const DA_COMPILARE = {
  ...base, tipo: 'alunno', id: 'cccc3333-0000-4000-8000-000000000003',
  cognome: 'Costa', stato: 'da-compilare',
  codice_attuale: null, non_verificabili: ['sesso', 'luogo-nascita'],
  codice_proposto: null, proposta_bloccata_da: 'anagrafica' as const,
}

/** NEUTRO con la proposta pronta: si scrive dove non c'è niente. CONTA — ed è
 *  il caso che il badge di ieri lasciava fuori (1 alunno + 1 genitore veri). */
const DA_COMPILARE_CON_PROPOSTA = {
  ...base, tipo: 'genitore', id: 'eeee5555-0000-4000-8000-000000000005',
  cognome: 'Ferri', stato: 'da-compilare',
  codice_attuale: null, non_verificabili: ['luogo-nascita'],
  codice_proposto: CF_PROPOSTO, priorita: 0 as const,
}

const ELENCO = [INCOERENTE, NON_VERIFICABILE, COMBACIA, DA_COMPILARE, DA_COMPILARE_CON_PROPOSTA]

const fetchMock = vi.fn()
/** L'elenco dei codici fiscali risponde quando lo decide il test. */
let rispondiCodici: () => void

beforeEach(() => {
  vi.clearAllMocks()
  let sblocca: (v: unknown) => void = () => {}
  const codici = new Promise<unknown>((res) => { sblocca = res })
  rispondiCodici = () => sblocca({
    ok: true, status: 200,
    json: async () => ({ righe: ELENCO, totale: ELENCO.length, troncato: false }),
  })

  fetchMock.mockImplementation((url: string) => {
    const p = new URL(String(url), 'http://t.test').pathname
    if (p.includes('/api/admin/anagrafiche/codici-fiscali')) return codici
    if (p.includes('/api/admin/gruppi-mensa')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: [] }) })
    if (p.includes('/api/admin/sections')) return Promise.resolve({ ok: true, status: 200, json: async () => [] })
    if (p.includes('/api/admin/students')) return Promise.resolve({ ok: true, status: 200, json: async () => [] })
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  })
  vi.stubGlobal('fetch', fetchMock)
})

import AdminStudentsPage from '@/app/(dashboard)/admin/students/page'

/** Il bottone della linguetta «Codici fiscali». */
const linguetta = () => screen.getByRole('button', { name: new RegExp(itAdmin.cfTab, 'i') })

/** La pillola dentro quel bottone: `null` quando il numero non c'è ancora. */
function pillola(): HTMLElement | null {
  const spans = Array.from(linguetta().querySelectorAll('span'))
  return spans.length > 0 ? (spans[spans.length - 1] as HTMLElement) : null
}

describe('/admin/students — la pillola della linguetta «Codici fiscali»', () => {
  it('⚠️ porta l’AZIONABILE (2), non i tre stati sommati (5) né i soli rossi (1)', async () => {
    render(<AdminStudentsPage />)
    rispondiCodici()

    // CONTROLLO POSITIVO, prima di tutto: il nodo esiste davvero, ed è dentro il
    // bottone della linguetta. Senza, «non dice 5» sarebbe verde su un badge
    // sparito — cioè la sonda diventerebbe cieca proprio mentre dichiara di vedere.
    await waitFor(() => expect(pillola()).not.toBeNull())
    const badge = pillola() as HTMLElement
    expect(linguetta()).toContainElement(badge)

    // ⟵ IL PUNTO.
    expect(badge.textContent?.trim()).toBe('2')
    // Le due mutazioni che questo lock esiste per far diventare rosse, dette per
    // nome: `count: …totale` (5) e un conteggio dei soli `incoerente` (1).
    expect(badge.textContent?.trim()).not.toBe(String(ELENCO.length))
    expect(badge.textContent?.trim()).not.toBe(
      String(ELENCO.filter((r) => r.stato === 'incoerente').length),
    )

    // E il numero è parte del NOME della linguetta: chi usa uno screen reader
    // sente «Codici fiscali 2», non un badge muto accanto a una parola.
    expect(linguetta().textContent).toContain('2')
  })

  it('finché l’elenco non è arrivato la pillola NON c’è: uno zero direbbe «niente da verificare»', async () => {
    render(<AdminStudentsPage />)

    // Si aspetta che la pagina abbia finito di caricare i SUOI alunni (finché lo
    // spinner a tutta pagina è acceso, le linguette non sono nemmeno rese) — e
    // nel frattempo la lettura dei codici fiscali resta in volo, che è il momento
    // che questo test guarda.
    await waitFor(() => expect(screen.queryByText(itAdmin.caricamentoAnagrafica)).not.toBeInTheDocument())

    // La linguetta c'è (controllo positivo: la pagina è resa)…
    expect(linguetta()).toBeInTheDocument()
    // …ma senza numero, perché il numero non è ancora stato misurato.
    expect(pillola()).toBeNull()

    // Controllo opposto: appena la misura arriva, il numero compare.
    rispondiCodici()
    await waitFor(() => expect(pillola()?.textContent?.trim()).toBe('2'))
  })
})
