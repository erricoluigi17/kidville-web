import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DBFinto } from '../../fixtures/finto-supabase'
import { creaFintoSupabase } from '../../fixtures/finto-supabase'

/**
 * IL BAMBINO GEMELLO: lo stesso bambino, con un codice fiscale diverso.
 *
 * ─── IL GUASTO, MISURATO IL 2026-09-14 ──────────────────────────────────────
 * Nella stessa sede c'erano sette coppie di alunni doppi. In tutte e sette: stesso
 * nome, cognome e data di nascita, codici fiscali diversi per UN carattere, e uno
 * dei due col carattere di controllo sbagliato. L'import riconosceva un bambino
 * solo per codice fiscale identico: il refuso faceva nascere un secondo alunno —
 * due rette, i solleciti sulla retta fantasma, un bonifico riconciliato sulla
 * copia sbagliata.
 *
 * Questo file prova il modulo che le due strade d'import condividono per
 * riconoscerlo. Usa il finto client che APPLICA davvero i filtri: con un mock
 * piatto «stessa sede» e «altra sede» risponderebbero la stessa lista, e il test
 * sulla sede sarebbe verde anche senza il filtro.
 *
 * ⚠️ DATI DI PROVA. Il repository è pubblico e il dominio sono minori: i nomi sono
 * quelli convenzionali, e i codici fiscali hanno il catastale `Z999`, che non è
 * assegnato a nessuno stato (la convenzione di `__tests__/lib/fiscale/`).
 */

const log = vi.hoisted(() => ({
  eventi: [] as { evento: string; livello: string; campi: Record<string, unknown>; errore?: unknown }[],
}))
vi.mock('@/lib/logging/logger', async (orig) => {
  const vero = await orig<typeof import('@/lib/logging/logger')>()
  return {
    ...vero,
    logEvento: (evento: string, livello: string, campi: Record<string, unknown>, errore?: unknown) => {
      log.eventi.push({ evento, livello, campi, errore })
    },
  }
})

import {
  cercaGemelloAlunno,
  cercaGemelloGenitore,
  primoGemelloFraIBambini,
  stessoNome,
} from '@/lib/iscrizioni/doppioni'

const SEDE = 'a1a1a1a1-0000-4000-8000-000000000001'
const ALTRA_SEDE = 'b2b2b2b2-0000-4000-8000-000000000002'
const ESISTENTE = 'c3c3c3c3-0000-4000-8000-000000000003'
const ARCHIVIATO = 'c3c3c3c3-0000-4000-8000-000000000004'
const GENITORE = 'd4d4d4d4-0000-4000-8000-000000000005'

/** Codice valido (verificato in `validazione.test.ts`). */
const CF_VALIDO = 'XQQYKV19C07Z999T'
/** Lo stesso codice con il carattere di controllo sbagliato: il refuso misurato. */
const CF_REFUSO = 'XQQYKV19C07Z999A'
const NATO_IL = '2019-03-07'

const OPERAZIONE = { operazione: 'test/doppioni' }

let lette: string[]
const client = (db: DBFinto, errori?: Record<string, { code: string; message?: string }>) => {
  lette = []
  return creaFintoSupabase(db, lette, { errori })
}

const alunno = (over: Record<string, unknown> = {}) => ({
  id: ESISTENTE,
  scuola_id: SEDE,
  nome: 'Mario',
  cognome: 'Rossi',
  data_nascita: NATO_IL,
  codice_fiscale: CF_VALIDO,
  anonimizzato_il: null,
  archiviato_il: null,
  ...over,
})

const cercato = (over: Record<string, unknown> = {}) => ({
  scuolaId: SEDE,
  nome: 'Mario',
  cognome: 'Rossi',
  dataNascita: NATO_IL,
  codiceFiscale: CF_REFUSO,
  ...over,
})

beforeEach(() => {
  log.eventi = []
})

