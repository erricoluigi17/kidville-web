import { describe, it, expect } from 'vitest'
import {
    totaleTicket,
    importoRiga,
    totaleComposizione,
    quadra,
    scartoQuadratura,
    violazioniRighe,
    violazioniComposizione,
    puoConfermare,
    proponiAncora,
    sediCoinvolte,
    proponiAllocazioneSuVoci,
    rigaDaVoceAperta,
    round2,
    type RigaComposizione,
    type RigaEsistente,
    type RigaNuova,
    type RigaTicket,
} from '@/lib/pagamenti/conciliazione-composita'

// Motore PURO della composizione di un bonifico (F4). Nessun I/O, nessun React,
// nessun Supabase: è la stessa aritmetica che devono usare la route e il
// componente, perché due implementazioni della quadratura sono due verdetti
// diversi sullo stesso bonifico.

const SEDE_A = '11111111-1111-4111-8111-111111111111'
const SEDE_B = '22222222-2222-4222-8222-222222222222'
const SEDE_C = '33333333-3333-4333-8333-333333333333'
const ALUNNO = '44444444-4444-4444-8444-444444444444'

const esistente = (p: Partial<RigaEsistente> = {}): RigaEsistente => ({
    specie: 'esistente',
    pagamentoId: 'pag-1',
    alunnoId: ALUNNO,
    scuolaId: SEDE_A,
    categoriaSlug: 'extra',
    descrizione: 'Uscita didattica',
    residuo: 100,
    importo: 100,
    ...p,
})

const nuova = (p: Partial<RigaNuova> = {}): RigaNuova => ({
    specie: 'nuova',
    alunnoId: ALUNNO,
    scuolaId: SEDE_A,
    categoriaId: 'cat-extra',
    categoriaSlug: 'extra',
    descrizione: 'Materiale didattico',
    importo: 50,
    ...p,
})

const ticket = (p: Partial<RigaTicket> = {}): RigaTicket => ({
    specie: 'ticket',
    alunnoId: ALUNNO,
    scuolaId: SEDE_A,
    quantita: 20,
    costoUnitario: 2.5,
    ...p,
})

// ─── totaleTicket: il totale è CALCOLATO, mai digitato ────────────────────────

describe('totaleTicket', () => {
    it('20 ticket da 2,50 fanno 50,00', () => {
        expect(totaleTicket(20, 2.5)).toBe(50)
    })

    it('arrotonda a 2 decimali (3 × 0,335 non resta a 1,0049999…)', () => {
        expect(totaleTicket(3, 0.335)).toBe(1.01)
    })

    it('a costo 0 il totale è 0 — è aritmetica, non un permesso', () => {
        // ⚠️ Il titolo diceva «costo unitario 0 è ammesso (ricarica in omaggio)», e dal
        // 2026-09-12 non è più vero: a dire che quella riga non si può confermare è
        // `violazioniRighe` (`costo_unitario_non_positivo`), perché la RPC rifiuta un
        // incasso da zero. `totaleTicket` non giudica: calcola, e deve continuare a
        // farlo anche su una riga che il gate rifiuterà, perché è la funzione che il
        // pannello chiama per mostrare «20 × 0,00 = 0,00 €» accanto ai due campi
        // mentre l'operatrice digita. Chi giudica e chi conta restano due mestieri.
        expect(totaleTicket(20, 0)).toBe(0)
        expect(violazioniRighe([ticket({ quantita: 20, costoUnitario: 0 })])).toEqual([
            { indice: 0, codice: 'costo_unitario_non_positivo' },
        ])
    })
})

// ─── importoRiga: una sola aritmetica per tutte e tre le specie ───────────────

describe('importoRiga', () => {
    it('voce esistente → il proprio importo, arrotondato', () => {
        expect(importoRiga(esistente({ importo: 33.333 }))).toBe(33.33)
    })

    it('voce nuova → il proprio importo, arrotondato', () => {
        expect(importoRiga(nuova({ importo: 12.005 }))).toBe(12.01)
    })

    it('ticket → delega a totaleTicket, NON legge un importo digitato', () => {
        expect(importoRiga(ticket({ quantita: 20, costoUnitario: 2.5 }))).toBe(50)
    })
})

// ─── totaleComposizione e quadratura ─────────────────────────────────────────

describe('totaleComposizione', () => {
    it('somma le tre specie insieme', () => {
        const righe: RigaComposizione[] = [
            esistente({ importo: 120 }),
            nuova({ importo: 30 }),
            ticket({ quantita: 20, costoUnitario: 2.5 }),
        ]
        expect(totaleComposizione(righe)).toBe(200)
    })

    it('tre righe da 0,10 fanno 0,30 esatti (niente 0.30000000000000004)', () => {
        const righe = [nuova({ importo: 0.1 }), nuova({ importo: 0.1 }), nuova({ importo: 0.1 })]
        expect(totaleComposizione(righe)).toBe(0.3)
    })

    it('arrotonda al centesimo A OGNI PASSO: 3 × 33,333 fa 99,99 e non 100', () => {
        // Somma nuda 99,999: senza arrotondamento per passo il totale «quadrerebbe»
        // con un bonifico da 100 € pur essendo fatto di righe che valgono 99,99.
        // ⚠️ Onestà su questo test: finché ogni riga è già al centesimo (lo garantisce
        // `importoRiga`), arrotondare a ogni passo e arrotondare solo alla fine danno
        // lo STESSO numero — la somma di valori a 2 decimali è a 2 decimali e l'errore
        // binario resta sotto il mezzo centesimo per qualunque quantità realistica di
        // righe. Quello che questi test bloccano è che l'arrotondamento CI SIA; la sua
        // posizione non è osservabile, e fingere il contrario sarebbe un test decorativo.
        const righe = [nuova({ importo: 33.333 }), nuova({ importo: 33.333 }), nuova({ importo: 33.333 })]
        expect(totaleComposizione(righe)).toBe(99.99)
    })

    it('duecento righe da un centesimo fanno 2,00 esatti (nessuna deriva sul volume)', () => {
        const righe = Array.from({ length: 200 }, () => nuova({ importo: 0.01 }))
        expect(totaleComposizione(righe)).toBe(2)
        expect(quadra(righe, 2)).toBe(true)
    })

    it('nessuna riga → 0', () => {
        expect(totaleComposizione([])).toBe(0)
    })
})

