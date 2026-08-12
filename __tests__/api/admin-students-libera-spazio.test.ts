import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// =============================================================================
// `POST /api/admin/students/libera-spazio` — il secondo tempo dell'archiviazione.
//
// Foto, video e messaggi via; registri e pagamenti intatti. È irreversibile,
// quindi qui si prova la CATENA DELLE PRECONDIZIONI prima ancora dell'effetto:
// chi può chiamarla, su chi, e con quale conferma. Un 403 mancato o un 409
// dimenticato non producono un errore visibile — producono un bambino a cui
// sono state cancellate le foto.
//
// Le asserzioni sono sulla MUTAZIONE (che cosa è stato scritto, cancellato,
// tolto dai bucket), mai sul solo status: un 200 non dice se il file è uscito.
// =============================================================================

const AL = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALTRO = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'
// La sede si prende da `__tests__/fixtures/sedi.ts`: un uuid di produzione in un
// test è innocuo di per sé, ma NORMALIZZA l'errore — chi copia un test copia
// l'uuid, e da lì finisce in uno script che scrive sul database vero.
const SEDE = SEDE_A

/** Il file di chat che si RIFIUTA di uscire dal bucket, in un test solo. */
const ALLEGATO_BLOCCATO = 'auth-9/uuid-referto.pdf'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  logEvento: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  scritture: [] as unknown[],
  rimossi: [] as { bucket: string; percorsi: string[] }[],
  bloccati: [] as string[],
  /**
   * Fa passare `assertAlunnoInScope` senza guardare niente, per UN test solo.
   *
   * Serve a raggiungere la seconda rete della route — la sua lettura di
   * `alunni` — che altrimenti sarebbe irraggiungibile in prova: il gate di sede
   * legge la stessa tabella per primo, quindi un'iniezione su `alunni` cade lì.
   * Il gate vero resta provato dai test che NON alzano questo interruttore.
   */
  scopeAperto: false,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', async (originale) => {
  const vero = await originale<typeof import('@/lib/auth/scope')>()
  return {
    ...vero,
    assertAlunnoInScope: async (...args: Parameters<typeof vero.assertAlunnoInScope>) =>
      h.scopeAperto ? null : vero.assertAlunnoInScope(...args),
  }
})
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
// `logEvento` è spiato, non silenziato: l'esito parziale è una riga PERSISTITA,
// ed è l'unica cosa che dice a un essere umano che un file è rimasto dentro.
// Senza asserzione, «loggato» e «mai successo» si leggono uguali.
vi.mock('@/lib/logging/logger', async (originale) => {
  const vero = await originale<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: h.logEvento }
})
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const conStorage = () => {
    const base = creaFintoSupabase(h.db as DBFinto, [], {
      scritture: h.scritture as Scrittura[],
    }) as unknown as Record<string, unknown>
    base.storage = {
      from: (bucket: string) => ({
        remove: async (percorsi: string[]) => {
          h.rimossi.push({ bucket, percorsi })
          // Un percorso «bloccato» non compare fra gli usciti e la verifica di
          // `rimuoviEVerifica` lo ritrova nel bucket: è così che si rappresenta
          // il guasto vero — la `remove()` riesce, il file resta.
          return {
            data: percorsi.filter((p) => !h.bloccati.includes(p)).map((p) => ({ name: p })),
            error: null,
          }
        },
        list: async (cartella: string, opzioni?: { search?: string }) => {
          const nome = opzioni?.search ?? ''
          const pieno = cartella ? `${cartella}/${nome}` : nome
          return { data: h.bloccati.includes(pieno) ? [{ name: nome }] : [], error: null }
        },
      }),
    }
    return base
  }
  return { createAdminClient: async () => conStorage(), createClient: async () => conStorage() }
})

import { POST } from '@/app/api/admin/students/libera-spazio/route'