describe('stessoNome — la stessa uguaglianza dell\'abbinamento all\'elenco', () => {
  it('maiuscole, spazi doppi e in coda non contano', () => {
    expect(stessoNome({ nome: '  mario ', cognome: 'ROSSI' }, { nome: 'Mario', cognome: 'Rossi' })).toBe(true)
    expect(stessoNome({ nome: 'Anna  Lucia', cognome: 'Rossi' }, { nome: 'Anna Lucia', cognome: 'rossi' })).toBe(true)
  })

  it('nome e cognome scambiati sono lo stesso nome', () => {
    expect(stessoNome({ nome: 'Rossi', cognome: 'Mario' }, { nome: 'Mario', cognome: 'Rossi' })).toBe(true)
  })

  it('lo stesso nome con gli spazi altrove è lo stesso nome (`De Luca` / `DeLuca`)', () => {
    expect(stessoNome({ nome: 'Mario', cognome: 'De Luca' }, { nome: 'Mario', cognome: 'DeLuca' })).toBe(true)
  })

  it('un nome diverso NON è lo stesso nome: due gemelli veri hanno nomi diversi', () => {
    expect(stessoNome({ nome: 'Mario', cognome: 'Rossi' }, { nome: 'Maria', cognome: 'Rossi' })).toBe(false)
    expect(stessoNome({ nome: 'Mario', cognome: 'Rossi' }, { nome: 'Mario', cognome: 'Rossi Bianchi' })).toBe(false)
  })

  it('un nome vuoto non combacia con niente, nemmeno con un altro vuoto', () => {
    expect(stessoNome({ nome: '', cognome: '' }, { nome: '', cognome: '' })).toBe(false)
    expect(stessoNome({ nome: 'Mario', cognome: null }, { nome: 'Mario', cognome: '' })).toBe(false)
  })
})

