// __tests__/lib/elimina-definitivo.test.ts
import { describe, it, expect } from 'vitest'
import { creaFintoSupabase, type DBFinto, type OpzioniFinto, type Riga } from '../fixtures/finto-supabase'
import { contaPerEliminazione, rimuoviFileAlunno, scelteDisponibili } from '@/lib/alunni/elimina-definitivo'

const AL = '10000000-0000-4000-8000-000000000001'
const FRATELLO = '10000000-0000-4000-8000-000000000002'
const DOPPIONE = '10000000-0000-4000-8000-000000000003'

function db(extra: Partial<DBFinto> = {}): DBFinto {
  return {
    alunni: [{ id: AL, stato: 'ritirato', section_id: null }],
    parents: [],
    presenze: [{ id: 'pr-1', alunno_id: AL }],
    eventi_diario: [],
    student_parents: [{ student_id: AL, parent_id: 'p-1' }],
    pagamenti: [],
    ricevute_emesse: [],
    fatture_emesse: [],
    fatture_coda: [],
    riconciliazione_movimenti: [],
    incassi: [],
    valutazioni: [],
    pagelle: [],
    scrutinio_giudizi: [],
    scrutinio_comportamento: [],
    note_disciplinari: [],
    certificati_competenze: [],
    certificati_medici: [],
    student_documents: [],
    galleria_media_v2: [],
    news_posts: [],
    chat_threads: [],
    chat_messages: [],
    enrollment_submissions: [],
    ...extra,
  }
}

describe('scelteDisponibili — la tabella delle decisioni del titolare', () => {
  it('nessun pagamento e nessun registro: solo «elimina»', () => {
    expect(scelteDisponibili({ pagamenti: 0, pagamenti_bloccati: 0, registro_primaria: false, foto_non_rimovibili: 0 })).toEqual({
      scelte: { elimina: true, elimina_con_pagamenti: false, anonimizza: false },
      motivo: null,
    })
  })

  it('pagamenti cancellabili: «cancella anche i pagamenti» oppure «anonimizza»', () => {
    expect(scelteDisponibili({ pagamenti: 2, pagamenti_bloccati: 0, registro_primaria: false, foto_non_rimovibili: 0 })).toEqual({
      scelte: { elimina: false, elimina_con_pagamenti: true, anonimizza: true },
      motivo: 'ALUNNO_ELIMINAZIONE_HA_PAGAMENTI',
    })
  })

  it('un pagamento bloccato: resta solo «anonimizza»', () => {
    expect(scelteDisponibili({ pagamenti: 2, pagamenti_bloccati: 1, registro_primaria: false, foto_non_rimovibili: 0 })).toEqual({
      scelte: { elimina: false, elimina_con_pagamenti: false, anonimizza: true },
      motivo: 'ALUNNO_ELIMINAZIONE_PAGAMENTI_BLOCCATI',
    })
  })

  it('il registro della primaria vince su tutto: nessuna scelta, nemmeno anonimizzare', () => {
    expect(scelteDisponibili({ pagamenti: 2, pagamenti_bloccati: 0, registro_primaria: true, foto_non_rimovibili: 0 })).toEqual({
      scelte: { elimina: false, elimina_con_pagamenti: false, anonimizza: false },
      motivo: 'REGISTRO_PRIMARIA_DA_CONSERVARE',
    })
  })

  it('foto non rimovibili: niente «elimina», che fallirebbe SEMPRE con file restanti', () => {
    expect(scelteDisponibili({ pagamenti: 0, pagamenti_bloccati: 0, registro_primaria: false, foto_non_rimovibili: 1 })).toEqual({
      scelte: { elimina: false, elimina_con_pagamenti: false, anonimizza: false },
      motivo: 'ALUNNO_ELIMINAZIONE_FOTO_NON_RIMOVIBILI',
    })
  })

  it('foto non rimovibili e registro della primaria: vince il registro', () => {
    expect(scelteDisponibili({ pagamenti: 0, pagamenti_bloccati: 0, registro_primaria: true, foto_non_rimovibili: 3 })).toEqual({
      scelte: { elimina: false, elimina_con_pagamenti: false, anonimizza: false },
      motivo: 'REGISTRO_PRIMARIA_DA_CONSERVARE',
    })
  })

  it('pagamenti cancellabili e foto non rimovibili: resta solo «anonimizza», che quelle foto le tollera', () => {
    expect(scelteDisponibili({ pagamenti: 2, pagamenti_bloccati: 0, registro_primaria: false, foto_non_rimovibili: 1 })).toEqual({
      scelte: { elimina: false, elimina_con_pagamenti: false, anonimizza: true },
      motivo: 'ALUNNO_ELIMINAZIONE_FOTO_NON_RIMOVIBILI',
    })
  })

  it('pagamenti bloccati e foto non rimovibili: il motivo è il blocco permanente, i pagamenti', () => {
    expect(scelteDisponibili({ pagamenti: 2, pagamenti_bloccati: 1, registro_primaria: false, foto_non_rimovibili: 1 })).toEqual({
      scelte: { elimina: false, elimina_con_pagamenti: false, anonimizza: true },
      motivo: 'ALUNNO_ELIMINAZIONE_PAGAMENTI_BLOCCATI',
    })
  })
})