const req = (body: unknown) =>
  new Request('http://localhost/api/admin/students/libera-spazio', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/**
 * Due media soli suoi + uno di gruppo, e tre messaggi di cui uno con allegato.
 * Le sedi sono quelle vere, i contenuti no: il repository è pubblico.
 */
function dbDiProva(): Record<string, Record<string, unknown>[]> {
  return {
    utenti: [{ id: 'dir-1', ruolo: 'admin', scuola_id: SEDE }],
    alunni: [
      {
        id: AL,
        nome: 'Bambino',
        cognome: 'DiProva',
        stato: 'ritirato',
        scuola_id: SEDE,
        section_id: null,
        spazio_liberato_il: null,
      },
    ],
    galleria_media_v2: [
      { id: 'm-1', file_url: 'uploads/u1/sua.jpg', file_type: 'foto', tag_students: [AL] },
      { id: 'm-2', file_url: 'uploads/u1/altra.jpg', file_type: 'foto', tag_students: [AL] },
      { id: 'm-3', file_url: 'uploads/u1/gruppo.jpg', file_type: 'foto', tag_students: [AL, ALTRO] },
    ],
    chat_threads: [{ id: 'th-1', student_id: AL, teacher_id: 't-1', parent_id: 'p-1' }],
    chat_messages: [
      { id: 'ms-1', thread_id: 'th-1', content: 'TESTO DI PROVA', attachment_url: null },
      { id: 'ms-2', thread_id: 'th-1', content: 'ALTRO TESTO', attachment_url: null },
      { id: 'ms-3', thread_id: 'th-1', content: 'CON ALLEGATO', attachment_url: ALLEGATO_BLOCCATO },
    ],
    news_posts: [],
    pagamenti: [{ id: 'pag-1', alunno_id: AL }],
    presenze: [{ id: 'pr-1', alunno_id: AL, giustificazione_testo: 'DI PROVA' }],
    // Il ponte multi-plesso: vuoto qui, riempito dal solo test che ne ha bisogno.
    // `scuoleDiUtente` lo legge per la Direzione, e senza la riga l'operatore ha
    // la sola `utenti.scuola_id` — che è il caso normale a una sede.
    utenti_scuole: [],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'dir-1', role: 'admin', scuola_id: SEDE } })
  h.db = dbDiProva()
  h.scritture = []
  h.rimossi = []
  h.bloccati = []
  h.scopeAperto = false
})

describe('POST /api/admin/students/libera-spazio — chi può, su chi, con quale conferma', () => {
  it('⚠️ il gate riceve ESATTAMENTE `[admin, coordinator]` — l’elenco, non un 403 qualunque', async () => {
    // ─── PERCHÉ QUESTA RIGA ESISTE, misurata in collaudo il 2026-08-13 ─────
    // Il test qui sotto («403 alla SEGRETERIA») mocka `requireStaff` per intero e
    // asserisce che, QUANDO il mock risponde 403, non succede niente. È vero e non
    // basta: è una tautologia. Prova che un 403 ferma la rotta, non che la
    // segreteria ne riceva uno. La mutazione — `['admin','coordinator']` →
    // `['admin','coordinator','segreteria']`, e `'segreteria'` è uno `StaffRole`
    // valido, quindi nemmeno `tsc` protegge — lasciava VERDI tutti i 49 test
    // dedicati e i 1017 di architettura. Il gate che separa il gesto reversibile
    // da quello che non torna non era misurato da niente.
    //
    // L'elenco è scritto qui a LETTERA, non importato da
    // `@/lib/alunni/archiviazione`: importarlo renderebbe questa riga verde
    // qualunque cosa ci finisca dentro — cioè la stessa tautologia, spostata.
    await POST(req({ alunno_id: AL, mode: 'dryrun' }))
    expect(h.requireStaff).toHaveBeenCalledWith(expect.anything(), ['admin', 'coordinator'])
  })

  it('403 alla SEGRETERIA: liberare spazio non si annulla, archiviare sì', async () => {
    // Il confine fra i due gesti passa esattamente di qui. `requireStaff` con
    // `['admin','coordinator']` risponde 403 a chi non è Direzione, e il test lo
    // verifica dal lato che conta: nessuna scrittura, nessuna `remove()`.
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    const res = await POST(req({ alunno_id: AL, mode: 'dryrun' }))
    expect(res.status).toBe(403)
    expect(h.scritture).toHaveLength(0)
    expect(h.rimossi).toHaveLength(0)
  })

  it('il gate PRECEDE la lettura del corpo: un body storto resta un 403', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    const res = await POST(req({ mode: 'ballerino' }))
    expect(res.status).toBe(403)
  })

  it('409 se l’alunno è ancora ISCRITTO, e il rifiuto dice come si sblocca', async () => {
    h.db.alunni[0].stato = 'iscritto'
    const res = await POST(req({ alunno_id: AL, mode: 'dryrun' }))
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.codice).toBe('SPAZIO_ALUNNO_ANCORA_ISCRITTO')
    expect(String(json.error)).toContain('ritirato')
    expect(h.rimossi).toHaveLength(0)
  })

  it('409 anche per un SOSPESO: è un bambino che frequenta', async () => {
    // `alunni.sospeso` (booleano, morosità) e `stato = 'sospeso'` sono due cose
    // diverse; questa è la seconda, ed è dalla parte protetta del confine per
    // decisione — non per dimenticanza. Con una negazione (`!== 'iscritto'`)
    // sarebbe passato.
    h.db.alunni[0].stato = 'sospeso'
    expect((await POST(req({ alunno_id: AL, mode: 'dryrun' }))).status).toBe(409)
  })

  it('409 su uno stato mai visto prima: l’elenco è chiuso', async () => {
    h.db.alunni[0].stato = 'trasferito'
    const res = await POST(req({ alunno_id: AL, mode: 'execute', confirm: 'diprova bambino' }))
    expect(res.status).toBe(409)
    expect(h.rimossi).toHaveLength(0)
  })

  it('il rifiuto lascia una traccia, con lo stato che l’ha causato e senza nomi', async () => {
    h.db.alunni[0].stato = 'iscritto'
    await POST(req({ alunno_id: AL, mode: 'dryrun' }))
    const riga = h.logEvento.mock.calls.find((c) => c[0] === 'gdpr')
    expect(riga, 'nessun log sul rifiuto').toBeTruthy()
    expect(riga![1]).toBe('warn')
    expect(riga![2]).toMatchObject({ esito: 'spazio-rifiutato-ancora-iscritto', tipo: 'iscritto' })
    expect(JSON.stringify(riga![2])).not.toMatch(/Bambino|DiProva/)
  })

  it('404 se l’alunno non esiste', async () => {
    const res = await POST(req({ alunno_id: 'c3c3c3c3-3333-4333-8333-cccccccccccc', mode: 'dryrun' }))
    expect(res.status).toBe(404)
  })

  it('403 se l’alunno è di un ALTRO plesso, e prima di qualunque effetto', async () => {
    h.db.alunni[0].scuola_id = SEDE_B
    const res = await POST(req({ alunno_id: AL, mode: 'execute', confirm: 'diprova bambino' }))
    expect(res.status).toBe(403)
    expect(h.rimossi).toHaveLength(0)
    expect(h.db.galleria_media_v2).toHaveLength(3)
  })

  it('400 se la conferma nominativa non combacia — e non tocca niente', async () => {
    const res = await POST(req({ alunno_id: AL, mode: 'execute', confirm: 'DiProva Bambina' }))
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('SPAZIO_CONFERMA_NON_VALIDA')
    expect(h.rimossi).toHaveLength(0)
    expect(h.db.chat_messages).toHaveLength(3)
    expect(h.db.galleria_media_v2).toHaveLength(3)
  })

  it('400 anche con la conferma ASSENTE: il silenzio non conferma', async () => {
    expect((await POST(req({ alunno_id: AL, mode: 'execute' }))).status).toBe(400)
    expect(h.db.chat_messages).toHaveLength(3)
  })
})

