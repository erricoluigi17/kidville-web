import { describe, it, expect } from 'vitest'
import { decidiAbbinamento, type FattiAbbinamento } from '@/lib/chat/rubrica'

/**
 * LA REGOLA: «questo operatore e questo genitore possono parlarsi su questo bambino?»
 *
 * È una funzione PURA, e non per eleganza: prima viveva in tre posti che non
 * dicevano la stessa cosa — la rubrica del genitore, la rubrica della maestra e il
 * gate che apre il thread — e ognuno dei tre aveva una falla sua.
 *
 * ─── COSA FALLIVA, misurato in produzione il 2026-09-07 ───────────────────────
 *
 *  · **150 genitori su 706** vedevano, fra le «proprie insegnanti», una persona che
 *    insegnante non è: in `utenti_sezioni` ci sono 6 righe di `segreteria` e 1 di
 *    `admin`, e la rubrica non guardava il ruolo.
 *  · **32 genitori** vedevano almeno un docente CESSATO (`attivo = false`).
 *  · **9 genitori** ricadevano in un fallback che restituiva **tutti i 63 docenti di
 *    5 sedi** — Demo ed E2E comprese.
 *  · **12 docenti su 60** vedevano i genitori di UNA sola delle proprie sezioni
 *    (`.limit(1)` senza `order`, quindi non deterministicamente).
 *  · il gate di scrittura non verificava affatto l'altra metà del thread: un
 *    genitore poteva aprire una chat con una qualunque insegnante, anche di
 *    un'altra sede, purché il bambino fosse suo.
 *
 * ─── DUE COSE CHE QUESTA REGOLA NON CONFONDE ─────────────────────────────────
 *
 * 1. **`non-deciso` non è `no`.** Una lettura fallita non autorizza a negare: chi
 *    la riceve risponde 500, non 403. Negare su un guasto vorrebbe dire dire a una
 *    famiglia «questa non è la tua insegnante» perché una query è andata storta.
 * 2. **`attivo: null` non è `attivo: false`.** La colonna è `boolean DEFAULT true`
 *    *nullable*: un NULL è una riga vecchia, non una persona cessata.
 */

const SEZ_A = 'sez-a'
const SEZ_B = 'sez-b'
const SEDE_1 = 'sede-1'
const SEDE_2 = 'sede-2'

const fatti = (o: Partial<FattiAbbinamento> = {}): FattiAbbinamento => ({
  alunno: { id: 'alu-1', sectionId: SEZ_A, scuolaId: SEDE_1, stato: 'iscritto' },
  operatore: { id: 'op-1', ruolo: 'educator', attivo: true, sezioni: [SEZ_A], scuole: [SEDE_1] },
  legame: 'si',
  ...o,
})

const esito = (o: Partial<FattiAbbinamento> = {}) => decidiAbbinamento(fatti(o))

describe('la maestra e la famiglia della propria sezione', () => {
  it('si parlano', () => {
    expect(esito()).toEqual({ consentito: true, motivo: 'consentito' })
  })

  it('anche con più sezioni: contano TUTTE, non la prima che capita', () => {
    const r = esito({ operatore: { id: 'op-1', ruolo: 'educator', attivo: true, sezioni: [SEZ_B, SEZ_A], scuole: [SEDE_1] } })
    expect(r.consentito).toBe(true)
  })

  it('un bambino SOSPESO resta raggiungibile: sospeso è un bambino che frequenta', () => {
    expect(esito({ alunno: { id: 'alu-1', sectionId: SEZ_A, scuolaId: SEDE_1, stato: 'sospeso' } }).consentito).toBe(true)
  })
})

