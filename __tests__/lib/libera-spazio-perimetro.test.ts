import { describe, it, expect, beforeEach, vi } from 'vitest'
import { creaFintoSupabase, type DBFinto, type Scrittura } from '../fixtures/finto-supabase'
import {
  contaSpazio,
  liberaSpazio,
  TABELLE_CHE_RESTANO_LEGGIBILI,
  TABELLE_INTATTE,
} from '@/lib/alunni/libera-spazio'

// =============================================================================
// IL PERIMETRO DI «LIBERA SPAZIO» — l'unica prova che vale.
//
// Il modulo dichiara, in `TABELLE_INTATTE`, che cosa NON tocca: pagamenti,
// presenze, valutazioni, pagelle, note, diario, certificati medici, armadietto,
// mensa, legami, domanda d'iscrizione, anagrafica, thread, segnalazioni, audit.
// Quell'elenco finisce nel riquadro di conferma che l'operatore legge prima di
// premere un pulsante senza annulla — cioè è una promessa su cui qualcuno prende
// una decisione.
//
// **Un elenco che dichiara e non fa è peggio del silenzio**: il silenzio fa
// controllare, la promessa fa smettere di controllare. Perciò qui non si crede
// al modulo. Si esegue davvero, su un client finto che APPLICA i filtri e
// REGISTRA le scritture, con una riga in ogni tabella dell'elenco — e si guarda
// che cosa è stato scritto e su quali bucket è finita una `remove()`.
//
// È lo stesso metodo del registro dei bucket dell'oblio
// (`__tests__/lib/gdpr-oblio-completo.test.ts`), applicato all'altra direzione:
// là si prova che i magazzini dichiarati coperti si svuotino DAVVERO, qui che i
// magazzini dichiarati intatti restino DAVVERO intatti.
// =============================================================================

const AL = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALTRO = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'
const OP = 'test/libera-spazio'

/** L'indirizzo pubblico che `promuoviMediaBozza` scrive nella riga di un articolo. */
const URL_FOTO_NEWS =
  'https://esempio.supabase.co/storage/v1/object/public/news/uploads/staff-1/1700-abc.jpg'

/** I tre soli bucket che «libera spazio» può toccare. */
const BUCKET_AMMESSI = ['chat-allegati', 'gallery', 'news']

/**
 * Una riga per OGNI tabella dell'elenco «non tocca», più i dati su cui il
 * modulo lavora davvero.
 *
 * Le righe sono verosimili nella FORMA e palesemente inventate nel contenuto:
 * questo repository è pubblico e non ci entra il dato di una famiglia.
 */
