import { describe, it, expect } from 'vitest'
import { z } from 'zod'

import type { CampoFiltro } from '@/lib/ui/filtri/tipi'
import {
  azzeraFiltro,
  contaAttivi,
  decidiStatoElenco,
  descriviAttivi,
  filtraRighe,
  opzioniDerivate,
  pulisciFiltri,
  queryServer,
  valoriIniziali,
  versoUrl,
} from '@/lib/ui/filtri/motore'
import { normalizzaTesto, rangoDiMatch } from '@/lib/ui/testo-ricerca'
import { normalizzaTesto as normalizzaDaCombobox, rangoDiMatch as rangoDaCombobox } from '@/components/ui/Combobox'
import { orIlike, termineOr } from '@/lib/db/ricerca-postgrest'
import { restringiSedi } from '@/lib/auth/scope'
import { zOpzionale, zPeriodo, zTestoRicerca } from '@/lib/validation/common'
// Le sedi FINTE: un test non deve conoscere la produzione (lock
// `migrazioni-senza-sede-cablata`, che ha misurato questo file e l'ha respinto).
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// =============================================================================
// IL MOTORE DEI FILTRI — la parte PURA, quella che si può sbagliare in silenzio.
//
// Perché esiste questo banco. Una barra filtri sbaglia sempre nello stesso modo:
// funziona a schermo e mente sui bordi. Le tre bugie che costano di più, e che
// qui si misurano una per una:
//
//  1. L'AND E L'OR SI SCAMBIANO. Due filtri diversi vanno in AND («stato = in
//     attesa» E «sede = Cesa»); due valori dello STESSO filtro vanno in OR
//     («stato = in attesa OPPURE approvata»). Scambiarli non fa rumore: fa
//     comparire righe di troppo, o sparire righe che ci sono. §4.
//
//  2. IL PERIODO PERDE UN GIORNO. Un intervallo «dal 1° al 31» che esclude il 31
//     è la forma più comune del difetto, e la segreteria se ne accorge solo
//     quando manca la registrazione dell'ultimo giorno del mese. §4.
//
//  3. IL FILTRO CLIENT FINISCE NELLA QUERY (o viceversa). Un campo `dove:'client'`
//     spedito al server produce un 400 o — peggio — viene ignorato e l'elenco
//     torna intero; un campo `dove:'server'` filtrato solo a schermo mostra 20
//     righe su 400 e chiama «tutte» quelle 20. §3.
//
// Il motore è PURO di proposito: nessun React, nessuna fetch, nessun DOM. Tutto
// ciò che si può sbagliare qui si misura senza montare niente.
//
// ⚠️ Nessun dato personale nei dati di prova (repository PUBBLICO): le righe sono
// pratiche di segreteria con oggetti di documenti e sedi, non persone.
// =============================================================================

interface Pratica {
  id: string
  oggetto: string
  stato: 'in_attesa' | 'approvata' | 'respinta'
  sede: string
  data: string
  urgente: boolean
}

const PRATICHE: Pratica[] = [
  { id: '1', oggetto: 'Richiesta nulla osta', stato: 'in_attesa', sede: 'Cesa', data: '2026-01-10', urgente: false },
  { id: '2', oggetto: 'Comunicazione all’ASL', stato: 'approvata', sede: 'Aversa', data: '2026-02-01', urgente: true },
  { id: '3', oggetto: 'Verbale del Consiglio', stato: 'respinta', sede: 'Cesa', data: '2026-02-28', urgente: false },
  { id: '4', oggetto: 'Nulla osta al trasferimento', stato: 'in_attesa', sede: 'Giugliano', data: '2026-03-31', urgente: true },
]

