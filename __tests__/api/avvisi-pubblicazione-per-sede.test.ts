import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, SEDE_C } from '../fixtures/sedi'
import { RUOLI_PUBBLICAZIONE_DEFAULT } from '@/lib/scuole/admin-settings-default'

// =============================================================================
// Chi può pubblicare un avviso, sede per sede (S24 · backend F3 del ciclo 2).
//
// IL DIFETTO, misurato in produzione il 2026-07-31. Kidville Aversa e Kidville
// Cesa sono nate il 29 luglio con `admin_settings.avvisi_config = {}`: il
// provisioning non popolava quella configurazione, perché quando la sede era una
// sola il corredo era implicito. Da lì due errori si sommavano:
//   1. il default di codice era `['admin']`, mentre la SCHERMATA
//      (AvvisiSettings.tsx:42) mostra selezionati «Segreteria/Admin» E «Docenti»
//      — cioè il server negava ciò che l'interfaccia dichiarava permesso;
//   2. la mappatura del ruolo metteva `segreteria` nel gruppo `teacher`, benché
//      la pillola `admin` si chiami «Segreteria/Admin» e tutto il resto
//      dell'applicazione tratti la segreteria come gestione (active-role.ts:24,
//      require-staff.ts:272, scope.ts:240).
// Risultato: `test.aversa.segreteria` riceveva
// `403 «La pubblicazione di avvisi è riservata alla segreteria»` — il messaggio
// nominava come autorizzato ESATTAMENTE il ruolo che stava negando.
//
// METODO. Niente `not.toBe(403)`: si asserisce lo stato esatto, il CORPO del
// messaggio e l'effetto sul database (`avvisi` scritta o vuota, nessuna
// scrittura, nessuna notifica). Ogni diniego ha accanto il suo controllo
// positivo sulla STESSA sede, altrimenti un gate che nega tutto passerebbe.
// =============================================================================

const SEGRETERIA_A = '11111111-1111-4111-8111-aaaaaaaaaaaa'
const ADMIN_A = '22222222-2222-4222-8222-aaaaaaaaaaaa'
const EDUCATOR_A = '33333333-3333-4333-8333-aaaaaaaaaaaa'
const SEGRETERIA_B = '44444444-4444-4444-8444-bbbbbbbbbbbb'
const EDUCATOR_B = '55555555-5555-4555-8555-bbbbbbbbbbbb'
const SEGRETERIA_C = '66666666-6666-4666-8666-cccccccccccc'

const GEN_A = 'a0a0a0a0-0000-4000-8000-00000000000a'
const GEN_B = 'b0b0b0b0-0000-4000-8000-00000000000b'
const GEN_C = 'c0c0c0c0-0000-4000-8000-00000000000c'
const ALU_A = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_B = 'b1b1b1b1-1111-4111-8111-bbbbbbbbbbbb'
const ALU_C = 'c1c1c1c1-1111-4111-8111-cccccccccccc'

/** Nome di classe presente in tutte e tre le sedi (l'omonimia non è il tema qui). */
const CLASSE = 'TEST Infanzia'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireDocente: vi.fn(),
  notificaEvento: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as unknown[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: h.requireUser,
  requireDocente: h.requireDocente,
}))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture as Scrittura[] }),
  }
})

import { POST } from '@/app/api/avvisi/route'

