// @vitest-environment node
/**
 * IL CESSIONARIO DIGITATO A MANO, PASSATO ALLO SCHEMA UFFICIALE.
 *
 * ─── PERCHÉ NON BASTA CERCARE `<Nome>` NELLA STRINGA ─────────────────────────
 * Un documento può contenere tutte le stringhe giuste ed essere scartato lo
 * stesso: lo SdI controlla per primo l'ORDINE imposto da `xs:sequence`, la
 * presenza degli elementi obbligatori e i `pattern`. Il ramo dell'intestatario
 * digitato è NUOVO — provincia e civico arrivano dal payload invece che da
 * `parents` — e un elemento fuori posto costerebbe un numero già consumato più
 * uno scarto formale (`00102`), che arriva giorni dopo via PEC.
 *
 * Quindi qui l'XML dell'emissione vera viene dato a `xmllint` con lo XSD
 * dell'Agenzia delle Entrate, esattamente come per il tracciato reale.
 *
 * ─── E LA MISURA CHE IL CESSIONARIO RESTA UNA PERSONA FISICA ─────────────────
 * Nessun `Denominazione`, nessun `IdFiscaleIVA`: è fuori scope per decisione del
 * titolare, e si misura sul documento GENERATO, non sullo schema di ingresso —
 * perché è il documento che parte.
 *
 * ⚠️ Ambiente `node` dichiarato in testa: in jsdom questo file non misurerebbe
 * quello che dice di misurare.
 *
 * Nomi e codici fiscali SINTETICI: il repository è pubblico.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { validaFatturaPA } from './valida-xsd'

const SCUOLA = '11111111-1111-1111-1111-111111111111'
const tokenOk = { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 }

async function carica() {
  vi.resetModules()
  vi.doMock('@/lib/logging/app-log', () => ({ appLog: vi.fn(async () => {}) }))
  vi.doMock('@/lib/aruba/client', async (originale) => {
    const actual = await originale<typeof import('@/lib/aruba/client')>()
    return {
      ...actual,
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: vi.fn(async () => 2327),
      arubaUpload: vi.fn(async () => ({ ok: true, uploadFileName: 'IT_x.xml.p7m', errorCode: '0000' })),
    }
  })
  return await import('@/lib/aruba/emissione')
}

function makeSupabase(pagamento: unknown) {
  const inserts: { table: string; row: unknown }[] = []
  return {
    from(table: string) {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.limit = () => b
      b.single = async () => ({ data: table === 'pagamenti' ? pagamento : null, error: null })
      b.maybeSingle = async () => ({
        data:
          table === 'admin_settings'
            ? {
                aruba_config: {
                  username: 'utente@scuola.it',
                  password_ref: 'ARUBA_PASSWORD',
                  abilitato: true,
                  ambiente: 'demo',
                },
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
            : null,
        error: null,
      })
      b.insert = async (row: unknown) => {
        inserts.push({ table, row })
        return { error: null }
      }
      b.update = () => ({ eq: async () => ({ error: null }) })
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null })
      return b
    },
    rpc: async () => ({ data: 2328, error: null }),
    _inserts: inserts,
  }
}

const pagamento = {
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
    cognome: 'Bianchi',
    codice_fiscale: null,
    data_nascita: '2019-03-15',
    genitori_separati: false,
    retta_split_config: null,
    intestatario_fatture: null,
  },
}

beforeEach(() => {
  vi.stubEnv('ARUBA_PASSWORD', 'segretissima')
})
afterEach(() => {
  vi.doUnmock('@/lib/logging/app-log')
  vi.doUnmock('@/lib/aruba/client')
  vi.unstubAllEnvs()
  vi.resetModules()
})

/** Il solo blocco `<CessionarioCommittente>`: il cedente ha campi omonimi. */
function cessionario(xml: string): string {
  const dentro = xml.slice(xml.indexOf('<CessionarioCommittente>'), xml.indexOf('</CessionarioCommittente>'))
  expect(dentro.length, 'blocco del cessionario non trovato: la misura sotto non misurerebbe niente').toBeGreaterThan(100)
  return dentro
}

