import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { senzaFirmaInApp, ALUNNI_PER_RICHIESTA, type ModuloDelRegistro } from '@/lib/anno/senza-firma-app'
import { clientTabelle, type ErroreFinto, type Richiesta, type Riga } from '../helpers/supabase-tabelle-finto'

/**
 * COMPITO 4.7.2 · «chi non ha firmato in app», il calcolo. La regola dell'anno è quella di `firmatoInAppIl` (NON si ripete qui: il
 * test usa la funzione vera) e le letture sono quelle del client finto, che applica davvero i filtri. Due moduli veri del registro:
 * `delega_ritiro` (durata `anno`) e `scheda_sanitaria` (`fino_a_revoca`). Date fisse. Solo uuid finti.
 */

const SEDE = '22222222-2222-4222-8222-222222222222'
const ANNO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PRIMA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const al = (n: number) => `a1a1a1a1-a1a1-4a1a-8a1a-${String(n).padStart(12, '0')}`
const fr = (n: number) => `f1f1f1f1-f1f1-4f1f-8f1f-${String(n).padStart(12, '0')}`

const DELEGA: ModuloDelRegistro = { id: '71717171-7171-4717-8717-717171717171', codice: 'delega_ritiro', lista: 'conferma' }
const SANITARIA: ModuloDelRegistro = { id: '72727272-7272-4727-8727-727272727272', codice: 'scheda_sanitaria', lista: 'conferma' }

let tabelle: Record<string, Riga[]>
let errori: Record<string, ErroreFinto | undefined>
let richieste: Richiesta[]
const client = () => clientTabelle(() => tabelle, () => errori, richieste) as unknown as SupabaseClient

const frequenza = (n: number, alunno: number, tipo: string, stato: string, section: string | null = null): Riga =>
  ({ id: fr(n), alunno_id: al(alunno), anno_sede_id: ANNO, tipo, stato, section_id: section })
const documento = (n: number, alunno: number, tipo: string, creato: string, eliminato: string | null = null): Riga =>
  ({ id: `d0d0d0d0-d0d0-4d0d-8d0d-${String(n).padStart(12, '0')}`, student_id: al(alunno), document_type: tipo, created_at: creato, eliminato_il: eliminato })

beforeEach(() => {
  richieste = []
  errori = {}
  tabelle = {
    anni_sede: [
      { id: ANNO, scuola_id: SEDE, inizio: '2027-09-01', fine: '2028-08-31', ultimo_giorno_aperto: '2028-07-31' },
      { id: PRIMA, scuola_id: SEDE, inizio: '2026-09-01', fine: '2027-08-31', ultimo_giorno_aperto: '2027-07-31' },
    ],
    frequenze: [
      frequenza(1, 1, 'conferma', 'in_attesa'), // firma nell'anno → non compare
      frequenza(2, 2, 'conferma', 'iscritto'), // firma dell'anno prima → compare
      frequenza(3, 3, 'conferma', 'ritirato'), // non viva → mai considerata
      frequenza(4, 4, 'nuova', 'in_attesa'), // altra lista → mai considerata
      frequenza(5, 5, 'conferma', 'in_attesa'), // firma dopo la fine dell'anno + una eliminata → compare
      frequenza(6, 6, 'conferma', 'in_attesa'), // nessun documento → compare
    ],
    student_documents: [
      documento(1, 1, 'delega_ritiro', '2027-10-05T09:00:00Z'),
      documento(2, 2, 'delega_ritiro', '2026-10-05T09:00:00Z'),
      documento(3, 5, 'delega_ritiro', '2028-09-10T09:00:00Z'),
      documento(4, 5, 'delega_ritiro', '2027-10-01T09:00:00Z', '2027-11-01T09:00:00Z'),
      documento(5, 2, 'scheda_sanitaria', '2026-10-05T09:00:00Z'),
    ],
  }
})

const idFrequenze = (r: Awaited<ReturnType<typeof senzaFirmaInApp>>) => (r.ok ? r.righe.map((x) => x.frequenza_id) : null)

