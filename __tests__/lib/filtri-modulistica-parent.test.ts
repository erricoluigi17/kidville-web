// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTranslator } from 'use-intl'

import {
  campiArchivio,
  campiCertificatiMedici,
  campiDaCompilare,
  STATO_MODULO_PREDEFINITO,
  type RigaArchivio,
  type RigaCertificatoMedico,
  type RigaModuloAssegnato,
} from '@/components/features/parent/filtri-modulistica'
import {
  campoAttivo,
  contaAttivi,
  descriviAttivi,
  filtraRighe,
  pulisciFiltri,
  queryServer,
  valoreNeutro,
  valoriIniziali,
} from '@/lib/ui/filtri/motore'
import type { CampoFiltro, ValoriFiltri } from '@/lib/ui/filtri/tipi'

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * I FILTRI DELLA «MODULISTICA» DEL GENITORE — la parte che si prova senza montare.
 *
 * I descrittori sono dati puri: `CampoFiltro<R>` più gli estrattori che leggono la
 * riga. Provarli qui, contro il motore vero (`filtraRighe`, `pulisciFiltri`,
 * `queryServer`), misura le tre cose che in una barra filtri si rompono in
 * silenzio, e le misura PRIMA che ci sia un pixel:
 *
 *  1. **il filtro di stato che sostituisce un `if` cablato.** Oggi la scheda «Da
 *     compilare» fa `assignedForms.filter(f => f.status === 'pending')` in due
 *     punti. Diventando un filtro deve continuare a mostrare *quello* — cioè il
 *     suo valore di riposo è `pending`, non «tutti» — o alla prima apertura la
 *     famiglia si troverebbe davanti anche i moduli già firmati e scaduti;
 *
 *  2. **«Pulisci filtri» che riporta al riposo, non al vuoto.** Un `predefinito`
 *     che «Pulisci» azzera è un filtro che, pulito, mostra più righe di quante ne
 *     mostrasse all'apertura: lo stesso gesto che dovrebbe rimettere ordine
 *     cambia l'insieme di partenza;
 *
 *  3. **nessun parametro nuovo verso `parent/*`.** Il carico di una famiglia è di
 *     una o tre righe per figlio, già interamente in memoria: ogni campo qui è
 *     `dove: 'client'`, e `queryServer` deve restituire la stringa VUOTA. Se un
 *     giorno qualcuno mettesse un campo `server`, la rotta riceverebbe un
 *     parametro che nessuno schema `zod` dichiara — cioè un 400 in faccia a un
 *     genitore, oppure (peggio) un filtro ignorato che restituisce tutto.
 *
 * ⚠️ Nessun dato personale nei dati di prova: il repository è PUBBLICO.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

const RADICE = process.cwd()
const CATALOGO = JSON.parse(
  readFileSync(join(RADICE, 'messages/it/parentServizi.json'), 'utf8'),
) as Record<string, string>

/** Il traduttore VERO del namespace `parentServizi`: ICU, plurali, errori che urlano. */
const t = createTranslator({
  locale: 'it',
  messages: { parentServizi: CATALOGO } as never,
  namespace: 'parentServizi' as never,
  onError: (errore) => {
    throw errore
  },
}) as unknown as (chiave: string, valori?: Record<string, string | number>) => string

/** Lo stato di partenza di una barra costruita su questi campi, senza indirizzo. */
const riposo = <R,>(campi: readonly CampoFiltro<R>[]): ValoriFiltri => valoriIniziali(campi, null)

const trova = <R,>(campi: readonly CampoFiltro<R>[], chiave: string): CampoFiltro<R> => {
  const campo = campi.find((c) => c.chiave === chiave)
  if (!campo) throw new Error(`campo «${chiave}» assente: ${campi.map((c) => c.chiave).join(', ')}`)
  return campo
}

// ─────────────────────────────────────────────────────────────────────────────
// I dati di prova — nomi inventati, il repository è pubblico
// ─────────────────────────────────────────────────────────────────────────────