describe('cercaGemelloAlunno', () => {
  it('trova il gemello: stessa sede, stessa data, stesso nome scritto in un altro modo, codice diverso', async () => {
    const esito = await cercaGemelloAlunno(
      client({ alunni: [alunno()] }),
      cercato({ nome: '  mario ', cognome: 'ROSSI' }),
      OPERAZIONE,
    )
    expect(esito).toEqual({ esito: 'trovato', schede: [{ id: ESISTENTE, codiceFiscaleValido: true }] })
  })

  it('dice se il codice della scheda esistente supera il carattere di controllo', async () => {
    // È il discriminante che ha deciso le sette coppie: in 5 casi su 7 era la
    // copia ATTIVA ad avere il codice sbagliato — ed è quello che va in fattura.
    const esito = await cercaGemelloAlunno(
      client({ alunni: [alunno({ codice_fiscale: CF_REFUSO })] }),
      cercato({ codiceFiscale: CF_VALIDO }),
      OPERAZIONE,
    )
    expect(esito).toEqual({ esito: 'trovato', schede: [{ id: ESISTENTE, codiceFiscaleValido: false }] })
  })

  it('una scheda senza codice fiscale è un gemello, con validità «non si sa»', async () => {
    const esito = await cercaGemelloAlunno(client({ alunni: [alunno({ codice_fiscale: null })] }), cercato(), OPERAZIONE)
    expect(esito).toEqual({ esito: 'trovato', schede: [{ id: ESISTENTE, codiceFiscaleValido: null }] })
  })

  it('nome e cognome invertiti nella domanda: è lo stesso bambino', async () => {
    const esito = await cercaGemelloAlunno(
      client({ alunni: [alunno()] }),
      cercato({ nome: 'Rossi', cognome: 'Mario' }),
      OPERAZIONE,
    )
    expect(esito.esito).toBe('trovato')
  })

  it('nome diverso → nessuno', async () => {
    const esito = await cercaGemelloAlunno(client({ alunni: [alunno()] }), cercato({ nome: 'Maria' }), OPERAZIONE)
    expect(esito).toEqual({ esito: 'nessuno' })
  })

  it('stesso bambino in un\'ALTRA sede → nessuno: il trasferimento non è un doppione', async () => {
    const esito = await cercaGemelloAlunno(
      client({ alunni: [alunno({ scuola_id: ALTRA_SEDE })] }),
      cercato(),
      OPERAZIONE,
    )
    expect(esito).toEqual({ esito: 'nessuno' })
  })

  it('data di nascita diversa → nessuno', async () => {
    const esito = await cercaGemelloAlunno(client({ alunni: [alunno()] }), cercato({ dataNascita: '2019-03-08' }), OPERAZIONE)
    expect(esito).toEqual({ esito: 'nessuno' })
  })

  it('una scheda ANONIMIZZATA non è un gemello: di quel bambino non resta nessuno', async () => {
    const esito = await cercaGemelloAlunno(
      client({ alunni: [alunno({ anonimizzato_il: '2026-09-02T10:00:00Z' })] }),
      cercato(),
      OPERAZIONE,
    )
    expect(esito).toEqual({ esito: 'nessuno' })
  })

  it('una scheda ARCHIVIATA è un gemello: i doppioni di oggi erano quasi tutti archiviati', async () => {
    const esito = await cercaGemelloAlunno(
      client({
        alunni: [alunno({ id: ARCHIVIATO, stato: 'ritirato', archiviato_il: '2026-09-01T10:00:00Z', section_id: null })],
      }),
      cercato(),
      OPERAZIONE,
    )
    expect(esito).toEqual({ esito: 'trovato', schede: [{ id: ARCHIVIATO, codiceFiscaleValido: true }] })
  })

  it('chi porta ESATTAMENTE lo stesso codice non è un gemello: è la stessa scheda', async () => {
    // `alunni.codice_fiscale` è `character(16)`: il valore torna IMPAGINATO con spazi
    // in coda, e il confronto non deve inciampare in quegli spazi.
    const esito = await cercaGemelloAlunno(
      client({ alunni: [alunno({ codice_fiscale: `${CF_VALIDO}   ` })] }),
      cercato({ codiceFiscale: CF_VALIDO }),
      OPERAZIONE,
    )
    expect(esito).toEqual({ esito: 'nessuno' })
  })

  it('più schede gemelle → tutte, perché sceglierne una sarebbe indovinare', async () => {
    const esito = await cercaGemelloAlunno(
      client({ alunni: [alunno(), alunno({ id: ARCHIVIATO, codice_fiscale: null })] }),
      cercato(),
      OPERAZIONE,
    )
    expect(esito.esito).toBe('trovato')
    if (esito.esito === 'trovato') expect(esito.schede.map((s) => s.id).sort()).toEqual([ESISTENTE, ARCHIVIATO].sort())
  })

  it('senza data di nascita, nome o cognome NON si cerca: nessuna lettura, nessun gemello', async () => {
    for (const mancante of [{ dataNascita: '' }, { dataNascita: null }, { cognome: '  ' }, { nome: undefined }]) {
      const esito = await cercaGemelloAlunno(client({ alunni: [alunno()] }), cercato(mancante), OPERAZIONE)
      expect(esito).toEqual({ esito: 'nessuno' })
      expect(lette).toEqual([])
    }
  })

  it('una data scritta come istante vale per il suo giorno', async () => {
    const esito = await cercaGemelloAlunno(
      client({ alunni: [alunno()] }),
      cercato({ dataNascita: `${NATO_IL}T00:00:00.000Z` }),
      OPERAZIONE,
    )
    expect(esito.esito).toBe('trovato')
  })

  it('lettura fallita → non_verificabile (non lancia), e il log è `error` con l\'errore', async () => {
    const esito = await cercaGemelloAlunno(
      client({ alunni: [alunno()] }, { alunni: { code: '08006', message: 'connection failure' } }),
      cercato(),
      { operazione: 'test/doppioni', indice: 2 },
    )
    expect(esito.esito).toBe('non_verificabile')
    const ev = log.eventi.find((e) => e.campi.esito === 'gemello-non-verificabile')
    expect(ev?.livello).toBe('error')
    expect(ev?.errore).toBeTruthy()
    expect(ev?.campi).toMatchObject({ operazione: 'test/doppioni', entita: 'bambino', indice: 2, sede_id: SEDE })
  })

  it('schema assente (il DB E2E della CI non è migrato) → non_verificabile, log `info`', async () => {
    const esito = await cercaGemelloAlunno(
      client({ alunni: [alunno()] }, { alunni: { code: '42703', message: 'column alunni.anonimizzato_il does not exist' } }),
      cercato(),
      OPERAZIONE,
    )
    expect(esito.esito).toBe('non_verificabile')
    expect(log.eventi.find((e) => e.campi.esito === 'gemello-non-verificabile')?.livello).toBe('info')
  })

  it('nei log mai nomi, codici fiscali o date di nascita', async () => {
    await cercaGemelloAlunno(
      client({ alunni: [alunno()] }, { alunni: { code: '08006', message: 'boom' } }),
      cercato(),
      OPERAZIONE,
    )
    const scritto = JSON.stringify(log.eventi.map((e) => e.campi))
    for (const dato of ['Mario', 'Rossi', CF_VALIDO, CF_REFUSO, NATO_IL]) expect(scritto).not.toContain(dato)
  })
})

