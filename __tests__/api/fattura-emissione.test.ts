import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Stub delle chiamate di rete Aruba (mantengo reali resolveArubaCredentials/arubaBaseUrls).
vi.mock('@/lib/aruba/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/aruba/client')>()
  return { ...actual, arubaSignin: vi.fn(), arubaUpload: vi.fn(), arubaUltimoNumeroFattura: vi.fn() }
})

import { emettiFatturaPagamento, svuotaCacheUltimoNumeroAruba } from '@/lib/aruba/emissione'
import { arubaSignin, arubaUpload, arubaUltimoNumeroFattura } from '@/lib/aruba/client'

/**
 * IL PAVIMENTO DELLA SERIE È IN CACHE — e i test non se lo passano l'un l'altro.
 *
 * Dal 2026-08-10 l'ultimo numero si legge da Aruba **una volta per lotto** e non
 * una volta per fattura (`TTL_ULTIMO_NUMERO_MS` in `emissione.ts`): Aruba strozza a
 * ~60 richieste l'ora e la rilettura per-fattura spezzava a metà l'emissione delle
 * rette del mese. La cache vive nel modulo, e questo file importa il modulo UNA
 * VOLTA per tutti i casi: senza questa riga il secondo caso troverebbe il pavimento
 * lasciato dal primo, non chiamerebbe `arubaUltimoNumeroFattura`, e misurerebbe un
 * comportamento che in produzione non esiste — cioè il test direbbe «verde» sul
 * nulla. Sta al livello del file, prima di ogni `describe`, perché la cache non
 * appartiene a nessuno di loro in particolare.
 */
beforeEach(() => svuotaCacheUltimoNumeroAruba())

const SCUOLA = '11111111-1111-1111-1111-111111111111'

/**
 * IL TEMPO È FERMO, e non è un vezzo.
 *
 * Da oggi l'emissione decide la SERIE FISCALE dalla data di nascita del bambino
 * confrontata con l'anno scolastico corrente, e scrive l'anno dentro il numero
 * (`FPR 7/26`). Un test che leggesse l'orologio direbbe la verità oggi e
 * cambierebbe risposta da solo fra due anni, senza che nessuno abbia toccato una
 * riga: è la forma esatta dei difetti che questo repo ha già pagato. Si congela
 * il SOLO `Date` — i timer restano veri, perché `vi.waitFor` e le attese
 * asincrone dei test ne hanno bisogno.
 *
 * 2026-03-31 12:00 a Roma: anno fiscale 2026, anno scolastico 2025/26, quindi il
 * confine fra le due serie è il 30/04/2023 (tre anni compiuti entro il 30 aprile).
 */
const ADESSO = new Date('2026-03-31T10:00:00Z')
/** Nato prima del confine → serie «FPR». Resta FPR qualunque sia l'anno di esecuzione. */
const NASCITA_FPR = '2019-03-15'
/** Nato dopo il confine (30/04/2023) → serie «Asilo». */
const NASCITA_ASILO = '2024-09-10'

function makeSupabase(responses: Record<string, unknown> & { rpc?: number }) {
  const inserts: { table: string; row: unknown }[] = []
  const updates: { table: string; row: unknown }[] = []
  const rpcCalls: { fn: string; args: unknown }[] = []
  const api = {
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
        update: (row: unknown) => ({
          eq: async () => {
            updates.push({ table, row })
            return { error: null }
          },
        }),
      }
      return builder
    },
    rpc: async (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args })
      return { data: responses.rpc ?? 1, error: null }
    },
    _inserts: inserts,
    _updates: updates,
    _rpc: rpcCalls,
  }
  return api
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
  categoria_id: 'cat-1',
  alunno_id: 'al-1',
  payment_categories: { slug: 'retta' },
  alunni: {
    id: 'al-1',
    nome: 'Mario',
    cognome: 'Rossi',
    // Dati SINTETICI: il repository è pubblico e i bambini veri non entrano nei test.
    codice_fiscale: 'RSSMRA19C15H501K',
    data_nascita: NASCITA_FPR,
    intestatario_fatture: { tipo: 'adult', nome: 'Giulia Farina', adult_id: 'parent-1' },
  },
}

