import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { REGISTRO_BUCKET_OBLIO, anonimizzaAlunno, type CoperturaBucket, type CanaleOblio } from '@/lib/gdpr/esegui'
import {
  OBLIO_DISTRUGGE,
  OBLIO_RESTA,
  contaCosaDistrugge,
  sommaConteggiOblio,
  type VoceOblio,
} from '@/lib/gdpr/cosa-distrugge'
import itAdminAltro from '../../messages/it/adminAltro.json'
import enAdminAltro from '../../messages/en/adminAltro.json'

// `logEvento` è SPIATO, non silenziato: la riga di successo del dry-run è
// dichiarata «l'unica risposta che non dipende dalla memoria di qualcuno» fra
// sei mesi, e fino al 2026-08-13 nessun test la guardava — toglierla lasciava
// 61 test su 61 verdi. Il repo asserisce sui log altrove
// (`gdpr-erase-route.test.ts`): senza asserzione, un presidio dichiarato in un
// commento è un presidio che nessuno difende.
const spie = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (originale) => {
  const vero = await originale<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: spie.logEvento }
})

// =============================================================================
// LOCK · L'AVVISO DICE TUTTO CIÒ CHE L'OBLIO DISTRUGGE.
//
// IL DIFETTO, misurato il 2026-08-12. Il pannello del diritto all'oblio faceva
// confermare un'anonimizzazione IRREVERSIBILE mostrando quattro righe, di cui una
// sola parlava di documenti: «file da rimuovere: 3». Dentro quel numero, per
// dichiarazione di `REGISTRO_BUCKET_OBLIO`, ci sono le PAGELLE del bambino e i
// suoi CERTIFICATI MEDICI. Chi confermava non poteva saperlo.
//
// PERCHÉ UN LOCK E NON UN ELENCO SCRITTO NEL PANNELLO. Un elenco scritto a mano
// nell'interfaccia invecchia in silenzio: il giorno in cui l'oblio comincerà a
// svuotare un magazzino in più, `REGISTRO_BUCKET_OBLIO` lo saprà — è il registro
// che il lock dei bucket tiene aggiornato per forza — e l'avviso no. Sarebbe la
// stessa firma del difetto di partenza: un'operazione che fa più di quanto dice,
// con il gate verde.
//
// COSA PRETENDE QUESTO FILE.
//  1. ogni bucket dichiarato COPERTO per il canale ALUNNO compare in
//     `OBLIO_DISTRUGGE`: se l'oblio lo svuota, l'avviso lo dice;
//  2. ogni voce di `OBLIO_DISTRUGGE` che nomina un bucket lo trova COPERTO nel
//     registro: un avviso che annuncia una distruzione che non avviene è l'errore
//     opposto e non è meno grave — fa rifiutare un oblio legittimo;
//  3. pagelle e certificati medici stanno PER PRIMI, perché sono le due voci che
//     cambiano la decisione di chi conferma;
//  4. ogni etichetta esiste in ENTRAMBE le lingue (una Direzione può leggere in
//     inglese, e next-intl mostrerebbe il nome della chiave);
//  5. i NUMERI annunciati sono quelli che l'operazione produce davvero — non si
//     crede al commento: si fa girare il conteggio e l'oblio sullo stesso client
//     finto e si confrontano;
//  6. una lettura fallita si annuncia come «non misurato» (`null`) e mai come
//     zero: un conteggio inventato è una conferma inventata.
//
// Ogni regola ha accanto la sua PROVA NEGATIVA, come gli altri lock del repo: un
// controllo che non sa fallire è verde su qualunque cosa, ed è il modo più
// silenzioso di non controllare niente.
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// Le tre domande, come funzioni pure: così si possono interrogare anche su un
// registro FINTO, ed è l'unico modo di dimostrare che sanno dire di no.
// ─────────────────────────────────────────────────────────────────────────────

/** I bucket che il registro dichiara svuotati da un certo canale. */
function copertiPerCanale(registro: Record<string, CoperturaBucket>, canale: CanaleOblio): string[] {
  return Object.entries(registro)
    .filter(([, v]) => v.stato === 'coperto' && v.canali.includes(canale))
    .map(([k]) => k)
    .sort()
}

/** I bucket che l'avviso nomina. */
function annunciati(voci: VoceOblio[]): string[] {
  return [...new Set(voci.map((v) => v.bucket).filter((b): b is string => typeof b === 'string'))].sort()
}