function dbDiProva(): DBFinto {
  const intatte: DBFinto = {}
  for (const t of TABELLE_INTATTE) intatte[t] = []
  return {
    ...intatte,
    // ── l'anagrafica: resta, ed è il punto del modello ──
    alunni: [
      { id: AL, nome: 'Bambino', cognome: 'DiProva', stato: 'ritirato', spazio_liberato_il: null },
    ],
    // ── ciò che si conserva dieci anni ──
    pagamenti: [{ id: 'pag-1', alunno_id: AL, importo: 100 }],
    incassi: [{ id: 'inc-1', pagamento_id: 'pag-1' }],
    presenze: [{ id: 'pr-1', alunno_id: AL, stato: 'assente', giustificazione_testo: 'DI PROVA' }],
    valutazioni: [{ id: 'vl-1', alunno_id: AL, voto: 8 }],
    pagelle: [{ id: 'pg-1', alunno_id: AL, file_url: 'scr-1/al-1.pdf' }],
    note_disciplinari: [{ id: 'nd-1', alunno_id: AL, testo: 'DI PROVA' }],
    eventi_diario: [{ id: 'ed-1', alunno_id: AL, testo: 'DI PROVA' }],
    certificati_medici: [{ id: 'cm-1', alunno_id: AL, file_path: 'al-1/uuid.pdf' }],
    certificati_competenze: [{ id: 'cc-1', alunno_id: AL }],
    armadietto: [{ id: 'ar-1', alunno_id: AL }],
    ticket_mensa: [{ id: 'tm-1', alunno_id: AL }],
    legame_genitori_alunni: [{ id: 'lg-1', alunno_id: AL, genitore_id: 'g-1' }],
    student_parents: [{ id: 'sp-1', student_id: AL, parent_id: 'p-1' }],
    enrollment_submissions: [{ id: 'es-1', data: { children: [{ nome: 'Bambino' }] } }],
    segnalazioni: [{ id: 'sg-1', tipo_oggetto: 'media_galleria', oggetto_id: 'm-1', motivo: 'DI PROVA' }],
    registro_modifiche: [{ id: 'rm-1', alunno_id: AL }],
    audit_scritture_docente: [{ id: 'as-1', entita_id: AL, valore_dopo: { nome: 'Bambino' } }],
    // ── ciò che se ne va ──
    galleria_media_v2: [
      { id: 'm-1', file_url: 'uploads/u1/sua.jpg', file_type: 'foto', tag_students: [AL] },
      { id: 'm-2', file_url: 'uploads/u1/suo.mp4', file_type: 'video', tag_students: [AL] },
      { id: 'm-3', file_url: 'uploads/u1/gruppo.jpg', file_type: 'foto', tag_students: [AL, ALTRO] },
    ],
    // Il thread NON si cancella (la prova di moderazione è `ON DELETE CASCADE`
    // su `conversazioni_sospensioni`): per questo `chat_threads` è nell'elenco.
    // Il secondo thread è di un'ALTRA famiglia: `chat_threads` è UNIQUE
    // (teacher_id, parent_id, student_id), quindi un thread appartiene a un
    // bambino solo — e questo controllo positivo lo verifica invece di crederci.
    chat_threads: [
      { id: 'th-1', student_id: AL, teacher_id: 't-1', parent_id: 'p-1' },
      { id: 'th-9', student_id: ALTRO, teacher_id: 't-1', parent_id: 'p-9' },
    ],
    chat_messages: [
      { id: 'ms-1', thread_id: 'th-1', content: 'TESTO DI PROVA', attachment_url: null },
      { id: 'ms-2', thread_id: 'th-1', content: 'ALTRO TESTO', attachment_url: 'auth-9/uuid-referto.pdf' },
      { id: 'ms-9', thread_id: 'th-9', content: 'DI UN’ALTRA FAMIGLIA', attachment_url: 'auth-8/uuid-altro.pdf' },
    ],
    news_posts: [
      {
        id: 'np-1',
        stato: 'pubblicata',
        nascosta_motivo: null,
        bambini_ritratti: [AL],
        copertina_url: URL_FOTO_NEWS,
        contenuto_json: null,
        contenuto_html: null,
        contenuto_testo: null,
      },
    ],
  }
}

interface Ambiente {
  client: ReturnType<typeof creaFintoSupabase>
  scritture: Scrittura[]
  rimossi: { bucket: string; percorsi: string[] }[]
}

/** Il finto client + un finto Storage che REGISTRA su quali bucket si è tolto. */
function ambiente(db: DBFinto, bloccati: string[] = []): Ambiente {
  const scritture: Scrittura[] = []
  const rimossi: { bucket: string; percorsi: string[] }[] = []
  const base = creaFintoSupabase(db, [], { scritture }) as unknown as Record<string, unknown>
  base.storage = {
    from: (bucket: string) => ({
      remove: async (percorsi: string[]) => {
        rimossi.push({ bucket, percorsi })
        // I bloccati NON compaiono fra gli usciti: `rimuoviEVerifica` andrà a
        // guardare se ci sono ancora, ed è così che si simula un file che resta.
        return { data: percorsi.filter((p) => !bloccati.includes(p)).map((p) => ({ name: p })), error: null }
      },
      list: async (cartella: string, opzioni?: { search?: string }) => {
        const nome = opzioni?.search ?? ''
        const pieno = cartella ? `${cartella}/${nome}` : nome
        return { data: bloccati.includes(pieno) ? [{ name: nome }] : [], error: null }
      },
    }),
  }
  return { client: base as unknown as ReturnType<typeof creaFintoSupabase>, scritture, rimossi }
}

const bucketToccati = (rimossi: { bucket: string; percorsi: string[] }[]) =>
  [...new Set(rimossi.filter((r) => r.percorsi.length > 0).map((r) => r.bucket))].sort()