describe('quadra / scartoQuadratura', () => {
    it('quadratura esatta al centesimo → vero, scarto 0', () => {
        const righe = [esistente({ importo: 120.45 }), ticket({ quantita: 2, costoUnitario: 2.5 })]
        expect(quadra(righe, 125.45)).toBe(true)
        expect(scartoQuadratura(righe, 125.45)).toBe(0)
    })

    it('un centesimo di differenza NON quadra: nessuna tolleranza oltre il centesimo', () => {
        const righe = [esistente({ importo: 100 })]
        expect(quadra(righe, 100.01)).toBe(false)
        expect(quadra(righe, 99.99)).toBe(false)
    })

    it('un centesimo NON quadra nemmeno dove una tolleranza «di un centesimo» lo assorbirebbe', () => {
        // 100,01 contro 100,02: |100.01 − 100.02| = 0.009999999999990905, cioè MINORE
        // di 0,01. Una quadratura scritta come `Math.abs(scarto) <= 0.01` direbbe che
        // questo bonifico quadra. La coppia 100 / 100,01 non lo mostrerebbe: lì la
        // differenza binaria è 0.010000000000005116, sopra la soglia per caso.
        const righe = [esistente({ importo: 100.01 })]
        expect(quadra(righe, 100.02)).toBe(false)
        expect(scartoQuadratura(righe, 100.02)).toBe(-0.01)
    })

    it('righe in difetto rispetto al bonifico → scarto NEGATIVO (manca)', () => {
        const righe = [esistente({ importo: 90 })]
        expect(quadra(righe, 100)).toBe(false)
        expect(scartoQuadratura(righe, 100)).toBe(-10)
    })

    it('righe in eccesso rispetto al bonifico → scarto POSITIVO (avanza)', () => {
        const righe = [esistente({ importo: 110 })]
        expect(quadra(righe, 100)).toBe(false)
        expect(scartoQuadratura(righe, 100)).toBe(10)
    })

    it('i centesimi in virgola mobile non producono uno scarto fantasma', () => {
        const righe = [nuova({ importo: 0.1 }), nuova({ importo: 0.1 }), nuova({ importo: 0.1 })]
        expect(scartoQuadratura(righe, 0.3)).toBe(0)
        expect(quadra(righe, 0.3)).toBe(true)
    })

    it('nessuna riga contro un bonifico → scarto pari a tutto il bonifico, in difetto', () => {
        expect(quadra([], 250)).toBe(false)
        expect(scartoQuadratura([], 250)).toBe(-250)
    })
})

// ─── violazioniRighe: perché NON si può confermare, e su quale riga ──────────

describe('violazioniRighe', () => {
    it('composizione valida → nessuna violazione', () => {
        const righe: RigaComposizione[] = [esistente(), nuova(), ticket()]
        expect(violazioniRighe(righe)).toEqual([])
    })

    it('importo 0 o negativo su una voce → importo_non_positivo, con l\'indice della riga', () => {
        expect(violazioniRighe([nuova({ importo: 0 })])).toEqual([{ indice: 0, codice: 'importo_non_positivo' }])
        expect(violazioniRighe([esistente({ importo: -5 })])).toEqual([
            { indice: 0, codice: 'importo_non_positivo' },
        ])
    })

    it('quantità ticket 0 o negativa → quantita_non_valida', () => {
        expect(violazioniRighe([ticket({ quantita: 0 })])).toEqual([{ indice: 0, codice: 'quantita_non_valida' }])
        expect(violazioniRighe([ticket({ quantita: -3 })])).toEqual([{ indice: 0, codice: 'quantita_non_valida' }])
    })

    it('quantità ticket non intera → quantita_non_valida (i ticket non si spezzano)', () => {
        expect(violazioniRighe([ticket({ quantita: 2.5 })])).toEqual([{ indice: 0, codice: 'quantita_non_valida' }])
    })

    it('costo unitario 0 → costo_unitario_non_positivo: la RPC rifiuta un incasso da zero', () => {
        // ⚠️ Questo test asseriva l'OPPOSTO fino al 2026-09-12 («costo unitario 0 è
        // AMMESSO, ricarica in omaggio»), e il motore lo rispettava: misurato,
        // `violazioniRighe([ticket 20 × 0])` = `[]` e `puoConfermare([nuova 100,
        // ticket 20 × 0], 100)` = **true**. Cioè il gate accendeva «Conferma» su un
        // payload che la RPC della stessa branch rifiuta:
        // `20260912180100_transazione_voci_nuove.sql:486-491` —
        // `IF v_costo IS NULL OR v_costo <= 0 THEN RAISE EXCEPTION 'voce ticket #%:
        // costo_unitario deve essere > 0'`. E la ragione è strutturale, non un
        // capriccio della RPC: a costo zero la riga vale `0.00` e l'INSERT in
        // `incassi` viola `incassi_importo_check CHECK (importo <> 0)`, SQLSTATE
        // 23514. L'operatrice avrebbe visto un pulsante verde e un 500.
        //
        // La giustificazione caduta era «gli stessi vincoli del check storico su
        // `pagamenti/ticket`» (`costo >= 0`): vera di QUELLA route, che però
        // `RigaTicket` non alimenta — i suoi campi sono quelli del blocco
        // `voci_ticket`, non di `ricariche_mensa`, che prende un `importo`.
        // In conciliazione il ticket si PAGA; la ricarica in omaggio resta possibile
        // dalla strada che già esiste (`ricariche_mensa`), che non passa da `incassi`.
        expect(violazioniRighe([ticket({ quantita: 10, costoUnitario: 0 })])).toEqual([
            { indice: 0, codice: 'costo_unitario_non_positivo' },
        ])
        expect(puoConfermare([nuova({ importo: 100 }), ticket({ quantita: 20, costoUnitario: 0 })], 100)).toBe(false)
    })

    it('costo unitario negativo → costo_unitario_negativo', () => {
        expect(violazioniRighe([ticket({ costoUnitario: -1 })])).toEqual([
            { indice: 0, codice: 'costo_unitario_negativo' },
        ])
    })

    it('importo di una voce esistente che SUPERA il residuo → oltre_residuo', () => {
        expect(violazioniRighe([esistente({ residuo: 100, importo: 120 })])).toEqual([
            { indice: 0, codice: 'oltre_residuo' },
        ])
    })

    it('importo esattamente pari al residuo → ammesso', () => {
        expect(violazioniRighe([esistente({ residuo: 100, importo: 100 })])).toEqual([])
    })

    it('UN centesimo oltre il residuo è già oltre il residuo: nessuna tolleranza', () => {
        // ⚠️ La soglia di questa regola non era presidiata da niente. Misurato il
        // 2026-09-12: allentandola di un centesimo — `importoRiga(riga) >
        // round2(num(riga.residuo)) + 0.01` — la suite restava **86 passed**, cioè si
        // poteva regalare un centesimo per riga senza che un solo test se ne
        // accorgesse. Il file pretende il contrario da sé («Nessuna tolleranza oltre
        // il centesimo … una tolleranza "piccola" è comunque denaro che nessuno ha
        // assegnato a nessuno») e su `quadra` quella soglia È presidiata: qui no.
        // 100,01 su un residuo di 100 è il caso minimo che lo dimostra, e il mutante
        // col +0,01 lo lascia passare perché `100.01 > round2(100) + 0.01` è falso.
        expect(violazioniRighe([esistente({ residuo: 100, importo: 100.01 })])).toEqual([
            { indice: 0, codice: 'oltre_residuo' },
        ])
    })

    it('il confronto col residuo avviene al centesimo, non sui bit', () => {
        // L'IMPORTO porta il rumore binario (0.1+0.2 = 0.30000000000000004) e il residuo
        // è pulito: confrontando i bit invece dei centesimi la riga risulterebbe «oltre
        // il residuo» e bloccherebbe un incasso perfettamente valido.
        expect(violazioniRighe([esistente({ residuo: 0.3, importo: 0.1 + 0.2 })])).toEqual([])
        // …e il caso speculare, col rumore dalla parte del residuo.
        expect(violazioniRighe([esistente({ residuo: 0.1 + 0.2, importo: 0.3 })])).toEqual([])
    })

    it('alunno mancante → alunno_mancante, su qualunque specie', () => {
        expect(violazioniRighe([esistente({ alunnoId: null })])).toEqual([{ indice: 0, codice: 'alunno_mancante' }])
        expect(violazioniRighe([nuova({ alunnoId: '' })])).toEqual([{ indice: 0, codice: 'alunno_mancante' }])
        expect(violazioniRighe([ticket({ alunnoId: null })])).toEqual([{ indice: 0, codice: 'alunno_mancante' }])
    })

    it('sede mancante → sede_mancante, su qualunque specie', () => {
        // Misurato prima di questa regola: `violazioniRighe([nuova({ scuolaId: null })])`
        // = `[]` e `puoConfermare(…, 100)` = **true**. Il commento di `sediCoinvolte`
        // dichiarava però che «la loro assenza è un problema della riga»: non lo era di
        // nessuno. E il vincolo è di progetto — «ogni scrittura dichiara la sua sede»,
        // perché chi la indovina archivia nel plesso sbagliato in silenzio.
        expect(violazioniRighe([esistente({ scuolaId: null })])).toEqual([{ indice: 0, codice: 'sede_mancante' }])
        expect(violazioniRighe([nuova({ scuolaId: '   ' })])).toEqual([{ indice: 0, codice: 'sede_mancante' }])
        expect(violazioniRighe([ticket({ scuolaId: null })])).toEqual([{ indice: 0, codice: 'sede_mancante' }])
    })

    it('alunno e sede mancanti insieme → due violazioni sulla stessa riga', () => {
        expect(violazioniRighe([nuova({ alunnoId: null, scuolaId: null })])).toEqual([
            { indice: 0, codice: 'alunno_mancante' },
            { indice: 0, codice: 'sede_mancante' },
        ])
    })

    it('il gate dice NO a una riga senza sede, dove prima diceva SÌ', () => {
        expect(puoConfermare([nuova({ importo: 100, scuolaId: null })], 100)).toBe(false)
        expect(puoConfermare([nuova({ importo: 100, scuolaId: '' })], 100)).toBe(false)
        // …e la stessa composizione, con la sede, passa: la regola non blocca un
        // percorso legittimo — le righe arrivano sempre con una sede nota.
        expect(puoConfermare([nuova({ importo: 100, scuolaId: SEDE_A })], 100)).toBe(true)
    })

    it('descrizione vuota o di soli spazi su una voce → descrizione_vuota', () => {
        expect(violazioniRighe([nuova({ descrizione: '   ' })])).toEqual([{ indice: 0, codice: 'descrizione_vuota' }])
        expect(violazioniRighe([esistente({ descrizione: '' })])).toEqual([{ indice: 0, codice: 'descrizione_vuota' }])
    })

    it('categoria mancante su una voce NUOVA → categoria_mancante (l\'esistente ce l\'ha già)', () => {
        expect(violazioniRighe([nuova({ categoriaId: null })])).toEqual([{ indice: 0, codice: 'categoria_mancante' }])
        expect(violazioniRighe([esistente({ categoriaSlug: null })])).toEqual([])
    })

    it('più violazioni su più righe: ciascuna porta l\'indice della propria riga', () => {
        const righe: RigaComposizione[] = [
            esistente(),
            nuova({ importo: 0, categoriaId: null }),
            ticket({ quantita: 0 }),
        ]
        expect(violazioniRighe(righe)).toEqual([
            { indice: 1, codice: 'importo_non_positivo' },
            { indice: 1, codice: 'categoria_mancante' },
            { indice: 2, codice: 'quantita_non_valida' },
        ])
    })
})

