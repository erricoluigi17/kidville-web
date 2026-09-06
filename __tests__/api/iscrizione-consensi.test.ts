import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi'
import { NextRequest } from 'next/server'
import { CONSENSI_FOTO_CANALI } from '@/lib/forms/enrollment-template'

// =============================================================================
// Informativa e prova dei consensi sul modulo pubblico d'iscrizione.
//
// Il modulo raccoglie allergie, note mediche (BES, DSA, patologie) e il
// documento d'identità del MINORE. Fino al 2026-07-31 lo faceva senza mostrare
// alcuna informativa e senza registrare niente: non mancava un filtro, mancava
// proprio il posto dove scrivere la prova.
//
// Due proprietà, e la seconda conta quanto la prima:
//  1. senza la presa visione dell'informativa l'invio è RESPINTO — e la verifica
//     sta sul SERVER, perché un invio fatto fuori dal wizard non esegue il
//     codice del wizard;
//  2. NON si chiede il consenso per i dati sanitari. Un consenso che non si può
//     rifiutare — senza l'allergia la Scuola non può preparare il pasto in
//     sicurezza — non è libero, e un consenso non libero non è una base
//     giuridica: si tratterebbero dati sanitari di minori credendo di averne una.
//     Il consenso resta sulle FOTO, dove rifiutare non costa nulla al bambino,
//     ed è granulare per canale.
// =============================================================================

const SEDE = SEDE_A

const h = vi.hoisted(() => ({
  inserts: [] as Record<string, unknown>[],
}))

// Modello minimale: un solo campo per bambino/adulto. Qui si prova il consenso,
// non la validazione dei campi, che ha i suoi test.
const minimalModel = {
  schema: {
    version: '1',
    pages: [
      { id: 'bambino', title: 'B', fields: [{ id: 'nome', type: 'text', label: 'Nome', required: true }] },
      { id: 'adulto', title: 'A', fields: [{ id: 'nome', type: 'text', label: 'Nome', required: true }] },
    ],
  },
}

vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: () => ({ ok: true, retryAfterMs: 0 }),
  clientIp: () => '203.0.113.7',
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      if (table === 'schools' || table === 'scuole') {
        const b: Record<string, unknown> = {}
        b.select = () => b
        b.order = () => b
        b.in = () => b
        b.then = (res: (v: unknown) => unknown) =>
          Promise.resolve({ data: [{ id: SEDE, nome: NOME_SEDE_A, attiva: true }], error: null }).then(res)
        return b
      }
      if (table === 'form_models') {
        const b: Record<string, unknown> = {}
        b.select = () => b
        b.eq = () => b
        b.maybeSingle = async () => ({ data: minimalModel, error: null })
        return b
      }
      const b: Record<string, unknown> = {}
      b.insert = (row: Record<string, unknown>) => { h.inserts.push(row); return b }
      b.select = () => b
      b.single = async () => ({ data: { id: 'sub-1' }, error: null })
      return b
    },
  }),
}))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn() }))
vi.mock('@/lib/notifiche/destinatari', () => ({
  staffScuola: vi.fn(async () => []),
  scuolaUnicaReale: vi.fn(async () => SEDE),
}))

import { POST } from '@/app/api/iscrizione/route'
import { CONSENSI_FIELDS } from '@/lib/forms/enrollment-template'
import { VERSIONE_PRIVACY } from '@/lib/legal/versioni'

const invia = (data: Record<string, unknown>) =>
  POST(
    new NextRequest('http://localhost/api/iscrizione', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
      body: JSON.stringify({ scuola_id: SEDE, data }),
    }),
  )

const famiglia = (extra: Record<string, unknown> = {}) => ({
  children: [{ nome: 'Tino', cognome: 'Prova' }],
  adults: [{ nome: 'Ines', cognome: 'Prova' }],
  ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.inserts = []
})

describe('il modulo NON chiede il consenso per i dati sanitari', () => {
  it('nessun blocco obbligatorio riguarda allergie, salute o dati sanitari', () => {
    const obbligatori = CONSENSI_FIELDS.filter((f) => f.required)
    expect(obbligatori).toHaveLength(1)
    expect(obbligatori[0].id).toBe('presa_visione_informativa')
    for (const f of CONSENSI_FIELDS) {
      const testo = `${f.id} ${f.label} ${f.text ?? ''}`.toLowerCase()
      const chiedeConsensoSanitario =
        /acconsento/.test(testo) && /(allergi|salute|sanitar|medic|patologi)/.test(testo)
      expect(chiedeConsensoSanitario, `«${f.label}» chiede un consenso sui dati sanitari`).toBe(false)
    }
  })

  it('il consenso foto è granulare per canale e sempre facoltativo', () => {
    const foto = CONSENSI_FIELDS.filter((f) => f.id.startsWith('consenso_foto_'))
    // Galleria riservata, sito e social sono ambiti diversi: un consenso
    // raccolto per l'uno non copre gli altri (provv. Garante 725/2025).
    expect(foto.map((f) => f.id).sort()).toEqual([
      'consenso_foto_galleria',
      'consenso_foto_sito',
      'consenso_foto_social',
    ])
    for (const f of foto) expect(f.required).toBeFalsy()
  })
})