const post = (body: unknown) =>
  new NextRequest('http://localhost/api/avvisi', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const dbBase = (): DBFinto => ({
  utenti_scuole: [],
  utenti: [
    { id: SEGRETERIA_A, ruolo: 'segreteria', role: 'segreteria', scuola_id: SEDE_A },
    { id: ADMIN_A, ruolo: 'admin', role: 'admin', scuola_id: SEDE_A },
    { id: EDUCATOR_A, ruolo: 'educator', role: 'educator', scuola_id: SEDE_A },
    { id: SEGRETERIA_B, ruolo: 'segreteria', role: 'segreteria', scuola_id: SEDE_B },
    { id: EDUCATOR_B, ruolo: 'educator', role: 'educator', scuola_id: SEDE_B },
    { id: SEGRETERIA_C, ruolo: 'segreteria', role: 'segreteria', scuola_id: SEDE_C },
  ],
  sections: [
    { id: 'sec-a', scuola_id: SEDE_A, name: CLASSE },
    { id: 'sec-b', scuola_id: SEDE_B, name: CLASSE },
    { id: 'sec-c', scuola_id: SEDE_C, name: CLASSE },
  ],
  // Ogni educator insegna nella classe della PROPRIA sede: il gate sul target
  // (`verificaTargetAvvisoDocente`) non deve mai essere la ragione del diniego,
  // altrimenti il test proverebbe un'altra difesa.
  utenti_sezioni: [
    { utente_id: EDUCATOR_A, section_id: 'sec-a', sections: { name: CLASSE } },
    { utente_id: EDUCATOR_B, section_id: 'sec-b', sections: { name: CLASSE } },
  ],
  alunni: [
    { id: ALU_A, scuola_id: SEDE_A, classe_sezione: CLASSE, section_id: 'sec-a' },
    { id: ALU_B, scuola_id: SEDE_B, classe_sezione: CLASSE, section_id: 'sec-b' },
    { id: ALU_C, scuola_id: SEDE_C, classe_sezione: CLASSE, section_id: 'sec-c' },
  ],
  legame_genitori_alunni: [
    { alunno_id: ALU_A, genitore_id: GEN_A },
    { alunno_id: ALU_B, genitore_id: GEN_B },
    { alunno_id: ALU_C, genitore_id: GEN_C },
  ],
  student_parents: [],
  parents: [],
  admin_settings: [
    // SEDE A — la sede NUOVA, esattamente com'erano Aversa e Cesa il 31/07:
    // la riga esiste (il provisioning la crea), ma la configurazione avvisi è
    // vuota. La colonna è `NOT NULL DEFAULT '{}'`, quindi questo è il valore
    // reale letto in produzione, non un'ipotesi.
    { scuola_id: SEDE_A, avvisi_config: {} },
    // SEDE B — la Direzione ha DECISO: pubblica solo la gestione.
    { scuola_id: SEDE_B, avvisi_config: { ruoli_pubblicazione: ['admin'] } },
    // SEDE C — nessuno abilitato: caso limite, ma la configurazione lo permette.
    { scuola_id: SEDE_C, avvisi_config: { ruoli_pubblicazione: [] } },
  ],
  avvisi: [],
  audit_scritture_docente: [],
})

const avvisiScritti = () => h.db.avvisi ?? []
const corpo = (extra: Record<string, unknown> = {}) => ({
  titolo: 'Chiusura per festività',
  contenuto: 'La sede resta chiusa lunedì.',
  target_scope: 'classe',
  target_classes: [CLASSE],
  ...extra,
})

/** Autentica l'utente indicato e pubblica sulla sede dichiarata. */
async function pubblica(
  utente: { id: string; role: string; scuola_id: string },
  sede: string,
) {
  h.requireUser.mockResolvedValue({ user: utente })
  h.requireDocente.mockResolvedValue({ user: utente })
  const res = await POST(post(corpo({ scuola_id: sede })))
  return { res, body: (await res.json()) as { error?: string } }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.notificaEvento.mockResolvedValue(undefined)
})

describe('POST /api/avvisi — una sede senza `avvisi_config` non blocca la segreteria', () => {
  it('SEGRETERIA di una sede NUOVA (config vuota) ⇒ 201 e la riga esiste DAVVERO', async () => {
    // È il caso misurato in produzione: oggi risponde 403.
    const { res } = await pubblica(
      { id: SEGRETERIA_A, role: 'segreteria', scuola_id: SEDE_A },
      SEDE_A,
    )

    expect(res.status).toBe(201)
    expect(avvisiScritti()).toHaveLength(1)
    expect(avvisiScritti()[0].scuola_id).toBe(SEDE_A)
    expect(avvisiScritti()[0].author_id).toBe(SEGRETERIA_A)
    expect(h.notificaEvento).toHaveBeenCalledTimes(1)
  })

  it('EDUCATOR di una sede NUOVA ⇒ 201: il default vale quanto la schermata dichiara', async () => {
    // `AvvisiSettings.tsx:42` mostra selezionati «Segreteria/Admin» e «Docenti»
    // quando la config è vuota, e `DEFAULT_FUNZIONI_MATRICE` accende `avvisi`
    // per tutti e tre i gradi: un default di codice `['admin']` contraddiceva
    // sia la schermata sia il corredo della sede stessa.
    const { res } = await pubblica(
      { id: EDUCATOR_A, role: 'educator', scuola_id: SEDE_A },
      SEDE_A,
    )

    expect(res.status).toBe(201)
    expect(avvisiScritti()).toHaveLength(1)
    expect(avvisiScritti()[0].author_id).toBe(EDUCATOR_A)
  })

  it('il default di codice è lo STESSO con cui nasce la sede (una copia sola)', () => {
    // Se i due default divergono, una sede provisionata e una sede non ancora
    // provisionata si comportano in modo diverso — ed è il difetto di partenza.
    expect([...RUOLI_PUBBLICAZIONE_DEFAULT]).toEqual(['admin', 'teacher'])
  })

  it('ADMIN di una sede NUOVA ⇒ 201 (il percorso che già funzionava resta intatto)', async () => {
    const { res } = await pubblica({ id: ADMIN_A, role: 'admin', scuola_id: SEDE_A }, SEDE_A)

    expect(res.status).toBe(201)
    expect(avvisiScritti()).toHaveLength(1)
  })
})