// ─── lo STESSO pagamentoId su più righe: il residuo incassato due volte ──────

describe('violazioniRighe · più righe sulla STESSA voce', () => {
    it('due righe sulla stessa voce non possono incassarne il residuo DUE volte', () => {
        // Misurato prima della correzione: `violazioniRighe` = [], totale 200,
        // `puoConfermare(righe, 200)` = **true**. Cioè il gate autorizzava a incassare
        // 200 € su una voce che di residuo ne ha 100: 100 € assegnati a nulla, che
        // `residuoEffettivo` tronca a 0 in silenzio. Numeri di tutti i giorni, non
        // astronomici — e l'elenco con id ripetuti nasce davvero, concatenando le voci
        // aperte di due fratelli o da un ritento.
        const righe: RigaComposizione[] = [
            esistente({ pagamentoId: 'RETTA-MARZO', residuo: 100, importo: 100 }),
            esistente({ pagamentoId: 'RETTA-MARZO', residuo: 100, importo: 100 }),
        ]
        expect(totaleComposizione(righe)).toBe(200)
        expect(puoConfermare(righe, 200)).toBe(false)
    })

    it('la violazione sta su TUTTE le righe di quella voce, non solo sull\'ultima', () => {
        // L'operatrice deve vedere la COPPIA: presa una per una ciascuna riga è dentro
        // il residuo, quindi evidenziarne una sola le direbbe di cancellare quella —
        // senza farle capire che il problema è la ripetizione.
        const righe: RigaComposizione[] = [
            esistente({ pagamentoId: 'RETTA-MARZO', residuo: 100, importo: 100 }),
            esistente({ pagamentoId: 'RETTA-MARZO', residuo: 100, importo: 100 }),
        ]
        expect(violazioniRighe(righe)).toEqual([
            { indice: 0, codice: 'oltre_residuo_aggregato' },
            { indice: 1, codice: 'oltre_residuo_aggregato' },
        ])
    })

    it('vale anche per tre righe che sforano solo SOMMATE', () => {
        const righe = Array.from({ length: 3 }, () =>
            esistente({ pagamentoId: 'RETTA-MARZO', residuo: 50, importo: 50 }),
        )
        expect(totaleComposizione(righe)).toBe(150)
        expect(puoConfermare(righe, 150)).toBe(false)
    })

    it('il codice è DIVERSO da `oltre_residuo`: nessuna di quelle righe sfora da sola', () => {
        // Riusare `oltre_residuo` direbbe all'operatrice «importo oltre il residuo» su
        // una riga da 100 € su un residuo da 100 €: un messaggio che la misura smentisce.
        const righe: RigaComposizione[] = [
            esistente({ pagamentoId: 'X', residuo: 100, importo: 100 }),
            esistente({ pagamentoId: 'X', residuo: 100, importo: 100 }),
        ]
        expect(violazioniRighe([righe[0]])).toEqual([])
        expect(violazioniRighe(righe).every((v) => v.codice === 'oltre_residuo_aggregato')).toBe(true)
    })

    it('due righe sulla stessa voce che INSIEME ci stanno restano valide', () => {
        // Controllo negativo: senza, una regola che segnalasse ogni id ripetuto sarebbe
        // verde su questo test e bloccherebbe un incasso legittimo.
        const righe: RigaComposizione[] = [
            esistente({ pagamentoId: 'RETTA-MARZO', residuo: 100, importo: 60 }),
            esistente({ pagamentoId: 'RETTA-MARZO', residuo: 100, importo: 40 }),
        ]
        expect(violazioniRighe(righe)).toEqual([])
        expect(puoConfermare(righe, 100)).toBe(true)
    })

    it('voci DIVERSE non si sommano fra loro', () => {
        const righe: RigaComposizione[] = [
            esistente({ pagamentoId: 'RETTA-MARZO', residuo: 100, importo: 100 }),
            esistente({ pagamentoId: 'RETTA-APRILE', residuo: 100, importo: 100 }),
        ]
        expect(violazioniRighe(righe)).toEqual([])
        expect(puoConfermare(righe, 200)).toBe(true)
    })

    it('residui divergenti sullo stesso id → vince il PIÙ PICCOLO', () => {
        // Due letture dello stesso pagamento in momenti diversi (una stantia) portano
        // due residui. Il tetto è quello più prudente: non si assegna mai al bonifico
        // più denaro di quanto la voce, nella lettura più recente, possa reggere.
        const righe: RigaComposizione[] = [
            esistente({ pagamentoId: 'RETTA-MARZO', residuo: 100, importo: 40 }),
            esistente({ pagamentoId: 'RETTA-MARZO', residuo: 60, importo: 40 }),
        ]
        expect(violazioniRighe(righe)).toEqual([
            { indice: 0, codice: 'oltre_residuo_aggregato' },
            { indice: 1, codice: 'oltre_residuo_aggregato' },
        ])
        // …e sotto il tetto prudente la stessa coppia passa
        const sotto: RigaComposizione[] = [
            esistente({ pagamentoId: 'RETTA-MARZO', residuo: 100, importo: 30 }),
            esistente({ pagamentoId: 'RETTA-MARZO', residuo: 60, importo: 30 }),
        ]
        expect(violazioniRighe(sotto)).toEqual([])
    })

    it('un pagamentoId vuoto non identifica una voce: due righe così non si sommano', () => {
        // Raggruppare per stringa vuota accuserebbe di «doppio incasso» due righe che
        // non si sa nemmeno se siano la stessa voce.
        const righe: RigaComposizione[] = [
            esistente({ pagamentoId: '', residuo: 100, importo: 100 }),
            esistente({ pagamentoId: '   ', residuo: 100, importo: 100 }),
        ]
        expect(violazioniRighe(righe)).toEqual([])
    })

    it('UN centesimo oltre il residuo AGGREGATO è già oltre: nessuna tolleranza nemmeno qui', () => {
        // Stessa prova della soglia per riga, sull'altra regola di residuo. Misurato:
        // il mutante `g.somma > g.tetto + 0.01` lasciava la suite a **86 passed**.
        // 50 + 50,01 su un residuo da 100 è il caso minimo: nessuna delle due righe
        // sfora da sola (50 < 100), quindi senza la regola aggregata non resta niente
        // a dirlo — e col +0,01 la somma 100,01 non supera il tetto allentato.
        const righe: RigaComposizione[] = [
            esistente({ pagamentoId: 'RETTA-MARZO', residuo: 100, importo: 50 }),
            esistente({ pagamentoId: 'RETTA-MARZO', residuo: 100, importo: 50.01 }),
        ]
        expect(violazioniRighe(righe)).toEqual([
            { indice: 0, codice: 'oltre_residuo_aggregato' },
            { indice: 1, codice: 'oltre_residuo_aggregato' },
        ])
        expect(puoConfermare(righe, 100.01)).toBe(false)
    })

    it('un residuo dichiarato FUORI SCALA non è un residuo: il tetto aggregato vale 0', () => {
        // Presidia l'`al2` sul TETTO di `vociOltreIlResiduoAggregato`. Il commento
        // della funzione dichiara questo comportamento «misurato», e lo è — ma
        // nessun test lo reggeva: sostituendo quell'`al2` con `round2` la suite
        // restava **86 passed** e il verdetto si RIBALTAVA, perché `round2(1e308)` è
        // `Infinity`, un tetto infinito sta sopra qualunque somma e non accusa mai.
        // È la stessa classe di M10, due volte, nella funzione appena scritta.
        const righe: RigaComposizione[] = [
            esistente({ pagamentoId: 'RETTA-MARZO', residuo: 1e308, importo: 100 }),
            esistente({ pagamentoId: 'RETTA-MARZO', residuo: 1e308, importo: 100 }),
        ]
        expect(violazioniRighe(righe)).toEqual([
            { indice: 0, codice: 'oltre_residuo_aggregato' },
            { indice: 1, codice: 'oltre_residuo_aggregato' },
        ])
    })

    it('una SOMMA fuori scala non accusa al posto delle righe: parla `oltre_residuo`, riga per riga', () => {
        // Presidia l'`al2` sulla SOMMA, che mente nella direzione opposta: una somma
        // `Infinity` starebbe sopra qualunque tetto e accuserebbe SEMPRE. Col mutante
        // `round2` la suite restava **86 passed** e queste due righe portavano anche
        // `oltre_residuo_aggregato`, cioè «la voce compare due volte» detto di due
        // righe cha sforano ciascuna da sola — il difetto è già nominato riga per
        // riga, e l'aggregata aggiungerebbe solo un'accusa sbagliata.
        const righe: RigaComposizione[] = [
            esistente({ pagamentoId: 'RETTA-MARZO', residuo: 100, importo: 1e306 }),
            esistente({ pagamentoId: 'RETTA-MARZO', residuo: 100, importo: 1e306 }),
        ]
        expect(violazioniRighe(righe)).toEqual([
            { indice: 0, codice: 'oltre_residuo' },
            { indice: 1, codice: 'oltre_residuo' },
        ])
    })

    it('lo stesso id con spazi attorno è lo STESSO id: «A» e « A » si raggruppano', () => {
        // Presidia il `.trim()` di `idVoce`. Misurato: togliendolo, la suite restava
        // **86 passed** — il test sull'id vuoto non lo copre, perché lì la riga con
        // `'   '` finisce comunque in un gruppo da una riga sola e l'aggregata tace
        // per il `quante > 1`. Senza `trim`, due letture della stessa voce che
        // differiscono per uno spazio (un id copiato da un foglio, un JSON con un
        // campo non normalizzato) tornerebbero a incassare due volte lo stesso
        // residuo, che è esattamente il difetto che questa regola esiste per chiudere.
        const righe: RigaComposizione[] = [
            esistente({ pagamentoId: 'A', residuo: 100, importo: 100 }),
            esistente({ pagamentoId: ' A ', residuo: 100, importo: 100 }),
        ]
        expect(violazioniRighe(righe)).toEqual([
            { indice: 0, codice: 'oltre_residuo_aggregato' },
            { indice: 1, codice: 'oltre_residuo_aggregato' },
        ])
        expect(puoConfermare(righe, 200)).toBe(false)
    })

    it('la riga che sfora DA SOLA porta entrambi i codici, e sono due fatti veri', () => {
        const righe: RigaComposizione[] = [
            esistente({ pagamentoId: 'X', residuo: 100, importo: 120 }),
            esistente({ pagamentoId: 'X', residuo: 100, importo: 10 }),
        ]
        expect(violazioniRighe(righe)).toEqual([
            { indice: 0, codice: 'oltre_residuo' },
            { indice: 0, codice: 'oltre_residuo_aggregato' },
            { indice: 1, codice: 'oltre_residuo_aggregato' },
        ])
    })
})