/** I campi di prova: uno per ogni `tipo`, e le due metà `client`/`server`. */
function campiDiProva(): CampoFiltro<Pratica>[] {
  return [
    {
      tipo: 'ricerca',
      chiave: 'q',
      etichetta: 'Cerca',
      dove: 'client',
      primario: true,
      testiDi: (r) => [r.oggetto],
    },
    {
      tipo: 'scelta',
      chiave: 'stato',
      etichetta: 'Stato',
      dove: 'client',
      primario: true,
      valoreDi: (r) => r.stato,
      opzioni: [
        { valore: 'in_attesa', etichetta: 'In attesa', tono: 'warn' },
        { valore: 'approvata', etichetta: 'Approvata', tono: 'success' },
        { valore: 'respinta', etichetta: 'Respinta', tono: 'error' },
      ],
    },
    {
      tipo: 'multi',
      chiave: 'sede',
      etichetta: 'Sede',
      dove: 'client',
      valoriDi: (r) => [r.sede],
      opzioni: [
        { valore: 'Cesa', etichetta: 'Kidville Cesa' },
        { valore: 'Aversa', etichetta: 'Kidville Aversa' },
        { valore: 'Giugliano', etichetta: 'Kidville Giugliano' },
      ],
    },
    {
      tipo: 'periodo',
      chiave: 'data',
      etichetta: 'Periodo',
      dove: 'client',
      dataDi: (r) => r.data,
    },
    {
      tipo: 'interruttore',
      chiave: 'urgenti',
      etichetta: 'Solo urgenti',
      dove: 'client',
      predicato: (r) => r.urgente,
    },
    {
      tipo: 'scelta',
      chiave: 'anno',
      etichetta: 'Anno',
      dove: 'server',
      obbligatorio: true,
      predefinito: '2026',
      opzioni: [
        { valore: '2026', etichetta: '2026' },
        { valore: '2025', etichetta: '2025' },
      ],
    },
    {
      tipo: 'chip',
      chiave: 'tipo',
      etichetta: 'Tipo',
      dove: 'server',
      opzioni: [
        { valore: 'ingresso', etichetta: 'In ingresso', tono: 'info' },
        { valore: 'uscita', etichetta: 'In uscita', tono: 'neutral' },
      ],
    },
  ]
}

const ids = (righe: Pratica[]) => righe.map((r) => r.id)