/** L'anagrafica del cedente nella FONTE UNICA: `admin_settings.fiscale_config`. */
const cedenteCompleto = {
  denominazione: 'Kidville Scuola Cooperativa',
  piva: '12345678903',
  codice_fiscale: '12345678903',
  indirizzo: 'Via Roma',
  numero_civico: '1',
  cap: '00100',
  comune: 'Roma',
  provincia: 'RM',
  regime_fiscale: 'RF01',
  iban: 'IT60X0542811101000000123456',
}

const settingsConfig = {
  aruba_config: {
    username: 'utente@scuola.it',
    password_ref: 'ARUBA_PASSWORD',
    abilitato: true,
    ambiente: 'demo',
    // Ripiego storico, tenuto apposta: è la configurazione delle sedi che non
    // hanno ancora compilato `fiscale_config`, e un test qui sotto la esercita.
    fiscal: { piva: '12345678903', ragione_sociale: 'Kidville Srl', regime: 'RF01', indirizzo: 'Via Roma 1', cap: '00100', comune: 'Roma', provincia: 'RM' },
  },
  fiscale_config: cedenteCompleto,
}
const parent = {
  id: 'parent-1',
  first_name: 'Giulia',
  last_name: 'Farina',
  fiscal_code: 'FRNGLI80A41H501Z',
  residence_address: 'Via Milano',
  residence_street_number: '9',
  residence_city: 'Roma',
  residence_province: 'RM',
  zip_code: '00185',
}

/** L'XML della prima (o unica) riga scritta a registro. */
function xmlEmesso(sb: ReturnType<typeof makeSupabase>): string {
  const riga = sb._inserts.find((i) => i.table === 'fatture_emesse')
  return (riga!.row as { xml_inviato: string }).xml_inviato
}

