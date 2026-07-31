// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  slugSede,
  pianoSede,
  risolviSedi,
  seminaSede,
  creaAuthAdmin,
  SEDI_BERSAGLIO,
  NOME_SEZIONE_TEST,
  pianoAdminMultisede,
  seminaAdminMultisede,
  EMAIL_ADMIN_MULTISEDE,
} from '../../scripts/seed-test-sedi.mjs'
import { creaFintoSupabase, type DBFinto, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, SEDE_E2E, NOME_SEDE_E2E } from '../fixtures/sedi'

// ─────────────────────────────────────────────────────────────────────────────
// Account TEST su Aversa e Cesa (W4-B) — il collaudo dell'isolamento fra sedi
// ha bisogno di utenti che vivano DAVVERO in un plesso diverso da Giugliano.
//
// Questo test è la rete di sicurezza di uno script che scrive sul database di
// PRODUZIONE. Ciò che verifica non è «lo script gira», è:
//  · la sede si risolve PER NOME e, se il nome non c'è o è ambiguo, lo script
//    si ferma invece di indovinare (è la stessa regola di
//    `resolveScuolaScrittura`: scope vuoto ⇒ nega);
//  · ogni riga scritta porta la sede giusta, e le righe dell'altra sede non si
//    muovono di un millimetro;
//  · **`utenti_scuole` non viene toccata**. È il ponte che il 29/07 ha portato
//    `admin.e2e@kidville.test` — un `ruolo='admin'` — dentro Kidville Aversa e
//    Kidville Cesa. Un account di collaudo agganciato a una sede in più è
//    esattamente il difetto appena chiuso: qui è un'asserzione, non una nota.
// ─────────────────────────────────────────────────────────────────────────────

const NOME_SEDE_AVERSA = 'Kidville Aversa'
const NOME_SEDE_CESA = 'Kidville Cesa'
const PASSWORD_FINTA = 'password-di-prova-non-reale'

/** Le due sedi del piano, con uuid FINTI (mai quelli di produzione). */
function scuoleFinte() {
  return [
    { id: SEDE_A, nome: NOME_SEDE_AVERSA },
    { id: SEDE_B, nome: NOME_SEDE_CESA },
    { id: SEDE_E2E, nome: NOME_SEDE_E2E },
  ]
}

/** Adattatore auth finto: registra le chiamate, non conosce Supabase. */
function authFinto(esistenti: Record<string, string> = {}) {
  const creati: { email: string; password: string }[] = []
  const reimpostati: { id: string; password: string }[] = []
  const mappa = { ...esistenti }
  let seq = 0
  return {
    creati,
    reimpostati,
    adapter: {
      async trovaPerEmail(email: string) {
        return mappa[email] ?? null
      },
      async crea(email: string, password: string) {
        creati.push({ email, password })
        const id = `auth-${++seq}`
        mappa[email] = id
        return id
      },
      async reimpostaPassword(id: string, password: string) {
        reimpostati.push({ id, password })
      },
    },
  }
}

async function seminaSuFinto(
  opzioni: { db?: DBFinto; esistenti?: Record<string, string>; errori?: Record<string, { code: string }> } = {},
) {
  const db: DBFinto = opzioni.db ?? { schools: [], sections: [], utenti: [], alunni: [], parents: [] }
  const scritture: Scrittura[] = []
  const tabelle: string[] = []
  const supabase = creaFintoSupabase(db, tabelle, { scritture, errori: opzioni.errori })
  const auth = authFinto(opzioni.esistenti)
  const esito = await seminaSede({
    db: supabase,
    auth: auth.adapter,
    sede: { id: SEDE_A, nome: NOME_SEDE_AVERSA },
    password: PASSWORD_FINTA,
  })
  return { db, scritture, tabelle, auth, esito }
}