/** Svuotati per l'alunno e taciuti all'operatore. */
function taciuti(registro: Record<string, CoperturaBucket>, voci: VoceOblio[]): string[] {
  const detti = new Set(annunciati(voci))
  return copertiPerCanale(registro, 'alunno').filter((b) => !detti.has(b))
}

/** Annunciati e non svuotati: promesse che l'oblio non mantiene. */
function promesseVuote(registro: Record<string, CoperturaBucket>, voci: VoceOblio[]): string[] {
  return voci
    .filter((v) => {
      if (!v.bucket) return false
      const voce = registro[v.bucket]
      if (!voce || voce.stato !== 'coperto') return true
      // Il canale dichiarato dalla voce dev'essere uno di quelli che svuotano
      // davvero quel magazzino: `credenziali` se ne va col GENITORE orfano, non
      // con l'alunno, e scriverlo al contrario sarebbe una descrizione falsa
      // dell'operazione.
      return !voce.canali.includes(v.canale)
    })
    .map((v) => `${v.chiave} → ${v.bucket}`)
    .sort()
}

// ─────────────────────────────────────────────────────────────────────────────
// Un client finto minimo: quello che serve a contare e a obliare un alunno.
// ─────────────────────────────────────────────────────────────────────────────
interface DatiFinti {
  pagelle?: { id: string; file_url: string | null }[]
  certificati?: { id: string; file_path: string | null }[]
  media?: { id: string; file_url: string | null; tag_students: string[] }[]
  newsPosts?: Record<string, unknown>[]
  thread?: { id: string }[]
  messaggi?: { id: string; attachment_url: string | null }[]
  /** L'errore che PostgREST ritorna (non lancia) su una tabella. */
  err?: Record<string, { code?: string; message?: string }>
}

function clienteFinto(dati: DatiFinti) {
  const removed: { bucket: string; paths: string[] }[] = []
  const client = {
    from(tabella: string) {
      const b: Record<string, unknown> = {}
      const dataFor = (): unknown[] => {
        if (tabella === 'pagelle') return dati.pagelle ?? []
        if (tabella === 'certificati_medici') return dati.certificati ?? []
        if (tabella === 'galleria_media_v2') return dati.media ?? []
        if (tabella === 'news_posts') return dati.newsPosts ?? []
        if (tabella === 'chat_threads') return dati.thread ?? []
        if (tabella === 'chat_messages') return dati.messaggi ?? []
        return []
      }
      b.select = () => b
      b.eq = () => b
      b.neq = () => b
      b.not = () => b
      b.in = () => b
      b.is = () => b
      b.or = () => b
      b.ilike = () => b
      b.contains = () => b
      b.limit = () => b
      b.order = () => b
      b.range = () => b
      b.delete = () => b
      b.update = () => b
      b.maybeSingle = async () => ({ data: null, error: dati.err?.[tabella] ?? null })
      b.then = (res: (v: unknown) => unknown) => {
        const error = dati.err?.[tabella] ?? null
        return Promise.resolve({ data: error ? null : dataFor(), error }).then(res)
      }
      return b
    },
    storage: {
      from: (bucket: string) => ({
        remove: async (paths: string[]) => {
          removed.push({ bucket, paths })
          return { data: paths.map((p) => ({ name: p })), error: null }
        },
        list: async () => ({ data: [] as { name: string }[], error: null }),
      }),
    },
  }
  return { client, removed }
}

const AT = '2026-08-12T09:00:00Z'

/** Tre media ben formati: due del solo bambino, uno di gruppo. */
const MEDIA = [
  { id: 'md-1', file_url: 'uploads/u1/sua.jpg', tag_students: ['al-1'] },
  { id: 'md-2', file_url: 'uploads/u1/gruppo.jpg', tag_students: ['al-1', 'al-2'] },
  { id: 'md-3', file_url: 'uploads/u1/sua2.jpg', tag_students: ['al-1'] },
]

