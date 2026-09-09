import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'

// =============================================================================
// `GET /api/parent/primaria` — L'ALLEGATO DEL REGISTRO ARRIVAVA ALLA FAMIGLIA
// COME PERCORSO DI BUCKET, CIOÈ COME LINK MORTO.
//
// ─── LA FORMA DEL DIFETTO ────────────────────────────────────────────────────
//
// `primaria/allegati:POST` archivia in `allegati_registro.file_url` il PERCORSO
// dentro un contenitore PRIVATO (`public: false`) — `registro/<uuid>/<ts>.jpg` —
// e non un indirizzo: l'indirizzo lo genera la LETTURA, firmato e a scadenza
// breve, dietro al gate della route che lo serve. È il modello già in esercizio
// su galleria, avvisi, incarichi e chat.
//
// Questa route restituiva quel percorso GREZZO. Il componente della famiglia lo
// metteva in `href`, il browser lo risolveva come indirizzo RELATIVO
// (`https://app.kidville.it/parent/compiti/registro/<uuid>/…`) e rispondeva 404.
// Nessun log, nessun errore: soltanto un allegato che non si apre.
//
// ─── PERCHÉ SI ASSERISCE ANCHE SUL FALLIMENTO ────────────────────────────────
//
// Il ripiego sbagliato è restituire il percorso quando la firma non riesce: come
// indirizzo non funziona lo stesso, e maschera il guasto dello Storage da
// «allegato rotto». Il contratto del progetto (`firmaPercorsi`) è `null`, e il
// motivo finisce nel log col corpo dell'errore del provider.
//
// ─── COME L'HA VISTO FALLIRE ─────────────────────────────────────────────────
//
// Prima del rimedio: `file_url` usciva IDENTICO al percorso salvato e lo Storage
// non veniva toccato affatto (`h.firme` vuoto). Le due asserzioni che aprono il
// primo caso sono nate rosse su quello.
//
// ⚠️ Il finto client Supabase LANCIA su `storage.from(...)`: qui `client.storage`
// viene sostituito da un finto Storage che REGISTRA bucket, percorsi e TTL, così
// «ha firmato» è una proprietà verificata e non una speranza.
// =============================================================================

const SEDE = 'aaaaaaaa-0000-4000-8000-00000000000a'
const ALUNNO = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const BUCKET = 'registro-allegati'
const TTL_ATTESO = 600

/** Il percorso come lo archivia `primaria/allegati:POST`. Mai un indirizzo. */
const PERCORSO_FOTO = 'registro/11111111-2222-4333-8444-555555555555/1757000000000-ab12cd3.jpg'
const PERCORSO_PDF = 'registro/11111111-2222-4333-8444-555555555555/1757000000001-ef45gh6.pdf'

/** La data di oggi: la route legge gli ultimi 14 giorni di registro. */
const OGGI = new Date().toISOString().slice(0, 10)

type RispostaFirma = {
  data: Array<{ path: string | null; signedUrl: string | null; error?: string | null }> | null
  error: unknown
}

const h = vi.hoisted(() => ({
  requireParentOfStudent: vi.fn(),
  logEvento: vi.fn(),
  db: {} as DBFinto,
  tabelle: [] as string[],
  /** Ogni chiamata a `createSignedUrls`: bucket, percorsi e TTL richiesti. */
  firme: [] as Array<{ bucket: string; percorsi: string[]; ttl: number }>,
  /** `null` = risposta felice costruita sui percorsi ricevuti. */
  risposta: null as RispostaFirma | null,
}))

vi.mock('@/lib/auth/require-parent', () => ({
  requireParentOfStudent: (...a: unknown[]) => h.requireParentOfStudent(...a),
}))

vi.mock('@/lib/logging/logger', async (originale) => {
  const reale = await originale<typeof import('@/lib/logging/logger')>()
  return { ...reale, logEvento: (...a: unknown[]) => h.logEvento(...a) }
})

vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const conStorage = () => {
    const client = creaFintoSupabase(h.db, h.tabelle) as unknown as { storage: unknown }
    // Il finto client lancia su `storage`: lo si sostituisce, com'è documentato
    // nel fixture, con uno che registra gli accessi.
    client.storage = {
      from: (bucket: string) => ({
        createSignedUrls: async (percorsi: string[], ttl: number) => {
          h.firme.push({ bucket, percorsi, ttl })
          if (h.risposta) return h.risposta
          return {
            data: percorsi.map((p) => ({
              path: p,
              signedUrl: `https://finto.supabase.co/storage/v1/object/sign/${bucket}/${p}?token=finto`,
              error: null,
            })),
            error: null,
          }
        },
      }),
    }
    return client
  }
  return { createAdminClient: async () => conStorage(), createClient: async () => conStorage() }
})

import { GET } from '@/app/api/parent/primaria/route'

const req = () => new NextRequest(`http://localhost/api/parent/primaria?studentId=${ALUNNO}`)

/** Una riga di registro con gli allegati già annidati (il fixture non fa i join). */
const rigaRegistro = (allegati: Array<Record<string, unknown>>) => ({
  id: 'r-1',
  section_id: 'sec-a',
  data: OGGI,
  ora_lezione: 1,
  materia: null,
  argomento: 'Le frazioni',
  compiti: 'Esercizi 3 e 4',
  data_consegna_compiti: null,
  materie: { nome: 'Matematica' },
  firme_docenti: [],
  registro_destinatari: [],
  allegati_registro: allegati,
})

