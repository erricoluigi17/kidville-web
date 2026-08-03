import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import msgIt from '../../messages/it/adminComunicazioni.json'
import sharedIt from '../../messages/it/shared.json'
import sharedEn from '../../messages/en/shared.json'

// =============================================================================
// IL 503 DELLA CANCELLAZIONE ARRIVAVA A SCHERMO COME SILENZIO ASSOLUTO.
//
// IL DIFETTO (2026-08-03). `NewsElencoPanel` scriveva `if (res.ok) void carica()`
// senza `else`, sia sulla DELETE sia sulla rotta `pubblica` (pin / ritira /
// ripubblica). Un rifiuto si comportava come un successo: nessun avviso, nessun
// ricaricamento, la riga ancora lì.
//
// PERCHÉ È PEGGIO DI UN MESSAGGIO MANCANTE. Il rifiuto che passa di qui è il 503
// `NEWS_FILE_NON_RIMOSSI`: la news NON è stata eliminata, perché le sue immagini
// non sono uscite dal bucket pubblico. La route si ferma apposta — cancellare la
// riga lasciando il file significherebbe la foto di un minore a un indirizzo
// pubblico senza più nessuna riga da cui ritrovarla. Ma chi ha premuto «Elimina»
// vedeva la stessa identica schermata di un'eliminazione riuscita, e se ne andava
// convinto che quella foto fosse sparita. La difesa più forte della catena
// diventava, sullo schermo, la sua bugia più grande.
//
// SI MISURA CIÒ CHE L'UTENTE LEGGE, non quale funzione viene chiamata: un lock
// sul nome di `messaggioDaCorpo` sarebbe verde anche chiamandola e buttando via
// il risultato, che in questo repo è già successo (`void gate`).
// =============================================================================

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))

import { NewsElencoPanel } from '@/components/features/admin/news/NewsElencoPanel'

const SEDE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const POST_ID = '33333333-3333-4333-8333-333333333333'

/** La prosa che la DELETE manda accanto al codice: nasce italiana, sul server. */
const PROSA_SERVER =
  'Non è stato possibile togliere le immagini del post dall’archivio pubblico: la news non è stata eliminata. Riprova fra qualche istante.'

const POST_PUBBLICATO = {
  id: POST_ID,
  tipo: 'articolo',
  stato: 'pubblicata',
  titolo: 'Festa di fine anno',
  pubblicata_il: '2026-08-01T10:00:00.000Z',
  created_at: '2026-08-01T09:00:00.000Z',
  pinned: false,
}

/** L'esito che le due mutazioni devono ricevere. */
let rispostaMutazione: { stato: number; corpo: unknown } = { stato: 200, corpo: {} }

/** Il `lang` della radice: è ciò che `RootLayout` scrive da `getLocale()`. */
const conLingua = (lang: string) => document.documentElement.setAttribute('lang', lang)

beforeEach(() => {
  rispostaMutazione = { stato: 200, corpo: { disponibile: true } }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url)
      const metodo = init?.method ?? 'GET'
      if (u.includes('/api/news?') || (u.includes('/api/news?') && metodo === 'GET')) {
        return new Response(JSON.stringify({ disponibile: true, posts: [POST_PUBBLICATO] }), { status: 200 })
      }
      if (metodo === 'DELETE' || u.includes('/pubblica')) {
        return new Response(JSON.stringify(rispostaMutazione.corpo), { status: rispostaMutazione.stato })
      }
      return new Response(JSON.stringify({ disponibile: true, posts: [POST_PUBBLICATO] }), { status: 200 })
    }),
  )
  vi.stubGlobal('confirm', () => true)
})

afterEach(() => conLingua('it'))

/** Monta l'elenco e attende che la riga del post sia comparsa. */
async function montaElenco() {
  render(<NewsElencoPanel userId="admin-1" scuolaId={SEDE} onModifica={() => {}} />)
  await waitFor(() => screen.getByText(POST_PUBBLICATO.titolo))
}

describe('NewsElencoPanel — un rifiuto del server non arriva come silenzio', () => {
  it('DELETE rifiutata con 503 → l’avviso lo dice, nella lingua di chi guarda', async () => {
    conLingua('it')
    rispostaMutazione = { stato: 503, corpo: { error: PROSA_SERVER, codice: 'NEWS_FILE_NON_RIMOSSI' } }

    await montaElenco()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(msgIt.elencoElimina) }))

    const avviso = await waitFor(() => screen.getByRole('alert'))
    expect(
      avviso.textContent,
      'la news non è stata eliminata perché le immagini sono ancora nel bucket pubblico, e a ' +
        'schermo non c’è niente che lo dica: l’operatore se ne va convinto che la foto sia sparita',
    ).toBe(sharedIt.erroreNewsFileNonRimossi)
  })

  it('interfaccia INGLESE: lo stesso 503 dà il testo del catalogo EN, non la prosa italiana', async () => {
    conLingua('en')
    rispostaMutazione = { stato: 503, corpo: { error: PROSA_SERVER, codice: 'NEWS_FILE_NON_RIMOSSI' } }

    await montaElenco()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(msgIt.elencoElimina) }))

    const avviso = await waitFor(() => screen.getByRole('alert'))
    expect(avviso.textContent).toBe(sharedEn.erroreNewsFileNonRimossi)
    // L'asserzione che conta davvero: non è più l'italiano del server.
    expect(avviso.textContent).not.toBe(PROSA_SERVER)
    expect(avviso.textContent).not.toMatch(/archivio pubblico/i)
  })

  it('anche RITIRA/PIN rifiutata si vede: è la seconda mutazione, e taceva uguale', async () => {
    conLingua('it')
    rispostaMutazione = { stato: 403, corpo: { error: 'Puoi gestire solo le tue news' } }

    await montaElenco()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(msgIt.elencoRitira) }))

    const avviso = await waitFor(() => screen.getByRole('alert'))
    // Senza codice resta la prosa del server: il ripiego non si è perso.
    expect(avviso.textContent).toBe('Puoi gestire solo le tue news')
  })

  it('corpo VUOTO: la frase locale del pannello, mai la stringa vuota', async () => {
    conLingua('it')
    rispostaMutazione = { stato: 500, corpo: {} }

    await montaElenco()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(msgIt.elencoElimina) }))

    const avviso = await waitFor(() => screen.getByRole('alert'))
    expect(avviso.textContent).toBe(msgIt.elencoEliminazioneFallita)
  })

  it('CONTROLLO POSITIVO — operazione riuscita: nessun avviso', async () => {
    // Senza questo, «l’avviso compare quando serve» sarebbe verde anche in un
    // pannello che urla a ogni clic — cioè in uno di cui si impara a non leggere
    // più i messaggi, che è il modo più efficace di riaprire il difetto.
    conLingua('it')
    rispostaMutazione = { stato: 200, corpo: { disponibile: true } }

    await montaElenco()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(msgIt.elencoElimina) }))

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })
})