const OGGI = '2026-09-01'

const MODULI: RigaModuloAssegnato[] = [
  {
    form_id: 'f1',
    title: 'Autorizzazione gita al museo',
    description: 'Uscita didattica di mezza giornata',
    form_type: 'autorizzazione',
    // Scade fra tre giorni: dentro la finestra dei sette.
    expiration_date: '2026-09-04T10:00:00.000Z',
    status: 'pending',
    student: { id: 's1', nome: 'Primo', cognome: 'Diprova' },
  },
  {
    form_id: 'f2',
    title: 'Questionario di gradimento',
    description: 'Come è andato l’anno',
    form_type: 'gradimento',
    expiration_date: null,
    status: 'pending',
    student: { id: 's2', nome: 'Seconda', cognome: 'Diprova' },
  },
  {
    form_id: 'f3',
    title: 'Sondaggio sull’orario',
    description: 'Preferenze di entrata',
    form_type: 'sondaggio',
    // Scaduto ieri.
    expiration_date: '2026-08-31T10:00:00.000Z',
    status: 'expired',
    student: { id: 's1', nome: 'Primo', cognome: 'Diprova' },
  },
  {
    form_id: 'f4',
    title: 'Autorizzazione uscita anticipata',
    description: 'Consenso permanente',
    form_type: 'autorizzazione',
    // Scade fra due mesi: fuori dalla finestra.
    expiration_date: '2026-11-02T10:00:00.000Z',
    status: 'signed',
    student: { id: 's2', nome: 'Seconda', cognome: 'Diprova' },
  },
]

const ARCHIVIO: RigaArchivio[] = [
  {
    id: 'a1',
    // 22:30 UTC del 30 luglio = 00:30 del 31 luglio a Roma: il caso in cui il
    // giorno del server e il giorno della famiglia NON coincidono.
    created_at: '2026-07-30T22:30:00.000Z',
    origine: 'online',
    forms_templates: { title: 'Autorizzazione gita al museo' },
    alunni: { nome: 'Primo', cognome: 'Diprova' },
  },
  {
    id: 'a2',
    created_at: '2026-08-15T09:00:00.000Z',
    origine: 'cartaceo',
    forms_templates: { title: 'Questionario di gradimento' },
    alunni: { nome: 'Seconda', cognome: 'Diprova' },
  },
]

const CERTIFICATI: RigaCertificatoMedico[] = [
  {
    id: 'c1',
    alunno_id: 's1',
    fileName: 'certificato-uno.pdf',
    creato_il: '2026-09-01T08:00:00.000Z',
    stato: 'in_validazione',
    data_inizio: '2026-09-01',
    data_fine: '2026-09-05',
    alunno: { nome: 'Primo', cognome: 'Diprova' },
  },
  {
    id: 'c2',
    alunno_id: 's2',
    fileName: 'certificato-due.pdf',
    creato_il: '2026-06-01T08:00:00.000Z',
    stato: 'validato',
    data_inizio: '2026-06-01',
    data_fine: '2026-06-03',
    alunno: { nome: 'Seconda', cognome: 'Diprova' },
  },
]

// ═════════════════════════════════════════════════════════════════════════════
// 1 · «Da compilare» — il filtro che sostituisce un `if` cablato
// ═════════════════════════════════════════════════════════════════════════════

