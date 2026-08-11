import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'

import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * LE TRE SCHEDE DELL'ALUNNO — L'ACCESSIBILITÀ MISURATA, non dichiarata.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ PERCHÉ QUESTO FILE ESISTE, detto senza giri di parole. Il gemello
 * `schede-adulto-a11y.test.tsx` è nato l'11 agosto per le tre schede dell'ADULTO,
 * ha trovato violazioni vere e le ha riparate. Sulle tre schede dell'ALUNNO —
 * gli stessi campi, la stessa griglia, lo stesso rilascio — nessuno aveva
 * guardato: `smoke.axe.test.tsx` non monta nessuno di questi tre componenti, e
 * questa corsia aveva aggiunto `htmlFor`/`id` a UN campo per scheda (il codice
 * fiscale, perché serviva all'`aria-describedby` del badge) lasciando muti tutti
 * i vicini.
 *
 * Eseguendo axe l'11 agosto, PRIMA di questa riparazione, sono uscite violazioni
 * `label` vere e banali — `<label>` senza `htmlFor` sopra `<input>`/`<select>`
 * senza `id`:
 *
 *   · `ScrollableStudentForm` ×9  — nome, cognome, sesso, cittadinanza, comune di
 *     residenza, provincia di residenza, CAP, sede, sezione;
 *   · `StudentRegistryForm`   ×5  — nome, cognome, sesso, comune di residenza, CAP;
 *   · `StudentDetailPanel`    ×13 — nome, cognome, data di nascita, sesso,
 *     cittadinanza, indirizzo, civico, comune, provincia, CAP, sezione, stato,
 *     data d'iscrizione.
 *
 * «Il gate è verde» e «qualcuno ha guardato» sono due frasi diverse, e questo file
 * esiste perché diventino la stessa.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ⚠️ COSA QUESTO FILE COPRE DAVVERO — l'elenco, non la promessa.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * La prima stesura di questa testata diceva «da qui in avanti una casella senza
 * nome su una di queste tre schede fa rosso». **Era falso per un'intera classe di
 * campi**, ed è stato misurato togliendo i `htmlFor` e vedendo la suite restare
 * VERDE: i controlli che vivono in un RAMO CONDIZIONALE (note BES, dettagli
 * intestatario) o in un PASSO non montato del wizard non erano nel DOM, quindi axe
 * non poteva vederli e `verificaEtichette` non poteva contarli. Un file che promette
 * «fa rosso» e resta verde è peggio della sua assenza, perché il prossimo non
 * guarderà: è la trappola documentata in CLAUDE.md — *un documento che descrive una
 * protezione che non c'è è peggio di nessun documento*.
 *
 * Dall'11 agosto i rami si APRONO prima di misurare, e la copertura è questa:
 *
 *   · `ScrollableStudentForm` — scheda a riposo, PIÙ il ramo BES acceso e il ramo
 *     «Altro Soggetto» dell'intestatario fattura (i 4 campi che prima erano fuori
 *     dal DOM: `alunno-note-bes`, `alunno-intestatario-nome/-cognome/-codice-fiscale`);
 *   · `StudentRegistryForm` — TUTTI E QUATTRO i passi del wizard, non solo il primo,
 *     coi rami BES (passo 3) e intestatario (passo 4) aperti; e da oggi passa anche
 *     da `verificaEtichette`, che prima saltava del tutto questa scheda;
 *   · `StudentDetailPanel` — scheda a dati caricati, con `bes` acceso nella fixture.
 *
 * Dall'11 agosto c'è anche il caso che mancava, ed è l'ultimo blocco di questo file:
 * un record **senza codice fiscale e senza i dati per calcolarlo** — cioè lo stato
 * più comune dell'archivio vero, non l'eccezione — con la misura che il campo non
 * rimandi a una descrizione inesistente. Non è un caso che axe copra: le sette prove
 * `axe` restavano VERDI col difetto in pagina.
 *
 * Resta FUORI, e va detto invece di lasciarlo intendere: il contrasto dei colori
 * (non calcolabile senza layout in jsdom — ha il suo lock dedicato,
 * `contrasto-cascata.test.tsx`), le regole a livello di documento (disattivate qui
 * sotto, un componente isolato non è una pagina), e `StudentEconomicSection`, che è
 * finto in questo file e ha il proprio collaudo.
 *
 * ⚠️ REPOSITORY PUBBLICO: nessuna persona vera, nessun codice fiscale con
 * checksum valida. Toponimi e codici catastali sono dati aperti dell'Agenzia.
 */

