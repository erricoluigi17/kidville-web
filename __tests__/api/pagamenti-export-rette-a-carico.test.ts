import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import * as XLSX from 'xlsx'
import type { DBFinto } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'
import { STATI_PAGAMENTO } from '@/components/features/admin/pagamenti/stati'
import { SEPARATORE_STATO } from '@/lib/pagamenti/rette-a-carico'

// =============================================================================
// D14 (2026-09-28) — export dello Scadenzario: il bambino con la retta a carico di
// un fratello (`alunni.retta_a_carico_di`) riceve una riga per ogni retta del
// pagante, a importi ZERO (i totali dell'Excel non raddoppiano), con in «Stato» la
// stessa frase del cruscotto: «Paga il fratello Npag Rossi (Sez. C) · Da pagare».
//
// Finto client che FILTRA davvero e `scope.ts` VERO (nessun mock dello scope).
// =============================================================================

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  db: {} as DBFinto,
  errori: {} as Record<string, { code: string }>,
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  /** K4: la SECONDA lettura di `utenti_scuole` nella richiesta risponde con un errore. */
  guastoSecondaLetturaSedi: false,
}))
vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/logging/logger')>()
  h.logEvento.mockImplementation(vero.logEvento)
  h.logErrore.mockImplementation(vero.logErrore)
  return { ...vero, logEvento: h.logEvento, logErrore: h.logErrore }
})
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => {
      const c = creaFintoSupabase(h.db, [], { errori: h.errori })
      if (!h.guastoSecondaLetturaSedi) return c
      // La prima lettura (dentro `resolveScuoleAttive`) va bene; la seconda — le sedi dei
      // paganti — risponde `{ error }`, e `scuoleDiUtente` VERO la trasforma in `[]`.
      const guasto = creaFintoSupabase(h.db, [], { errori: { utenti_scuole: { code: '57014' } } })
      const from = c.from.bind(c)
      let letture = 0
      Object.assign(c, { from: (t: string) => (t === 'utenti_scuole' && ++letture === 2 ? guasto.from(t) : from(t)) })
      return c
    },
  }
})

import { GET } from '@/app/api/pagamenti/export/route'

const SEZ_A = '10000000-0000-4000-8000-00000000000a'
const SEZ_B = '10000000-0000-4000-8000-00000000000b'
const SEZ_C = '10000000-0000-4000-8000-00000000000c'
/** Una sezione della SECONDA sede (terza revisione: il filtro di sede non era provato). */
const SEZ_BETA = '10000000-0000-4000-8000-0000000000b1'
const ADMIN_AB = { id: 'admin-1', role: 'admin', scuola_id: SEDE_A }

const alunno = (id: string, extra: Record<string, unknown> = {}) => ({
  id, nome: `N${id}`, cognome: 'Rossi', classe_sezione: 'Sez. C', section_id: SEZ_C, scuola_id: SEDE_A,
  stato: 'iscritto', gender: 'M', archiviato_il: null, retta_a_carico_di: null, ...extra,
})
const RETTA = { nome: 'Retta', slug: 'retta' }
const voce = (id: string, alunnoId: string, periodo: string, extra: Record<string, unknown> = {}) => ({
  id, alunno_id: alunnoId, scuola_id: SEDE_A, descrizione: `Retta ${periodo.slice(0, 7)}`, importo: 250, importo_pagato: 0,
  scadenza: `${periodo.slice(0, 8)}05`, periodo_competenza: periodo, stato: 'da_pagare', tipo: 'singolo',
  fattura_stato: null, categoria_id: 'c-retta', payment_categories: RETTA,
  alunni: { nome: `N${alunnoId}`, cognome: 'Rossi', classe_sezione: 'Sez. C', section_id: SEZ_C, scuola_id: SEDE_A },
  ...extra,
})

async function righe(res: Response) {
  const wb = XLSX.read(Buffer.from(await res.arrayBuffer()))
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets.Scadenzario)
}