describe('lock · l’avviso dell’oblio dice ciò che l’oblio distrugge', () => {
  it('c’è qualcosa da controllare (se cade, tutto il resto è verde sul vuoto)', () => {
    // Un registro o un elenco letti male renderebbero questo file verde per
    // sempre, su niente. È la stessa asserzione di autoinganno degli altri lock.
    expect(Object.keys(REGISTRO_BUCKET_OBLIO).length).toBeGreaterThan(9)
    expect(OBLIO_DISTRUGGE.length).toBeGreaterThan(5)
    expect(copertiPerCanale(REGISTRO_BUCKET_OBLIO, 'alunno').length).toBeGreaterThan(3)
  })

  it('nessun magazzino si svuota in silenzio: coperto per l’ALUNNO ⇒ scritto nell’avviso', () => {
    const fuori = taciuti(REGISTRO_BUCKET_OBLIO, OBLIO_DISTRUGGE)
    expect(
      fuori,
      `Questi magazzini vengono svuotati dall'oblio di un alunno e la Direzione non lo legge ` +
        `da nessuna parte prima di confermare:\n  ${fuori.join('\n  ')}\n` +
        `Aggiungi la voce a \`OBLIO_DISTRUGGE\` (\`src/lib/gdpr/cosa-distrugge.ts\`) con la sua ` +
        `chiave di catalogo in it+en. Confermare un'operazione irreversibile senza sapere che ` +
        `se ne vanno le pagelle di un bambino è il difetto per cui questo lock esiste.`,
    ).toEqual([])
  })

  it('l’avviso non promette distruzioni che non avvengono', () => {
    const bugie = promesseVuote(REGISTRO_BUCKET_OBLIO, OBLIO_DISTRUGGE)
    expect(
      bugie,
      `Queste voci annunciano la distruzione di un magazzino che \`REGISTRO_BUCKET_OBLIO\` NON ` +
        `dichiara coperto da quel canale:\n  ${bugie.join('\n  ')}\n` +
        `È l'errore opposto e non è più leggero: una Direzione che legge «se ne vanno le ` +
        `pagelle» e vede che restano non si fida più di nessuna delle altre righe.`,
    ).toEqual([])
  })

  it('pagelle e certificati medici sono le PRIME due voci', () => {
    // Non è ordine estetico: sono le due voci per cui il riquadro è stato
    // scritto — un documento di valutazione e un certificato medico sono
    // l'unica parte dell'archivio che una famiglia può volere indietro dopo. In
    // fondo a un elenco di nove righe non le legge nessuno.
    //
    // ⚠️ Fino al 2026-08-13 questo commento aggiungeva «e le sole su cui il
    // registro porta ancora una riserva legale scritta», e non era vero: la
    // riserva («DA CONFERMARE DAL TITOLARE», massimario di scarto) sta nella
    // SOLA voce `pagelle`. La riga qui sotto lo misura invece di ripeterlo, così
    // il giorno in cui qualcuno la scriverà davvero anche sui certificati medici
    // questo file lo saprà.
    expect(OBLIO_DISTRUGGE[0]?.bucket).toBe('pagelle')
    expect(OBLIO_DISTRUGGE[1]?.bucket).toBe('certificati-medici')

    const conRiserva = Object.entries(REGISTRO_BUCKET_OBLIO)
      .filter(([, v]) => v.stato === 'coperto' && v.come.includes('DA CONFERMARE DAL TITOLARE'))
      .map(([k]) => k)
    expect(conRiserva, 'la riserva legale scritta sta in una voce sola: `pagelle`').toEqual(['pagelle'])
  })

  it('ogni etichetta esiste in ITALIANO e in INGLESE', () => {
    const chiavi = [
      ...OBLIO_DISTRUGGE.map((v) => v.chiave),
      ...OBLIO_RESTA,
      'oblioDistruggeTitolo',
      'oblioDistruggeFotoGruppo',
      'oblioDistruggeFotoTrattenute',
      'oblioDistruggeNonMisurato',
      'oblioDistruggeAlmeno',
      'oblioMisuraFallita',
      'oblioMisuraRiprova',
      'oblioRestaTitolo',
    ]
    for (const k of chiavi) {
      expect(itAdminAltro, `manca in messages/it/adminAltro.json: ${k}`).toHaveProperty(k)
      expect(enAdminAltro, `manca in messages/en/adminAltro.json: ${k}`).toHaveProperty(k)
    }
    // Le voci degli altri agenti non devono sparire da sotto: i due cataloghi
    // restano in parità, chiave per chiave.
    expect(Object.keys(itAdminAltro).sort()).toEqual(Object.keys(enAdminAltro).sort())
  })

  it('l’etichetta dice l’UNITÀ che il numero misura (articoli, non foto)', () => {
    // `articoli_pubblici` conta righe di `news_posts`. Un post porta
    // `copertina_url` PIÙ i media dentro `contenuto_json`, e `ritiraPost`
    // restituisce un numero di FILE: «Foto sul sito pubblico: 1» poteva voler
    // dire sette immagini. È la confusione fra numero e cosa — «file da
    // rimuovere: 3» — che questo elemento è nato per chiudere, riaperta con
    // un'etichetta nuova.
    const it = (itAdminAltro as Record<string, string>).oblioDistruggeNews
    const en = (enAdminAltro as Record<string, string>).oblioDistruggeNews
    expect(it.toLowerCase()).toContain('articoli')
    expect(en.toLowerCase()).toContain('posts')
    expect(it, 'l’etichetta si apre nominando le foto: è il numero sbagliato').not.toMatch(/^Foto/)
    expect(en, 'the label opens by naming photos: wrong unit').not.toMatch(/^Photos/)
  })

  it('il conteggio PARZIALE è dichiarato tale (`stima`), e uno solo lo è', () => {
    // `file_da_rimuovere` copre i documenti d'identità, non gli allegati che solo
    // la domanda d'iscrizione conosce: la route stessa lo chiamava «una STIMA» in
    // un commento che nessun operatore legge. Marcarlo qui è ciò che fa comparire
    // «almeno N» a schermo. Se un domani una voce nuova nascesse parziale senza
    // dichiararlo, questa riga la scopre.
    const stime = OBLIO_DISTRUGGE.filter((v) => v.stima).map((v) => v.campo)
    expect(stime).toEqual(['file_da_rimuovere'])
  })

  it('ogni voce dell’elenco ha un’etichetta e nessun doppione', () => {
    const chiavi = OBLIO_DISTRUGGE.map((v) => v.chiave)
    expect(chiavi.every((k) => k.trim().length > 0)).toBe(true)
    expect(new Set(chiavi).size, 'due voci con la stessa etichetta').toBe(chiavi.length)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// LE PROVE NEGATIVE — un controllo che non sa fallire non è un controllo.
// ─────────────────────────────────────────────────────────────────────────────
describe('lock · le prove negative (il controllo sa dire di no)', () => {
  it('un magazzino nuovo, coperto per l’alunno e non annunciato, viene SCOPERTO', () => {
    const registroFinto: Record<string, CoperturaBucket> = {
      ...REGISTRO_BUCKET_OBLIO,
      diari_video: { stato: 'coperto', canali: ['alunno'], come: 'inventato per questo test' },
    }
    expect(taciuti(registroFinto, OBLIO_DISTRUGGE)).toEqual(['diari_video'])
  })

  it('un magazzino coperto SOLO per il genitore non fa scattare la regola dell’alunno', () => {
    // Controllo positivo accanto al negativo: se la regola guardasse tutti i
    // canali, la riga qui sopra sarebbe verde per il motivo sbagliato.
    const registroFinto: Record<string, CoperturaBucket> = {
      ...REGISTRO_BUCKET_OBLIO,
      buste_paga: { stato: 'coperto', canali: ['genitore'], come: 'inventato per questo test' },
    }
    expect(taciuti(registroFinto, OBLIO_DISTRUGGE)).toEqual([])
  })

  it('una voce che annuncia un bucket ESCLUSO viene SCOPERTA', () => {
    const vociFinte: VoceOblio[] = [
      ...OBLIO_DISTRUGGE,
      { chiave: 'oblioDistruggeFatture', bucket: 'fatture', canale: 'alunno' },
    ]
    expect(promesseVuote(REGISTRO_BUCKET_OBLIO, vociFinte)).toEqual(['oblioDistruggeFatture → fatture'])
  })

  it('una voce che annuncia il CANALE sbagliato viene SCOPERTA', () => {
    // `credenziali` è coperto, ma dal canale GENITORE: dichiararlo come alunno
    // sarebbe una descrizione falsa dell'operazione, non un dettaglio.
    const vociFinte: VoceOblio[] = [{ chiave: 'x', bucket: 'credenziali', canale: 'alunno' }]
    expect(promesseVuote(REGISTRO_BUCKET_OBLIO, vociFinte)).toEqual(['x → credenziali'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// I NUMERI — quelli annunciati devono essere quelli che l'operazione produce.
// ─────────────────────────────────────────────────────────────────────────────
describe('conteggi del dry-run · il numero annunciato è quello che l’oblio produce', () => {
  /** Conta e oblia lo STESSO materiale su due client identici, e restituisce i due esiti. */
  async function contaEOblia(media: DatiFinti['media']) {
    const conteggi = await contaCosaDistrugge(clienteFinto({ media }).client as never, 'al-1', 'test')
    const esito = await anonimizzaAlunno(clienteFinto({ media }).client as never, { id: 'al-1' }, AT, 'test')
    return { conteggi, esito }
  }

  it('foto sue / foto di gruppo: il dry-run partiziona come `anonimizzaAlunno`', async () => {
    // La regola «in questa foto c'è qualcun altro?» era scritta in due posti — il
    // conteggio e l'esecuzione — e due copie della stessa regola divergono: è già
    // successo in questo repo. Qui non si confronta il codice, si confrontano i
    // due RISULTATI sullo stesso identico materiale.
    const { conteggi, esito } = await contaEOblia(MEDIA)

    expect(conteggi.foto_solo_sue).toBe(esito.fotoRimosse)
    expect(conteggi.foto_di_gruppo).toBe(esito.fotoSganciate)
    // Controllo positivo: senza, l'uguaglianza sarebbe verde su 0 = 0, cioè su un
    // oblio che non è mai partito.
    expect(conteggi.foto_solo_sue).toBe(2)
    expect(conteggi.foto_di_gruppo).toBe(1)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // LE DUE DIVERGENZE MISURATE IL 2026-08-12 — una fixture pulita non le vedeva.
  //
  // Il confronto qui sopra girava su UN materiale solo, tre media ben formati:
  // verde, e intanto le due copie della regola divergevano su due casi veri.
  // Da qui in avanti il confronto gira anche sui materiali che le facevano
  // divergere, perché un lock che verifica una fixture sola verifica quella
  // fixture, non la regola.
  // ───────────────────────────────────────────────────────────────────────────

  it('un tag di SCARTO non fa sopravvivere la foto: conteggio ed esecuzione dicono lo stesso', async () => {
    // MISURATO il 2026-08-12 con `tag_students: [' al-1 ']`:
    //   {conteggio_solo_sue: 1, conteggio_gruppo: 0, oblio_rimosse: 0, oblio_sganciate: 1}
    // Il riquadro annunciava una distruzione e l'esecuzione toglieva solo il tag.
    // La causa non era il numero: `uuidDichiarati` normalizzava gli uuid e
    // `obliaFotoAlunno` no. Che è anche un difetto di PRODOTTO, non solo di
    // annuncio — con un tag di scarto (`'   '`) accanto al suo, la foto di un
    // bambino sopravviveva al suo oblio, perché contava come «c'è qualcun altro».
    for (const tag of [' al-1 ', '   ', '']) {
      const { conteggi, esito } = await contaEOblia([
        { id: 'md-1', file_url: 'uploads/u1/sua.jpg', tag_students: ['al-1', tag] },
      ])
      expect(conteggi.foto_solo_sue, `tag di scarto «${tag}»`).toBe(esito.fotoRimosse)
      expect(conteggi.foto_di_gruppo, `tag di scarto «${tag}»`).toBe(esito.fotoSganciate)
      // Controllo positivo: è davvero una foto del solo bambino, e se ne va.
      expect(conteggi.foto_solo_sue, `tag di scarto «${tag}»`).toBe(1)
      expect(esito.fotoSganciate, `tag di scarto «${tag}»`).toBe(0)
    }
  })

  it('un indirizzo non riconoscibile NON si annuncia fra le distruzioni', async () => {
    // MISURATO il 2026-08-12 con `file_url: 'https://cdn.terzo.example/x.jpg?token=abc'`:
    //   {annunciato: 1, davvero_rimosse: 0, non_rimossi: 1}
    // `obliaFotoAlunno` questo caso lo gestisce apposta (`illeggibile`): non
    // cancella né il file né la riga, e logga `oblio-percorso-non-riconosciuto`.
    // Il conteggio lo ignorava e prometteva la distruzione lo stesso.
    const { conteggi, esito } = await contaEOblia([
      { id: 'md-1', file_url: 'https://cdn.terzo.example/x.jpg?token=abc', tag_students: ['al-1'] },
      { id: 'md-2', file_url: 'uploads/u1/sua.jpg', tag_students: ['al-1'] },
    ])
    expect(conteggi.foto_solo_sue).toBe(esito.fotoRimosse)
    expect(conteggi.foto_solo_sue).toBe(1)
    // Non sparisce dal riquadro: ha un numero suo, perché è una foto di quel
    // bambino che RESTA nell'archivio — e chi risponde alla famiglia lo deve
    // sapere. Su questo materiale lo storage risponde sempre ok, quindi
    // `fileNonRimossi` è fatto solo dagli illeggibili.
    expect(conteggi.foto_non_rimovibili).toBe(1)
    expect(esito.fileNonRimossi).toBe(conteggi.foto_non_rimovibili)
  })

  it('senza foto trattenute il numero è ZERO, non «c’è sempre qualcosa»', async () => {
    // Controllo positivo del test qui sopra: se `foto_non_rimovibili` valesse 1
    // per costruzione, la riga rossa comparirebbe su ogni oblio e smetterebbe di
    // voler dire qualcosa.
    const { conteggi } = await contaEOblia(MEDIA)
    expect(conteggi.foto_non_rimovibili).toBe(0)
  })

  it('pagelle e certificati medici: conta le righe che l’oblio cancella', async () => {
    const f = clienteFinto({
      pagelle: [
        { id: 'pg-1', file_url: 'scr-1/al-1-1.pdf' },
        { id: 'pg-2', file_url: 'scr-1/al-1-2.pdf' },
      ],
      certificati: [{ id: 'cm-1', file_path: 'al-1/uuid.pdf' }],
    })
    const c = await contaCosaDistrugge(f.client as never, 'al-1', 'test')
    expect(c.pagelle).toBe(2)
    expect(c.certificati_medici).toBe(1)
  })

  it('allegati di chat: solo i messaggi dei suoi thread, e solo se un thread c’è', async () => {
    const conThread = await contaCosaDistrugge(
      clienteFinto({
        thread: [{ id: 'th-1' }],
        messaggi: [{ id: 'ms-1', attachment_url: 'auth-9/referto.pdf' }],
      }).client as never,
      'al-1',
      'test',
    )
    expect(conThread.allegati_chat).toBe(1)

    // Nessun thread ⇒ nessuna query su `chat_messages`: un `in` con lista vuota su
    // PostgREST è un filtro che non filtra, e conterebbe gli allegati dell'intera
    // scuola. Il finto risponderebbe comunque `1`: se questa riga diventasse `1`,
    // il guard è saltato.
    const senzaThread = await contaCosaDistrugge(
      clienteFinto({ messaggi: [{ id: 'ms-1', attachment_url: 'auth-9/referto.pdf' }] }).client as never,
      'al-1',
      'test',
    )
    expect(senzaThread.allegati_chat).toBe(0)
  })

  it('articoli pubblici: conta solo quelli che lo dichiarano DAVVERO fra i ritratti', async () => {
    const f = clienteFinto({
      newsPosts: [
        { id: 'np-1', bambini_ritratti: ['al-1'] },
        // Il `contains` è del database; il finto restituisce tutto. La riga che
        // NON nomina il bambino non deve entrare nel conteggio, come non entra
        // nel ritiro di `obliaFotoNewsAlunno`.
        { id: 'np-2', bambini_ritratti: ['al-2'] },
        { id: 'np-3', bambini_ritratti: null },
      ],
    })
    const c = await contaCosaDistrugge(f.client as never, 'al-1', 'test')
    expect(c.articoli_pubblici).toBe(1)
  })

  it('lettura FALLITA → «non misurato» (`null`), mai zero', async () => {
    // PostgREST non lancia: ritorna `{ error }`. Se questo ramo tornasse `0`, il
    // riquadro direbbe «pagelle: 0» a una Direzione che sta per distruggerne due,
    // ed è la rassicurazione falsa per cui il riquadro esiste.
    const f = clienteFinto({
      pagelle: [{ id: 'pg-1', file_url: 'x.pdf' }],
      err: { pagelle: { code: '42501', message: 'permission denied for table pagelle' } },
    })
    const c = await contaCosaDistrugge(f.client as never, 'al-1', 'test')
    expect(c.pagelle).toBeNull()
    // Le altre voci restano misurate: un guasto su un magazzino non spegne l'avviso.
    expect(c.certificati_medici).toBe(0)
  })

  it('schema ASSENTE (DB E2E della CI non migrato) → zero, e senza rumore', async () => {
    // Qui il vuoto è la risposta giusta: se la tabella non esiste, di pagelle non
    // ce n'è nessuna. È l'unico caso in cui `0` non è una bugia.
    const f = clienteFinto({
      err: {
        pagelle: { code: 'PGRST205' },
        certificati_medici: { code: 'PGRST205' },
        student_documents: { code: 'PGRST205' },
        galleria_media_v2: { code: '42P01' },
        news_posts: { code: 'PGRST205' },
        chat_threads: { code: 'PGRST205' },
      },
    })
    const c = await contaCosaDistrugge(f.client as never, 'al-1', 'test')
    expect(c).toEqual({
      pagelle: 0,
      certificati_medici: 0,
      fascicolo_sanitario: 0,
      foto_solo_sue: 0,
      foto_di_gruppo: 0,
      foto_non_rimovibili: 0,
      articoli_pubblici: 0,
      allegati_chat: 0,
    })
  })

  it('senza alunno non si interroga niente', async () => {
    const f = clienteFinto({ pagelle: [{ id: 'pg-1', file_url: 'x.pdf' }] })
    const c = await contaCosaDistrugge(f.client as never, '  ', 'test')
    expect(c.pagelle).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// LA RIGA DI LOG — dichiarata «l'unica risposta che non dipende dalla memoria di
// qualcuno», e fino al 2026-08-13 senza nessun test.
//
// La mutazione lo ha dimostrato: avvolgendo quel `logEvento` in una funzione mai
// chiamata, 61 test su 61 restavano verdi. Un presidio che sopravvive alla
// propria rimozione non è un presidio, è un commento.
// ─────────────────────────────────────────────────────────────────────────────
describe('il dry-run LASCIA TRACCIA di ciò che ha mostrato alla Direzione', () => {
  beforeEach(() => spie.logEvento.mockClear())

  const rigaDryRun = () =>
    spie.logEvento.mock.calls.find(
      (c) => c[0] === 'gdpr' && (c[2] as { esito?: string })?.esito === 'oblio-dryrun-cosa-distrugge',
    )

  it('i numeri mostrati finiscono in un evento PERSISTITO', async () => {
    const f = clienteFinto({
      pagelle: [{ id: 'pg-1', file_url: 'a.pdf' }, { id: 'pg-2', file_url: 'b.pdf' }],
      certificati: [{ id: 'cm-1', file_path: 'al-1/x.pdf' }],
      media: MEDIA,
    })
    await contaCosaDistrugge(f.client as never, 'al-1', 'test-op')

    const riga = rigaDryRun()
    expect(riga, 'nessuna traccia di ciò che il dry-run ha mostrato').toBeTruthy()
    expect(riga![1]).toBe('info')
    // Fra sei mesi, alla domanda «vi era stato detto che se ne andavano le
    // pagelle?», questa riga è la risposta. Deve portare i NUMERI, non un «fatto».
    expect(riga![2]).toMatchObject({
      operazione: 'test-op',
      entita_tipo: 'alunni',
      entita_id: 'al-1',
      n_pagelle: 2,
      n_certificati: 1,
      n_foto: 2,
      n_foto_gruppo: 1,
      n_foto_trattenute: 0,
    })
  })

  it('«non misurato» arriva nel log come `null`, non come zero', async () => {
    // Il log è la prova, e una prova che dice «0 pagelle» dove nessuno ha potuto
    // contarle è peggio dell'assenza di prova: fra sei mesi si leggerebbe come
    // «non ce n'erano».
    const f = clienteFinto({
      pagelle: [{ id: 'pg-1', file_url: 'a.pdf' }],
      err: { pagelle: { code: '42501', message: 'permission denied for table pagelle' } },
    })
    await contaCosaDistrugge(f.client as never, 'al-1', 'test-op')
    expect(rigaDryRun()![2]).toMatchObject({ n_pagelle: null, n_certificati: 0 })
  })

  it('nel log solo conteggi e uuid: nessun nome, nessun percorso di file', async () => {
    // `gdpr` è un evento PERSISTITO e questi sono dati di minori.
    const f = clienteFinto({
      pagelle: [{ id: 'pg-1', file_url: 'scrutini/RossiMarco-pagella.pdf' }],
      media: [{ id: 'md-1', file_url: 'uploads/u1/RossiMarco.jpg', tag_students: ['al-1'] }],
    })
    await contaCosaDistrugge(f.client as never, 'al-1', 'test-op')
    const serializzata = JSON.stringify(rigaDryRun()![2])
    expect(serializzata).not.toMatch(/Rossi|Marco|\.pdf|\.jpg/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// L'OBLIO IN BLOCCO — la somma non può inventare un totale.
// ─────────────────────────────────────────────────────────────────────────────
describe('somma dei conteggi (canale delle richieste: più bambini, una conferma)', () => {
  const pieno = (n: number) => ({
    pagelle: n,
    certificati_medici: n,
    fascicolo_sanitario: n,
    foto_solo_sue: n,
    foto_di_gruppo: n,
    foto_non_rimovibili: n,
    articoli_pubblici: n,
    allegati_chat: n,
  })

  it('somma i figli misurati', () => {
    expect(sommaConteggiOblio([pieno(2), pieno(3)])).toEqual(pieno(5))
  })

  it('nessun figlio ⇒ zero, non «non misurato»', () => {
    // È il caso in cui la richiesta riguarda un genitore i cui figli sono tutti
    // ancora iscritti: nessun minore viene anonimizzato, quindi di pagelle non se
    // ne va nessuna. Qui `0` è la risposta VERA.
    expect(sommaConteggiOblio([])).toEqual(pieno(0))
  })

  it('UN solo figlio non misurato annulla il totale di quella voce', () => {
    // Il difetto che questa regola impedisce: 2 pagelle misurate + un bambino
    // illeggibile darebbero «pagelle: 2» — un numero più basso del vero, con
    // l'aria di una misura. Le altre voci restano misurate: un guasto su un
    // magazzino non spegne l'intero avviso.
    const somma = sommaConteggiOblio([pieno(2), { ...pieno(3), pagelle: null }])
    expect(somma.pagelle).toBeNull()
    expect(somma.certificati_medici).toBe(5)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// I DUE CANALI DELL'OBLIO MOSTRANO LO STESSO AVVISO.
//
// IL DIFETTO, misurato il 2026-08-13. L'avviso era stato scritto per
// `OblioPanel` e montato solo lì. Sulla STESSA pagina (`/admin/gdpr`), dieci
// pixel più su, `RichiesteCancellazionePanel` evade la richiesta ex art. 17
// della famiglia — in BLOCCO, su più bambini, con una conferma sola — e
// continuava a farlo mostrando quattro conteggi di persone e nemmeno una parola
// su pagelle, certificati medici, foto o allegati.
//
// Peggio: l'avviso stava sotto, legato alla selezione dell'ALTRO pannello, così
// chi confermava in alto poteva leggere sotto dei numeri di un bambino diverso.
//
// Questo lock non guarda la grafica: guarda che entrambi i pannelli montino il
// componente unico. È un controllo statico e lo dichiara — la prova che i numeri
// arrivino davvero sta nei test dei due pannelli.
// ─────────────────────────────────────────────────────────────────────────────
describe('lock · nessun canale dell’oblio conferma alla cieca', () => {
  const RADICE = process.cwd()
  const PANNELLI = [
    'src/components/features/admin/settings/OblioPanel.tsx',
    'src/components/features/admin/settings/RichiesteCancellazionePanel.tsx',
  ]
  const sorgente = (rel: string) => fs.readFileSync(path.join(RADICE, rel), 'utf8')

  it('la pagina /admin/gdpr monta esattamente questi due pannelli', () => {
    // Se domani ne comparisse un terzo, la riga qui sotto diventa rossa e
    // qualcuno deve decidere se anche quello mostra l'avviso. Senza, il lock
    // resterebbe verde su un elenco scritto una volta e mai più riletto.
    const pagina = sorgente('src/app/(dashboard)/admin/gdpr/page.tsx')
    const montati = [...pagina.matchAll(/<([A-Z][A-Za-z]*Panel)\b/g)].map((m) => m[1]).sort()
    expect([...new Set(montati)]).toEqual(['OblioPanel', 'RichiesteCancellazionePanel'])
  })

  it('entrambi i pannelli montano l’avviso e ne bloccano la conferma se la misura fallisce', () => {
    for (const rel of PANNELLI) {
      const src = sorgente(rel)
      expect(src, `${rel}: non monta <AvvisoOblio>`).toContain('<AvvisoOblio')
      // Il gate: il bottone rosso non parte se la misura non è riuscita. È la
      // seconda metà dello stesso difetto — un avviso muto con il bottone
      // attivo è la conferma alla cieca di prima, con una cornice in più.
      expect(src, `${rel}: il bottone non è vincolato alla misura`).toMatch(/disabled=\{[^}]*misura !== 'ok'/)
      // E la misura fallita dev'essere uno stato dichiarato, non un `if (res.ok)`
      // senza `else`: era esattamente quello il difetto.
      expect(src, `${rel}: il dry-run non ok non produce nessuno stato`).toContain("setMisura('fallita')")
    }
  })

  it('la sonda sa dire di no (prova negativa)', () => {
    // Un pannello finto che non monta l'avviso e lascia il bottone libero: se le
    // asserzioni qui sopra fossero scritte male, sarebbero verdi anche su questo.
    const finto = `const x = 1; <button disabled={busy || !confirm.trim()} />`
    expect(finto).not.toContain('<AvvisoOblio')
    expect(finto).not.toMatch(/disabled=\{[^}]*misura !== 'ok'/)
    expect(finto).not.toContain("setMisura('fallita')")
  })
})