describe('piano degli account TEST per sede', () => {
  it('le sedi bersaglio sono NOMI, non uuid', () => {
    expect(SEDI_BERSAGLIO).toEqual([NOME_SEDE_AVERSA, NOME_SEDE_CESA])
    for (const nome of SEDI_BERSAGLIO) {
      expect(nome).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i)
    }
  })

  it('lo slug della sede è il pezzo che entra nelle email', () => {
    expect(slugSede(NOME_SEDE_AVERSA)).toBe('aversa')
    expect(slugSede(NOME_SEDE_CESA)).toBe('cesa')
    expect(slugSede('  Kidville   Sant’Antimo ')).toBe('sant-antimo')
  })

  it('ogni sede ha segreteria, docente e genitore, tutti col prefisso test.', () => {
    const piano = pianoSede(NOME_SEDE_AVERSA)
    expect(piano.account.map((a) => a.email)).toEqual([
      'test.aversa.segreteria@kidville.test',
      'test.aversa.docente@kidville.test',
      'test.aversa.genitore@kidville.test',
    ])
    expect(piano.account.map((a) => a.ruolo)).toEqual(['segreteria', 'educator', 'genitore'])
    for (const a of piano.account) expect(a.email.startsWith('test.')).toBe(true)
  })

  it('la sezione di collaudo è OMONIMA fra le sedi: è il caso che il multi-sede sbagliava', () => {
    expect(pianoSede(NOME_SEDE_AVERSA).sezione.name).toBe(NOME_SEZIONE_TEST)
    expect(pianoSede(NOME_SEDE_CESA).sezione.name).toBe(NOME_SEZIONE_TEST)
  })

  it('il piano non contiene password: i segreti stanno nell’ambiente', () => {
    const serializzato = JSON.stringify(pianoSede(NOME_SEDE_AVERSA))
    expect(serializzato.toLowerCase()).not.toContain('password')
  })
})

describe('risoluzione delle sedi PER NOME', () => {
  it('trova le sedi richieste e ne restituisce id e nome', () => {
    expect(risolviSedi(scuoleFinte(), [NOME_SEDE_AVERSA, NOME_SEDE_CESA])).toEqual([
      { id: SEDE_A, nome: NOME_SEDE_AVERSA },
      { id: SEDE_B, nome: NOME_SEDE_CESA },
    ])
  })

  it('nome assente ⇒ si ferma, non ripiega su un’altra sede', () => {
    expect(() => risolviSedi(scuoleFinte(), ['Kidville Marcianise'])).toThrow(/Kidville Marcianise/)
  })

  it('nome ambiguo (due sedi omonime) ⇒ si ferma', () => {
    const doppie = [
      { id: SEDE_A, nome: NOME_SEDE_AVERSA },
      { id: SEDE_B, nome: NOME_SEDE_AVERSA },
    ]
    expect(() => risolviSedi(doppie, [NOME_SEDE_AVERSA])).toThrow(/ambigu/i)
  })

  it('la sede finta della CI non si semina', () => {
    expect(() => risolviSedi(scuoleFinte(), [NOME_SEDE_E2E])).toThrow(/E2E|collaudo automatico/i)
  })
})