describe('contaPerEliminazione', () => {
  it('conta presenze, legami e pagamenti, e dice se il registro c’è', async () => {
    const esito = await contaPerEliminazione(creaFintoSupabase(db()) as never, AL, 'test')
    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    expect(esito.conteggi).toMatchObject({
      presenze: 1,
      diario: 0,
      legami_genitori: 1,
      pagamenti: 0,
      pagamenti_bloccati: 0,
      registro_primaria: false,
    })
  })

  it('un pagamento con incasso è BLOCCATO, uno senza no', async () => {
    const supabase = creaFintoSupabase(
      db({
        pagamenti: [
          { id: 'pag-1', alunno_id: AL, parent_payment_id: null },
          { id: 'pag-2', alunno_id: AL, parent_payment_id: null },
        ],
        incassi: [{ id: 'inc-1', pagamento_id: 'pag-1' }],
      }),
    )
    const esito = await contaPerEliminazione(supabase as never, AL, 'test')
    expect(esito.ok && esito.conteggi).toMatchObject({ pagamenti: 2, pagamenti_bloccati: 1 })
  })

  it('la quota di un fratello appesa a un suo pagamento lo blocca', async () => {
    const supabase = creaFintoSupabase(
      db({
        pagamenti: [
          { id: 'pag-1', alunno_id: AL, parent_payment_id: null },
          { id: 'pag-f', alunno_id: FRATELLO, parent_payment_id: 'pag-1' },
        ],
      }),
    )
    const esito = await contaPerEliminazione(supabase as never, AL, 'test')
    expect(esito.ok && esito.conteggi).toMatchObject({ pagamenti: 1, pagamenti_bloccati: 1 })
  })

  it('una ricevuta senza pagamento conta come contabilità bloccata', async () => {
    const supabase = creaFintoSupabase(db({ ricevute_emesse: [{ id: 'r-1', alunno_id: AL, pagamento_id: null }] }))
    const esito = await contaPerEliminazione(supabase as never, AL, 'test')
    expect(esito.ok && esito.conteggi).toMatchObject({ pagamenti_bloccati: 1 })
  })

  it('una lettura fallita non diventa uno zero: ok=false', async () => {
    const supabase = creaFintoSupabase(db(), [], { errori: { presenze: { code: '57014', message: 'timeout' } } })
    const esito = await contaPerEliminazione(supabase as never, AL, 'test')
    expect(esito.ok).toBe(false)
  })

  it('un conteggio ASSENTE (HEAD con 404: error null, count null) non diventa uno zero', async () => {
    // Così risponde postgrest-js a una HEAD su una risorsa che dà 404: nessun
    // errore, nessun conteggio. Il finto restituisce sempre un numero, quindi il
    // caso si costruisce avvolgendo `from` per la sola tabella `presenze`.
    const vero = creaFintoSupabase(db()) as unknown as { from: (t: string) => unknown }
    const supabase = {
      ...vero,
      from: (t: string) =>
        t === 'presenze'
          ? { select: () => ({ eq: async () => ({ data: null, error: null, count: null }) }) }
          : vero.from(t),
    }
    const esito = await contaPerEliminazione(supabase as never, AL, 'test')
    expect(esito.ok).toBe(false)
  })
})