// ─── violazioniComposizione: i guai che NON stanno su nessuna riga ───────────

describe('violazioniComposizione', () => {
    it('composizione con almeno una riga contro un movimento positivo → nessuna violazione', () => {
        expect(violazioniComposizione([nuova()], 100)).toEqual([])
    })

    it('zero righe → composizione_vuota (un bonifico non si concilia col nulla)', () => {
        expect(violazioniComposizione([], 100)).toContain('composizione_vuota')
    })

    it('movimento a zero → movimento_non_positivo', () => {
        expect(violazioniComposizione([nuova()], 0)).toContain('movimento_non_positivo')
    })

    it('movimento negativo → movimento_non_positivo', () => {
        expect(violazioniComposizione([nuova()], -50)).toContain('movimento_non_positivo')
    })

    it('zero righe contro un movimento a zero → ENTRAMBE le violazioni, non la prima soltanto', () => {
        const v = violazioniComposizione([], 0)
        expect(v).toContain('composizione_vuota')
        expect(v).toContain('movimento_non_positivo')
    })

    it('importo del movimento NaN → movimento_non_positivo (non un silenzioso «quadra con 0»)', () => {
        expect(violazioniComposizione([], NaN)).toContain('movimento_non_positivo')
    })

    it('importo del movimento assente → movimento_non_positivo', () => {
        // Il tipo dice `number`, ma l'importo arriva da JSON/form: `undefined` ci passa
        // davvero, e `num()` lo trasforma in 0. Senza questa regola il gate direbbe «sì».
        expect(violazioniComposizione([nuova()], undefined as unknown as number)).toContain(
            'movimento_non_positivo',
        )
    })

    it('un centesimo è un movimento valido: la soglia è «> 0», non «abbastanza grande»', () => {
        expect(violazioniComposizione([nuova({ importo: 0.01 })], 0.01)).toEqual([])
    })

    it('un movimento sotto il mezzo centesimo NON è un incasso: vale 0, come in tutta la quadratura', () => {
        // 0,004 € al centesimo è 0: se qui si guardasse il grezzo invece di `round2`,
        // un movimento da mezzo millesimo risulterebbe «positivo» e la composizione
        // quadrerebbe a 0 contro di lui, che è di nuovo il sì detto senza sapere.
        expect(violazioniComposizione([nuova()], 0.004)).toContain('movimento_non_positivo')
    })

    it('il gate del pannello, senza questa funzione, direbbe SÌ al caso peggiore', () => {
        // Questo è il difetto misurato: righe vuote + movimento a 0 (o mancante) superano
        // il gate «nessuna violazione di riga E quadra», perché 0 === 0.
        expect(violazioniRighe([]).length === 0 && quadra([], 0)).toBe(true)
        expect(violazioniRighe([]).length === 0 && quadra([], NaN)).toBe(true)
        // Col gate completo il verdetto si ribalta, ed è l'unico verdetto giusto.
        const gateCompleto = (righe: RigaComposizione[], importo: number) =>
            violazioniRighe(righe).length === 0 &&
            violazioniComposizione(righe, importo).length === 0 &&
            quadra(righe, importo)
        expect(gateCompleto([], 0)).toBe(false)
        expect(gateCompleto([], NaN)).toBe(false)
        expect(gateCompleto([nuova({ importo: 100 })], 100)).toBe(true)
    })

    it('la regola di composizione NON si traveste da violazione di riga (nessun indice -1)', () => {
        // `Violazione.indice` deve restare un indice di riga VERO: una violazione con
        // indice -1 manderebbe la UI a evidenziare una riga che non esiste.
        expect(violazioniRighe([])).toEqual([])
        expect(violazioniRighe([nuova(), ticket()]).every((v) => v.indice >= 0)).toBe(true)
    })
})

