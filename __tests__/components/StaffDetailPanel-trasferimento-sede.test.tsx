import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'

import { SEDE_A, SEDE_B, SEDE_C, NOME_SEDE_A, NOME_SEDE_B, NOME_SEDE_C } from '../fixtures/sedi'

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  T6-C · SPOSTARE UN MEMBRO DELLO STAFF, DA UNO SCHERMO                  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * La tendina della sede su questa scheda ESISTE dal primo giorno. Quello che non
 * funzionava sono le due estremità:
 *
 *  1. ⚠️ SI RIEMPIVA DA `admin/staff:GET` (`j.schools`), cioè dalle sedi in cui
 *     l'utente LAVORA. Per una direttrice di Giugliano sono due sedi su tre, e la
 *     terza — l'unica che serve, perché un trasferimento è per definizione verso
 *     un plesso in cui la persona NON è ancora — non compariva. Nessun errore,
 *     nessun log: semplicemente una voce che non c'era. Le destinazioni le decide
 *     `GET /api/admin/sedi/destinazioni`, ed è più larga delle proprie sedi.
 *
 *  2. ⚠️ `canEdit` ERA `admin || coordinator`, e dal 2026-09-04 il server concede
 *     alla SEGRETERIA lo spostamento di sede (e nient'altro:
 *     `INCARICO_STAFF_RISERVATO` su ruolo, fasce d'età, classi e sugli account di
 *     Direzione). Un permesso concesso lato server e irraggiungibile lato client
 *     è un permesso che non esiste — e la strada che resta è la `UPDATE` a mano.
 *
 *     La scelta fatta qui NON è allargare `canEdit`: sarebbe stata una trappola.
 *     Il server calcola i cambi per DIFFERENZA, quindi una segretaria che toccasse
 *     anche una classe si vedrebbe rifiutare l'INTERO salvataggio, sede compresa,
 *     con un 403 che parla di un campo che non voleva cambiare. E `canEdit`
 *     governa anche il RUOLO: chi può cambiarlo può promuovere una collega ad
 *     `admin` e da lì rigenerarne le credenziali — è la riserva che tiene in piedi
 *     l'altra. Perciò la Segreteria ottiene un comando SUO, che apre la sola
 *     tendina della sede e manda il corpo minimo `{ id, scuola_id }`.
 */

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))

let ruoloCorrente = 'admin'
vi.mock('@/lib/auth/use-session-identity', () => ({
  useSessionIdentity: () => ({ userId: 'u-1', role: ruoloCorrente, ready: true }),
}))

const STAFF_ID = 'st-1'

/** Il membro aperto nella scheda: una maestra della sede B. */
const MEMBRO = {
  id: STAFF_ID,
  nome: 'Prova',
  cognome: 'Esempio',
  email: 'prova@esempio.test',
  ruolo: 'educator',
  scuola_id: SEDE_B,
  gradi: [],
}

/** ⚠️ `j.schools` porta SOLO le sedi dell'utente: è il difetto, non il contratto. */
const SCUOLE_DELL_UTENTE = [{ id: SEDE_B, nome: NOME_SEDE_B }]

const TRE_SEDI = [
  { id: SEDE_A, nome: NOME_SEDE_A },
  { id: SEDE_B, nome: NOME_SEDE_B },
  { id: SEDE_C, nome: NOME_SEDE_C },
]

let destinazioni: { stato: number; corpo: unknown }
let esitoPatch: { stato: number; corpo: unknown }
const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  ruoloCorrente = 'admin'
  destinazioni = { stato: 200, corpo: { success: true, data: TRE_SEDI, motivo: 'ok' } }
  esitoPatch = { stato: 200, corpo: { success: true } }
  fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(String(url), 'http://t.test')
    if (u.pathname === '/api/admin/sedi/destinazioni') {
      return Promise.resolve({ ok: destinazioni.stato < 400, status: destinazioni.stato, json: async () => destinazioni.corpo })
    }
    if (u.pathname === '/api/admin/staff' && init?.method === 'PATCH') {
      return Promise.resolve({ ok: esitoPatch.stato < 400, status: esitoPatch.stato, json: async () => esitoPatch.corpo })
    }
    if (u.pathname === '/api/admin/staff') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: [MEMBRO],
          schools: SCUOLE_DELL_UTENTE,
          // ⚠️ Le classi ci SONO nel mock, e non è arredamento: senza, la
          // modalità «solo sede» sarebbe verde anche mostrando le pillole delle
          // classi, perché non ce ne sarebbe nessuna da mostrare. Un mock piatto
          // è verde con e senza la correzione.
          sections: [{ id: 'sez-b1', name: 'LEONI', school_type: 'infanzia', scuola_id: SEDE_B }],
          assegnazioni: [{ utente_id: STAFF_ID, section_id: 'sez-b1' }],
        }),
      })
    }
    // Anagrafica del personale: 404 = «assente», non un guasto.
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) })
  })
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('alert', vi.fn())
})