describe('emettiFatturaPagamento', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(ADESSO)
    process.env.ARUBA_PASSWORD = 'segretissima'
    // La lettura del progressivo su Aruba è BLOCCANTE: senza un valore, ogni
    // emissione si fermerebbe. Zero = «la serie non ha ancora documenti quest'anno».
    vi.mocked(arubaUltimoNumeroFattura).mockResolvedValue(0)
  })
  afterEach(() => {
    vi.useRealTimers()
    delete process.env.ARUBA_PASSWORD
  })

  it('rifiuta un pagamento non saldato (400) senza chiamare Aruba', async () => {
    const sb = makeSupabase({ pagamenti: { ...pagamentoSaldato, stato: 'in_attesa' } })
    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.motivo).toBe('non_saldato')
      expect(esito.httpStatus).toBe(400)
    }
    expect(arubaUpload).not.toHaveBeenCalled()
  })

  it('Aruba non abilitato / credenziali assenti → non_configurato (503)', async () => {
    delete process.env.ARUBA_PASSWORD
    const sb = makeSupabase({ pagamenti: pagamentoSaldato, admin_settings: settingsConfig })
    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.motivo).toBe('non_configurato')
      expect(esito.httpStatus).toBe(503)
    }
  })

  it('happy path: genera XML, fa upload base64, persiste e mette il pagamento in_attesa', async () => {
    vi.mocked(arubaSignin).mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 })
    vi.mocked(arubaUpload).mockResolvedValue({ ok: true, uploadFileName: 'IT12345678903_a1b2.xml.p7m', errorCode: '0000' })
    const sb = makeSupabase({ pagamenti: pagamentoSaldato, admin_settings: settingsConfig, parents: parent, rpc: 7 })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(true)
    if (esito.ok) {
      expect(esito.numero).toBe(7)
      expect(esito.numeroFattura).toBe('FPR 7/26')
      expect(esito.uploadFileName).toBe('IT12345678903_a1b2.xml.p7m')
    }

    // upload chiamato con il solo dataFile base64: NIENTE `senderPIVA` su un TD01. Il 2026-09-03
    // la prima fattura vera è stata respinta da Aruba con `0093` «deleghe non valide» proprio per
    // quel campo, mandato a 11 cifre nude (la doc lo vuole `IT`+P.IVA, e solo sui TD26).
    const uploadArgs = vi.mocked(arubaUpload).mock.calls[0]
    expect('senderPIVA' in (uploadArgs[2] as object)).toBe(false)
    const dataFile = (uploadArgs[2] as { dataFileBase64: string }).dataFileBase64
    const decoded = Buffer.from(dataFile, 'base64').toString('utf-8')
    expect(decoded).toContain('<FormatoTrasmissione>FPR12</FormatoTrasmissione>')
    expect(decoded).toContain('<Natura>N4</Natura>')

    // persistenza: riga fatture_emesse + pagamento in_attesa con aruba_filename
    const fattura = sb._inserts.find((i: { table: string }) => i.table === 'fatture_emesse')
    expect(fattura).toBeTruthy()
    expect((fattura!.row as { aruba_filename: string }).aruba_filename).toBe('IT12345678903_a1b2.xml.p7m')
    const pagUpd = sb._updates.find((u: { table: string }) => u.table === 'pagamenti')
    expect((pagUpd!.row as { fattura_stato: string }).fattura_stato).toBe('in_attesa')
    expect((pagUpd!.row as { fattura_aruba_id: string }).fattura_aruba_id).toBe('IT12345678903_a1b2.xml.p7m')
  })

  it('bollo virtuale: fiscale_config attivo + importo sopra soglia → DatiBollo nell\'XML e flag a registro', async () => {
    vi.mocked(arubaSignin).mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 })
    vi.mocked(arubaUpload).mockResolvedValue({ ok: true, uploadFileName: 'IT_bollo.xml.p7m', errorCode: '0000' })
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      admin_settings: { ...settingsConfig, fiscale_config: { ...cedenteCompleto, bollo_enabled: true } },
      parents: parent,
      rpc: 8,
    })
    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(true)
    const fattura = sb._inserts.find((i: { table: string }) => i.table === 'fatture_emesse')
    expect((fattura!.row as { bollo_virtuale?: boolean }).bollo_virtuale).toBe(true)
    expect((fattura!.row as { xml_inviato: string }).xml_inviato).toContain('<DatiBollo>')
    expect((fattura!.row as { xml_inviato: string }).xml_inviato).toContain('<ImportoBollo>2.00</ImportoBollo>')
  })

  it('senza fiscale_config si ripiega su aruba_config.fiscal: nessun bollo, e il cedente esce comunque', async () => {
    vi.mocked(arubaSignin).mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 })
    vi.mocked(arubaUpload).mockResolvedValue({ ok: true, uploadFileName: 'IT_x.xml.p7m', errorCode: '0000' })
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      admin_settings: { ...settingsConfig, fiscale_config: undefined },
      parents: parent,
      rpc: 9,
    })
    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(true)
    const fattura = sb._inserts.find((i: { table: string }) => i.table === 'fatture_emesse')
    expect((fattura!.row as { bollo_virtuale?: boolean }).bollo_virtuale).toBe(false)
    expect((fattura!.row as { xml_inviato: string }).xml_inviato).not.toContain('<DatiBollo>')
    // Il ripiego porta CAP e comune, che è il difetto storico che `cedenteDaConfig` chiude.
    expect((fattura!.row as { xml_inviato: string }).xml_inviato).toContain('<CAP>00100</CAP>')
  })

  it('upload scartato da Aruba (errorCode != 0000) → scartata (502) e pagamento scartata', async () => {
    vi.mocked(arubaSignin).mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 })
    vi.mocked(arubaUpload).mockResolvedValue({ ok: false, errorCode: '0094', errorDescription: 'IdTrasmittente non valido' })
    const sb = makeSupabase({ pagamenti: pagamentoSaldato, admin_settings: settingsConfig, parents: parent, rpc: 8 })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.motivo).toBe('scartata')
      expect(esito.httpStatus).toBe(502)
    }
    const pagUpd = sb._updates.find((u: { table: string }) => u.table === 'pagamenti')
    expect((pagUpd!.row as { fattura_stato: string }).fattura_stato).toBe('scartata')
  })

  it('IVA 22%: scorpora l\'imponibile e ImportoTotaleDocumento = lordo incassato', async () => {
    vi.mocked(arubaSignin).mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 })
    vi.mocked(arubaUpload).mockResolvedValue({ ok: true, uploadFileName: 'IT_iva.xml.p7m', errorCode: '0000' })
    const sb = makeSupabase({
      pagamenti: { ...pagamentoSaldato, descrizione: 'Gadget scuola' },
      admin_settings: { ...settingsConfig, aruba_config: { ...settingsConfig.aruba_config, iva: [{ causale: 'Gadget', aliquota: 22 }] } },
      parents: parent,
      rpc: 10,
    })
    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(true)
    const xml = xmlEmesso(sb)
    // 150 lordo / 1.22 = 122.95 imponibile, imposta 27.05, totale documento 150.00
    expect(xml).toContain('<ImponibileImporto>122.95</ImponibileImporto>')
    expect(xml).toContain('<Imposta>27.05</Imposta>')
    expect(xml).toContain('<ImportoTotaleDocumento>150.00</ImportoTotaleDocumento>')
  })

  it('allinea il progressivo ad Aruba: interroga l\'ultimo numero della SERIE prima di numerare', async () => {
    vi.mocked(arubaSignin).mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 })
    vi.mocked(arubaUpload).mockResolvedValue({ ok: true, uploadFileName: 'IT_sync.xml.p7m', errorCode: '0000' })
    vi.mocked(arubaUltimoNumeroFattura).mockResolvedValue(1946)
    const sb = makeSupabase({ pagamenti: pagamentoSaldato, admin_settings: settingsConfig, parents: parent, rpc: 1947 })
    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(true)
    // Il sezionale arriva fino alla chiamata: senza, si leggerebbe il massimo
    // delle DUE serie mescolate — che è come sono nati i numeri doppi.
    expect(vi.mocked(arubaUltimoNumeroFattura).mock.calls[0][2]).toMatchObject({ sezionale: 'FPR', anno: 2026 })
    // …e finisce nella RPC come `p_min`, con il nome della serie.
    expect(sb._rpc[0]).toMatchObject({
      fn: 'prossimo_numero_fattura_sezionale',
      args: { p_sezionale: 'FPR', p_anno: 2026, p_min: 1946 },
    })
    if (esito.ok) expect(esito.numeroFattura).toBe('FPR 1947/26') // GREATEST(locale, 1946)+1 via RPC
  })
})