expect.extend(toHaveNoViolations)

/**
 * Le regole a livello di DOCUMENTO non si applicano a un componente isolato in
 * jsdom, e `color-contrast` non è calcolabile senza layout (il contrasto ha il suo
 * lock dedicato, `__tests__/a11y/contrasto-cascata.test.tsx`). Stesso insieme di
 * `smoke.axe.test.tsx` e di `schede-adulto-a11y.test.tsx`, così tre file non
 * divergono sulla stessa decisione.
 */
const axeOpts = {
  rules: {
    region: { enabled: false },
    'landmark-one-main': { enabled: false },
    'page-has-heading-one': { enabled: false },
  },
}

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'e' }))
vi.mock('@/lib/auth/current-teacher', () => ({ getCurrentTeacherId: () => null }))
vi.mock('@/components/features/admin/StudentEconomicSection', () => ({
  StudentEconomicSection: () => null,
}))

vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: [{ id: SEDE_A, nome: NOME_SEDE_A }],
    selezionate: [],
    effettive: [SEDE_A],
    sedeCorrente: SEDE_A,
    reFetchKey: SEDE_A,
    epocaSede: 0,
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
  }),
}))

import { ScrollableStudentForm } from '@/components/features/admin/ScrollableStudentForm'
import { StudentRegistryForm } from '@/components/features/admin/StudentRegistryForm'
import { StudentDetailPanel } from '@/components/features/admin/StudentDetailPanel'

/** Toponimi e codici catastali: dati aperti, non dati di persone. */
const NAPOLI = { comuni: [{ belfiore: 'H501', nome: 'NAPOLI', sigla: 'NA', attivo: true }] }

/**
 * Un alunno a dati CARICATI, e con `bes` acceso: la scheda vuota non renderebbe
 * la casella delle note BES, che è uno dei controlli da misurare.
 */
const ALUNNA = {
  id: 'al-1',
  nome: 'Ada',
  cognome: 'Verdi',
  gender: 'F',
  data_nascita: '2019-03-07',
  scuola_id: SEDE_A,
  birth_city: 'NAPOLI',
  birth_province: 'NA',
  birth_nation: 'Italia',
  codice_belfiore_nascita: 'H501',
  codice_fiscale: null as string | null,
  residence_address: 'Via di Prova',
  residence_street_number: '12',
  residence_city: 'Giugliano in Campania',
  residence_province: 'NA',
  zip_code: '80014',
  citizenship: 'Italiana',
  bes: true,
  note_bes: '',
  note_mediche: '',
  allergeni: [] as string[],
}

/**
 * ⚠️ L'ALUNNA CHE RAPPRESENTA LA MAGGIORANZA DELL'ARCHIVIO, non l'eccezione.
 *
 * Niente codice fiscale, niente sesso, niente codice catastale: è la combinazione
 * misurata in produzione l'11 agosto — su 33 alunni **18 senza codice fiscale** e
 * **17 senza il sesso**, con `codice_belfiore_nascita` NULL su **83 record su 83**.
 * Senza sesso e senza codice catastale `verificaCoerenza` non riesce nemmeno a
 * calcolare il codice atteso, quindi non c'è neppure la proposta «Usa questo»: il
 * badge di coerenza **non compare affatto**.
 *
 * È lo stato in cui `aria-describedby` puntava a un elemento inesistente, ed è per
 * questo che la fixture esiste: `ALUNNA` ha il sesso e il codice catastale, quindi il
 * badge lo mostra sempre e non poteva accorgersi di niente.
 */