afterEach(() => cleanup())

import { StaffDetailPanel } from '@/components/features/admin/StaffDetailPanel'

const apri = () => render(<StaffDetailPanel staffId={STAFF_ID} onClose={() => {}} />)

const tendinaSede = () => document.querySelector('select[name="incarico_sede"]') as HTMLSelectElement | null
const vociSede = () => Array.from(tendinaSede()?.options ?? []).map((o) => o.textContent ?? '')
/** Le classi PREMIBILI: sono `<button aria-pressed>`, le sole che assegnano. */
const pilloleClasse = () =>
  Array.from(document.querySelectorAll('button[aria-pressed]')).map((b) => (b.textContent ?? '').trim())
const patchInviati = () =>
  fetchMock.mock.calls
    .filter((c) => String(c[0]).includes('/api/admin/staff') && (c[1] as { method?: string })?.method === 'PATCH')
    .map((c) => JSON.parse(String((c[1] as { body?: string }).body)))

describe('StaffDetailPanel — la sede si sposta, e chi può farlo lo vede', () => {
  it('DIREZIONE: la tendina porta TUTTE le destinazioni, non solo le sedi dell’utente', async () => {
    apri()

    fireEvent.click(await screen.findByRole('button', { name: /modifica/i }))
    await waitFor(() => expect(tendinaSede()).not.toBeNull())

    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toContain('/api/admin/sedi/destinazioni')
    // La terza sede NON è fra quelle dell'utente (`j.schools`) ed è proprio quella
    // che deve comparire: è il difetto che questo test chiude.
    expect(vociSede()).toContain(NOME_SEDE_C)
    expect(vociSede()).toContain(NOME_SEDE_A)
    // ⚠️ Controprova del test della Segreteria: qui la classe È premibile. Senza
    // questa riga, «le classi restano in sola lettura» sarebbe verde anche su una
    // scheda che non mostra nessuna classe.
    expect(pilloleClasse()).toContain('LEONI')
  })

  it('SEGRETERIA: il comando c’è, e apre la sola sede — ruolo e classi restano in sola lettura', async () => {
    ruoloCorrente = 'segreteria'
    apri()

    // Prima di questo lavoro qui non c'era NIENTE: nessun «Modifica», nessun comando.
    fireEvent.click(await screen.findByTestId('staff-sposta-sede'))

    await waitFor(() => expect(tendinaSede()).not.toBeNull())
    // Il ruolo NON si tocca: chi può cambiarlo può promuovere una collega ad admin.
    expect(document.querySelector('select[name="incarico_ruolo"]')).toBeNull()
    // E nemmeno le classi: il server le rifiuterebbe INSIEME alla sede, e sullo
    // spostamento riuscito le sgancia da solo. La classe si LEGGE, non si preme.
    expect(pilloleClasse()).not.toContain('LEONI')
    expect(document.body.textContent).toContain('LEONI')
  })

  it('SEGRETERIA: il PATCH parte col corpo minimo {id, scuola_id}', async () => {
    ruoloCorrente = 'segreteria'
    apri()

    fireEvent.click(await screen.findByTestId('staff-sposta-sede'))
    await waitFor(() => expect(tendinaSede()).not.toBeNull())
    fireEvent.change(tendinaSede() as HTMLSelectElement, { target: { value: SEDE_C } })
    fireEvent.click(screen.getByTestId('staff-sede-salva'))

    await waitFor(() => expect(patchInviati()).toHaveLength(1))
    expect(patchInviati()[0]).toEqual({ id: STAFF_ID, scuola_id: SEDE_C })
  })

  it('DIREZIONE: il salvataggio completo continua a portare ruolo e classi', async () => {
    apri()

    fireEvent.click(await screen.findByRole('button', { name: /modifica/i }))
    await waitFor(() => expect(tendinaSede()).not.toBeNull())
    fireEvent.change(tendinaSede() as HTMLSelectElement, { target: { value: SEDE_A } })
    fireEvent.click(screen.getByTestId('staff-sede-salva'))

    await waitFor(() => expect(patchInviati()).toHaveLength(1))
    expect(patchInviati()[0]).toMatchObject({ id: STAFF_ID, scuola_id: SEDE_A, ruolo: 'educator' })
    expect(patchInviati()[0]).toHaveProperty('section_ids')
  })

  it('il rifiuto del server si legge dal CATALOGO, in pagina e non in un alert()', async () => {
    ruoloCorrente = 'segreteria'
    esitoPatch = {
      stato: 403,
      corpo: {
        error: 'Ruolo, fasce d’età e classi si cambiano dalla Direzione…',
        codice: 'INCARICO_STAFF_RISERVATO',
      },
    }
    apri()

    fireEvent.click(await screen.findByTestId('staff-sposta-sede'))
    await waitFor(() => expect(tendinaSede()).not.toBeNull())
    fireEvent.change(tendinaSede() as HTMLSelectElement, { target: { value: SEDE_A } })
    fireEvent.click(screen.getByTestId('staff-sede-salva'))

    const errore = await screen.findByTestId('staff-sede-errore')
    expect(errore.getAttribute('role')).toBe('alert')
    expect(errore.textContent?.trim().length ?? 0).toBeGreaterThan(10)
  })

  it('SEDE_NON_ACCESSIBILE si legge in italiano dal catalogo', async () => {
    ruoloCorrente = 'segreteria'
    esitoPatch = { stato: 403, corpo: { error: 'boom', codice: 'SEDE_NON_ACCESSIBILE' } }
    apri()

    fireEvent.click(await screen.findByTestId('staff-sposta-sede'))
    await waitFor(() => expect(tendinaSede()).not.toBeNull())
    fireEvent.change(tendinaSede() as HTMLSelectElement, { target: { value: SEDE_A } })
    fireEvent.click(screen.getByTestId('staff-sede-salva'))

    const errore = await screen.findByTestId('staff-sede-errore')
    expect(errore.textContent).toContain('Sede non accessibile')
    expect(errore.textContent).not.toContain('boom')
  })

  it('⚠️ SEGRETERIA su un account di DIREZIONE: nessun comando, perché il server lo negherebbe', async () => {
    // `puoModificareIncaricoStaff` nega alla Segreteria QUALUNQUE modifica a un
    // account di Direzione, sede compresa (`bersaglio-direzione`). Offrire il
    // comando sarebbe offrire un 403 — la trappola che questo lavoro evita.
    ruoloCorrente = 'segreteria'
    fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
      const u = new URL(String(url), 'http://t.test')
      if (u.pathname === '/api/admin/sedi/destinazioni') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: TRE_SEDI, motivo: 'ok' }) })
      }
      if (u.pathname === '/api/admin/staff' && init?.method !== 'PATCH') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: [{ ...MEMBRO, ruolo: 'admin' }], schools: SCUOLE_DELL_UTENTE, sections: [], assegnazioni: [] }),
        })
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) })
    })
    apri()

    await screen.findByText(/Kidville Beta|—/)
    expect(screen.queryByTestId('staff-sposta-sede')).toBeNull()
    expect(screen.queryByRole('button', { name: /^modifica$/i })).toBeNull()
  })

  it('⚠️ guasto di lettura delle sedi: si dice, e NON si mostra una tendina vuota', async () => {
    destinazioni = { stato: 500, corpo: { error: 'boom', codice: 'LETTURA_FALLITA' } }
    apri()

    fireEvent.click(await screen.findByRole('button', { name: /modifica/i }))
    const guasto = await screen.findByTestId('staff-sede-guasto')
    expect(guasto.textContent?.trim().length ?? 0).toBeGreaterThan(10)
    expect(tendinaSede()).toBeNull()
  })
})

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  T6-C/bis · UN COMANDO CHE NON PUÒ FARE NIENTE NON SI OFFRE             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Misurato con una segreteria a UNA SOLA SEDE — cioè il caso ordinario, non un
 * limite: il 2026-09-03 nessuna segreteria risultava associata a più di una
 * sede. Il comando «Sposta di sede» compariva lo stesso, apriva una modalità la
 * cui unica sostanza era la spiegazione «da qui non c'è nessun'altra sede», e
 * accanto alla spiegazione teneva un pulsante **Salva** che mandava
 * `{ id, scuola_id: <la sede in cui la persona già sta> }` — un PATCH a vuoto
 * che il server accetta come no-op. Un vicolo cieco con dentro un Salva.
 *
 * Il pannello del BAMBINO risolve lo stesso caso nel modo giusto — spiega e non
 * mostra il comando — e questo è il file che lo pretende anche qui. La
 * spiegazione NON sparisce: prende il posto del comando, che è la differenza fra
 * togliere un vicolo cieco e togliere una risposta.
 *
 * ⚠️ Il gemello di questo test è «SEGRETERIA: il comando c'è» qui sopra: con tre
 * sedi il comando deve esserci. Senza quel controllo positivo, nascondere il
 * comando SEMPRE renderebbe verde anche questo file.
 */
