import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi'

// =============================================================================
// HOME DOCENTE — il riquadro si chiamava «Allergie e note mediche» e di allergie
// non sapeva niente.
//
// L'elenco filtrava `note_mediche`, cioè la casella che il modulo d'iscrizione
// etichetta «Note Mediche (BES, DSA, patologie)». Misurato in produzione il
// 2026-09-07 su 657 iscritti: ZERO delle 44 note nomina un allergene, e 29 bambini
// comparivano in questo riquadro — sotto un titolo che dice «Allergie» — senza
// avere un'allergia. Il conteggio nella frase («N bambini da seguire») era quello.
//
// Ora i gruppi sono DUE nella stessa card, e la frase conta il primo:
//  · «Allergie»     → `haAllergiaOperativa`, con emoji ed etichetta, PIÙ il testo
//                     libero così com'è: al docente non si nasconde niente.
//                     ⚠️ È il predicato LARGO, non `haAllergiaConteggiabile`, e la
//                     ragione è scritta a lettere maiuscole più in basso: QUESTO
//                     RIQUADRO È UN ELENCO, NON UN CONTATORE. Col predicato dei
//                     numeri (i soli 14 UE) sparivano da qui i bambini con
//                     «fragole» o una chiave non canonica;
//  · «Note mediche» → `note_mediche` non vuota e non negata, e la negazione la
//                     decide `isNegazione` del motore: `/nessuna/` a sottostringa
//                     cancellava «Epilessia, nessuna terapia in corso».
//
// Fixture SINTETICHE: nomi inventati, nessun dato reale di minori.
// =============================================================================

const CLASSE = '2 ANNI'
const ID_DOCENTE = 'd0000000-0000-4000-8000-00000000ed00'
const SEC_A = 'aaaa1111-0000-4000-8000-0000000000a1'

const h = vi.hoisted(() => ({
  alunni: [] as Record<string, unknown>[],
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/teacher',
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/lib/auth/use-session-identity', () => ({
  useSessionIdentity: () => ({ userId: ID_DOCENTE, role: 'educator', ready: true }),
}))

vi.mock('@/lib/auth/use-teacher-gradi', () => ({
  useTeacherGradi: () => ({
    gradi: ['infanzia'],
    hasInfanzia: true,
    hasPrimaria: false,
    isPrimariaOnly: false,
    diarioPrimariaVisibile: false,
    ready: true,
  }),
}))

vi.mock('framer-motion', async () => {
  const React = await import('react')
  const motion = new Proxy(
    {},
    {
      get: (_t, tag: string) =>
        React.forwardRef(function M(
          { children, ...props }: { children?: React.ReactNode },
          ref: React.Ref<HTMLElement>,
        ) {
          const {
            initial, animate, exit, variants, transition, whileHover, whileTap, layout, layoutId,
            ...rest
          } = props as Record<string, unknown>
          void initial; void animate; void exit; void variants; void transition
          void whileHover; void whileTap; void layout; void layoutId
          return React.createElement(tag, { ...rest, ref }, children)
        }),
    },
  )
  return { motion, AnimatePresence: ({ children }: { children?: React.ReactNode }) => children }
})

import TeacherDashboardPage from '@/app/(dashboard)/teacher/page'

const risposta = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response

function montaFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith('/api/educator-sections')) {
      return risposta({
        sectionNames: [CLASSE],
        sections: [{ id: SEC_A, name: CLASSE, scuolaId: SEDE_A, scuolaNome: NOME_SEDE_A, school_type: 'nido' }],
        role: 'educator',
      })
    }
    if (url.startsWith('/api/primaria/me')) {
      return risposta({ success: true, data: { gradi: ['infanzia'], funzioni: {} } })
    }
    if (url.startsWith('/api/diary/students')) return risposta(h.alunni)
    if (url.startsWith('/api/avvisi')) return risposta([])
    if (url.startsWith('/api/agenda')) return risposta({ success: true, data: [] })
    return risposta([])
  })
}

