import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'
import itAdminSettings from '../../messages/it/adminSettings.json'
import enAdminSettings from '../../messages/en/adminSettings.json'

/**
 * W3-C — Impostazioni: TUTTE e 15 le sezioni dichiarano la sede.
 *
 * `admin_settings` ha UNA riga per sede: ogni pannello di questa pagina configura
 * UN plesso. Dieci sezioni su quindici però chiedevano la configurazione con il
 * solo `userId` (`useAdminSettings(userId)`), lasciando che fosse il server a
 * indovinare la sede. Finché il plesso era uno solo l'indovinello aveva sempre
 * ragione. Con tre plessi ha due esiti, entrambi pessimi:
 *
 *  - prima del 31/07 `resolveScuolaScrittura` ripiegava in silenzio su
 *    `utenti.scuola_id`: chi credeva di configurare Aversa cambiava i permessi
 *    della chat, degli avvisi e delle presenze DI GIUGLIANO, senza errore;
 *  - dal 31/07 quel ripiego è un **400**: gli stessi dieci pannelli si limitano a
 *    non salvare, e il selettore di sede in cima alla pagina resta decorativo.
 *
 * Il test guarda il giro COMPLETO: dal selettore (cookie `sedi_attive` letto dal
 * vero `SedeProvider`) fino alla querystring della GET e al corpo della PATCH.
 * Niente mock di `sede-context`: la guardia sotto esame è quella vera.
 */

// ─── Ambiente minimo della pagina ────────────────────────────────────────────
const nav = vi.hoisted(() => ({ replace: vi.fn(), search: '' }))

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ replace: nav.replace, push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/impostazioni',
}))

vi.mock('@/lib/auth/use-session-identity', () => ({
  useSessionIdentity: () => ({ userId: 'u1', role: 'admin', ready: true }),
}))

// `SedeProvider` prende l'identità da qui (non da useSessionIdentity).
vi.mock('@/lib/context/admin-identity', () => ({
  useAdminIdentity: () => ({ userId: 'u1', ruolo: 'admin', withUser: (h: string) => h }),
  AdminIdentityProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

import { SedeProvider, useSediAttive } from '@/lib/context/sede-context'
import AdminImpostazioniPage from '@/app/(dashboard)/admin/impostazioni/page'
import { DiarioSettings } from '@/components/features/admin/settings/DiarioSettings'

/**
 * Il selettore di sede vero (`SedeSelector`, dentro la topbar del cockpit) non
 * è montato in questo test: qui si pilota lo STESSO contesto con la stessa
 * chiamata che usa lui (`soloSede`), così il giro è quello reale.
 */
function CambiaSede({ verso }: { verso: string }) {
  const { soloSede } = useSediAttive()
  return <button onClick={() => soloSede(verso)}>cambia-sede</button>
}

// ─── Rete finta ──────────────────────────────────────────────────────────────
interface Chiamata { url: string; metodo: string; corpo: Record<string, unknown> | null }
const chiamate: Chiamata[] = []

const SEDI = [
  { id: SEDE_A, nome: NOME_SEDE_A },
  { id: SEDE_B, nome: NOME_SEDE_B },
]

/** La configurazione È per sede: il finto server la serve per sede, come il vero. */
const impostazioniDi = (scuolaId: string): Record<string, unknown> => ({
  scuola_id: scuolaId,
  funzioni_matrice: {},
  // Entrambe le sedi hanno le note libere ATTIVE: così, dopo un cambio sede, una
  // casella spenta non può che venire dalla bozza della sede precedente.
  diario_config: { note_libere_abilitate: true },
  presenze_config: {},
  note_config: {},
  avvisi_config: {},
  chat_config: {},
  galleria_config: {},
  armadietto_config: {},
  modulistica_config: {},
  notifiche_config: { toggles: {} },
})

const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
  const u = String(url)
  chiamate.push({
    url: u,
    metodo: init?.method ?? 'GET',
    corpo: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
  })
  if (u.startsWith('/api/admin/sedi')) {
    return { ok: true, status: 200, json: async () => SEDI }
  }
  if (u.startsWith('/api/admin/settings')) {
    const chiesta = new URLSearchParams(u.split('?')[1] ?? '').get('scuola_id')
      ?? (init?.body ? (JSON.parse(init.body) as { scuola_id?: string }).scuola_id : null)
    return { ok: true, status: 200, json: async () => ({ success: true, data: impostazioniDi(chiesta ?? SEDE_A) }) }
  }
  return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) }
})

/** Le sole chiamate che configurano un plesso: sono quelle che devono dire QUALE. */
const chiamateSettings = () => chiamate.filter((c) => c.url.startsWith('/api/admin/settings'))

