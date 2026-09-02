import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * `GET /api/parent/primaria` — IL CONTROLLO DEL LEGAME, CHE NESSUN TEST ESERCITAVA.
 *
 * La rotta restituisce il registro di un bambino della primaria: lezioni,
 * valutazioni, NOTE DISCIPLINARI e assenze con lo stato della giustificazione. Chi
 * la apre in veste di famiglia deve avere il legame con quel bambino, e la riga che
 * lo impone era `auth.user.role === 'genitore'`.
 *
 * ⚠️ PERCHÉ QUESTO FILE ESISTE (2026-09-01). Convertendo quella riga ad
 * `agisceComeGenitore` si è provato a invertirla apposta per vedere quale test
 * diventasse rosso: `auth-gaps-m9` e `classe-omonima-scope-sede`, diciotto test,
 * sono rimasti tutti VERDI con il controllo del legame ROVESCIATO — cioè con un
 * genitore che legge il registro di un bambino qualunque. Un presidio mai visto
 * fallire non è un presidio.
 *
 * ─── IL RILIEVO CHE QUESTO FILE DICHIARAVA DI NON CORREGGERE: ORA È CHIUSO ────
 *
 * La testata diceva, e con ragione: il controllo è scritto come
 * `if (agisce da genitore) { serve il legame }`, quindi per chi NON agisce da
 * genitore non c'è nulla — né legame né sede — e il gate a monte è `requireUser`,
 * che ammette ogni utente autenticato. Era la stessa forma dei due difetti chiusi
 * lo stesso giorno in `parent/submissions:POST` e `parent/forms/otp:PATCH`, e
 * restava aperta solo perché fuori dal perimetro di quel lavoro.
 *
 * L'handler ora chiama `requireParentOfStudent`, come le SETTE route sorelle
 * della primaria. Cosa cambia per i tre casi di questo file, uno per uno:
 *
 *  · i due sul GENITORE non cambiano di una virgola — cambia solo il NOME della
 *    funzione che chiede il legame (`verificaLegameGenitore`, esito a tre valori,
 *    al posto del booleano `genitoreHasFiglio`), ed è il motivo per cui il mock
 *    qui sotto li espone entrambi sulla stessa verità;
 *  · il terzo asseriva che in veste di lavoro si passasse SENZA nulla, ed è
 *    proprio ciò che non deve più accadere: oggi chi non è famiglia deve avere il
 *    bambino nel proprio plesso e nella propria sezione. Il caso è stato riscritto
 *    per dire la cosa vera («il legame non si chiede, ma lo scope sì»), e la sua
 *    metà positiva — l'educator che apre il registro di un bambino della PROPRIA
 *    sezione — vive in `parent-primaria-idor.test.ts`, che per verificarla monta
 *    il finto client con i filtri applicati davvero.
 *
 * La misura del difetto sta lì: prima del rimedio, un educator della sede A che
 * chiedeva un minore della sede B riceveva `200` con la nota disciplinare in
 * testo libero dentro il corpo della risposta.
 */

const ALU = 'a0000000-0000-4000-8000-00000000000c'

