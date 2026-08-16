import { describe, it, expect } from 'vitest'
import type { RigaElenco } from '@/lib/iscrizioni/import/abbinamento'
import { risolviRetta } from '@/lib/iscrizioni/import/retta'

// ─────────────────────────────────────────────────────────────────────────────
// LA RETTA: quando è una cifra, quando è a carico di un fratello, quando ci si
// ferma.
//
// ─── IL FATTO CHE GOVERNA QUESTO FILE, MISURATO IL 2026-08-16 ───────────────
// Nel file di Giugliano 36 righe su 338 non hanno una cifra ma un rimando —
// «vedi fratello», «vedi sor micronido», «VEDI SORELA» — e 30 sono vuote.
// Il rimando significa una cosa precisa, confermata dal titolare: la cifra
// scritta accanto a UN figlio è la retta di TUTTA la famiglia; gli altri figli
// non pagano nulla.
//
// ─── E LA TRAPPOLA CHE HA CAMBIATO IL DISEGNO ───────────────────────────────
// «Non paga nulla» NON si scrive `importo_retta_mensile = 0`. La formula che
// genera le rette è
//     COALESCE(NULLIF(al.importo_retta_mensile, 0), s.retta_default_importo, 150)
// (`20260731115341_genera_rette_per_sede.sql:154`, e il gemello TypeScript in
// `src/app/api/pagamenti/genera-rette/route.ts:52-55`): lo ZERO viene annullato
// da `NULLIF` e sostituito dal default della sede, che per tutte e tre le sedi
// vale **150,00 €** (misurato in `admin_settings`, 2026-08-16). Scrivere 0
// significherebbe mandare 150 € al mese a chi non deve pagare niente — cioè
// esattamente il contrario di quel che si voleva, in silenzio e per dieci mesi.
//
// Perciò «a carico di un fratello» è un esito A SÉ, e chi lo riceve deve
// scrivere anche `alunni.retta_a_carico_di`, che è ciò che fa saltare l'alunno
// alla generazione delle rette. La cifra da sola non basta a dirlo.
// ─────────────────────────────────────────────────────────────────────────────

const riga = (over: Partial<RigaElenco>): RigaElenco => ({
  id: 'x',
  classe: '3 ANNI C',
  nome: 'ROSSI MARIO',
  riga: 2,
  retta: null,
  rettaTesto: null,
  ...over,
})

describe('risolviRetta — la cifra', () => {
  it('una cifra è la cifra', () => {
    const e = risolviRetta(riga({ retta: 180 }), [])
    expect(e).toEqual({ tipo: 'importo', importo: 180 })
  })

  it('accetta i decimali', () => {
    const e = risolviRetta(riga({ retta: 187.5 }), [])
    expect(e).toEqual({ tipo: 'importo', importo: 187.5 })
  })

  it('uno ZERO scritto nel foglio NON è «non paga»: è ambiguo e ci si ferma', () => {
    // Lo zero, nel database, vuol dire «usa il default della sede» = 150 €.
    // Se davvero non deve pagare, la segreteria lo dice col rimando al fratello.
    const e = risolviRetta(riga({ retta: 0 }), [])
    expect(e.tipo).toBe('da_controllare')
  })

  it('una cifra negativa non esiste: ci si ferma', () => {
    expect(risolviRetta(riga({ retta: -50 }), []).tipo).toBe('da_controllare')
  })
})

describe('risolviRetta — il rimando al fratello', () => {
  const fratelloCon = (retta: number | null, nome = 'ROSSI LUCA'): RigaElenco =>
    riga({ id: 'f', nome, retta, classe: 'MICRONIDO' })

  it.each([['vedi fratello'], ['vedi sorella'], ['vedi fr'], ['vedi sor'], ['VEDI SORELA'], ['vedi sor micronido']])(
    '«%s» con un solo fratello che ha la cifra → a carico di lui',
    (testo) => {
      const e = risolviRetta(riga({ rettaTesto: testo }), [fratelloCon(330)])
      expect(e.tipo).toBe('a_carico')
      if (e.tipo === 'a_carico') {
        expect(e.importoFamiglia).toBe(330)
        expect(e.aCaricoDi.nome).toBe('ROSSI LUCA')
      }
    },
  )

  it('tre figli, una sola cifra (il caso BADALAMENTI: 450 € per tre) → a carico', () => {
    const e = risolviRetta(riga({ rettaTesto: 'vedi fr' }), [
      fratelloCon(450, 'BADALAMENTI ALESSANDRA'),
      riga({ id: 'f2', nome: 'BADALAMENTI BIANCA', rettaTesto: 'VEDI fratello' }),
    ])
    expect(e.tipo).toBe('a_carico')
    if (e.tipo === 'a_carico') expect(e.importoFamiglia).toBe(450)
  })

  it('più cifre uguali fra i fratelli contano come una sola', () => {
    const e = risolviRetta(riga({ rettaTesto: 'vedi fratello' }), [fratelloCon(300), fratelloCon(300, 'ROSSI ANNA')])
    expect(e.tipo).toBe('a_carico')
  })

  it('cifre DIVERSE fra i fratelli → non si sceglie quale vale', () => {
    const e = risolviRetta(riga({ rettaTesto: 'vedi fratello' }), [fratelloCon(300), fratelloCon(180, 'ROSSI ANNA')])
    expect(e.tipo).toBe('da_controllare')
    if (e.tipo === 'da_controllare') expect(e.motivo).toMatch(/divers/i)
  })

  it('nessun fratello con una cifra (il caso VIOLANTE: tutti e tre senza) → ci si ferma', () => {
    const e = risolviRetta(riga({ rettaTesto: 'vedi fr' }), [
      fratelloCon(null, 'VIOLANTE ANTONIO'),
      fratelloCon(null, 'VIOLANTE LORENZO'),
    ])
    expect(e.tipo).toBe('da_controllare')
  })

  it('rimando senza nessun fratello trovato (SILVESTRE LEONARDO) → ci si ferma', () => {
    const e = risolviRetta(riga({ rettaTesto: 'vedi fratello' }), [])
    expect(e.tipo).toBe('da_controllare')
    if (e.tipo === 'da_controllare') expect(e.motivo).toMatch(/fratell/i)
  })

  it('un fratello con lo ZERO non è una cifra valida nemmeno qui', () => {
    const e = risolviRetta(riga({ rettaTesto: 'vedi fratello' }), [fratelloCon(0)])
    expect(e.tipo).toBe('da_controllare')
  })
})

describe('risolviRetta — quando manca del tutto', () => {
  it('cella vuota → ci si ferma, e il motivo lo dice', () => {
    const e = risolviRetta(riga({}), [])
    expect(e.tipo).toBe('da_controllare')
    if (e.tipo === 'da_controllare') expect(e.motivo).toMatch(/vuot|assent|manca/i)
  })

  it('un punto interrogativo (MANCO MICHELLE) non è una retta', () => {
    const e = risolviRetta(riga({ rettaTesto: '?' }), [])
    expect(e.tipo).toBe('da_controllare')
  })

  it('un testo che non si capisce non viene interpretato', () => {
    const e = risolviRetta(riga({ rettaTesto: 'da definire' }), [])
    expect(e.tipo).toBe('da_controllare')
  })

  it('il motivo è sempre una frase leggibile da una persona, mai un codice', () => {
    const e = risolviRetta(riga({ rettaTesto: '?' }), [])
    if (e.tipo === 'da_controllare') {
      expect(e.motivo.length).toBeGreaterThan(10)
      expect(e.motivo).not.toMatch(/^[A-Z_]+$/)
    }
  })
})