const NOTA = 'Terapia sintetica di prova'
/** Nota lunga in cui la parola «nessuna» compare, e non nega niente. */
const NOTA_CON_NESSUNA = 'Epilessia, nessuna terapia in corso'

beforeEach(() => {
  h.alunni = [
    // 1. Allergene riconosciuto fra i 14 UE, dal testo libero.
    { id: 'a1', nome: 'Alfa', cognome: 'Uno', note_mediche: null, allergeni: [], allergies: 'arachidi', consenso_privacy: true },
    // 2. SOLO nota medica: non è un'allergia, e non deve stare nel primo gruppo
    //    né entrare nel conteggio della frase.
    { id: 'a2', nome: 'Beta', cognome: 'Due', note_mediche: NOTA, allergeni: [], allergies: null, consenso_privacy: true },
    // 3. Riconosciuto PIÙ residuo: «lattosio» diventa l'etichetta «Latte /
    //    lattosio», «fragole» non è fra i 14 — e il testo si vede lo stesso, per
    //    intero. È il punto del gruppo: al docente non si nasconde niente.
    { id: 'a3', nome: 'Gamma', cognome: 'Tre', note_mediche: null, allergeni: [], allergies: 'lattosio, fragole', consenso_privacy: true },
    // 4. Negazione: non è un'allergia.
    { id: 'a4', nome: 'Delta', cognome: 'Quattro', note_mediche: null, allergeni: [], allergies: 'nessuna', consenso_privacy: true },
    // 5. SOLO un testo fuori dai 14 UE. QUESTO RIQUADRO È UN ELENCO, non un
    //    contatore: Epsilon ci deve stare. Misurato in produzione il 2026-09-07:
    //    57 bambini hanno una restrizione scritta e non negata, 27 la nominano fra
    //    i 14 UE — col criterio del contatore ne sparivano 30, e la riga sapeva
    //    già mostrare il testo libero accanto alle etichette.
    { id: 'a5', nome: 'Epsilon', cognome: 'Cinque', note_mediche: null, allergeni: [], allergies: 'fragole', consenso_privacy: true },
    // 6. Chiave STRUTTURATA fuori dalle 14: in archivio c'è, e `normalizzaAllergeni`
    //    la scartava in silenzio — riga col solo nome, nessuna etichetta.
    { id: 'a6', nome: 'Eta', cognome: 'Sette', note_mediche: null, allergeni: ['nichel'], allergies: null, consenso_privacy: true },
    // 7. NOTA MEDICA CHE CONTIENE «nessuna» E DICE TUTT'ALTRO. Il filtro era
    //    `!/nessuna/i.test(...)`, cioè il criterio a SOTTOSTRINGA che il motore
    //    vieta per iscritto — applicato alla colonna sanitaria più delicata
    //    dell'anagrafica. Questa nota spariva per intero.
    { id: 'a7', nome: 'Theta', cognome: 'Otto', note_mediche: NOTA_CON_NESSUNA, allergeni: [], allergies: null, consenso_privacy: true },
    // 8. NOTA CHE NEGA DAVVERO: «Nessuna» non è una nota da leggere.
    { id: 'a8', nome: 'Iota', cognome: 'Nove', note_mediche: 'Nessuna', allergeni: [], allergies: null, consenso_privacy: true },
  ]
  vi.stubGlobal('fetch', montaFetch())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** La card «Allergie e note mediche» per intero. */
async function card(): Promise<HTMLElement> {
  const titolo = await screen.findByText('Allergie e note mediche')
  return titolo.closest('section') as HTMLElement
}

describe('Home docente — due gruppi nella card «Allergie e note mediche»', () => {
  it('l\'allergia sta nel gruppo ALLERGIE, con l\'etichetta dell\'allergene', async () => {
    render(<TeacherDashboardPage />)
    const c = await card()
    await waitFor(() => expect(within(c).getByText('Alfa Uno')).toBeInTheDocument())
    expect(within(c).getByText('Arachidi')).toBeInTheDocument()
    // Il testo libero resta accanto all'etichetta: è ciò che la persona ha scritto.
    expect(within(c).getByText('arachidi')).toBeInTheDocument()
  })

  it('la NOTA MEDICA non finisce fra le allergie, e ha il suo gruppo', async () => {
    render(<TeacherDashboardPage />)
    const c = await card()
    await waitFor(() => expect(within(c).getByText('Beta Due')).toBeInTheDocument())
    expect(within(c).getByText('Allergie')).toBeInTheDocument()
    expect(within(c).getByText('Note mediche')).toBeInTheDocument()
    // La nota si vede, come prima, ma sotto la sua etichetta.
    expect(within(c).getByText(NOTA)).toBeInTheDocument()
  })

  it('IL CONTEGGIO DELLA FRASE È QUELLO DELL\'ELENCO: 4, non 1 e non 6', async () => {
    // Prima contava le NOTE MEDICHE, e qui avrebbe detto «1 bambino» — quello che
    // un'allergia non ce l'ha. Poi ha contato i soli 14 UE e ne diceva 2, lasciando
    // fuori dall'ELENCO chi ha «fragole» o una chiave non canonica: 30 bambini su
    // 57, misurati in produzione. Il numero della frase è la lunghezza della lista
    // che sta sotto — Alfa, Gamma, Epsilon, Eta — e Beta («solo nota») e Delta
    // («nessuna») restano fuori.
    render(<TeacherDashboardPage />)
    const c = await card()
    await waitFor(() => expect(within(c).getByText('Alfa Uno')).toBeInTheDocument())
    expect(within(c).getByText(`4 bambini da seguire · sezione ${CLASSE}`)).toBeInTheDocument()
  })

  it('il testo NON riconosciuto resta accanto all\'etichetta: «fragole» non sparisce', async () => {
    render(<TeacherDashboardPage />)
    const c = await card()
    await waitFor(() => expect(within(c).getByText('Gamma Tre')).toBeInTheDocument())
    // «lattosio» diventa un'etichetta canonica…
    expect(within(c).getByText('Latte / lattosio')).toBeInTheDocument()
    // …e il testo per intero resta, con dentro la parola che i 14 UE non hanno.
    expect(within(c).getByText('lattosio, fragole')).toBeInTheDocument()
  })

  it('«nessuna» non è un\'allergia: quel bambino non compare affatto', async () => {
    render(<TeacherDashboardPage />)
    const c = await card()
    await waitFor(() => expect(within(c).getByText('Alfa Uno')).toBeInTheDocument())
    expect(within(c).queryByText('Delta Quattro')).toBeNull()
  })

  it('UN TESTO SOLO FUORI DAI 14 UE STA NELL\'ELENCO: «fragole» è un\'allergia vera', async () => {
    // È il rilievo: l'appartenenza a QUESTO gruppo si decideva col predicato dei
    // CONTATORI (i 14 UE), e Epsilon spariva da una card che sa già mostrare il
    // testo libero accanto alle etichette. Contare e elencare sono due domande:
    // la StatCard dell'anagrafica e il segnale `ha_allergie` della rotta contano
    // (e restano sui 14 UE), il docente in classe legge un elenco.
    render(<TeacherDashboardPage />)
    const c = await card()
    await waitFor(() => expect(within(c).getByText('Alfa Uno')).toBeInTheDocument())
    expect(within(c).getByText('Epsilon Cinque')).toBeInTheDocument()
    expect(within(c).getByText('fragole')).toBeInTheDocument()
  })

  it('una chiave STRUTTURATA fuori dalle 14 non lascia una riga muta', async () => {
    // `normalizzaAllergeni` scartava «nichel» in silenzio: senza testo libero, la
    // riga sarebbe comparsa col solo nome e nessuna etichetta accanto.
    //
    // ⚠️ Il matcher è una REGEX, e la ragione sta nel mock di next-intl
    // (`test/setup.ts`): `t.has()` risponde sempre `true`, quindi il ramo di
    // ripiego di `useAllergeneLabel` — quello che per una chiave sconosciuta
    // restituisce la chiave grezza — qui non si può percorrere, e al suo posto
    // esce il nome della chiave i18n. Ciò che questa prova sorveglia è che la
    // chiave arrivi fino al badge invece di essere scartata; che il ripiego dia
    // «nichel» lo misura `etichetteAllergie` in `allergeni-motore.test.ts`.
    render(<TeacherDashboardPage />)
    const c = await card()
    await waitFor(() => expect(within(c).getByText('Eta Sette')).toBeInTheDocument())
    expect(within(c).getByText(/nichel/)).toBeInTheDocument()
  })

  it('🔴 UNA NOTA CHE CONTIENE «NESSUNA» NON È UNA NEGAZIONE: il bambino resta', async () => {
    // Il filtro del gruppo note mediche era `!/nessuna/i.test(s.note_mediche)`:
    // la stessa regex a sottostringa che tutto il motore dichiara pericolosa
    // («cancella un bambino vero»), qui su BES, DSA e patologie. Una nota che
    // dice «Epilessia, nessuna terapia in corso» spariva dalla card.
    // Misurato in produzione il 2026-09-07: 44 note, 3 contengono «nessun», 0
    // più lunghe della sola parola — latente, non attivo. Adesso decide
    // `isNegazione`, a vocabolario intero, come ovunque altrove.
    render(<TeacherDashboardPage />)
    const c = await card()
    await waitFor(() => expect(within(c).getByText('Alfa Uno')).toBeInTheDocument())
    expect(within(c).getByText('Theta Otto')).toBeInTheDocument()
    expect(within(c).getByText(NOTA_CON_NESSUNA)).toBeInTheDocument()
  })

  it('una nota che nega DAVVERO resta fuori: «Nessuna» non si legge', async () => {
    render(<TeacherDashboardPage />)
    const c = await card()
    await waitFor(() => expect(within(c).getByText('Alfa Uno')).toBeInTheDocument())
    expect(within(c).queryByText('Iota Nove')).toBeNull()
  })

  it('con SOLE note mediche la frase parla di quelle, non di «0 bambini»', async () => {
    // Ramo che nessun'altra prova tocca: il conteggio della frase è quello delle
    // allergie, e quando sono zero dire «0 bambini da seguire» sopra un elenco
    // pieno sarebbe peggio che non dire niente.
    h.alunni = [{ id: 'a2', nome: 'Beta', cognome: 'Due', note_mediche: NOTA, allergeni: [], allergies: null, consenso_privacy: true }]
    render(<TeacherDashboardPage />)
    const c = await card()
    await waitFor(() => expect(within(c).getByText('Beta Due')).toBeInTheDocument())
    expect(within(c).getByText('1 nota medica da leggere')).toBeInTheDocument()
    // E il gruppo «Allergie» non c'è affatto: nessuna intestazione vuota.
    expect(within(c).queryByText('Allergie')).toBeNull()
  })

  it('senza allergie e senza note mediche la card non c\'è', async () => {
    h.alunni = [{ id: 'a9', nome: 'Zeta', cognome: 'Sei', note_mediche: null, allergeni: [], allergies: null, consenso_privacy: true }]
    render(<TeacherDashboardPage />)
    // L'attesa è su una cosa che DEVE comparire, così «non c'è la card» non è
    // verde solo perché la pagina non ha ancora finito di rendere.
    await waitFor(() => expect(screen.getByText('Appello del giorno')).toBeInTheDocument())
    expect(screen.queryByText('Allergie e note mediche')).toBeNull()
  })
})
