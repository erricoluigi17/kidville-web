import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import msgIt from '../../messages/it/adminComunicazioni.json'
import sharedIt from '../../messages/it/shared.json'
import sharedEn from '../../messages/en/shared.json'

// =============================================================================
// L'EDITOR NEWS MOSTRAVA LA PROSA ITALIANA DEL SERVER, SCAVALCANDO IL CATALOGO.
//
// IL DIFETTO (2026-08-03). `NewsEditorPanel` scriveva `setErrore(j?.error ?? …)`:
// prendeva l'`error` del corpo e lo metteva a schermo così com'era. Quella prosa
// NASCE sul server, dove il locale e il catalogo non esistono — è esattamente il
// fallimento F1 del collaudo del 2026-07-31 («Sede non accessibile» dentro
// un'interfaccia inglese), riaperto in un componente nuovo mentre la primitiva
// che lo chiude (`messaggioDaCorpo`) era già lì da due giorni.
//
// E C'ERA UNA SECONDA METÀ, peggiore della prima. Il 503 della PATCH mandava
// `codice: 'NEWS_FILE_NON_RIMOSSI'`, cioè il codice della CANCELLAZIONE, il cui
// testo di catalogo dice «la news non è stata eliminata». `messaggioDaCorpo`,
// appena riconosce un codice, mostra il catalogo e scarta la prosa: chi aveva
// appena cambiato una copertina avrebbe letto il resoconto di una cancellazione
// che nessuno aveva chiesto. Un codice RIUSATO passa il lock `errori-con-codice`
// esattamente come uno giusto — è dichiarato e tradotto in due lingue.
//
// QUI SI MISURA CIÒ CHE L'UTENTE LEGGE, non quale funzione viene chiamata: un
// lock sul nome di `messaggioDaCorpo` sarebbe verde anche chiamandola e buttando
// via il risultato, che in questo repo è già successo (`void gate`).
// =============================================================================

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))
vi.mock('@/components/features/admin/news/NewsRichTextEditor', () => ({
  NewsRichTextEditor: () => null,
}))

import { NewsEditorPanel } from '@/components/features/admin/news/NewsEditorPanel'

const SEDE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

/** La prosa che la PATCH manda accanto al codice: nasce italiana, sul server. */
const PROSA_SERVER =
  'Non è stato possibile togliere dall’archivio pubblico le immagini sostituite: la modifica non è stata salvata. Riprova fra qualche istante.'

/** Il corpo che il salvataggio deve ricevere: 503 con prosa + codice. */
let rispostaSalvataggio: { stato: number; corpo: unknown } = { stato: 201, corpo: {} }

/** Il `lang` della radice: è ciò che `RootLayout` scrive da `getLocale()`. */
const conLingua = (lang: string) => document.documentElement.setAttribute('lang', lang)

beforeEach(() => {
  rispostaSalvataggio = { stato: 201, corpo: { disponibile: true, post: { id: 'p1' } } }
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/news/categorie')) {
      return new Response(JSON.stringify({ disponibile: true, categorie: [] }), { status: 200 })
    }
    if (u.includes('/api/admin/sections/scoped')) {
      return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 })
    }
    if (u.includes('/api/news')) {
      return new Response(JSON.stringify(rispostaSalvataggio.corpo), { status: rispostaSalvataggio.stato })
    }
    return new Response('{}', { status: 200 })
  }))
})

afterEach(() => conLingua('it'))

/** Monta l'editor, scrive un titolo e prova a salvare la bozza. */
async function salvaBozza() {
  render(<NewsEditorPanel userId="admin-1" scuolaId={SEDE} modalita="admin" />)
  fireEvent.change(screen.getByLabelText(msgIt.editorTitolo), { target: { value: 'Festa' } })
  fireEvent.click(screen.getByRole('button', { name: new RegExp(msgIt.editorSalvaBozza) }))
  return waitFor(() => screen.getByRole('alert'))
}

describe('NewsEditorPanel — il rifiuto del server si legge nella lingua di chi lo legge', () => {
  it('interfaccia INGLESE: il 503 diventa il testo del catalogo EN, non la prosa italiana', async () => {
    conLingua('en')
    rispostaSalvataggio = {
      stato: 503,
      corpo: { error: PROSA_SERVER, codice: 'NEWS_FILE_SOSTITUITI_NON_RIMOSSI' },
    }

    const avviso = await salvaBozza()
    expect(avviso.textContent).toBe(sharedEn.erroreNewsFileSostituitiNonRimossi)
    // L'asserzione che conta davvero: non è più l'italiano del server.
    expect(avviso.textContent).not.toBe(PROSA_SERVER)
    expect(avviso.textContent).not.toMatch(/archivio pubblico/i)
  })

  it('interfaccia ITALIANA: lo stesso codice dà il testo del catalogo IT', async () => {
    conLingua('it')
    rispostaSalvataggio = {
      stato: 503,
      corpo: { error: PROSA_SERVER, codice: 'NEWS_FILE_SOSTITUITI_NON_RIMOSSI' },
    }

    const avviso = await salvaBozza()
    expect(avviso.textContent).toBe(sharedIt.erroreNewsFileSostituitiNonRimossi)
  })

  it('la modifica rifiutata NON viene raccontata come una cancellazione', async () => {
    // La trappola vera: col codice della DELETE il testo mostrato sarebbe stato
    // «la news non è stata eliminata» — corretto per la cancellazione, falso qui,
    // e nessun lock lo avrebbe visto, perché quel codice è dichiarato e tradotto.
    conLingua('en')
    rispostaSalvataggio = {
      stato: 503,
      corpo: { error: PROSA_SERVER, codice: 'NEWS_FILE_SOSTITUITI_NON_RIMOSSI' },
    }

    const avviso = await salvaBozza()
    expect(
      avviso.textContent,
      'a chi ha modificato un articolo si sta dicendo che una cancellazione non è riuscita',
    ).not.toMatch(/delet/i)
    // Controllo POSITIVO: la frase parla davvero delle modifiche non salvate.
    expect(avviso.textContent).toMatch(/changes/i)
  })

  it('SENZA codice resta la prosa del server (il ripiego non si è perso)', async () => {
    // Le risposte di `news` ancora senza codice sono decine: togliendo il ripiego
    // l'utente leggerebbe una frase generica al posto del motivo vero, che è un
    // modo di peggiorare mentre si crede di tradurre.
    conLingua('it')
    rispostaSalvataggio = { stato: 400, corpo: { error: 'URL Instagram non valido' } }

    const avviso = await salvaBozza()
    expect(avviso.textContent).toBe('URL Instagram non valido')
  })

  it('corpo VUOTO: la frase locale del componente, mai la stringa vuota', async () => {
    conLingua('it')
    rispostaSalvataggio = { stato: 500, corpo: {} }

    const avviso = await salvaBozza()
    expect(avviso.textContent).toBe(msgIt.editorSalvataggioFallito)
  })
})