const ALUNNA_SENZA_CF = {
  id: 'al-2',
  nome: 'Bea',
  cognome: 'Bianchi',
  gender: null as string | null,
  data_nascita: '2020-05-04',
  scuola_id: SEDE_A,
  birth_city: '',
  birth_province: '',
  birth_nation: '',
  codice_belfiore_nascita: null as string | null,
  codice_fiscale: null as string | null,
  residence_address: '',
  residence_street_number: '',
  residence_city: '',
  residence_province: '',
  zip_code: '',
  citizenship: '',
  bes: false,
  note_bes: '',
  note_mediche: '',
  allergeni: [] as string[],
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/anagrafiche/comuni')) return new Response(JSON.stringify(NAPOLI), { status: 200 })
    if (url.includes('/api/admin/sections')) return new Response(JSON.stringify([]), { status: 200 })
    return new Response('[]', { status: 200 })
  }))
})
afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * ⚠️ I RAMI SI APRONO, ALTRIMENTI NON SI MISURA NIENTE. `formData.is_bes_dsa` nasce
 * `false` e `invoice_holder_type` nasce `'mom'`: a riposo le note BES e i tre campi
 * dell'intestatario NON sono nel DOM. Finché restavano chiusi si poteva togliere il
 * loro `htmlFor` e la suite restava verde — provato, ed è la ragione per cui questo
 * helper esiste.
 */
const apriRamiScrollable = async () => {
  fireEvent.click(screen.getByLabelText(/Studente BES \/ DSA/))
  fireEvent.click(screen.getByLabelText(/^Altro Soggetto$/))
  await screen.findByLabelText(/Note BES \/ DSA/)
  await screen.findByLabelText(/Codice Fiscale Intestatario/)
}

/** Il wizard non ha rotta né stato esterno: si cambia passo col suo bottone. */
const avanti = async (volte: number) => {
  for (let i = 0; i < volte; i++) {
    fireEvent.click(screen.getByRole('button', { name: 'Avanti' }))
  }
}

describe('axe · le tre schede dell’alunno, zero violazioni', () => {
  it('ScrollableStudentForm — la scheda montata dal cockpit (`FamilyRegistryManager`)', async () => {
    const { container } = render(<ScrollableStudentForm />)
    await waitFor(() => expect(screen.getByLabelText(/Codice Fiscale/)).toBeInTheDocument())
    expect(await axe(container, axeOpts)).toHaveNoViolations()
  })

  it('ScrollableStudentForm — coi RAMI APERTI: note BES e dettagli intestatario', async () => {
    // I 4 campi che fino all'11 agosto nessuna misura toccava, perché non erano
    // nel DOM: `alunno-note-bes`, `alunno-intestatario-nome/-cognome/-codice-fiscale`.
    const { container } = render(<ScrollableStudentForm />)
    await waitFor(() => expect(screen.getByLabelText(/Codice Fiscale/)).toBeInTheDocument())
    await apriRamiScrollable()
    expect(await axe(container, axeOpts)).toHaveNoViolations()
  })

  it('StudentRegistryForm — non montata da nessuna pagina, ma finché esiste si misura', async () => {
    const { container } = render(<StudentRegistryForm />)
    await waitFor(() => expect(screen.getByLabelText(/Codice Fiscale/)).toBeInTheDocument())
    expect(await axe(container, axeOpts)).toHaveNoViolations()
  })

  it('StudentRegistryForm — passo 2 (residenza), che il solo passo 1 non montava', async () => {
    const { container } = render(<StudentRegistryForm />)
    await waitFor(() => expect(screen.getByLabelText(/Codice Fiscale/)).toBeInTheDocument())
    await avanti(1)
    await screen.findByLabelText(/Indirizzo di Residenza/)
    expect(await axe(container, axeOpts)).toHaveNoViolations()
  })

  it('StudentRegistryForm — passo 3 col ramo BES APERTO', async () => {
    const { container } = render(<StudentRegistryForm />)
    await waitFor(() => expect(screen.getByLabelText(/Codice Fiscale/)).toBeInTheDocument())
    await avanti(2)
    fireEvent.click(await screen.findByLabelText(/Studente BES \/ DSA/))
    await screen.findByLabelText(/Note BES \/ DSA/)
    expect(await axe(container, axeOpts)).toHaveNoViolations()
  })

  it('StudentRegistryForm — passo 4 col ramo intestatario APERTO', async () => {
    const { container } = render(<StudentRegistryForm />)
    await waitFor(() => expect(screen.getByLabelText(/Codice Fiscale/)).toBeInTheDocument())
    await avanti(3)
    fireEvent.click(await screen.findByLabelText(/^Altro Soggetto$/))
    await screen.findByLabelText(/Codice Fiscale Intestatario/)
    expect(await axe(container, axeOpts)).toHaveNoViolations()
  })

  it('StudentDetailPanel — la scheda aperta sui record veri, a dati CARICATI', async () => {
    const { container } = render(
      <StudentDetailPanel
        student={ALUNNA}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
        variant="page"
      />,
    )
    await waitFor(() => expect(screen.getByLabelText(/Codice Fiscale/)).toBeInTheDocument())
    expect(await axe(container, axeOpts)).toHaveNoViolations()
  })
})