describe('POST /api/admin/students/libera-spazio — il dry-run', () => {
  it('conta senza scrivere, e dice il nominativo da digitare', async () => {
    const res = await POST(req({ alunno_id: AL, mode: 'dryrun' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.dryrun).toBe(true)
    expect(json.foto_sole_sue).toBe(2)
    expect(json.media_di_gruppo).toBe(1)
    expect(json.thread).toBe(1)
    expect(json.messaggi).toBe(3)
    expect(json.allegati).toBe(1)
    expect(json.nominativo_conferma).toBe('DIPROVA BAMBINO')
    // Nessuna scrittura, nessuna `remove()`: sole SELECT.
    expect(h.scritture).toHaveLength(0)
    expect(h.rimossi).toHaveLength(0)
    expect(h.db.chat_messages).toHaveLength(3)
    expect(h.db.galleria_media_v2).toHaveLength(3)
  })

  it('distingue i VIDEO dalle foto: sono lo stesso bucket, non lo stesso conteggio', async () => {
    h.db.galleria_media_v2[1].file_type = 'video'
    const json = await (await POST(req({ alunno_id: AL, mode: 'dryrun' }))).json()
    expect(json.foto_sole_sue).toBe(1)
    expect(json.video_soli_suoi).toBe(1)
  })

  it('porta con sé l’elenco di ciò che NON tocca', async () => {
    const json = await (await POST(req({ alunno_id: AL, mode: 'dryrun' }))).json()
    for (const t of ['pagamenti', 'presenze', 'valutazioni', 'pagelle', 'certificati_medici', 'alunni']) {
      expect(json.non_tocca.tabelle, `manca ${t} dall'elenco mostrato all'operatore`).toContain(t)
    }
    expect(json.non_tocca.bucket).toContain('fatture')
  })

  it('⚠️ e NON promette una tabella su cui la rotta stessa scrive', async () => {
    // `audit_scritture_docente` era in `TABELLE_INTATTE`, quindi viaggiava al
    // client dentro `non_tocca` — mentre `logScrittura`, due righe dopo la
    // liberazione, ci fa un `INSERT`. La promessa era vera dove il test la
    // provava (la libreria non ci scrive) e falsa dove veniva spedita. Un elenco
    // che dichiara e non fa è peggio del silenzio: il silenzio fa controllare, la
    // promessa fa smettere di controllare.
    //
    // Il controllo è in due tempi, perché uno solo sarebbe passato per il motivo
    // sbagliato: la voce non c'è più nell'elenco spedito, E la rotta ci scrive
    // davvero. Se un domani `logScrittura` sparisse, la seconda riga lo dice.
    const dry = await (await POST(req({ alunno_id: AL, mode: 'dryrun' }))).json()
    expect(dry.non_tocca.tabelle).not.toContain('audit_scritture_docente')

    const esec = await POST(req({ alunno_id: AL, mode: 'execute', confirm: 'diprova bambino' }))
    expect((await esec.json()).non_tocca.tabelle).not.toContain('audit_scritture_docente')
    expect(h.logScrittura, 'nessuna riga nel registro: allora la voce poteva restare').toHaveBeenCalled()
  })
})

describe('POST /api/admin/students/libera-spazio — l’esecuzione', () => {
  it('2 foto sole sue via, 1 sganciata, 2 messaggi cancellati e 1 TRATTENUTO', async () => {
    // Il caso che riassume tutto il modulo: il file di `ms-3` non esce dal
    // bucket, quindi quella riga NON si può cancellare — lasciarla senza file
    // sarebbe «un file invisibile e non cancellato», il guasto peggiore.
    h.bloccati = [ALLEGATO_BLOCCATO]
    const res = await POST(req({ alunno_id: AL, mode: 'execute', confirm: 'diprova bambino' }))
    expect(res.status).toBe(200)
    const json = await res.json()

    // Galleria: le due sole sue se ne vanno (riga e file), quella di gruppo resta
    // senza il suo tag — dentro c'è l'immagine di un altro bambino.
    expect(json.foto_rimosse).toBe(2)
    expect(json.foto_sganciate).toBe(1)
    expect(h.db.galleria_media_v2.map((m) => m.id)).toEqual(['m-3'])
    expect(h.db.galleria_media_v2[0].tag_students).toEqual([ALTRO])

    // Chat: due messaggi via col loro testo, uno trattenuto, il thread in piedi.
    expect(json.messaggi_cancellati).toBe(2)
    expect(json.messaggi_trattenuti).toBe(1)
    expect(h.db.chat_messages.map((m) => m.id)).toEqual(['ms-3'])
    expect(h.db.chat_messages[0].attachment_url).toBe(ALLEGATO_BLOCCATO)
    expect(h.db.chat_threads).toHaveLength(1)

    // Il timestamp NON si scrive: la riga resta azionabile e si riprova.
    expect(json.parziale).toBe(true)
    expect(json.spazio_liberato_il).toBeNull()
    expect(h.db.alunni[0].spazio_liberato_il).toBeNull()

    // E la cosa si sa: riga PERSISTITA, con i conteggi e nessun nome.
    const parziale = h.logEvento.mock.calls.find((c) => c[2]?.esito === 'spazio-liberato-parziale')
    expect(parziale, 'nessun log sull’esito parziale').toBeTruthy()
    expect(parziale![0]).toBe('gdpr')
    expect(parziale![1]).toBe('error')
    // `n_allegati_fermi` distingue «il file è ancora nel bucket» (qui 1) da «la
    // cancellazione è stata respinta» (0 con `n_messaggi` > 0): due guasti, due
    // rimedi, e senza questo numero si leggerebbero uguali.
    expect(parziale![2]).toMatchObject({ entita_id: AL, n_messaggi: 1, n_allegati_fermi: 1 })
    expect(JSON.stringify(parziale![2])).not.toMatch(/Bambino|DiProva|referto/)
  })

  it('registri e pagamenti restano, e l’anagrafica pure', async () => {
    h.bloccati = [ALLEGATO_BLOCCATO]
    await POST(req({ alunno_id: AL, mode: 'execute', confirm: 'diprova bambino' }))
    expect(h.db.pagamenti).toHaveLength(1)
    expect(h.db.presenze[0].giustificazione_testo).toBe('DI PROVA')
    expect(h.db.alunni[0].nome).toBe('Bambino')
    expect(h.db.alunni[0].cognome).toBe('DiProva')
  })

  it('senza bloccanti: tutto via, timestamp scritto, log di SUCCESSO', async () => {
    const res = await POST(req({ alunno_id: AL, mode: 'execute', confirm: 'DIPROVA BAMBINO' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.parziale).toBe(false)
    expect(json.messaggi_cancellati).toBe(3)
    expect(h.db.chat_messages).toHaveLength(0)
    expect(typeof json.spazio_liberato_il).toBe('string')
    expect(h.db.alunni[0].spazio_liberato_il).toBe(json.spazio_liberato_il)
    // Evento critico → si logga anche il successo: con i soli errori, «nessun
    // log» non distingue «tutto a posto» da «non è mai partito niente».
    const ok = h.logEvento.mock.calls.find((c) => c[2]?.esito === 'spazio-liberato')
    expect(ok, 'il successo non lascia traccia').toBeTruthy()
    expect(ok![1]).toBe('info')
  })

  it('la scrittura finisce nel registro immutabile, coi soli conteggi', async () => {
    await POST(req({ alunno_id: AL, mode: 'execute', confirm: 'diprova bambino' }))
    expect(h.logScrittura).toHaveBeenCalledTimes(1)
    const arg = h.logScrittura.mock.calls[0][1] as Record<string, unknown>
    expect(arg.entitaTipo).toBe('alunno_spazio_liberato')
    expect(arg.entitaId).toBe(AL)
    // Nessun nome, nessun percorso di file: solo numeri e uuid.
    expect(JSON.stringify(arg.valoreDopo)).not.toMatch(/Bambino|DiProva|uploads|referto/)
  })

  it('⚠️ nel registro la SEDE è quella dell’ALUNNO, non quella dell’operatore', async () => {
    // Il caso vero: `test.multisede.admin` vede tutte e tre le sedi di
    // produzione. Con `auth.user.scuola_id` — cioè la sede PRIMARIA di chi opera
    // — la riga che fra dieci anni dovrà rispondere a «chi ha deciso, e in quale
    // plesso» risponde col plesso sbagliato. Il gemello `archivia` lo fa già
    // giusto, e la stessa asserzione sta in `admin-students-archivia.test.ts`.
    //
    // La fixture normale non lo coglierebbe: là l'operatore ha la stessa sede
    // del bambino, quindi i due valori coincidono e la riga sbagliata passa.
    h.db.alunni[0].scuola_id = SEDE_A
    h.db.utenti_scuole = [
      { utente_id: 'dir-1', scuola_id: SEDE_B },
      { utente_id: 'dir-1', scuola_id: SEDE_A },
    ]
    h.requireStaff.mockResolvedValue({ user: { id: 'dir-1', role: 'admin', scuola_id: SEDE_B } })

    const res = await POST(req({ alunno_id: AL, mode: 'execute', confirm: 'diprova bambino' }))
    expect(res.status).toBe(200)
    const arg = h.logScrittura.mock.calls[0][1] as Record<string, unknown>
    expect(arg.scuolaId, 'il registro attribuisce la sede dell’operatore').toBe(SEDE_A)
    expect(arg.scuolaId).not.toBe(SEDE_B)
  })

  it('la conferma è insensibile a maiuscole e spazi, ma non al nome', async () => {
    const res = await POST(req({ alunno_id: AL, mode: 'execute', confirm: '  diProva   Bambino ' }))
    expect(res.status).toBe(200)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// «NON C'È» E «NON L'HO POTUTO LEGGERE» — la coppia che in questa rotta decide
// se una cancellazione parte o no.
//
// PostgREST non lancia: l'errore torna nel valore, e il `try/catch` della route
// su quel ramo non scatta mai. Qui la conseguenza è peggiore che altrove: a
// valle c'è una `delete` sui messaggi, e «non ho potuto leggere i thread» letto
// come «non ce ne sono» produce un'operazione che dichiara successo senza aver
// tolto niente — cioè un bambino che esce dall'elenco «da liberare» con le sue
// foto ancora nell'archivio, e nessuno che ci torni sopra.
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/admin/students/libera-spazio — le letture che decidono', () => {
  it('anagrafica illeggibile → 500, MAI il 404 che dice «non esiste»', async () => {
    // Il 404 è l'unica risposta che nessuno pensa di riprovare: su un guasto
    // passeggero chiuderebbe la pratica. Qui a rispondere è il gate di sede, che
    // legge `alunni` per primo e si ferma da sé — la seconda rete (la lettura
    // della route) è provata nel test qui sotto.
    const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
    const finto = creaFintoSupabase(h.db as DBFinto, [], {
      errori: { 'alunni:select': { code: '42501', message: 'permission denied' } },
    })
    const mod = await import('@/lib/supabase/server-client')
    const spia = vi.spyOn(mod, 'createAdminClient').mockResolvedValue(finto)
    try {
      const res = await POST(req({ alunno_id: AL, mode: 'dryrun' }))
      expect(res.status).toBe(500)
      expect(JSON.stringify(await res.json())).not.toContain('non trovato')
      expect(h.rimossi).toHaveLength(0)
    } finally {
      spia.mockRestore()
    }
  })

  it('la SECONDA lettura fallita risponde 500 col suo codice, non 404', async () => {
    // PostgREST non lancia: senza il controllo del valore di ritorno, questa
    // lettura uscirebbe dalla porta del 404 — «il bambino non esiste» a chi sta
    // per liberargli lo spazio. Il gate di sede è messo da parte apposta, perché
    // legge la stessa tabella e intercetterebbe l'iniezione.
    h.scopeAperto = true
    const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
    const finto = creaFintoSupabase(h.db as DBFinto, [], {
      errori: { 'alunni:select': { code: '42501', message: 'permission denied' } },
    })
    const mod = await import('@/lib/supabase/server-client')
    const spia = vi.spyOn(mod, 'createAdminClient').mockResolvedValue(finto)
    try {
      const res = await POST(req({ alunno_id: AL, mode: 'dryrun' }))
      expect(res.status).toBe(500)
      const json = await res.json()
      expect(json.codice).toBe('SPAZIO_NON_LIBERATO')
      expect(JSON.stringify(json)).not.toContain('non trovato')
    } finally {
      spia.mockRestore()
    }
  })

  it('il conteggio del dry-run non si inventa: galleria illeggibile → 500', async () => {
    // Il dry-run è ciò che l'operatore legge PRIMA di digitare il nominativo:
    // «0 foto» al posto di «non ho potuto guardare» gli farebbe approvare un
    // numero che nessuno ha misurato. `42501` non è uno schema assente.
    const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
    const finto = creaFintoSupabase(h.db as DBFinto, [], {
      errori: { 'galleria_media_v2:select': { code: '42501', message: 'permission denied' } },
    })
    const mod = await import('@/lib/supabase/server-client')
    const spia = vi.spyOn(mod, 'createAdminClient').mockResolvedValue(finto)
    try {
      const res = await POST(req({ alunno_id: AL, mode: 'dryrun' }))
      expect(res.status).toBe(500)
      expect((await res.json()).codice).toBe('SPAZIO_NON_LIBERATO')
    } finally {
      spia.mockRestore()
    }
  })

  /**
   * ⚠️ E LA STESSA PRUDENZA SUL PERCORSO CHE DISTRUGGE — il difetto BLOCCANTE
   * trovato in collaudo il 2026-08-13, e la ragione per cui questi due test
   * esistono.
   *
   * Fino a quel giorno la cautela stava tutta sul percorso INNOCUO: il dry-run,
   * davanti a una galleria illeggibile, rispondeva 500 (il test qui sopra),
   * mentre l'esecuzione — che cancella — rispondeva `200 {ok:true,
   * parziale:false}`, scriveva `spazio_liberato_il` nella riga `alunni`, mandava
   * un log di SUCCESSO a livello `info` e faceva comparire accanto al nome il
   * badge «Spazio liberato». Con le foto ancora nell'archivio e l'articolo
   * ancora `pubblicata` sul sito PUBBLICO. Nessuno ci sarebbe più tornato.
   *
   * Misurato con `42501 permission denied` — che NON è uno schema assente — su
   * `galleria_media_v2:select` e su `news_posts:select`, uno per volta.
   */
  it('⚠️ galleria illeggibile in EXECUTE → 500: non si dichiara «fatto» su ciò che non si è visto', async () => {
    const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
    const finto = creaFintoSupabase(h.db as DBFinto, [], {
      errori: { 'galleria_media_v2:select': { code: '42501', message: 'permission denied' } },
    }) as unknown as Record<string, unknown>
    finto.storage = {
      from: () => ({
        remove: async (p: string[]) => ({ data: p.map((x) => ({ name: x })), error: null }),
        list: async () => ({ data: [], error: null }),
      }),
    }
    const mod = await import('@/lib/supabase/server-client')
    const spia = vi.spyOn(mod, 'createAdminClient').mockResolvedValue(finto as never)
    try {
      const res = await POST(req({ alunno_id: AL, mode: 'execute', confirm: 'diprova bambino' }))
      expect(res.status).toBe(500)
      expect((await res.json()).codice).toBe('SPAZIO_NON_LIBERATO')
      // Il punto non è lo status: è che NIENTE è stato toccato e che il segno di
      // «fatto» non è stato scritto — la riga resta azionabile, si riprova.
      expect(h.db.galleria_media_v2).toHaveLength(3)
      expect(h.db.chat_messages).toHaveLength(3)
      expect(h.db.alunni[0].spazio_liberato_il).toBeNull()
      expect(h.logScrittura, 'registro immutabile scritto su un lavoro mai fatto').not.toHaveBeenCalled()
      // E NESSUN log di successo: `info` + `spazio-liberato` è la riga che a mesi
      // di distanza direbbe «quel giorno le foto sono state tolte».
      expect(h.logEvento.mock.calls.find((c) => c[2]?.esito === 'spazio-liberato')).toBeUndefined()
    } finally {
      spia.mockRestore()
    }
  })

  it('⚠️ sito PUBBLICO illeggibile in EXECUTE → 500, e l’articolo resta dov’era', async () => {
    // Peggiore della galleria: `news` è l'unico bucket servito senza login. Un
    // «fatto» dichiarato qui vuol dire la foto di un bambino non più iscritto a
    // un indirizzo che conosce chiunque, e un elenco che non lo segnala più.
    h.db.news_posts = [
      { id: 'np-1', stato: 'pubblicata', bambini_ritratti: [AL], copertina_url: null, contenuto_json: null },
    ]
    const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
    const finto = creaFintoSupabase(h.db as DBFinto, [], {
      errori: { 'news_posts:select': { code: '42501', message: 'permission denied' } },
    }) as unknown as Record<string, unknown>
    finto.storage = {
      from: () => ({
        remove: async (p: string[]) => ({ data: p.map((x) => ({ name: x })), error: null }),
        list: async () => ({ data: [], error: null }),
      }),
    }
    const mod = await import('@/lib/supabase/server-client')
    const spia = vi.spyOn(mod, 'createAdminClient').mockResolvedValue(finto as never)
    try {
      const res = await POST(req({ alunno_id: AL, mode: 'execute', confirm: 'diprova bambino' }))
      expect(res.status).toBe(500)
      expect(h.db.news_posts[0].stato).toBe('pubblicata')
      expect(h.db.galleria_media_v2).toHaveLength(3)
      expect(h.db.alunni[0].spazio_liberato_il).toBeNull()
      expect(h.logScrittura).not.toHaveBeenCalled()
    } finally {
      spia.mockRestore()
    }
  })

  it('thread illeggibili in EXECUTE → 500, e nessun messaggio cancellato', async () => {
    const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
    const finto = creaFintoSupabase(h.db as DBFinto, [], {
      errori: { 'chat_threads:select': { code: '42501', message: 'permission denied' } },
    }) as unknown as Record<string, unknown>
    finto.storage = {
      from: () => ({
        remove: async (p: string[]) => ({ data: p.map((x) => ({ name: x })), error: null }),
        list: async () => ({ data: [], error: null }),
      }),
    }
    const mod = await import('@/lib/supabase/server-client')
    const spia = vi.spyOn(mod, 'createAdminClient').mockResolvedValue(finto as never)
    try {
      const res = await POST(req({ alunno_id: AL, mode: 'execute', confirm: 'diprova bambino' }))
      expect(res.status).toBe(500)
      expect((await res.json()).codice).toBe('SPAZIO_NON_LIBERATO')
      // Il punto non è lo status: è che non è partito NIENTE.
      expect(h.db.chat_messages).toHaveLength(3)
      expect(h.db.galleria_media_v2).toHaveLength(3)
      expect(h.logScrittura).not.toHaveBeenCalled()
    } finally {
      spia.mockRestore()
    }
  })

  it('la cancellazione RESPINTA non diventa un successo: niente timestamp', async () => {
    // La `delete` passa il filtro e viene respinta dal database (RLS, vincolo):
    // è la forma di guasto più comune in produzione, e la sola chiave per
    // tabella non saprebbe rappresentarla — zittendo `chat_messages` la route
    // non arriverebbe nemmeno a leggere i messaggi.
    const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
    const finto = creaFintoSupabase(h.db as DBFinto, [], {
      errori: { 'chat_messages:delete': { code: '42501', message: 'permission denied' } },
    }) as unknown as Record<string, unknown>
    finto.storage = {
      from: () => ({
        remove: async (p: string[]) => ({ data: p.map((x) => ({ name: x })), error: null }),
        list: async () => ({ data: [], error: null }),
      }),
    }
    const mod = await import('@/lib/supabase/server-client')
    const spia = vi.spyOn(mod, 'createAdminClient').mockResolvedValue(finto as never)
    try {
      const res = await POST(req({ alunno_id: AL, mode: 'execute', confirm: 'diprova bambino' }))
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.messaggi_cancellati).toBe(0)
      expect(json.messaggi_trattenuti).toBe(3)
      expect(json.parziale).toBe(true)
      expect(json.spazio_liberato_il).toBeNull()
      expect(h.db.alunni[0].spazio_liberato_il).toBeNull()
      expect(h.db.chat_messages).toHaveLength(3)
      // Nessun allegato è rimasto agganciato: il file era uscito. Il guasto è
      // sulla DELETE, e il log lo dice invece di lasciarlo indovinare.
      const parziale = h.logEvento.mock.calls.find((c) => c[2]?.esito === 'spazio-liberato-parziale')
      expect(parziale![2]).toMatchObject({ n_messaggi: 3, n_allegati_fermi: 0 })
    } finally {
      spia.mockRestore()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// IL DB DELLA CI NON È MIGRATO — e la risposta giusta non è un 500.
//
// `spazio_liberato_il` arriva dalla migrazione `20260812194517`. Il DB E2E della
// CI è un progetto SEPARATO e non migrato: là PostgREST risponde `42703` in
// lettura e `PGRST204` in scrittura. Un 500 «Errore interno» dice all'operatore
// «riprova», e riprovare su quell'ambiente non serve a niente: il rimedio è
// applicare la migrazione. È la stessa decisione dei due gemelli, e qui pesa di
// più — perché è la rotta che cancella.
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/admin/students/libera-spazio — l’ambiente senza le colonne', () => {
  const conColonnaAssente = async (codice: string) => {
    const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
    const finto = creaFintoSupabase(h.db as DBFinto, [], {
      // Solo la lettura della ROUTE: il gate di sede legge `alunni` per primo con
      // altre colonne — tutte del baseline — e su quell'ambiente non fallisce.
      errori: { 'alunni:select': { code: codice, message: `column alunni.spazio_liberato_il does not exist` } },
    })
    const mod = await import('@/lib/supabase/server-client')
    return { finto, mod }
  }

  it('42703 in lettura → 503 ARCHIVIO_NON_DISPONIBILE, non 500', async () => {
    h.scopeAperto = true
    const { finto, mod } = await conColonnaAssente('42703')
    const spia = vi.spyOn(mod, 'createAdminClient').mockResolvedValue(finto)
    try {
      const res = await POST(req({ alunno_id: AL, mode: 'dryrun' }))
      expect(res.status).toBe(503)
      expect((await res.json()).codice).toBe('ARCHIVIO_NON_DISPONIBILE')
      expect(h.rimossi).toHaveLength(0)
      expect(h.db.chat_messages).toHaveLength(3)
    } finally {
      spia.mockRestore()
    }
  })

  it('PGRST204 pure, e in EXECUTE non parte niente', async () => {
    h.scopeAperto = true
    const { finto, mod } = await conColonnaAssente('PGRST204')
    const spia = vi.spyOn(mod, 'createAdminClient').mockResolvedValue(finto)
    try {
      const res = await POST(req({ alunno_id: AL, mode: 'execute', confirm: 'diprova bambino' }))
      expect(res.status).toBe(503)
      expect((await res.json()).codice).toBe('ARCHIVIO_NON_DISPONIBILE')
      // Il punto non è lo status: è che non è stato toccato NIENTE.
      expect(h.db.galleria_media_v2).toHaveLength(3)
      expect(h.db.chat_messages).toHaveLength(3)
      expect(h.logScrittura).not.toHaveBeenCalled()
    } finally {
      spia.mockRestore()
    }
  })

  it('la colonna assente lascia una riga: è un ambiente da migrare, non un guasto passeggero', async () => {
    h.scopeAperto = true
    const { finto, mod } = await conColonnaAssente('42703')
    const spia = vi.spyOn(mod, 'createAdminClient').mockResolvedValue(finto)
    try {
      await POST(req({ alunno_id: AL, mode: 'dryrun' }))
      const riga = h.logEvento.mock.calls.find((c) => c[2]?.esito === 'colonne-archiviazione-assenti')
      expect(riga, 'nessun log sull’archivio assente').toBeTruthy()
      expect(riga![1]).toBe('error')
    } finally {
      spia.mockRestore()
    }
  })

  it('un errore di lettura che NON è una colonna assente resta un 500', async () => {
    // Il controllo negativo del degrado: senza, `colonnaAssente` potrebbe
    // rispondere `true` a tutto e trasformare ogni guasto in un 503 che invita a
    // migrare un database già migrato.
    h.scopeAperto = true
    const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
    const finto = creaFintoSupabase(h.db as DBFinto, [], {
      errori: { 'alunni:select': { code: '42501', message: 'permission denied' } },
    })
    const mod = await import('@/lib/supabase/server-client')
    const spia = vi.spyOn(mod, 'createAdminClient').mockResolvedValue(finto)
    try {
      const res = await POST(req({ alunno_id: AL, mode: 'dryrun' }))
      expect(res.status).toBe(500)
      expect((await res.json()).codice).toBe('SPAZIO_NON_LIBERATO')
    } finally {
      spia.mockRestore()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// LA SECONDA RETE DI SEDE, sull'unica operazione che non ha un annulla.
//
// Il gate (`assertAlunnoInScope`) e il filtro `.in('scuola_id', plessi)` sulla
// lettura non sono la stessa difesa: il gate impedisce di NOMINARE la riga di un
// altro plesso, il filtro impedisce che una corsa fra il gate e la lettura ne
// faccia rientrare una. Qui il gate è messo da parte APPOSTA — è l'unico modo di
// provare che la seconda rete esiste davvero: se il filtro sparisse, questo test
// diventerebbe rosso e nessun altro se ne accorgerebbe.
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/admin/students/libera-spazio — il filtro di sede sulla lettura', () => {
  it('col gate scavalcato, l’alunno di un altro plesso NON viene letto e niente parte', async () => {
    h.scopeAperto = true
    h.db.alunni[0].scuola_id = SEDE_B // l'operatore è su SEDE_A

    const res = await POST(req({ alunno_id: AL, mode: 'execute', confirm: 'diprova bambino' }))
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('SPAZIO_ALUNNO_NON_TROVATO')
    expect(h.rimossi).toHaveLength(0)
    expect(h.db.galleria_media_v2).toHaveLength(3)
    expect(h.db.chat_messages).toHaveLength(3)
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it('e la cosa si SA: un 404 muto qui sarebbe indistinguibile da un id sbagliato', async () => {
    h.scopeAperto = true
    h.db.alunni[0].scuola_id = SEDE_B
    await POST(req({ alunno_id: AL, mode: 'dryrun' }))
    const riga = h.logEvento.mock.calls.find((c) => c[2]?.esito === 'alunno-non-piu-in-scope')
    expect(riga, 'nessun log sull’alunno uscito dallo scope').toBeTruthy()
    expect(riga![0]).toBe('multi_sede')
    expect(riga![1]).toBe('warn')
  })

  it('il controllo positivo: nello STESSO plesso la lettura passa e il dry-run conta', async () => {
    // Senza questa riga i due test qui sopra sarebbero verdi anche con un filtro
    // che non trova mai niente — cioè con la funzionalità spenta.
    h.scopeAperto = true
    const json = await (await POST(req({ alunno_id: AL, mode: 'dryrun' }))).json()
    expect(json.dryrun).toBe(true)
    expect(json.foto_sole_sue).toBe(2)
  })
})