async function xmlConIntestatario(intestatarioScelto: unknown): Promise<string> {
  const { emettiFatturaPagamento } = await carica()
  const sb = makeSupabase(pagamento)
  const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' }, {
    intestatarioScelto: intestatarioScelto as never,
  })
  expect(esito.ok, 'il documento non è stato composto: non c’è niente da validare').toBe(true)
  const riga = sb._inserts.find((i) => i.table === 'fatture_emesse')?.row as { xml_inviato: string }
  return riga.xml_inviato
}

describe('il cessionario digitato a mano supera lo XSD ufficiale', () => {
  it('con provincia e civico → documento VALIDO', async () => {
    const xml = await xmlConIntestatario({
      tipo: 'persona',
      codice_fiscale: 'PRLCRL80A01H501Z',
      nome: 'Carlo',
      cognome: 'Perlini',
      indirizzo: 'Via delle Prove',
      cap: '81030',
      comune: 'Cesa',
      provincia: 'CE',
      numero_civico: '9',
    })
    const esito = await validaFatturaPA(xml)
    expect(esito.errori, esito.errori.join('\n')).toEqual([])
    expect(esito.valido).toBe(true)
  })

  it('SENZA provincia e civico (sono facoltativi) → documento ancora VALIDO', async () => {
    // Gli elementi facoltativi omessi sono la trappola tipica di `xs:sequence`:
    // un `<Provincia></Provincia>` vuoto violerebbe il `pattern [A-Z]{2}`.
    const xml = await xmlConIntestatario({
      tipo: 'persona',
      codice_fiscale: 'FBBGLI80A41H501Z',
      nome: 'Giulia',
      cognome: 'Fabbri',
      indirizzo: 'Via delle Prove',
      cap: '81030',
      comune: 'Cesa',
    })
    // Solo nel blocco del CESSIONARIO: il cedente la provincia ce l'ha, e
    // cercarla in tutto il documento misurerebbe la sede della cooperativa.
    const blocco = cessionario(xml)
    expect(blocco).not.toContain('<Provincia>')
    expect(blocco).not.toContain('<NumeroCivico>')
    const esito = await validaFatturaPA(xml)
    expect(esito.errori, esito.errori.join('\n')).toEqual([])
  })

  it('un nome con accenti e una `&` non rompono il documento', async () => {
    const xml = await xmlConIntestatario({
      tipo: 'persona',
      codice_fiscale: 'PRLCRL80A01H501Z',
      nome: 'Niccolò',
      cognome: 'Perlini',
      indirizzo: 'Via Prove & Contro',
      cap: '81030',
      comune: 'Cesa',
    })
    expect(xml).toContain('&amp;')
    const esito = await validaFatturaPA(xml)
    expect(esito.errori, esito.errori.join('\n')).toEqual([])
  })

  it('il cessionario resta una PERSONA FISICA: né `Denominazione` né `IdFiscaleIVA`', async () => {
    const xml = await xmlConIntestatario({
      tipo: 'persona',
      codice_fiscale: 'PRLCRL80A01H501Z',
      nome: 'Carlo',
      cognome: 'Perlini',
      indirizzo: 'Via delle Prove',
      cap: '81030',
      comune: 'Cesa',
    })
    const blocco = cessionario(xml)
    expect(blocco).not.toContain('Denominazione')
    expect(blocco).not.toContain('IdFiscaleIVA')
    // E il cedente invece li ha entrambi: senza questa riga, «non contiene» sarebbe
    // vero anche per un documento vuoto, o per una `slice` che ha pescato niente.
    expect(xml).toContain('<IdFiscaleIVA>')
    expect(xml).toContain('<Denominazione>')
  })
})