// ─── Importi fuori scala: `round2` fabbrica Infinity da un input FINITO ──────

describe('importi fuori scala', () => {
    // `num()` scarta `NaN` e `Infinity` in INGRESSO, ma 1e308 è finito e ci passa
    // indisturbato: a fabbricare l'infinito è `round2`, che moltiplica per 100 prima
    // di dividere — `Math.round(1e310) / 100` è `Infinity`. Misurato PRIMA della
    // correzione: la riga gigante non produceva nessuna violazione, il movimento
    // gigante nemmeno, e il gate diceva SÌ perché `Infinity === Infinity`. È la
    // stessa specie del difetto di `violazioniComposizione`: il motore risponde «sì»
    // proprio dove non sa niente. E 1e308 è JSON perfettamente valido: arriva da un
    // body, o da un `<input type="number">` in cui qualcuno ha incollato qualcosa.

    it('una riga da 1e308 vale 0 e diventa importo_non_positivo', () => {
        expect(importoRiga(nuova({ importo: 1e308 }))).toBe(0)
        expect(violazioniRighe([nuova({ importo: 1e308 })])).toEqual([
            { indice: 0, codice: 'importo_non_positivo' },
        ])
    })

    it('un movimento da 1e308 diventa movimento_non_positivo', () => {
        expect(violazioniComposizione([nuova()], 1e308)).toContain('movimento_non_positivo')
    })

    it('trabocca anche il ticket: quantità × costo unitario non lo protegge `num()`', () => {
        // `num()` guarda i due fattori, non il prodotto: 1e200 × 1e200 è Infinity.
        expect(importoRiga(ticket({ quantita: 1e200, costoUnitario: 1e200 }))).toBe(0)
    })

    it('…e quello 0 del ticket ha finalmente un CODICE: prima il gate diceva SÌ', () => {
        // ⚠️ IL DIFETTO, misurato il 2026-09-12 sul sorgente vero. Il test qui sopra
        // esiste da sempre e misura la riga ESATTA — 1e200 × 1e200 — ma si ferma a
        // `importoRiga(...) === 0` e **non chiede mai il verdetto al gate**. Chiesto:
        //   · `violazioniRighe([ticket 1e200 × 1e200])`            → **[]**
        //   · `puoConfermare([nuova 100, ticket 1e200 × 1e200], 100)` → **true**
        //   · `puoConfermare([nuova 100, ticket 1e308 × 2,5], 100)`   → **true**
        // L'asimmetria col ramo VOCE era netta: `puoConfermare([nuova 100, nuova
        // 1e308], 100)` = false, e ha pure un test dedicato poco più sotto.
        //
        // Causa radice: `al2` manda a 0 il prodotto fuori scala; sul ramo voce quello
        // 0 lo intercetta `importo_non_positivo`, ma sul ramo ticket quella regola è
        // tolta apposta — e così lo 0 «fuori scala» era INDISTINGUIBILE da uno 0
        // legittimo. Il gate incassava 100 € dichiarando di aver composto 100 € di
        // retta più una ricarica che sullo schermo vale 0,00 € e nel database non
        // esiste.
        expect(violazioniRighe([ticket({ quantita: 1e200, costoUnitario: 1e200 })])).toEqual([
            { indice: 0, codice: 'quantita_non_valida' },
        ])
        expect(puoConfermare([nuova({ importo: 100 }), ticket({ quantita: 1e200, costoUnitario: 1e200 })], 100)).toBe(
            false,
        )
        expect(puoConfermare([nuova({ importo: 100 }), ticket({ quantita: 1e308, costoUnitario: 2.5 })], 100)).toBe(
            false,
        )
    })

    it('la quantità dei ticket si ferma alla scala SICURA, non a «è un intero»', () => {
        // `Number.isInteger` e `Number.isSafeInteger` divergono esattamente qui, ed è
        // la differenza che chiude il difetto: 2**53 è un intero perfettamente
        // rispettabile per `isInteger` e il primo numero in cui due interi vicini
        // condividono lo stesso double. Sopra quella soglia «un ticket in più» non è
        // più un ticket in più, e il prodotto esce di scala poco dopo.
        expect(violazioniRighe([ticket({ quantita: 2 ** 53, costoUnitario: 2.5 })])).toEqual([
            { indice: 0, codice: 'quantita_non_valida' },
        ])
        // …e il controllo negativo, senza il quale la regola potrebbe essere «rifiuta
        // tutto» e resterebbe verde: il confine e i numeri di tutti i giorni passano.
        expect(violazioniRighe([ticket({ quantita: 2 ** 53 - 1, costoUnitario: 2.5 })])).toEqual([])
        expect(violazioniRighe([ticket({ quantita: 1, costoUnitario: 2.5 })])).toEqual([])
        expect(violazioniRighe([ticket({ quantita: 1e9, costoUnitario: 2.5 })])).toEqual([])
    })

    it('il totale di un ticket non è MAI 0 in silenzio, nemmeno quando i due campi sono ineccepibili', () => {
        // ⚠️ RILIEVO CHE NON ERA NEL PIANO, misurato mentre si verificava quello che
        // c'era. La correzione prescritta — `isSafeInteger` sulla QUANTITÀ — chiude
        // 1e200 × 1e200 e 1e308 × 2,5 perché lì a uscire di scala è la quantità.
        // Non chiude il caso speculare, dove la quantità è sicura e a uscire di scala
        // è il COSTO. Misurato col solo `isSafeInteger` applicato:
        //   · `violazioniRighe([ticket 20 × 1e308])`               → **[]**
        //   · `importoRiga(ticket 20 × 1e308)`                     → **0**
        //   · `puoConfermare([nuova 100, ticket 20 × 1e308], 100)` → **true**
        // Stesso difetto, stessa specie, altra porta: una riga che sullo schermo vale
        // 0,00 € e che nessun codice nomina, mentre il resto della composizione quadra.
        expect(violazioniRighe([ticket({ quantita: 20, costoUnitario: 1e308 })])).toEqual([
            { indice: 0, codice: 'importo_non_positivo' },
        ])
        expect(puoConfermare([nuova({ importo: 100 }), ticket({ quantita: 20, costoUnitario: 1e308 })], 100)).toBe(
            false,
        )
        // E lo stesso 0 muto si raggiunge SENZA numeri astronomici, per difetto invece
        // che per eccesso: un decimo di centesimo per ticket. `round(q × c, 2)` fa
        // `0.00` anche nella RPC, e l'INSERT in `incassi` viola
        // `incassi_importo_check CHECK (importo <> 0)` — lo stesso 23514 del costo a
        // zero. Misurato prima: `[]`, e `puoConfermare(…, 100)` = **true**.
        expect(violazioniRighe([ticket({ quantita: 1, costoUnitario: 0.001 })])).toEqual([
            { indice: 0, codice: 'importo_non_positivo' },
        ])
        expect(puoConfermare([nuova({ importo: 100 }), ticket({ quantita: 1, costoUnitario: 0.001 })], 100)).toBe(false)
        // Controllo negativo: un ticket vero non deve cadere in questa rete.
        expect(violazioniRighe([ticket({ quantita: 1, costoUnitario: 0.01 })])).toEqual([])
    })

    it('due righe FINITE la cui SOMMA esce dalla scala: il totale resta finito', () => {
        // Il difetto NON è l'ingresso fuori scala: è la somma. Ogni riga da 1e306 è
        // finita, `al2` non la azzera e `violazioniRighe` non ha niente da ridire —
        // sono righe valide. Misurato con `round2` nudo nel ciclo di
        // `totaleComposizione`: totale = **Infinity**, e di conseguenza
        // `scartoQuadratura(righe, 1000)` = **0**. Il motore diceva insieme «non
        // quadra» e «scarto 0,00 €», e `totaleComposizione` è esportata: quel totale
        // la UI lo mostra. Soglia misurata: a 5e305 per riga il totale è ancora finito.
        const righe: RigaComposizione[] = [nuova({ importo: 1e306 }), nuova({ importo: 1e306 })]
        expect(importoRiga(righe[0])).toBe(1e306)
        expect(violazioniRighe(righe)).toEqual([])
        expect(Number.isFinite(totaleComposizione(righe))).toBe(true)
        expect(scartoQuadratura(righe, 1000)).toBe(-1000)
        expect(puoConfermare(righe, 2e306)).toBe(false)
    })

    it('nessun numero che esce dal motore è Infinity — su ingressi che NON si autoannullano', () => {
        // ⚠️ ONESTÀ SU QUESTO TEST, che prima era decorativo. Gli ingressi erano due
        // soli — una riga da 1e308 e un ticket 1e200 × 1e200 — e `al2` li azzera
        // ENTRAMBI: il totale misurato era 0, quindi il test NON POTEVA fallire, e il
        // titolo dichiarava una proprietà universale provandola dove nulla la mette
        // alla prova. È la trappola che questo repo ha già pagato: un test mai visto
        // fallire non è un test.
        //
        // Gli ingressi qui sotto sono scelti apposta per SMENTIRE il titolo, e prima
        // della correzione tre di loro lo smentivano davvero (misurato):
        //   · `totaleComposizione([1e306, 1e306])`             → Infinity
        //   · `proponiAllocazioneSuVoci([residuo 1e308], 1e308)` → { importo: Infinity }
        //   · `rigaDaVoceAperta({ importo DB 1e308 })`          → residuo/importo Infinity
        // L'elenco è enumerato e il verdetto è collettivo apposta: così il messaggio
        // d'errore nomina TUTTE le uscite non finite in un colpo, invece di fermarsi
        // alla prima — e aggiungere una funzione che esporta numeri significa
        // aggiungere una riga qui.
        const voceGigante = {
            id: 'pag-gigante',
            alunno_id: ALUNNO,
            scuola_id: SEDE_A,
            descrizione: 'Retta fuori scala',
            importo: 1e308,
            stato: 'da_pagare',
        }
        const voceNormale = {
            id: 'pag-normale',
            alunno_id: ALUNNO,
            scuola_id: SEDE_A,
            descrizione: 'Retta di ottobre',
            importo: 300,
            stato: 'da_pagare',
        }
        const dueDa1e306: RigaComposizione[] = [nuova({ importo: 1e306 }), nuova({ importo: 1e306 })]
        const autoannullanti: RigaComposizione[] = [
            nuova({ importo: 1e308 }),
            ticket({ quantita: 1e200, costoUnitario: 1e200 }),
        ]
        const proposta = proponiAllocazioneSuVoci([{ id: 'a', residuo: 1e308 }], 1e308)
        expect(proposta).toHaveLength(1)

        const uscite: Array<[string, number]> = [
            ['totaleTicket(1e200, 1e200)', totaleTicket(1e200, 1e200)],
            ['importoRiga(voce da 1e308)', importoRiga(nuova({ importo: 1e308 }))],
            ['importoRiga(ticket 1e200 × 1e200)', importoRiga(ticket({ quantita: 1e200, costoUnitario: 1e200 }))],
            ['totaleComposizione(ingressi che si autoannullano)', totaleComposizione(autoannullanti)],
            ['totaleComposizione([1e306, 1e306])', totaleComposizione(dueDa1e306)],
            ['scartoQuadratura([1e306, 1e306], 1000)', scartoQuadratura(dueDa1e306, 1000)],
            ['scartoQuadratura([1e306, 1e306], 2e306)', scartoQuadratura(dueDa1e306, 2e306)],
            ['scartoQuadratura(autoannullanti, 1e308)', scartoQuadratura(autoannullanti, 1e308)],
            ['proponiAllocazioneSuVoci([residuo 1e308], 1e308)[0].importo', proposta[0].importo],
            ['rigaDaVoceAperta({ importo DB 1e308 }).residuo', rigaDaVoceAperta(voceGigante).residuo],
            ['rigaDaVoceAperta({ importo DB 1e308 }).importo', rigaDaVoceAperta(voceGigante).importo],
            ['rigaDaVoceAperta(voce normale, importo 1e308).importo', rigaDaVoceAperta(voceNormale, 1e308).importo],
        ]
        const infiniti = uscite.filter(([, v]) => !Number.isFinite(v)).map(([nome]) => nome)
        expect(
            infiniti,
            `Numeri NON finiti in uscita dal motore:\n  ${infiniti.join('\n  ')}\n` +
            `Un Infinity che esce di qui finisce in una colonna \`numeric\` o sullo schermo ` +
            `dell'operatrice come totale di un bonifico.`,
        ).toEqual([])
    })

    it('`quadra` da sola dice VERO alla composizione gigante: a dire NO è il gate', () => {
        // ⚠️ RILIEVO CHE MI SONO FATTO DA SOLO, misurato rifacendo le mutazioni: l'`al2`
        // di `quadra` è il TERZO non presidiato, della stessa classe di M10. Sostituito
        // con `round2` la suite restava verde — e il verdetto di `quadra` si ribaltava,
        // perché `round2(1e308)` è `Infinity` e `0 === Infinity` è falso.
        // Il commento di `al2` dichiara questo comportamento «misurato dopo la
        // correzione» («`quadra([riga da 1e308], 1e308)` è ancora VERO … ed è giusto
        // così, "0 quadra con 0"»), ed è vero: ma era una frase, non una protezione.
        // Presidiarla serve a due cose: che resti vera, e che resti chiaro che la
        // quadratura NON è il gate — a fermare la composizione gigante è
        // `puoConfermare`, che guarda anche le violazioni. È la ragione per cui il
        // gate non si ricompone a mano.
        expect(quadra([nuova({ importo: 1e308 })], 1e308)).toBe(true)
        expect(puoConfermare([nuova({ importo: 1e308 })], 1e308)).toBe(false)
    })

    it('il gate dice NO alla composizione gigante, dove prima diceva SÌ', () => {
        expect(puoConfermare([nuova({ importo: 1e308 })], 1e308)).toBe(false)
    })
})