function scegliSede(id?: string) {
  document.cookie = `sedi_attive=${id ?? ''}; path=/`
}

// Le 15 voci della pagina, con l'etichetta con cui compaiono nella navigazione.
const VOCI: { id: string; etichetta: string }[] = [
  { id: 'moduli', etichetta: itAdminSettings.voceFunzioniModuli },
  { id: 'pagamenti', etichetta: itAdminSettings.vocePagamenti },
  { id: 'rette', etichetta: itAdminSettings.voceRette },
  { id: 'modulistica', etichetta: itAdminSettings.voceModulistica },
  { id: 'didattica', etichetta: itAdminSettings.voceDidattica },
  { id: 'pagelle', etichetta: itAdminSettings.vocePagelle },
  { id: 'diario', etichetta: itAdminSettings.voceDiario },
  { id: 'presenze', etichetta: itAdminSettings.vocePresenze },
  { id: 'note', etichetta: itAdminSettings.voceNote },
  { id: 'mensa', etichetta: itAdminSettings.voceMensa },
  { id: 'armadietto', etichetta: itAdminSettings.voceArmadietto },
  { id: 'avvisi', etichetta: itAdminSettings.voceAvvisi },
  { id: 'chat', etichetta: itAdminSettings.voceChat },
  { id: 'galleria', etichetta: itAdminSettings.voceGalleria },
  { id: 'notifiche', etichetta: itAdminSettings.voceNotifiche },
]

const paginaConSedi = (cambioVerso?: string) =>
  render(
    <SedeProvider>
      {cambioVerso ? <CambiaSede verso={cambioVerso} /> : null}
      <AdminImpostazioniPage />
    </SedeProvider>,
  )

beforeEach(() => {
  vi.clearAllMocks()
  chiamate.length = 0
  scegliSede()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  scegliSede()
})

// -----------------------------------------------------------------------------
// 1. Sede ambigua ⇒ nessuna sezione configura niente
// -----------------------------------------------------------------------------

describe('Impostazioni — con più sedi attive nessuna sezione lavora alla cieca', () => {
  it.each(VOCI)('la sezione «$etichetta» chiede di scegliere la sede e non interroga il server', async ({ etichetta }) => {
    paginaConSedi()
    // Le due sedi sono caricate: la selezione è ambigua (nessun cookie).
    await waitFor(() => expect(chiamate.some((c) => c.url.startsWith('/api/admin/sedi'))).toBe(true))

    fireEvent.click(screen.getAllByRole('button', { name: new RegExp(etichetta, 'i') })[0])

    expect(await screen.findByText('Seleziona una sede')).toBeInTheDocument()
    expect(chiamateSettings()).toEqual([])
  })
})

// -----------------------------------------------------------------------------
// 2. Sede scelta ⇒ la sede fa tutto il giro, fino alla query e al corpo
// -----------------------------------------------------------------------------

describe('Impostazioni — la sede scelta arriva al server, in lettura e in scrittura', () => {
  it('la GET della configurazione porta la sede scelta nella querystring', async () => {
    scegliSede(SEDE_B)
    paginaConSedi()

    fireEvent.click(screen.getAllByRole('button', { name: new RegExp(itAdminSettings.voceDiario, 'i') })[0])

    await waitFor(() => expect(chiamateSettings().length).toBeGreaterThan(0))
    const lette = chiamateSettings().filter((c) => c.metodo === 'GET')
    expect(lette.length).toBeGreaterThan(0)
    for (const c of lette) expect(c.url).toContain(`scuola_id=${SEDE_B}`)
  })

  it('la PATCH del salvataggio DICHIARA la sede scelta nel corpo', async () => {
    scegliSede(SEDE_B)
    paginaConSedi()

    fireEvent.click(screen.getAllByRole('button', { name: new RegExp(itAdminSettings.voceDiario, 'i') })[0])
    const salva = await screen.findByRole('button', { name: /^salva$/i })
    fireEvent.click(salva)

    await waitFor(() => expect(chiamateSettings().some((c) => c.metodo === 'PATCH')).toBe(true))
    const patch = chiamateSettings().find((c) => c.metodo === 'PATCH')!
    expect(patch.corpo?.scuola_id).toBe(SEDE_B)
    expect(patch.corpo).toHaveProperty('diario_config')
  })

  it('il nome della sede in configurazione è scritto in testa al pannello', async () => {
    scegliSede(SEDE_B)
    paginaConSedi()

    fireEvent.click(screen.getAllByRole('button', { name: new RegExp(itAdminSettings.voceDiario, 'i') })[0])

    expect(await screen.findByText(new RegExp(NOME_SEDE_B))).toBeInTheDocument()
    expect(screen.queryByText(new RegExp(NOME_SEDE_A))).not.toBeInTheDocument()
  })
})