beforeEach(() => {
  vi.clearAllMocks()
  h.errori = {}
  h.guastoSecondaLetturaSedi = false
  h.db = {
    schools: [{ id: SEDE_A, nome: NOME_SEDE_A }, { id: SEDE_B, nome: NOME_SEDE_B }],
    scuole: [{ id: SEDE_A, attiva: true }, { id: SEDE_B, attiva: true }],
    utenti_scuole: [{ utente_id: 'admin-1', scuola_id: SEDE_A }, { utente_id: 'admin-1', scuola_id: SEDE_B }],
    alunni: [
      alunno('pag'),                                                                            // paga
      alunno('fig', { retta_a_carico_di: 'pag', classe_sezione: 'Sez. A', section_id: SEZ_A }), // a carico
      alunno('teo', { retta_a_carico_di: 'pag', classe_sezione: 'Sez. A', section_id: SEZ_A }), // a carico, ma con retta di ottobre
      alunno('bea', { retta_a_carico_di: 'pag', classe_sezione: 'Sez. B', section_id: SEZ_B }), // a carico, in un'ALTRA sezione
      // La seconda sede: un pagante e il suo bambino a carico, entrambi di Beta.
      alunno('pgb', { scuola_id: SEDE_B, classe_sezione: 'Sez. C', section_id: SEZ_BETA }),
      alunno('fgb', { scuola_id: SEDE_B, retta_a_carico_di: 'pgb', classe_sezione: 'Sez. Beta', section_id: SEZ_BETA }),
    ],
    pagamenti: [
      voce('p-set', 'pag', '2026-09-01', { stato: 'pagato', importo_pagato: 250 }),
      voce('p-ott', 'pag', '2026-10-01'),
      voce('t-ott', 'teo', '2026-10-01', { importo: 100 }),
      voce('b-ott', 'pgb', '2026-10-01', {
        scuola_id: SEDE_B,
        alunni: { nome: 'Npgb', cognome: 'Rossi', classe_sezione: 'Sez. C', section_id: SEZ_BETA, scuola_id: SEDE_B },
      }),
    ],
    registro_modifiche: [],
  }
  h.requireStaff.mockResolvedValue({ user: ADMIN_AB })
})