describe('cercaGemelloGenitore', () => {
  const genitore = (over: Record<string, unknown> = {}) => ({
    id: GENITORE,
    first_name: 'Anna',
    last_name: 'Bianchi',
    birth_date: '1985-06-10',
    fiscal_code: 'XQQYKV85H50Z999X',
    auth_user_id: 'e5e5e5e5-0000-4000-8000-000000000006',
    emails: ['anna@example.test'],
    anonimizzato_il: null,
    ...over,
  })

  const adulto = (over: Record<string, unknown> = {}) => ({
    nome: 'anna',
    cognome: ' Bianchi ',
    dataNascita: '1985-06-10',
    codiceFiscale: 'XQQYKV85H50Z999Y',
    ...over,
  })

  it('trova la scheda gemella in `parents`, con account ed email della SCHEDA', async () => {
    const esito = await cercaGemelloGenitore(client({ parents: [genitore()] }), adulto(), OPERAZIONE)
    expect(esito).toEqual({
      esito: 'trovato',
      schede: [{ id: GENITORE, authUserId: 'e5e5e5e5-0000-4000-8000-000000000006', emails: ['anna@example.test'] }],
    })
  })

  it('un genitore non ha sede: la ricerca non ne chiede una', async () => {
    const esito = await cercaGemelloGenitore(client({ parents: [genitore()] }), adulto(), OPERAZIONE)
    expect(esito.esito).toBe('trovato')
  })

  it('una scheda anonimizzata non conta', async () => {
    const esito = await cercaGemelloGenitore(
      client({ parents: [genitore({ anonimizzato_il: '2026-09-02T10:00:00Z' })] }),
      adulto(),
      OPERAZIONE,
    )
    expect(esito).toEqual({ esito: 'nessuno' })
  })

  it('nome o data diversi → nessuno', async () => {
    expect(await cercaGemelloGenitore(client({ parents: [genitore()] }), adulto({ nome: 'Anita' }), OPERAZIONE)).toEqual({ esito: 'nessuno' })
    expect(await cercaGemelloGenitore(client({ parents: [genitore()] }), adulto({ dataNascita: '1985-06-11' }), OPERAZIONE)).toEqual({ esito: 'nessuno' })
  })

  it('scheda senza email né account: arrivano vuoti, non indefiniti', async () => {
    const esito = await cercaGemelloGenitore(
      client({ parents: [genitore({ emails: null, auth_user_id: null })] }),
      adulto(),
      OPERAZIONE,
    )
    expect(esito).toEqual({ esito: 'trovato', schede: [{ id: GENITORE, authUserId: null, emails: [] }] })
  })

  it('lettura fallita → non_verificabile, log `error`', async () => {
    const esito = await cercaGemelloGenitore(
      client({ parents: [genitore()] }, { parents: { code: '08006', message: 'boom' } }),
      adulto(),
      OPERAZIONE,
    )
    expect(esito.esito).toBe('non_verificabile')
    const ev = log.eventi.find((e) => e.campi.esito === 'gemello-non-verificabile')
    expect(ev?.livello).toBe('error')
    expect(ev?.campi.entita).toBe('genitore')
  })
})

describe('primoGemelloFraIBambini — la forma che serve all\'import massivo', () => {
  it('restituisce il primo bambino che ha un gemello in sede, col suo indice', async () => {
    const db = { alunni: [alunno()] }
    const esito = await primoGemelloFraIBambini(
      client(db),
      SEDE,
      [
        { indice: 0, nome: 'Luca', cognome: 'Rossi', dataNascita: '2021-01-01', codiceFiscale: null },
        { indice: 1, nome: 'Mario', cognome: 'Rossi', dataNascita: NATO_IL, codiceFiscale: CF_REFUSO },
      ],
      OPERAZIONE,
    )
    expect(esito).toEqual({ indice: 1, schede: [{ id: ESISTENTE, codiceFiscaleValido: true }] })
  })

  it('nessun bambino con gemello → null', async () => {
    const esito = await primoGemelloFraIBambini(
      client({ alunni: [alunno()] }),
      SEDE,
      [{ indice: 0, nome: 'Mario', cognome: 'Rossi', dataNascita: NATO_IL, codiceFiscale: CF_VALIDO }],
      OPERAZIONE,
    )
    expect(esito).toBeNull()
  })

  it('una lettura fallita non ferma la domanda: si logga e si guarda il bambino dopo', async () => {
    const esito = await primoGemelloFraIBambini(
      client({ alunni: [alunno()] }, { alunni: { code: '08006', message: 'boom' } }),
      SEDE,
      [{ indice: 0, nome: 'Mario', cognome: 'Rossi', dataNascita: NATO_IL, codiceFiscale: CF_REFUSO }],
      OPERAZIONE,
    )
    expect(esito).toBeNull()
    expect(log.eventi.some((e) => e.campi.esito === 'gemello-non-verificabile')).toBe(true)
  })
})