// ─────────────────────────────────────────────────────────────────────────────
describe('§1 · valoriIniziali — lo stato di partenza, e l’URL che lo rialza', () => {
  it('senza URL ogni campo parte dal proprio valore neutro', () => {
    const v = valoriIniziali(campiDiProva())
    expect(v).toEqual({
      q: '',
      stato: '',
      sede: [],
      data: { da: '', a: '' },
      urgenti: false,
      anno: '2026', // obbligatorio: parte dal predefinito, non dal vuoto
      tipo: '',
    })
  })

  it('l’URL rialza lo stato: testo, scelta, multi (separati da virgola), periodo, interruttore', () => {
    const v = valoriIniziali(
      campiDiProva(),
      new URLSearchParams('q=nulla+osta&stato=in_attesa&sede=Cesa,Giugliano&dataDa=2026-01-01&dataA=2026-03-31&urgenti=1&anno=2025'),
    )
    expect(v).toEqual({
      q: 'nulla osta',
      stato: 'in_attesa',
      sede: ['Cesa', 'Giugliano'],
      data: { da: '2026-01-01', a: '2026-03-31' },
      urgenti: true,
      anno: '2025',
      tipo: '',
    })
  })

  it('un valore che non è fra le opzioni viene SCARTATO, non fidato', () => {
    // Un parametro d'URL è scritto da chi vuole: se «stato=qualunque» passasse,
    // il filtro mostrerebbe zero righe senza che nessun controllo lo dica.
    const v = valoriIniziali(campiDiProva(), new URLSearchParams('stato=qualunque&sede=Cesa,Marte'))
    expect(v.stato).toBe('')
    expect(v.sede).toEqual(['Cesa'])
  })

  it('una data mal scritta nell’URL non entra nello stato', () => {
    const v = valoriIniziali(campiDiProva(), new URLSearchParams('dataDa=ieri&dataA=2026-02-30'))
    // 2026-02-30 NON esiste sul calendario: la stessa regola di `zDataYMD`.
    expect(v.data).toEqual({ da: '', a: '' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('§2 · versoUrl — l’indirizzo che si può incollare a un collega', () => {
  it('emette solo ciò che è stato scelto davvero', () => {
    const campi = campiDiProva()
    const v = { ...valoriIniziali(campi), q: 'nulla', sede: ['Cesa', 'Giugliano'] }
    expect(versoUrl(campi, v).toString()).toBe('q=nulla&sede=Cesa%2CGiugliano')
  })

  it('il periodo esce come `<chiave>Da` e `<chiave>A`, e i vuoti non escono', () => {
    const campi = campiDiProva()
    const v = { ...valoriIniziali(campi), data: { da: '', a: '2026-03-31' } }
    expect(versoUrl(campi, v).toString()).toBe('dataA=2026-03-31')
  })

  it('l’obbligatorio esce SOLO se cambiato: un anno corrente nell’URL è rumore', () => {
    const campi = campiDiProva()
    expect(versoUrl(campi, valoriIniziali(campi)).toString()).toBe('')
    expect(versoUrl(campi, { ...valoriIniziali(campi), anno: '2025' }).toString()).toBe('anno=2025')
  })

  it('quello che esce rientra identico: il giro completo non perde niente', () => {
    const campi = campiDiProva()
    const v = {
      q: 'consiglio',
      stato: 'respinta',
      sede: ['Cesa'],
      data: { da: '2026-01-01', a: '2026-12-31' },
      urgenti: true,
      anno: '2025',
      tipo: 'uscita',
    }
    expect(valoriIniziali(campi, versoUrl(campi, v))).toEqual(v)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('§3 · queryServer — solo ciò che il server deve sapere', () => {
  it('i campi `dove:client` non partono MAI verso l’API', () => {
    const campi = campiDiProva()
    const v = { ...valoriIniziali(campi), q: 'nulla', stato: 'in_attesa', sede: ['Cesa'], urgenti: true }
    const q = queryServer(campi, v)
    expect(q.has('q')).toBe(false)
    expect(q.has('stato')).toBe(false)
    expect(q.has('sede')).toBe(false)
    expect(q.has('urgenti')).toBe(false)
  })

  it('l’obbligatorio c’è SEMPRE, anche al valore predefinito', () => {
    const campi = campiDiProva()
    expect(queryServer(campi, valoriIniziali(campi)).toString()).toBe('anno=2026')
  })

  it('i campi server facoltativi escono solo quando valgono qualcosa', () => {
    const campi = campiDiProva()
    const v = { ...valoriIniziali(campi), tipo: 'uscita' }
    expect(queryServer(campi, v).toString()).toBe('anno=2026&tipo=uscita')
  })

  it('la stringa è STABILE: gli stessi valori danno la stessa chiave, in qualunque ordine', () => {
    // È il contratto su cui si regge `chiaveServer` dell'hook: una chiave che
    // cambia a parità di scelte è un ciclo di fetch infinito.
    const campi = campiDiProva()
    const a = queryServer(campi, { anno: '2026', tipo: 'uscita', q: 'x', stato: '', sede: [], data: { da: '', a: '' }, urgenti: false })
    const b = queryServer(campi, { urgenti: false, data: { da: '', a: '' }, sede: [], stato: '', q: 'y', tipo: 'uscita', anno: '2026' })
    expect(a.toString()).toBe(b.toString())
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('§4 · filtraRighe — AND fra campi diversi, OR dentro un multi', () => {
  const campi = campiDiProva()
  const base = valoriIniziali(campi)

  it('senza filtri non tocca niente (e non riordina)', () => {
    expect(filtraRighe(campi, base, PRATICHE)).toEqual(PRATICHE)
  })

  it('la ricerca ignora accenti, apostrofi e maiuscole', () => {
    expect(ids(filtraRighe(campi, { ...base, q: 'ALL’ASL' }, PRATICHE))).toEqual(['2'])
    expect(ids(filtraRighe(campi, { ...base, q: "all'asl" }, PRATICHE))).toEqual(['2'])
    expect(ids(filtraRighe(campi, { ...base, q: 'all asl' }, PRATICHE))).toEqual(['2'])
  })

  it('due valori dello stesso `multi` vanno in OR', () => {
    expect(ids(filtraRighe(campi, { ...base, sede: ['Cesa', 'Giugliano'] }, PRATICHE))).toEqual(['1', '3', '4'])
  })

  it('e l’OR è OR anche quando la RIGA ha più valori (qui `some` ≠ `every`)', () => {
    // ⚠️ Questo caso esiste perché il precedente NON basta, e lo si è scoperto
    // rompendo il motore apposta: con `valoriDi` che torna UN valore solo,
    // `some` ed `every` danno lo stesso risultato, e scambiarli lascia la suite
    // verde. La differenza si vede solo su una riga che porta PIÙ valori dello
    // stesso campo — le etichette di una pratica, le sezioni di un avviso.
    interface Nota {
      id: string
      tag: string[]
    }
    const campiTag: CampoFiltro<Nota>[] = [
      {
        tipo: 'multi',
        chiave: 'tag',
        etichetta: 'Etichette',
        dove: 'client',
        valoriDi: (r) => r.tag,
        opzioni: [
          { valore: 'urgente', etichetta: 'Urgente' },
          { valore: 'sanitario', etichetta: 'Sanitario' },
          { valore: 'contabile', etichetta: 'Contabile' },
        ],
      },
    ]
    const note: Nota[] = [
      { id: 'a', tag: ['urgente', 'sanitario'] },
      { id: 'b', tag: ['contabile'] },
      { id: 'c', tag: [] },
    ]
    // «Urgente» selezionato: la riga `a` lo HA, insieme a un'altra etichetta.
    // Con l'AND sparirebbe — cioè scegliere UN filtro nasconderebbe la riga che
    // quel filtro descrive.
    expect(filtraRighe(campiTag, { tag: ['urgente'] }, note).map((n) => n.id)).toEqual(['a'])
    expect(filtraRighe(campiTag, { tag: ['urgente', 'contabile'] }, note).map((n) => n.id)).toEqual(['a', 'b'])
    expect(filtraRighe(campiTag, { tag: [] }, note).map((n) => n.id)).toEqual(['a', 'b', 'c'])
  })

  it('due campi diversi vanno in AND', () => {
    const v = { ...base, sede: ['Cesa', 'Giugliano'], stato: 'in_attesa' }
    expect(ids(filtraRighe(campi, v, PRATICHE))).toEqual(['1', '4'])
  })

  it('il periodo è INCLUSIVO a tutti e due gli estremi', () => {
    const v = { ...base, data: { da: '2026-01-10', a: '2026-03-31' } }
    // Il 10 gennaio e il 31 marzo — cioè gli estremi — devono esserci.
    expect(ids(filtraRighe(campi, v, PRATICHE))).toEqual(['1', '2', '3', '4'])
  })

  it('un solo estremo funziona come «da qui in poi» / «fino a qui»', () => {
    expect(ids(filtraRighe(campi, { ...base, data: { da: '2026-02-28', a: '' } }, PRATICHE))).toEqual(['3', '4'])
    expect(ids(filtraRighe(campi, { ...base, data: { da: '', a: '2026-02-01' } }, PRATICHE))).toEqual(['1', '2'])
  })

  it('`da` dopo `a` non è un errore da nascondere: l’elenco è vuoto', () => {
    const v = { ...base, data: { da: '2026-03-31', a: '2026-01-01' } }
    expect(filtraRighe(campi, v, PRATICHE)).toEqual([])
  })

  it('l’interruttore tiene solo le righe che soddisfano il predicato', () => {
    expect(ids(filtraRighe(campi, { ...base, urgenti: true }, PRATICHE))).toEqual(['2', '4'])
    // Spento NON significa «solo i non urgenti»: significa «non filtrare».
    expect(filtraRighe(campi, { ...base, urgenti: false }, PRATICHE)).toEqual(PRATICHE)
  })

  it('i campi `dove:server` non filtrano di nuovo a schermo', () => {
    // Il server ha già ristretto: rifiltrare qui significherebbe applicare due
    // volte lo stesso criterio su dati già scremati, e con `tipo` che nemmeno
    // esiste sulla riga vorrebbe dire svuotare l'elenco.
    expect(filtraRighe(campi, { ...base, tipo: 'uscita', anno: '2025' }, PRATICHE)).toEqual(PRATICHE)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('§5 · contaAttivi — il numero sulla pastiglia «Filtri»', () => {
  const campi = campiDiProva()
  const base = valoriIniziali(campi)

  it('a riposo è zero', () => {
    expect(contaAttivi(campi, base)).toBe(0)
  })

  it('conta i CAMPI, non i valori: un multi con tre scelte resta un filtro solo', () => {
    expect(contaAttivi(campi, { ...base, sede: ['Cesa', 'Aversa', 'Giugliano'] })).toBe(1)
  })

  it('l’obbligatorio NON si conta mai, nemmeno quando è stato cambiato', () => {
    expect(contaAttivi(campi, { ...base, anno: '2025' })).toBe(0)
    expect(contaAttivi(campi, { ...base, anno: '2025', stato: 'respinta' })).toBe(1)
  })

  it('una ricerca fatta di soli spazi non è un filtro', () => {
    expect(contaAttivi(campi, { ...base, q: '   ' })).toBe(0)
  })

  it('il periodo conta una volta sola anche con due estremi', () => {
    expect(contaAttivi(campi, { ...base, data: { da: '2026-01-01', a: '2026-12-31' } })).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('§6 · descriviAttivi — i chip removibili, col tono del badge di stato', () => {
  const campi = campiDiProva()
  const base = valoriIniziali(campi)

  it('il chip di uno stato porta lo STESSO tono del badge di quello stato', () => {
    const [chip] = descriviAttivi(campi, { ...base, stato: 'in_attesa' })
    expect(chip).toMatchObject({ chiave: 'stato', etichetta: 'Stato', testo: 'In attesa', tono: 'warn' })
  })

  it('un multi produce un chip PER VALORE, ognuno togliibile da solo', () => {
    const chips = descriviAttivi(campi, { ...base, sede: ['Cesa', 'Giugliano'] })
    expect(chips.map((c) => c.testo)).toEqual(['Kidville Cesa', 'Kidville Giugliano'])
    expect(chips.map((c) => c.valore)).toEqual(['Cesa', 'Giugliano'])
  })

  it('la ricerca si descrive col testo cercato, l’interruttore con la sua etichetta', () => {
    expect(descriviAttivi(campi, { ...base, q: '  nulla osta ' })[0].testo).toBe('nulla osta')
    expect(descriviAttivi(campi, { ...base, urgenti: true })[0].testo).toBe('Solo urgenti')
  })

  it('il periodo ha una descrizione neutra di lingua, che la pagina può sostituire', () => {
    const soloIso = descriviAttivi(campi, { ...base, data: { da: '2026-01-01', a: '2026-03-31' } })[0]
    expect(soloIso.testo).toBe('2026-01-01 → 2026-03-31')

    const conFormato = campi.map((c) =>
      c.chiave === 'data' && c.tipo === 'periodo' ? { ...c, descrivi: (p: { da: string; a: string }) => `dal ${p.da} al ${p.a}` } : c,
    )
    expect(descriviAttivi(conFormato, { ...base, data: { da: '2026-01-01', a: '2026-03-31' } })[0].testo).toBe(
      'dal 2026-01-01 al 2026-03-31',
    )
  })

  it('l’obbligatorio non compare fra i chip: non è un filtro da togliere', () => {
    expect(descriviAttivi(campi, { ...base, anno: '2025' })).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('§7 · azzeraFiltro e pulisciFiltri', () => {
  const campi = campiDiProva()
  const base = valoriIniziali(campi)

  it('azzerare un multi per valore toglie solo quel valore', () => {
    const v = azzeraFiltro(campi, { ...base, sede: ['Cesa', 'Giugliano'] }, 'sede', 'Cesa')
    expect(v.sede).toEqual(['Giugliano'])
  })

  it('azzerare senza valore riporta il campo al suo neutro', () => {
    expect(azzeraFiltro(campi, { ...base, stato: 'respinta' }, 'stato').stato).toBe('')
    expect(azzeraFiltro(campi, { ...base, data: { da: '2026-01-01', a: '' } }, 'data').data).toEqual({ da: '', a: '' })
  })

  it('«Pulisci filtri» azzera tutto TRANNE gli obbligatori, che restano dove sono', () => {
    const sporco = { q: 'x', stato: 'respinta', sede: ['Cesa'], data: { da: '2026-01-01', a: '' }, urgenti: true, anno: '2025', tipo: 'uscita' }
    expect(pulisciFiltri(campi, sporco)).toEqual({ ...base, anno: '2025' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('§8 · opzioniDerivate — le voci che nascono dai dati, non da un elenco', () => {
  it('conta le occorrenze e ordina per etichetta in italiano', () => {
    expect(opzioniDerivate(PRATICHE, (r) => r.sede)).toEqual([
      { valore: 'Aversa', etichetta: 'Aversa', conteggio: 1 },
      { valore: 'Cesa', etichetta: 'Cesa', conteggio: 2 },
      { valore: 'Giugliano', etichetta: 'Giugliano', conteggio: 1 },
    ])
  })

  it('salta i valori assenti e accetta gli estrattori che ne tornano più d’uno', () => {
    const righe = [{ tag: ['a', 'b'] }, { tag: [] }, { tag: null }, { tag: ['b'] }]
    expect(opzioniDerivate(righe, (r) => r.tag)).toEqual([
      { valore: 'a', etichetta: 'a', conteggio: 1 },
      { valore: 'b', etichetta: 'b', conteggio: 2 },
    ])
  })

  it('etichetta e tono si possono decidere fuori (i18n e coerenza col badge)', () => {
    const o = opzioniDerivate(PRATICHE, (r) => r.stato, {
      etichettaDi: (v) => ({ in_attesa: 'In attesa', approvata: 'Approvata', respinta: 'Respinta' })[v] ?? v,
      tonoDi: (v) => (v === 'in_attesa' ? 'warn' : v === 'approvata' ? 'success' : 'error'),
    })
    expect(o).toEqual([
      { valore: 'approvata', etichetta: 'Approvata', conteggio: 1, tono: 'success' },
      { valore: 'in_attesa', etichetta: 'In attesa', conteggio: 2, tono: 'warn' },
      { valore: 'respinta', etichetta: 'Respinta', conteggio: 1, tono: 'error' },
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('§9 · decidiStatoElenco — «vuoto» e «nessun risultato» non sono la stessa cosa', () => {
  // ⚠️ `nAttivi` NON è un ingrediente di questa decisione, ed è una scelta: se lo
  // fosse, «tabella vuota» diventerebbe «nessun risultato» appena c'è un filtro
  // acceso — cioè l'accusa che questo stato esiste per non fare. Ciò che conta è
  // `totale`: quante righe esistono SENZA filtri.
  const pronto = { caricamento: false, errore: false, totale: 10, mostrati: 3 }

  it('con righe da mostrare non c’è nessuno stato da rendere', () => {
    expect(decidiStatoElenco(pronto)).toBe('pronto')
  })

  it('prima lettura → caricamento', () => {
    expect(decidiStatoElenco({ ...pronto, caricamento: true, totale: 0, mostrati: 0 })).toBe('caricamento')
  })

  it('mentre si ricarica, le righe già a schermo restano: non è più «caricamento»', () => {
    // È la micro-interazione che fa la differenza: sostituire la tabella con uno
    // spinner a ogni tasto è il difetto peggiore di una barra filtri.
    expect(decidiStatoElenco({ ...pronto, caricamento: true })).toBe('pronto')
  })

  it('tabella vuota SENZA filtri → «vuoto»: i filtri non c’entrano', () => {
    expect(decidiStatoElenco({ ...pronto, totale: 0, mostrati: 0 })).toBe('vuoto')
  })

  it('tabella vuota CON filtri → sempre «vuoto»: accusare i filtri sarebbe falso', () => {
    // 5 linguette su 13 hanno zero righe in produzione: è il caso normale, non il
    // caso limite. «Nessun risultato con questi filtri» su una tabella che non ha
    // MAI avuto una riga manda la segreteria a cercare un filtro che non esiste.
    expect(decidiStatoElenco({ ...pronto, totale: 0, mostrati: 0 })).toBe('vuoto')
  })

  it('righe esistenti ma nessuna passa i filtri → «senzaRisultati»', () => {
    expect(decidiStatoElenco({ ...pronto, totale: 387, mostrati: 0 })).toBe('senzaRisultati')
  })

  it('una lettura FALLITA con i filtri attivi non è mai «senzaRisultati»', () => {
    // Manderebbe la segreteria a togliere filtri per un guasto che non è suo.
    expect(decidiStatoElenco({ caricamento: false, errore: true, totale: 387, mostrati: 0 })).toBe('errore')
    expect(decidiStatoElenco({ caricamento: true, errore: true, totale: 0, mostrati: 0 })).toBe('errore')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('§10 · ricerca-postgrest — la sanificazione `.or()` in UN posto solo', () => {
  // Le due copie scritte a mano oggi nel repo, ricopiate qui alla lettera:
  //   · src/app/api/admin/protocolli/route.ts:130     → /[,()%]/g
  //   · src/app/api/documenti-firmati/route.ts:132    → /[%,()]/g
  // Stesso insieme di caratteri, ordine diverso: due copie riscritte a memoria.
  // L'helper deve produrre la STESSA identica stringa di entrambe, altrimenti
  // adottarlo cambierebbe il comportamento di due rotte in produzione.
  const comeProtocolli = (t: string) => t.replace(/[,()%]/g, ' ').trim()
  const comeDocumentiFirmati = (t: string) => t.replace(/[%,()]/g, ' ').trim()

  const BATTERIA = [
    'nulla osta',
    '  spazi  attorno  ',
    'virgola, dentro',
    '100% (urgente)',
    'a,b(c)d%e',
    '%%%',
    ',,,',
    '',
    '   ',
    'Sant’Agnello',
    'délibéra',
  ]

  it('produce byte per byte la stessa stringa delle due copie esistenti', () => {
    for (const testo of BATTERIA) {
      expect(termineOr(testo), `sanificazione diversa da protocolli su «${testo}»`).toBe(comeProtocolli(testo))
      expect(termineOr(testo), `sanificazione diversa da documenti-firmati su «${testo}»`).toBe(comeDocumentiFirmati(testo))
    }
  })

  it('e le due copie erano davvero d’accordo fra loro (se non lo fossero, il confronto sopra sarebbe inutile)', () => {
    for (const testo of BATTERIA) expect(comeProtocolli(testo)).toBe(comeDocumentiFirmati(testo))
  })

  it('un termine che si annulla del tutto torna stringa vuota: il chiamante NON deve filtrare', () => {
    // `.or('nome.ilike.%%')` non è «nessun filtro»: è un filtro che passa tutto,
    // scritto in un modo che sembra una restrizione.
    expect(termineOr(' , ( ) % ')).toBe('')
  })

  it('orIlike compone le condizioni come le due rotte le scrivono a mano', () => {
    expect(orIlike(['oggetto', 'mittente', 'destinatario'], 'nulla osta')).toBe(
      'oggetto.ilike.%nulla osta%,mittente.ilike.%nulla osta%,destinatario.ilike.%nulla osta%',
    )
    expect(orIlike(['nome', 'cognome'], 'ross')).toBe('nome.ilike.%ross%,cognome.ilike.%ross%')
  })

  it('orIlike rifiuta un termine vuoto invece di produrre un filtro che passa tutto', () => {
    expect(orIlike(['nome'], '')).toBe('')
    expect(orIlike([], 'ross')).toBe('')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('§11 · restringiSedi — la sede del client INTERSECA, non sostituisce', () => {
  const A = SEDE_A
  const B = SEDE_B

  it('senza sede richiesta restituisce le sedi attive, intatte', () => {
    expect(restringiSedi([A, B])).toEqual([A, B])
    expect(restringiSedi([A, B], undefined)).toEqual([A, B])
    expect(restringiSedi([A, B], '')).toEqual([A, B])
  })

  it('con una sede richiesta restringe a quella sola', () => {
    expect(restringiSedi([A, B], B)).toEqual([B])
  })

  it('una sede NON accessibile non allarga niente: torna `null`, cioè «rifiuta»', () => {
    expect(restringiSedi([A], B)).toBeNull()
    expect(restringiSedi([], B)).toBeNull()
  })

  it('il confronto ignora le maiuscole e restituisce la forma CANONICA del database', () => {
    // In Postgres `uuid` è un tipo: 'AAAA…' e 'aaaa…' sono lo stesso valore. In
    // JavaScript no — ed è il difetto che `formaConfronto` esiste per chiudere.
    expect(restringiSedi([A, B], A.toUpperCase())).toEqual([A])
  })

  it('nessuna sede accessibile e nessuna richiesta: elenco vuoto, non diniego', () => {
    // `[]` significa «non hai plessi» e i chiamanti lo trattano come elenco
    // vuoto; `null` significa «hai chiesto un plesso che non è tuo» → 403.
    expect(restringiSedi([])).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('§12 · gli schemi zod condivisi', () => {
  it('zOpzionale: stringa vuota e null diventano `undefined`', () => {
    const s = z.object({ v: zOpzionale(z.string().max(10)) })
    expect(s.parse({ v: '' })).toEqual({ v: undefined })
    expect(s.parse({ v: null })).toEqual({ v: undefined })
    expect(s.parse({})).toEqual({ v: undefined })
    expect(s.parse({ v: 'ciao' })).toEqual({ v: 'ciao' })
    expect(s.safeParse({ v: 'undici-caratteri' }).success).toBe(false)
  })

  it('zTestoRicerca: facoltativo, con un tetto che impedisce una query smisurata', () => {
    const s = z.object({ q: zTestoRicerca })
    expect(s.parse({ q: '' })).toEqual({ q: undefined })
    expect(s.parse({ q: 'nulla osta' })).toEqual({ q: 'nulla osta' })
    expect(s.safeParse({ q: 'x'.repeat(201) }).success).toBe(false)
  })

  it('zPeriodo: due estremi facoltativi, nominati `<chiave>Da` e `<chiave>A`', () => {
    const s = z.object({ ...zPeriodo('data').shape })
    expect(s.parse({ dataDa: '', dataA: '2026-03-31' })).toEqual({ dataDa: undefined, dataA: '2026-03-31' })
    expect(s.safeParse({ dataDa: '2026-02-30' }).success).toBe(false) // data inesistente
    expect(s.safeParse({ dataDa: '31/03/2026' }).success).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('§13 · testo-ricerca — un solo posto per la normalizzazione', () => {
  it('normalizza accenti, apostrofi (di tre specie) e spazi', () => {
    expect(normalizzaTesto('Forlì')).toBe('forli')
    expect(normalizzaTesto("Sant'Agnello")).toBe('sant agnello')
    expect(normalizzaTesto('Sant’Agnello')).toBe('sant agnello')
    expect(normalizzaTesto('  DUE   spazi ')).toBe('due spazi')
  })

  it('il rango distingue inizio stringa, inizio parola e dentro una parola', () => {
    expect(rangoDiMatch('rivarolo canavese', 'riva')).toBe(0)
    expect(rangoDiMatch('rivarolo canavese', 'canav')).toBe(1)
    expect(rangoDiMatch('rivarolo canavese', 'varo')).toBe(2)
    expect(rangoDiMatch('rivarolo canavese', 'zzz')).toBeNull()
  })

  it('`Combobox` continua a esportare le STESSE funzioni, non una copia', () => {
    // Il campo dei comuni si regge su queste due: se lo spostamento le avesse
    // duplicate, le due copie divergerebbero al primo aggiustamento.
    expect(normalizzaDaCombobox).toBe(normalizzaTesto)
    expect(rangoDaCombobox).toBe(rangoDiMatch)
  })
})