describe('POST /api/iscrizione — la presa visione è verificata sul SERVER', () => {
  it('senza presa visione: 400, e NIENTE viene scritto', async () => {
    const res = await invia(famiglia())
    expect(res.status).toBe(400)
    const j = await res.json()
    expect(j.consensi).toContain('presa_visione_informativa')
    expect(h.inserts).toHaveLength(0)
  })

  it('presa visione a `false` non vale come accettazione', async () => {
    const res = await invia(famiglia({ presa_visione_informativa: false }))
    expect(res.status).toBe(400)
    expect(h.inserts).toHaveLength(0)
  })

  it('con la presa visione: 201 e la prova viene registrata', async () => {
    const res = await invia(famiglia({ presa_visione_informativa: true }))
    expect(res.status).toBe(201)
    expect(h.inserts).toHaveLength(1)
    const log = h.inserts[0].consents_log as Record<string, unknown>
    expect(log).toBeTruthy()
    expect(log.versione_informativa).toBe(VERSIONE_PRIVACY)
    expect(log.ip).toBe('203.0.113.7')
    const blocchi = log.blocchi as { field_id: string; accepted: boolean; text?: string }[]
    const presa = blocchi.find((b) => b.field_id === 'presa_visione_informativa')
    expect(presa?.accepted).toBe(true)
    // La prova deve dire COSA è stato accettato, non solo che qualcosa lo è
    // stato: il testo mostrato viene congelato dentro la riga.
    expect(presa?.text).toBeTruthy()
  })

  it('la versione NON è spoofabile dal client', async () => {
    await invia(famiglia({ presa_visione_informativa: true, versione_informativa: '1999-01-01' }))
    const log = h.inserts[0].consents_log as Record<string, unknown>
    expect(log.versione_informativa).toBe(VERSIONE_PRIVACY)
    expect(log.versione_informativa).not.toBe('1999-01-01')
  })

  it('i consensi foto rifiutati vengono registrati come rifiutati, non omessi', async () => {
    // Un consenso mancante e un consenso negato non sono la stessa cosa: la
    // prova deve poter distinguere «non gliel'abbiamo chiesto» da «ha detto no».
    await invia(famiglia({ presa_visione_informativa: true, consenso_foto_galleria: false }))
    const log = h.inserts[0].consents_log as Record<string, unknown>
    const blocchi = log.blocchi as { field_id: string; accepted: boolean }[]
    const galleria = blocchi.find((b) => b.field_id === 'consenso_foto_galleria')
    expect(galleria).toBeTruthy()
    expect(galleria?.accepted).toBe(false)
  })
})

/**
 * Il sorgente SENZA commenti. Qui i lock cercano parole — `consents_log`,
 * `CONSENSI_FOTO_CANALI` — che nei file sorvegliati compaiono anche nella prosa
 * che spiega la regola, e devono compararci: un lock che le trovasse nei propri
 * commenti resterebbe verde su codice riscritto da capo. Si guarda il CODICE.
 *
 * Il `//` di uno SCHEMA non è un commento: senza l'esclusione del `:` che lo
 * precede, una riga con `'https://…'` verrebbe troncata e il lock leggerebbe
 * mezzo file convinto di averlo letto tutto. Stessa forma (e stessa ragione) di
 * `__tests__/lib/logging-tetto.test.ts`.
 */
const senzaCommenti = (sorgente: string): string =>
  sorgente.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