// ─── puoConfermare: l'UNICO gate, perché la protezione non si ricordi a memoria ─

describe('puoConfermare', () => {
    it('composizione valida che quadra → vero', () => {
        expect(puoConfermare([nuova({ importo: 100 })], 100)).toBe(true)
    })

    it('zero righe contro un movimento a 0 o NaN → falso', () => {
        expect(puoConfermare([], 0)).toBe(false)
        expect(puoConfermare([], NaN)).toBe(false)
    })

    it('righe ineccepibili che NON quadrano → falso', () => {
        expect(puoConfermare([nuova({ importo: 90 })], 100)).toBe(false)
    })

    it('una riga invalida non passa nemmeno quando la somma quadra', () => {
        // Una descrizione vuota non cambia il totale: il gate deve guardare ANCHE le righe.
        const righe = [nuova({ importo: 100, descrizione: '' })]
        expect(quadra(righe, 100)).toBe(true)
        expect(puoConfermare(righe, 100)).toBe(false)
    })

    it('il gate a DUE pezzi riapre il difetto: per questo ne esiste UNO', () => {
        // `violazioniRighe(r).length === 0 && quadra(r, importo)` compila, passa `tsc` e
        // passa ogni lock: `violazioniComposizione` ritorna un tipo DIVERSO, quindi
        // dimenticarla non è un errore di compilazione, è solo una svista silenziosa.
        const gateIncompleto = (r: RigaComposizione[], importo: number) =>
            violazioniRighe(r).length === 0 && quadra(r, importo)
        expect(gateIncompleto([], 0)).toBe(true)
        expect(gateIncompleto([], NaN)).toBe(true)
        // Lo stesso caso, con l'unico gate esportato:
        expect(puoConfermare([], 0)).toBe(false)
        expect(puoConfermare([], NaN)).toBe(false)
    })
})