const dbBase = (allegati: Array<Record<string, unknown>>): DBFinto => ({
  sections: [{ id: 'sec-a', scuola_id: SEDE, school_type: 'primaria' }],
  alunni: [{ id: ALUNNO, nome: 'Alfa', cognome: 'Beta', section_id: 'sec-a', scuola_id: SEDE }],
  admin_settings: [],
  registro_orario: [rigaRegistro(allegati)],
  materie: [],
  presenze: [],
  valutazioni: [],
  note_disciplinari: [],
})

/** Gli allegati della prima lezione, come li riceve il browser della famiglia. */
async function allegatiDellaRisposta() {
  const res = await GET(req())
  expect(res.status).toBe(200)
  const corpo = await res.json()
  return corpo.data.lezioni[0].allegati as Array<{ id: string; file_url: string | null; file_name: string | null }>
}

beforeEach(() => {
  vi.clearAllMocks()
  h.tabelle = []
  h.firme = []
  h.risposta = null
  h.requireParentOfStudent.mockResolvedValue({ user: { id: 'gen-1', role: 'genitore' }, response: null })
  h.db = dbBase([
    { id: 'al-1', tipo: 'immagine', file_url: PERCORSO_FOTO, file_name: 'lavagna.jpg' },
    { id: 'al-2', tipo: 'pdf', file_url: PERCORSO_PDF, file_name: 'scheda.pdf' },
  ])
})

describe('l’allegato del registro esce FIRMATO, mai come percorso di bucket', () => {
  it('il percorso salvato diventa un indirizzo firmato del bucket `registro-allegati`', async () => {
    const allegati = await allegatiDellaRisposta()

    // Le due asserzioni su cui il file è nato rosso.
    expect(allegati.map((a) => a.file_url)).not.toContain(PERCORSO_FOTO)
    expect(h.firme, 'lo Storage dev’essere stato interrogato: è tutto il rimedio').toHaveLength(1)

    expect(allegati[0].file_url).toBe(
      `https://finto.supabase.co/storage/v1/object/sign/${BUCKET}/${PERCORSO_FOTO}?token=finto`,
    )
    expect(allegati[1].file_url).toContain(PERCORSO_PDF)
  })

  it('una sola chiamata allo Storage per tutta la pagina, sul bucket e col TTL del progetto', async () => {
    await allegatiDellaRisposta()
    expect(h.firme).toHaveLength(1)
    expect(h.firme[0].bucket).toBe(BUCKET)
    expect(h.firme[0].ttl).toBe(TTL_ATTESO)
    expect(h.firme[0].percorsi.sort()).toEqual([PERCORSO_PDF, PERCORSO_FOTO].sort())
  })

  it('nessun percorso grezzo sopravvive da nessuna parte nel corpo della risposta', async () => {
    const res = await GET(req())
    const testo = JSON.stringify(await res.json())
    // Il percorso compare DENTRO l'indirizzo firmato: si cerca la forma nuda,
    // cioè il valore fra virgolette come lo scriveva la route prima del rimedio.
    expect(testo).not.toContain(`"${PERCORSO_FOTO}"`)
    expect(testo).not.toContain(`"${PERCORSO_PDF}"`)
  })

  it('id, tipo e nome del file restano quelli: si sostituisce l’indirizzo, non l’allegato', async () => {
    const allegati = await allegatiDellaRisposta()
    expect(allegati.map((a) => a.id)).toEqual(['al-1', 'al-2'])
    expect(allegati.map((a) => a.file_name)).toEqual(['lavagna.jpg', 'scheda.pdf'])
  })
})

describe('quando la firma non riesce esce `null`, mai il percorso', () => {
  it('errore dello Storage → `file_url: null` per tutti, e il motivo nel log', async () => {
    h.risposta = { data: null, error: { message: 'bucket not found', statusCode: '404' } }
    const allegati = await allegatiDellaRisposta()

    expect(allegati.map((a) => a.file_url)).toEqual([null, null])
    const errori = h.logEvento.mock.calls.filter((c) => c[0] === 'storage' && c[1] === 'error')
    expect(errori.length, 'un fallimento muto è il difetto, non il rimedio').toBeGreaterThan(0)
    expect((errori[0][2] as { operazione?: string }).operazione).toBe('parent/primaria:GET')
  })

  it('firma PARZIALE: chi si è firmato esce firmato, chi no esce `null`', async () => {
    h.risposta = {
      data: [{ path: PERCORSO_FOTO, signedUrl: 'https://finto.supabase.co/firmato', error: null }],
      error: null,
    }
    const allegati = await allegatiDellaRisposta()
    expect(allegati[0].file_url).toBe('https://finto.supabase.co/firmato')
    expect(allegati[1].file_url).toBeNull()
  })

  it('un `file_url` vuoto non fa partire nessuna firma e resta `null`', async () => {
    h.db = dbBase([{ id: 'al-1', tipo: 'immagine', file_url: null, file_name: 'senza-percorso.jpg' }])
    const allegati = await allegatiDellaRisposta()
    expect(h.firme, 'niente da firmare: lo Storage non si tocca').toHaveLength(0)
    expect(allegati[0].file_url).toBeNull()
  })

  it('una lezione SENZA allegati non tocca lo Storage e resta con l’elenco vuoto', async () => {
    h.db = dbBase([])
    const allegati = await allegatiDellaRisposta()
    expect(allegati).toEqual([])
    expect(h.firme).toHaveLength(0)
  })
})