// -----------------------------------------------------------------------------
// 3. Il pannello segue la sede: cambiarla ricarica la configurazione di QUELLA
// -----------------------------------------------------------------------------

describe('Impostazioni — cambiare sede riparte da capo, senza portarsi dietro l\'altra', () => {
  it('la configurazione della sede nuova viene riletta dal server', async () => {
    scegliSede(SEDE_A)
    paginaConSedi(SEDE_B)
    fireEvent.click(screen.getAllByRole('button', { name: new RegExp(itAdminSettings.voceDiario, 'i') })[0])
    await waitFor(() => expect(chiamateSettings().some((c) => c.url.includes(`scuola_id=${SEDE_A}`))).toBe(true))

    fireEvent.click(screen.getByText('cambia-sede'))

    await waitFor(() => expect(chiamateSettings().some((c) => c.url.includes(`scuola_id=${SEDE_B}`))).toBe(true))
    expect(await screen.findByText(new RegExp(NOME_SEDE_B))).toBeInTheDocument()
  })

  it('le modifiche non salvate della sede precedente NON restano in pagina', async () => {
    scegliSede(SEDE_A)
    paginaConSedi(SEDE_B)
    fireEvent.click(screen.getAllByRole('button', { name: new RegExp(itAdminSettings.voceDiario, 'i') })[0])

    // Sulla sede A l'operatore spegne le note libere, e NON salva.
    const noteLibere = () => screen.getByLabelText(itAdminSettings.diNoteLibere) as HTMLInputElement
    await waitFor(() => expect(noteLibere().checked).toBe(true))
    fireEvent.click(noteLibere())
    expect(noteLibere().checked).toBe(false)

    // Passa alla sede B: la bozza dell'altra sede non deve sopravvivere, o il
    // prossimo «Salva» scriverebbe su B una scelta fatta guardando A.
    fireEvent.click(screen.getByText('cambia-sede'))

    await waitFor(() => expect(noteLibere().checked).toBe(true))
  })

  // Il rimontaggio della pagina (`key={sid}`) e la dipendenza dell'effetto sono
  // due difese distinte: qui si prova la seconda da sola, cambiando la sede
  // SENZA rimontare, così un domani nessuna delle due può sparire in silenzio.
  it('anche senza rimontaggio, cambiare `scuolaId` rilegge la sede nuova', async () => {
    const { rerender } = render(<DiarioSettings userId="u1" scuolaId={SEDE_A} />)
    await waitFor(() => expect(chiamateSettings().some((c) => c.url.includes(`scuola_id=${SEDE_A}`))).toBe(true))

    rerender(<DiarioSettings userId="u1" scuolaId={SEDE_B} />)
    await waitFor(() => expect(chiamateSettings().some((c) => c.url.includes(`scuola_id=${SEDE_B}`))).toBe(true))
  })

  it('la sede del pannello non è sovrascrivibile dal corpo del salvataggio', async () => {
    // `save({...})` è chiamato dai pannelli con le sole chiavi di configurazione:
    // se un domani ne passasse una di nome `scuola_id`, a vincere deve restare la
    // sede del selettore — non il pannello.
    render(<DiarioSettings userId="u1" scuolaId={SEDE_A} />)
    fireEvent.click(await screen.findByRole('button', { name: /^salva$/i }))
    await waitFor(() => expect(chiamateSettings().some((c) => c.metodo === 'PATCH')).toBe(true))
    expect(chiamateSettings().find((c) => c.metodo === 'PATCH')!.corpo?.scuola_id).toBe(SEDE_A)
  })
})

// -----------------------------------------------------------------------------
// 4. Catalogo i18n
// -----------------------------------------------------------------------------

describe('Impostazioni — le etichette nuove esistono in entrambe le lingue', () => {
  const CHIAVI = [
    'sedeRequiredModuli', 'sedeRequiredModulistica', 'sedeRequiredDiario',
    'sedeRequiredPresenze', 'sedeRequiredNote', 'sedeRequiredArmadietto',
    'sedeRequiredAvvisi', 'sedeRequiredChat', 'sedeRequiredGalleria',
    'sedeRequiredNotifiche', 'sedeInConfigurazione', 'sedeSconosciuta',
  ]

  it.each(CHIAVI)('«%s» c\'è in it e in en', (k) => {
    expect(itAdminSettings).toHaveProperty(k)
    expect(enAdminSettings).toHaveProperty(k)
  })

  it('adminSettings: it ed en espongono lo stesso set di chiavi', () => {
    expect(Object.keys(itAdminSettings).sort()).toEqual(Object.keys(enAdminSettings).sort())
  })
})