describe('la SERIE FISCALE — «Asilo» o «FPR», e non si indovina mai', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(ADESSO)
    process.env.ARUBA_PASSWORD = 'segretissima'
    vi.mocked(arubaUltimoNumeroFattura).mockResolvedValue(0)
    vi.mocked(arubaSignin).mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 })
    vi.mocked(arubaUpload).mockResolvedValue({ ok: true, uploadFileName: 'IT_s.xml.p7m', errorCode: '0000' })
  })
  afterEach(() => {
    vi.useRealTimers()
    delete process.env.ARUBA_PASSWORD
  })

  it('nato dopo il 30 aprile del confine → «Asilo», con l\'anno a QUATTRO cifre', async () => {
    const sb = makeSupabase({
      pagamenti: {
        ...pagamentoSaldato,
        alunni: { ...pagamentoSaldato.alunni, codice_fiscale: null, data_nascita: NASCITA_ASILO },
      },
      admin_settings: settingsConfig,
      parents: parent,
      rpc: 2328,
    })
    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(true)
    if (esito.ok) expect(esito.numeroFattura).toBe('Asilo 2328/2026')
    const riga = sb._inserts.find((i) => i.table === 'fatture_emesse')!
    expect((riga.row as { sezionale: string }).sezionale).toBe('Asilo')
    // Il ProgressivoInvio porta la LETTERA della serie e l'anno: altrimenti la
    // 2328 di «Asilo» e la 2328 di «FPR» genererebbero lo stesso nome file.
    expect((riga.row as { progressivo_invio: string }).progressivo_invio).toBe('A26002328')
    expect(xmlEmesso(sb)).toContain('<Numero>Asilo 2328/2026</Numero>')
  })

  it('la serie sta a REGISTRO insieme al numero: senza, «2328/2026» è ambiguo', async () => {
    const sb = makeSupabase({ pagamenti: pagamentoSaldato, admin_settings: settingsConfig, parents: parent, rpc: 2328 })
    await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    const riga = sb._inserts.find((i) => i.table === 'fatture_emesse')!
    expect(riga.row).toMatchObject({ sezionale: 'FPR', numero: 2328, anno: 2026 })
  })

  it('senza codice fiscale E senza data di nascita l\'emissione si BLOCCA (422) e Aruba non viene toccata', async () => {
    const sb = makeSupabase({
      pagamenti: {
        ...pagamentoSaldato,
        alunni: { ...pagamentoSaldato.alunni, codice_fiscale: null, data_nascita: null },
      },
      admin_settings: settingsConfig,
      parents: parent,
      rpc: 3,
    })
    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.motivo).toBe('dati_minore_mancanti')
      expect(esito.httpStatus).toBe(422)
      expect(esito.messaggio).toContain('serie fiscale')
    }
    // Niente numero bruciato, niente documento in volo: ci si ferma PRIMA.
    expect(arubaUpload).not.toHaveBeenCalled()
    expect(sb._rpc).toHaveLength(0)
    expect(sb._inserts).toHaveLength(0)
  })

  it('quando CF e anagrafica discordano vince l\'anagrafica (e la fattura parte lo stesso)', async () => {
    // CF che dice 15/03/2019 (→ FPR), anagrafica che dice 10/09/2024 (→ Asilo).
    const sb = makeSupabase({
      pagamenti: {
        ...pagamentoSaldato,
        alunni: { ...pagamentoSaldato.alunni, codice_fiscale: 'RSSMRA19C15H501K', data_nascita: NASCITA_ASILO },
      },
      admin_settings: settingsConfig,
      parents: parent,
      rpc: 5,
    })
    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(true)
    if (esito.ok) expect(esito.numeroFattura).toBe('Asilo 5/2026')
  })
})