const h = vi.hoisted(() => ({
  // `ruoli` è l'unione dei ruoli REALI letti dal database (`utenti.ruolo` + il
  // ponte `parents.auth_user_id`), non la veste indossata: è il campo su cui
  // `eFamiglia` decide, ed è assente per i 617 utenti con un ruolo solo.
  utente: {
    id: 'gen1',
    role: 'genitore' as string,
    scuola_id: null as string | null,
    ruoli: undefined as readonly string[] | undefined,
  },
  legame: true,
  /** Quante volte il legame è stato interrogato: `0` significa «non chiesto». */
  legameChiesto: 0,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: vi.fn().mockImplementation(async () => ({ user: { ...h.utente } })),
}))
// I DUE nomi con cui si chiede «è tuo figlio?», tenuti sulla STESSA verità:
// `genitoreHasFiglio` è il booleano che l'handler usava da solo,
// `verificaLegameGenitore` è l'esito a tre valori del gate (`si`/`no`/
// `non-deciso`). Esporne uno solo non lascia un test più severo: lo fa esplodere
// con `is not a function`, che la route trasforma in un 500 — e un 500 non
// distingue «non è tuo figlio» da «il mock è incompleto».
vi.mock('@/lib/anagrafiche/legami', () => ({
  genitoreHasFiglio: vi.fn().mockImplementation(async () => {
    h.legameChiesto++
    return h.legame
  }),
  verificaLegameGenitore: vi.fn().mockImplementation(async () => {
    h.legameChiesto++
    return h.legame ? 'si' : 'no'
  }),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'not', 'order']) b[m] = () => b
      b.maybeSingle = async () => {
        if (table === 'alunni') {
          return { data: { id: ALU, nome: 'Alfa', cognome: 'Beta', section_id: 'sec-1', scuola_id: 'sc-1' }, error: null }
        }
        // `school_type` diverso da 'primaria': la risposta esce subito, e il
        // registro non serve — qui si collauda il GATE, non il contenuto.
        if (table === 'sections') return { data: { school_type: 'infanzia' }, error: null }
        return { data: null, error: null }
      }
      b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res)
      return b
    },
  }),
}))

import { GET } from '@/app/api/parent/primaria/route'

const req = () => new NextRequest(`http://localhost/api/parent/primaria?studentId=${ALU}`)

beforeEach(() => {
  h.utente = { id: 'gen1', role: 'genitore', scuola_id: null, ruoli: undefined }
  h.legame = true
  h.legameChiesto = 0
})

describe('GET /api/parent/primaria — in veste di famiglia serve il legame col bambino', () => {
  it('senza legame → 403, e il registro non viene nemmeno letto', async () => {
    h.legame = false
    const res = await GET(req())
    expect(res.status).toBe(403)
    expect(h.legameChiesto, 'il legame dev’essere stato chiesto: è il presidio').toBe(1)
  })

  it('col legame → 200', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(h.legameChiesto).toBe(1)
  })

  it('a chi NON è famiglia il legame non si chiede — ma lo scope sì, e qui nega', async () => {
    // Chiedere a un educator il legame di parentela col bambino di cui apre il
    // registro gli impedirebbe di lavorare: quel bambino non è suo figlio, è un
    // suo alunno. Perciò il legame resta non interrogato (`legameChiesto === 0`).
    //
    // Ma «non ti chiedo il legame» non vuol dire «non ti chiedo niente», ed è
    // esattamente ciò che questa riga asseriva prima: `200` per un educator
    // qualunque su un bambino qualunque. Qui `ed1` non ha sezioni assegnate
    // (`utenti_sezioni` è vuota nel finto client), quindi `assertAlunnoInScope`
    // risponde «Alunno non nella tua classe».
    //
    // Il rovescio positivo — l'educator che apre il registro di un bambino della
    // PROPRIA sezione e ottiene 200 — sta in `parent-primaria-idor.test.ts`: là
    // il finto client i filtri li applica davvero, e con un mock piatto come
    // questo la differenza fra «in sezione» e «fuori sezione» non è esprimibile.
    h.utente = { id: 'ed1', role: 'educator', scuola_id: 'sc-1', ruoli: undefined }
    const res = await GET(req())
    expect(res.status).toBe(403)
    expect(h.legameChiesto, 'il legame di parentela non si chiede a chi non è famiglia').toBe(0)
  })

  it('la docente-genitore in veste di lavoro passa PER IL LEGAME, non per la veste', async () => {
    // Cinque persone reali in produzione: `utenti.ruolo = 'educator'` PIÙ il ponte
    // `parents.auth_user_id`. La biforcazione del gate è sul LEGAME (`eFamiglia`,
    // ruoli dal database) e non sulla veste (`agisceComeGenitore`, cookie): il
    // figlio può stare in un'altra sede e fuori dalle sezioni che insegnano, e con
    // lo scope di lavoro si prenderebbero un 403 sul registro del PROPRIO figlio.
    h.utente = { id: 'docgen1', role: 'educator', scuola_id: 'sc-1', ruoli: ['educator', 'genitore'] }
    h.legame = true
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(h.legameChiesto, 'chi è famiglia nel DATABASE prova prima il legame').toBe(1)
  })
})
