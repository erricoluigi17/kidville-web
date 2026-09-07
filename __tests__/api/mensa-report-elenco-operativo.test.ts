import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// =============================================================================
// L'ELENCO ALLERGIE DEL REPORT MENSA È UNA SUPERFICIE OPERATIVA, NON UN CONTATORE.
//
// Qui non si conta chi ha un'allergia: si decide cosa NON mettere nel piatto di un
// bambino. Quindi la regola è più larga di quella dei contatori dell'anagrafica:
//  · un testo fuori dai 14 allergeni UE — «fragole», «kiwi», «nichel» — RESTA, e
//    sono 33 righe su 60 in produzione: sparirebbero dal foglio di chi cucina;
//  · una NEGAZIONE («Nessuna», «N/A») esce, perché non è un'allergia ma il modo in
//    cui qualcuno ha scritto di non averne. In produzione l'elenco passa da 60 a 57.
//
// Prima la condizione era `(a.allergies ?? '').trim().length > 0 || eff.length > 0`:
// bastava che ci fosse del testo, e «Nessuna» era testo.
//
// ⚠️ IL CASO REALE, che vale più di tutti gli altri: una frase che contiene
// «di nessun tipo» in mezzo (un fastidio al lattosio, cibi che il bambino non
// mangia) NON è una negazione. Col vecchio criterio a sottostringa dello script di
// backfill sarebbe sparita da questo elenco — cioè dal foglio della cucina.
// =============================================================================

const ADMIN = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1'

const h = vi.hoisted(() => ({
  utente: null as Record<string, unknown> | null,
  prenotazioni: [] as { alunno_id: string }[],
  alunni: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/auth/scope', () => ({ resolveScuolaScrittura: async () => ({ scuolaId: 'sc-1' }) }))
vi.mock('@/lib/sezioni/docenti', () => ({ nomiSezioniDiUtente: async () => [], sezioniDiUtente: async () => [] }))
vi.mock('@/lib/mensa/server', () => ({
  loadMensaConfig: async () => ({ cutoffOra: '09:30', giorniAttivi: [1, 2, 3, 4, 5], settimaneRotazione: 4, sogliaSaldoBasso: 5 }),
  loadResolveOptions: async () => ({ menuConfigId: null }),
  resolveMenuConfigId: async () => null,
}))
// Menu spento: qui non si guardano i conflitti col piatto del giorno, si guarda
// CHI finisce nell'elenco. Con il menu attivo un conflitto potrebbe far entrare
// una riga per un'altra ragione, e la misura non direbbe più cosa crede di dire.
vi.mock('@/lib/mensa/resolveMenu', () => ({
  resolveMenuGiorno: () => ({ attivo: false, chiuso: false, allergeni: null }),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b; b.eq = () => b; b.in = () => b; b.order = () => b
      b.single = async () => ({ data: h.utente, error: null })
      b.then = (res: (v: unknown) => void) => {
        if (table === 'mensa_prenotazioni') return res({ data: h.prenotazioni, error: null })
        if (table === 'alunni') return res({ data: h.alunni, error: null })
        return res({ data: [], error: null })
      }
      return b
    },
  }),
}))

import { GET } from '@/app/api/mensa/report/route'

const req = () => new NextRequest('http://localhost/api/mensa/report', { headers: { 'x-user-id': ADMIN } })

const CASI: { id: string; nome: string; allergeni: string[]; allergies: string | null; inElenco: boolean; perche: string }[] = [
  { id: 'a1', nome: 'Strutturato', allergeni: ['glutine'], allergies: null, inElenco: true, perche: 'allergene spuntato' },
  { id: 'a2', nome: 'DaiQuattordici', allergeni: [], allergies: 'arachidi', inElenco: true, perche: 'testo fra i 14 UE' },
  { id: 'a3', nome: 'FuoriDaiQuattordici', allergeni: [], allergies: 'fragole', inElenco: true, perche: 'allergia vera fuori dai 14: il piatto la deve sapere' },
  { id: 'a4', nome: 'FraseConNessun', allergeni: [], allergies: 'non mangia crudi di nessun tipo, fastidio al lattosio', inElenco: true, perche: 'il caso reale: «nessun» in mezzo non è una negazione' },
  { id: 'a5', nome: 'Negazione', allergeni: [], allergies: 'Nessuna allergia nota', inElenco: false, perche: 'negazione a vocabolario intero' },
  { id: 'a6', nome: 'NegazioneBreve', allergeni: [], allergies: 'N/A', inElenco: false, perche: 'negazione' },
  { id: 'a7', nome: 'Vuoto', allergeni: [], allergies: '   ', inElenco: false, perche: 'niente da mettere in elenco' },
  { id: 'a8', nome: 'SenzaNiente', allergeni: [], allergies: null, inElenco: false, perche: 'niente da mettere in elenco' },
  // Le due fonti che si contraddicono, e il testo vinceva sempre: il bambino
  // entrava in elenco (giusto, una spunta è una dichiarazione) e accanto al suo
  // nome la cucina leggeva «nessuna». Vedi la prova sul TESTO qui sotto.
  { id: 'a9', nome: 'SpuntaControTesto', allergeni: ['latte'], allergies: 'nessuna', inElenco: true, perche: 'la spunta è una dichiarazione: il testo non la smentisce' },
  // Chiave in archivio fuori dalle 14: `normalizzaAllergeni` la scartava, e senza
  // testo libero il bambino usciva del tutto dal foglio della cucina.
  { id: 'a10', nome: 'ChiaveIgnota', allergeni: ['nichel'], allergies: null, inElenco: true, perche: 'una restrizione dichiarata non sparisce perché la chiave non è fra le 14' },
]