describe('il CEDENTE e il blocco DatiPagamento', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(ADESSO)
    process.env.ARUBA_PASSWORD = 'segretissima'
    vi.mocked(arubaUltimoNumeroFattura).mockResolvedValue(0)
    vi.mocked(arubaSignin).mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 })
    vi.mocked(arubaUpload).mockResolvedValue({ ok: true, uploadFileName: 'IT_c.xml.p7m', errorCode: '0000' })
  })
  afterEach(() => {
    vi.useRealTimers()
    delete process.env.ARUBA_PASSWORD
  })

  it('CAP, comune e provincia del cedente escono VALORIZZATI (era il difetto: uscivano vuoti)', async () => {
    const sb = makeSupabase({ pagamenti: pagamentoSaldato, admin_settings: settingsConfig, parents: parent, rpc: 4 })
    await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    const xml = xmlEmesso(sb)
    expect(xml).toContain('<Denominazione>Kidville Scuola Cooperativa</Denominazione>')
    // Via e civico escono in DUE elementi, come per il cessionario: dal 2026-08-10
    // `cedenteDaConfig` non li incolla più in `<Indirizzo>` (il tracciato ha
    // `<NumeroCivico>` fra `Indirizzo` e `CAP`, e il vecchio accorpamento rischiava
    // di far cadere il civico nel troncamento a 60 caratteri).
    expect(xml).toContain('<Indirizzo>Via Roma</Indirizzo>')
    expect(xml).toContain('<NumeroCivico>1</NumeroCivico>')
    expect(xml).toContain('<CAP>00100</CAP>')
    expect(xml).toContain('<Comune>Roma</Comune>')
    expect(xml).toContain('<Provincia>RM</Provincia>')
    expect(xml).not.toContain('<CAP></CAP>')
  })

  it('cedente incompleto → 503 e NIENTE emissione (nessun numero bruciato)', async () => {
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      // Né `fiscale_config` né il ripiego: non c'è anagrafica da nessuna parte.
      admin_settings: {
        aruba_config: { username: 'u@s.it', password_ref: 'ARUBA_PASSWORD', abilitato: true, ambiente: 'demo' },
      },
      parents: parent,
      rpc: 4,
    })
    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.motivo).toBe('non_configurato')
      expect(esito.httpStatus).toBe(503)
      expect(esito.messaggio).toContain('Dati del cedente incompleti')
    }
    expect(arubaUpload).not.toHaveBeenCalled()
    expect(sb._rpc).toHaveLength(0)
  })

  it('DatiPagamento: bonifico MP05, unica soluzione TP02 e scadenza — e NIENTE altro', async () => {
    const sb = makeSupabase({ pagamenti: pagamentoSaldato, admin_settings: settingsConfig, parents: parent, rpc: 4 })
    await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    const xml = xmlEmesso(sb)
    expect(xml).toContain('<CondizioniPagamento>TP02</CondizioniPagamento>')
    expect(xml).toContain('<ModalitaPagamento>MP05</ModalitaPagamento>')
    expect(xml).toContain('<DataScadenzaPagamento>2026-03-10</DataScadenzaPagamento>')
    expect(xml).toContain('<ImportoPagamento>150.00</ImportoPagamento>')
    // L'ordine è quello dello schema: DatiPagamento DOPO DatiBeniServizi.
    expect(xml.indexOf('<DatiPagamento>')).toBeGreaterThan(xml.indexOf('</DatiBeniServizi>'))
  })

  it('l\'IBAN NON entra nel tracciato, nemmeno quando è configurato', async () => {
    // ⚠️ IL CASO ROVESCIATO IL 2026-08-10, ed è il punto. Questo test pretendeva
    // `<IBAN>IT60X…</IBAN>` perché il PRD lo prescriveva, mentre
    // `docs/fatturazione/tracciato-di-riferimento.md` — scritto nello stesso
    // lavoro — elencava «aggiungere IBAN per completezza» fra gli errori. Ha
    // deciso la misura: due fatture vere scaricate da Aruba (`Asilo 2327/2026` e
    // `FPR 1946/26`) hanno in `<DettaglioPagamento>` soltanto ModalitaPagamento,
    // DataScadenzaPagamento e ImportoPagamento. Nessun `<Beneficiario>`.
    // La fixture TIENE l'IBAN configurato apposta: senza, il caso non
    // proverebbe niente — passerebbe anche se il codice tornasse a leggerlo.
    expect(cedenteCompleto.iban).toBeTruthy()
    const sb = makeSupabase({ pagamenti: pagamentoSaldato, admin_settings: settingsConfig, parents: parent, rpc: 4 })
    await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    const xml = xmlEmesso(sb)
    expect(xml).toContain('<DatiPagamento>')
    expect(xml).not.toContain('<IBAN>')
    expect(xml).not.toContain(cedenteCompleto.iban)
    expect(xml).not.toContain('<Beneficiario>')
  })

  it('CessionarioCommittente: provincia e numero civico del genitore entrano nell\'XML', async () => {
    const sb = makeSupabase({ pagamenti: pagamentoSaldato, admin_settings: settingsConfig, parents: parent, rpc: 4 })
    await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    const xml = xmlEmesso(sb)
    const cessionario = xml.slice(xml.indexOf('<CessionarioCommittente>'), xml.indexOf('</CessionarioCommittente>'))
    expect(cessionario).toContain('<Indirizzo>Via Milano</Indirizzo>')
    expect(cessionario).toContain('<NumeroCivico>9</NumeroCivico>')
    expect(cessionario).toContain('<Provincia>RM</Provincia>')
  })
})