describe('export scadenzario — righe dei bambini a carico (D14)', () => {
  it('una riga per ogni retta del pagante, a importi zero, con lo stato del pagante', async () => {
    const res = await GET(new NextRequest('http://localhost/api/pagamenti/export?tipo=scadenzario'))
    expect(res.status).toBe(200)
    const fig = (await righe(res)).filter((r) => r.Alunno === 'Nfig Rossi')
    expect(fig).toEqual([
      expect.objectContaining({ Sede: NOME_SEDE_A, Sezione: 'Sez. A', Categoria: 'Retta', Descrizione: 'Retta 2026-09', Scadenza: '2026-09-05', 'Importo €': 0, 'Pagato €': 0, 'Residuo €': 0, Stato: 'Paga il fratello Npag Rossi (Sez. C) · Pagato' }),
      expect.objectContaining({ Descrizione: 'Retta 2026-10', Scadenza: '2026-10-05', 'Importo €': 0, Stato: 'Paga il fratello Npag Rossi (Sez. C) · Da pagare' }),
    ])
  })

  // K4 (seconda revisione 2026-09-28): le sedi dei paganti venivano SOLO da una seconda
  // `scuoleDiUtente`, che su un errore restituisce `[]`: il pagante della stessa sede del
  // bambino diventava «non leggibile» e le righe del bambino sparivano dall'Excel.
  it('K4 — la seconda lettura delle sedi fallisce: le righe del bambino (pagante nella sua sede) ci sono', async () => {
    h.guastoSecondaLetturaSedi = true
    const res = await GET(new NextRequest('http://localhost/api/pagamenti/export?tipo=scadenzario'))
    expect(res.status).toBe(200)
    expect(h.logEvento).toHaveBeenCalledWith('auth', 'error', expect.objectContaining({ tipo: 'sedi-utente-non-risolte' }), expect.anything())
    const fig = (await righe(res)).filter((r) => r.Alunno === 'Nfig Rossi')
    expect(fig.map((r) => r.Stato)).toEqual(['Paga il fratello Npag Rossi (Sez. C) · Pagato', 'Paga il fratello Npag Rossi (Sez. C) · Da pagare'])
  })

  it('D9: il bambino con la sua retta del mese non riceve la riga in più per quel mese', async () => {
    const tutte = await righe(await GET(new NextRequest('http://localhost/api/pagamenti/export?tipo=scadenzario')))
    const teo = tutte.filter((r) => r.Alunno === 'Nteo Rossi')
    expect(teo.map((r) => [r.Descrizione, r['Importo €']])).toEqual([['Retta 2026-09', 0], ['Retta 2026-10', 100]])
  })

  it('le righe restano ordinate per scadenza', async () => {
    const tutte = await righe(await GET(new NextRequest('http://localhost/api/pagamenti/export?tipo=scadenzario')))
    const scadenze = tutte.map((r) => String(r.Scadenza))
    expect(scadenze).toEqual([...scadenze].sort())
  })

  it('filtro classi: conta la classe del BAMBINO, anche se il pagante è fuori filtro', async () => {
    const tutte = await righe(await GET(new NextRequest(`http://localhost/api/pagamenti/export?tipo=scadenzario&section_ids=${SEZ_A}`)))
    expect(tutte.some((r) => r.Alunno === 'Npag Rossi')).toBe(false)
    expect(tutte.filter((r) => r.Alunno === 'Nfig Rossi')).toHaveLength(2)
  })

  // ===========================================================================
  // Terza revisione (2026-09-29) — i due filtri dell'export sulle righe a carico NON erano
  // protetti da nessun test: tutti i bambini a carico stavano nella stessa sezione e nella
  // stessa sede, e togliendo il filtro classi (`export-rette-a-carico.ts`) o la restrizione
  // `sediBambini` alla sede dichiarata (`export/route.ts`) la suite restava verde. Qui ci sono
  // un bambino in un'ALTRA sezione («bea», Sez. B) e uno nella SECONDA sede («fgb», Beta), e
  // si guarda che restino FUORI — accanto a quelli che devono esserci, perché un'assenza da
  // sola passa anche quando non esce niente.
  // ===========================================================================
  describe('i filtri dell’export tengono fuori le righe a carico che non c’entrano', () => {
    const esporta = async (qs = '') =>
      righe(await GET(new NextRequest(`http://localhost/api/pagamenti/export?tipo=scadenzario${qs}`)))
    const di = (tutte: Record<string, unknown>[], nome: string) => tutte.filter((r) => r.Alunno === nome)

    it('senza filtri (controllo positivo): ci sono le righe di fig, bea e fgb', async () => {
      const tutte = await esporta()
      expect(di(tutte, 'Nfig Rossi')).toHaveLength(2)
      expect(di(tutte, 'Nbea Rossi')).toHaveLength(2)
      expect(di(tutte, 'Nfgb Rossi').map((r) => [r.Sede, r.Stato])).toEqual([[NOME_SEDE_B, 'Paga il fratello Npgb Rossi (Sez. C) · Da pagare']])
    })

    it('section_ids = Sez. A: fig sì, bea (Sez. B) e fgb (sezione di Beta) NO', async () => {
      const tutte = await esporta(`&section_ids=${SEZ_A}`)
      expect(di(tutte, 'Nfig Rossi')).toHaveLength(2)
      expect(di(tutte, 'Nbea Rossi')).toEqual([])
      expect(di(tutte, 'Nfgb Rossi')).toEqual([])
    })

    // R9: in Postgres `uuid` è un TIPO, e PostgREST trova la riga anche con l'uuid in maiuscolo;
    // `Array.includes` no. Con `section_ids` in maiuscolo le righe a carico sparivano.
    it('section_ids in MAIUSCOLO: le righe a carico ci sono lo stesso (e le altre restano fuori)', async () => {
      const tutte = await esporta(`&section_ids=${SEZ_A.toUpperCase()}`)
      expect(di(tutte, 'Nfig Rossi')).toHaveLength(2)
      expect(di(tutte, 'Nbea Rossi')).toEqual([])
    })

    it('section_ids = Sez. B: bea sì, fig NO', async () => {
      const tutte = await esporta(`&section_ids=${SEZ_B}`)
      expect(di(tutte, 'Nbea Rossi').map((r) => r.Descrizione)).toEqual(['Retta 2026-09', 'Retta 2026-10'])
      expect(di(tutte, 'Nfig Rossi')).toEqual([])
    })

    it('scuola_id = Alfa: fig sì, fgb (bambino di Beta) NO', async () => {
      const tutte = await esporta(`&scuola_id=${SEDE_A}`)
      expect(di(tutte, 'Nfig Rossi')).toHaveLength(2)
      expect(di(tutte, 'Nfgb Rossi')).toEqual([])
    })

    it('scuola_id = Beta: fgb sì, fig e bea (bambini di Alfa) NO', async () => {
      const tutte = await esporta(`&scuola_id=${SEDE_B}`)
      expect(di(tutte, 'Nfgb Rossi')).toHaveLength(1)
      expect(di(tutte, 'Nfig Rossi')).toEqual([])
      expect(di(tutte, 'Nbea Rossi')).toEqual([])
    })

    it('una voce `padre` del pagante non produce una riga in più', async () => {
      h.db.pagamenti.push(voce('p-pad', 'pag', '2026-11-01', { tipo: 'padre', descrizione: 'Contenitore rateale' }))
      const fig = di(await esporta(), 'Nfig Rossi')
      expect(fig.map((r) => r.Descrizione)).toEqual(['Retta 2026-09', 'Retta 2026-10'])
    })

    it('una retta del pagante senza `periodo_competenza` non produce una riga in più', async () => {
      h.db.pagamenti.push(voce('p-nul', 'pag', '2026-12-01', { periodo_competenza: null, descrizione: 'Retta senza periodo' }))
      const tutte = await esporta()
      // Controllo positivo: la voce c'è, nella riga del pagante.
      expect(di(tutte, 'Npag Rossi').map((r) => r.Descrizione)).toContain('Retta senza periodo')
      expect(di(tutte, 'Nfig Rossi').map((r) => r.Descrizione)).toEqual(['Retta 2026-09', 'Retta 2026-10'])
    })
  })

  it('filtro stato: la riga del bambino segue lo stato della retta del pagante', async () => {
    const tutte = await righe(await GET(new NextRequest('http://localhost/api/pagamenti/export?tipo=scadenzario&stato=pagato')))
    expect(tutte.filter((r) => r.Alunno === 'Nfig Rossi').map((r) => r.Descrizione)).toEqual(['Retta 2026-09'])
  })

  // Oltre il piano: la route accetta anche `categoria_id`. Un export «solo Mensa» non deve
  // ricevere le righe di RETTA dei bambini a carico; uno «solo Retta» sì.
  it('filtro categoria: la riga del bambino c’è solo se la retta del pagante è di QUELLA categoria', async () => {
    const CAT_RETTA = '20000000-0000-4000-8000-0000000000a1'
    const CAT_MENSA = '20000000-0000-4000-8000-0000000000a2'
    for (const p of h.db.pagamenti) p.categoria_id = CAT_RETTA
    const mensa = await righe(await GET(new NextRequest(`http://localhost/api/pagamenti/export?tipo=scadenzario&categoria_id=${CAT_MENSA}`)))
    expect(mensa).toEqual([])
    const retta = await righe(await GET(new NextRequest(`http://localhost/api/pagamenti/export?tipo=scadenzario&categoria_id=${CAT_RETTA}`)))
    expect(retta.filter((r) => r.Alunno === 'Nfig Rossi').map((r) => r.Descrizione)).toEqual(['Retta 2026-09', 'Retta 2026-10'])
  })

  // C7 (revisione 2026-09-28): il lock «schermo = Excel» di `rette-a-carico.test.ts` copre il
  // PREFISSO («Paga il fratello …»). Lo STATO, dopo il separatore, a schermo viene da
  // `STATI_PAGAMENTO` e nell'Excel da `STATO_LABEL` della route: due mappe, e nulla le legava.
  describe('C7 — lo stato dopo « · » è la stessa parola del cruscotto', () => {
    const STATI = ['da_pagare', 'parziale', 'pagato', 'scaduto']
    it('gli stati del cruscotto sono questi quattro (uno nuovo va aggiunto qui)', () => {
      expect(Object.keys(STATI_PAGAMENTO).sort()).toEqual([...STATI].sort())
    })
    for (const stato of STATI) {
      it(`retta del pagante «${stato}» → «… · ${STATI_PAGAMENTO[stato].label}»`, async () => {
        h.db.pagamenti = [voce('p-nov', 'pag', '2026-11-01', { stato })]
        const fig = (await righe(await GET(new NextRequest('http://localhost/api/pagamenti/export?tipo=scadenzario'))))
          .filter((r) => r.Alunno === 'Nfig Rossi')
        expect(fig).toHaveLength(1)
        expect(fig[0].Stato).toBe(`Paga il fratello Npag Rossi (Sez. C)${SEPARATORE_STATO}${STATI_PAGAMENTO[stato].label}`)
      })
    }
  })

  // C8b (revisione 2026-09-28): la colonna «Stato» era larga 10 caratteri, e la frase del
  // bambino a carico ne ha 50–60 — nell'Excel si leggeva «Paga il f».
  describe('C8b — la larghezza della colonna Stato', () => {
    async function colonnaStato(qs = 'tipo=scadenzario') {
      const res = await GET(new NextRequest(`http://localhost/api/pagamenti/export?${qs}`))
      const ws = XLSX.read(Buffer.from(await res.arrayBuffer()), { cellStyles: true }).Sheets.Scadenzario
      const intestazione = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 })[0]
      const i = intestazione.indexOf('Stato')
      const testi = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws).map((r) => String(r.Stato))
      return { wch: (ws['!cols'] as { wch?: number }[])[i].wch, piuLunga: Math.max(...testi.map((x) => x.length)) }
    }
    it('con le righe a carico: larga quanto la frase più lunga', async () => {
      const { wch, piuLunga } = await colonnaStato()
      expect(piuLunga).toBeGreaterThan(40)
      expect(wch).toBe(piuLunga)
    })
    it('senza righe a carico: compatta come prima (10)', async () => {
      for (const a of h.db.alunni) a.retta_a_carico_di = null
      expect((await colonnaStato()).wch).toBe(10)
    })
    it('tetto a 60: un nome lunghissimo non fa una colonna larga mezzo schermo', async () => {
      h.db.alunni.find((a) => a.id === 'pag')!.cognome = 'X'.repeat(80)
      expect((await colonnaStato()).wch).toBe(60)
    })
    // K1 (seconda revisione): `pagamenti.stato` è nullable in produzione. La riga del pagante a
    // stato NULL esce con la cella vuota, quella del bambino con la frase SENZA « · stato» — e
    // l'export non va in 500.
    it('retta del pagante a stato NULL: 200, la frase senza lo stato, la colonna misurata', async () => {
      h.db.pagamenti = [voce('p-nov', 'pag', '2026-11-01', { stato: null })]
      const res = await GET(new NextRequest('http://localhost/api/pagamenti/export?tipo=scadenzario'))
      expect(res.status).toBe(200)
      const tutte = await righe(res)
      expect(tutte.find((r) => r.Alunno === 'Nfig Rossi')?.Stato).toBe('Paga il fratello Npag Rossi (Sez. C)')
      expect(tutte.find((r) => r.Alunno === 'Npag Rossi')?.Stato ?? '').toBe('')
      const { wch } = await colonnaStato()
      expect(wch).toBe('Paga il fratello Npag Rossi (Sez. C)'.length)
    })
  })

  // R3 (terza revisione 2026-09-29): prima erano due righe error per un guasto. Q1 (quarta
  // revisione): il loader non logga più il guasto («chi chiama logga»); lo scrive QUI l'export,
  // UNA riga `logEvento` error con l'esito della lettura fallita e l'errore vero — e senza `stato`
  // né `logErrore`: l'export risponde 200, non c'è un 5xx da dichiarare, la marca resta giù.
  it('legami non letti: l’export esce lo stesso, senza righe in più, e UNA riga error con la causa', async () => {
    h.errori = { 'alunni:select': { code: '57014' } }
    const res = await GET(new NextRequest('http://localhost/api/pagamenti/export?tipo=scadenzario'))
    expect(res.status).toBe(200)
    expect((await righe(res)).some((r) => r.Alunno === 'Nfig Rossi')).toBe(false)
    const errori = h.logEvento.mock.calls.filter((c) => c[1] === 'error')
    expect(errori).toHaveLength(1)
    expect(errori[0]).toEqual([
      'pagamento', 'error',
      expect.objectContaining({ operazione: 'pagamenti/export:GET', esito: 'legami-bambini-non-letti' }),
      expect.objectContaining({ code: '57014' }),
    ])
    expect((errori[0][2] as { stato?: unknown }).stato).toBeUndefined()
    expect(h.logErrore).not.toHaveBeenCalled()
    // La riga `info` della conseguenza non c'è più: la riga error la dice già (operazione = export).
    expect(h.logEvento).not.toHaveBeenCalledWith('pagamento', 'info', expect.objectContaining({ esito: 'export-senza-righe-a-carico' }))
  })
})