beforeEach(() => {
  vi.clearAllMocks()
  h.utente = { id: ADMIN, nome: 'Adm', cognome: 'In', ruolo: 'admin', role: 'admin', scuola_id: 'sc-1' }
  h.prenotazioni = CASI.map((c) => ({ alunno_id: c.id }))
  h.alunni = CASI.map((c) => ({
    id: c.id, nome: c.nome, cognome: 'Finto', classe_sezione: 'Rossi',
    allergeni: c.allergeni, allergies: c.allergies,
  }))
})

async function elenco(): Promise<string[]> {
  const res = await GET(req())
  expect(res.status).toBe(200)
  const j = (await res.json()) as { data: { allergie: { nome: string }[] } }
  return j.data.allergie.map((r) => r.nome)
}

describe('GET /api/mensa/report — chi entra nell\'elenco allergie della cucina', () => {
  it('ogni caso entra o esce per la ragione che ha scritta accanto', async () => {
    const nomi = await elenco()
    for (const c of CASI) {
      const atteso = c.inElenco
      expect(nomi.includes(`${c.nome} Finto`), `${c.nome} — ${c.perche}`).toBe(atteso)
    }
  })

  it('le negazioni e il vuoto sono gli UNICI tolti: 6 righe su 10', async () => {
    // Il numero secco è il controllo che il filtro non sia diventato né più largo
    // (torna «Nessuna») né più stretto (sparisce «fragole», e con lei 33 righe
    // vere in produzione).
    expect((await elenco()).length).toBe(CASI.filter((c) => c.inElenco).length)
  })

  it('il testo dell\'allergia arriva alla cucina COM\'È, non riassunto in chiavi', async () => {
    const res = await GET(req())
    const j = (await res.json()) as { data: { allergie: { nome: string; allergie: string; conflitto: boolean }[] } }
    const fragole = j.data.allergie.find((r) => r.nome.startsWith('FuoriDaiQuattordici'))!
    expect(fragole.allergie).toBe('fragole')
    // E la forma della riga non è cambiata: `{nome, classe, allergie, conflitto}`.
    expect(Object.keys(fragole).sort()).toEqual(['allergie', 'classe', 'conflitto', 'nome'])
  })

  it('LE DUE FONTI SI SOMMANO: accanto al nome non si legge più «nessuna»', async () => {
    // La riga era `allergie: (a.allergies ?? '').trim() || eff.join(', ')`, cioè il
    // testo libero VINCEVA sempre sulle chiavi spuntate. Il motore faceva entrare
    // questo bambino in elenco — e la cucina, accanto al suo nome, leggeva la
    // parola «nessuna». È il foglio con cui si prepara il piatto.
    const res = await GET(req())
    const j = (await res.json()) as { data: { allergie: { nome: string; allergie: string }[] } }
    const riga = j.data.allergie.find((r) => r.nome.startsWith('SpuntaControTesto'))!
    expect(riga.allergie).toBe('Latte / lattosio')
    expect(riga.allergie).not.toContain('nessuna')
  })

  it('una chiave fuori dalle 14 arriva alla cucina COM\'È, come sul prestampato di banco', async () => {
    const res = await GET(req())
    const j = (await res.json()) as { data: { allergie: { nome: string; allergie: string }[] } }
    const riga = j.data.allergie.find((r) => r.nome.startsWith('ChiaveIgnota'))!
    expect(riga.allergie).toBe('nichel')
  })

  it('chiavi ED etichette insieme quando ci sono tutt\'e due', async () => {
    // `Strutturato` ha la spunta e nessun testo; `DaiQuattordici` ha solo il testo.
    const res = await GET(req())
    const j = (await res.json()) as { data: { allergie: { nome: string; allergie: string }[] } }
    const perNome = (p: string) => j.data.allergie.find((r) => r.nome.startsWith(p))!.allergie
    expect(perNome('Strutturato')).toBe('Glutine')
    // Il testo non si riassume in chiavi: qui NON si legge «Arachidi», si legge
    // ciò che la persona ha scritto.
    expect(perNome('DaiQuattordici')).toBe('arachidi')
  })
})