describe('la CAUSALE della fattura — cascata manuale → categoria → predefinito', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(ADESSO)
    process.env.ARUBA_PASSWORD = 'segretissima'
    vi.mocked(arubaUltimoNumeroFattura).mockResolvedValue(0)
    vi.mocked(arubaSignin).mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 })
    vi.mocked(arubaUpload).mockResolvedValue({ ok: true, uploadFileName: 'IT_ca.xml.p7m', errorCode: '0000' })
  })
  afterEach(() => {
    vi.useRealTimers()
    delete process.env.ARUBA_PASSWORD
  })

  const causaleScritta = (sb: ReturnType<typeof makeSupabase>) =>
    (sb._inserts.find((i) => i.table === 'fatture_emesse')!.row as { causale: string }).causale

  it('usa il modello della CATEGORIA del pagamento (slug `retta`)', async () => {
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      admin_settings: {
        ...settingsConfig,
        fattura_causali_config: {
          default: 'Predefinito {descrizione}',
          retta: 'Retta {mese} {anno} - {nome_completo}',
        },
      },
      parents: parent,
      rpc: 4,
    })
    await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    // I segnaposto parlano dell'ALUNNO: è il bambino che il documento identifica.
    expect(causaleScritta(sb)).toBe('Retta marzo 2026 - Mario Rossi')
  })

  it('senza riga di categoria si ricade su «Predefinito»', async () => {
    const sb = makeSupabase({
      pagamenti: { ...pagamentoSaldato, payment_categories: { slug: 'gita' } },
      admin_settings: { ...settingsConfig, fattura_causali_config: { default: 'Predefinito {descrizione}' } },
      parents: parent,
      rpc: 4,
    })
    await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(causaleScritta(sb)).toBe('Predefinito Retta di Marzo')
  })

  it('la correzione scritta A MANO dalla segreteria vince su qualunque modello', async () => {
    const sb = makeSupabase({
      pagamenti: { ...pagamentoSaldato, fattura_causale: 'Saldo concordato con la famiglia' },
      admin_settings: { ...settingsConfig, fattura_causali_config: { retta: 'Retta {mese}' } },
      parents: parent,
      rpc: 4,
    })
    await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(causaleScritta(sb)).toBe('Saldo concordato con la famiglia')
  })

  it('l\'emissione NON riscrive più `pagamenti.fattura_causale` (era ciò che congelava la causale)', async () => {
    // Riscrivendola, dal secondo giro quel campo non era più «ciò che ha scritto
    // una persona» ma l'eco della prima composizione: cambiare il modello della
    // categoria non aveva più alcun effetto, e nessuno poteva capire perché.
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      admin_settings: { ...settingsConfig, fattura_causali_config: { retta: 'Retta {mese}' } },
      parents: parent,
      rpc: 4,
    })
    await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    for (const upd of sb._updates.filter((u) => u.table === 'pagamenti')) {
      expect(Object.keys(upd.row as object)).not.toContain('fattura_causale')
    }
  })

  it('nessun modello configurato → il modello di fabbrica, che parte dalla descrizione', async () => {
    const sb = makeSupabase({ pagamenti: pagamentoSaldato, admin_settings: settingsConfig, parents: parent, rpc: 4 })
    await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    const causale = causaleScritta(sb)
    expect(causale).toContain('Retta di Marzo')
    expect(causale).toContain('Mario Rossi')
    // «del minore»: il genere viene dal CF del bambino, non da un default maschile.
    expect(causale).toContain('del minore')
  })
})

