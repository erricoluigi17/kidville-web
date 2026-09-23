// @vitest-environment node

/**
 * Test 8 di D1 §12 — la libreria delle orfane (`scripts/lib/fatture-orfane.mjs`).
 *
 * Dati SINTETICI: uuid finti, nomi file finti, codice fiscale palesemente finto
 * (`FINTOCODICE00001`), nomi di fantasia. La partita IVA del cedente è quella pubblica
 * della cooperativa (controllo b di D1 §9.1), non un dato personale.
 *
 * Tre parti:
 *   · funzioni pure (estrazione dall'XML, log, accoppiamento, intestatario, istruzione,
 *     maschere, cartella fuori dal repo);
 *   · l'istruzione ESEGUITA su PGlite, con lo schema preso dai file veri delle migrazioni:
 *     WORM, trigger della visibilità, indici, vincolo per sede della baseline e poi la
 *     migrazione di R1-1.1 letta dal disco;
 *   · il controllo testuale: nessuna copia del predicato in `scripts/lib/**`.
 *
 * Ogni prova ha un controllo negativo accanto: senza, non misura niente.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { buildFatturaElettronicaXml, type FatturaPAInput } from '@/lib/aruba/fatturapa-xml'
import { formattaNumeroFattura } from '@/lib/fatturazione/sezionale'
import {
  PREDICATO_SQL_PARTITA_NON_REGISTRATA,
  fatturaPartitaNonRegistrata,
} from '@/lib/pagamenti/fattura-partita-non-registrata'
import { PAGAMENTI_DEI_CASI } from '../fixtures/casi-partita-non-registrata'
import {
  DA_DECIDERE,
  MOTIVO_MIGRAZIONE_NON_APPLICATA,
  PARTITA_IVA_CEDENTE,
  RE_NUMERO_NEL_LOG,
  SQL_VINCOLO_PER_SEDE,
  VINCOLO_NUMERO_PER_SEDE,
  VoceNonValida,
  accoppiaOrfane,
  componiInsert,
  datiDaLog,
  estraiCampiXml,
  fuoriDalRepository,
  leggiNumeroFattura,
  maschera,
  mascheraCf,
  mascheraNome,
  mascheraTesto,
  risolviIntestatario,
  verdettoVincolo,
} from '../../scripts/lib/fatture-orfane.mjs'

const RADICE = process.cwd()
const MIGRAZIONI = join(RADICE, 'supabase/migrations')

/* ────────────────────────────────────────────────────────────────────────────
 * Dati finti
 * ──────────────────────────────────────────────────────────────────────────── */

const SEDE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SEDE_ALTRA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SEDE_PROVA_CI = 'e2e00000-0000-4000-8000-000000000001'
const PAG = '11111111-1111-4111-8111-111111111111'
const PAG_2 = '22222222-2222-4222-8222-222222222222'
const PAG_3 = '33333333-3333-4333-8333-333333333333'
const LOG_ID = '44444444-4444-4444-8444-444444444444'
const LOG_ID_2 = '55555555-5555-4555-8555-555555555555'
const UTENTE = '66666666-6666-4666-8666-666666666666'
const ADULTO = '77777777-7777-4777-8777-777777777777'
const GENITORE = '88888888-8888-4888-8888-888888888888'
const GENITORE_2 = '99999999-9999-4999-8999-999999999999'

const FILE = 'IT03394870616_f1a2b.xml.p7m'
const FILE_2 = 'IT03394870616_c3d4e.xml.p7m'
const CF_FINTO = 'FINTOCODICE00001'
const NOME = 'Nome Finto'
const COGNOME = "D'Esempio"
const DESCRIZIONE = 'Retta & mensa <settembre>'
const ISTANTE = '2026-09-22T12:11:52.000Z'

function inputXml(sovrascrivi: Partial<FatturaPAInput> = {}): FatturaPAInput {
  return {
    progressivoInvio: 'F26002541',
    numero: formattaNumeroFattura('FPR', 2541, 2026),
    data: '2026-09-22',
    cedente: {
      piva: PARTITA_IVA_CEDENTE,
      codiceFiscale: PARTITA_IVA_CEDENTE,
      denominazione: 'Cooperativa di prova',
      regimeFiscale: 'RF01',
      sede: { indirizzo: 'Via Finta 1', cap: '00000', comune: 'Paese Finto', provincia: 'XX', nazione: 'IT' },
    },
    cessionario: {
      codiceFiscale: CF_FINTO,
      nome: NOME,
      cognome: COGNOME,
      sede: { indirizzo: 'Via Inventata 2', cap: '00000', comune: 'Paese Finto', provincia: 'XX', nazione: 'IT' },
    },
    righe: [{ descrizione: DESCRIZIONE, prezzoUnitario: 150 }],
    bollo: { importo: 2 },
    pagamento: { dataScadenza: '2026-09-30' },
    ...sovrascrivi,
  }
}

const XML = buildFatturaElettronicaXml(inputXml())

function voceBase(sovrascrivi: Record<string, unknown> = {}) {
  return {
    pagamento_id: PAG,
    scuola_id: SEDE,
    file: FILE,
    sezionale: 'FPR',
    anno: 2026,
    numero: 2541,
    progressivo_invio: 'F26002541',
    causale: DESCRIZIONE,
    importo: '150.00',
    intestatario: { nome: NOME, cognome: COGNOME, codice_fiscale: CF_FINTO },
    xml: XML,
    istante: ISTANTE,
    quota_adult_id: ADULTO,
    parent_registry_id: GENITORE,
    bollo_virtuale: true,
    app_log_id: LOG_ID,
    emessa_da: UTENTE,
    vincolo: VINCOLO_NUMERO_PER_SEDE,
    ...sovrascrivi,
  }
}

const OPZIONI = { predicatoSql: PREDICATO_SQL_PARTITA_NON_REGISTRATA, giornaleEsiste: false }

/** Il messaggio che `emissione.ts` scrive oggi per un 23505 dopo l'upload. */
function rigaLog(sovrascrivi: Record<string, unknown> = {}) {
  const msg =
    'DOPPIA EMISSIONE: la fattura FPR 2541/26 è partita verso Aruba (' + FILE + ') ma il registro ' +
    "l'ha RIFIUTATA perché per questa quota (o per questo numero) esisteva già un documento."
  return {
    id: LOG_ID,
    messaggio: msg,
    utente_id: UTENTE,
    scuola_id: SEDE,
    contesto: {
      campi: { operazione: 'emettiFatturaPagamento', esito: 'registro-doppione-rifiutato', numero: 2541, anno: 2026 },
      causa: {
        codice: '23505',
        messaggio: `duplicate key value violates unique constraint "${VINCOLO_NUMERO_PER_SEDE}"`,
      },
    },
    ...sovrascrivi,
  }
}