// ─── proponiAncora: quale riga ancora la fattura ─────────────────────────────

describe('proponiAncora', () => {
    it('la voce con categoria retta ancora la fattura ANCHE se non è la maggiore', () => {
        const righe: RigaComposizione[] = [
            nuova({ categoriaSlug: 'extra', importo: 500 }),
            esistente({ categoriaSlug: 'retta', importo: 150 }),
        ]
        expect(proponiAncora(righe)).toEqual({ indice: 1, motivo: 'retta' })
    })

    it('senza retta → la riga di importo maggiore', () => {
        const righe: RigaComposizione[] = [
            nuova({ categoriaSlug: 'extra', importo: 80 }),
            nuova({ categoriaSlug: 'mensa', importo: 300 }),
            esistente({ categoriaSlug: 'gita', importo: 120 }),
        ]
        expect(proponiAncora(righe)).toEqual({ indice: 1, motivo: 'maggiore' })
    })

    it('a parità di importo vince la prima', () => {
        const righe: RigaComposizione[] = [
            nuova({ categoriaSlug: 'extra', importo: 100 }),
            nuova({ categoriaSlug: 'mensa', importo: 100 }),
        ]
        expect(proponiAncora(righe)).toEqual({ indice: 0, motivo: 'maggiore' })
    })

    it('un ticket NON può ancorare se c\'è una voce, nemmeno se vale di più', () => {
        const righe: RigaComposizione[] = [
            ticket({ quantita: 100, costoUnitario: 5 }), // 500 €
            nuova({ categoriaSlug: 'extra', importo: 20 }),
        ]
        expect(proponiAncora(righe)).toEqual({ indice: 1, motivo: 'maggiore' })
    })

    it('sole righe ticket → ancora il ticket maggiore', () => {
        const righe: RigaComposizione[] = [
            ticket({ quantita: 10, costoUnitario: 2.5 }), // 25 €
            ticket({ quantita: 20, costoUnitario: 2.5 }), // 50 €
        ]
        expect(proponiAncora(righe)).toEqual({ indice: 1, motivo: 'maggiore' })
    })

    it('nessuna riga → nessuna àncora', () => {
        expect(proponiAncora([])).toBeNull()
    })

    it('più rette → la prima (il motivo resta «retta»)', () => {
        const righe: RigaComposizione[] = [
            esistente({ categoriaSlug: 'retta', importo: 150 }),
            nuova({ categoriaSlug: 'retta', importo: 400 }),
        ]
        expect(proponiAncora(righe)).toEqual({ indice: 0, motivo: 'retta' })
    })
})

// ─── sediCoinvolte: capire se il bonifico è cross-sede ───────────────────────

