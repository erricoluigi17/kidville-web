import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * L'ORDINE DEI CONTROLLI È IL CONTROLLO — e la lettura del progressivo è una per LOTTO.
 *
 * Tre difetti misurati sul motore di emissione, tutti e tre della stessa famiglia:
 * qualcosa che si poteva sapere PRIMA veniva scoperto DOPO, a numero già consumato.
 *
 *  1. GATE SUL CESSIONARIO. C'era solo `reg.fiscal_code` presente. Indirizzo, CAP e
 *     comune del genitore entravano nell'XML anche vuoti, e `prossimo_numero_fattura_
 *     sezionale` — che SCRIVE il contatore — era già stato chiamato: numero bruciato
 *     più scarto SDI. Misura del 2026-08-10 su `parents`: 22 righe con un
 *     `fiscal_code` valorizzato, 21 delle quali non hanno la forma di un codice
 *     fiscale (venti a 14 caratteri, una a due).
 *
 *  2. UNA LETTURA PER FATTURA. `docs/fatturazione/tracciato-di-riferimento.md` dice
 *     che Aruba strozza a ~60 richieste l'ora e che il numero si legge «una volta per
 *     lotto, mai una volta per fattura». Il motore faceva il contrario, con un
 *     commento che lo rivendicava, e da quando la lettura pagina l'elenco quella
 *     chiamata vale fino a 20 richieste. Le rette del mese per 32 bambini sfondavano
 *     il secchio a metà lotto.
 *
 *  3. RIGA IVA INCOERENTE. `aliquota 0` senza `Natura` è scarto SDI 00401 e lo XSD
 *     non lo vede: si scopriva dopo l'upload, a numero consumato.
 *
 * Il fake di Supabase qui CONTA le chiamate a `rpc`: «nessun numero è stato
 * consumato» non è una frase di cortesia nel messaggio d'errore, è un'asserzione.
 */

const SCUOLA = '11111111-1111-1111-1111-111111111111'

interface ClientFinto {
  arubaSignin?: unknown
  arubaUpload?: unknown
  arubaUltimoNumeroFattura?: unknown
}

async function carica(finto: ClientFinto) {
  vi.resetModules()
  vi.doMock('@/lib/logging/app-log', () => ({ appLog: vi.fn(async () => {}) }))
  vi.doMock('@/lib/aruba/client', async (originale) => {
    const actual = await originale<typeof import('@/lib/aruba/client')>()
    return { ...actual, ...finto }
  })
  return await import('@/lib/aruba/emissione')
}

/** Fake di Supabase con i CONTATORI: quante allocazioni di numero, quali insert. */
function makeSupabase(responses: Record<string, unknown> & { rpc?: number }) {
  const inserts: { table: string; row: unknown }[] = []
  const rpc = vi.fn(async () => ({ data: responses.rpc ?? 1, error: null }))
  return {
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        single: async () => ({ data: responses[table] ?? null, error: null }),
        maybeSingle: async () => ({ data: responses[table] ?? null, error: null }),
        insert: async (row: unknown) => {
          inserts.push({ table, row })
          return { error: null }
        },
        update: () => ({ eq: async () => ({ error: null }) }),
      }
      return builder
    },
    rpc,
    _inserts: inserts,
    _rpc: rpc,
  }
}

const pagamentoSaldato = {
  id: 'pag-1',
  descrizione: 'Retta di Marzo',
  importo: 150,
  stato: 'pagato',
  scadenza: '2026-03-10',
  periodo_competenza: '2026-03-01',
  scuola_id: SCUOLA,
  fattura_causale: null,
  categoria_id: null,
  alunno_id: 'al-1',
  payment_categories: null,
  alunni: {
    id: 'al-1',
    nome: 'Mario',
    cognome: 'Rossi',
    codice_fiscale: null,
    // Dato SINTETICO: decide solo la serie fiscale, non è di nessun bambino vero.
    data_nascita: '2019-03-15',
    intestatario_fatture: { tipo: 'adult', nome: 'Giulia Farina', adult_id: 'parent-1' },
  },
}

const arubaConfig = {
  username: 'utente@scuola.it',
  password_ref: 'ARUBA_PASSWORD',
  abilitato: true,
  ambiente: 'demo',
}

const settingsConfig = {
  aruba_config: arubaConfig,
  fiscale_config: {
    denominazione: "SCUOLA DELL'INFANZIA LA FAVOLA SOCIETA' COOPERATIVA",
    piva: '03394870616',
    codice_fiscale: '03394870616',
    indirizzo: 'Via Silvio Pellico',
    numero_civico: '7',
    cap: '81030',
    comune: 'Cesa',
    provincia: 'CE',
    regime_fiscale: 'RF01',
  },
}

/** Intestatario SINTETICO e completo: nessun dato di famiglie vere nei test. */
const parentCompleto = {
  id: 'parent-1',
  first_name: 'Giulia',
  last_name: 'Farina',
  fiscal_code: 'FRNGLI80A41H501Z',
  residence_address: 'Via delle Prove 9',
  residence_city: 'Cesa',
  zip_code: '81030',
}

const tokenOk = { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 }
const uploadOk = vi.fn(async () => ({ ok: true, uploadFileName: 'IT_x.xml.p7m', errorCode: '0000' }))

beforeEach(() => {
  vi.stubEnv('ARUBA_PASSWORD', 'segretissima')
})

afterEach(() => {
  vi.doUnmock('@/lib/logging/app-log')
  vi.doUnmock('@/lib/aruba/client')
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('il gate sull\'INTESTATARIO ferma PRIMA che un numero venga consumato', () => {
  it('residenza vuota → non si emette, e la RPC del numero non viene MAI chiamata', async () => {
    const upload = vi.fn(async () => ({ ok: true, uploadFileName: 'IT_x.xml.p7m', errorCode: '0000' }))
    const { emettiFatturaPagamento } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: vi.fn(async () => 2327),
      arubaUpload: upload,
    })
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      admin_settings: settingsConfig,
      // Il caso reale: il codice fiscale c'è (l'unico controllo che esisteva), la
      // residenza no. Prima usciva `<Indirizzo></Indirizzo><CAP></CAP>`, cioè uno
      // scarto SDI su un numero già assegnato.
      parents: { ...parentCompleto, residence_address: '', residence_city: '', zip_code: '' },
      rpc: 2328,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.motivo).toBe('intestatario_mancante')
      expect(esito.messaggio).toContain('Nessun numero è stato consumato')
      expect(esito.messaggio).toContain('CAP')
    }
    expect(sb._rpc, 'un numero consumato qui è un buco nel registro fiscale').not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
    expect(sb._inserts.filter((i) => i.table === 'fatture_emesse')).toHaveLength(0)
  })

  it('un codice fiscale di 14 caratteri (il caso di 20 righe su 22 in produzione) non passa', async () => {
    const { emettiFatturaPagamento } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: vi.fn(async () => 2327),
      arubaUpload: uploadOk,
    })
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      admin_settings: settingsConfig,
      parents: { ...parentCompleto, fiscal_code: 'FRNG80A41H501Z' },
      rpc: 2328,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(false)
    if (!esito.ok) expect(esito.messaggio).toContain('codice fiscale (formato)')
    expect(sb._rpc).not.toHaveBeenCalled()
  })

  it('un\'anagrafica completa passa il gate e la fattura parte', async () => {
    // La prova che il gate non blocca il caso buono: senza questa riga «non emette
    // mai niente» supererebbe i due casi qui sopra.
    const upload = vi.fn(async () => ({ ok: true, uploadFileName: 'IT_ok.xml.p7m', errorCode: '0000' }))
    const { emettiFatturaPagamento } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: vi.fn(async () => 2327),
      arubaUpload: upload,
    })
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      admin_settings: settingsConfig,
      parents: parentCompleto,
      rpc: 2328,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(true)
    if (esito.ok) expect(esito.numero).toBe(2328)
    expect(upload).toHaveBeenCalledTimes(1)
  })
})

describe('il progressivo si legge UNA VOLTA PER LOTTO', () => {
  it('tre pagamenti di fila → UNA sola chiamata a `findByUsername`, non tre', async () => {
    // Con la lettura per-fattura, le rette del mese per 32 bambini facevano 32
    // letture (fino a 20 richieste HTTP ciascuna) più 32 upload: il secchio di Aruba
    // (~60 richieste l'ora) si svuota a metà lotto e da lì in poi NESSUNA fattura
    // parte più, con metà delle rette già emesse.
    const ultimoNumero = vi.fn(async () => 2327)
    const { emettiFatturaPagamento } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: ultimoNumero,
      arubaUpload: vi.fn(async () => ({ ok: true, uploadFileName: 'IT_lotto.xml.p7m', errorCode: '0000' })),
    })
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      admin_settings: settingsConfig,
      parents: parentCompleto,
      rpc: 2328,
    })

    for (const id of ['pag-1', 'pag-2', 'pag-3']) {
      const esito = await emettiFatturaPagamento(sb as never, id, { id: 'staff-1' })
      expect(esito.ok).toBe(true)
    }

    expect(ultimoNumero).toHaveBeenCalledTimes(1)
    // Le fatture però sono tre: la cache riguarda il PAVIMENTO, non l'emissione.
    expect(sb._inserts.filter((i) => i.table === 'fatture_emesse')).toHaveLength(3)
  })

  it('la cache si può svuotare, e allora si rilegge (i test non si passano lo stato)', async () => {
    const ultimoNumero = vi.fn(async () => 2327)
    const { emettiFatturaPagamento, svuotaCacheUltimoNumeroAruba } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: ultimoNumero,
      arubaUpload: vi.fn(async () => ({ ok: true, uploadFileName: 'IT_c.xml.p7m', errorCode: '0000' })),
    })
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      admin_settings: settingsConfig,
      parents: parentCompleto,
      rpc: 2328,
    })

    await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    svuotaCacheUltimoNumeroAruba()
    await emettiFatturaPagamento(sb as never, 'pag-2', { id: 'staff-1' })

    expect(ultimoNumero).toHaveBeenCalledTimes(2)
  })

  it('IL 429 DI ARUBA ha un messaggio suo: aspettare, non ricontrollare la configurazione', async () => {
    // Aruba risponde al limite di chiamate con una PAGINA HTML, non con un errore
    // strutturato: il `code` sull'errore è l'unico appiglio per distinguerlo da un
    // guasto vero, e la risposta giusta per la segreteria è opposta.
    const errore429 = Object.assign(new Error('Aruba findByUsername fallita (HTTP 429): <html>…'), {
      name: 'ArubaHttpError',
      code: '429',
    })
    const { emettiFatturaPagamento } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: vi.fn(async () => {
        throw errore429
      }),
      arubaUpload: uploadOk,
    })
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      admin_settings: settingsConfig,
      parents: parentCompleto,
      rpc: 2328,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.motivo).toBe('numerazione_non_allineata')
      expect(esito.messaggio).toContain('troppe richieste')
      expect(esito.messaggio).toContain('nessun numero è stato consumato')
    }
    expect(sb._rpc).not.toHaveBeenCalled()
  })
})

describe('la riga IVA incoerente si ferma alla configurazione, non allo SDI', () => {
  it('`aliquota 0` senza `natura` → 503 «non configurato», e nessun numero consumato', async () => {
    const upload = vi.fn(async () => ({ ok: true, uploadFileName: 'IT_iva.xml.p7m', errorCode: '0000' }))
    const { emettiFatturaPagamento } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: vi.fn(async () => 2327),
      arubaUpload: upload,
    })
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      admin_settings: {
        ...settingsConfig,
        // La riga che `z.unknown()` lasciava salvare: senza natura.
        aruba_config: { ...arubaConfig, iva: [{ causale: 'Retta', aliquota: 0 }] },
      },
      parents: parentCompleto,
      rpc: 2328,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.motivo).toBe('non_configurato')
      expect(esito.httpStatus).toBe(503)
      expect(esito.messaggio).toContain('00401')
    }
    expect(sb._rpc).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
  })

  it('`aliquota 22` CON `natura` → si ferma anche lei (00400)', async () => {
    const { emettiFatturaPagamento } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: vi.fn(async () => 2327),
      arubaUpload: uploadOk,
    })
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      admin_settings: {
        ...settingsConfig,
        aruba_config: { ...arubaConfig, iva: [{ causale: 'Retta', aliquota: 22, natura: 'N4' }] },
      },
      parents: parentCompleto,
      rpc: 2328,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(false)
    if (!esito.ok) expect(esito.messaggio).toContain('00400')
    expect(sb._rpc).not.toHaveBeenCalled()
  })

  it('IL RIFERIMENTO NORMATIVO configurato arriva nell\'XML a registro', async () => {
    // Prima non veniva passato affatto: `<RiferimentoNormativo>` spariva proprio
    // sulle righe esenti configurate a mano dalla sede.
    const { emettiFatturaPagamento } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: vi.fn(async () => 2327),
      arubaUpload: vi.fn(async () => ({ ok: true, uploadFileName: 'IT_rn.xml.p7m', errorCode: '0000' })),
    })
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      admin_settings: {
        ...settingsConfig,
        aruba_config: {
          ...arubaConfig,
          iva: [
            {
              causale: 'Retta',
              aliquota: 0,
              natura: 'N4',
              riferimento_normativo: 'Esente art. 10 n. 20 DPR 633/1972',
            },
          ],
        },
      },
      parents: parentCompleto,
      rpc: 2328,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(true)
    const riga = sb._inserts.find((i) => i.table === 'fatture_emesse')?.row as { xml_inviato: string }
    expect(riga.xml_inviato).toContain('<Natura>N4</Natura>')
    expect(riga.xml_inviato).toContain('<RiferimentoNormativo>Esente art. 10 n. 20 DPR 633/1972</RiferimentoNormativo>')
  })
})