describe('contaPerEliminazione — l’avviso doppione (stesso codice fiscale di un bambino che frequenta)', () => {
  // Un valore finto, alfanumerico come un codice vero: il repository è pubblico.
  const CF = 'CFDIPROVA0000001'
  const conDoppione = (altro: Riga): DBFinto =>
    db({
      alunni: [
        // Scritto come lo restituisce `character(16)` e come lo digita una famiglia: spazi e minuscole.
        { id: AL, stato: 'ritirato', section_id: null, codice_fiscale: ` ${CF.toLowerCase()} `, fiscal_code: null, anonimizzato_il: null },
        altro,
      ],
    })

  it('l’altra scheda FREQUENTA (stesso codice in fiscal_code): vero', async () => {
    const esito = await contaPerEliminazione(
      creaFintoSupabase(conDoppione({ id: DOPPIONE, stato: 'iscritto', section_id: 's-1', codice_fiscale: null, fiscal_code: CF, anonimizzato_il: null })) as never,
      AL,
      'test',
    )
    expect(esito.ok && esito.conteggi.cf_condiviso_con_frequentante).toBe(true)
  })

  it('stato vuoto vale «iscritto» (è il default della colonna): vero', async () => {
    const esito = await contaPerEliminazione(
      creaFintoSupabase(conDoppione({ id: DOPPIONE, stato: null, section_id: 's-1', codice_fiscale: CF, fiscal_code: null, anonimizzato_il: null })) as never,
      AL,
      'test',
    )
    expect(esito.ok && esito.conteggi.cf_condiviso_con_frequentante).toBe(true)
  })

  it('nessun’altra scheda con quel codice: falso', async () => {
    const esito = await contaPerEliminazione(
      creaFintoSupabase(conDoppione({ id: DOPPIONE, stato: 'iscritto', section_id: 's-1', codice_fiscale: 'ALTROCODICE00001', fiscal_code: null, anonimizzato_il: null })) as never,
      AL,
      'test',
    )
    expect(esito.ok).toBe(true)
    expect(esito.ok && esito.conteggi.cf_condiviso_con_frequentante).toBe(false)
  })

  it('l’altra scheda è RITIRATA: non frequenta, falso', async () => {
    const esito = await contaPerEliminazione(
      creaFintoSupabase(conDoppione({ id: DOPPIONE, stato: 'ritirato', section_id: null, codice_fiscale: CF, fiscal_code: null, anonimizzato_il: null })) as never,
      AL,
      'test',
    )
    expect(esito.ok).toBe(true)
    expect(esito.ok && esito.conteggi.cf_condiviso_con_frequentante).toBe(false)
  })

  it('l’altra scheda è già ANONIMIZZATA: falso', async () => {
    const esito = await contaPerEliminazione(
      creaFintoSupabase(conDoppione({ id: DOPPIONE, stato: 'iscritto', section_id: 's-1', codice_fiscale: CF, fiscal_code: null, anonimizzato_il: '2026-10-01T00:00:00.000Z' })) as never,
      AL,
      'test',
    )
    expect(esito.ok && esito.conteggi.cf_condiviso_con_frequentante).toBe(false)
  })

  it.each([
    { caso: 'il codice della scheda', n: 1 },
    { caso: 'le altre schede con quel codice', n: 2 },
  ])('lettura fallita ($caso) → ok=false, mai un «no» falso', async ({ n }) => {
    const supabase = guastoAllaLettura(
      conDoppione({ id: DOPPIONE, stato: 'iscritto', section_id: 's-1', codice_fiscale: CF, fiscal_code: null, anonimizzato_il: null }),
      'alunni',
      n,
    )
    const esito = await contaPerEliminazione(supabase as never, AL, 'test')
    expect(esito.ok).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// I RAMI CHE PROTEGGONO UN GESTO IRREVERSIBILE.
//
// Ogni caso qui sotto è stato visto fallire rompendo apposta il ramo che
// protegge: un test che resta verde con la protezione tolta non protegge niente.
// ─────────────────────────────────────────────────────────────────────────────

const GUASTO = { code: '57014', message: 'canceling statement due to statement timeout' }
const PAG = { id: 'pag-1', alunno_id: AL, parent_payment_id: null }
const DOC = 'iscrizioni/prova/documento-di-prova.pdf'

/** Una catena di query che risponde con un errore, qualunque metodo si chiami. */
function catenaInErrore(): unknown {
  const risposta = { data: null, error: GUASTO, count: null }
  const catena: unknown = new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === 'then'
          ? (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(risposta).then(ok, ko)
          : () => catena,
    },
  )
  return catena
}

/**
 * La n-esima `from(tabella)` risponde con un errore, le altre no. Serve a colpire
 * la SECONDA lettura di una tabella letta due volte (le quote su `pagamenti`, le
 * ricevute senza pagamento su `ricevute_emesse`), che l'opzione `errori` del
 * finto non distingue dalla prima. Se la lettura n-esima non esistesse più, il
 * test cadrebbe (ok: true), non resterebbe verde per caso.
 */
function guastoAllaLettura(dati: DBFinto, tabella: string, n: number): unknown {
  const vero = creaFintoSupabase(dati) as unknown as { from: (t: string) => unknown }
  let viste = 0
  return { ...vero, from: (t: string) => (t === tabella && ++viste === n ? catenaInErrore() : vero.from(t)) }
}

describe('contaPerEliminazione — che cosa rende un pagamento contabilità vera', () => {
  it.each<{ tabella: string; riga: Riga }>([
    { tabella: 'ricevute_emesse', riga: { id: 'r-1', alunno_id: AL, pagamento_id: 'pag-1' } },
    { tabella: 'fatture_emesse', riga: { id: 'f-1', pagamento_id: 'pag-1' } },
    { tabella: 'riconciliazione_movimenti', riga: { id: 'm-1', pagamento_id: 'pag-1' } },
    { tabella: 'incassi', riga: { id: 'i-1', pagamento_id: 'pag-1' } },
    { tabella: 'fatture_coda', riga: { id: 'q-1', pagamento_id: 'pag-1', stato: 'in_coda' } },
    { tabella: 'fatture_coda', riga: { id: 'q-1', pagamento_id: 'pag-1', stato: 'in_invio' } },
    { tabella: 'fatture_coda', riga: { id: 'q-1', pagamento_id: 'pag-1', stato: 'emessa' } },
    { tabella: 'fatture_coda', riga: { id: 'q-1', pagamento_id: 'pag-1', stato: 'errore' } },
  ])('un pagamento con una riga in $tabella ($riga.stato) è bloccato', async ({ tabella, riga }) => {
    const supabase = creaFintoSupabase(db({ pagamenti: [PAG], [tabella]: [riga] }))
    const esito = await contaPerEliminazione(supabase as never, AL, 'test')
    expect(esito.ok && esito.conteggi).toMatchObject({ pagamenti: 1, pagamenti_bloccati: 1 })
    if (!esito.ok) return
    expect(scelteDisponibili(esito.conteggi).scelte.elimina_con_pagamenti).toBe(false)
  })

  it('una voce di fatture_coda «tolta» è già fuori dalla coda: il pagamento NON è bloccato', async () => {
    const supabase = creaFintoSupabase(
      db({ pagamenti: [PAG], fatture_coda: [{ id: 'q-1', pagamento_id: 'pag-1', stato: 'tolta' }] }),
    )
    const esito = await contaPerEliminazione(supabase as never, AL, 'test')
    expect(esito.ok && esito.conteggi).toMatchObject({ pagamenti: 1, pagamenti_bloccati: 0 })
  })

  it('i campi dell’oblio arrivano come numeri, mai null', async () => {
    const esito = await contaPerEliminazione(creaFintoSupabase(db()) as never, AL, 'test')
    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    for (const v of Object.values(esito.conteggi)) expect(v === null).toBe(false)
  })
})

describe('contaPerEliminazione — una lettura fallita non diventa mai uno zero', () => {
  it.each<{ caso: string; tabella: string; extra: Partial<DBFinto> }>([
    { caso: 'i pagamenti dell’alunno', tabella: 'pagamenti', extra: {} },
    { caso: 'le ricevute di un suo pagamento', tabella: 'ricevute_emesse', extra: { pagamenti: [PAG] } },
    { caso: 'le fatture di un suo pagamento', tabella: 'fatture_emesse', extra: { pagamenti: [PAG] } },
    { caso: 'gli abbinamenti di un suo pagamento', tabella: 'riconciliazione_movimenti', extra: { pagamenti: [PAG] } },
    { caso: 'gli incassi di un suo pagamento', tabella: 'incassi', extra: { pagamenti: [PAG] } },
    { caso: 'la coda delle fatture di un suo pagamento', tabella: 'fatture_coda', extra: { pagamenti: [PAG] } },
    { caso: 'le ricevute senza pagamento', tabella: 'ricevute_emesse', extra: {} },
    { caso: 'il diario', tabella: 'eventi_diario', extra: {} },
    { caso: 'i legami coi genitori', tabella: 'student_parents', extra: {} },
    { caso: 'il registro della primaria', tabella: 'valutazioni', extra: {} },
    { caso: 'la galleria (preventivo dell’oblio)', tabella: 'galleria_media_v2', extra: {} },
  ])('$caso ($tabella) → ok=false', async ({ tabella, extra }) => {
    const supabase = creaFintoSupabase(db(extra), [], { errori: { [tabella]: GUASTO } })
    const esito = await contaPerEliminazione(supabase as never, AL, 'test')
    expect(esito.ok).toBe(false)
  })

  it('la lettura delle QUOTE di altri alunni (seconda lettura di pagamenti) → ok=false', async () => {
    const supabase = guastoAllaLettura(db({ pagamenti: [PAG] }), 'pagamenti', 2)
    const esito = await contaPerEliminazione(supabase as never, AL, 'test')
    expect(esito.ok).toBe(false)
  })

  it('la lettura delle ricevute senza pagamento, CON un pagamento presente → ok=false', async () => {
    const supabase = guastoAllaLettura(db({ pagamenti: [PAG] }), 'ricevute_emesse', 2)
    const esito = await contaPerEliminazione(supabase as never, AL, 'test')
    expect(esito.ok).toBe(false)
  })
})

/** Il finto con lo Storage che registra ogni `remove()`, e la RPC dei video che risponde «fatto». */
function conStorage(dati: DBFinto, opzioni: OpzioniFinto = {}) {
  const rimossi: { bucket: string; percorsi: string[] }[] = []
  const client = creaFintoSupabase(dati, [], {
    rpc: { video_intent_oblio_alunno: () => ({ data: { ok: true, intenti: 0, revocati: 0 }, error: null }) },
    ...opzioni,
  }) as unknown as Record<string, unknown>
  client.storage = {
    from: (bucket: string) => ({
      remove: async (percorsi: string[]) => {
        rimossi.push({ bucket, percorsi })
        return { data: percorsi.map((p) => ({ name: p })), error: null }
      },
      list: async () => ({ data: [], error: null }),
    }),
  }
  return { client: client as never, rimossi }
}

describe('rimuoviFileAlunno — i file escono, o la scheda resta', () => {
  it('niente da togliere: ok=true, tutti zeri, Storage mai toccato', async () => {
    const { client, rimossi } = conStorage(db())
    const esito = await rimuoviFileAlunno(client, { id: AL, documento_path: null }, 'test')
    expect(esito).toEqual({
      ok: true,
      numeri: {
        foto_rimosse: 0,
        foto_sganciate: 0,
        news_ritirate: 0,
        news_trattenuti: 0,
        certificati: 0,
        fascicolo: 0,
        allegati_chat: 0,
        documenti_rimossi: 0,
        documento_condiviso: 0,
        restanti: 0,
      },
    })
    expect(rimossi).toEqual([])
  })

  it.each<{ tabella: string; extra: Partial<DBFinto> }>([
    { tabella: 'galleria_media_v2', extra: {} },
    { tabella: 'news_posts', extra: {} },
    { tabella: 'certificati_medici', extra: {} },
    { tabella: 'student_documents', extra: {} },
    { tabella: 'chat_threads', extra: {} },
    { tabella: 'chat_messages', extra: { chat_threads: [{ id: 'th-1', student_id: AL }] } },
  ])('una lettura fallita su $tabella → ok=false', async ({ tabella, extra }) => {
    const { client } = conStorage(db(extra), { errori: { [tabella]: GUASTO } })
    const esito = await rimuoviFileAlunno(client, { id: AL, documento_path: null }, 'test')
    expect(esito.ok).toBe(false)
  })

  it('la RPC dei video in volo risponde con un errore → ok=false', async () => {
    const { client } = conStorage(db(), {
      rpc: { video_intent_oblio_alunno: () => ({ data: null, error: GUASTO }) },
    })
    const esito = await rimuoviFileAlunno(client, { id: AL, documento_path: null }, 'test')
    expect(esito.ok).toBe(false)
  })

  it('i thread della chat si leggono PRIMA di ogni passo distruttivo: se falliscono, nessun file esce', async () => {
    const dati = db({
      galleria_media_v2: [{ id: 'm-1', file_url: 'uploads/u1/sua.jpg', file_type: 'foto', tag_students: [AL] }],
    })
    const { client, rimossi } = conStorage(dati, { errori: { chat_threads: GUASTO } })
    const esito = await rimuoviFileAlunno(client, { id: AL, documento_path: DOC }, 'test')
    expect(esito.ok).toBe(false)
    expect(rimossi).toEqual([])
    expect(dati.galleria_media_v2).toHaveLength(1)
  })

  it('CONTROLLO POSITIVO — senza guasti la stessa foto esce davvero', async () => {
    const dati = db({
      galleria_media_v2: [{ id: 'm-1', file_url: 'uploads/u1/sua.jpg', file_type: 'foto', tag_students: [AL] }],
    })
    const { client, rimossi } = conStorage(dati)
    const esito = await rimuoviFileAlunno(client, { id: AL, documento_path: null }, 'test')
    expect(esito.ok).toBe(true)
    expect(esito.numeri.foto_rimosse).toBe(1)
    expect(rimossi.length).toBeGreaterThan(0)
  })

  it('il documento d’identità solo suo esce dal bucket delle iscrizioni', async () => {
    // La sua stessa riga porta lo stesso percorso: non deve contare come «condiviso».
    const { client, rimossi } = conStorage(db({ alunni: [{ id: AL, documento_path: DOC }] }))
    const esito = await rimuoviFileAlunno(client, { id: AL, documento_path: DOC }, 'test')
    expect(esito.ok).toBe(true)
    expect(esito.numeri).toMatchObject({ documenti_rimossi: 1, documento_condiviso: 0 })
    expect(rimossi).toEqual([{ bucket: 'form_attachments', percorsi: [DOC] }])
  })

  // Chi altro può nominare lo stesso file: un altro alunno (il doppione), un
  // genitore, o la DOMANDA d'iscrizione — nel ramo dei bambini o degli adulti.
  const ALTRE_SCHEDE: { caso: string; extra: Partial<DBFinto> }[] = [
    { caso: 'un altro alunno', extra: { alunni: [{ id: AL, documento_path: DOC }, { id: DOPPIONE, documento_path: DOC }] } },
    { caso: 'un genitore', extra: { parents: [{ id: 'p-9', documento_path: DOC }] } },
    {
      caso: 'una domanda d’iscrizione (bambini)',
      extra: { enrollment_submissions: [{ id: 'dom-1', data: { children: [{ nome: 'Bambino', documento_path: DOC }], adults: [] } }] },
    },
    {
      caso: 'una domanda d’iscrizione (adulti)',
      extra: { enrollment_submissions: [{ id: 'dom-1', data: { children: [], adults: [{ nome: 'Adulto', documento_path: DOC }] } }] },
    },
  ]

  it.each(ALTRE_SCHEDE)('un documento che nomina anche $caso NON si toglie: non è solo suo', async ({ extra }) => {
    const { client, rimossi } = conStorage(db({ alunni: [{ id: AL, documento_path: DOC }], ...extra }))
    const esito = await rimuoviFileAlunno(client, { id: AL, documento_path: DOC }, 'test')
    expect(esito.ok).toBe(true)
    expect(esito.numeri).toMatchObject({ documenti_rimossi: 0, documento_condiviso: 1, restanti: 0 })
    expect(rimossi).toEqual([])
  })

  it('una domanda che nomina un ALTRO file non rende condiviso il suo', async () => {
    const { client, rimossi } = conStorage(
      db({
        alunni: [{ id: AL, documento_path: DOC }],
        enrollment_submissions: [{ id: 'dom-1', data: { children: [{ documento_path: 'iscrizioni/prova/altro.pdf' }] } }],
      }),
    )
    const esito = await rimuoviFileAlunno(client, { id: AL, documento_path: DOC }, 'test')
    expect(esito.numeri).toMatchObject({ documenti_rimossi: 1, documento_condiviso: 0 })
    expect(rimossi).toEqual([{ bucket: 'form_attachments', percorsi: [DOC] }])
  })

  it.each([{ tabella: 'alunni' }, { tabella: 'parents' }, { tabella: 'enrollment_submissions' }])(
    'non si sa se $tabella nomina il documento → ok=false, e nessun file esce',
    async ({ tabella }) => {
      const dati = db({
        alunni: [{ id: AL, documento_path: DOC }],
        galleria_media_v2: [{ id: 'm-1', file_url: 'uploads/u1/sua.jpg', file_type: 'foto', tag_students: [AL] }],
      })
      const { client, rimossi } = conStorage(dati, { errori: { [tabella]: GUASTO } })
      const esito = await rimuoviFileAlunno(client, { id: AL, documento_path: DOC }, 'test')
      expect(esito.ok).toBe(false)
      expect(rimossi).toEqual([])
      expect(dati.galleria_media_v2).toHaveLength(1)
    },
  )

  // `enrollment_submissions` è nella baseline: esiste in produzione e sul DB della
  // CI. Se risponde «tabella assente» (o «colonna assente») è un GUASTO, non un
  // «nessuna domanda»: trattarlo come vuoto toglierebbe il file della domanda.
  it.each(['42P01', 'PGRST205', '42703'])(
    'le domande rispondono %s: è un guasto → ok=false, e nessun file esce',
    async (code) => {
      const dati = db({
        alunni: [{ id: AL, documento_path: DOC }],
        galleria_media_v2: [{ id: 'm-1', file_url: 'uploads/u1/sua.jpg', file_type: 'foto', tag_students: [AL] }],
      })
      const { client, rimossi } = conStorage(dati, {
        errori: { enrollment_submissions: { code, message: 'assente' } },
      })
      const esito = await rimuoviFileAlunno(client, { id: AL, documento_path: DOC }, 'test')
      expect(esito.ok).toBe(false)
      expect(rimossi).toEqual([])
      expect(dati.galleria_media_v2).toHaveLength(1)
    },
  )

  it('una foto del blog che un ALTRO articolo usa resta, e si conta in news_trattenuti', async () => {
    const POST = '20000000-0000-4000-8000-000000000001'
    const ESTRANEO = '20000000-0000-4000-8000-000000000002'
    const COPERTINA = 'https://esempio.supabase.co/storage/v1/object/public/news/uploads/staff-1/1700-abc.jpg'
    const { client, rimossi } = conStorage(
      db({
        news_posts: [
          { id: POST, stato: 'pubblicata', bambini_ritratti: [AL], copertina_url: COPERTINA, contenuto_json: null },
          { id: ESTRANEO, stato: 'pubblicata', bambini_ritratti: [], copertina_url: COPERTINA, contenuto_json: null },
        ],
      }),
    )
    const esito = await rimuoviFileAlunno(client, { id: AL, documento_path: null }, 'test')
    expect(esito.ok).toBe(true)
    expect(esito.numeri).toMatchObject({ news_ritirate: 1, news_trattenuti: 1, restanti: 0 })
    expect(rimossi).toEqual([])
  })
})