describe('senzaFirmaInApp', () => {
  it('un bambino con la firma nell\'anno non compare; uno senza sì; una firma di dopo la fine dell\'anno e una eliminata non contano', async () => {
    const r = await senzaFirmaInApp(client(), { annoSedeId: ANNO, modulo: DELEGA })
    expect(idFrequenze(r)).toEqual([fr(2), fr(5), fr(6)])
    expect(r.ok && r.viveDellaLista).toBe(4)
  })

  it('un modulo «fino a revoca» riconosce anche la firma di un anno prima', async () => {
    const r = await senzaFirmaInApp(client(), { annoSedeId: ANNO, modulo: SANITARIA })
    expect(idFrequenze(r)).toEqual([fr(1), fr(5), fr(6)]) // il 2 ha firmato nel 2026 e vale ancora
  })

  it('considera solo le frequenze vive della lista del modulo: la lista «nuova» ha il suo elenco', async () => {
    const r = await senzaFirmaInApp(client(), { annoSedeId: ANNO, modulo: { ...DELEGA, lista: 'nuova' } })
    expect(idFrequenze(r)).toEqual([fr(4)])
  })

  it('porta nome della sezione solo come uuid: nessun nome di persona esce dalla libreria', async () => {
    tabelle.frequenze = [frequenza(1, 1, 'conferma', 'in_attesa', '51515151-5151-4515-8515-515151515151')]
    tabelle.student_documents = []
    const r = await senzaFirmaInApp(client(), { annoSedeId: ANNO, modulo: DELEGA })
    expect(r.ok && r.righe).toEqual([{ frequenza_id: fr(1), alunno_id: al(1), section_id: '51515151-5151-4515-8515-515151515151' }])
  })

  it('dal fascicolo legge SOLO student_id, document_type, created_at, e solo i documenti vivi', async () => {
    await senzaFirmaInApp(client(), { annoSedeId: ANNO, modulo: DELEGA })
    const sulFascicolo = richieste.filter((x) => x.tabella === 'student_documents')
    expect(sulFascicolo.length).toBeGreaterThan(0)
    for (const x of sulFascicolo) {
      expect(x.colonne).toBe('student_id, document_type, created_at')
      expect(x.filtri['is:eliminato_il']).toBeNull() // fascicoloVivo
    }
  })

  it('i bambini vanno al fascicolo a gruppi: nessuna richiesta oltre ALUNNI_PER_RICHIESTA', async () => {
    const n = ALUNNI_PER_RICHIESTA * 2 + 50
    tabelle.frequenze = Array.from({ length: n }, (_, i) => frequenza(i + 1, i + 1, 'conferma', 'in_attesa'))
    tabelle.student_documents = [documento(1, n, 'delega_ritiro', '2027-10-05T09:00:00Z')]
    const r = await senzaFirmaInApp(client(), { annoSedeId: ANNO, modulo: DELEGA })
    // l'ultimo bambino (nell'ultimo gruppo) ha firmato: se il terzo gruppo non fosse letto comparirebbe fra i senza firma
    expect(r.ok && r.righe.length).toBe(n - 1)
    expect(r.ok && r.righe.some((x) => x.alunno_id === al(n))).toBe(false)
    const gruppi = richieste.filter((x) => x.tabella === 'student_documents').map((x) => (x.filtri['in:student_id'] as string[]).length)
    expect(gruppi).toEqual([ALUNNI_PER_RICHIESTA, ALUNNI_PER_RICHIESTA, 50])
  })

  it('PostgREST in errore → mai un elenco: l\'esito è l\'errore, qualunque sia la lettura che cade', async () => {
    for (const tabella of ['anni_sede', 'frequenze', 'student_documents']) {
      errori = { [tabella]: { code: 'XX000', message: 'boom' } }
      const r = await senzaFirmaInApp(client(), { annoSedeId: ANNO, modulo: DELEGA })
      expect(r.ok, tabella).toBe(false)
      expect(!r.ok && r.error.code, tabella).toBe('XX000')
    }
  })

  it('l\'anno che non c\'è è un errore, non un elenco vuoto', async () => {
    tabelle.anni_sede = []
    const r = await senzaFirmaInApp(client(), { annoSedeId: ANNO, modulo: DELEGA })
    expect(r.ok).toBe(false)
  })

  it('senza un anno prima, la soglia di una firma annuale è l\'inizio dell\'anno', async () => {
    tabelle.anni_sede = [{ id: ANNO, scuola_id: SEDE, inizio: '2027-09-01', fine: '2028-08-31', ultimo_giorno_aperto: '2028-07-31' }]
    tabelle.student_documents = [documento(1, 1, 'delega_ritiro', '2027-08-20T09:00:00Z')]
    const r = await senzaFirmaInApp(client(), { annoSedeId: ANNO, modulo: DELEGA })
    expect(r.ok && r.righe.some((x) => x.alunno_id === al(1))).toBe(true) // 20/08 è prima dell'inizio: non vale
  })
})
