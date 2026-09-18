import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { caricaMediaGalleria, messaggioCaricamento } from '@/lib/gallery/carica-media'
import itShared from '../../messages/it/shared.json'

/**
 * IL 409 CHE CHIUDE IL PERCORSO VECCHIO, VISTO DA CHI CARICA.
 *
 * ─── PERCHÉ NON BASTA CHE LA PORTA RISPONDA 409 ─────────────────────────────
 * Un rifiuto che il client non sa leggere è un rifiuto muto. Fino a oggi
 * `caricaMediaGalleria` aveva tre rami sul fallimento della firma — 415, 400 e
 * «tutto il resto» — e il 409 finiva nel terzo: `motivo: 'firma'`, cioè la frase
 * «Non è stato possibile preparare il caricamento. Riprova fra qualche minuto.»
 *
 * Quella frase, davanti a un blocco che NON passa riprovando, è il difetto del
 * 2026-09-08 rifatto identico: allora il 400 cadeva nello stesso ramo generico, 8
 * insegnanti hanno riprovato 33 volte e due sono finite nel rate limit. Il
 * messaggio non era solo inutile — produceva il guasto successivo.
 *
 * ⚠️ E QUI IL COSTO SAREBBE PIÙ ALTO, perché il rimedio è nelle mani di chi
 * carica: aggiornare l'app. Una frase che dice «riprova fra qualche minuto» lo
 * nasconde, e chi legge riprova finché non si arrende.
 *
 * ─── LA CODA OFFLINE ────────────────────────────────────────────────────────
 * `syncPendingGalleryMedia` passa da questa stessa funzione. Un esito `ok:false`
 * lascia la riga in Dexie con `sync_status: 'error'`, e la sincronizzazione
 * ripesca `pending` **e** `error`: il filmato NON si perde, e riparte da solo il
 * giorno in cui l'app aggiornata lo adotta. È ciò che la frase del catalogo
 * promette («i filmati già in attesa ripartono da soli»), ed è il motivo per cui
 * il 409 non deve mai diventare un abbandono.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn() }))
vi.mock('@/lib/logging/client', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/client')>()),
  logClient: h.logClient,
}))

/** La frase del catalogo condiviso: l'unica copia, e quella che si legge a schermo. */
const FRASE_AGGIORNA = (itShared as Record<string, string>).erroreVideoAppDaAggiornare

/** Un file della dimensione voluta senza allocarla: in jsdom `size` è scrivibile. */
function fileDa(byte: number, tipo: string, nome = 'recita-di-mario-rossi.mp4'): File {
  const f = new File(['x'], nome, { type: tipo })
  Object.defineProperty(f, 'size', { value: byte })
  return f
}

/** Il corpo esatto che la porta manda: prosa dal catalogo + codice. */
const CORPO_409 = { error: FRASE_AGGIORNA, codice: 'VIDEO_APP_DA_AGGIORNARE' }

function fetchFinta(stato: number, corpo: unknown) {
  const chiamate: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      chiamate.push(String(url))
      if (String(url).includes('/api/gallery/upload-url')) {
        return { ok: stato >= 200 && stato < 300, status: stato, json: async () => corpo } as Response
      }
      return { ok: true, status: 200 } as Response
    }),
  )
  return chiamate
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('caricaMediaGalleria · il 409 del percorso vecchio ha un ramo suo', () => {
  it('409 + codice ⇒ «app-da-aggiornare», e il file NON parte', async () => {
    const chiamate = fetchFinta(409, CORPO_409)
    const esito = await caricaMediaGalleria(fileDa(9_000_000, 'video/mp4'), 'video/mp4')
    expect(esito).toEqual({ ok: false, motivo: 'app-da-aggiornare', stato: 409 })
    // Nessuna `PUT`: la firma non è stata emessa, non c'è niente da spedire.
    expect(chiamate.filter((u) => !u.includes('/api/gallery/upload-url'))).toEqual([])
  })

  it('il log lo distingue da «firma non emessa»: messaggio suo, e `warn` non `error`', async () => {
    fetchFinta(409, CORPO_409)
    await caricaMediaGalleria(fileDa(9_000_000, 'video/mp4'), 'video/mp4')
    // La chiave di dedup di `logClient` è `evento|messaggio|stato`: senza un
    // messaggio proprio, questo rifiuto si confonderebbe in tabella con il guasto
    // vero della firma — e il giorno dell'accensione bisogna poter contare quanti
    // telefoni parlano ancora la lingua vecchia.
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ messaggio: 'gallery-app-da-aggiornare', stato: 409, livello: 'warn' }),
    )
  })

  it('nessuna riga di log porta il nome del file, nemmeno in questo ramo', async () => {
    fetchFinta(409, CORPO_409)
    await caricaMediaGalleria(fileDa(9_000_000, 'video/mp4', 'recita-di-mario-rossi.mp4'), 'video/mp4')
    const righe = JSON.stringify(h.logClient.mock.calls)
    expect(righe).not.toContain('mario')
    expect(righe).not.toContain('rossi')
  })

  it('un 409 SENZA quel codice resta il ramo generico di prima: niente si è mosso', async () => {
    // Il ramo nuovo si apre sul codice, non sul numero: se un giorno quella porta
    // rispondesse 409 per un'altra ragione, dire «aggiorna l'app» sarebbe una
    // bugia azionabile, che è peggio di un messaggio generico.
    fetchFinta(409, { error: 'conflitto qualunque' })
    const esito = await caricaMediaGalleria(fileDa(9_000_000, 'video/mp4'), 'video/mp4')
    expect(esito).toEqual({ ok: false, motivo: 'firma', stato: 409 })
  })

  it('gli altri stati non cambiano di una virgola', async () => {
    for (const [stato, atteso] of [
      [415, 'formato'],
      [400, 'formato-non-ammesso'],
      [429, 'firma'],
    ] as const) {
      fetchFinta(stato, { error: 'x' })
      const esito = await caricaMediaGalleria(fileDa(9_000_000, 'video/mp4'), 'video/mp4')
      expect(esito, `stato ${stato}`).toEqual({ ok: false, motivo: atteso, stato })
    }
  })
})

describe('messaggioCaricamento · quel che una persona legge davvero', () => {
  it('dice di aggiornare l\'app, e non «riprova fra qualche minuto»', () => {
    // `t` finta che restituisce la chiave: se la frase venisse da `teacherServizi`
    // qui si leggerebbe `galleryErrFirma`. Viene invece dal catalogo condiviso,
    // dove la frase del codice `VIDEO_APP_DA_AGGIORNARE` esiste già in italiano e
    // in inglese — una copia sola, che non può divergere.
    const testo = messaggioCaricamento({ ok: false, motivo: 'app-da-aggiornare', stato: 409 }, (k) => k)
    expect(testo).toBe(FRASE_AGGIORNA)
    expect(testo).not.toBe('galleryErrFirma')
    // Nessun codice a schermo: un identificatore non dice a nessuno cosa fare.
    expect(testo).not.toContain('VIDEO_APP_DA_AGGIORNARE')
    expect(testo).not.toContain('CLIENT_UPDATE_REQUIRED')
  })

  it('le altre frasi restano quelle di prima', () => {
    expect(messaggioCaricamento({ ok: false, motivo: 'firma', stato: 429 }, (k) => k)).toBe('galleryErrFirma')
    expect(messaggioCaricamento({ ok: false, motivo: 'formato', stato: 415 }, (k) => k))
      .toBe('galleryAlertVideoNonConvertibile')
  })
})