describe('semina di una sede', () => {
  it('scrive i tre account nella sede risolta, e mai la colonna generata `role`', async () => {
    const { db, scritture } = await seminaSuFinto()
    const utenti = (db.utenti ?? []) as Record<string, unknown>[]
    expect(utenti).toHaveLength(3)
    for (const u of utenti) {
      expect(u.scuola_id).toBe(SEDE_A)
      expect(String(u.email)).toMatch(/^test\.aversa\./)
    }
    expect(utenti.map((u) => u.ruolo).sort()).toEqual(['educator', 'genitore', 'segreteria'])
    const scrittureUtenti = scritture.filter((s) => s.tabella === 'utenti')
    expect(scrittureUtenti.length).toBeGreaterThan(0)
    for (const s of scrittureUtenti) {
      for (const riga of s.valori) expect(Object.keys(riga)).not.toContain('role')
    }
  })

  it('non aggancia MAI gli account di collaudo a una sede con `utenti_scuole`', async () => {
    const { db, scritture, tabelle } = await seminaSuFinto()
    expect(scritture.map((s) => s.tabella)).not.toContain('utenti_scuole')
    expect(tabelle).not.toContain('utenti_scuole')
    expect(db.utenti_scuole ?? []).toHaveLength(0)
  })

  it('la sezione di collaudo nasce nella sede, e ci aggancia docente e alunno', async () => {
    const { db } = await seminaSuFinto()
    const sezioni = (db.sections ?? []) as Record<string, unknown>[]
    expect(sezioni).toHaveLength(1)
    expect(sezioni[0].scuola_id).toBe(SEDE_A)
    expect(sezioni[0].name).toBe(NOME_SEZIONE_TEST)

    const sezioneId = sezioni[0].id
    const alunni = (db.alunni ?? []) as Record<string, unknown>[]
    expect(alunni).toHaveLength(1)
    expect(alunni[0].scuola_id).toBe(SEDE_A)
    expect(alunni[0].section_id).toBe(sezioneId)
    expect(alunni[0].classe_sezione).toBe(NOME_SEZIONE_TEST)

    const docente = ((db.utenti ?? []) as Record<string, unknown>[]).find((u) => u.ruolo === 'educator')
    expect((db.utenti_sezioni ?? []) as Record<string, unknown>[]).toEqual([
      expect.objectContaining({ utente_id: docente?.id, section_id: sezioneId }),
    ])
  })

  it('il genitore è un’identità completa: utenti + parents + i due legami', async () => {
    const { db } = await seminaSuFinto()
    const genitore = ((db.utenti ?? []) as Record<string, unknown>[]).find((u) => u.ruolo === 'genitore')
    const parents = (db.parents ?? []) as Record<string, unknown>[]
    const alunno = ((db.alunni ?? []) as Record<string, unknown>[])[0]
    expect(parents).toHaveLength(1)
    expect(parents[0].auth_user_id).toBe(genitore?.id)
    expect(parents[0].consensi_gdpr).toEqual({ privacy: true, termini: true })
    // Stessa persona, stessa identità: `parents` e `utenti` non devono divergere.
    expect(parents[0].first_name).toBe(genitore?.nome)
    expect(parents[0].last_name).toBe(genitore?.cognome)
    expect((db.student_parents ?? []) as Record<string, unknown>[]).toEqual([
      expect.objectContaining({ student_id: alunno.id, parent_id: parents[0].id }),
    ])
    expect((db.legame_genitori_alunni ?? []) as Record<string, unknown>[]).toEqual([
      expect.objectContaining({ genitore_id: genitore?.id, alunno_id: alunno.id }),
    ])
  })

  it('non tocca le righe dell’altra sede', async () => {
    const db: DBFinto = {
      schools: [],
      sections: [{ id: 'sez-b', scuola_id: SEDE_B, name: NOME_SEZIONE_TEST, school_type: 'infanzia' }],
      utenti: [{ id: 'u-b', email: 'test.cesa.segreteria@kidville.test', ruolo: 'segreteria', scuola_id: SEDE_B }],
      alunni: [{ id: 'a-b', scuola_id: SEDE_B, nome: 'Alunno1', cognome: 'Test Cesa' }],
      parents: [],
    }
    const { db: dopo } = await seminaSuFinto({ db })
    expect((dopo.sections as Record<string, unknown>[]).filter((s) => s.scuola_id === SEDE_B)).toEqual([
      { id: 'sez-b', scuola_id: SEDE_B, name: NOME_SEZIONE_TEST, school_type: 'infanzia' },
    ])
    expect((dopo.utenti as Record<string, unknown>[]).filter((u) => u.scuola_id === SEDE_B)).toEqual([
      { id: 'u-b', email: 'test.cesa.segreteria@kidville.test', ruolo: 'segreteria', scuola_id: SEDE_B },
    ])
    expect((dopo.alunni as Record<string, unknown>[]).filter((a) => a.scuola_id === SEDE_B)).toHaveLength(1)
  })

  it('è idempotente: la seconda esecuzione non duplica nulla', async () => {
    const db: DBFinto = { schools: [], sections: [], utenti: [], alunni: [], parents: [] }
    const scritture: Scrittura[] = []
    const supabase = creaFintoSupabase(db, [], { scritture })
    const auth = authFinto()
    const sede = { id: SEDE_A, nome: NOME_SEDE_AVERSA }
    await seminaSede({ db: supabase, auth: auth.adapter, sede, password: PASSWORD_FINTA })
    const fotografia = JSON.stringify(db)
    await seminaSede({ db: supabase, auth: auth.adapter, sede, password: PASSWORD_FINTA })
    expect(JSON.stringify(db)).toBe(fotografia)
    expect(auth.creati).toHaveLength(3) // 3 account creati la prima volta, 0 la seconda
    expect(auth.reimpostati).toHaveLength(3) // alla seconda passata la password si riallinea
  })

  it('un errore PostgREST non passa inosservato: lancia invece di proseguire', async () => {
    await expect(seminaSuFinto({ errori: { utenti: { code: '42501' } } })).rejects.toThrow(/utenti/)
  })

  it('senza password non scrive NIENTE', async () => {
    const db: DBFinto = { schools: [], sections: [], utenti: [], alunni: [], parents: [] }
    const scritture: Scrittura[] = []
    const supabase = creaFintoSupabase(db, [], { scritture })
    const auth = authFinto()
    await expect(
      seminaSede({
        db: supabase,
        auth: auth.adapter,
        sede: { id: SEDE_A, nome: NOME_SEDE_AVERSA },
        password: '',
      }),
    ).rejects.toThrow(/KV_TEST_PASSWORD/)
    expect(scritture).toHaveLength(0)
    expect(auth.creati).toHaveLength(0)
  })

  it('l’esito elenca gli account creati con ruolo e sede (per il rapporto)', async () => {
    const { esito } = await seminaSuFinto()
    expect(esito.sede).toBe(NOME_SEDE_AVERSA)
    expect(esito.account).toHaveLength(3)
    expect(esito.account[0]).toEqual(
      expect.objectContaining({ email: 'test.aversa.segreteria@kidville.test', ruolo: 'segreteria', creato: true }),
    )
    expect(JSON.stringify(esito)).not.toContain(PASSWORD_FINTA)
  })
})