describe('la liberatoria foto arriva fino al bambino', () => {
  it('i consensi foto si leggono dalla PROVA, e la route DELEGA alla regola condivisa', async () => {
    // Difetto d'integrazione che questo test blocca: la famiglia acconsentiva e
    // il bambino restava con `consenso_privacy = false`, quindi la galleria gli
    // bloccava le foto. Il consenso c'era, ma non arrivava dove viene letto — e
    // nessuno avrebbe capito perché.
    //
    // ⚠️ 2026-08-01 — QUESTO TEST LOCKAVA IL DIFETTO SUCCESSIVO. Fino a oggi
    // pretendeva `route.not.toContain('consenso_foto_sito')` e
    // `not.toContain('consenso_foto_social')`, cioè inchiodava l'import a
    // leggere UN SOLO canale su tre. Il commento diceva «sono canali distinti e
    // non devono passare di qui» — ma «distinti» vuol dire colonne distinte, non
    // «ignorati»: gli altri due, risposti da 141 famiglie, non arrivavano da
    // nessuna parte (privacy F4). Il difetto era protetto da un'asserzione.
    //
    // Ora il legame consenso→colonna vive in `CONSENSI_FOTO_CANALI` e l'import
    // lo percorre tutto: la prova per canale è in
    // `__tests__/api/iscrizioni-consensi-foto-per-canale.test.ts`, che è
    // comportamentale e cresce da sola con la mappa.
    //
    // ⚠️ 2026-09-06 — IL LOCK HA CAMBIATO CASA, NON MESTIERE. Fino a oggi
    // pretendeva le due cose dentro la ROUTE: `consents_log` accanto a
    // `CONSENSI_FOTO_CANALI`, e l'import di `@/lib/forms/enrollment-template`.
    // Dal 2026-09-05 la regola non abita più lì: sta in
    // `src/lib/iscrizioni/consensi-foto.ts` e la chiamano tutti e due gli import
    // — a mano e in blocco — perché per un mese e mezzo ne è esistita UNA COPIA
    // SOLA, in questa route, e il giro automatico non ne aveva nessuna. Dopo il
    // refactoring le due asserzioni erano diventate rosse per il posto, non per
    // il merito: il lock si sposta dove la regola vive adesso e in più pretende
    // che la route DELEGHI, invece di essere semplicemente cancellato.
    //
    // ⚠️ E SI GUARDA IL CODICE, NON I COMMENTI. La forma originale del lock era
    // una vicinanza fra le due parole — `/consents_log[\s\S]{0,600}CONSENSI_FOTO_CANALI/`
    // — e portata di peso sul modulo sarebbe stata DECORATIVA: misurato il
    // 2026-09-06, restava verde anche dopo aver tolto `CONSENSI_FOTO_CANALI` da
    // tutto il codice, perché le due parole si toccano già dentro la testata che
    // SPIEGA la regola. Un lock soddisfatto dai propri commenti non è un lock:
    // qui si cerca nel sorgente ripulito, e ogni asserzione è stata vista
    // diventare rossa rompendo apposta ciò che sorveglia.
    const { readFileSync } = await import('node:fs')
    const modulo = senzaCommenti(readFileSync('src/lib/iscrizioni/consensi-foto.ts', 'utf8'))
    const route = senzaCommenti(readFileSync('src/app/api/admin/iscrizioni/route.ts', 'utf8'))

    // 1. LA REGOLA legge la prova e percorre la mappa, e le due cose stanno lì.
    // Dalla prova (`consents_log`), non da `data`: `data` è ciò che il client ha
    // mandato, `consents_log` è ciò che il server ha verificato e congelato
    // all'invio. La colonna si nomina nella select, quindi la prova si legge
    // davvero da lì e non si deduce da altro.
    expect(modulo).toContain("select('consents_log')")
    // L'elenco dei canali NON si scrive a mano: viene dalla mappa, percorsa
    // tutta. È l'unica difesa contro il ripetersi dell'elenco troncato al primo.
    expect(modulo).toContain('Object.entries(CONSENSI_FOTO_CANALI)')
    expect(modulo).toContain("from '@/lib/forms/enrollment-template'")

    // 2. LA ROUTE delega: importa la regola condivisa e le passa LA PROVA.
    // Le due asserzioni vanno insieme e nessuna basta da sola: con il solo
    // import, un domani basterebbe rifarsi la regola in casa accanto a una
    // dipendenza inerte; con la sola vicinanza, basterebbe alimentarla con
    // `data` invece che con `consents_log` per tornare al difetto col lock verde.
    expect(route).toContain("from '@/lib/iscrizioni/consensi-foto'")
    expect(route).toMatch(/consensiFotoDaProva[\s\S]{0,200}consents_log/)
    // Controllo positivo: la mappa contiene davvero i tre canali (se si
    // svuotasse, le asserzioni qui sopra resterebbero verdi e non direbbero più
    // niente).
    expect(Object.keys(CONSENSI_FOTO_CANALI)).toEqual(
      expect.arrayContaining(['consenso_foto_galleria', 'consenso_foto_sito', 'consenso_foto_social']),
    )
    expect(CONSENSI_FOTO_CANALI.consenso_foto_galleria).toBe('consenso_privacy')
  })
})