describe('ogni campo ha un nome, e ogni `htmlFor` un bersaglio', () => {
  /**
   * axe guarda il singolo elemento; questa misura guarda l'INSIEME. Un `htmlFor`
   * che punta a un `id` inesistente non è una violazione per axe (il campo può
   * avere un nome per un'altra via), ma è un'etichetta che non porta il fuoco da
   * nessuna parte — ed è esattamente il difetto che nasce quando si copia un
   * blocco di JSX senza cambiargli l'`id`. Gli `id` DUPLICATI contano il doppio
   * qui: `FamilyRegistryManager` monta `ScrollableStudentForm` accanto alle
   * schede adulto, e due `id` uguali in pagina rompono `aria-describedby`.
   */
  const verificaEtichette = (container: HTMLElement) => {
    for (const etichetta of Array.from(container.querySelectorAll('label[for]'))) {
      const bersaglio = etichetta.getAttribute('for')!
      expect(container.querySelectorAll(`[id="${CSS.escape(bersaglio)}"]`)).toHaveLength(1)
    }
    const ids = Array.from(container.querySelectorAll('[id]')).map((el) => el.id)
    expect(new Set(ids).size).toBe(ids.length)
  }

  it('ScrollableStudentForm: nessun `for` orfano, nessun `id` duplicato', async () => {
    const { container } = render(<ScrollableStudentForm />)
    await waitFor(() => expect(screen.getByLabelText(/Codice Fiscale/)).toBeInTheDocument())
    verificaEtichette(container)
  })

  it('ScrollableStudentForm coi rami APERTI: i 4 campi condizionali hanno un bersaglio', async () => {
    const { container } = render(<ScrollableStudentForm />)
    await waitFor(() => expect(screen.getByLabelText(/Codice Fiscale/)).toBeInTheDocument())
    await apriRamiScrollable()
    verificaEtichette(container)
    // Nominati uno per uno: `verificaEtichette` non può accorgersi di un campo che
    // qualcuno rimuovesse del tutto, e questi quattro sono quelli che erano scoperti.
    for (const id of ['alunno-note-bes', 'alunno-intestatario-nome', 'alunno-intestatario-cognome', 'alunno-intestatario-codice-fiscale']) {
      expect(container.querySelector(`label[for="${id}"]`)).not.toBeNull()
      expect(container.querySelector(`[id="${id}"]`)).not.toBeNull()
    }
  })

  it('StudentRegistryForm, tutti e quattro i passi: nessun `for` orfano, nessun `id` duplicato', async () => {
    // Questa scheda non passava affatto da `verificaEtichette`: il controllo
    // d'insieme copriva solo le altre due.
    const { container } = render(<StudentRegistryForm />)
    await waitFor(() => expect(screen.getByLabelText(/Codice Fiscale/)).toBeInTheDocument())
    verificaEtichette(container)

    await avanti(1)
    await screen.findByLabelText(/Indirizzo di Residenza/)
    verificaEtichette(container)

    await avanti(1)
    fireEvent.click(await screen.findByLabelText(/Studente BES \/ DSA/))
    await screen.findByLabelText(/Note BES \/ DSA/)
    verificaEtichette(container)
    expect(container.querySelector('label[for="registry-note-bes"]')).not.toBeNull()

    await avanti(1)
    fireEvent.click(await screen.findByLabelText(/^Altro Soggetto$/))
    await screen.findByLabelText(/Codice Fiscale Intestatario/)
    verificaEtichette(container)
    for (const id of ['registry-intestatario-nome', 'registry-intestatario-cognome', 'registry-intestatario-codice-fiscale']) {
      expect(container.querySelector(`label[for="${id}"]`)).not.toBeNull()
      expect(container.querySelector(`[id="${id}"]`)).not.toBeNull()
    }
  })

  it('StudentDetailPanel: nessun `for` orfano, nessun `id` duplicato', async () => {
    const { container } = render(
      <StudentDetailPanel
        student={ALUNNA}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
        variant="page"
      />,
    )
    await waitFor(() => expect(screen.getByLabelText(/Codice Fiscale/)).toBeInTheDocument())
    verificaEtichette(container)
  })
})

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * NESSUN CAMPO RIMANDA A UNA DESCRIZIONE CHE NON ESISTE.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ QUESTO CASO MANCAVA, e non perché fosse esotico: mancava perché tutte le
 * fixture avevano abbastanza dati da far comparire il badge di coerenza. Il campo
 * del codice fiscale porta `aria-describedby` verso `BadgeCoerenzaCf`, che
 * restituisce `null` quando non ha niente da dire — e su un record **senza codice
 * fiscale e senza i dati per calcolarlo** (18 alunni su 33, 17 senza il sesso,
 * `codice_belfiore_nascita` NULL su 83 su 83: misura di produzione dell'11 agosto)
 * il badge non c'è. Chi legge con uno screen reader arrivava sul campo e sentiva un
 * rimando a un elemento che non esiste.
 *
 * ⚠️ E axe NON lo vede: le sette prove qui sopra erano VERDI mentre il difetto era
 * in pagina — provato eseguendole prima della riparazione. `aria-valid-attr-value`
 * non fa fallire un `aria-describedby` orfano, quindi la misura dev'essere questa,
 * esplicita: ogni `id` elencato in `aria-describedby` risolve a un elemento del
 * contenitore.
 */
describe('ogni `aria-describedby` punta a un elemento che esiste', () => {
  /**
   * `aria-describedby` è una LISTA di id separati da spazio: si controllano tutti,
   * uno per uno. Un solo riferimento morto in mezzo a due buoni è comunque un campo
   * che rimanda al nulla.
   */
  const verificaDescrizioni = (container: HTMLElement) => {
    const descritti = Array.from(container.querySelectorAll('[aria-describedby]'))
    for (const el of descritti) {
      const ids = (el.getAttribute('aria-describedby') ?? '').split(' ').filter((s) => s !== '')
      // Un attributo presente ma vuoto è già un difetto: dichiara una descrizione
      // e non ne nomina nessuna.
      expect(ids.length).toBeGreaterThan(0)
      for (const id of ids) {
        expect(container.querySelectorAll(`[id="${CSS.escape(id)}"]`)).toHaveLength(1)
      }
    }
  }

  it('StudentDetailPanel — un record SENZA codice fiscale e senza i dati per calcolarlo', async () => {
    const { container } = render(
      <StudentDetailPanel
        student={ALUNNA_SENZA_CF}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
        variant="page"
      />,
    )
    const campoCf = await screen.findByLabelText(/Codice Fiscale/)

    // La premessa del caso, dichiarata invece che sperata: il badge NON è in pagina.
    expect(container.querySelector('#dettaglio-badge-coerenza-cf')).toBeNull()

    // E quindi il campo non lo nomina. Nominarlo sarebbe un rimando nel vuoto.
    expect(campoCf.getAttribute('aria-describedby')).toBeNull()
    verificaDescrizioni(container)
  })

  it('StudentDetailPanel — e quando il badge C\'È, il campo torna a puntarci', async () => {
    // Il rovescio della misura: senza questo, «togli sempre l'attributo» passerebbe.
    const { container } = render(
      <StudentDetailPanel
        student={ALUNNA}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
        variant="page"
      />,
    )
    const campoCf = await screen.findByLabelText(/Codice Fiscale/)
    expect(campoCf.getAttribute('aria-describedby')).toBe('dettaglio-badge-coerenza-cf')
    verificaDescrizioni(container)
  })

  it('ScrollableStudentForm — scheda appena aperta, che è lo stato senza badge', async () => {
    const { container } = render(<ScrollableStudentForm />)
    const campoCf = await screen.findByLabelText(/Codice Fiscale/)
    expect(container.querySelector('#alunno-badge-coerenza-cf')).toBeNull()
    expect(campoCf.getAttribute('aria-describedby')).toBeNull()
    verificaDescrizioni(container)
  })

  it('StudentRegistryForm — wizard appena aperto, che è lo stato senza badge', async () => {
    const { container } = render(<StudentRegistryForm />)
    const campoCf = await screen.findByLabelText(/Codice Fiscale/)
    expect(container.querySelector('#registry-badge-coerenza-cf')).toBeNull()
    expect(campoCf.getAttribute('aria-describedby')).toBeNull()
    verificaDescrizioni(container)
  })
})