describe('POST /api/avvisi — il 403 nomina i ruoli davvero abilitati', () => {
  it('EDUCATOR dove la Direzione ha ristretto a «admin» ⇒ 403 che nomina Segreteria e Direzione', async () => {
    const { res, body } = await pubblica(
      { id: EDUCATOR_B, role: 'educator', scuola_id: SEDE_B },
      SEDE_B,
    )

    expect(res.status).toBe(403)
    // Il CORPO è la parte che conta: il messaggio vecchio diceva «riservata alla
    // segreteria» proprio a chi era segreteria. Deve nominare i ruoli abilitati
    // REALI, e mai il ruolo che sta ricevendo il diniego.
    expect(body.error).toBe(
      'In questa sede possono pubblicare avvisi: Segreteria e Direzione. ' +
        'Il tuo ruolo (Docenti) non è fra questi — Impostazioni → Avvisi.',
    )
    // Nessuna mutazione: è l'asserzione che regge, non lo status.
    expect(avvisiScritti()).toHaveLength(0)
    expect(h.scritture).toHaveLength(0)
    expect(h.notificaEvento).not.toHaveBeenCalled()
  })

  it('…e nella STESSA sede la segreteria pubblica: il gate non nega a tutti', async () => {
    // Controllo positivo accanto al diniego: senza, un gate rotto in chiuso
    // (403 per chiunque) passerebbe il test qui sopra.
    const { res } = await pubblica(
      { id: SEGRETERIA_B, role: 'segreteria', scuola_id: SEDE_B },
      SEDE_B,
    )

    expect(res.status).toBe(201)
    expect(avvisiScritti()).toHaveLength(1)
    expect(avvisiScritti()[0].scuola_id).toBe(SEDE_B)
  })

  it('nessun ruolo abilitato ⇒ 403 che lo dice, invece di indicare un colpevole', async () => {
    const { res, body } = await pubblica(
      { id: SEGRETERIA_C, role: 'segreteria', scuola_id: SEDE_C },
      SEDE_C,
    )

    expect(res.status).toBe(403)
    expect(body.error).toBe(
      'In questa sede nessun ruolo è abilitato a pubblicare avvisi — Impostazioni → Avvisi.',
    )
    expect(avvisiScritti()).toHaveLength(0)
    expect(h.scritture).toHaveLength(0)
  })

  it('la configurazione che conta è quella della sede su cui si PUBBLICA', async () => {
    // Segreteria di B (dove `teacher` è escluso) che pubblica su A: la sede A
    // ammette entrambi i gruppi, quindi 201. La prova serve a fissare che la
    // config si legge dalla sede risolta, non da quella primaria dell'autore.
    h.db.utenti_scuole = [
      { utente_id: SEGRETERIA_B, scuola_id: SEDE_A },
      { utente_id: SEGRETERIA_B, scuola_id: SEDE_B },
    ]
    h.db.utenti = h.db.utenti.map((u) =>
      u.id === SEGRETERIA_B ? { ...u, ruolo: 'admin', role: 'admin' } : u,
    )

    const { res } = await pubblica({ id: SEGRETERIA_B, role: 'admin', scuola_id: SEDE_B }, SEDE_A)

    expect(res.status).toBe(201)
    expect(avvisiScritti()[0].scuola_id).toBe(SEDE_A)
  })
})