describe('chi la regola tiene fuori', () => {
  it('la maestra di un\'ALTRA sezione: sono i 30 thread nati dalla porta senza gate', () => {
    const r = esito({ operatore: { id: 'op-1', ruolo: 'educator', attivo: true, sezioni: [SEZ_B], scuole: [SEDE_1] } })
    expect(r).toEqual({ consentito: false, motivo: 'operatore-fuori-sezione' })
  })

  it('una maestra CESSATA: 32 genitori se la vedevano ancora in rubrica', () => {
    const r = esito({ operatore: { id: 'op-1', ruolo: 'educator', attivo: false, sezioni: [SEZ_A], scuole: [SEDE_1] } })
    expect(r).toEqual({ consentito: false, motivo: 'operatore-non-attivo' })
  })

  it('un bambino senza sezione: non esiste «la sua maestra» da indovinare', () => {
    const r = esito({ alunno: { id: 'alu-1', sectionId: null, scuolaId: SEDE_1, stato: 'iscritto' } })
    expect(r).toEqual({ consentito: false, motivo: 'alunno-senza-sezione' })
  })

  it('un bambino RITIRATO: il canale con la famiglia è chiuso', () => {
    const r = esito({ alunno: { id: 'alu-1', sectionId: SEZ_A, scuolaId: SEDE_1, stato: 'ritirato' } })
    expect(r).toEqual({ consentito: false, motivo: 'alunno-senza-canale' })
  })

  it('uno stato SCONOSCIUTO si tratta come chiuso: l\'elenco è una lista bianca', () => {
    expect(esito({ alunno: { id: 'alu-1', sectionId: SEZ_A, scuolaId: SEDE_1, stato: 'boh' } }).motivo).toBe('alunno-senza-canale')
    expect(esito({ alunno: { id: 'alu-1', sectionId: SEZ_A, scuolaId: SEDE_1, stato: null } }).motivo).toBe('alunno-senza-canale')
  })

  it('chi non è genitore di quel bambino', () => {
    expect(esito({ legame: 'no' })).toEqual({ consentito: false, motivo: 'legame-famiglia-assente' })
  })

  it('la cuoca, che non insegna e non è staff di direzione', () => {
    const r = esito({ operatore: { id: 'op-1', ruolo: 'cuoca', attivo: true, sezioni: [], scuole: [SEDE_1] } })
    expect(r).toEqual({ consentito: false, motivo: 'operatore-non-e-insegnante' })
  })
})

describe('la segreteria e la direzione: per SEDE, non per sezione', () => {
  it.each(['admin', 'coordinator', 'segreteria'] as const)('%s della stessa sede: sì', (ruolo) => {
    const r = esito({ operatore: { id: 'op-1', ruolo, attivo: true, sezioni: [], scuole: [SEDE_1] } })
    expect(r.consentito).toBe(true)
  })

  it('è questo ramo che tiene in piedi i 35 thread già aperti con lo staff', () => {
    const r = esito({ operatore: { id: 'op-1', ruolo: 'segreteria', attivo: true, sezioni: [], scuole: [SEDE_1] } })
    expect(r.motivo).toBe('consentito')
  })

  it('ma di un\'ALTRA sede: no', () => {
    const r = esito({ operatore: { id: 'op-1', ruolo: 'segreteria', attivo: true, sezioni: [], scuole: [SEDE_2] } })
    expect(r).toEqual({ consentito: false, motivo: 'operatore-fuori-sede' })
  })
})

describe('«non lo so» non è «no»', () => {
  it('un legame non deciso resta non deciso: chi lo riceve risponde 500, non 403', () => {
    expect(esito({ legame: 'non-deciso' })).toEqual({ consentito: false, motivo: 'non-deciso' })
  })

  it('l\'alunno non letto', () => {
    expect(esito({ alunno: null })).toEqual({ consentito: false, motivo: 'non-deciso' })
  })

  it('l\'operatore non letto', () => {
    expect(esito({ operatore: null })).toEqual({ consentito: false, motivo: 'non-deciso' })
  })

  it('`attivo: null` NON è un cessato: la colonna è nullable, e un NULL è una riga vecchia', () => {
    const r = esito({ operatore: { id: 'op-1', ruolo: 'educator', attivo: null, sezioni: [SEZ_A], scuole: [SEDE_1] } })
    expect(r.consentito).toBe(true)
  })
})
