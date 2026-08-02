import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import msg from '../../messages/it/adminComunicazioni.json'

// =============================================================================
// S23 — L'editor News non ha più una spunta libera (privacy F4).
//
// Il difetto: `const [consensoFoto, setConsensoFoto] = useState(false)`. Al primo
// caricamento di una foto compariva una modale «confermo di avere il consenso»;
// la spunta restava dentro il browser e non usciva mai. Non arrivava al server,
// non veniva archiviata, non consultava nessun dato — quindi non c'era prova di
// chi avesse dichiarato cosa (art. 5 §2 e art. 7 §1 GDPR), e i consensi «sito»
// raccolti da 141 famiglie continuavano a non essere letti da nessuno.
//
// Qui si verifica quello che il test dell'API non può vedere: che la
// dichiarazione venga chiesta PRIMA del caricamento — il bucket `news` è
// pubblico, quindi il file è raggiungibile da chiunque dall'istante dell'upload,
// prima ancora che il post esista — e che sia LEI a viaggiare nel body.
// =============================================================================

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))
// L'editor rich-text porta con sé TipTap: qui non serve, e il suo bundle
// rallenterebbe il test senza aggiungere una sola asserzione.
vi.mock('@/components/features/admin/news/NewsRichTextEditor', () => ({
  NewsRichTextEditor: () => null,
}))

import { NewsEditorPanel } from '@/components/features/admin/news/NewsEditorPanel'

const SEDE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ALUNNO = '11111111-1111-4111-8111-111111111111'

/** Le fetch dell'editor: categorie, sezioni, alunni della sezione, salvataggio. */
let ultimoBody: Record<string, unknown> | null = null

beforeEach(() => {
  ultimoBody = null
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/api/news/categorie')) return new Response(JSON.stringify({ disponibile: true, categorie: [] }), { status: 200 })
    if (u.includes('/api/admin/sections/scoped')) {
      return new Response(JSON.stringify({ success: true, data: [{ sezioni: [{ name: 'TEST Infanzia' }] }] }), { status: 200 })
    }
    if (u.includes('/api/diary/students')) {
      return new Response(JSON.stringify([{ id: ALUNNO, nome: 'Anna', cognome: 'B.' }]), { status: 200 })
    }
    if (u.includes('/api/news')) {
      ultimoBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return new Response(JSON.stringify({ disponibile: true, post: { id: 'p1' } }), { status: 201 })
    }
    return new Response('{}', { status: 200 })
  }))
})

const monta = () =>
  render(<NewsEditorPanel userId="admin-1" scuolaId={SEDE} modalita="admin" />)

describe('NewsEditorPanel — la dichiarazione dei bambini ritratti', () => {
  it('la foto non si carica finché la dichiarazione non è resa', () => {
    monta()
    const carica = screen.getByRole('button', { name: msg.editorCaricaCopertina })
    // Controllo positivo di lettura: il bottone esiste davvero (se il testo
    // cambiasse, la prova negativa qui sotto passerebbe per assenza).
    expect(carica).toBeTruthy()
    expect(carica).toBeDisabled()
    expect(screen.getByText(msg.editorRitrattiObbligatoria)).toBeTruthy()
  })

  it('dichiarato «nessun bambino ritratto» → il caricamento si apre', () => {
    monta()
    fireEvent.click(screen.getByLabelText(msg.editorRitrattiNessuno))
    expect(screen.getByRole('button', { name: msg.editorCaricaCopertina })).not.toBeDisabled()
  })

  it('scegliere «sono ritratti questi bambini» senza sceglierne nessuno NON basta', () => {
    monta()
    fireEvent.click(screen.getByLabelText(msg.editorRitrattiElenco))
    // La dichiarazione è resa solo quando l'elenco è pieno: un elenco vuoto
    // sarebbe «non lo so», e «non lo so» non è una dichiarazione.
    expect(screen.getByRole('button', { name: msg.editorCaricaCopertina })).toBeDisabled()
  })

  it('i bambini scelti viaggiano nel body della POST', async () => {
    monta()
    fireEvent.click(screen.getByLabelText(msg.editorRitrattiElenco))
    fireEvent.change(await screen.findByLabelText(msg.editorRitrattiSezione), { target: { value: 'TEST Infanzia' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Anna B.' }))

    fireEvent.change(screen.getByLabelText(msg.editorTitolo), { target: { value: 'Festa' } })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(msg.editorSalvaBozza) }))

    await waitFor(() => expect(ultimoBody).not.toBeNull())
    expect(ultimoBody?.bambini_ritratti).toEqual([ALUNNO])
  })

  it('senza dichiarazione il campo NON viaggia: è l’assenza che fa rifiutare il server', async () => {
    monta()
    fireEvent.change(screen.getByLabelText(msg.editorTitolo), { target: { value: 'Solo testo' } })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(msg.editorSalvaBozza) }))
    await waitFor(() => expect(ultimoBody).not.toBeNull())
    // Controllo positivo: la POST è partita davvero (il titolo c'è)…
    expect(ultimoBody?.titolo).toBe('Solo testo')
    // …e la dichiarazione NON è stata inventata al posto dell'operatore.
    expect(ultimoBody).not.toHaveProperty('bambini_ritratti')
  })
})