describe('adattatore auth su Supabase', () => {
  function clientAuthFinto(utenti: { id: string; email: string }[]) {
    const chiamate: { metodo: string; arg: unknown }[] = []
    const client = {
      auth: {
        admin: {
          async listUsers({ page }: { page: number; perPage: number }) {
            chiamate.push({ metodo: 'listUsers', arg: page })
            return { data: { users: page === 1 ? utenti : [] }, error: null }
          },
          async createUser(arg: Record<string, unknown>) {
            chiamate.push({ metodo: 'createUser', arg })
            return { data: { user: { id: 'auth-nuovo' } }, error: null }
          },
          async updateUserById(id: string, arg: Record<string, unknown>) {
            chiamate.push({ metodo: 'updateUserById', arg: { id, ...arg } })
            return { data: { user: { id } }, error: null }
          },
        },
      },
    }
    return { client, chiamate }
  }

  it('account assente ⇒ lo crea con email già confermata', async () => {
    const { client, chiamate } = clientAuthFinto([])
    const adapter = creaAuthAdmin(client)
    expect(await adapter.trovaPerEmail('test.aversa.docente@kidville.test')).toBeNull()
    const id = await adapter.crea('test.aversa.docente@kidville.test', PASSWORD_FINTA)
    expect(id).toBe('auth-nuovo')
    expect(chiamate.at(-1)).toEqual({
      metodo: 'createUser',
      arg: { email: 'test.aversa.docente@kidville.test', password: PASSWORD_FINTA, email_confirm: true },
    })
  })

  it('account già presente ⇒ nessun doppione, solo la password riallineata', async () => {
    const { client, chiamate } = clientAuthFinto([{ id: 'auth-esistente', email: 'TEST.aversa.docente@kidville.test' }])
    const adapter = creaAuthAdmin(client)
    expect(await adapter.trovaPerEmail('test.aversa.docente@kidville.test')).toBe('auth-esistente')
    await adapter.reimpostaPassword('auth-esistente', PASSWORD_FINTA)
    expect(chiamate.map((c) => c.metodo)).not.toContain('createUser')
    expect(chiamate.at(-1)).toEqual({
      metodo: 'updateUserById',
      arg: { id: 'auth-esistente', password: PASSWORD_FINTA, email_confirm: true },
    })
  })

  it('un errore dell’admin API non si ingoia', async () => {
    const client = {
      auth: {
        admin: {
          async listUsers() {
            return { data: null, error: { message: 'service_role scaduta' } }
          },
        },
      },
    }
    await expect(creaAuthAdmin(client).trovaPerEmail('x@kidville.test')).rejects.toThrow(/service_role scaduta/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// L'UNICO account di collaudo multi-sede (2026-07-31) — e perché è un'eccezione
//
// Tutto il blocco qui sopra asserisce che `utenti_scuole` NON si tocca: un
// account di collaudo sta nella sua sede e in nessun'altra. Resta però un ramo
// che nessuno può collaudare così — il selettore di sede — perché dei 57 utenti
// di produzione **uno solo**, l'admin del titolare, ha più di un plesso. Senza
// un secondo account multi-sede l'unico modo di provare quel ramo è usare le
// credenziali di una persona vera.
//
// Il titolare ha quindi autorizzato UNA deroga, stretta il più possibile:
//  · un account solo, `admin`, riconoscibile dal prefisso `test.`;
//  · nessun bambino, nessun genitore, nessun legame: solo l'accesso;
//  · la sede finta della CI resta fuori PER COSTRUZIONE, non per convenzione —
//    è lo stesso `isSedeE2E` che protegge il resto dello script.
//
// E soprattutto: il ruolo `admin` non è un vezzo. `scuoleDiUtente`
// (src/lib/auth/scope.ts:58) concede il ponte multi-plesso ai SOLI admin, per
// decisione di prodotto del 30/07. Un account `segreteria` multi-sede sarebbe
// un oggetto inerte: le righe in `utenti_scuole` ci sarebbero e non varrebbero
// niente. L'ultimo test qui sotto inchioda proprio quello, così il giorno in cui
// qualcuno allargasse il ponte per comodità se ne accorgerebbe subito.
// ─────────────────────────────────────────────────────────────────────────────

describe('account di collaudo multi-sede (deroga del 2026-07-31)', () => {
  it('prende TUTTE le sedi reali e lascia fuori quella finta della CI', () => {
    const piano = pianoAdminMultisede(scuoleFinte())
    expect(piano.sedi.map((s) => s.id)).toEqual([SEDE_A, SEDE_B])
    expect(piano.sedi.map((s) => s.id)).not.toContain(SEDE_E2E)
  })

  it('è UN account solo, di ruolo admin, col prefisso degli account di collaudo', () => {
    const piano = pianoAdminMultisede(scuoleFinte())
    expect(piano.account.ruolo).toBe('admin')
    expect(piano.account.email).toMatch(/^test\..*@kidville\.test$/)
    expect(piano.account.email).toBe(EMAIL_ADMIN_MULTISEDE)
  })

  it('il piano non contiene password', () => {
    expect(JSON.stringify(pianoAdminMultisede(scuoleFinte()))).not.toMatch(/password/i)
  })

  it('nessuna sede reale ⇒ si ferma invece di creare un admin senza plessi', () => {
    expect(() => pianoAdminMultisede([{ id: SEDE_E2E, nome: NOME_SEDE_E2E }])).toThrow(/nessuna sede reale/i)
  })

  it('scrive l’utente e UNA riga `utenti_scuole` per ogni sede reale', async () => {
    const db: DBFinto = { schools: [], sections: [], utenti: [], alunni: [], parents: [] }
    const scritture: Scrittura[] = []
    const tabelle: string[] = []
    const supabase = creaFintoSupabase(db, tabelle, { scritture })
    const auth = authFinto()

    const esito = await seminaAdminMultisede({
      db: supabase,
      auth: auth.adapter,
      sedi: [
        { id: SEDE_A, nome: NOME_SEDE_AVERSA },
        { id: SEDE_B, nome: NOME_SEDE_CESA },
      ],
      password: PASSWORD_FINTA,
    })

    // Controllo POSITIVO: l'utente c'è, con ruolo admin e la prima sede come primaria.
    const utente = scritture.find((s) => s.tabella === 'utenti')
    expect(utente).toBeDefined()
    expect(utente?.valori?.[0]).toMatchObject({ email: EMAIL_ADMIN_MULTISEDE, ruolo: 'admin', scuola_id: SEDE_A })
    // `role` è una colonna GENERATA da `ruolo`: scriverla è un errore (AGENTS.md).
    expect(Object.keys(utente?.valori?.[0] ?? {})).not.toContain('role')

    // Il ponte: una riga per sede, e solo per questo account.
    const ponte = scritture.filter((s) => s.tabella === 'utenti_scuole')
    const sediScritte = ponte.flatMap((s) => s.valori ?? []).map((r) => r.scuola_id)
    expect([...sediScritte].sort()).toEqual([SEDE_A, SEDE_B].sort())
    expect(esito.sedi).toHaveLength(2)
  })

  it('non crea alunni, parents né legami: è solo un accesso', async () => {
    const db: DBFinto = { schools: [], sections: [], utenti: [], alunni: [], parents: [] }
    const scritture: Scrittura[] = []
    const supabase = creaFintoSupabase(db, [], { scritture })
    await seminaAdminMultisede({
      db: supabase,
      auth: authFinto().adapter,
      sedi: [{ id: SEDE_A, nome: NOME_SEDE_AVERSA }],
      password: PASSWORD_FINTA,
    })
    const toccate = scritture.map((s) => s.tabella)
    // Asserzione negativa…
    expect(toccate).not.toContain('alunni')
    expect(toccate).not.toContain('parents')
    expect(toccate).not.toContain('student_parents')
    expect(toccate).not.toContain('legame_genitori_alunni')
    // …col suo controllo POSITIVO accanto: senza, un no-op passerebbe il test.
    expect(toccate).toContain('utenti')
    expect(toccate).toContain('utenti_scuole')
  })

  it('la sede finta della CI non si semina nemmeno se gliela si passa a mano', async () => {
    await expect(
      seminaAdminMultisede({
        db: creaFintoSupabase({ schools: [], sections: [], utenti: [], alunni: [], parents: [] }, [], {}),
        auth: authFinto().adapter,
        sedi: [{ id: SEDE_E2E, nome: NOME_SEDE_E2E }],
        password: PASSWORD_FINTA,
      }),
    ).rejects.toThrow(/E2E/i)
  })

  it('senza password non scrive NIENTE', async () => {
    const scritture: Scrittura[] = []
    const supabase = creaFintoSupabase({ schools: [], sections: [], utenti: [], alunni: [], parents: [] }, [], {
      scritture,
    })
    await expect(
      seminaAdminMultisede({
        db: supabase,
        auth: authFinto().adapter,
        sedi: [{ id: SEDE_A, nome: NOME_SEDE_AVERSA }],
        password: '',
      }),
    ).rejects.toThrow()
    expect(scritture).toHaveLength(0)
  })
})