describe('libera spazio · il perimetro dichiarato è il perimetro vero', () => {
  let db: DBFinto

  beforeEach(() => {
    db = dbDiProva()
  })

  it('la `remove()` arriva SOLO su `gallery`, `chat-allegati` e `news`', async () => {
    const a = ambiente(db)
    const r = await liberaSpazio(a.client, AL, OP)
    expect(r.ok).toBe(true)
    expect(bucketToccati(a.rimossi)).toEqual(BUCKET_AMMESSI)
  })

  it('nessun bucket di conservazione viene sfiorato: fatture, cassa, pagelle, certificati', async () => {
    // Controllo NEGATIVO esplicito, con i nomi scritti: `pagelle` e
    // `certificati-medici` sono i due che l'oblio svuota, ed è proprio per questo
    // che qui devono restare — «libera spazio» non è l'art. 17, e chi legge il
    // codice accanto potrebbe copiarne la riga sbagliata.
    const a = ambiente(db)
    await liberaSpazio(a.client, AL, OP)
    const toccati = new Set(a.rimossi.map((x) => x.bucket))
    for (const b of ['fatture', 'cassa-giustificativi', 'pagelle', 'certificati-medici', 'form_attachments', 'credenziali']) {
      expect(toccati.has(b), `bucket toccato e non doveva: ${b}`).toBe(false)
    }
  })

  it.each(TABELLE_INTATTE.filter((t) => t !== 'alunni'))(
    'nessuna scrittura su `%s`',
    async (tabella) => {
      const a = ambiente(dbDiProva())
      await liberaSpazio(a.client, AL, OP)
      const colpite = a.scritture.filter((s) => s.tabella === tabella)
      expect(
        colpite.map((s) => `${s.operazione}:${JSON.stringify(s.valori)}`),
        `«libera spazio» ha scritto su ${tabella}, che dichiara di non toccare`,
      ).toEqual([])
    },
  )

  it('su `alunni` l’unica scrittura è il marcatore `spazio_liberato_il`', async () => {
    const a = ambiente(db)
    await liberaSpazio(a.client, AL, OP)
    const su = a.scritture.filter((s) => s.tabella === 'alunni')
    expect(su).toHaveLength(1)
    expect(su[0].operazione).toBe('update')
    // Nome, cognome, codice fiscale: nessuna di queste chiavi può comparire. È il
    // punto di tutto il modello a due tempi — i registri restano leggibili solo
    // finché l'anagrafica resta.
    expect(Object.keys(su[0].valori[0])).toEqual(['spazio_liberato_il'])
    expect(db.alunni[0].nome).toBe('Bambino')
    expect(db.alunni[0].cognome).toBe('DiProva')
  })

  it('le righe di conservazione ci sono ancora, una per una', async () => {
    // Il controllo delle scritture prova che nessuna DELETE è partita; questo
    // prova che il risultato è quello atteso anche se un giorno qualcuno
    // cancellasse per una strada che l'accumulatore non vede.
    const a = ambiente(db)
    await liberaSpazio(a.client, AL, OP)
    for (const t of TABELLE_INTATTE) {
      expect(db[t].length, `la tabella ${t} si è svuotata`).toBeGreaterThan(0)
    }
    expect(db.presenze[0].giustificazione_testo).toBe('DI PROVA')
    expect(db.note_disciplinari[0].testo).toBe('DI PROVA')
    expect(db.eventi_diario[0].testo).toBe('DI PROVA')
  })

  it('CONTROLLO POSITIVO — ciò che deve sparire sparisce davvero', async () => {
    // Senza questo, un modulo che non fa NIENTE passerebbe ogni asserzione qui
    // sopra a pieni voti: «non ha toccato niente» è vero anche per un motore
    // spento, ed è il modo più facile di rendere verde un test di perimetro.
    const a = ambiente(db)
    const r = await liberaSpazio(a.client, AL, OP)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // I due media taggati solo a lui (una foto e un video) escono, riga e file.
    expect(r.esito.foto_rimosse).toBe(2)
    expect(db.galleria_media_v2.map((m) => m.id)).toEqual(['m-3'])
    // Quello di gruppo resta, senza il suo tag: dentro c'è un altro bambino.
    expect(r.esito.foto_sganciate).toBe(1)
    expect(db.galleria_media_v2[0].tag_students).toEqual([ALTRO])
    // I messaggi se ne vanno PER INTERO, testo compreso; i thread restano —
    // entrambi, compreso quello dell'altra famiglia, col suo messaggio intatto.
    expect(db.chat_messages.map((m) => m.id)).toEqual(['ms-9'])
    expect(db.chat_messages[0].attachment_url).toBe('auth-8/uuid-altro.pdf')
    expect(r.esito.messaggi_cancellati).toBe(2)
    expect(db.chat_threads).toHaveLength(2)
    // L'articolo pubblico è ritirato e il timestamp è stato scritto.
    expect(r.esito.articoli_ritirati).toBe(1)
    expect(r.esito.parziale).toBe(false)
    expect(typeof r.esito.spazio_liberato_il).toBe('string')
  })

  it('un allegato che NON esce trattiene il suo messaggio, e il timestamp non si scrive', async () => {
    // La regola che questo modulo esiste per non violare: cancellare la riga di
    // un messaggio il cui file è rimasto nel bucket produrrebbe «un file
    // invisibile e non cancellato» — nessuna riga lo nominerebbe più.
    const a = ambiente(db, ['auth-9/uuid-referto.pdf'])
    const r = await liberaSpazio(a.client, AL, OP)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(db.chat_messages.map((m) => m.id)).toEqual(['ms-2', 'ms-9'])
    expect(r.esito.messaggi_trattenuti).toBe(1)
    expect(r.esito.parziale).toBe(true)
    expect(r.esito.spazio_liberato_il).toBeNull()
    expect(db.alunni[0].spazio_liberato_il).toBeNull()
  })

  it('la lettura dei thread fallita FERMA tutto: non si cancella a tentoni', async () => {
    // «Non ci sono thread» e «non ho potuto chiederlo» portano a due gesti
    // opposti, e il secondo autorizza una cancellazione. Un `42501` non è uno
    // schema assente: non si degrada, ci si ferma.
    const a = ambiente(db)
    const conGuasto = creaFintoSupabase(db, [], {
      errori: { 'chat_threads:select': { code: '42501', message: 'permission denied' } },
    }) as unknown as Record<string, unknown>
    conGuasto.storage = (a.client as unknown as Record<string, unknown>).storage
    const r = await liberaSpazio(conGuasto as never, AL, OP)
    expect(r.ok).toBe(false)
    expect(db.chat_messages).toHaveLength(3)
    expect(db.galleria_media_v2).toHaveLength(3)
  })

  it('schema assente (DB della CI non migrato) → si degrada, non si esplode', async () => {
    const dbSenzaNews: DBFinto = { ...dbDiProva(), news_posts: [] }
    const a = ambiente(dbSenzaNews)
    const conSchemaAssente = creaFintoSupabase(dbSenzaNews, [], {
      errori: { news_posts: { code: '42P01', message: 'relation does not exist' } },
    }) as unknown as Record<string, unknown>
    conSchemaAssente.storage = (a.client as unknown as Record<string, unknown>).storage
    const r = await liberaSpazio(conSchemaAssente as never, AL, OP)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.esito.articoli_ritirati).toBe(0)
    // Il resto del lavoro si è fatto lo stesso.
    expect(r.esito.foto_rimosse).toBe(2)
  })

  it('`audit_scritture_docente` NON è fra le tabelle intatte: la rotta ci scrive', async () => {
    // La rotta, subito dopo, chiama `logScrittura` che ci fa un `INSERT`. Finché
    // la voce stava in `TABELLE_INTATTE` viaggiava al client dentro `non_tocca`,
    // cioè come promessa all'operatore — vera dove questo file la provava (qui
    // gira solo la LIBRERIA) e falsa dove veniva spedita. Che il registro non
    // venga DISTRUTTO resta vero, e sta nell'elenco suo.
    expect(TABELLE_INTATTE).not.toContain('audit_scritture_docente')
    expect(TABELLE_CHE_RESTANO_LEGGIBILI).toContain('audit_scritture_docente')
    // Controllo positivo: la libreria continua a non toccarlo davvero.
    const db2 = dbDiProva()
    const a = ambiente(db2)
    await liberaSpazio(a.client, AL, OP)
    expect(a.scritture.filter((s) => s.tabella === 'audit_scritture_docente')).toEqual([])
    expect(db2.audit_scritture_docente).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// I NUMERI ANNUNCIATI SONO QUELLI CHE L'ESECUZIONE PRODUCE.
//
// La regola «in questo media c'è qualcun altro?» era scritta DUE volte: `soloSuo`
// (locale, usata solo dal dry-run) e `sorteDellaFoto` (`@/lib/gdpr/foto-partizione`,
// usata dall'esecuzione dentro `obliaFotoAlunno`). Nessun test confrontava i due
// numeri, e le due copie DIVERGEVANO già: `soloSuo` filtrava i tag con
// `typeof t === 'string' && t !== ''`, `sorteDellaFoto` con `uuidDichiarati`, che
// fa anche il `trim()`.
//
// Qui non si confronta il codice: si confrontano i due RISULTATI sullo stesso
// identico materiale, scelto per rompere una divergenza. È il metodo già in uso
// per l'oblio (`__tests__/architecture/oblio-avviso-dichiarato.test.ts`).
// ─────────────────────────────────────────────────────────────────────────────
describe('libera spazio · il conteggio annuncia quello che l’esecuzione fa', () => {
  /** Conta ed esegue lo STESSO materiale su due client identici e separati. */
  async function contaEdEsegui(media: Record<string, unknown>[]) {
    const perContare: DBFinto = { ...dbDiProva(), galleria_media_v2: media.map((m) => ({ ...m })) }
    const perEseguire: DBFinto = { ...dbDiProva(), galleria_media_v2: media.map((m) => ({ ...m })) }
    const conta = await contaSpazio(ambiente(perContare).client, AL, OP)
    const esec = await liberaSpazio(ambiente(perEseguire).client, AL, OP)
    return { conta, esec }
  }

  it('un tag di SCARTO accanto al suo non fa dire due cose diverse', async () => {
    // `'   '` è una stringa vera per JavaScript. Con le due copie il dry-run
    // diceva «di gruppo: 1, resta» e l'esecuzione «solo sua: la cancello»: il
    // numero che l'operatore conferma e ciò che accade non coincidevano.
    const { conta, esec } = await contaEdEsegui([
      { id: 'm-1', file_url: 'uploads/u1/sua.jpg', file_type: 'foto', tag_students: [AL, '   '] },
    ])
    expect(conta.ok).toBe(true)
    expect(esec.ok).toBe(true)
    if (!conta.ok || !esec.ok) return
    expect(conta.conti.foto_sole_sue + conta.conti.video_soli_suoi).toBe(esec.esito.foto_rimosse)
    expect(conta.conti.media_di_gruppo).toBe(esec.esito.foto_sganciate)
  })

  it('un indirizzo NON riconoscibile non viene annunciato fra le distruzioni', async () => {
    // `sorteDellaFoto` → `trattenuta`: l'esecuzione non toglie né il file né la
    // riga. Contarlo fra le «foto sole sue» prometterebbe una distruzione che non
    // avviene; tacerlo nasconderebbe che una sua foto resta nell'archivio. Ha un
    // numero suo, come `ConteggiOblio.foto_non_rimovibili`.
    const { conta, esec } = await contaEdEsegui([
      { id: 'm-1', file_url: 'https://altro-dominio.example/fuori.jpg', file_type: 'foto', tag_students: [AL] },
      { id: 'm-2', file_url: 'uploads/u1/sua.jpg', file_type: 'foto', tag_students: [AL] },
    ])
    expect(conta.ok).toBe(true)
    expect(esec.ok).toBe(true)
    if (!conta.ok || !esec.ok) return
    expect(conta.conti.media_non_rimovibili).toBe(1)
    expect(conta.conti.foto_sole_sue).toBe(1)
    expect(conta.conti.foto_sole_sue + conta.conti.video_soli_suoi).toBe(esec.esito.foto_rimosse)
    // E l'esito è PARZIALE: un file di quel bambino è rimasto nell'archivio.
    expect(esec.esito.parziale).toBe(true)
    expect(esec.esito.spazio_liberato_il).toBeNull()
  })

  it('foto e video sono lo stesso bucket e due conteggi, ma la somma è quella eseguita', async () => {
    const { conta, esec } = await contaEdEsegui([
      { id: 'm-1', file_url: 'uploads/u1/sua.jpg', file_type: 'foto', tag_students: [AL] },
      { id: 'm-2', file_url: 'uploads/u1/suo.mp4', file_type: 'video', tag_students: [AL] },
      { id: 'm-3', file_url: 'uploads/u1/gruppo.jpg', file_type: 'foto', tag_students: [AL, ALTRO] },
    ])
    expect(conta.ok).toBe(true)
    expect(esec.ok).toBe(true)
    if (!conta.ok || !esec.ok) return
    expect(conta.conti.foto_sole_sue).toBe(1)
    expect(conta.conti.video_soli_suoi).toBe(1)
    expect(conta.conti.foto_sole_sue + conta.conti.video_soli_suoi).toBe(esec.esito.foto_rimosse)
    expect(conta.conti.media_di_gruppo).toBe(esec.esito.foto_sganciate)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// «NON L'HO POTUTO GUARDARE» NON DIVENTA MAI «NON C'ERA NIENTE».
//
// ─── IL DIFETTO, misurato il 2026-08-13 ────────────────────────────────────
// `obliaFotoAlunno` e `obliaFotoNewsAlunno` restituivano zeri sia quando non
// c'era niente da togliere sia quando la SELECT falliva (RLS, `42501`), e
// `liberaSpazio` ne prendeva solo i contatori. Esito: `parziale: false`,
// `spazio_liberato_il` scritto, log di SUCCESSO a livello `info` — con le foto
// ancora nell'archivio e l'articolo ancora pubblicato sul sito PUBBLICO. Il
// bambino usciva dall'elenco «da liberare» col badge, e nessuno ci tornava più.
//
// ─── LE DUE RETI, E PERCHÉ SERVONO ENTRAMBE ────────────────────────────────
//  · `liberaSpazio` conta PRIMA di toccare: una lettura fallita lì ferma tutto e
//    non distrugge niente (`ok: false`);
//  · le funzioni che eseguono dichiarano `letto`, che copre la finestra fra il
//    conteggio e il gesto — un permesso che cade nel mezzo. Lì il lavoro è già
//    cominciato: l'esito è PARZIALE, il timestamp non si scrive.
// ─────────────────────────────────────────────────────────────────────────────
describe('libera spazio · il successo non si dichiara su un archivio non letto', () => {
  /**
   * Un client che legge bene le prime `dopo` volte una tabella, e poi non ci
   * riesce più: è la finestra fra il conteggio e l'esecuzione, l'unico caso che
   * l'iniezione statica di `creaFintoSupabase` non sa rappresentare.
   */
  function cedeStradaDopo(base: unknown, tabella: string, dopo: number) {
    const client = base as { from: (t: string) => unknown }
    const originale = client.from.bind(client)
    let viste = 0
    const guasto = { code: '42501', message: 'permission denied' }
    client.from = (t: string) => {
      if (t !== tabella) return originale(t)
      viste++
      if (viste <= dopo) return originale(t)
      // Catena minima: qualunque filtro torna se stesso, e l'`await` finale
      // consegna l'errore — che è esattamente ciò che fa PostgREST.
      const catena: Record<string, unknown> = {
        then: (r: (v: unknown) => unknown) => Promise.resolve({ data: null, error: guasto }).then(r),
      }
      for (const m of ['select', 'contains', 'eq', 'in', 'is', 'not', 'update', 'delete', 'insert']) {
        catena[m] = () => catena
      }
      return catena
    }
    return base
  }

  let db: DBFinto

  beforeEach(() => {
    db = dbDiProva()
  })

  it('galleria illeggibile AL MOMENTO DI TOGLIERE: esito PARZIALE, nessun timestamp', async () => {
    const a = ambiente(db)
    // La prima lettura (il conteggio) passa; la seconda (`obliaFotoAlunno`) no.
    const r = await liberaSpazio(cedeStradaDopo(a.client, 'galleria_media_v2', 1) as never, AL, OP)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.esito.letture_fallite).toBe(1)
    expect(r.esito.parziale, 'successo dichiarato su un archivio che non si è potuto leggere').toBe(true)
    expect(r.esito.spazio_liberato_il).toBeNull()
    expect(db.alunni[0].spazio_liberato_il).toBeNull()
    // Le righe di galleria sono ancora tutte lì: è il punto.
    expect(db.galleria_media_v2).toHaveLength(3)
  })

  it('sito PUBBLICO illeggibile al momento di ritirare: stesso verdetto', async () => {
    const a = ambiente(db)
    const r = await liberaSpazio(cedeStradaDopo(a.client, 'news_posts', 1) as never, AL, OP)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.esito.letture_fallite).toBe(1)
    expect(r.esito.parziale).toBe(true)
    expect(r.esito.spazio_liberato_il).toBeNull()
    // L'articolo è ancora `pubblicata`, e l'elenco «da liberare» lo dirà ancora.
    expect(db.news_posts[0].stato).toBe('pubblicata')
  })

  it('e la cosa si SA: riga persistita a livello `error`, coi soli conteggi', async () => {
    const logger = await import('@/lib/logging/logger')
    const spia = vi.spyOn(logger, 'logEvento').mockImplementation(() => {})
    try {
      const a = ambiente(dbDiProva())
      await liberaSpazio(cedeStradaDopo(a.client, 'galleria_media_v2', 1) as never, AL, OP)
      const riga = spia.mock.calls.find((c) => (c[2] as { esito?: string })?.esito === 'spazio-liberato-parziale')
      expect(riga, 'nessuna riga sull’archivio non letto').toBeTruthy()
      expect(riga![0]).toBe('gdpr')
      expect(riga![1]).toBe('error')
      expect(riga![2]).toMatchObject({ n_archivi_non_letti: 1 })
      // Mai un nome, mai un percorso: `gdpr` è un canale PERSISTITO.
      expect(JSON.stringify(riga![2])).not.toMatch(/Bambino|DiProva|uploads/)
      // E nessun log di successo accanto: sarebbero due righe che si smentiscono.
      expect(spia.mock.calls.find((c) => (c[2] as { esito?: string })?.esito === 'spazio-liberato')).toBeUndefined()
    } finally {
      spia.mockRestore()
    }
  })

  it('e gli ALLEGATI DI CHAT non letti non passano per «non ce n’erano»', async () => {
    // `obliaAllegatiChat` ha la stessa forma delle altre due — davanti a un
    // `42501` torna tre zeri — ma qui il presidio arriva da un'altra strada, e va
    // PROVATO invece che dedotto: senza quella lettura nessun `attachment_url`
    // viene azzerato, quindi la `delete` (che filtra `.is('attachment_url',
    // null)`) lascia in piedi proprio i messaggi che trattengono un file. Il
    // conteggio «prima» li aveva contati: la differenza li fa riemergere come
    // `messaggi_trattenuti`, e l'esito è parziale. Il file resta nel bucket e la
    // riga che lo nomina resta con lui — che è la regola di tutto il modulo.
    const a = ambiente(db)
    const r = await liberaSpazio(cedeStradaDopo(a.client, 'chat_messages', 1) as never, AL, OP)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.esito.messaggi_trattenuti).toBeGreaterThan(0)
    expect(r.esito.parziale).toBe(true)
    expect(r.esito.spazio_liberato_il).toBeNull()
    expect(db.alunni[0].spazio_liberato_il).toBeNull()
    // I messaggi del bambino sono ancora lì, col loro allegato.
    expect(db.chat_messages.map((m) => m.id)).toEqual(['ms-1', 'ms-2', 'ms-9'])
  })

  it('CONTROLLO POSITIVO — senza guasti `letture_fallite` è zero e il timestamp si scrive', async () => {
    // Senza questo, i tre test qui sopra sarebbero verdi anche se `parziale`
    // fosse sempre `true`: cioè se il timestamp non si scrivesse MAI.
    const a = ambiente(dbDiProva())
    const r = await liberaSpazio(a.client, AL, OP)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.esito.letture_fallite).toBe(0)
    expect(r.esito.parziale).toBe(false)
    expect(typeof r.esito.spazio_liberato_il).toBe('string')
  })
})