describe('StaffDetailPanel — niente comando dove non c\'è dove spostare', () => {
  /** L'unica sede leggibile è quella in cui la persona già sta: il caso ordinario. */
  const unaSolaSede = () => {
    destinazioni = { stato: 200, corpo: { success: true, data: [{ id: SEDE_B, nome: NOME_SEDE_B }], motivo: 'ok' } }
  }

  it('SEGRETERIA con una sola sede: nessun comando, e la ragione RESTA scritta', async () => {
    ruoloCorrente = 'segreteria'
    unaSolaSede()
    apri()

    const spiegazione = await screen.findByTestId('staff-sposta-sede-spiegazione')
    expect(spiegazione.textContent?.trim().length ?? 0).toBeGreaterThan(20)
    // Il vicolo cieco: il comando che apre una modalità senza sostanza…
    expect(screen.queryByTestId('staff-sposta-sede')).toBeNull()
    // …e il Salva che ci stava dentro, che mandava un PATCH a vuoto.
    expect(screen.queryByTestId('staff-sede-salva')).toBeNull()
    expect(tendinaSede()).toBeNull()
  })

  it('DIREZIONE con una sola sede: «Modifica» RESTA — apre anche ruolo e classi, non solo la sede', async () => {
    // Controprova: il comando che si nasconde è quello della Segreteria, la cui
    // unica sostanza è la sede. «Modifica» ha altro da fare e non si tocca.
    unaSolaSede()
    apri()

    fireEvent.click(await screen.findByRole('button', { name: /modifica/i }))
    await waitFor(() => expect(document.querySelector('select[name="incarico_ruolo"]')).not.toBeNull())
    expect(screen.queryByTestId('staff-sposta-sede-spiegazione')).toBeNull()
  })

  it('SEGRETERIA: «Salva» resta spento finché la sede non cambia davvero', async () => {
    // Il secondo presidio, per la finestra in cui l'elenco non è ancora arrivato
    // (o non si è potuto leggere) e il comando si offre comunque: in modalità
    // «solo sede» il salvataggio ha un mestiere solo, e senza cambio non ne ha
    // nessuno. Un PATCH a vuoto non è un salvataggio, è un log in più.
    ruoloCorrente = 'segreteria'
    apri()

    fireEvent.click(await screen.findByTestId('staff-sposta-sede'))
    await waitFor(() => expect(tendinaSede()).not.toBeNull())
    expect((screen.getByTestId('staff-sede-salva') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(tendinaSede() as HTMLSelectElement, { target: { value: SEDE_C } })
    expect((screen.getByTestId('staff-sede-salva') as HTMLButtonElement).disabled).toBe(false)
  })
})
