import { describe, it, expect, beforeEach, vi } from 'vitest'

// =============================================================================
// `creaMuta()` — L'UNICO POSTO IN CUI SI DECIDE COSA SUCCEDE QUANDO UNA
// SCRITTURA VIENE RIFIUTATA.
//
// La funzione non è nuova: viveva dentro `GiudiziManager.tsx`, scritta lì il
// giorno in cui il difetto è stato visto lì. Gli altri manager di
// `admin/primaria` continuavano a fare `await fetch(...)` e basta — niente
// `res.ok`, niente `catch`, niente stato d'errore, niente log. Qui si misurano i
// quattro esiti che una mutazione può avere — riuscita, rifiuto 4xx, guasto 5xx,
// rete giù — perché sono quattro comportamenti DIVERSI e nessuno dei quattro è
// «non succede niente».
//
// I DUE CONFINI CHE NON SI SPOSTANO, e che qui hanno un test ciascuno:
//
//  · IL CORPO DELLA RISPOSTA NON SI LOGGA. Nel log finiscono lo `stato` (un
//    numero: passa la lista bianca di `redact`) e l'etichetta dell'evento. Il
//    corpo può contenere il nome di una classe o di un bambino.
//  · IL `contesto` NON SI LOGGA. È il nome della riga su cui rifare il gesto —
//    un docente, una materia — e serve all'operatore, non a `app_log`.
//
// ⚠️ `logClient` FILTRA PRIMA DI SPEDIRE: 401/403/404 non lasciano il
// dispositivo (`livelloFetch` in `src/lib/logging/client.ts`). Qui si verifica
// che `creaMuta` lo CHIAMI; che cosa poi ne faccia è una decisione di quel
// modulo e non va duplicata qui. Il presidio che conta per il 403 — cioè per il
// rifiuto più probabile, quello di sede — non è il log: è l'avviso a schermo, ed
// è per questo che l'avviso ha più asserzioni del log.
// =============================================================================

const h = vi.hoisted(() => ({ logClient: vi.fn(), nomeErrore: vi.fn(() => 'TypeError') }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: h.nomeErrore }))

import { creaMuta } from '@/lib/ui/muta'

const RIPIEGO = 'Salvataggio non riuscito. Riprova.'
const ROTTA = '/admin/impostazioni'

const risposta = (stato: number, corpo: unknown) => ({
  ok: stato >= 200 && stato < 300,
  status: stato,
  json: async () => corpo,
}) as unknown as Response

const fetchMock = vi.fn()

/** Una `muta` fresca e le due spie che ha dentro, per ogni test. */
function banco() {
  const ricarica = vi.fn()
  const setErrore = vi.fn()
  return { ricarica, setErrore, muta: creaMuta({ route: ROTTA, ricarica, setErrore, fallback: RIPIEGO }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
})

describe('creaMuta · successo', () => {
  it('ritorna true, pulisce l’avviso e ricarica, senza loggare niente', async () => {
    fetchMock.mockResolvedValue(risposta(200, { success: true }))
    const b = banco()

    await expect(b.muta('/api/x', { method: 'POST' }, 'x-respinta')).resolves.toBe(true)

    expect(b.setErrore).toHaveBeenCalledWith('')
    expect(b.ricarica).toHaveBeenCalledTimes(1)
    expect(h.logClient).not.toHaveBeenCalled()
  })
})

describe('creaMuta · rifiuto 4xx', () => {
  it('mostra la prosa del server, logga lo STATO e ricarica', async () => {
    fetchMock.mockResolvedValue(risposta(403, { error: 'Non hai accesso a questa sede.' }))
    const b = banco()

    await expect(b.muta('/api/x', { method: 'DELETE' }, 'x-elimina-respinta')).resolves.toBe(false)

    expect(b.setErrore).toHaveBeenCalledWith('Non hai accesso a questa sede.')
    // Si ricarica ANCHE sul rifiuto: è ciò che toglie dallo schermo un dato che
    // il database non ha — il caso degli stati ottimistici.
    expect(b.ricarica).toHaveBeenCalledTimes(1)
    expect(h.logClient).toHaveBeenCalledWith({
      livello: 'error',
      evento: 'fetch',
      messaggio: 'x-elimina-respinta',
      route: ROTTA,
      stato: 403,
    })
  })

  it('il falso è la ragione per cui ritorna un booleano: solo su true si azzera il campo', async () => {
    // `GiudiziManager` cancella il testo appena scritto SOLO se il server ha
    // accettato. Cancellarlo su un rifiuto obbligherebbe a riscriverlo per
    // riprovare — ed è il momento in cui l'operatore rinuncia.
    fetchMock.mockResolvedValue(risposta(409, { error: 'Etichetta già in uso' }))
    const b = banco()

    await expect(b.muta('/api/x', { method: 'POST' }, 'x-respinta')).resolves.toBe(false)
  })

  it('senza corpo leggibile resta il ripiego, mai la stringa vuota', async () => {
    // A schermo il vuoto è indistinguibile dal silenzio che questa funzione
    // esiste per togliere.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => { throw new Error('corpo non JSON') },
    } as unknown as Response)
    const b = banco()

    await b.muta('/api/x', { method: 'POST' }, 'x-respinta')

    expect(b.setErrore).toHaveBeenCalledWith(RIPIEGO)
  })

  it('col `contesto` l’avviso dice A QUALE RIGA rifare il gesto — e il log non lo vede', async () => {
    fetchMock.mockResolvedValue(risposta(403, { error: 'Non hai accesso a questa sede.' }))
    const b = banco()

    await b.muta('/api/x', { method: 'PATCH' }, 'x-respinta', 'Matematica')

    expect(b.setErrore).toHaveBeenCalledWith('Matematica: Non hai accesso a questa sede.')
    expect(JSON.stringify(h.logClient.mock.calls)).not.toContain('Matematica')
  })
})

describe('creaMuta · guasto 5xx', () => {
  it('logga lo stato 500 e avvisa a schermo', async () => {
    fetchMock.mockResolvedValue(risposta(500, { error: 'Errore interno' }))
    const b = banco()

    await expect(b.muta('/api/x', { method: 'POST' }, 'x-respinta')).resolves.toBe(false)

    expect(b.setErrore).toHaveBeenCalledWith('Errore interno')
    expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ stato: 500, livello: 'error' }))
  })
})

describe('creaMuta · rete giù', () => {
  it('non lancia: ritorna false, avvisa col ripiego e NON ricarica', async () => {
    // La fetch che non è mai partita non ha uno `stato` da raccontare, e non c'è
    // niente di nuovo da leggere: il server non ha visto nulla. È l'unico dei
    // quattro esiti in cui `ricarica` non viene chiamata.
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch https://esempio/alunno/<id>'))
    const b = banco()

    await expect(b.muta('/api/x', { method: 'POST' }, 'x-respinta', 'Matematica')).resolves.toBe(false)

    expect(b.setErrore).toHaveBeenCalledWith('Matematica: Salvataggio non riuscito. Riprova.')
    expect(b.ricarica).not.toHaveBeenCalled()
    expect(h.logClient).toHaveBeenCalledWith({
      livello: 'error',
      evento: 'fetch',
      messaggio: 'x-respinta: TypeError',
      route: ROTTA,
    })
    // Il `message` di una fetch fallita si porta dietro l'URL, e in un URL di
    // questo prodotto c'è l'id di un minore: nel log va il NOME della classe
    // d'errore, non il suo messaggio.
    expect(JSON.stringify(h.logClient.mock.calls)).not.toContain('Failed to fetch')
  })
})