function pagamento(sovrascrivi: Record<string, unknown> = {}) {
  return {
    id: PAG,
    scuola_id: SEDE,
    fattura_stato: 'in_attesa',
    fattura_aruba_id: FILE,
    fattura_emessa_il: ISTANTE,
    ...sovrascrivi,
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * estraiCampiXml
 * ──────────────────────────────────────────────────────────────────────────── */

describe('estraiCampiXml — tracciato di buildFatturaElettronicaXml', () => {
  it('estrae tutti i campi di D1 §9.1 punto 4, con le entità decodificate', () => {
    const esito = estraiCampiXml(XML)
    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    expect(esito.campi).toEqual({
      progressivoInvio: 'F26002541',
      tipoDocumento: 'TD01',
      data: '2026-09-22',
      numero: 'FPR 2541/26',
      importoTotaleDocumento: '150.00',
      importoPagamento: '150.00',
      bolloVirtuale: true,
      cedenteIdCodice: PARTITA_IVA_CEDENTE,
      cessionario: { codiceFiscale: CF_FINTO, nome: NOME, cognome: COGNOME },
      descrizione: DESCRIZIONE,
    })
    // Controllo che l'XML porti davvero le entità: senza, «decodificate» non proverebbe niente.
    expect(XML).toContain('Retta &amp; mensa &lt;settembre&gt;')
    expect(XML).toContain('D&apos;Esempio')
  })

  it("l'IdCodice è quello del CEDENTE, non quello di IdTrasmittente (Aruba)", () => {
    const esito = estraiCampiXml(XML)
    expect(XML).toContain('<IdCodice>01879020517</IdCodice>')
    expect(esito.ok && esito.campi.cedenteIdCodice).toBe(PARTITA_IVA_CEDENTE)
  })

  it('senza bollo e senza DatiPagamento: bollo falso e ImportoPagamento nullo', () => {
    const esito = estraiCampiXml(buildFatturaElettronicaXml(inputXml({ bollo: undefined, pagamento: undefined })))
    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    expect(esito.campi.bolloVirtuale).toBe(false)
    expect(esito.campi.importoPagamento).toBeNull()
  })

  it('decodifica i riferimenti numerici', () => {
    const xml = XML.replace('<Nome>Nome Finto</Nome>', '<Nome>Ren&#233; &#x41;</Nome>')
    const esito = estraiCampiXml(xml)
    expect(esito.ok && esito.campi.cessionario.nome).toBe('René A')
  })

  it('più di un FatturaElettronicaBody → rifiuto', () => {
    const corpo = /<FatturaElettronicaBody>[\s\S]*<\/FatturaElettronicaBody>/.exec(XML)![0]
    const due = XML.replace(corpo, corpo + '\n' + corpo)
    const esito = estraiCampiXml(due)
    expect(esito).toEqual({ ok: false, motivo: expect.stringMatching(/più di un FatturaElettronicaBody/) })
  })

  it('rifiuta DOCTYPE, CDATA, entità sconosciute, & nudo, campi ripetuti, due righe di dettaglio', () => {
    const casi: Array<[string, string, RegExp]> = [
      ['doctype', XML.replace('<?xml version="1.0" encoding="UTF-8"?>', '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e "x">]>'), /DOCTYPE/],
      ['cdata', XML.replace('<Nome>Nome Finto</Nome>', '<Nome><![CDATA[Nome]]></Nome>'), /CDATA/],
      ['entità', XML.replace('<Nome>Nome Finto</Nome>', '<Nome>Nome&nbsp;Finto</Nome>'), /entità sconosciuta/],
      ['& nudo', XML.replace('<Nome>Nome Finto</Nome>', '<Nome>Nome & Finto</Nome>'), /&/],
      ['numero ripetuto', XML.replace('<Numero>FPR 2541/26</Numero>', '<Numero>FPR 2541/26</Numero><Numero>FPR 2542/26</Numero>'), /ripetuto: Numero/],
      ['due linee', XML.replace(/(<DettaglioLinee>[\s\S]*?<\/DettaglioLinee>)/, '$1$1'), /righe di dettaglio: 2/],
      ['vuoto', '', /vuoto/],
    ]
    for (const [nome, xml, motivo] of casi) {
      const esito = estraiCampiXml(xml)
      expect(esito.ok, nome).toBe(false)
      if (!esito.ok) expect(esito.motivo, nome).toMatch(motivo)
    }
  })

  it('campo obbligatorio mancante → rifiuto, mai un valore indovinato', () => {
    const esito = estraiCampiXml(XML.replace(/<ProgressivoInvio>[^<]*<\/ProgressivoInvio>/, ''))
    expect(esito).toEqual({ ok: false, motivo: 'campo mancante: ProgressivoInvio' })
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * Numero e log
 * ──────────────────────────────────────────────────────────────────────────── */

describe('leggiNumeroFattura e datiDaLog', () => {
  it('rilegge ogni forma di formattaNumeroFattura (FPR con anno a due cifre)', () => {
    for (const [s, n] of [['Asilo', 2524], ['FPR', 2525], ['FPR', 1], ['Asilo', 123456789]] as const) {
      expect(leggiNumeroFattura(formattaNumeroFattura(s, n, 2026))).toMatchObject({ sezionale: s, numero: n, anno: 2026 })
    }
    expect(leggiNumeroFattura('FPR 0/26')).toBeNull()
    expect(leggiNumeroFattura('Altro 5/2026')).toBeNull()
  })

  it('la regex cattura «FPR 2525/2026» per intero, anno compreso', () => {
    const d = datiDaLog(rigaLog({ messaggio: `fattura FPR 2525/2026 inviata ad Aruba (${FILE}) ma NON scritta a registro` }))
    expect(d.numero).toEqual({ sezionale: 'FPR', numero: 2525, anno: 2026, testo: 'FPR 2525/2026' })
    // Negativo: una regex che si ferma a due cifre dopo la barra ne prende un pezzo.
    const troncata = /((?:Asilo|FPR) [0-9]+\/[0-9]{2})/.exec('FPR 2525/2026')![1]
    expect(troncata).toBe('FPR 2525/20')
    expect(RE_NUMERO_NEL_LOG.exec('FPR 2525/2026')![1]).toBe('FPR 2525/2026')
  })

  it('ricava file, numero, vincolo, utente e id dal log di un 23505', () => {
    expect(datiDaLog(rigaLog())).toEqual({
      app_log_id: LOG_ID,
      esito: 'registro-doppione-rifiutato',
      file: FILE,
      fileAmbiguo: false,
      numero: { sezionale: 'FPR', numero: 2541, anno: 2026, testo: 'FPR 2541/26' },
      vincolo: VINCOLO_NUMERO_PER_SEDE,
      utente_id: UTENTE,
      scuola_id: SEDE,
    })
  })

  it('vincolo non riconosciuto → null; due file nel messaggio → ambiguo', () => {
    const ignoto = datiDaLog(rigaLog({ contesto: { campi: {}, causa: { messaggio: 'violates unique constraint "altro_vincolo"' } } }))
    expect(ignoto.vincolo).toBeNull()
    const due = datiDaLog(rigaLog({ messaggio: `file ${FILE} e ${FILE_2}` }))
    expect(due.file).toBeNull()
    expect(due.fileAmbiguo).toBe(true)
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * accoppiaOrfane
 * ──────────────────────────────────────────────────────────────────────────── */

describe('accoppiaOrfane — scoperta e parità SQL/TS per voce', () => {
  const base = {
    candidatiSql: [pagamento()],
    righe: [] as Array<{ pagamento_id: string; sdi_stato: number | null; aruba_filename: string | null }>,
    log: [rigaLog()],
    pagamentiConInvio: null as string[] | null,
    predicato: fatturaPartitaNonRegistrata,
  }

  it("un'orfana pura col suo log è pronta, e porta con sé chi l'aveva emessa", () => {
    const esito = accoppiaOrfane(base)
    expect(esito.daDecidere).toBe(0)
    expect(esito.voci).toHaveLength(1)
    expect(esito.voci[0]).toMatchObject({ pagamento_id: PAG, file: FILE, stato: 'pronta', motivi: [] })
    expect(esito.voci[0].log).toMatchObject({ app_log_id: LOG_ID, utente_id: UTENTE, vincolo: VINCOLO_NUMERO_PER_SEDE })
    expect(esito.logSenzaOrfana).toEqual([])
  })

  it('una voce con un invio della coda → DA DECIDERE: la registra la coda', () => {
    const esito = accoppiaOrfane({ ...base, pagamentiConInvio: [PAG] })
    expect(esito.voci[0].stato).toBe('da_decidere')
    expect(esito.voci[0].motivi).toContain(DA_DECIDERE.laRegistraLaCoda)
    // Negativo: giornale presente ma senza invii del pagamento → pronta.
    expect(accoppiaOrfane({ ...base, pagamentiConInvio: [PAG_2] }).voci[0].stato).toBe('pronta')
  })

  it('SQL e TS in disaccordo su un caso sintetico → DA DECIDERE (lo script esce con 2)', () => {
    // L'SQL (sintetico) restituisce un pagamento che ha già la riga del suo file: il TS dice falso.
    const esito = accoppiaOrfane({ ...base, righe: [{ pagamento_id: PAG, sdi_stato: 1, aruba_filename: FILE }] })
    expect(esito.voci[0].motivi).toContain(DA_DECIDERE.predicatiDiscordi)
    expect(esito.daDecidere).toBe(1)
    // Il verso opposto: un pagamento nominato dal log, fuori dall'SQL, che il TS dà vero.
    const opposto = accoppiaOrfane({ ...base, candidatiSql: [], pagamentiDeiLog: [pagamento()] })
    expect(opposto.voci).toHaveLength(1)
    expect(opposto.voci[0].motivi).toEqual([DA_DECIDERE.predicatiDiscordi])
    // …e se il TS lo dà falso (già registrato) il log resta solo «senza orfana».
    const registrato = accoppiaOrfane({
      ...base,
      candidatiSql: [],
      pagamentiDeiLog: [pagamento({ fattura_stato: 'emessa' })],
    })
    expect(registrato.voci).toEqual([])
    expect(registrato.logSenzaOrfana).toEqual([{ app_log_id: LOG_ID, file: FILE, esito: 'registro-doppione-rifiutato' }])
  })

  it('più log sullo stesso pagamento → DA DECIDERE; nessun log → solo un avviso', () => {
    const due = accoppiaOrfane({ ...base, log: [rigaLog(), rigaLog({ id: LOG_ID_2 })] })
    expect(due.voci[0].motivi).toContain(DA_DECIDERE.piuLog)
    const nessuno = accoppiaOrfane({ ...base, log: [] })
    expect(nessuno.voci[0].stato).toBe('pronta')
    expect(nessuno.voci[0].avvisi).toEqual(['nessun log di registro con questo nome file'])
  })

  it('log di un altro file → segnalato come log senza orfana', () => {
    const esito = accoppiaOrfane({ ...base, log: [rigaLog(), rigaLog({ id: LOG_ID_2, messaggio: `fattura FPR 9/26 (${FILE_2})` })] })
    expect(esito.logSenzaOrfana).toEqual([{ app_log_id: LOG_ID_2, file: FILE_2, esito: 'registro-doppione-rifiutato' }])
    expect(esito.avvisi).toEqual(["1 log di registro senza un'orfana"])
  })

  it('righe a registro, nome file non valido, sede del log diversa → DA DECIDERE', () => {
    const conRiga = accoppiaOrfane({ ...base, righe: [{ pagamento_id: PAG, sdi_stato: 2, aruba_filename: FILE_2 }] })
    expect(conRiga.voci[0].motivi).toEqual([DA_DECIDERE.righeARegistro])
    const senzaFile = accoppiaOrfane({ ...base, candidatiSql: [pagamento({ fattura_aruba_id: null })] })
    expect(senzaFile.voci[0].motivi).toContain(DA_DECIDERE.fileNonValido)
    const altraSede = accoppiaOrfane({ ...base, log: [rigaLog({ scuola_id: SEDE_ALTRA })] })
    expect(altraSede.voci[0].motivi).toEqual([DA_DECIDERE.sedeDelLog])
  })

  it('la sede fittizia della CI è esclusa; le voci escono in ordine di emissione', () => {
    const esito = accoppiaOrfane({
      ...base,
      log: [],
      candidatiSql: [
        pagamento({ id: PAG_2, fattura_aruba_id: FILE_2, fattura_emessa_il: '2026-09-22T12:00:00.000Z' }),
        pagamento({ id: PAG_3, scuola_id: SEDE_PROVA_CI }),
        pagamento({ fattura_emessa_il: '2026-09-21T08:00:00.000Z' }),
      ],
    })
    expect(esito.esclusi).toBe(1)
    expect(esito.voci.map((v) => v.pagamento_id)).toEqual([PAG, PAG_2])
  })

  it('senza il predicato TS non accoppia niente', () => {
    expect(() => accoppiaOrfane({ ...base, predicato: undefined as never })).toThrow(/predicato TS/)
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * risolviIntestatario
 * ──────────────────────────────────────────────────────────────────────────── */

describe('risolviIntestatario — casi (i)-(iv) di D1 §9.2', () => {
  const adulto = { adult_id: ADULTO, parent_id: GENITORE, codice_fiscale: CF_FINTO }

  it('(i) un adulto del bambino con quel CF → i suoi due id', () => {
    expect(risolviIntestatario({ codiceFiscale: ' fintocodice00001 ', adulti: [adulto] })).toEqual({
      esito: 'risolto', caso: 'i', quota_adult_id: ADULTO, parent_registry_id: GENITORE,
    })
  })

  it('(ii) nessun adulto, un solo parents con quel CF → il suo id', () => {
    expect(
      risolviIntestatario({ codiceFiscale: CF_FINTO, adulti: [{ ...adulto, codice_fiscale: 'ALTROCODICE00002' }], genitori: [{ id: GENITORE_2, codice_fiscale: CF_FINTO }] }),
    ).toEqual({ esito: 'risolto', caso: 'ii', quota_adult_id: GENITORE_2, parent_registry_id: GENITORE_2 })
  })

  it('(iii) intestatario «altro» senza anagrafica → NULL e NULL', () => {
    expect(risolviIntestatario({ codiceFiscale: CF_FINTO, origine: 'altro' })).toEqual({
      esito: 'risolto', caso: 'iii', quota_adult_id: null, parent_registry_id: null,
    })
  })

  it('(iv) nessuna corrispondenza, oppure più di una → DA DECIDERE', () => {
    expect(risolviIntestatario({ codiceFiscale: CF_FINTO, origine: 'genitore' })).toMatchObject({ esito: 'da_decidere', caso: 'iv' })
    expect(
      risolviIntestatario({ codiceFiscale: CF_FINTO, adulti: [adulto, { adult_id: GENITORE_2, parent_id: GENITORE_2, codice_fiscale: CF_FINTO }] }),
    ).toMatchObject({ esito: 'da_decidere', caso: 'iv' })
    expect(
      risolviIntestatario({ codiceFiscale: CF_FINTO, genitori: [{ id: GENITORE, codice_fiscale: CF_FINTO }, { id: GENITORE_2, codice_fiscale: CF_FINTO }] }),
    ).toMatchObject({ esito: 'da_decidere', caso: 'iv' })
    expect(risolviIntestatario({ codiceFiscale: '' })).toMatchObject({ esito: 'da_decidere', caso: 'iv' })
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * componiInsert e maschere (puro)
 * ──────────────────────────────────────────────────────────────────────────── */

describe('componiInsert — validazioni, tag, stampa', () => {
  it('rifiuta ogni campo non valido, nominandolo', () => {
    const cattivi: Array<[string, Record<string, unknown>]> = [
      ['pagamento_id', { pagamento_id: "x'; drop table pagamenti; --" }],
      ['scuola_id', { scuola_id: null }],
      ['quota_adult_id', { quota_adult_id: 'non-un-uuid' }],
      ['emessa_da', { emessa_da: 42 }],
      ['sezionale', { sezionale: 'Nido' }],
      ['anno', { anno: 26 }],
      ['numero', { numero: 25.5 }],
      ['numero', { numero: '2541' }],
      ['importo', { importo: '150' }],
      ['importo', { importo: 150 }],
      ['istante', { istante: '22/09/2026' }],
      ['istante', { istante: '2026-09-22T12:11:52' }],
      ['file', { file: "IT03394870616_f1a2b.xml.p7m'" }],
      ['progressivo_invio', { progressivo_invio: 'F2600254' }],
      ['bollo_virtuale', { bollo_virtuale: 'SI' }],
      ['vincolo', { vincolo: 'inventato' }],
      ['codice_fiscale', { intestatario: { nome: NOME, cognome: COGNOME, codice_fiscale: "FINTO'CODICE" } }],
      ['codice_fiscale', { intestatario: { nome: NOME, cognome: COGNOME, codice_fiscale: 'fintocodice00001' } }],
      ['nome', { intestatario: { nome: ' ', cognome: COGNOME, codice_fiscale: CF_FINTO } }],
      ['causale', { causale: 'con\u0000nul' }],
    ]
    for (const [campo, rotto] of cattivi) {
      let errore: unknown = null
      try {
        componiInsert(voceBase(rotto), OPZIONI)
      } catch (e) {
        errore = e
      }
      expect(errore, JSON.stringify(rotto)).toBeInstanceOf(VoceNonValida)
      expect((errore as { campo: string }).campo, JSON.stringify(rotto)).toBe(campo)
    }
    // Negativo: la voce base passa.
    expect(() => componiInsert(voceBase(), OPZIONI)).not.toThrow()
  })

  it('senza il predicato del modulo, o senza dire se il giornale esiste, non compone', () => {
    expect(() => componiInsert(voceBase(), { giornaleEsiste: false } as never)).toThrow(/predicatoSql/)
    expect(() => componiInsert(voceBase(), { predicatoSql: PREDICATO_SQL_PARTITA_NON_REGISTRATA } as never)).toThrow(/giornaleEsiste/)
  })

  it('il predicato entra nella CTE così com’è, dal modulo', () => {
    const { sql } = componiInsert(voceBase(), OPZIONI)
    expect(sql).toContain(`AND (${PREDICATO_SQL_PARTITA_NON_REGISTRATA})`)
  })

  it('il tag che collide con un testo si scarta; se collidono tutti, niente istruzione', () => {
    const tags = ['tcollide', 'tlibero']
    const { sql, tag } = componiInsert(voceBase({ causale: 'testo con $tcollide$ dentro' }), {
      ...OPZIONI,
      generaTag: () => tags.shift()!,
    })
    expect(tag).toBe('tlibero')
    expect(sql).toContain('$tlibero$testo con $tcollide$ dentro$tlibero$')
    expect(() =>
      componiInsert(voceBase({ xml: XML + '<!-- $tsempre$ -->' }), { ...OPZIONI, generaTag: () => 'tsempre' }),
    ).toThrow(/nessun tag libero/)
    // Un testo che FINISCE con `$tag` (senza il `$` finale) collide lo stesso: il suo `$`
    // più il `$` di chiusura formano `$tag$` e chiudono la stringa in anticipo, troncando
    // la causale in silenzio. Il tag va scartato anche qui.
    const tagsCoda = ['tfisso', 'taltro']
    const coda = componiInsert(voceBase({ causale: 'retta $tfisso' }), {
      ...OPZIONI,
      generaTag: () => tagsCoda.shift()!,
    })
    expect(coda.tag).toBe('taltro')
    expect(coda.sql).toContain('$taltro$retta $tfisso$taltro$')
    expect(coda.sql).not.toContain('$tfisso$retta')
    expect(() =>
      componiInsert(voceBase({ causale: 'retta $tfisso' }), { ...OPZIONI, generaTag: () => 'tfisso' }),
    ).toThrow(/nessun tag libero/)
    // Il tag di default è casuale: due composizioni, due tag.
    expect(componiInsert(voceBase(), OPZIONI).tag).not.toBe(componiInsert(voceBase(), OPZIONI).tag)
  })

  it('creato_da NULL = sistema; audit con utente_id NULL ed emessa_da dal log', () => {
    const { sql } = componiInsert(voceBase(), OPZIONI)
    expect(sql).toMatch(/'Presa in carico', '2026-09-22T12:11:52\.000Z'::timestamptz, NULL, '2026-09-22T12:11:52\.000Z'::timestamptz/)
    expect(sql).toMatch(/SELECT NULL, 'registrazione_fattura_orfana', 'fatture_emesse', ins\.id/)
    expect(sql).toContain(`'emessa_da', '${UTENTE}'::text`)
    expect(sql).not.toMatch(/UPDATE\s+public\.pagamenti/i)
  })

  it('la clausola sul giornale c’è solo se la tabella esiste', () => {
    expect(componiInsert(voceBase(), OPZIONI).sql).not.toContain('fatture_coda_invii')
    expect(componiInsert(voceBase(), { ...OPZIONI, giornaleEsiste: true }).sql).toContain(
      'NOT EXISTS (SELECT 1 FROM public.fatture_coda_invii i WHERE i.pagamento_id = p.id)',
    )
  })

  it('la stampa non contiene CF, nomi, causale né XML; li contiene solo l’istruzione vera', () => {
    const { sql, sqlMascherato } = componiInsert(voceBase(), { ...OPZIONI, anagrafica: { nome: 'nome finto', cognome: 'Altro' } })
    for (const segreto of [CF_FINTO, NOME, COGNOME, DESCRIZIONE, '<FatturaElettronicaBody>']) {
      expect(sql, segreto).toContain(segreto)
      expect(sqlMascherato, segreto).not.toContain(segreto)
    }
    expect(sqlMascherato).toContain("'FIN…(16)'")
    expect(sqlMascherato).toContain("presente, 10 caratteri; coincide con l'anagrafica: sì")
    expect(sqlMascherato).toContain("presente, 9 caratteri; coincide con l'anagrafica: no")
    expect(sqlMascherato).toMatch(/<\d+ byte, sha256 [0-9a-f]{16}…>/)
  })

  it('maschere: CF come ABC…(16), nomi solo come lunghezza, testi come byte e impronta', () => {
    expect(mascheraCf(CF_FINTO)).toBe('FIN…(16)')
    expect(mascheraCf('')).toBe('(assente)')
    expect(mascheraNome(NOME)).toBe("presente, 10 caratteri; coincide con l'anagrafica: non verificato")
    expect(mascheraTesto('àb')).toMatch(/^<3 byte, sha256 [0-9a-f]{16}…>$/)
    const m = maschera({ intestatario: { nome: NOME, cognome: COGNOME, codice_fiscale: CF_FINTO }, causale: DESCRIZIONE, xml: XML })
    expect(JSON.stringify(m)).not.toMatch(new RegExp([CF_FINTO, NOME, 'Esempio', 'settembre'].join('|')))
  })
})

describe('fuoriDalRepository', () => {
  it('la radice e le sue sottocartelle sono dentro; fratelli e /tmp sono fuori', () => {
    expect(fuoriDalRepository(RADICE)).toBe(false)
    expect(fuoriDalRepository(join(RADICE, 'scripts', 'nuova-cartella'))).toBe(false)
    expect(fuoriDalRepository(`${RADICE}-aruba`)).toBe(true)
    expect(fuoriDalRepository(join(tmpdir(), 'orfane'))).toBe(true)
    expect(fuoriDalRepository('')).toBe(false)
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * PGlite: lo schema dai file veri delle migrazioni
 * ──────────────────────────────────────────────────────────────────────────── */

function leggiMigrazione(nome: string): string {
  return readFileSync(join(MIGRAZIONI, nome), 'utf8')
}

/** Un pezzo di una migrazione, trovato per forma: se la forma cambia, il test lo dice. */
function estrai(testo: string, re: RegExp, cosa: string): string {
  const m = re.exec(testo)
  if (!m) throw new Error(`pezzo di schema non trovato: ${cosa}`)
  return m[0]
}

const BASELINE = leggiMigrazione('20260704120000_baseline.sql')
const SEZIONALE = leggiMigrazione('20260809235620_fatture_numerazione_sezionale.sql')
const WORM = leggiMigrazione('20260711150000_worm_registri_fiscali.sql')
const VISIBILITA = leggiMigrazione('20260916120000_fatture_visibilita_snapshot.sql')
const FILE_MIGRAZIONE_R1 = readdirSync(MIGRAZIONI).filter((n) => n.endsWith('_fatture_emesse_senza_vincolo_numero_per_sede.sql'))
const MIGRAZIONE_R1 = FILE_MIGRAZIONE_R1.length === 1 ? leggiMigrazione(FILE_MIGRAZIONE_R1[0]) : ''

const SCHEMA = [
  estrai(BASELINE, /CREATE TYPE public\.fattura_stato AS ENUM \([^)]*\);/, 'enum fattura_stato'),
  `CREATE TABLE public.pagamenti (
     id uuid PRIMARY KEY, scuola_id uuid NOT NULL,
     fattura_stato public.fattura_stato DEFAULT 'non_richiesta'::public.fattura_stato NOT NULL,
     fattura_aruba_id character varying(255), fattura_emessa_il timestamptz);`,
  estrai(BASELINE, /CREATE TABLE public\.fatture_emesse \([\s\S]*?\n\);/, 'tabella fatture_emesse'),
  `ALTER TABLE ONLY public.fatture_emesse ADD CONSTRAINT fatture_emesse_pkey PRIMARY KEY (id);`,
  estrai(BASELINE, /ALTER TABLE ONLY public\.fatture_emesse\s+ADD CONSTRAINT fatture_emesse_scuola_id_anno_numero_key UNIQUE \(scuola_id, anno, numero\);/, 'vincolo per sede'),
  `ALTER TABLE public.fatture_emesse ADD COLUMN bollo_virtuale boolean NOT NULL DEFAULT false;
   ALTER TABLE public.fatture_emesse ADD COLUMN sezionale text;
   ALTER TABLE public.fatture_emesse ADD COLUMN modalita_emissione text;`,
  estrai(SEZIONALE, /CREATE UNIQUE INDEX IF NOT EXISTS fatture_emesse_sezionale_anno_numero_uidx[\s\S]*?;/, 'indice per serie'),
  estrai(SEZIONALE, /CREATE UNIQUE INDEX IF NOT EXISTS fatture_emesse_pagamento_quota_uidx[\s\S]*?;/, 'indice per quota'),
  estrai(SEZIONALE, /CREATE OR REPLACE FUNCTION public\.worm_fatture_emesse\(\)[\s\S]*?END \$\$;/, 'funzione WORM'),
  estrai(WORM, /CREATE TRIGGER trg_worm_fatture_emesse[\s\S]*?;/, 'trigger WORM'),
  `CREATE TABLE public.admin_settings (scuola_id uuid PRIMARY KEY);`,
  estrai(VISIBILITA, /ALTER TABLE public\.admin_settings\s+ADD COLUMN IF NOT EXISTS fatture_visibilita_attiva_il timestamptz;/, 'colonna visibilità'),
  estrai(VISIBILITA, /CREATE OR REPLACE FUNCTION public\.fatture_visibilita_snapshot_guard\(\)[\s\S]*?END \$\$;/, 'funzione visibilità'),
  estrai(VISIBILITA, /CREATE TRIGGER trg_fatture_visibilita_snapshot_guard[\s\S]*?;/, 'trigger visibilità'),
  `CREATE TABLE public.registro_modifiche (
     id bigserial PRIMARY KEY, utente_id uuid, azione text NOT NULL,
     tabella_interessata character varying(100), record_id uuid,
     vecchio_valore jsonb, nuovo_valore jsonb, indirizzo_ip inet,
     creato_il timestamp with time zone DEFAULT CURRENT_TIMESTAMP);`,
].join('\n')

const aperti: PGlite[] = []
afterEach(async () => {
  while (aperti.length > 0) await aperti.pop()!.close()
})

async function nuovoDb({ migrato = true } = {}): Promise<PGlite> {
  const db = new PGlite()
  aperti.push(db)
  await db.exec(SCHEMA)
  if (migrato) await db.exec(MIGRAZIONE_R1)
  await db.exec(`INSERT INTO public.admin_settings (scuola_id) VALUES ('${SEDE}');`)
  return db
}

async function semina(db: PGlite, p: { id?: string; stato?: string; file?: string | null } = {}) {
  const file = p.file === undefined ? FILE : p.file
  await db.exec(
    `INSERT INTO public.pagamenti (id, scuola_id, fattura_stato, fattura_aruba_id, fattura_emessa_il)
     VALUES ('${p.id ?? PAG}', '${SEDE}', '${p.stato ?? 'in_attesa'}', ${file === null ? 'NULL' : `'${file}'`}, '${ISTANTE}');`,
  )
}

/** Una riga a registro scritta come la scrive l'app (con la modalità). */
function rigaRegistro(r: { pagamento: string; sezionale: string; numero: number; sdi?: number; file?: string }) {
  return `INSERT INTO public.fatture_emesse (pagamento_id, scuola_id, numero, sezionale, anno, importo, sdi_stato, aruba_filename, modalita_emissione)
          VALUES ('${r.pagamento}', '${SEDE}', ${r.numero}, '${r.sezionale}', 2026, 10, ${r.sdi ?? 1}, ${r.file ? `'${r.file}'` : 'NULL'}, 'ordinaria');`
}

type EsitoInsert = { registrate: number; audit: number; fattura_id: string | null; audit_id: string | null }

async function esegui(db: PGlite, sql: string): Promise<EsitoInsert> {
  const risultati = await db.exec(sql)
  return risultati[risultati.length - 1].rows[0] as unknown as EsitoInsert
}

async function conta(db: PGlite, tabella: string): Promise<number> {
  const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${tabella}`)
  return r.rows[0].n
}

async function verdetto(db: PGlite) {
  return verdettoVincolo((await db.query(SQL_VINCOLO_PER_SEDE)).rows)
}

describe('componiInsert eseguita su PGlite (WORM, visibilità, precondizioni)', () => {
  it('lo schema viene davvero dai file, e la migrazione di R1-1.1 è una sola', () => {
    expect(FILE_MIGRAZIONE_R1).toHaveLength(1)
    expect(MIGRAZIONE_R1).toMatch(/DROP CONSTRAINT IF EXISTS fatture_emesse_scuola_id_anno_numero_key/)
  })

  it('tabella col vincolo per sede come nella baseline → «migrazione non applicata», e nessuna riga', async () => {
    const db = await nuovoDb({ migrato: false })
    await semina(db)
    // La collisione vera: la Asilo 2541 della stessa sede c'è già.
    await semina(db, { id: PAG_2, stato: 'emessa', file: FILE_2 })
    await db.exec(rigaRegistro({ pagamento: PAG_2, sezionale: 'Asilo', numero: 2541, file: FILE_2 }))

    expect(await verdetto(db)).toMatchObject({ ok: false, motivo: MOTIVO_MIGRAZIONE_NON_APPLICATA })
    // Anche se lo script ignorasse il verdetto, l'istruzione non scrive e non lancia un 23505.
    expect(await esegui(db, componiInsert(voceBase(), OPZIONI).sql)).toMatchObject({ registrate: 0, audit: 0 })
    expect(await conta(db, 'fatture_emesse')).toBe(1)

    // Dopo il file di R1-1.1, letto dal disco: procede.
    await db.exec(MIGRAZIONE_R1)
    expect(await verdetto(db)).toEqual({ ok: true })
    expect(await esegui(db, componiInsert(voceBase(), OPZIONI).sql)).toMatchObject({ registrate: 1, audit: 1 })
  })

  it('verdettoVincolo è fail-closed su una lettura malformata', () => {
    expect(verdettoVincolo([])).toMatchObject({ ok: false })
    expect(verdettoVincolo([{ n: '0' }])).toMatchObject({ ok: false })
    expect(verdettoVincolo(null)).toMatchObject({ ok: false })
  })

  it('prima esecuzione 1+1, seconda 0: la riga ha la forma di D1 §9.2', async () => {
    const db = await nuovoDb()
    await semina(db)
    const { sql } = componiInsert(voceBase(), OPZIONI)

    const prima = await esegui(db, sql)
    expect(prima).toMatchObject({ registrate: 1, audit: 1 })
    expect(prima.fattura_id).toMatch(/^[0-9a-f-]{36}$/)

    const riga = (await db.query<Record<string, unknown>>(`SELECT * FROM public.fatture_emesse WHERE id = '${prima.fattura_id}'`)).rows[0]
    expect(riga).toMatchObject({
      pagamento_id: PAG, scuola_id: SEDE, numero: 2541, sezionale: 'FPR', anno: 2026,
      progressivo_invio: 'F26002541', causale: DESCRIZIONE, importo: '150.00',
      intestatario: { nome: NOME, cognome: COGNOME, codice_fiscale: CF_FINTO },
      xml_inviato: XML, aruba_filename: FILE, sdi_stato: 1, sdi_stato_label: 'Presa in carico',
      creato_da: null, quota_adult_id: ADULTO, quota_label: null, parent_registry_id: GENITORE,
      modalita_emissione: 'ordinaria', bollo_virtuale: true,
    })
    expect(new Date(riga.inviata_il as string).toISOString()).toBe(ISTANTE)
    expect(new Date(riga.creato_il as string).toISOString()).toBe(ISTANTE)

    const audit = (await db.query<Record<string, unknown>>('SELECT * FROM public.registro_modifiche')).rows
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      utente_id: null, azione: 'registrazione_fattura_orfana', tabella_interessata: 'fatture_emesse',
      record_id: prima.fattura_id,
      vecchio_valore: { pagamento_id: PAG, riga_a_registro: false },
      nuovo_valore: {
        pagamento_id: PAG, sezionale: 'FPR', anno: 2026, numero: 2541, aruba_filename: FILE,
        app_log_id: LOG_ID, emessa_da: UTENTE, causa: VINCOLO_NUMERO_PER_SEDE, strumento: 'scripts/fatture-orfane.mjs',
      },
    })

    // Seconda esecuzione (anche con un tag nuovo): niente, e nessun errore.
    expect(await esegui(db, componiInsert(voceBase(), OPZIONI).sql)).toMatchObject({ registrate: 0, audit: 0, fattura_id: null })
    expect(await conta(db, 'fatture_emesse')).toBe(1)
    expect(await conta(db, 'registro_modifiche')).toBe(1)
    // Il pagamento non si tocca.
    const pag = (await db.query<{ fattura_stato: string }>(`SELECT fattura_stato FROM public.pagamenti WHERE id = '${PAG}'`)).rows[0]
    expect(pag.fattura_stato).toBe('in_attesa')
  })

  it('la riga scritta è WORM: il trigger vero rifiuta UPDATE del numero e DELETE', async () => {
    const db = await nuovoDb()
    await semina(db)
    const { fattura_id } = await esegui(db, componiInsert(voceBase(), OPZIONI).sql)
    await expect(db.exec(`UPDATE public.fatture_emesse SET numero = 9 WHERE id = '${fattura_id}'`)).rejects.toThrow(/immutabili/)
    await expect(db.exec(`DELETE FROM public.fatture_emesse WHERE id = '${fattura_id}'`)).rejects.toThrow(/DELETE non consentito/)
  })

  it('con la visibilità attiva nella sede la riga entra (porta la modalità); una senza modalità no', async () => {
    const db = await nuovoDb()
    await db.exec(`UPDATE public.admin_settings SET fatture_visibilita_attiva_il = now() WHERE scuola_id = '${SEDE}'`)
    await semina(db)
    expect(await esegui(db, componiInsert(voceBase(), OPZIONI).sql)).toMatchObject({ registrate: 1, audit: 1 })
    // Controllo che il trigger sia vivo: la stessa forma senza modalità è rifiutata.
    await semina(db, { id: PAG_2, file: FILE_2 })
    await expect(
      db.exec(
        `INSERT INTO public.fatture_emesse (pagamento_id, scuola_id, numero, sezionale, anno, importo)
         VALUES ('${PAG_2}', '${SEDE}', 7, 'Asilo', 2026, 1)`,
      ),
    ).rejects.toThrow(/modalita_emissione obbligatoria/)
  })

  it('FPR N e Asilo N nella stessa sede: dopo la migrazione convivono (il caso delle sei orfane)', async () => {
    const db = await nuovoDb()
    await semina(db)
    await semina(db, { id: PAG_2, stato: 'emessa', file: FILE_2 })
    await db.exec(rigaRegistro({ pagamento: PAG_2, sezionale: 'Asilo', numero: 2541, file: FILE_2 }))
    expect(await esegui(db, componiInsert(voceBase(), OPZIONI).sql)).toMatchObject({ registrate: 1 })
  })

  it('precondizioni: stato diverso, file diverso, numero occupato, righe del pagamento → 0', async () => {
    const casi: Array<[string, (db: PGlite) => Promise<void>]> = [
      ['stato emessa', (db) => semina(db, { stato: 'emessa' })],
      ['stato scartata', (db) => semina(db, { stato: 'scartata' })],
      ['file diverso sul pagamento', (db) => semina(db, { file: FILE_2 })],
      [
        'numero occupato da un altro pagamento',
        async (db) => {
          await semina(db)
          await semina(db, { id: PAG_2, stato: 'emessa', file: FILE_2 })
          await db.exec(rigaRegistro({ pagamento: PAG_2, sezionale: 'FPR', numero: 2541, file: FILE_2 }))
        },
      ],
      [
        'il pagamento ha già una riga (scartata, di un altro file)',
        async (db) => {
          await semina(db)
          await db.exec(rigaRegistro({ pagamento: PAG, sezionale: 'FPR', numero: 2400, sdi: 2, file: FILE_2 }))
        },
      ],
    ]
    for (const [nome, prepara] of casi) {
      const db = await nuovoDb()
      await prepara(db)
      const prima = await conta(db, 'fatture_emesse')
      expect(await esegui(db, componiInsert(voceBase(), OPZIONI).sql), nome).toMatchObject({ registrate: 0, audit: 0 })
      expect(await conta(db, 'fatture_emesse'), nome).toBe(prima)
      expect(await conta(db, 'registro_modifiche'), nome).toBe(0)
    }
  })

  it('giornale della coda: con un invio del pagamento 0; senza invii 1', async () => {
    const giornale = `CREATE TABLE public.fatture_coda_invii (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pagamento_id uuid NOT NULL);`
    const sql = componiInsert(voceBase(), { ...OPZIONI, giornaleEsiste: true }).sql

    const conInvio = await nuovoDb()
    await conInvio.exec(giornale)
    await semina(conInvio)
    await conInvio.exec(`INSERT INTO public.fatture_coda_invii (pagamento_id) VALUES ('${PAG}')`)
    expect(await esegui(conInvio, sql)).toMatchObject({ registrate: 0, audit: 0 })

    const senzaInvio = await nuovoDb()
    await senzaInvio.exec(giornale)
    await semina(senzaInvio)
    expect(await esegui(senzaInvio, sql)).toMatchObject({ registrate: 1, audit: 1 })

    // Senza la tabella, la clausola scritta comunque farebbe fallire l'istruzione: per questo è condizionale.
    const senzaTabella = await nuovoDb()
    await semina(senzaTabella)
    await expect(senzaTabella.exec(sql)).rejects.toThrow(/fatture_coda_invii/)
  })

  it('parità SQL/TS sui casi condivisi: nessuna voce discorde; con la forma «zero righe» sì', async () => {
    const db = await nuovoDb()
    for (const p of PAGAMENTI_DEI_CASI) {
      await db.exec(
        `INSERT INTO public.pagamenti (id, scuola_id, fattura_stato, fattura_aruba_id)
         VALUES ('${p.id}', '${SEDE}', '${p.fattura_stato}', ${p.fattura_aruba_id === null ? 'NULL' : `'${p.fattura_aruba_id}'`});`,
      )
    }
    // Le righe dei casi senza vincoli d'unicità di mezzo: solo le colonne che il predicato legge.
    await db.exec('DROP INDEX public.fatture_emesse_sezionale_anno_numero_uidx; DROP INDEX public.fatture_emesse_pagamento_quota_uidx;')
    let n = 0
    const righe = PAGAMENTI_DEI_CASI.flatMap((p) => p.righe.map((r) => ({ ...r, pagamento_id: p.id })))
    for (const r of righe) {
      n += 1
      await db.exec(
        `INSERT INTO public.fatture_emesse (pagamento_id, scuola_id, numero, anno, importo, sdi_stato, aruba_filename, quota_adult_id, modalita_emissione)
         VALUES ('${r.pagamento_id}', '${SEDE}', ${n}, 2026, 1, ${r.sdi_stato ?? 'NULL'}, ${r.aruba_filename === null ? 'NULL' : `'${r.aruba_filename}'`},
                 ${r.quota_adult_id === null ? 'NULL' : `'${r.quota_adult_id}'`}, 'ordinaria');`,
      )
    }
    const candidatiSql = (
      await db.query<{ id: string; scuola_id: string; fattura_stato: string; fattura_aruba_id: string | null }>(
        `SELECT p.id, p.scuola_id, p.fattura_stato::text AS fattura_stato, p.fattura_aruba_id FROM public.pagamenti p WHERE ${PREDICATO_SQL_PARTITA_NON_REGISTRATA} ORDER BY p.id`,
      )
    ).rows
    const attesi = PAGAMENTI_DEI_CASI.filter((p) => p.atteso).map((p) => p.id).sort()
    expect(candidatiSql.map((p) => p.id)).toEqual(attesi)

    const ingresso = { candidatiSql, righe, log: [], pagamentiConInvio: null, pagamentiDeiLog: PAGAMENTI_DEI_CASI.map((p) => ({ ...p, scuola_id: SEDE })) }
    const conModulo = accoppiaOrfane({ ...ingresso, predicato: fatturaPartitaNonRegistrata })
    expect(conModulo.voci.filter((v) => v.motivi.includes(DA_DECIDERE.predicatiDiscordi))).toEqual([])
    expect(conModulo.voci.map((v) => v.pagamento_id).sort()).toEqual(attesi)

    // Negativo: un TS nella forma «zero righe» diverge sui casi 2, 5 e 7 (righe che non
    // contano, perché d'altro file o scartate), e la scoperta lo vede.
    const zeroRighe = (pag: { fattura_stato?: string | null }, sue: readonly unknown[]) => pag.fattura_stato === 'in_attesa' && sue.length === 0
    const discordi = accoppiaOrfane({ ...ingresso, predicato: zeroRighe }).voci
      .filter((v) => v.motivi.includes(DA_DECIDERE.predicatiDiscordi))
      .map((v) => PAGAMENTI_DEI_CASI.find((p) => p.id === v.pagamento_id)!.caso)
      .sort()
    expect(discordi).toEqual([2, 5, 7])
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * Controllo testuale: il predicato ha una fonte sola
 * ──────────────────────────────────────────────────────────────────────────── */

describe('fonte unica del predicato', () => {
  const COPIA_DEL_PREDICATO = /fattura_stato\s*=\s*'in_attesa'/

  function fileSotto(cartella: string): string[] {
    return readdirSync(cartella).flatMap((nome) => {
      const percorso = join(cartella, nome)
      return statSync(percorso).isDirectory() ? fileSotto(percorso) : [percorso]
    })
  }

  it("nessun letterale fattura_stato = 'in_attesa' in scripts/lib/**", () => {
    const file = fileSotto(join(RADICE, 'scripts/lib'))
    // Controllo positivo: la scansione vede davvero la libreria, e la regex riconosce il testo del modulo.
    expect(file).toContain(join(RADICE, 'scripts/lib/fatture-orfane.mjs'))
    expect(PREDICATO_SQL_PARTITA_NON_REGISTRATA).toMatch(COPIA_DEL_PREDICATO)
    const copie = file.filter((f) => COPIA_DEL_PREDICATO.test(readFileSync(f, 'utf8')))
    expect(copie).toEqual([])
  })
})