describe('il progressivo che non si può leggere: si FERMA, non si indovina', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(ADESSO)
    process.env.ARUBA_PASSWORD = 'segretissima'
    vi.mocked(arubaSignin).mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 })
    vi.mocked(arubaUpload).mockResolvedValue({ ok: true, uploadFileName: 'IT_n.xml.p7m', errorCode: '0000' })
  })
  afterEach(() => {
    vi.useRealTimers()
    delete process.env.ARUBA_PASSWORD
  })

  it('Aruba non risponde sul progressivo → 503, nessun upload, nessuna riga a registro', async () => {
    // Fino al 2026-08-09 qui si proseguiva «col contatore interno». Su una serie
    // che vive sul gestionale di Aruba quel contatore vale ZERO: sarebbe uscito
    // un «FPR 1/26» su una serie che di documenti ne ha 1.946.
    vi.mocked(arubaUltimoNumeroFattura).mockRejectedValue(
      Object.assign(new Error('Aruba findByUsername fallita (HTTP 403): {"errorDescription":"User not enabled"}'), { code: '403' }),
    )
    const sb = makeSupabase({ pagamenti: pagamentoSaldato, admin_settings: settingsConfig, parents: parent, rpc: 1 })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.motivo).toBe('numerazione_non_allineata')
      expect(esito.httpStatus).toBe(503)
      // Su un 403 la serie NON è l'informazione utile: ciò che la segreteria deve
      // sapere è che riprovare non serve e dove andare a guardare. Fino al
      // 2026-09-02 qui usciva «Riprova più tardi» per un guasto che sarebbe
      // rimasto identico l'indomani.
      expect(esito.messaggio).toContain('credenziali')
      expect(esito.messaggio).toContain('nessun numero è stato consumato')
      expect(esito.messaggio).not.toContain('Riprova fra')
    }
    expect(arubaUpload).not.toHaveBeenCalled()
    expect(sb._rpc).toHaveLength(0)
    expect(sb._inserts.filter((i) => i.table === 'fatture_emesse')).toHaveLength(0)
  })

  it('ogni guasto ha il SUO messaggio: sei cause non possono avere una frase sola', async () => {
    // Il 2026-09-02 la segreteria ha letto «Riprova più tardi» davanti a un guasto
    // del nostro parser, che sarebbe stato identico anche il giorno dopo. Il `code`
    // per distinguere c'era già: non veniva guardato.
    //
    // Si asserisce su PAROLE PORTANTI, non sulla frase intera: una virgola cambiata
    // non deve tingere di rosso un test che parla d'altro. Ma un test ci vuole:
    // senza, «Riprova più tardi» può tornare su un 403 e nessuno se ne accorge.
    const casi = [
      { code: '429', deve: 'troppe richieste', nonDeve: 'configurazione' },
      { code: '403', deve: 'credenziali', nonDeve: 'Riprova fra' },
      { code: '401', deve: 'credenziali', nonDeve: 'Riprova fra' },
      { code: 'rete', deve: 'non ha risposto entro 30 secondi', nonDeve: 'credenziali' },
      // Qui il «non deve» NON può essere «credenziali»: il messaggio le nomina
      // apposta, per dire che NON sono loro il problema. Ciò che non deve esserci è
      // l'invito a riprovare — il formato non cambia aspettando.
      { code: 'etichette-illeggibili', deve: 'FPR', nonDeve: 'Riprova' },
      { code: 'qualcosa-di-ignoto', deve: 'Impossibile leggere', nonDeve: 'credenziali' },
    ] as const

    for (const caso of casi) {
      vi.mocked(arubaUltimoNumeroFattura).mockRejectedValue(
        Object.assign(new Error(`guasto simulato ${caso.code}`), { code: caso.code }),
      )
      const sb = makeSupabase({ pagamenti: pagamentoSaldato, admin_settings: settingsConfig, parents: parent, rpc: 1 })
      const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
      expect(esito.ok, caso.code).toBe(false)
      if (!esito.ok) {
        expect(esito.messaggio, caso.code).toContain(caso.deve)
        expect(esito.messaggio, caso.code).not.toContain(caso.nonDeve)
        // L'unica promessa identica in tutti e sei i rami, ed è quella che conta:
        // chi legge deve poter dare per certo che non è partito niente.
        expect(esito.messaggio, caso.code).toContain('nessun numero è stato consumato')
      }
      // E la promessa deve essere VERA, non solo scritta.
      expect(arubaUpload, caso.code).not.toHaveBeenCalled()
      expect(sb._rpc, caso.code).toHaveLength(0)
    }
  })
})