describe('sediCoinvolte', () => {
    it('deduplica e ordina gli uuid di sede', () => {
        const righe: RigaComposizione[] = [
            esistente({ scuolaId: SEDE_C }),
            nuova({ scuolaId: SEDE_A }),
            ticket({ scuolaId: SEDE_C }),
            esistente({ scuolaId: SEDE_B }),
        ]
        expect(sediCoinvolte(righe)).toEqual([SEDE_A, SEDE_B, SEDE_C])
    })

    it('una sola sede → un solo uuid (bonifico non cross-sede)', () => {
        expect(sediCoinvolte([esistente(), nuova(), ticket()])).toEqual([SEDE_A])
    })

    it('sedi assenti o vuote non entrano nell\'elenco', () => {
        const righe: RigaComposizione[] = [
            esistente({ scuolaId: null }),
            nuova({ scuolaId: '  ' }),
            ticket({ scuolaId: SEDE_B }),
        ]
        expect(sediCoinvolte(righe)).toEqual([SEDE_B])
    })

    it('nessuna riga → elenco vuoto', () => {
        expect(sediCoinvolte([])).toEqual([])
    })
})

// ─── riuso: allocazione automatica e residuo effettivo ───────────────────────

describe('proponiAllocazioneSuVoci', () => {
    it('riempie le voci nell\'ordine dato senza sforare la capienza, con importi NUMERICI', () => {
        const voci = [
            { id: 'vecchia', residuo: 100 },
            { id: 'media', residuo: 50 },
            { id: 'nuova', residuo: 80 },
        ]
        expect(proponiAllocazioneSuVoci(voci, 120)).toEqual([
            { id: 'vecchia', importo: 100 },
            { id: 'media', importo: 20 },
        ])
    })

    it('capienza nulla → nessuna voce toccata', () => {
        expect(proponiAllocazioneSuVoci([{ id: 'a', residuo: 10 }], 0)).toEqual([])
    })

    it('la proposta quadra con la capienza quando le voci bastano', () => {
        const voci = [{ id: 'a', residuo: 33.33 }, { id: 'b', residuo: 33.33 }]
        const proposta = proponiAllocazioneSuVoci(voci, 50)
        const righe = proposta.map((p) => esistente({ pagamentoId: p.id, residuo: 100, importo: p.importo }))
        expect(quadra(righe, 50)).toBe(true)
    })

    it('un id ripetuto si consuma UNA volta sola: la capienza è un tetto, non un suggerimento', () => {
        // `proponiAllocazione` ritorna una mappa per `id`: i duplicati vi collassano.
        // Ri-emetterne uno per ogni occorrenza dell'array raddoppia l'importo allocato
        // e sfora la capienza — cioè assegna al bonifico più denaro di quanto ne porti.
        const voci = [{ id: 'x', residuo: 100 }, { id: 'x', residuo: 100 }]
        const proposta = proponiAllocazioneSuVoci(voci, 100)
        expect(proposta).toEqual([{ id: 'x', importo: 100 }])
        expect(proposta.reduce((t, p) => round2(t + p.importo), 0)).toBeLessThanOrEqual(100)
    })

    it('due elenchi di figli concatenati con una voce in comune restano dentro la capienza', () => {
        // Ci si arriva davvero così: le voci aperte di due fratelli concatenate, oppure
        // un ritento che rimette in coda una voce già presente.
        const voci = [
            { id: 'retta-marzo', residuo: 200 },
            { id: 'mensa', residuo: 50 },
            { id: 'retta-marzo', residuo: 200 },
        ]
        const proposta = proponiAllocazioneSuVoci(voci, 220)
        expect(proposta).toEqual([
            { id: 'retta-marzo', importo: 200 },
            { id: 'mensa', importo: 20 },
        ])
        expect(proposta.reduce((t, p) => round2(t + p.importo), 0)).toBe(220)
    })

    it('la proposta su voci duplicate produce righe che QUADRANO col bonifico', () => {
        const voci = [{ id: 'x', residuo: 100 }, { id: 'x', residuo: 100 }]
        const proposta = proponiAllocazioneSuVoci(voci, 100)
        const righe = proposta.map((p) => esistente({ pagamentoId: p.id, residuo: 100, importo: p.importo }))
        expect(quadra(righe, 100)).toBe(true)
    })
})

describe('rigaDaVoceAperta', () => {
    it('il residuo della riga è quello EFFETTIVO: importo − sconto − incassato', () => {
        const riga = rigaDaVoceAperta({
            id: 'pag-9',
            alunno_id: ALUNNO,
            scuola_id: SEDE_A,
            descrizione: 'Retta di settembre',
            importo: 300,
            sconto: 50,
            importo_pagato: 100,
            stato: 'parziale',
            payment_categories: { slug: 'retta' },
        })
        expect(riga).toEqual({
            specie: 'esistente',
            pagamentoId: 'pag-9',
            alunnoId: ALUNNO,
            scuolaId: SEDE_A,
            categoriaSlug: 'retta',
            descrizione: 'Retta di settembre',
            residuo: 150,
            importo: 150,
        })
    })

    it('sovraincasso: il residuo non va mai sotto zero', () => {
        const riga = rigaDaVoceAperta({
            id: 'pag-10',
            alunno_id: ALUNNO,
            scuola_id: SEDE_A,
            descrizione: 'Mensa',
            importo: 100,
            importo_pagato: 130,
            stato: 'pagato',
        })
        expect(riga.residuo).toBe(0)
        expect(riga.importo).toBe(0)
    })

    it('un importo a DATABASE fuori scala ferma il gate con `importo_non_positivo`, NON con `oltre_residuo`', () => {
        // ⚠️ Il passaggio di consegne di questa fetta dichiarava: «`num()` lo azzera e
        // `oltre_residuo` scatta». **Misurato: non scatta.** Azzerandosi il residuo si
        // azzera anche il TETTO del confronto, e `0 > 0` è falso. Il gate ferma
        // comunque, ma per l'altra ragione — ed è quella giusta: 1e308 non è un importo
        // «oltre il residuo», non è un importo. Questo test esiste perché quella frase
        // non torni a essere un'affermazione mai verificata.
        const riga = rigaDaVoceAperta({
            id: 'pag-12',
            alunno_id: ALUNNO,
            scuola_id: SEDE_A,
            descrizione: 'Retta fuori scala',
            importo: 1e308,
            stato: 'da_pagare',
        })
        expect(riga.residuo).toBe(0)
        expect(riga.importo).toBe(0)
        expect(violazioniRighe([riga])).toEqual([{ indice: 0, codice: 'importo_non_positivo' }])
        expect(violazioniRighe([riga]).some((v) => v.codice === 'oltre_residuo')).toBe(false)
        expect(puoConfermare([riga], 100)).toBe(false)
    })

    it('un importo esplicito vince sul residuo, ma la riga resta confrontabile col residuo', () => {
        const riga = rigaDaVoceAperta(
            {
                id: 'pag-11',
                alunno_id: ALUNNO,
                scuola_id: SEDE_A,
                descrizione: 'Retta di ottobre',
                importo: 300,
                stato: 'da_pagare',
                payment_categories: { slug: 'retta' },
            },
            120,
        )
        expect(riga.importo).toBe(120)
        expect(riga.residuo).toBe(300)
        expect(violazioniRighe([riga])).toEqual([])
    })
})