describe('modulistica genitore · scheda «Da compilare»', () => {
  const campi = () => campiDaCompilare(MODULI, t, { oggi: OGGI })

  it('a riposo mostra SOLO i moduli da compilare: il `pending` cablato diventa il predefinito', () => {
    const c = campi()
    const stato = trova(c, 'stato')
    expect(stato.tipo).toBe('multi')
    if (stato.tipo !== 'multi') throw new Error('stato non è un multi')
    expect(stato.predefinito).toEqual([STATO_MODULO_PREDEFINITO])

    const visti = filtraRighe(c, riposo(c), MODULI).map((m) => m.form_id)
    expect(visti).toEqual(['f1', 'f2'])
  })

  it('il predefinito NON conta fra i filtri attivi, e «Pulisci» ci riporta (non azzera)', () => {
    const c = campi()
    const base = riposo(c)
    expect(contaAttivi(c, base)).toBe(0)

    // Spegnendo l'unica pastiglia accesa resta l'insieme vuoto, che vuol dire
    // «tutti»: è il modo in cui un `multi` esprime «nessun filtro» senza passare
    // da un valore che non è fra le opzioni.
    const conTutti: ValoriFiltri = { ...base, stato: [] }
    expect(campoAttivo(trova(c, 'stato'), conTutti)).toBe(true)
    expect(filtraRighe(c, conTutti, MODULI)).toHaveLength(4)

    expect(pulisciFiltri(c, conTutti).stato).toEqual([STATO_MODULO_PREDEFINITO])
  })

  it('due stati insieme si sommano (OR dentro il campo), e ciascuno resta removibile', () => {
    const c = campi()
    const due: ValoriFiltri = { ...riposo(c), stato: ['pending', 'expired'] }
    expect(filtraRighe(c, due, MODULI).map((m) => m.form_id)).toEqual(['f1', 'f2', 'f3'])
    expect(descriviAttivi(c, due).map((a) => a.testo)).toEqual(['Da compilare', 'Scaduto'])
  })

  it('«figlio» è un chip primario, così su un telefono resta VISIBILE e non nel foglio', () => {
    const c = campi()
    const figlio = trova(c, 'figlio')
    // La variante compatta tiene in riga i soli `chip` (`BarraFiltri`: `inRiga`).
    // Un `primario` di tipo `scelta` finirebbe comunque dentro il foglio.
    expect(figlio.tipo).toBe('chip')
    expect(figlio.primario).toBe(true)

    const soloSecondo: ValoriFiltri = { ...riposo(c), figlio: 's2' }
    expect(filtraRighe(c, soloSecondo, MODULI).map((m) => m.form_id)).toEqual(['f2'])
  })

  it('con un figlio solo il filtro «figlio» non si disegna: non avrebbe niente da restringere', () => {
    const diUnFiglio = MODULI.filter((m) => m.student.id === 's1')
    expect(campiDaCompilare(diUnFiglio, t, { oggi: OGGI }).some((c) => c.chiave === 'figlio')).toBe(false)
  })

  it('«scadenza» separa i sette giorni dallo scaduto, e chi non scade non è né l’uno né l’altro', () => {
    const c = campi()
    const base = riposo(c)
    const conStatoLibero = { ...base, stato: '' }

    const inScadenza = filtraRighe(c, { ...conStatoLibero, scadenza: 'in_scadenza' }, MODULI)
    expect(inScadenza.map((m) => m.form_id)).toEqual(['f1'])

    const scaduti = filtraRighe(c, { ...conStatoLibero, scadenza: 'scaduto' }, MODULI)
    expect(scaduti.map((m) => m.form_id)).toEqual(['f3'])
  })

  it('la ricerca sul titolo ignora accenti e forma dell’apostrofo', () => {
    const c = campi()
    const base = { ...riposo(c), stato: '' }
    expect(filtraRighe(c, { ...base, q: "sull'orario" }, MODULI).map((m) => m.form_id)).toEqual(['f3'])
    expect(filtraRighe(c, { ...base, q: 'MUSEO' }, MODULI).map((m) => m.form_id)).toEqual(['f1'])
  })

  it('il tipo di modulo porta lo stesso tono del badge della riga', () => {
    const tipo = trova(campi(), 'tipoModulo')
    if (tipo.tipo !== 'chip' && tipo.tipo !== 'scelta') throw new Error('tipoModulo non è una scelta')
    const toni = Object.fromEntries(tipo.opzioni.map((o) => [o.valore, o.tono]))
    expect(toni.autorizzazione).toBe('info')
    expect(toni.sondaggio).toBe('evidenza')
    expect(toni.gradimento).toBe('evidenza')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 2 · «Archivio firmati»
// ═════════════════════════════════════════════════════════════════════════════

describe('modulistica genitore · scheda «Archivio firmati»', () => {
  const campi = () => campiArchivio(ARCHIVIO, t)

  it('il periodo si misura sul giorno CIVILE italiano, non sull’istante UTC', () => {
    const c = campi()
    const base = riposo(c)
    // La riga è del 30 luglio alle 22:30 UTC, cioè del 31 luglio a Roma. Chiesto
    // il solo 31 luglio, deve esserci; chiesto il solo 30, no.
    const trentuno = filtraRighe(c, { ...base, periodo: { da: '2026-07-31', a: '2026-07-31' } }, ARCHIVIO)
    expect(trentuno.map((r) => r.id)).toEqual(['a1'])
    const trenta = filtraRighe(c, { ...base, periodo: { da: '2026-07-30', a: '2026-07-30' } }, ARCHIVIO)
    expect(trenta).toHaveLength(0)
  })

  it('«origine» nasce dai dati e distingue l’online dal cartaceo', () => {
    const c = campi()
    const origine = trova(c, 'origine')
    if (origine.tipo !== 'chip' && origine.tipo !== 'scelta') throw new Error('origine non è una scelta')
    expect(origine.opzioni.map((o) => o.valore).sort()).toEqual(['cartaceo', 'online'])
    expect(filtraRighe(c, { ...riposo(c), origine: 'cartaceo' }, ARCHIVIO).map((r) => r.id)).toEqual(['a2'])
  })

  it('«modulo» nasce dai titoli davvero presenti in archivio', () => {
    const modulo = trova(campi(), 'modulo')
    if (modulo.tipo !== 'chip' && modulo.tipo !== 'scelta') throw new Error('modulo non è una scelta')
    expect(modulo.opzioni.map((o) => o.etichetta)).toEqual([
      'Autorizzazione gita al museo',
      'Questionario di gradimento',
    ])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3 · «Certificati medici»
// ═════════════════════════════════════════════════════════════════════════════

describe('modulistica genitore · scheda «Certificati medici»', () => {
  const campi = () => campiCertificatiMedici(CERTIFICATI, t)

  it('il periodo di copertura tiene la riga che SI SOVRAPPONE, non quella che ci sta dentro', () => {
    const c = campi()
    const base = riposo(c)
    // Il certificato c1 copre 01→05 settembre. Chiedendo 04→10 settembre le due
    // finestre si toccano: la riga resta. È la differenza fra «malattia in corso
    // nel periodo» e «malattia interamente contenuta nel periodo».
    expect(filtraRighe(c, { ...base, copertura: { da: '2026-09-04', a: '2026-09-10' } }, CERTIFICATI).map((r) => r.id))
      .toEqual(['c1'])
    expect(filtraRighe(c, { ...base, copertura: { da: '2026-09-06', a: '2026-09-10' } }, CERTIFICATI))
      .toHaveLength(0)
  })

  it('lo stato porta gli stessi toni dei badge dell’elenco', () => {
    const stato = trova(campi(), 'stato')
    if (stato.tipo !== 'chip' && stato.tipo !== 'scelta') throw new Error('stato non è una scelta')
    const toni = Object.fromEntries(stato.opzioni.map((o) => [o.valore, o.tono]))
    expect(toni).toEqual({ in_validazione: 'warn', validato: 'success', rifiutato: 'error' })
    expect(filtraRighe(campi(), { ...riposo(campi()), stato: 'validato' }, CERTIFICATI).map((r) => r.id)).toEqual(['c2'])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 5 · L'invariante di tutta la pagina: niente parte verso l'API
// ═════════════════════════════════════════════════════════════════════════════

describe('modulistica genitore · nessun parametro nuovo verso le rotte `parent/*`', () => {
  const tutte: Array<[string, CampoFiltro<never>[]]> = [
    ['compilare', campiDaCompilare(MODULI, t, { oggi: OGGI }) as unknown as CampoFiltro<never>[]],
    ['archivio', campiArchivio(ARCHIVIO, t) as unknown as CampoFiltro<never>[]],
    ['medici', campiCertificatiMedici(CERTIFICATI, t) as unknown as CampoFiltro<never>[]],
    // ⚠️ La quarta scheda — il catalogo dei prestampati — NON è qui, e non è una
    // dimenticanza: i suoi filtri vivono in `features/prestampati/filtri-catalogo.ts`,
    // che serve tutti e diciassette i modelli e tutte e due le facce (famiglia e
    // segreteria). Una seconda dichiarazione degli stessi campi, ristretta agli otto
    // del genitore, sarebbe la stessa regola in due posti — cioè due regole che
    // divergono al primo ritocco. Il suo banco è `filtri-catalogo-prestampati.test.ts`.
  ]

  for (const [nome, campi] of tutte) {
    it(`${nome}: ogni campo filtra a schermo, e la query per l’API resta vuota`, () => {
      expect(campi.length).toBeGreaterThan(2)
      expect(campi.filter((c) => c.dove !== 'client')).toEqual([])
      expect(queryServer(campi, riposo(campi)).toString()).toBe('')
    })

    it(`${nome}: ogni etichetta è un TESTO risolto, mai il nome di una chiave`, () => {
      for (const campo of campi) {
        expect(campo.etichetta.length).toBeGreaterThan(1)
        expect(campo.etichetta).not.toMatch(/^[a-z][A-Za-z0-9]*$/)
        expect(campo.etichetta).not.toContain('parentServizi.')
      }
    })

    /**
     * ⚠️ L'INVARIANTE CHE HA DECISO LA FORMA DEL FILTRO «STATO».
     *
     * `chip` e `scelta` con un `predefinito` hanno un buco: premendo la pastiglia
     * accesa (o scegliendo «Tutti») il valore torna alla stringa vuota, che il
     * motore considera ATTIVA — è diversa dal predefinito — ma che non
     * corrisponde a nessuna opzione. `descriviAttivi` non trova l'etichetta e
     * produce un chip removibile **senza testo**: un ✕ che galleggia da solo.
     *
     * Misurato qui sotto sul motore vero, e non descritto a parole: se un giorno
     * qualcuno riporterà `stato` a `chip` con `predefinito`, questo test dirà
     * esattamente che cosa comparirà a schermo.
     */
    it(`${nome}: nessuna scelta singola porta un valore di partenza (produrrebbe un chip senza testo)`, () => {
      for (const campo of campi) {
        if (campo.tipo !== 'chip' && campo.tipo !== 'scelta') continue
        expect(
          campo.predefinito ?? '',
          `«${campo.chiave}» è un ${campo.tipo} con un predefinito: spegnendolo nascerebbe un chip vuoto`,
        ).toBe('')
      }
    })
  }

  it('la prova della prova: un `chip` con un predefinito genera davvero un chip SENZA testo', () => {
    // Il difetto si dimostra, non si racconta: senza questa riga l'invariante qui
    // sopra sarebbe una regola di cui nessuno ha mai visto la violazione.
    const finto: CampoFiltro<{ stato: string }>[] = [
      {
        tipo: 'chip',
        chiave: 'stato',
        etichetta: 'Stato',
        dove: 'client',
        predefinito: 'pending',
        opzioni: [{ valore: 'pending', etichetta: 'Da compilare' }],
        valoreDi: (r) => r.stato,
      },
    ]
    expect(valoreNeutro(finto[0])).toBe('pending')
    const spento = descriviAttivi(finto, { stato: '' })
    expect(spento).toHaveLength(1)
    expect(spento[0].testo).toBe('')
  })
})
