import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PERSONALE_LIMITI, CONSENSI_PERSONALE_FIELDS } from '@/lib/forms/personale-template'

// =============================================================================
// LA CONSERVAZIONE DELL'ANAGRAFICA DEL PERSONALE — e le quattro cose che i due
// gemelli (`retention-candidature`, `retention-iscrizioni`) hanno già pagato.
//
// 1. PRIMA I FILE, POI LE RIGHE. Al contrario, un errore a metà lascerebbe la
//    scansione di un documento d'identità nell'archivio senza più nessuna riga
//    che la nomini: invisibile, non cancellata — il modo peggiore di conservare
//    il dato di una persona. E la rinuncia è PER PRATICA: una scansione che non
//    esce riguarda la SUA riga, non le altre.
//    ⚠️ QUI VALE ANCHE PER L'UPDATE, ed è la differenza col gemello: azzerare
//    il percorso non è una cancellazione più mite, è la stessa perdita di
//    riferimento. Fatto PRIMA della rimozione, lascia un oggetto nel bucket che
//    nessuna riga nomina più — e che il giro dopo non saprebbe nemmeno esistere.
//    ⚠️ E DAL 12/08/2026 LE FACCE SONO DUE (`documento_fronte_path` e
//    `documento_retro_path`, migrazione `20260812194501`): la riga si chiude solo
//    quando sono usciti ENTRAMBI i file — `every`, non `some`. Con `some`, il
//    retro che non esce verrebbe azzerato in tabella insieme al fronte, e la
//    fotografia del retro di una carta d'identità resterebbe nell'archivio senza
//    più nessuna riga che la nomini, mentre il giro si dichiara riuscito
//    sull'altra metà. È il difetto peggiore di tutta questa consegna.
// 2. IL CONTEGGIO SI LOGGA SEMPRE, ANCHE A ZERO, E FUORI DAL RAMO CHE PUÒ
//    FALLIRE. Nella versione SQL delle iscrizioni l'`INSERT` in `app_log` stava
//    DOPO la `DELETE`: l'eccezione lo saltava, e la difesa che doveva accorgersi
//    del guasto era a valle del guasto. Qui il battito si scrive in un `finally`.
// 3. RIGHE TRATTENUTE ⇒ 500. Un 200 direbbe «fatto» a chi sorveglia il lavoro
//    notturno, e quella conservazione resterebbe scoperta senza che si sappia.
// 4. IL TERMINE PROMESSO E IL TERMINE APPLICATO SONO LO STESSO NUMERO. I 90
//    giorni, i 12 mesi e i 10 anni sono `PERSONALE_LIMITI`, cioè i numeri che il
//    testo del consenso INTERPOLA nella frase che l'interessata legge e spunta —
//    frase che finisce congelata in `pratiche_personale.consents_log`. Se il
//    codice ne applicasse altri, a divergere sarebbe la dichiarazione su cui è
//    stata prestata la presa visione (art. 13 §2 lett. a).
//
// E una quinta, che è di questo dominio: **il percorso della scansione è un dato
// personale**. L'oggetto è la fotografia di una carta d'identità, e `app_log` è
// interrogabile in SQL per 30 giorni: una riga che riportasse quel percorso
// pubblicherebbe l'indirizzo di un documento d'identità dentro una tabella di
// diagnosi.
// =============================================================================

const CRON_SECRET = 'segreto-di-prova-personale-non-usato-altrove'

const h = vi.hoisted(() => ({
  /** La sequenza REALE delle operazioni: è l'ordine la cosa da provare. */
  sequenza: [] as { tipo: 'remove' | 'delete' | 'update'; tabella?: string; valore: unknown }[],
  /** Le colonne chieste a ogni `select()`, per tabella: il ripiego si misura qui. */
  select: [] as { tabella: string; colonne: string }[],
  /**
   * GLI ARGOMENTI DELLE CLAUSOLE. Il gemello ha misurato, il 2026-08-10, che un
   * mock che rimpiazza `lt`/`in`/`order`/`limit` con `() => qb` rende la clausola
   * WHERE INVISIBILE alla suite: due mutazioni sopravvissute con 27 test verdi,
   * fra cui la peggiore possibile — la soglia grossolana spostata sul termine più
   * LUNGO, che smette di leggere le righe scadute e continua a scrivere
   * «esito: ok, zero». Qui gli argomenti si registrano e si asseriscono.
   */
  clausole: [] as { tabella: string; metodo: string; argomenti: unknown[] }[],
  /** Le risposte di lettura, per tabella e in ordine. Vuote ⇒ si usano le righe. */
  lettureP: [] as { data: unknown; error: unknown }[],
  lettureA: [] as { data: unknown; error: unknown }[],
  pratiche: [] as Record<string, unknown>[],
  anagrafiche: [] as Record<string, unknown>[],
  /** Cosa risponde `storage.remove()`. */
  removeRisposta: null as { data: unknown[] | null; error: unknown } | null,
  /** L'errore delle scritture, per tabella e per verso. */
  erroreDeleteP: null as unknown,
  erroreDeleteA: null as unknown,
  erroreUpdate: null as unknown,
  /**
   * L'errore della spazzata del registro dei caricamenti. Ha una casella sua e non
   * riusa `erroreDeleteP`/`erroreDeleteA` perché il verso conservativo è OPPOSTO:
   * là un guasto vale 500, qui vale un `warn` e il giro prosegue.
   */
  erroreDeleteRegistro: null as unknown,
  /** Il `count` restituito dalle scritture. `undefined` ⇒ quante ne sono nominate. */
  countScrittura: undefined as number | undefined,
  /** `true` ⇒ PostgREST il conteggio NON lo restituisce, anche se richiesto. */
  countAssente: false,
  /** Cosa fa esplodere `createAdminClient`, per provare il ramo dell'eccezione. */
  eccezioneClient: null as unknown,
  /** I percorsi che, INTERROGANDO lo Storage, risultano ANCORA nel bucket. */
  ancoraNelBucket: new Set<string>(),
  verifiche: [] as string[],
  eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
  staffNegato: null as unknown,
}))

vi.mock('@/lib/logging/logger', () => ({
  logEvento: (evento: string, livello: string, campi: Record<string, unknown>) => {
    h.eventi.push({ evento, livello, campi })
  },
  logErrore: () => {},
  logOk: () => {},
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: vi.fn(async () =>
    h.staffNegato
      ? { user: null, response: h.staffNegato }
      : { user: { id: '00000000-0000-4000-8000-000000000001' }, response: null },
  ),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => {
    if (h.eccezioneClient) throw h.eccezioneClient
    /** Il `count` arriva SOLO se la route l'ha chiesto: un mock che lo restituisse
     *  sempre certificherebbe una route che non lo chiede. */
    const conteggio = (opzioni: { count?: string } | undefined, ids: unknown) =>
      opzioni?.count === 'exact' && !h.countAssente
        ? (h.countScrittura ?? (ids as string[]).length)
        : undefined
    return {
      from: (tabella: string) => {
        const qb: Record<string, unknown> = {}
        qb.select = (colonne: string) => {
          h.select.push({ tabella, colonne })
          return qb
        }
        for (const m of ['lt', 'in', 'eq', 'order', 'limit', 'not']) {
          qb[m] = (...argomenti: unknown[]) => {
            h.clausole.push({ tabella, metodo: m, argomenti })
            return qb
          }
        }
        qb.delete = (opzioni?: { count?: string }) => ({
          in: (_c: string, ids: unknown) => {
            h.sequenza.push({ tipo: 'delete', tabella, valore: ids })
            const error =
              tabella === 'pratiche_personale'
                ? h.erroreDeleteP
                : tabella === 'caricamenti_personale'
                  ? h.erroreDeleteRegistro
                  : h.erroreDeleteA
            return Promise.resolve({ error, count: conteggio(opzioni, ids) })
          },
        })
        qb.update = (patch: unknown, opzioni?: { count?: string }) => ({
          in: (_c: string, ids: unknown) => {
            h.sequenza.push({ tipo: 'update', tabella, valore: { ids, patch } })
            return Promise.resolve({ error: h.erroreUpdate, count: conteggio(opzioni, ids) })
          },
        })
        qb.then = (res: (v: unknown) => unknown) => {
          const coda = tabella === 'pratiche_personale' ? h.lettureP : h.lettureA
          const righe = tabella === 'pratiche_personale' ? h.pratiche : h.anagrafiche
          return Promise.resolve(coda.shift() ?? { data: righe, error: null }).then(res)
        }
        return qb
      },
      storage: {
        from: () => ({
          remove: (percorsi: string[]) => {
            h.sequenza.push({ tipo: 'remove', valore: percorsi })
            return Promise.resolve(
              h.removeRisposta ?? { data: percorsi.map((p) => ({ name: p })), error: null },
            )
          },
          list: (cartella: string, opzioni?: { search?: string }) => {
            const nome = opzioni?.search ?? ''
            h.verifiche.push(`${cartella}|${nome}`)
            const completo = cartella ? `${cartella}/${nome}` : nome
            return Promise.resolve({
              data: h.ancoraNelBucket.has(completo) ? [{ name: nome }] : [],
              error: null,
            })
          },
        }),
      },
    }
  },
}))

import { POST } from '@/app/api/gdpr/retention-personale/route'

const SORGENTE_ROUTE = readFileSync(
  join(process.cwd(), 'src/app/api/gdpr/retention-personale/route.ts'),
  'utf8',
)
const INFORMATIVA = readFileSync(join(process.cwd(), 'src/app/privacy/page.tsx'), 'utf8')

/**
 * L'informativa SENZA i commenti JSX: ciò che la persona legge davvero.
 *
 * Non è pignoleria. Le note di quel file SPIEGANO le frasi che sono state tolte —
 * compresa, parola per parola, la promessa di sostituzione della copia del
 * documento — e un lock che cercasse quella promessa nel sorgente grezzo la
 * troverebbe nella nota che racconta perché non c'è più: andrebbe rosso proprio
 * grazie alla correzione che pretende. Un lock che si offende del proprio
 * commento viene cancellato entro una settimana.
 */
const INFORMATIVA_TESTO = INFORMATIVA.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

/**
 * CHI ESEGUE LA SOSTITUZIONE DELLA COPIA DEL DOCUMENTO — dichiarato, non annusato.
 *
 * È VUOTO, e finché lo è né `/privacy` né il testo del consenso possono promettere
 * che la copia «viene sostituita, con cancellazione della precedente». Chi scriverà
 * quel meccanismo — la route di approvazione, o un aggiornamento dell'anagrafica —
 * aggiunga qui la sua riga: la promessa torna lecita nello stesso momento.
 *
 * ⚠️ PERCHÉ UN ELENCO DICHIARATO E NON UNA RICERCA NEL REPO. Perché la ricerca è
 * stata provata, ed è verde a vuoto. Cercare in `src/` un file che nomini
 * `documenti_personale` e chiami `.remove()`/`rimuoviEVerifica()` trova TRE file
 * (misurato l'11/08/2026) e nessuno dei tre sostituisce niente:
 *   · `iscrizione/personale/upload/route.ts` ritira l'oggetto appena caricato
 *     quando la riga di registro non si scrive — un rollback, non una sostituzione;
 *   · `lib/personale/caricamenti.ts` spazza le scansioni ORFANE, cioè quelle che
 *     una pratica non l'hanno mai avuta;
 *   · `lib/gdpr/esegui.ts` nomina il bucket nel registro dell'oblio e chiama
 *     `rimuoviEVerifica` per tutt'altri magazzini.
 * Con quel detettore la prova sarebbe passata proprio mentre la promessa era falsa:
 * la forma peggiore di lock. È la stessa disciplina di `AUTOMI_DICHIARATI` in
 * `informativa-conservazione-dichiarata` — si dichiara, e poi si verifica che la
 * dichiarazione non sia vuota.
 */
const SOSTITUZIONE_ESEGUITA_DA: { file: string; perche: string }[] = []

/**
 * Tutti i sorgenti di `src/`, ricorsivamente. Serve alle prove che devono cercare
 * CHI fa una cosa nel repo, e non fidarsi di un elenco scritto a mano — l'elenco
 * a mano è la forma giusta quando si dichiara una responsabilità
 * (`SOSTITUZIONE_ESEGUITA_DA`), quella sbagliata quando si deve accorgersi di un
 * file NUOVO scritto da qualcun altro fra sei mesi.
 */
function fileDiSrc(dir = join(process.cwd(), 'src')): string[] {
  const dentro: string[] = []
  for (const voce of readdirSync(dir, { withFileTypes: true })) {
    const percorso = join(dir, voce.name)
    if (voce.isDirectory()) dentro.push(...fileDiSrc(percorso))
    else if (/\.(ts|tsx)$/.test(voce.name)) dentro.push(percorso)
  }
  return dentro
}

const chiama = (headers: Record<string, string> = { 'x-cron-secret': CRON_SECRET }) =>
  POST(
    new Request('http://localhost/api/gdpr/retention-personale', {
      method: 'POST',
      headers,
    }) as never,
  )

/** Una data di `n` giorni fa, calcolata come la calcola la route. */
function giorniFa(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString()
}

/** Una data di `n` mesi fa. */
function mesiFa(n: number): string {
  const d = new Date()
  d.setMonth(d.getMonth() - n)
  return d.toISOString()
}

/** Una data di `n` anni fa. */
function anniFa(n: number): string {
  const d = new Date()
  d.setFullYear(d.getFullYear() - n)
  return d.toISOString()
}

/**
 * Una pratica del modulo pubblico. Il percorso porta il COGNOME nel nome del file,
 * come in produzione: serve a provare che quel nome non finisce in un log.
 *
 * ⚠️ IL RETRO È `null` PER COSTRUZIONE, e non è una svista: è il caso
 * RETROCOMPATIBILE — la riga scritta prima del 12/08/2026, quando il modulo
 * chiedeva una faccia sola. Le due facce insieme si provano dove servono, con
 * `conDueFacce`, così ogni prova dichiara quale dei due mondi sta misurando invece
 * di ereditarlo dal default.
 */
const pratica = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  stato: 'pending',
  creata_il: giorniFa(200),
  evasa_il: null,
  documento_fronte_path: `pratiche/${id}/documento-rossi.jpg`,
  documento_retro_path: null,
  ...extra,
})

/** Un'anagrafica definitiva. La chiave è `utente_id`: la 1:1 non ha un id proprio. */
const anagrafica = (
  utente_id: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  utente_id,
  cessato_il: null,
  documento_fronte_path: `personale/${utente_id}/documento-rossi.jpg`,
  documento_retro_path: null,
  ...extra,
})

/** Il fronte di una riga costruita dalle due funzioni qui sopra. */
const fronteDi = (riga: Record<string, unknown>) => String(riga.documento_fronte_path)
/** Il retro, per le righe che ce l'hanno. */
const retroDi = (riga: Record<string, unknown>) => String(riga.documento_retro_path)

/**
 * Le due facce, come le porta una riga scritta dal modulo di oggi: entrambe
 * obbligatorie per tutti e tre i tipi di documento (CI/PP/DL).
 */
const conDueFacce = (percorsoFronte: string): Record<string, unknown> => ({
  documento_fronte_path: percorsoFronte,
  documento_retro_path: percorsoFronte.replace('documento-rossi', 'retro-rossi'),
})

const soloDi = (tipo: 'remove' | 'delete' | 'update') => h.sequenza.filter((c) => c.tipo === tipo)
const cancellateDa = (tabella: string) =>
  h.sequenza.filter((c) => c.tipo === 'delete' && c.tabella === tabella).flatMap((c) => c.valore as string[])
const aggiornate = () =>
  h.sequenza
    .filter((c) => c.tipo === 'update')
    .flatMap((c) => (c.valore as { ids: string[] }).ids)
const patchDegliUpdate = () =>
  h.sequenza.filter((c) => c.tipo === 'update').map((c) => (c.valore as { patch: unknown }).patch)
const eventiDi = (livello: string) => h.eventi.filter((e) => e.livello === livello)
/** Il battito che `controlloBattitoCron` sa leggere: `cron` · `info` · con i conteggi. */
const battiti = () =>
  h.eventi.filter((e) => e.evento === 'cron' && e.livello === 'info' && 'n_pratiche' in e.campi)
const clausoleDi = (tabella: string, metodo: string) =>
  h.clausole.filter((c) => c.tabella === tabella && c.metodo === metodo)

/** Quanti giorni indietro sta `iso` rispetto a ora, arrotondato al giorno. */
function giorniIndietro(iso: string): number {
  return Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000)
}

/** Quanti mesi indietro sta `iso` rispetto a ora, arrotondato al mese intero. */
function mesiIndietro(iso: string): number {
  const adesso = new Date()
  const d = new Date(iso)
  return (
    (adesso.getFullYear() - d.getFullYear()) * 12 +
    (adesso.getMonth() - d.getMonth()) -
    (adesso.getDate() < d.getDate() ? 1 : 0)
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  h.sequenza = []
  h.select = []
  h.clausole = []
  h.lettureP = []
  h.lettureA = []
  h.pratiche = []
  h.anagrafiche = []
  h.removeRisposta = null
  h.erroreDeleteP = null
  h.erroreDeleteA = null
  h.erroreUpdate = null
  h.erroreDeleteRegistro = null
  h.countScrittura = undefined
  h.countAssente = false
  h.eccezioneClient = null
  h.ancoraNelBucket = new Set()
  h.verifiche = []
  h.eventi = []
  h.staffNegato = null
  process.env.CRON_SECRET = CRON_SECRET
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/gdpr/retention-personale — prima i file, poi le righe', () => {
  it('CONTROLLO POSITIVO: con tutto a posto toglie la scansione E la riga, in quest’ordine', async () => {
    // Senza questo, l'intero file certificherebbe una route che non cancella mai
    // niente — cioè una conservazione che non conserva e non cancella.
    h.pratiche = [pratica('p1')]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, pratiche: 1, file: 1 })
    expect(passi(), 'prima il file, poi la riga, poi il registro che lo nominava').toEqual([
      'remove:storage',
      'delete:pratiche_personale',
      'delete:caricamenti_personale',
    ])
    expect(cancellateDa('pratiche_personale')).toEqual(['p1'])
  })

  it('🔴 anche l’UPDATE che azzera i due percorsi viene DOPO la rimozione dei file', async () => {
    // È la variante che il gemello non aveva, e la più facile da sbagliare: un
    // `update` sembra più mite di una `delete` e verrebbe naturale farlo prima.
    // Sarebbe la stessa perdita di riferimento — l'oggetto resterebbe nel bucket
    // e nessuna riga lo nominerebbe più, quindi nemmeno il giro successivo.
    h.anagrafiche = [anagrafica('u1', { cessato_il: mesiFa(14) })]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(passi(), 'prima remove, poi update, poi il registro').toEqual([
      'remove:storage',
      'update:anagrafica_personale',
      'delete:caricamenti_personale',
    ])
    expect(aggiornate()).toEqual(['u1'])
    expect(
      patchDegliUpdate(),
      'l’update azzera ENTRAMBE le facce e nient’altro: una colonna azzerata e l’altra no è uno ' +
        'stato che nessuno ha deciso',
    ).toEqual([{ documento_fronte_path: null, documento_retro_path: null }])
    expect(await res.json()).toMatchObject({ ok: true, scansioni: 1, anagrafiche: 0, file: 1 })
  })

  it('🔴 una scansione che NON esce trattiene solo la SUA riga, e la risposta è 500', async () => {
    // La conservazione è un obbligo per riga, non per lotto: il documento di p1
    // non ha niente a che vedere con la pratica di p2. E il lotto lavorato a metà
    // si DICHIARA guasto: un 200 direbbe «fatto» a chi sorveglia.
    h.pratiche = [pratica('p1'), pratica('p2')]
    h.removeRisposta = { data: [{ name: 'pratiche/p2/documento-rossi.jpg' }], error: null }
    h.ancoraNelBucket = new Set(['pratiche/p1/documento-rossi.jpg'])
    const res = await chiama()
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({
      ok: false,
      motivo: 'allegati-non-rimossi',
      pratiche: 1,
      righe_trattenute: 1,
    })
    expect(cancellateDa('pratiche_personale'), 'p2 non è trattenuta dal file di p1').toEqual(['p2'])
  })

  it('🔴 se `remove()` fallisce del tutto, NESSUNA riga si tocca — nemmeno con un update', async () => {
    h.pratiche = [pratica('p1')]
    h.anagrafiche = [
      anagrafica('u1', { cessato_il: mesiFa(14) }),
      anagrafica('u2', { cessato_il: anniFa(11) }),
    ]
    h.removeRisposta = { data: null, error: { message: 'storage giù' } }
    const res = await chiama()
    expect(res.status).toBe(500)
    expect(soloDi('delete'), 'una scansione irraggiungibile non è una scansione cancellata').toHaveLength(0)
    expect(soloDi('update'), 'e nemmeno il percorso si dimentica').toHaveLength(0)
    expect(await res.json()).toMatchObject({ ok: false, motivo: 'allegati-non-rimossi', righe_trattenute: 3 })
  })

  it('🔴 e vale identico per le ANAGRAFICHE: la scansione che non esce trattiene la SUA riga', async () => {
    // MISURATO con una mutazione, il giorno stesso in cui questo file è nato:
    // togliendo il filtro dei bloccanti dal solo ramo delle scansioni, i 47 test
    // restavano verdi. Cioè la regola «una scansione ancora nel bucket trattiene
    // la sua riga» era provata per le pratiche e NON per le anagrafiche — proprio
    // dove l'operazione è un `update`, che sembra più mite e non lo è: azzerare il
    // percorso mentre il file è ancora lì lo rende irraggiungibile per sempre, e
    // nemmeno il giro successivo saprebbe che esiste.
    h.anagrafiche = [
      anagrafica('bloccata-12m', { cessato_il: mesiFa(14) }),
      anagrafica('libera-12m', { cessato_il: mesiFa(14) }),
      anagrafica('bloccata-10a', { cessato_il: anniFa(11) }),
    ]
    h.removeRisposta = { data: [{ name: 'personale/libera-12m/documento-rossi.jpg' }], error: null }
    h.ancoraNelBucket = new Set([
      'personale/bloccata-12m/documento-rossi.jpg',
      'personale/bloccata-10a/documento-rossi.jpg',
    ])
    const res = await chiama()
    expect(res.status).toBe(500)
    expect(aggiornate(), 'solo la riga il cui file è davvero uscito si sbianca').toEqual([
      'libera-12m',
    ])
    expect(
      cancellateDa('anagrafica_personale'),
      'e la riga da cancellare con il file ancora nel bucket non si tocca',
    ).toEqual([])
    expect(await res.json()).toMatchObject({
      ok: false,
      motivo: 'allegati-non-rimossi',
      scansioni: 1,
      anagrafiche: 0,
      righe_trattenute: 2,
    })
  })

  it('una scansione GIÀ ASSENTE non blocca niente: l’esito voluto è raggiunto', async () => {
    // Il difetto che si sarebbe auto-bloccato per sempre: un file mancante non
    // torna, e contarlo come guasto avrebbe fermato ogni cancellazione futura.
    h.pratiche = [pratica('p1')]
    h.removeRisposta = { data: [], error: null }
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(cancellateDa('pratiche_personale')).toEqual(['p1'])
    expect(h.verifiche.length, 'il percorso non uscito si verifica').toBe(1)
  })

  it('una pratica SENZA scansione non fa partire nessuna chiamata allo Storage', async () => {
    h.pratiche = [pratica('p1', { documento_fronte_path: null })]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(soloDi('remove'), 'niente da togliere, niente da chiedere').toHaveLength(0)
    expect(cancellateDa('pratiche_personale')).toEqual(['p1'])
  })
})

// =============================================================================
// DUE FACCE, E LA RIGA SI CHIUDE SOLO QUANDO ESCONO ENTRAMBE
//
// ─── PERCHÉ QUESTO BLOCCO È IL PIÙ IMPORTANTE DEL FILE ──────────────────────
//
// Questo job è l'UNICO posto del repo che toglie dal bucket la scansione del
// documento di una persona dodici mesi dopo la cessazione. Fino al 12/08/2026
// leggeva `documento_path` e azzerava UNA colonna: dal giorno in cui il modulo ha
// cominciato a chiedere anche il retro (migrazione `20260812194501`), una route
// rimasta a un percorso solo avrebbe lasciato nell'archivio la fotografia del
// RETRO della carta d'identità di ogni dipendente cessata — per sempre, e senza
// che nessuno se ne accorgesse, perché il giro avrebbe continuato a rispondere
// `ok` sul fronte.
//
// ─── E `every`, NON `some` ───────────────────────────────────────────────────
//
// La riga si chiude solo quando TUTTI i suoi percorsi sono usciti (o erano già
// assenti). Con `some` basterebbe il fronte: le due colonne andrebbero a NULL
// mentre il retro è ancora nel bucket, e da quel momento nessuna riga lo
// nominerebbe più — «invisibile, non cancellato» applicato a metà documento, che
// è peggio del caso a un file solo perché l'altra metà DICHIARA il successo.
// La prova che lo misura è «se il remove del RETRO fallisce…» qui sotto: è la
// mutazione che questo blocco esiste per uccidere.
// =============================================================================

describe('POST /api/gdpr/retention-personale — il documento ha due facce', () => {
  it('🔴 a 12 mesi ESCE ANCHE IL RETRO, e le due colonne vanno a null insieme', async () => {
    // LA PROVA ESPLICITA: «il retro esce dal bucket». Senza, una route rimasta a
    // un percorso solo passerebbe tutto il resto del file — il fronte esce, la
    // riga si azzera, la risposta è 200 — e il retro resterebbe nell'archivio.
    const riga = anagrafica('u1', {
      cessato_il: mesiFa(13),
      ...conDueFacce('personale/u1/documento-rossi.jpg'),
    })
    h.anagrafiche = [riga]
    const res = await chiama()
    expect(res.status).toBe(200)

    const percorsiTolti = soloDi('remove').flatMap((c) => c.valore as string[])
    expect(
      percorsiTolti,
      'il RETRO non è uscito dal bucket: la fotografia della seconda faccia di una carta ' +
        'd’identità resterebbe nell’archivio per sempre, e il giro continuerebbe a dichiarare ok',
    ).toContain(retroDi(riga))
    expect(percorsiTolti, 'e il fronte con lui').toContain(fronteDi(riga))
    expect(percorsiTolti).toHaveLength(2)

    expect(patchDegliUpdate(), 'entrambe le colonne, mai una a metà').toEqual([
      { documento_fronte_path: null, documento_retro_path: null },
    ])
    expect(aggiornate()).toEqual(['u1'])
    expect(await res.json()).toMatchObject({ ok: true, scansioni: 1, file: 2 })
  })

  it('🔴 se il RETRO non esce, la riga NON viene azzerata AFFATTO — nemmeno il fronte', async () => {
    // LA MUTAZIONE CHE QUESTA PROVA UCCIDE: `every` → `some` nel filtro dei
    // chiudibili. Con `some` il fronte uscito basterebbe a far azzerare ENTRAMBE
    // le colonne, e il retro rimasto nel bucket non sarebbe più nominato da
    // nessuna riga: non lo troverebbe più nemmeno questo job, che parte proprio da
    // quelle colonne. Una scansione «invisibile, non cancellata» — e per giunta
    // dichiarata cancellata dal conteggio.
    const riga = anagrafica('u1', {
      cessato_il: mesiFa(13),
      ...conDueFacce('personale/u1/documento-rossi.jpg'),
    })
    h.anagrafiche = [riga]
    h.removeRisposta = { data: [{ name: fronteDi(riga) }], error: null }
    h.ancoraNelBucket = new Set([retroDi(riga)])

    const res = await chiama()
    expect(res.status).toBe(500)
    expect(
      soloDi('update'),
      'il fronte è uscito e il retro no: azzerare adesso significa perdere il riferimento ' +
        'all’unico file rimasto nel bucket',
    ).toHaveLength(0)
    expect(await res.json()).toMatchObject({
      ok: false,
      motivo: 'allegati-non-rimossi',
      scansioni: 0,
      righe_trattenute: 1,
    })
    expect(battiti()[0].campi).toMatchObject({
      esito: 'righe-trattenute',
      n_scansioni: 0,
      n_righe_trattenute: 1,
    })
  })

  it('🔴 … e lo stesso vale per la RIGA cancellata a 10 anni', async () => {
    // Il verso `delete` della stessa regola: qui non si perde un riferimento, si
    // perde la riga intera — e con lei l'unica traccia del retro rimasto dentro.
    const riga = anagrafica('u1', {
      cessato_il: anniFa(11),
      ...conDueFacce('personale/u1/documento-rossi.jpg'),
    })
    h.anagrafiche = [riga]
    h.removeRisposta = { data: [{ name: fronteDi(riga) }], error: null }
    h.ancoraNelBucket = new Set([retroDi(riga)])

    const res = await chiama()
    expect(res.status).toBe(500)
    expect(cancellateDa('anagrafica_personale')).toEqual([])
    expect(await res.json()).toMatchObject({ anagrafiche: 0, righe_trattenute: 1 })
  })

  it('🔴 e vale per la PRATICA come per l’anagrafica: le due facce sono le sue', async () => {
    const p = pratica('p1', { ...conDueFacce('pratiche/p1/documento-rossi.jpg') })
    h.pratiche = [p]
    h.removeRisposta = { data: [{ name: retroDi(p) }], error: null }
    h.ancoraNelBucket = new Set([fronteDi(p)])
    const res = await chiama()
    expect(res.status).toBe(500)
    expect(
      cancellateDa('pratiche_personale'),
      'la riga è la sola cosa che nomina il fronte rimasto nel bucket',
    ).toEqual([])
  })

  it('la riga col SOLO fronte resta lavorabile: un file, due colonne azzerate', async () => {
    // RETROCOMPATIBILITÀ. Le righe scritte prima del 12/08/2026 hanno una faccia
    // sola, e il `rename column` le ha portate tutte sul fronte. Se questo caso si
    // rompesse, le scansioni raccolte fino a ieri non uscirebbero MAI dal bucket —
    // ed è l'unico insieme di righe che in produzione esiste davvero.
    h.anagrafiche = [anagrafica('u1', { cessato_il: mesiFa(13) })]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(soloDi('remove').flatMap((c) => c.valore as string[])).toEqual([
      'personale/u1/documento-rossi.jpg',
    ])
    expect(
      patchDegliUpdate(),
      'il retro non c’era, ma la colonna si azzera lo stesso: costa niente e chiude la riga in ' +
        'uno stato unico',
    ).toEqual([{ documento_fronte_path: null, documento_retro_path: null }])
    expect(await res.json()).toMatchObject({ ok: true, scansioni: 1, file: 1 })
  })

  it('e la riga col solo RETRO — che nessun modulo scrive, ma un SQL a mano sì — non viene dimenticata', async () => {
    // «Non lo produce nessun percorso applicativo» non è «non esiste»: è la stessa
    // ragione per cui `STATI_RESPINTE` guarda anche la `pending` con `evasa_il`.
    // Se la route leggesse il solo fronte, questa riga avrebbe una fotografia di
    // carta d'identità nel bucket e nessun termine che la faccia scadere.
    h.anagrafiche = [
      anagrafica('u1', {
        cessato_il: mesiFa(13),
        documento_fronte_path: null,
        documento_retro_path: 'personale/u1/retro-rossi.jpg',
      }),
    ]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(soloDi('remove').flatMap((c) => c.valore as string[])).toEqual([
      'personale/u1/retro-rossi.jpg',
    ])
    expect(aggiornate()).toEqual(['u1'])
  })

  it('🔴 se manca `documento_retro_path` in tabella, il documento è IGNOTO e non si tocca niente', async () => {
    // METÀ INFORMAZIONE NON È INFORMAZIONE. Su un database che non ha ancora la
    // colonna del retro, leggere il solo fronte e cancellare vorrebbe dire togliere
    // la riga lasciando nel bucket un file che quella riga era l'unica a nominare.
    // È lo stesso verso conservativo già scritto per `documento_path`, esteso alla
    // seconda faccia: se anche UNA SOLA delle due colonne non si legge, non si
    // tocca NESSUNA riga.
    h.pratiche = [pratica('p1')]
    h.lettureA = [
      {
        data: null,
        error: {
          code: '42703',
          message: 'column anagrafica_personale.documento_retro_path does not exist',
        },
      },
      { data: [anagrafica('u1', { cessato_il: mesiFa(13) })], error: null },
    ]
    const res = await chiama()
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({
      ok: false,
      motivo: 'documento-ignoto',
      pratiche: 0,
      anagrafiche: 0,
      scansioni: 0,
    })
    expect(h.sequenza, 'né file né righe: un 200 direbbe «fatto» a chi sorveglia').toHaveLength(0)
    expect(battiti()[0].campi).toMatchObject({
      esito: 'documento-ignoto',
      documento_ignoto: true,
    })
  })

  it('🔴 … e vale identico quando a perdere il retro è `pratiche_personale`', async () => {
    h.lettureP = [
      {
        data: null,
        error: {
          code: 'PGRST204',
          message: 'column pratiche_personale.documento_retro_path does not exist',
        },
      },
      { data: [pratica('p1', { documento_retro_path: undefined })], error: null },
    ]
    const res = await chiama()
    expect(res.status).toBe(503)
    expect(soloDi('delete')).toHaveLength(0)
    expect(soloDi('remove')).toHaveLength(0)
    expect(battiti()[0].campi).toMatchObject({ documento_ignoto: true })
  })

  it('i due percorsi si tolgono in UNA sola chiamata allo Storage, e senza duplicati', async () => {
    // `remove()` accetta un elenco: una chiamata per file moltiplicherebbe le
    // richieste per due e, su un lotto pieno, sfonderebbe il tempo della funzione —
    // e un lavoro che SCADE non cancella niente e si ripresenta identico.
    h.anagrafiche = [
      anagrafica('u1', { cessato_il: mesiFa(13), ...conDueFacce('personale/u1/documento-rossi.jpg') }),
      anagrafica('u2', { cessato_il: mesiFa(13), ...conDueFacce('personale/u2/documento-rossi.jpg') }),
    ]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(soloDi('remove'), 'una chiamata sola, con tutti i percorsi dentro').toHaveLength(1)
    const percorsi = soloDi('remove')[0].valore as string[]
    expect(percorsi).toHaveLength(4)
    expect(new Set(percorsi).size, 'nessun percorso ripetuto').toBe(4)
    expect(await res.json()).toMatchObject({ file: 4, scansioni: 2 })
  })
})

// =============================================================================
// IL REGISTRO DEI CARICAMENTI, CHE NOMINA GLI STESSI OGGETTI
//
// `caricamenti_personale` ha per chiave primaria il `percorso`: è la riga che dice
// CHI ha caricato quell'oggetto (migrazione `20260811234334`, più
// `anagrafica_utente_id` dal `20260812194501`). Le due cascate del database la
// portano via quando muore il suo proprietario — `pratica_id` e
// `anagrafica_utente_id` sono entrambe `on delete cascade` — ma NON coprono il
// caso centrale di questo job: a dodici mesi la scansione esce dal bucket e
// l'anagrafica RESTA, ancora nove anni. Senza questa spazzata, il registro
// continuerebbe a nominare oggetti che non esistono più.
// =============================================================================

describe('POST /api/gdpr/retention-personale — il registro dei caricamenti', () => {
  it('🔴 le righe di registro che nominano i file USCITI vengono cancellate', async () => {
    const riga = anagrafica('u1', {
      cessato_il: mesiFa(13),
      ...conDueFacce('personale/u1/documento-rossi.jpg'),
    })
    h.anagrafiche = [riga]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(
      cancellateDa('caricamenti_personale'),
      'a dodici mesi l’anagrafica resta in tabella: nessuna cascata porta via il registro, e ' +
        'quelle righe nominerebbero due oggetti che non esistono più',
    ).toEqual([fronteDi(riga), retroDi(riga)])
  })

  it('🔴 e il registro si tocca DOPO i file, mai prima', async () => {
    // La riga di registro è l'unica che nomina l'oggetto per chiave: toglierla
    // prima della rimozione lascerebbe nel bucket un file che nemmeno la spazzata
    // degli orfani saprebbe più trovare.
    h.pratiche = [pratica('p1')]
    await chiama()
    const ordine = passi()
    expect(ordine.indexOf('remove:storage')).toBeLessThan(
      ordine.indexOf('delete:caricamenti_personale'),
    )
  })

  it('🔴 un file TRATTENUTO non perde la sua riga di registro', async () => {
    // Il file è ancora nel bucket: la sua riga di registro è l'unica cosa che lo
    // nomina per chiave, e toglierla lo renderebbe irraggiungibile anche alla
    // spazzata degli orfani.
    h.pratiche = [pratica('p1'), pratica('p2')]
    h.removeRisposta = { data: [{ name: 'pratiche/p2/documento-rossi.jpg' }], error: null }
    h.ancoraNelBucket = new Set(['pratiche/p1/documento-rossi.jpg'])
    const res = await chiama()
    expect(res.status).toBe(500)
    expect(cancellateDa('caricamenti_personale')).toEqual(['pratiche/p2/documento-rossi.jpg'])
  })

  it('senza nessun file uscito il registro non si interroga nemmeno', async () => {
    h.pratiche = [pratica('p1', { documento_fronte_path: null })]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(cancellateDa('caricamenti_personale')).toEqual([])
  })

  it('🔴 registro assente (DB della CI non migrato) ⇒ warn, e il giro NON fallisce', async () => {
    // Il verso conservativo qui è l'opposto di quello delle scansioni, e la ragione
    // è quale dato resta indietro: una riga di registro orfana nomina un file che
    // NON C'È PIÙ. Fermare la conservazione per questo lascerebbe nel bucket le
    // scansioni vere — cioè si smetterebbe di cancellare documenti d'identità per
    // proteggere un elenco di nomi di oggetti inesistenti.
    h.erroreDeleteRegistro = { code: 'PGRST205', message: 'relation caricamenti_personale not found' }
    h.pratiche = [pratica('p1')]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, pratiche: 1 })
    const avviso = eventiDi('warn').find((e) => e.campi.esito === 'registro-non-ripulito')
    expect(avviso, 'un ripiego taciuto è un ripiego che nessuno scopre').toBeTruthy()
    expect(avviso?.campi.error_code).toBe('PGRST205')
    expect(
      battiti()[0].campi.n_registro,
      'la spazzata è ESPLOSA: `0` direbbe «misurato, ed erano zero» — che è il fatto opposto',
    ).toBeNull()
  })

  it('e il conteggio del registro sta nel battito anche quando va tutto bene', async () => {
    h.pratiche = [pratica('p1')]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(battiti()[0].campi).toMatchObject({ n_registro: 1 })
  })

  it('🔴 «riuscita a zero righe» e «esplosa» NON scrivono lo stesso battito', async () => {
    // È la distinzione che questo file esiste per difendere, nell'unico ramo in cui
    // serve davvero: sul DB della CI (non migrato) e sulla produzione fino
    // all'11/08/2026 la tabella non c'è, e la DELETE va sempre in errore. Con
    // `n_registro: 0` in entrambi i casi, chi domani legge `app_log` filtrando
    // `esito = 'ok'` non ha modo di sapere che la spazzata non è mai partita — la
    // stessa classe di guasto del `403` senza corpo (AGENTS §5), dentro il file che
    // si vanta di averla evitata.
    //
    // Un percorso scritto prima che il registro esistesse non ha nessuna riga da
    // cancellare: `count: 0` con `error: null` è un esito NORMALE e va detto come
    // misura, non confuso con l'assenza di misura.
    h.pratiche = [pratica('p1')]
    h.countScrittura = 0
    const riuscita = await chiama()
    expect(riuscita.status).toBe(200)
    expect(battiti()[0].campi.n_registro, 'misurato, ed erano zero').toBe(0)

    h.sequenza = []
    h.eventi = []
    h.countScrittura = undefined
    h.erroreDeleteRegistro = { code: 'PGRST205', message: 'relation not found' }
    h.pratiche = [pratica('p1')]
    const esplosa = await chiama()
    expect(esplosa.status).toBe(200)
    expect(battiti()[0].campi.n_registro, 'non misurato: la DELETE è fallita').toBeNull()
  })

  it('🔴 la spazzata del registro si SPEZZA: nessuna DELETE porta un lotto intero di percorsi', async () => {
    // PostgREST mette i filtri nella QUERY STRING anche per la DELETE, e
    // `percorsiUsciti` non ha un tetto proprio: deriva dal lotto, che con due facce
    // arriva a ~3000 percorsi (500 pratiche×2 + 500 fascicoli×2 + 500 anagrafiche×2).
    // Misurato con `new URLSearchParams`, sui percorsi VERI (88 caratteri:
    // `documenti/<uuid>/<uuid>.jpeg`):
    //
    //     25 percorsi →   2.540 byte      3000 percorsi → 303.015 byte
    //
    // e al tetto del CHECK di colonna (200 caratteri) 3000 percorsi fanno 639.015
    // byte. Kong e nginx rifiutano molto prima (414/400, con l'8 KB di default sul
    // buffer di richiesta). Senza spezzettamento, quindi, su un lotto pieno la
    // FASE 4 non ripulirebbe MAI il registro — e siccome il suo guasto è un `warn`
    // che non ferma il giro, nessuno se ne accorgerebbe: esattamente l'esito che
    // questa fase esiste per impedire.
    h.anagrafiche = Array.from({ length: 60 }, (_, i) =>
      anagrafica(`u${i}`, {
        cessato_il: mesiFa(13),
        ...conDueFacce(`personale/u${i}/documento-rossi.jpg`),
      }),
    )
    const res = await chiama()
    expect(res.status).toBe(200)

    const chiamate = h.sequenza.filter(
      (c) => c.tipo === 'delete' && c.tabella === 'caricamenti_personale',
    )
    const tutti = h.anagrafiche.flatMap((r) => [fronteDi(r), retroDi(r)])
    expect(tutti).toHaveLength(120)

    expect(chiamate.length, 'una DELETE sola con 120 percorsi è il difetto').toBeGreaterThan(1)
    for (const c of chiamate) {
      expect(
        (c.valore as string[]).length,
        'un gruppo oltre il tetto rimette la riga di richiesta sulla strada del 414',
      ).toBeLessThanOrEqual(25)
    }
    expect(
      cancellateDa('caricamenti_personale').sort(),
      'spezzare non è perdere: ogni percorso uscito resta coperto, una volta sola',
    ).toEqual([...tutti].sort())
    expect(
      battiti()[0].campi.n_registro,
      'il battito porta la SOMMA dei conteggi dei gruppi, non quello dell’ultimo',
    ).toBe(120)
  })

  it('🔴 un gruppo che esplode ferma la spazzata e NON la dichiara misurata', async () => {
    // Il primo gruppo fallisce: se la tabella non c'è, non c'è nessun gruppo
    // successivo che possa riuscire, e insistere sarebbe una richiesta dietro
    // l'altra verso lo stesso errore. Ciò che NON si può fare è dichiarare un
    // numero: il giro è incompleto e `n_registro` è una misura, non un'intenzione.
    h.anagrafiche = Array.from({ length: 60 }, (_, i) =>
      anagrafica(`u${i}`, {
        cessato_il: mesiFa(13),
        ...conDueFacce(`personale/u${i}/documento-rossi.jpg`),
      }),
    )
    h.erroreDeleteRegistro = { code: 'PGRST205', message: 'relation not found' }
    const res = await chiama()

    expect(res.status, 'la parte irreversibile è già fatta: il giro non fallisce').toBe(200)
    const chiamate = h.sequenza.filter(
      (c) => c.tipo === 'delete' && c.tabella === 'caricamenti_personale',
    )
    expect(chiamate, 'inutile martellare: al primo errore ci si ferma').toHaveLength(1)
    expect(battiti()[0].campi.n_registro).toBeNull()

    const avviso = eventiDi('warn').find((e) => e.campi.esito === 'registro-non-ripulito')
    expect(avviso?.campi.error_code).toBe('PGRST205')
    expect(
      avviso?.campi.n_percorsi_non_spazzati,
      'quanto è rimasto indietro è il fatto che serve per rimediare',
    ).toBe(120)
  })

  it('🔴 nessun log del registro nomina un percorso', async () => {
    h.erroreDeleteRegistro = { code: '42501', message: 'permission denied' }
    h.pratiche = [pratica('p1')]
    await chiama()
    const tutto = JSON.stringify(h.eventi)
    for (const proibito of ['documento-rossi', 'pratiche/p1']) {
      expect(tutto.includes(proibito), `«${proibito}» non deve stare in un log`).toBe(false)
    }
  })
})

// =============================================================================
// LA PRATICA APPROVATA, E IL FASCICOLO CHE SE LA PORTA VIA
//
// ─── IL DIFETTO CHE QUESTO BLOCCO CHIUDE (rilievo del revisore, 2026-08-11) ──
//
// La route leggeva `pratiche_personale` con `.in('stato', ['pending',
// 'in_approvazione', 'rifiutata'])`: la riga APPROVATA non veniva nemmeno letta,
// e in tutto `src/` non esisteva nessun'altra `.delete()` su quella tabella.
// Quindi una richiesta accolta restava in archivio PER SEMPRE — nome, codice
// fiscale, data e luogo di nascita, residenza, domicilio, email, telefono,
// estremi del documento e `consents_log` — mentre `/privacy` le dichiarava, nella
// voce sulle richieste, che «se la richiesta viene approvata i dati confluiscono
// nel fascicolo del personale e seguono i termini indicati ai due punti
// precedenti»: dieci anni dalla cessazione. La testata della route stessa la
// chiamava «il pezzo di fascicolo» con quel termine e concludeva, dieci righe
// dopo, che per farla scadere «il termine va prima DICHIARATO in /privacy»: era
// già dichiarato, e il perimetro si contraddiceva da solo.
//
// È la stessa fattispecie del gemello del 2026-08-10 — un termine promesso a una
// persona e applicato da nessuno (art. 13 §2 lett. a) — con un'aggravante di
// schema: `origine_pratica_id` sta sul lato ANAGRAFICA (`on delete set null`),
// quindi cancellare l'anagrafica non si porta via la pratica e DISTRUGGE l'unica
// riga che sapeva quale fosse.
//
// Il lock dei tre numeri non lo prendeva, e non poteva: confronta i NUMERI di
// `/privacy` con `PERSONALE_LIMITI` e non chiede a nessuno di applicarli.
// =============================================================================

/** Le operazioni nell'ordine, con la tabella: qui l'ordine È la regola. */
const passi = () => h.sequenza.map((c) => `${c.tipo}:${c.tabella ?? 'storage'}`)

/** Un'anagrafica cessata da 11 anni, nata da una pratica approvata. */
const fascicoloScaduto = (utente: string, praticaId: string) =>
  anagrafica(utente, {
    cessato_il: anniFa(11),
    documento_fronte_path: null,
    documento_retro_path: null,
    origine_pratica_id: praticaId,
  })

describe('POST /api/gdpr/retention-personale — la pratica APPROVATA e il suo fascicolo', () => {
  it('🔴 il fascicolo che scade porta via il modulo che l’ha generato', async () => {
    h.lettureP = [
      { data: [], error: null },
      { data: [{ id: 'pa1', documento_fronte_path: null, documento_retro_path: null }], error: null },
    ]
    h.anagrafiche = [fascicoloScaduto('u1', 'pa1')]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(
      cancellateDa('pratiche_personale'),
      'la richiesta approvata non scadeva mai: restava in tabella con codice fiscale, ' +
        'residenza, domicilio, recapiti ed estremi del documento, mentre /privacy le ' +
        'dichiarava dieci anni dalla cessazione',
    ).toEqual(['pa1'])
    expect(cancellateDa('anagrafica_personale')).toEqual(['u1'])
    expect(await res.json()).toMatchObject({
      ok: true,
      pratiche: 0,
      pratiche_fascicolo: 1,
      anagrafiche: 1,
    })
  })

  it('🔴 e la cancella PRIMA dell’anagrafica: il legame muore con lei', async () => {
    // `origine_pratica_id` vive sul lato anagrafica. Nell'ordine opposto, una
    // seconda `delete` che fallisce lascerebbe in `pratiche_personale` la copia
    // integrale di un'anagrafica e nessuna riga che sappia più a chi appartiene:
    // il giro dopo non saprebbe nemmeno cercarla.
    h.lettureP = [
      { data: [], error: null },
      { data: [{ id: 'pa1', documento_fronte_path: null, documento_retro_path: null }], error: null },
    ]
    h.anagrafiche = [fascicoloScaduto('u1', 'pa1')]
    await chiama()
    expect(passi()).toEqual(['delete:pratiche_personale', 'delete:anagrafica_personale'])
  })

  it('🔴 se la `delete` della pratica fallisce, l’anagrafica NON viene toccata', async () => {
    // Il verso che rende utile l'ordine: il guasto lascia la coppia intera, e la
    // notte dopo si richiude. Con l'ordine opposto avrebbe lasciato un orfano.
    h.lettureP = [
      { data: [], error: null },
      { data: [{ id: 'pa1', documento_fronte_path: null, documento_retro_path: null }], error: null },
    ]
    h.anagrafiche = [fascicoloScaduto('u1', 'pa1')]
    h.erroreDeleteP = { code: '55P03', message: 'lock non ottenuto' }
    const res = await chiama()
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ ok: false, motivo: 'righe-non-cancellate' })
    expect(
      cancellateDa('anagrafica_personale'),
      'cancellarla adesso significherebbe perdere l’unico puntatore alla pratica rimasta',
    ).toEqual([])
  })

  it('🔴 e il file del modulo d’origine esce PRIMA della sua riga', async () => {
    // Per contratto quella colonna è NULL dopo l'approvazione («l'oggetto NON si
    // copia», commento di colonna di 20260811205643). Ma cancellare una riga
    // FIDANDOSI di un contratto è esattamente il modo in cui una fotografia di
    // carta d'identità resta nel bucket senza più nulla che la nomini — e il
    // contratto lo scriverà una route di approvazione che oggi non esiste.
    h.lettureP = [
      { data: [], error: null },
      {
        data: [
          { id: 'pa1', documento_fronte_path: 'pratiche/pa1/documento-rossi.jpg', documento_retro_path: null },
        ],
        error: null,
      },
    ]
    h.anagrafiche = [fascicoloScaduto('u1', 'pa1')]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(passi()).toEqual([
      'remove:storage',
      'delete:pratiche_personale',
      'delete:anagrafica_personale',
      // Il registro dei caricamenti per ultimo: le due cascate del database ne hanno
      // già portata via una parte, e ciò che resta si toglie quando l'oggetto è
      // fuori dal bucket per certo.
      'delete:caricamenti_personale',
    ])
    expect(soloDi('remove')[0].valore).toEqual(['pratiche/pa1/documento-rossi.jpg'])
  })

  it('🔴 una pratica TRATTENUTA dal proprio file trattiene anche la sua anagrafica', async () => {
    // Il controesempio che l'ordine da solo non copre: la scansione della pratica
    // non esce, la pratica resta — e l'anagrafica, che ha un file suo o nessuno,
    // sarebbe chiudibile. Cancellandola si perderebbe `origine_pratica_id`, cioè
    // l'unico puntatore alla riga rimasta: un orfano per sempre.
    h.lettureP = [
      { data: [], error: null },
      {
        data: [
          { id: 'pa1', documento_fronte_path: 'pratiche/pa1/documento-rossi.jpg', documento_retro_path: null },
        ],
        error: null,
      },
    ]
    h.anagrafiche = [fascicoloScaduto('u1', 'pa1')]
    h.removeRisposta = { data: [], error: null }
    h.ancoraNelBucket = new Set(['pratiche/pa1/documento-rossi.jpg'])
    const res = await chiama()
    expect(res.status).toBe(500)
    expect(cancellateDa('pratiche_personale')).toEqual([])
    expect(
      cancellateDa('anagrafica_personale'),
      'l’anagrafica è il solo posto in cui è scritto QUALE pratica va con lei',
    ).toEqual([])
    expect(await res.json()).toMatchObject({
      ok: false,
      motivo: 'allegati-non-rimossi',
      pratiche_fascicolo: 0,
      anagrafiche: 0,
      righe_trattenute: 2,
    })
  })

  it('il rapporto cessato da 12 mesi — non da 10 anni — non tocca nessuna pratica', async () => {
    // A dodici mesi se ne va la SOLA scansione: il fascicolo, e con lui il modulo
    // che l'ha generato, resta ancora nove anni. Senza questa prova, un filtro
    // sbagliato farebbe scadere il modulo d'origine otto anni prima del termine
    // dichiarato — e nel verso in cui il dato non torna più.
    h.lettureP = [{ data: [], error: null }]
    h.anagrafiche = [anagrafica('u1', { cessato_il: mesiFa(14), origine_pratica_id: 'pa1' })]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(cancellateDa('pratiche_personale')).toEqual([])
    expect(aggiornate(), 'la scansione sì: è il termine più corto').toEqual(['u1'])
    expect(
      h.select.filter((s) => s.tabella === 'pratiche_personale'),
      'e la pratica d’origine non viene nemmeno riletta: non c’è nessun fascicolo da chiudere',
    ).toHaveLength(1)
  })

  it('il rapporto IN CORSO non tocca niente, nemmeno la pratica che lo ha generato', async () => {
    h.lettureP = [{ data: [], error: null }]
    h.anagrafiche = [anagrafica('u1', { cessato_il: null, origine_pratica_id: 'pa1' })]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(h.sequenza, 'una persona in servizio non ha niente da perdere qui').toHaveLength(0)
  })

  it('🔴 se `origine_pratica_id` è ignota e un fascicolo scade, NON si tocca niente', async () => {
    // Stesso verso del percorso del documento ignoto: «non so quale pratica appartenga a
    // questa anagrafica» vale «non toccare». Cancellare il fascicolo lascerebbe la
    // sua pratica in tabella e nessuna riga che sappia più a chi appartiene.
    h.pratiche = [pratica('p1')]
    h.lettureA = [
      {
        data: null,
        error: {
          code: '42703',
          message: 'column anagrafica_personale.origine_pratica_id does not exist',
        },
      },
      { data: [anagrafica('u1', { cessato_il: anniFa(11) })], error: null },
    ]
    const res = await chiama()
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({
      ok: false,
      motivo: 'origine-pratica-ignota',
      pratiche: 0,
      anagrafiche: 0,
    })
    expect(h.sequenza, 'né file né righe: un 200 direbbe «fatto» a chi sorveglia').toHaveLength(0)
    expect(battiti()[0].campi).toMatchObject({
      esito: 'origine-pratica-ignota',
      origine_pratica_ignota: true,
    })
  })

  it('… ma se NESSUN fascicolo scade, il giro prosegue: il ripiego non si allarga', async () => {
    // Un ripiego che si estendesse oltre il proprio danno fermerebbe per sempre la
    // cancellazione delle richieste a 90 giorni, per un motivo che non le riguarda.
    h.pratiche = [pratica('p1')]
    h.lettureA = [
      {
        data: null,
        error: {
          code: '42703',
          message: 'column anagrafica_personale.origine_pratica_id does not exist',
        },
      },
      { data: [anagrafica('u1', { cessato_il: mesiFa(14) })], error: null },
    ]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(cancellateDa('pratiche_personale')).toEqual(['p1'])
    expect(aggiornate()).toEqual(['u1'])
    expect(
      battiti()[0].campi,
      'il fatto resta scritto: rileggendo app_log si distingue «il database ce l’ha» da ' +
        '«non c’era niente da chiudere»',
    ).toMatchObject({ esito: 'ok', origine_pratica_ignota: true })
  })

  it('🔴 se la rilettura del modulo d’origine fallisce, non si chiude nessun fascicolo', async () => {
    h.lettureP = [
      { data: [], error: null },
      { data: null, error: { code: '08006', message: 'connessione persa' } },
    ]
    h.anagrafiche = [fascicoloScaduto('u1', 'pa1')]
    const res = await chiama()
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ ok: false, motivo: 'lettura-fallita' })
    expect(h.sequenza).toHaveLength(0)
    expect(battiti(), 'il battito sta fuori dal ramo che può fallire').toHaveLength(1)
  })

  it('una pratica d’origine GIÀ SPARITA non blocca la chiusura del fascicolo', async () => {
    // Cancellata a mano, o da un giro precedente andato a metà: l'id non torna
    // dalla rilettura. Non è un errore — è il lavoro già fatto — e trattenere
    // l'anagrafica per questo la conserverebbe oltre i dieci anni dichiarati.
    h.lettureP = [
      { data: [], error: null },
      { data: [], error: null },
    ]
    h.anagrafiche = [fascicoloScaduto('u1', 'pa1')]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(cancellateDa('pratiche_personale')).toEqual([])
    expect(cancellateDa('anagrafica_personale')).toEqual(['u1'])
    expect(await res.json()).toMatchObject({ ok: true, pratiche_fascicolo: 0, anagrafiche: 1 })
  })

  it('🔴 una pratica già scaduta a 90 giorni non viene cancellata DUE volte', async () => {
    // Se lo stesso id finisse in entrambi gli insiemi, la seconda `delete`
    // toccherebbe zero righe e farebbe gridare `conteggio-discorde` a un giro
    // perfettamente riuscito — un allarme falso, che si impara a ignorare.
    h.lettureP = [
      { data: [pratica('pa1', { documento_fronte_path: null })], error: null },
      { data: [{ id: 'pa1', documento_fronte_path: null, documento_retro_path: null }], error: null },
    ]
    h.anagrafiche = [fascicoloScaduto('u1', 'pa1')]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(cancellateDa('pratiche_personale')).toEqual(['pa1'])
    expect(soloDi('delete').filter((c) => c.tabella === 'pratiche_personale')).toHaveLength(1)
    expect(
      eventiDi('warn').some((e) => e.campi.esito === 'conteggio-discorde'),
      'nessun allarme su un giro riuscito',
    ).toBe(false)
  })

  it('🔴 nessun log nomina l’uuid della pratica o dell’anagrafica', async () => {
    h.lettureP = [
      { data: [], error: null },
      {
        data: [
          { id: 'pa1', documento_fronte_path: 'pratiche/pa1/documento-rossi.jpg', documento_retro_path: null },
        ],
        error: null,
      },
    ]
    h.anagrafiche = [fascicoloScaduto('u1', 'pa1')]
    await chiama()
    const tutto = JSON.stringify(h.eventi)
    for (const proibito of ['pa1', 'documento-rossi', 'pratiche/pa1']) {
      expect(tutto.includes(proibito), `«${proibito}» non deve stare in un log`).toBe(false)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/gdpr/retention-personale — il battito, che si scrive SEMPRE', () => {
  it('🔴 il conteggio c’è ANCHE A ZERO: «nessuna riga» non può voler dire due cose', async () => {
    // Con i soli errori, «nessun log» non distingue «tutto a posto» da «non è mai
    // partito niente» — l'ambiguità che ha nascosto il guasto delle email.
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(battiti()).toHaveLength(1)
    expect(battiti()[0].campi).toMatchObject({
      n_pratiche: 0,
      n_anagrafiche: 0,
      n_scansioni: 0,
      esito: 'ok',
    })
  })

  it('🔴 il conteggio c’è anche quando la LETTURA fallisce: sta fuori dal ramo che può fallire', async () => {
    h.lettureP = [{ data: null, error: { code: '08006', message: 'connessione persa' } }]
    const res = await chiama()
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ ok: false, motivo: 'lettura-fallita' })
    expect(battiti(), 'il battito non può stare dentro la transazione che sorveglia').toHaveLength(1)
    expect(eventiDi('error').some((e) => e.campi.esito === 'lettura-fallita')).toBe(true)
  })

  it('… e vale anche se a cadere è la SECONDA lettura (le anagrafiche)', async () => {
    // Le due letture sono due, e una route che controlla `{ error }` solo sulla
    // prima leggerebbe «nessuna anagrafica cessata» da un guasto di rete.
    h.pratiche = [pratica('p1')]
    h.lettureA = [{ data: null, error: { code: '08006', message: 'connessione persa' } }]
    const res = await chiama()
    expect(res.status).toBe(500)
    expect(soloDi('delete'), 'un guasto a metà non autorizza a chiudere l’altra metà').toHaveLength(0)
    expect(battiti()).toHaveLength(1)
  })

  it('il battito è quello che `controlloBattitoCron` sa leggere: cron · info · esito ok · operazione', async () => {
    // `esito` risponde a «è andata bene?», non a «di che cosa si occupa»: un
    // battito con l'esito sbagliato non viene contato da nessuno, e il lavoro può
    // smettere di girare senza che nulla lo dica.
    h.pratiche = [pratica('p1')]
    await chiama()
    expect(battiti()[0].campi).toMatchObject({
      operazione: 'retention-personale',
      esito: 'ok',
      n_pratiche: 1,
    })
  })

  it('🔴 il conteggio c’è anche sull’ECCEZIONE, e l’eccezione non viene inghiottita', async () => {
    h.eccezioneClient = new Error('createAdminClient: connessione rifiutata')
    await expect(chiama(), 'un’eccezione si logga e si RILANCIA, non si maschera').rejects.toThrow(
      'connessione rifiutata',
    )
    expect(battiti(), 'il battito sopravvive all’eccezione').toHaveLength(1)
    expect(battiti()[0].campi).toMatchObject({ esito: 'eccezione', n_pratiche: 0 })
    expect(eventiDi('error').some((e) => e.campi.esito === 'eccezione')).toBe(true)
  })

  it('e quando qualcosa resta indietro il battito NON dice `ok`', async () => {
    h.pratiche = [pratica('p1')]
    h.removeRisposta = { data: [], error: null }
    h.ancoraNelBucket = new Set(['pratiche/p1/documento-rossi.jpg'])
    const res = await chiama()
    expect(res.status).toBe(500)
    expect(battiti()).toHaveLength(1)
    expect(
      battiti()[0].campi.esito,
      'un giro che non ha finito il lavoro non è un giro riuscito',
    ).not.toBe('ok')
    expect(battiti()[0].campi).toMatchObject({ n_righe_trattenute: 1 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/gdpr/retention-personale — i tre termini', () => {
  it('🔴 la pratica non approvata scade a 90 giorni, e la DECISIONE sposta la decorrenza', async () => {
    h.pratiche = [
      pratica('fresca', { creata_il: giorniFa(30) }),
      pratica('vecchia', { creata_il: giorniFa(120) }),
      // Respinta ieri dopo un anno di attesa: il termine riparte dalla decisione.
      pratica('respinta-ieri', {
        stato: 'rifiutata',
        creata_il: giorniFa(365),
        evasa_il: giorniFa(1),
      }),
      pratica('respinta-da-un-pezzo', {
        stato: 'rifiutata',
        creata_il: giorniFa(365),
        evasa_il: giorniFa(120),
      }),
    ]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(cancellateDa('pratiche_personale')).toEqual(['vecchia', 'respinta-da-un-pezzo'])
  })

  it('🔴 solo il RIFIUTO sposta la decorrenza: un `evasa_il` su una pratica in attesa non allunga', async () => {
    // L'informativa dice «novanta giorni dalla ricezione, O DALLA DECISIONE SE LA
    // RICHIESTA È STATA RESPINTA»: la seconda decorrenza ha una condizione, e
    // ignorarla conserva NOVANTA GIORNI OLTRE il termine dichiarato. Il verso
    // dell'errore sarebbe quello che conserva di più, che è il verso sbagliato
    // quando il numero è un termine promesso (è la correzione che il gemello ha
    // pagato il 2026-08-10). L'incoerenza qui sotto — `pending` con `evasa_il` —
    // nessun percorso applicativo la produce, ma una UPDATE scritta a mano sì.
    h.pratiche = [
      pratica('in-attesa-con-evasa-il-strana', {
        stato: 'pending',
        creata_il: giorniFa(200),
        evasa_il: giorniFa(1),
      }),
    ]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(
      cancellateDa('pratiche_personale'),
      'la pratica mai respinta scade dalla RICEZIONE, qualunque cosa dica `evasa_il`',
    ).toEqual(['in-attesa-con-evasa-il-strana'])
  })

  it('🔴 una RESPINTA senza data di decisione NON si cancella: il ripiego anticiperebbe il termine', async () => {
    // IL DIFETTO CHE QUESTA PROVA CHIUDE (rilievo del revisore, 2026-08-11), ed è
    // il verso peggiore dei due: cancellare TROPPO, che non si torna indietro.
    //
    // Fino a stamattina il riferimento era `evasa_il ?? creata_il`. È aritmetica:
    // `creata_il <= evasa_il`, quindi per una pratica RESPINTA il ripiego sulla
    // ricezione fa scadere i 90 giorni PRIMA del termine promesso — di tutto il
    // tempo che la Segreteria ci ha messo a decidere. Con una respinta ieri dopo
    // un anno di attesa, se ne andavano la riga E la scansione della carta
    // d'identità allegata, 275 giorni prima della data dichiarata in /privacy.
    //
    // Il `warn` del ripiego, per giunta, dichiarava l'opposto: «la ricezione è la
    // data più vecchia: non si anticipa nessuna cancellazione». Un messaggio che
    // promette una garanzia che il codice non dà è ciò che questo repo chiama «un
    // documento che descrive una protezione che non c'è» — e lo legge un essere
    // umano di notte, mentre decide se fidarsi.
    h.pratiche = [
      // Respinta un anno fa, ma NESSUNA data di decisione: non è databile.
      pratica('respinta-senza-decisione', {
        stato: 'rifiutata',
        creata_il: giorniFa(365),
        evasa_il: null,
      }),
      // Idem, con una data che non si interpreta.
      pratica('respinta-data-rotta', {
        stato: 'rifiutata',
        creata_il: giorniFa(365),
        evasa_il: 'non-una-data',
      }),
      // IL CONTROLLO POSITIVO: senza, questa prova resterebbe verde anche se la
      // route smettesse di cancellare del tutto.
      pratica('mai-valutata-vecchia', { stato: 'pending', creata_il: giorniFa(365) }),
    ]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(
      cancellateDa('pratiche_personale'),
      'la respinta senza decorrenza leggibile è stata cancellata: è il termine promesso ' +
        'accorciato del tempo di decisione, su una riga che porta con sé la scansione di un ' +
        'documento d’identità',
    ).toEqual(['mai-valutata-vecchia'])
    expect(
      soloDi('remove').flatMap((c) => c.valore as string[]),
      'e nemmeno il file esce dall’archivio: la riga che lo nomina è ancora lì',
    ).toEqual(['pratiche/mai-valutata-vecchia/documento-rossi.jpg'])
  })

  it('… e le righe trattenute si DICHIARANO: «zero scadute» e «non so datarle» sono due fatti', async () => {
    // Il verso opposto è a sua volta un difetto — conservare oltre il termine
    // dichiarato non è prudenza (art. 13 §2 lett. a) — solo reversibile. Perciò si
    // sceglie, ma non in silenzio: senza questo conteggio una `rifiutata` senza
    // `evasa_il` resterebbe in tabella per sempre e il battito continuerebbe a
    // scrivere «esito: ok, zero pratiche», che è indistinguibile da «non c'era
    // niente da fare».
    h.pratiche = [
      pratica('respinta-senza-decisione', { stato: 'rifiutata', creata_il: giorniFa(365), evasa_il: null }),
      pratica('senza-ricezione', { stato: 'pending', creata_il: null }),
    ]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(soloDi('delete')).toHaveLength(0)
    expect(battiti()[0].campi).toMatchObject({
      esito: 'ok',
      n_pratiche: 0,
      n_pratiche_scadute: 0,
      n_pratiche_senza_riferimento: 2,
    })
    const avviso = eventiDi('warn').find((e) => e.campi.esito === 'riferimento-illeggibile')
    expect(avviso, 'un ripiego taciuto è un ripiego che nessuno scopre').toBeTruthy()
    expect(avviso?.campi.n_pratiche_senza_riferimento).toBe(2)
    // E il conteggio resta un conteggio: nessun id, nessun percorso, nessuna data.
    expect(JSON.stringify(avviso)).not.toContain('respinta-senza-decisione')
  })

  it('🔴 la pratica APPROVATA non si tocca MAI: la sua scansione è quella dell’anagrafica', async () => {
    // All'approvazione l'oggetto non si copia — l'anagrafica punta allo stesso
    // file — quindi cancellare qui la riga approvata rischierebbe di togliere il
    // documento che l'anagrafica sta ancora usando. Ed è anche il pezzo di
    // fascicolo che dimostra come quell'anagrafica sia nata: il suo termine è di
    // dieci anni dalla cessazione, non di novanta giorni dall'approvazione.
    h.pratiche = [
      pratica('approvata-vecchissima', { stato: 'approvata', creata_il: giorniFa(900), evasa_il: giorniFa(800) }),
      pratica('stato-inventato-domani', { stato: 'in_revisione_legale', creata_il: giorniFa(900) }),
    ]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(
      soloDi('delete'),
      'né lo stato approvato né uno stato ignoto autorizzano a cancellare',
    ).toHaveLength(0)
    // …e la query lo dice anche al database: elenco POSITIVO, non `neq('approvata')`.
    const inClause = clausoleDi('pratiche_personale', 'in')[0]
    expect(inClause, 'la lettura delle pratiche non filtra più per stato').toBeTruthy()
    expect(inClause.argomenti[0]).toBe('stato')
    expect([...(inClause.argomenti[1] as string[])].sort()).toEqual(
      ['in_approvazione', 'pending', 'rifiutata'].sort(),
    )
  })

  it('🔴 `cessato_il` NULL è un rapporto IN CORSO: non si tocca niente, mai', async () => {
    // È la regola che protegge una persona ancora in servizio. Se cadesse, questo
    // lavoro cancellerebbe il documento d'identità di chi lavora qui domani mattina.
    h.anagrafiche = [
      anagrafica('in-servizio'),
      anagrafica('senza-data', { cessato_il: undefined }),
      anagrafica('data-rotta', { cessato_il: 'non-una-data' }),
    ]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(soloDi('update')).toHaveLength(0)
    expect(soloDi('delete')).toHaveLength(0)
    expect(soloDi('remove'), 'e il file non si tocca nemmeno nell’archivio').toHaveLength(0)
  })

  it('🔴 a 12 mesi dalla cessazione se ne va la SOLA scansione, e la riga resta', async () => {
    h.anagrafiche = [
      anagrafica('cessata-da-6-mesi', { cessato_il: mesiFa(6) }),
      anagrafica('cessata-da-14-mesi', { cessato_il: mesiFa(14) }),
    ]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(aggiornate(), 'a sei mesi non si tocca ancora niente').toEqual(['cessata-da-14-mesi'])
    expect(
      cancellateDa('anagrafica_personale'),
      'il fascicolo vive dieci anni: a quattordici mesi la riga non si cancella',
    ).toEqual([])
  })

  it('🔴 a 10 anni se ne va la RIGA, e non si fa anche l’update sulla stessa riga', async () => {
    // Sbiancare una riga che sta per sparire è lavoro doppio e, soprattutto,
    // farebbe contare due volte lo stesso file: il conteggio dichiarato mentirebbe.
    h.anagrafiche = [anagrafica('cessata-da-11-anni', { cessato_il: anniFa(11) })]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(cancellateDa('anagrafica_personale')).toEqual(['cessata-da-11-anni'])
    expect(soloDi('update'), 'la riga cancellata non si sbianca anche').toHaveLength(0)
    expect(await res.json()).toMatchObject({ anagrafiche: 1, scansioni: 0, file: 1 })
  })

  it('una scansione già assente dalla riga non produce nessun update a vuoto', async () => {
    // I due percorsi sono già NULL: il giro precedente li ha sbiancati. Un update
    // qui non toglierebbe niente e gonfierebbe il conteggio dichiarato.
    h.anagrafiche = [
      anagrafica('gia-sbiancata', { cessato_il: mesiFa(14), documento_fronte_path: null }),
    ]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(soloDi('update')).toHaveLength(0)
    expect(soloDi('remove')).toHaveLength(0)
    expect(await res.json()).toMatchObject({ ok: true, scansioni: 0 })
  })

  it('🔴 una data ILLEGGIBILE non si cancella: «non verificabile» non è «permesso»', async () => {
    // Su un'operazione irreversibile un dato che manca vale «non toccare». Senza
    // questo test la riga che scarta il riferimento illeggibile poteva invertirsi
    // e cancellare tutto ciò che non si sa datare.
    h.pratiche = [
      pratica('senza-data', { creata_il: null }),
      pratica('data-rotta', { creata_il: 'non-una-data' }),
      pratica('buona', { creata_il: giorniFa(120) }),
    ]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(cancellateDa('pratiche_personale'), 'si cancella solo ciò che si sa datare').toEqual([
      'buona',
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/gdpr/retention-personale — il taglio grossolano, che nessuno guardava', () => {
  // Questi test esistono per due mutazioni MISURATE sul gemello il 2026-08-10,
  // sopravvissute entrambe con 27 test verdi perché il mock buttava via gli
  // argomenti delle clausole. Un lock che non guarda la clausola WHERE non
  // sorveglia una query: sorveglia il fatto che una query sia stata scritta.

  it('🔴 sulle pratiche la soglia è di 90 giorni, e si taglia sulla RICEZIONE', async () => {
    await chiama()
    const lt = clausoleDi('pratiche_personale', 'lt')
    expect(lt, 'la lettura delle pratiche non filtra più per data').toHaveLength(1)
    expect(lt[0].argomenti[0], 'il taglio si fa sulla data di RICEZIONE, mai su evasa_il').toBe(
      'creata_il',
    )
    expect(
      giorniIndietro(String(lt[0].argomenti[1])),
      `la soglia deve stare ${PERSONALE_LIMITI.giorniPraticaNonApprovata} giorni indietro: è il ` +
        'termine dichiarato, e `evasa_il` non è mai anteriore a `creata_il`, quindi tagliare sulla ' +
        'ricezione non può nascondere nessuna riga scaduta',
    ).toBe(PERSONALE_LIMITI.giorniPraticaNonApprovata)
  })

  it('🔴 sulle anagrafiche la soglia è il termine PIÙ BREVE (12 mesi), non i 10 anni', async () => {
    // LA MUTAZIONE CHE CONTA: con la soglia a dieci anni, nessuna cessazione fra i
    // 12 mesi e i 10 anni verrebbe mai LETTA — quindi nessuna scansione verrebbe
    // mai tolta — e il battito continuerebbe a dire «esito: ok, zero». Un giro a
    // vuoto che si dichiara riuscito è il guasto che questo file impedisce.
    await chiama()
    const lt = clausoleDi('anagrafica_personale', 'lt')
    expect(lt, 'la lettura delle anagrafiche non filtra più per data').toHaveLength(1)
    expect(lt[0].argomenti[0]).toBe('cessato_il')
    expect(
      mesiIndietro(String(lt[0].argomenti[1])),
      `la soglia deve stare ${PERSONALE_LIMITI.mesiDocumentoDopoCessazione} mesi indietro — il ` +
        'termine PIÙ BREVE dei due. Col più lungo le scansioni di chi ha cessato non uscirebbero ' +
        'mai, e il battito direbbe «ok, zero» ogni notte',
    ).toBe(PERSONALE_LIMITI.mesiDocumentoDopoCessazione)
  })

  it('entrambe le letture hanno un TETTO e leggono le più vecchie per prime', async () => {
    // Senza `.limit()` il taglio lo decide `db-max-rows` di PostgREST, e lo decide
    // in silenzio; senza `.order()` il lotto tagliato è arbitrario, e le righe più
    // in ritardo potrebbero non uscire mai.
    await chiama()
    for (const [tabella, colonna] of [
      ['pratiche_personale', 'creata_il'],
      ['anagrafica_personale', 'cessato_il'],
    ] as const) {
      const limit = clausoleDi(tabella, 'limit')
      expect(limit, `${tabella}: nessun tetto esplicito`).toHaveLength(1)
      expect(Number(limit[0].argomenti[0])).toBeGreaterThan(0)
      const order = clausoleDi(tabella, 'order')
      expect(order, `${tabella}: senza ordine, un lotto tagliato è un lotto arbitrario`).toHaveLength(1)
      expect(order[0].argomenti[0]).toBe(colonna)
      expect(order[0].argomenti[1]).toMatchObject({ ascending: true })
    }
  })

  it('🔴 un lotto al tetto si DICHIARA: «ok» su un lotto tagliato è un mezzo lavoro travestito', async () => {
    const tetto = Number(SORGENTE_ROUTE.match(/TETTO_LOTTO\s*=\s*(\d+)/)![1])
    h.pratiche = Array.from({ length: tetto }, (_v, i) =>
      pratica(`p${i}`, { documento_fronte_path: null, creata_il: giorniFa(120) }),
    )
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, lotto_pieno: true })
    expect(
      eventiDi('warn').some((e) => e.campi.esito === 'lotto-pieno'),
      'il taglio del lotto deve lasciare una traccia leggibile in app_log',
    ).toBe(true)
    expect(battiti()[0].campi).toMatchObject({ lotto_pieno: true })
  })

  it('e un lotto NON pieno lo dice altrettanto chiaramente', async () => {
    h.pratiche = [pratica('p1', { documento_fronte_path: null })]
    const res = await chiama()
    expect(await res.json()).toMatchObject({ lotto_pieno: false })
    expect(eventiDi('warn').some((e) => e.campi.esito === 'lotto-pieno')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/gdpr/retention-personale — il numero dichiarato è quello VERO', () => {
  it('🔴 le scritture chiedono il conteggio esatto, e si dichiara quello, non l’intenzione', async () => {
    h.pratiche = [pratica('p1'), pratica('p2')]
    h.countScrittura = 1 // una era già stata tolta a mano
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(
      await res.json(),
      'due righe nominate, una davvero cancellata: si dichiara una',
    ).toMatchObject({ ok: true, pratiche: 1 })
    expect(battiti()[0].campi).toMatchObject({ n_pratiche: 1, conteggio_verificato: true })
    expect(
      eventiDi('warn').some((e) => e.campi.esito === 'conteggio-discorde'),
      'lo scarto si dichiara: non è un guasto, ma non è nemmeno niente',
    ).toBe(true)
  })

  it('🔴 il conteggio si chiede su TUTTE E TRE le scritture, update compreso', async () => {
    // MISURATO con una mutazione: togliendo `{ count: 'exact' }` dal solo `update`
    // i test restavano verdi, perché il conteggio era provato sulla sola `delete`
    // delle pratiche. Con tre scritture e una sola sorvegliata, il numero
    // dichiarato dalle altre due torna a essere l'INTENZIONE — che è esattamente
    // ciò che questo blocco esiste per impedire.
    h.pratiche = [pratica('p1')]
    h.anagrafiche = [
      anagrafica('u-scansione', { cessato_il: mesiFa(14) }),
      anagrafica('u-fascicolo', { cessato_il: anniFa(11) }),
    ]
    h.countScrittura = 0 // nessuna delle tre righe c'era più
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(
      await res.json(),
      'tre righe nominate, zero davvero toccate: si dichiara zero, su tutte e tre',
    ).toMatchObject({ ok: true, pratiche: 0, anagrafiche: 0, scansioni: 0 })
    expect(battiti()[0].campi).toMatchObject({ conteggio_verificato: true })
    expect(eventiDi('warn').some((e) => e.campi.esito === 'conteggio-discorde')).toBe(true)
  })

  it('… e se PostgREST il conteggio non lo dà, non si finge di averlo misurato', async () => {
    h.pratiche = [pratica('p1')]
    h.countAssente = true
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(battiti()[0].campi).toMatchObject({ n_pratiche: 1, conteggio_verificato: false })
    expect(
      eventiDi('warn').some((e) => e.campi.esito === 'conteggio-discorde'),
      'un conteggio che non c’è non è un conteggio discorde',
    ).toBe(false)
  })

  it('🔴 file rimossi e riga non cancellata è un 500, non un 200 con un numero più basso', async () => {
    h.pratiche = [pratica('p1')]
    h.erroreDeleteP = { code: '42501', message: 'permission denied' }
    const res = await chiama()
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ ok: false, motivo: 'righe-non-cancellate' })
    expect(battiti()[0].campi.esito).toBe('cancellazione-fallita')
  })

  it('🔴 e lo è anche l’UPDATE fallito: il file è uscito e la colonna lo nomina ancora', async () => {
    h.anagrafiche = [anagrafica('u1', { cessato_il: mesiFa(14) })]
    h.erroreUpdate = { code: '42501', message: 'permission denied' }
    const res = await chiama()
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ ok: false, motivo: 'scansioni-non-azzerate' })
    expect(battiti()[0].campi.esito).toBe('scansioni-non-azzerate')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/gdpr/retention-personale — l’autenticazione', () => {
  it('🔴 il segreto SBAGLIATO è loggato come errore', async () => {
    // Un cron che bussa con la chiave sbagliata è il guasto invisibile: non
    // cancella più niente e non lo dice a nessuno.
    const res = await chiama({ 'x-cron-secret': 'chiave-che-non-torna' })
    expect(res.status).toBe(200) // lo staff finto del mock passa: conta il LOG
    const errore = eventiDi('error').find((e) => e.campi.esito === 'secret-errato')
    expect(errore, 'l’header c’è e non torna: va gridato').toBeTruthy()
    expect(errore?.evento).toBe('cron')
  })

  it('senza header è lo staff a rispondere del giro (lancio manuale)', async () => {
    const res = await chiama({})
    expect(res.status).toBe(200)
    expect(
      eventiDi('error').some((e) => e.campi.esito === 'secret-errato'),
      'un header assente non è un header sbagliato',
    ).toBe(false)
    expect(battiti()[0].campi.canale).toBe('manuale')
  })

  it('e se lo staff non passa, non si cancella niente — e il battito lo DICE', async () => {
    h.staffNegato = new Response(JSON.stringify({ error: 'no' }), { status: 403 })
    h.pratiche = [pratica('p1')]
    const res = await chiama({})
    expect(res.status).toBe(403)
    expect(h.sequenza, 'gate prima, lavoro poi').toHaveLength(0)
    // Il 403 lo vede solo chi ha fatto la chiamata. Chi legge `app_log` la notte
    // dopo vede un battito senza cancellazioni: se dicesse `ok` sembrerebbe un
    // giro riuscito a vuoto, che è la cosa che questo file non deve mai produrre.
    expect(battiti()).toHaveLength(1)
    expect(battiti()[0].campi).toMatchObject({ esito: 'non-autorizzato', n_pratiche: 0 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/gdpr/retention-personale — il DB della CI non è migrato', () => {
  it('🔴 tabella assente ⇒ 503 con il codice, MAI un 200 bugiardo', async () => {
    h.lettureP = [{ data: null, error: { code: 'PGRST205', message: 'relation not found' } }]
    const res = await chiama()
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ ok: false, motivo: 'tabella-assente' })
    const riga = h.eventi.find((e) => e.campi.esito === 'tabella-assente')
    expect(riga?.campi.error_code, 'il codice va detto, è ciò che distingue i due guasti').toBe(
      'PGRST205',
    )
  })

  it('🔴 colonna assente ⇒ si ritenta senza, con un warn che la NOMINA', async () => {
    h.lettureP = [
      { data: null, error: { code: '42703', message: 'column pratiche_personale.evasa_il does not exist' } },
      {
        data: [
          pratica('mai-valutata', { creata_il: giorniFa(120), evasa_il: undefined }),
          // Su un database senza `evasa_il` questa riga NON è databile: il suo
          // termine decorre dalla decisione, e la decisione non esiste come
          // colonna. È il caso raggiungibile del difetto — un DB che ha `stato` e
          // non `evasa_il` — e senza questa riga la prova non lo vedrebbe.
          pratica('respinta', { stato: 'rifiutata', creata_il: giorniFa(365), evasa_il: undefined }),
        ],
        error: null,
      },
    ]
    const res = await chiama()
    expect(res.status).toBe(200)
    const selP = h.select.filter((s) => s.tabella === 'pratiche_personale')
    expect(selP.length, 'una lettura, poi la seconda senza la colonna').toBe(2)
    expect(selP[0].colonne).toContain('evasa_il')
    expect(selP[1].colonne, 'la colonna assente esce dalla select').not.toContain('evasa_il')
    const avviso = eventiDi('warn').find((e) => e.campi.esito === 'colonna-assente')
    expect(avviso, 'un ripiego taciuto è un ripiego che nessuno scopre').toBeTruthy()
    expect(String(avviso?.campi.msg)).toContain('evasa_il')
    // Il ripiego NON si allarga oltre il proprio danno: chi decorre dalla ricezione
    // continua a scadere (la ricezione c'è), chi decorre dalla decisione no.
    expect(
      cancellateDa('pratiche_personale'),
      'senza `evasa_il` la respinta è stata cancellata dalla RICEZIONE, che è la data più ' +
        'vecchia: il termine promesso accorciato del tempo di decisione',
    ).toEqual(['mai-valutata'])
    // E il messaggio del ripiego dice ciò che il codice fa davvero. Fino
    // all'11/08/2026 dichiarava l'opposto («non si anticipa nessuna
    // cancellazione») mentre la anticipava: un log che promette una garanzia
    // inesistente è peggio di nessun log, perché viene creduto.
    expect(String(avviso?.campi.msg)).toMatch(/RESPINTE non si cancellano/)
    expect(battiti()[0].campi.n_pratiche_senza_riferimento).toBe(1)
  })

  it('🔴 senza il percorso del documento NON si tocca NIENTE: righe tolte e scansioni lasciate è il caso peggiore', async () => {
    // Il difetto vero, non ipotetico: senza `documento_fronte_path` la seconda
    // `select` la esclude, i percorsi restano zero, nessuna `remove()` parte — e
    // senza il blocco le righe si cancellerebbero lo stesso. Le scansioni
    // resterebbero nel bucket senza più nessuna riga che le nomini: invisibili,
    // non cancellate.
    h.lettureP = [
      { data: null, error: { code: '42703', message: 'column pratiche_personale.documento_fronte_path does not exist' } },
      { data: [pratica('p1', { creata_il: giorniFa(200), documento_fronte_path: undefined })], error: null },
    ]
    h.anagrafiche = [anagrafica('u1', { cessato_il: anniFa(11) })]
    const res = await chiama()
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({
      ok: false,
      motivo: 'documento-ignoto',
      pratiche: 0,
      anagrafiche: 0,
      scansioni: 0,
    })
    expect(soloDi('delete'), 'non si sa quali file la riga nomini: la riga non si tocca').toHaveLength(0)
    expect(soloDi('update')).toHaveLength(0)
    expect(soloDi('remove')).toHaveLength(0)
    expect(battiti()[0].campi).toMatchObject({
      esito: 'documento-ignoto',
      documento_ignoto: true,
    })
  })

  it('🔴 … e vale anche quando a perdere la colonna è l’ANAGRAFICA, non la pratica', async () => {
    // Le due tabelle si degradano separatamente, ma la conseguenza è una sola: se
    // di UNA delle due non si sa quali file nomini, non si tocca NESSUNA delle due.
    // Le pratiche resterebbero cancellabili, ma il verso conservativo si sceglie
    // per intero: un giro a metà è più difficile da leggere di un giro non fatto.
    h.pratiche = [pratica('p1', { creata_il: giorniFa(200) })]
    h.lettureA = [
      { data: null, error: { code: 'PGRST204', message: 'column anagrafica_personale.documento_fronte_path does not exist' } },
      { data: [], error: null },
    ]
    const res = await chiama()
    expect(res.status).toBe(503)
    expect(soloDi('delete')).toHaveLength(0)
    expect(soloDi('remove')).toHaveLength(0)
  })

  it('🔴 e un `42703` che non NOMINA nessuna colonna nota cade dalla stessa parte', async () => {
    // Il ripiego rinuncia a TUTTE le colonne facoltative quando non riconosce
    // nessun nome: quindi qualunque errore di colonna illeggibile arriva qui — e
    // qui non si cancella.
    h.lettureP = [
      { data: null, error: { code: 'PGRST204', message: 'schema cache: something entirely unknown' } },
      { data: [pratica('p1', { creata_il: giorniFa(200) })], error: null },
    ]
    const res = await chiama()
    expect(res.status).toBe(503)
    expect(soloDi('delete')).toHaveLength(0)
  })

  it('🔴 senza `cessato_il` la lettura NON viene ritentata: il ripiego dev’essere RAGGIUNGIBILE', async () => {
    // IL DIFETTO CHE QUESTA PROVA CHIUDE, e che la sua versione precedente
    // NASCONDEVA (rilievo del revisore, 2026-08-11).
    //
    // `cessato_il` non è solo una colonna della `select`: è anche il `.lt()` e
    // l'`.order()` della query. Un ripiego che la toglie dalla sola lista delle
    // colonne lette e ritenta prende **lo stesso `42703`** sul filtro, e la route
    // esce 500 `lettura-fallita` — mentre il `warn` racconta una degradazione
    // pulita e il battito scrive `cessazione_ignota: true`. La prova che copriva
    // quel ramo era verde soltanto perché la fixture faceva RIUSCIRE la seconda
    // lettura: un database senza quella colonna non lo fa mai. Verde a vuoto.
    //
    // Perciò qui la seconda risposta in coda è quella VERA — un altro `42703` — e
    // il conto delle `select` è l'asserzione che vale: se qualcuno rimette il
    // ritento, quella risposta viene consumata e questa prova diventa rossa con
    // il 500 in mano.
    h.lettureA = [
      { data: null, error: { code: '42703', message: 'column anagrafica_personale.cessato_il does not exist' } },
      { data: null, error: { code: '42703', message: 'column anagrafica_personale.cessato_il does not exist' } },
    ]
    h.pratiche = []
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(
      h.select.filter((s) => s.tabella === 'anagrafica_personale'),
      'la lettura delle anagrafiche è stata ritentata: senza `cessato_il` il filtro e ' +
        'l’ordinamento rialzano lo stesso 42703, e il giro esce 500 invece di degradare',
    ).toHaveLength(1)
    // «Non so chi abbia cessato» non è «hanno cessato tutti»: il verso che conserva
    // è l'unico ammesso, e si scrive nel battito perché qualcuno lo veda.
    expect(soloDi('update')).toHaveLength(0)
    expect(soloDi('delete')).toHaveLength(0)
    expect(soloDi('remove')).toHaveLength(0)
    expect(battiti()[0].campi).toMatchObject({
      cessazione_ignota: true,
      n_anagrafiche: 0,
      n_scansioni: 0,
      // `lotto_pieno` resta falso: non si legge nessuna riga, quindi non si finge
      // nemmeno un lotto da riprendere la notte dopo.
      lotto_pieno: false,
    })
  })

  it('…e con la sola `documento_fronte_path` assente il ritento c’è, perché il filtro regge', async () => {
    // Il verso opposto, che dimostra che la prova qui sopra misura la RAGIONE
    // giusta e non «non si ritenta mai»: se a mancare è il percorso del documento,
    // il `.lt('cessato_il')` è ancora valido e la seconda lettura ha senso. (Il giro
    // esce comunque 503 per la regola «percorso ignoto ⇒ non si tocca niente»: qui
    // si misura che la seconda lettura sia PARTITA.)
    h.lettureA = [
      { data: null, error: { code: 'PGRST204', message: 'column anagrafica_personale.documento_fronte_path does not exist' } },
      { data: [], error: null },
    ]
    const res = await chiama()
    expect(res.status).toBe(503)
    expect(h.select.filter((s) => s.tabella === 'anagrafica_personale')).toHaveLength(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/gdpr/retention-personale — cosa NON finisce nei log', () => {
  it('🔴 il percorso della scansione non compare in nessun log', async () => {
    // L'oggetto è la fotografia di una carta d'identità: il suo percorso in
    // `app_log` — 30 giorni, interrogabile in SQL — sarebbe l'indirizzo di un
    // documento d'identità dentro una tabella di diagnosi.
    h.pratiche = [pratica('p1'), pratica('p2')]
    h.anagrafiche = [anagrafica('u1', { cessato_il: mesiFa(14) })]
    h.removeRisposta = { data: [], error: null }
    h.ancoraNelBucket = new Set(['pratiche/p1/documento-rossi.jpg'])
    await chiama()
    const tutto = JSON.stringify(h.eventi)
    for (const proibito of ['documento-rossi', '.jpg', 'pratiche/p1', 'personale/u1']) {
      expect(tutto.includes(proibito), `«${proibito}» non deve stare in un log`).toBe(false)
    }
    expect(h.eventi.length, 'e comunque i log ci sono: conteggi, non percorsi').toBeGreaterThan(0)
  })
})

// =============================================================================
// LOCK · IL TERMINE PROMESSO E IL TERMINE APPLICATO SONO LO STESSO NUMERO
// =============================================================================

/**
 * In un testo legale il numero si scrive in lettere: si accetta la cifra o la
 * parola, perché è la COERENZA a essere sorvegliata, non la tipografia.
 */
const IN_LETTERE: Record<number, string> = {
  7: 'sette', 10: 'dieci', 12: 'dodici', 24: 'ventiquattro', 30: 'trenta',
  60: 'sessanta', 90: 'novanta', 120: 'centoventi',
}

/** La sezione «Conservazione dei dati» DELIMITATA: dal titolo al suo `</section>`. */
const SEZIONE_CONSERVAZIONE = (() => {
  const dal = INFORMATIVA.indexOf('Conservazione dei dati')
  const al = INFORMATIVA.indexOf('</section>', dal)
  return INFORMATIVA.slice(dal, al === -1 ? undefined : al)
})()

/** Le voci dell'elenco, a spazi normalizzati: in JSX il testo va a capo dove capita. */
const VOCI = SEZIONE_CONSERVAZIONE.split('<li>')
  .slice(1)
  .map((v) => v.split('</li>')[0].replace(/\s+/g, ' ').trim())

/** L'informativa dichiara `n` (in cifre o in lettere) seguito da `unita`? */
function dichiara(testo: string, n: number, unita: string): boolean {
  const parola = IN_LETTERE[n]
  return (
    new RegExp(`${n}\\s*${unita}`, 'i').test(testo) ||
    (parola !== undefined && new RegExp(`${parola}\\s*${unita}`, 'i').test(testo))
  )
}

/**
 * LE `version` CHE IL DATABASE DICHIARA APPLICATE — non la prosa delle testate.
 *
 * Stessa fonte di `cron-sorvegliato-e-applicato.test.ts` e di
 * `migrazioni-complete.test.ts`: la fotografia di
 * `supabase_migrations.schema_migrations`, che si rigenera a ogni `apply_migration`.
 *
 * ⚠️ E LA PROSA DA SOLA NON BASTEREBBE, misurato l'11/08/2026 proprio su questa
 * consegna: il rilevatore usato altrove è `/NON\s+APPLICATA/i`, e la testata di
 * `20260811234403_scadenze_documenti_cron.sql` diceva «NON ANCORA APPLICATA». Due
 * parole in mezzo, e la migrazione risultava applicata a chiunque cercasse quel
 * marcatore. La fotografia non si aggira scrivendo.
 */
const APPLICATE: ReadonlySet<string> = new Set(
  (
    JSON.parse(
      readFileSync(
        join(process.cwd(), '__tests__/fixtures/migrazioni-applicate-snapshot.json'),
        'utf8',
      ),
    ) as { migrazioni: { version: string }[] }
  ).migrazioni.map((m) => m.version),
)

/** Le migrazioni che installano `cron.schedule('<job>', …)`, con la loro `version`. */
function installazioniDi(job: string) {
  const dir = join(process.cwd(), 'supabase', 'migrations')
  const re = new RegExp(`cron\\.schedule\\s*\\(\\s*'${job}'`, 'i')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, version: file.slice(0, 14), sql: readFileSync(join(dir, file), 'utf8') }))
    .filter(({ sql }) => re.test(sql))
}

/**
 * La testata dice «NON APPLICATA» e nessuno ha ancora attestato il contrario con
 * una riga «APPLICATA il AAAA-MM-GG». Stessa forma di
 * `informativa-conservazione-dichiarata`: si legge INSIEME alla fotografia, mai al
 * suo posto — le due fonti mentono in versi opposti, e il verso che conta qui è
 * «il repo crede applicato ciò che il database non ha».
 */
function soloSuCarta(sql: string): boolean {
  return (
    /NON\s+(?:ANCORA\s+)?APPLICATA/i.test(sql) &&
    !/(?<!NON\s{1,4})APPLICATA\s+(?:in\s+produzione\s+)?il\s+\d{4}-\d{2}-\d{2}/i.test(sql)
  )
}

const TRE_VOCI: {
  quale: RegExp
  etichetta: string
  valore: number
  unita: string
  ancheDetto: RegExp
  perche: string
}[] = [
  {
    quale: /dati anagrafici del personale/i,
    etichetta: 'fascicolo anagrafico del personale',
    valore: PERSONALE_LIMITI.anniFascicoloDopoCessazione,
    unita: 'anni',
    ancheDetto: /cessazione/i,
    perche:
      'un termine senza decorrenza non è un termine dichiarato: dieci anni DA QUANDO (art. 13 §2 lett. a)',
  },
  {
    quale: /copia del documento d.{0,8}identità del personale/i,
    etichetta: 'copia del documento d’identità del personale',
    valore: PERSONALE_LIMITI.mesiDocumentoDopoCessazione,
    unita: 'mesi',
    // ⚠️ ERA `/sostituit/i`, ed è stato cambiato l'11/08/2026 su rilievo del
    // revisore: quella forma INCHIODAVA nell'informativa una promessa che il repo
    // non manteneva («la copia viene sostituita, con cancellazione della
    // precedente»), cioè faceva il contrario del lavoro di un lock — teneva ferma
    // una dichiarazione falsa con una prova verde. La condizione buona è la
    // DECORRENZA, come per il fascicolo: dodici mesi DA QUANDO.
    ancheDetto: /cessazione/i,
    perche:
      'un termine senza decorrenza non è un termine dichiarato: dodici mesi DA QUANDO. Cessato il ' +
      'rapporto la finalità di identificazione è esaurita, ed è ciò che rende quel numero una regola',
  },
  {
    quale: /richieste di anagrafica del personale non approvate/i,
    etichetta: 'richieste di anagrafica non approvate',
    valore: PERSONALE_LIMITI.giorniPraticaNonApprovata,
    unita: 'giorni',
    ancheDetto: /documento/i,
    perche:
      'la copia del documento allegata se ne va con la richiesta: se l’informativa non lo dice, ' +
      'promette la cancellazione di un modulo e non di una fotografia di carta d’identità',
  },
]

describe('lock · il termine promesso e il termine applicato sono LO STESSO numero', () => {
  it('🔴 i tre termini del codice sono `PERSONALE_LIMITI`, IMPORTATI e non ribattuti', () => {
    // Due costanti indipendenti per lo stesso termine divergono in silenzio, e a
    // divergere sarebbe il termine dichiarato alla persona (art. 13 §2 lett. a).
    const attese: [RegExp, string][] = [
      [/GIORNI_PRATICA\s*=\s*PERSONALE_LIMITI\.giorniPraticaNonApprovata/, 'giorniPraticaNonApprovata'],
      [/MESI_DOCUMENTO\s*=\s*PERSONALE_LIMITI\.mesiDocumentoDopoCessazione/, 'mesiDocumentoDopoCessazione'],
      [/ANNI_FASCICOLO\s*=\s*PERSONALE_LIMITI\.anniFascicoloDopoCessazione/, 'anniFascicoloDopoCessazione'],
    ]
    for (const [forma, nome] of attese) {
      expect(
        forma.test(SORGENTE_ROUTE),
        `la route ribatte un numero invece di importare \`PERSONALE_LIMITI.${nome}\` da ` +
          '`personale-template`: il giorno in cui il titolare cambia termine, il modulo prometterà ' +
          'una cosa e il cron ne applicherà un’altra, in silenzio',
      ).toBe(true)
    }
  })

  it('e il TESTO del consenso promette esattamente quei due numeri', () => {
    const consenso = CONSENSI_PERSONALE_FIELDS.find((f) => f.id === 'presa_visione_copia_documento')
    expect(consenso, 'il blocco sulla copia del documento non esiste più nel modulo').toBeTruthy()
    expect(
      consenso!.required,
      'la presa visione sulla copia del documento è obbligatoria: è l’art. 13, non un consenso',
    ).toBe(true)
    expect(consenso!.text).toContain(`${PERSONALE_LIMITI.mesiDocumentoDopoCessazione} mesi`)
    expect(consenso!.text).toContain(`${PERSONALE_LIMITI.giorniPraticaNonApprovata} giorni`)
  })

  it('la sezione «Conservazione dei dati» si legge, e ha le sue voci (sanity)', () => {
    // Se il titolo o la forma dell'elenco cambiano, le prove qui sotto girerebbero
    // sul vuoto e direbbero «verde» senza aver guardato niente.
    expect(
      VOCI.length,
      'nessun `<li>` fra «Conservazione dei dati» e il suo `</section>`: la sezione è stata ' +
        'spostata o riscritta, e questo lock non sta più leggendo l’informativa',
    ).toBeGreaterThanOrEqual(9)
  })

  it.each(TRE_VOCI)(
    '🔴 l’informativa dichiara «$etichetta» con lo stesso numero di `PERSONALE_LIMITI`',
    ({ quale, etichetta, valore, unita, ancheDetto, perche }) => {
      const voce = VOCI.find((v) => quale.test(v))
      expect(
        voce,
        `la sezione «Conservazione dei dati» non ha nessuna voce per «${etichetta}» — mentre il ` +
          `codice la fa scadere. Una categoria di dati che il documento non nomina è l'art. 13 non ` +
          `adempiuto verso la persona che quei dati li ha consegnati.`,
      ).toBeTruthy()
      const parola = IN_LETTERE[valore]
      expect(
        dichiara(voce!, valore, unita),
        `il codice cancella «${etichetta}» dopo ${valore} ${unita} e l'informativa non dichiara ` +
          `quel termine. Se il numero è cambiato in \`PERSONALE_LIMITI\`, va cambiato ANCHE qui: è ` +
          `la dichiarazione su cui l'interessata ha preso visione, non una nota interna.` +
          (parola === undefined
            ? ` (Nessuna forma in lettere nota per ${valore}: aggiungila alla mappa di questo lock.)`
            : ''),
      ).toBe(true)
      // Contare un numero non basta: resterebbe verde su QUALUNQUE regola quel
      // numero descrivesse. È il difetto che il gemello ha pagato il 2026-08-10,
      // restando verde mentre la route applicava un termine diverso da quello
      // dichiarato. La seconda condizione nomina ciò che quel numero significa.
      expect(ancheDetto.test(voce!), `${etichetta}: ${perche}`).toBe(true)
    },
  )

  it('🔴 la voce dice anche cosa succede alla richiesta APPROVATA, e il codice lo fa davvero', () => {
    // IL DIFETTO CHE QUESTA PROVA CHIUDE (rilievo del revisore, 2026-08-11).
    //
    // La voce prometteva già che la richiesta accolta «segue i termini indicati ai
    // due punti precedenti», e nessuno li applicava: la route leggeva i soli stati
    // non approvati, e in tutto `src/` non c'era un'altra `.delete()` su
    // `pratiche_personale`. Una richiesta approvata restava in tabella per sempre.
    //
    // Le due direzioni si sorvegliano INSIEME, perché il difetto può tornare da
    // entrambe: un'informativa che promette un termine che il codice non applica, e
    // un codice che cancella un dato di cui l'informativa non parla. La seconda non
    // è più mite della prima — è la cancellazione di un dato senza che l'interessata
    // sappia quando avviene.
    const voce = VOCI.find((v) => /richieste di anagrafica del personale non approvate/i.test(v))
    expect(voce, 'la voce sulle richieste di anagrafica non si trova più nell’informativa').toBeTruthy()

    const dichiaraLApprovata =
      /approvat/i.test(voce!) &&
      dichiara(voce!, PERSONALE_LIMITI.anniFascicoloDopoCessazione, 'anni')
    // Il codice: legge il legame col fascicolo, e su quello cancella.
    const applicaLApprovata =
      /origine_pratica_id/.test(SORGENTE_ROUTE) &&
      /idPraticheFascicolo/.test(SORGENTE_ROUTE) &&
      /fascicoloChiudibili\.map\(\(r\) => r\.chiave\)/.test(SORGENTE_ROUTE)

    expect(
      applicaLApprovata,
      dichiaraLApprovata
        ? 'L’informativa dichiara che la richiesta APPROVATA è cancellata insieme al fascicolo, e ' +
            'la route non la tocca: `origine_pratica_id` non viene letto, o nessuna `.delete()` su ' +
            '`pratiche_personale` è guidata da quel legame. È un termine promesso a una persona e ' +
            'applicato da nessuno (art. 13 §2 lett. a) — su una riga che contiene codice fiscale, ' +
            'nascita, residenza, domicilio, recapiti, estremi del documento e la prova di presa ' +
            'visione.'
        : 'La route cancella la pratica approvata insieme al fascicolo e l’informativa non lo dice ' +
            'più: chi ha compilato quel modulo non sa quando la sua richiesta sparisce. Rimetti la ' +
            'frase nella voce, o togli il meccanismo — non si cancella un dato di nascosto.',
    ).toBe(dichiaraLApprovata)

    expect(
      dichiaraLApprovata,
      'la voce non nomina più la richiesta APPROVATA con il termine del fascicolo ' +
        `(${PERSONALE_LIMITI.anniFascicoloDopoCessazione} anni): un rimando ai «due punti ` +
        'precedenti» non è un termine dichiarato se il numero non c’è, ed è il più lungo di tutti.',
    ).toBe(true)
  })

  it('🔴 chi approva una pratica scrive `origine_pratica_id`, e RILASCIA le due facce', () => {
    // IL DIFETTO CHE QUESTA PROVA IMPEDISCE, ed è nel futuro: la route di
    // approvazione della Segreteria non esiste ancora — MISURATO l'11/08/2026: in
    // tutto `src/` non c'è una riga che scriva `anagrafica_personale`. Il giorno in
    // cui verrà scritta, se dimenticherà `origine_pratica_id`, ogni fascicolo
    // nascerà senza il puntatore al modulo che l'ha generato: `retention-personale`
    // chiuderà l'anagrafica a dieci anni e lascerà la pratica approvata in tabella,
    // orfana e invisibile, con dentro codice fiscale, nascita, residenza, domicilio,
    // recapiti, estremi del documento e `consents_log`.
    //
    // ⚠️ IL RIPIEGO NON È CANCELLARE GLI ORFANI. Su un database in cui il legame non
    // è stato scritto, «cancella tutte le approvate che nessuno cita» porterebbe via
    // il modulo d'origine di persone ANCORA IN SERVIZIO. La regola è a monte: il
    // legame si scrive quando nasce il fascicolo, e questa prova lo pretende.
    //
    // ─── E LA SECONDA PRETESA, SIMMETRICA, SUL TERMINE PIÙ CORTO ───────────────
    //
    // (rilievo del revisore, 2026-08-11.) La prima metà di questo lock guarda il
    // termine PIÙ LUNGO: i dieci anni del fascicolo. Il contratto della migrazione
    // `20260811205643` ne dichiara un altro, sul termine più CORTO, e nessuna prova
    // lo pretendeva — commento di colonna di quella che allora era `pratiche_personale.documento_path`:
    // «All'approvazione l'oggetto NON si copia: l'anagrafica punta allo stesso file
    // e questa colonna torna NULL. Un oggetto, un proprietario».
    //
    // Se la futura route di approvazione lascerà una copia del percorso sulla
    // pratica, quella riga la porterà con sé per DIECI ANNI — la Fase 3 della route
    // rilegge i percorsi della pratica d'origine solo al decimo anno — mentre
    // `/privacy` promette DODICI MESI per «la copia del documento d'identità del
    // personale». Cioè si sforerebbe proprio il termine con la base giuridica più
    // fragile: nessuna norma impone al datore di custodire una fotocopia, impone di
    // identificare. E lo si scoprirebbe fra anni, perché il giro notturno
    // continuerebbe a rispondere `ok`.
    //
    // È lo stesso ragionamento con cui la Fase 3 della route è stata costruita —
    // «cancellare fidandosi di un contratto è il modo in cui una fotografia di carta
    // d'identità resta nel bucket» — applicato al termine che scade per primo.
    const scrittori = fileDiSrc().filter((f) => {
      const s = readFileSync(f, 'utf8')
      return (
        /from\(\s*'anagrafica_personale'\s*\)/.test(s) &&
        /\.(insert|upsert)\s*\(/.test(s)
      )
    })
    if (scrittori.length === 0) {
      // Vuoto oggi, e lo si DICHIARA invece di lasciar credere che la prova abbia
      // guardato qualcosa: la route di approvazione non è ancora stata scritta.
      expect(
        /route di approvazione della Segreteria non è ancora stata scritta/.test(SORGENTE_ROUTE),
        'nessun file di `src/` crea un’anagrafica del personale, e la testata della route non lo ' +
          'dichiara più: o è stata scritta l’approvazione (e allora questa prova deve trovarla), o ' +
          'la nota è stata cancellata e il perimetro non è più scritto da nessuna parte.',
      ).toBe(true)
      return
    }
    for (const f of scrittori) {
      const sorgente = readFileSync(f, 'utf8')
      const nome = f.replace(process.cwd() + '/', '')
      expect(
        /origine_pratica_id/.test(sorgente),
        `${nome} crea un’anagrafica del personale e non scrive ` +
          '`origine_pratica_id`. Il fascicolo nascerà senza il puntatore al modulo che l’ha ' +
          'generato, e `retention-personale` a dieci anni chiuderà l’anagrafica lasciando la ' +
          'pratica approvata in tabella, orfana e irraggiungibile: nessun giro successivo saprà ' +
          'più che esiste.',
      ).toBe(true)
      // ⚠️ DUE COLONNE, DUE RILASCI. Dal 12/08/2026 le facce sono due
      // (`20260812194501`): rilasciare il solo fronte lascerebbe sulla pratica il
      // percorso del RETRO, e quella riga se lo porterebbe per dieci anni — cioè
      // esattamente il difetto che questo lock esiste per impedire, dimezzato e
      // perciò più difficile da vedere.
      for (const colonna of ['documento_fronte_path', 'documento_retro_path']) {
        expect(
          new RegExp(`${colonna}\\s*:\\s*null`).test(sorgente),
          `${nome} crea un’anagrafica del personale e non rilascia ` +
            `\`pratiche_personale.${colonna}\` (nessun \`${colonna}: null\`). Il contratto della ` +
            'migrazione `20260811205643`, esteso alle due facce da `20260812194501`, dice «un ' +
            'oggetto, un proprietario»: all’approvazione la scansione passa all’anagrafica e la ' +
            'colonna della pratica torna NULL. Lasciandovi una copia del percorso, quella pratica ' +
            'se la porta per DIECI ANNI — è la Fase 3 di `retention-personale`, che la rilegge solo ' +
            'al decimo anno — mentre /privacy promette DODICI MESI per la copia del documento ' +
            'd’identità: si sfora proprio il termine con la base giuridica più fragile, e nessuna ' +
            'norma impone al datore di custodire una fotocopia. Le due strade, e nessuna terza: ' +
            `(a) azzerare \`${colonna}\` sulla pratica nello stesso giro in cui nasce il fascicolo; ` +
            '(b) se davvero si vuole che la pratica conservi una copia sua, dichiararlo in /privacy ' +
            'con il suo termine e insegnarlo a `retention-personale`, che oggi non lo sa.',
        ).toBe(true)
      }
    }
  })

  it('🔴 e non promette la SOSTITUZIONE della copia finché nessuno la esegue', () => {
    // IL DIFETTO CHE QUESTA PROVA CHIUDE (rilievo del revisore, 2026-08-11), ed è
    // lo stesso della regola qui sotto sull'«automaticamente», applicato a un
    // verbo che quella regola non intercetta.
    //
    // Fino a stamattina l'informativa E il testo del consenso dicevano che la
    // copia del documento «viene sostituita, con cancellazione della precedente,
    // appena l'interessata ne consegna una nuova». MISURATO: in tutto `src/` non
    // esiste una riga che scriva le colonne del documento di `anagrafica_personale` (l'unica
    // scrittura su quella colonna è l'azzeramento della route di conservazione),
    // né una `remove()` sul bucket `documenti_personale` fuori da quel job.
    // Peggio: il lock stesso PRETENDEVA quella frase (`ancheDetto: /sostituit/i`),
    // cioè teneva ferma con una prova verde una dichiarazione che il repo non
    // manteneva.
    //
    // Il giorno in cui la route di approvazione sovrascriverà una delle due colonne
    // del documento con la seconda scansione di una persona, il file precedente
    // resterà nel bucket senza più nessuna riga che lo nomini — e questo job, che
    // legge proprio quelle colonne, non lo troverà MAI: invisibile, non cancellato.
    //
    // La regola è quella di `informativa-conservazione-dichiarata`: il TERMINE si
    // può promettere, il MECCANISMO no — finché non c'è chi lo esegue. Chi scriverà
    // la sostituzione rimetta pure la frase: questa prova diventa verde da sé.
    const promessa = /sostituit\w*[^.;]{0,80}cancellazione della precedente/i
    const consenso = CONSENSI_PERSONALE_FIELDS.find(
      (f) => f.id === 'presa_visione_copia_documento',
    )
    const dichiarano = [
      ...(promessa.test(INFORMATIVA_TESTO) ? ['src/app/privacy/page.tsx'] : []),
      ...(promessa.test(consenso?.text ?? '')
        ? ['src/lib/forms/personale-template.ts (il testo finisce in `consents_log`!)']
        : []),
    ]
    if (dichiarano.length === 0) return

    expect(
      SOSTITUZIONE_ESEGUITA_DA.length,
      `${dichiarano.join(' e ')} promette che la copia del documento «viene sostituita, con ` +
        `cancellazione della precedente» — e \`SOSTITUZIONE_ESEGUITA_DA\`, in questo file, è vuoto: ` +
        `nessuno ha dichiarato chi la esegue. Ogni sostituzione lascerebbe una fotografia di carta ` +
        `d'identità nel bucket \`documenti_personale\` che nessuna riga nomina più — invisibile, ` +
        `non cancellata, e per sempre, perché \`retention-personale\` legge i due percorsi e ` +
        `quello punta ormai al file NUOVO. Le due strade: (a) scrivere il meccanismo (rimuovere il ` +
        `percorso precedente PRIMA di sovrascriverlo, all'approvazione o all'aggiornamento) e ` +
        `dichiararlo qui con la sua prova; (b) togliere la frase da entrambi i documenti. Il ` +
        `TERMINE resta dichiarato e resta sorvegliato in ogni caso: è il MECCANISMO a non potersi ` +
        `promettere prima di esistere.`,
    ).toBeGreaterThan(0)

    // Una dichiarazione che non si verifica è una frase, non una prova: lo stesso
    // motivo per cui `REGISTRO_BUCKET_OBLIO` distingue «coperto» da «dichiarato».
    for (const { file } of SOSTITUZIONE_ESEGUITA_DA) {
      const sorgente = readFileSync(join(process.cwd(), file), 'utf8')
      expect(
        /documenti_personale|BUCKET_DOCUMENTI_PERSONALE/.test(sorgente) &&
          /rimuoviEVerifica\s*\(|\.remove\s*\(/.test(sorgente),
        `\`${file}\` è dichiarato come esecutore della sostituzione e non toglie niente dal ` +
          `bucket delle scansioni. Dichiararlo non lo rende vero.`,
      ).toBe(true)
    }
  })

  it('🔴 e non promette un AUTOMATISMO che non è ancora stato applicato al database', () => {
    // La regola di `informativa-conservazione-dichiarata`: il termine si può
    // promettere, la macchina no — finché non c'è. Qui la migrazione che installa
    // il cron è scritta ma non applicata, quindi le tre voci NON dicono
    // «automaticamente». Il giorno in cui verrà applicata e attestata, si potrà
    // aggiungere la parola: questa prova diventa il suo prezzo.
    const promessa =
      /(?:cancellat|eliminat|anonimizzat|rimoss)\w*\s+automaticamente|automaticamente\s+(?:cancellat|eliminat|anonimizzat|rimoss)\w*/i
    const conParola = TRE_VOCI.map(({ quale }) => VOCI.find((v) => quale.test(v)))
      .filter((v): v is string => v !== undefined)
      .filter((v) => promessa.test(v))
    if (conParola.length === 0) return

    const nome = SORGENTE_ROUTE.match(/const JOB = '([^']+)'/)![1]
    const dir = join(process.cwd(), 'supabase', 'migrations')
    const installa = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .filter((f) => new RegExp(`cron\\.schedule\\(\\s*'${nome}'`).test(readFileSync(join(dir, f), 'utf8')))
    for (const f of installa) {
      const sql = readFileSync(join(dir, f), 'utf8')
      expect(
        /NON\s+APPLICATA/i.test(sql) &&
          !/(?<!NON\s{1,4})APPLICATA\s+(?:in\s+produzione\s+)?il\s+\d{4}-\d{2}-\d{2}/i.test(sql),
        `L'informativa promette che «${conParola[0].slice(0, 60)}…» è cancellato AUTOMATICAMENTE, e ` +
          `il lavoro \`${nome}\` che dovrebbe farlo vive soltanto in ${f}, marcato «NON APPLICATA». ` +
          `Un file SQL non cancella niente: applicala e attestalo in testata con «APPLICATA il ` +
          `AAAA-MM-GG», oppure togli la parola — il termine resta dichiarato e resta sorvegliato.`,
      ).toBe(false)
    }
  })

  it('🔴 l’AUTOMA esiste nel repo: `cron.schedule` in una migrazione, GIORNALIERO', () => {
    // IL DIFETTO CHE QUESTO TEST CHIUDE è quello che rendeva tutto il resto una
    // scenografia: sul gemello, fino al 2026-08-10, la voce in `JOB_CRON` e la
    // voce nell'informativa esistevano e il `cron.schedule` no. Nessuno chiamava
    // quella route: era codice morto, mentre /privacy dichiarava pubblicamente un
    // termine che nessuno applicava.
    const nome = SORGENTE_ROUTE.match(/const JOB = '([^']+)'/)![1]
    const dir = join(process.cwd(), 'supabase', 'migrations')
    const forma = new RegExp(`cron\\.schedule\\(\\s*'${nome}'\\s*,\\s*'([^']+)'`)
    const trovate = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => ({ f, m: readFileSync(join(dir, f), 'utf8').match(forma) }))
      .filter((x) => x.m)
    expect(
      trovate.length,
      `In supabase/migrations/ non c'è nessun \`cron.schedule('${nome}', …)\`. Questa route non la ` +
        `chiama nessuno: è codice morto, mentre /privacy dichiara tre termini di conservazione e ` +
        `\`JOB_CRON\` fa dire a /api/health «job senza battito: ${nome}» per sempre, dal primo ` +
        `deploy. Le due strade, e nessuna terza: (a) scrivere e APPLICARE la migrazione; ` +
        `(b) togliere INSIEME la voce da JOB_CRON e le tre voci dall'informativa.`,
    ).toBeGreaterThan(0)
    for (const { f, m } of trovate) {
      const giorno = m![1].split(/\s+/)[2]
      expect(
        giorno,
        `\`${nome}\` è schedulato «${m![1]}» in ${f}, e non è giornaliero. Un lavoro MENSILE non è ` +
          `sorvegliabile da \`JOB_CRON\`: \`app_log\` conserva 30 giorni e la finestra necessaria ` +
          `ne vorrebbe ~32 — è la ragione per cui \`iscrizioni-retention\` sta in ` +
          `\`JOB_CRON_NON_SORVEGLIATI\` invece che in \`JOB_CRON\`.`,
      ).toBe('*')
    }
  })

  it('🔴 la voce in `JOB_CRON` e la migrazione APPLICATA viaggiano INSIEME', async () => {
    // IL DIFETTO CHE QUESTA PROVA CHIUDE (rilievo del revisore, 2026-08-11) è
    // quello che la testata della migrazione descrive in un riquadro d'avviso e
    // che nessun lock intercettava: `controlloBattitoCron` considera muto anche il
    // job che non ha MAI battuto (`t === undefined`), quindi un nome in `JOB_CRON`
    // senza il suo `cron.schedule` nel database manda `/api/health` in
    // `degradato` DAL PRIMO DEPLOY e per sempre.
    //
    // MISURATO il 2026-08-11 su `cron.job` in produzione: `candidature-retention`
    // c'è («5 5 * * *», attivo), `retention-personale` NO. La voce in `JOB_CRON`
    // c'era già.
    //
    // Perché conta più di un semaforo storto: un allarme che suona da solo viene
    // spento, e quando il lavoro smetterà davvero di girare — cioè quando le
    // scansioni dei documenti d'identità smetteranno di scadere — nessuno se ne
    // accorgerà, perché il rosso era rosso da settimane. È esattamente ciò che ha
    // pagato il gemello `candidature-retention` il 2026-08-10.
    //
    // Il lock dell'informativa non lo prende: quello guarda solo le voci che
    // dicono «automaticamente», e le tre del personale — giustamente — non lo
    // dicono. Perciò la coppia si tiene qui.
    const { JOB_CRON } = await import('@/lib/health/controlli')
    const nome = SORGENTE_ROUTE.match(/const JOB = '([^']+)'/)![1]
    if (!JOB_CRON.some((j) => j.nome === nome)) return

    const dir = join(process.cwd(), 'supabase', 'migrations')
    const installa = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .filter((f) => new RegExp(`cron\\.schedule\\(\\s*'${nome}'`).test(readFileSync(join(dir, f), 'utf8')))
    for (const f of installa) {
      const sql = readFileSync(join(dir, f), 'utf8')
      expect(
        /NON\s+APPLICATA/i.test(sql),
        `\`${nome}\` è sorvegliato da \`JOB_CRON\` (src/lib/health/controlli.ts) e la migrazione ` +
          `che lo installa — ${f} — è ancora marcata «NON APPLICATA». Al merge \`/api/health\` ` +
          `risponde \`degradato\` con «job senza battito: ${nome}» dal primo secondo e per sempre, ` +
          `su un lavoro che non esiste ancora: un allarme che suona da solo viene spento, e allora ` +
          `non protegge più niente. Le due strade, e nessuna terza: (a) APPLICARE la migrazione ` +
          `nello stesso rilascio (\`apply_migration\` + \`get_advisors\` a 0 ERROR) e attestarlo in ` +
          `testata con «APPLICATA il AAAA-MM-GG»; (b) togliere il nome da \`JOB_CRON\` e metterlo in ` +
          `\`JOB_CRON_NON_SORVEGLIATI\` con la ragione, finché non lo si applica. I TERMINI ` +
          `dichiarati in /privacy restano dove sono in entrambi i casi: è il meccanismo a non ` +
          `potersi sorvegliare prima di esistere.`,
      ).toBe(false)
      expect(
        /APPLICATA il \d{4}-\d{2}-\d{2}/.test(sql),
        `${f} installa \`${nome}\` e non attesta in testata quando è stata applicata. ` +
          `«L'ho applicata» detto a voce non si rilegge fra sei mesi: si scrive nel file.`,
      ).toBe(true)
    }
  })

  it('la fotografia delle migrazioni applicate si legge (sanity)', () => {
    // Senza, la prova qui sotto sarebbe rossa comunque — quindi non è il verso
    // pericoloso. Serve a distinguere i due rossi: «la migrazione non è applicata»
    // da «la fotografia non si legge più», che si correggono in modi opposti.
    expect(
      APPLICATE.size,
      '__tests__/fixtures/migrazioni-applicate-snapshot.json è vuoto o illeggibile: la prova qui ' +
        'sotto direbbe «nessuna migrazione applicata» per qualunque job, e il difetto sarebbe nel ' +
        'suo strumento, non nel repo.',
    ).toBeGreaterThan(50)
  })

  it.each(TRE_VOCI)(
    '🔴 «$etichetta»: il termine è promesso ⇒ esiste un `cron.schedule` in una migrazione APPLICATA',
    ({ quale, etichetta, valore, unita }) => {
      // ─── IL DIFETTO CHE QUESTA PROVA CHIUDE, e come è stato misurato ─────────
      //
      // (Rilievo del revisore, 2026-08-11, TROVATO PROVANDOLO — non leggendo.)
      // Le due prove qui sopra tengono la coppia «nome sorvegliato ⇔ migrazione
      // applicata», e ciascuna delle due, nel proprio messaggio d'errore,
      // raccomanda come via d'uscita (b) di spostare il nome in
      // `JOB_CRON_NON_SORVEGLIATI`. Quella via d'uscita RENDE IL GATE VERDE:
      //   · qui sopra, riga ~1821: `if (!JOB_CRON.some((j) => j.nome === nome)) return`
      //     — tolto il nome da `JOB_CRON`, la prova esce prima di guardare la
      //     migrazione, e questo file passa 70/70;
      //   · `cron-sorvegliato-e-applicato.test.ts` costruisce `COPPIE` da
      //     `JOB_CRON` e basta: fuori di lì, il job smette di essere nominato.
      // Applicandola a entrambi i job della consegna, il gate è INTERAMENTE verde
      // con `/privacy` che promette novanta giorni, dodici mesi e dieci anni su
      // fotografie di carte d'identità che nessuna macchina cancella.
      //
      // E nessun altro lock copre il buco: `informativa-conservazione-dichiarata`
      // scatta sulle sole voci che contengono «automaticamente»
      // (`PROMESSA_DI_AUTOMATISMO`), e queste tre — giustamente, finché la
      // migrazione non è applicata — quella parola non la dicono.
      //
      // ─── PERCHÉ LA REGOLA È DIVERSA DA QUELLA DELL'«AUTOMATICAMENTE» ─────────
      //
      // Lì l'uscita legittima è togliere la parola: il TERMINE resta promesso e
      // qualcuno può applicarlo a mano. Qui a mano non lo applica nessuno, ed è
      // misurato: in tutto `src/` le uniche scritture che cancellano una pratica,
      // azzerano le colonne del documento di `anagrafica_personale` o tolgono un oggetto da
      // `documenti_personale` per fine conservazione stanno in questa route — non
      // esiste una schermata da cui la Segreteria possa farlo. Senza il suo
      // `cron.schedule` applicato, i tre termini non li esegue nessuno: non sono
      // «promessi e fatti a mano», sono promessi e basta.
      //
      // Perciò le due strade, e nessuna terza — spostare il nome NON è una di
      // esse: (a) applicare la migrazione; (b) smettere di promettere il termine,
      // in ENTRAMBI i posti in cui è scritto.
      const nome = SORGENTE_ROUTE.match(/const JOB = '([^']+)'/)![1]

      // Dove il termine è promesso, oggi. Il testo del consenso conta quanto
      // l'informativa, e forse di più: viene congelato in
      // `pratiche_personale.consents_log`, cioè resta agli atti come la frase
      // esatta su cui l'interessata ha spuntato la presa visione. Cancellare la
      // voce da `/privacy` lasciando la promessa nel modulo non è la strada (b):
      // è la stessa promessa, scritta dove si legge meno.
      const promessoIn = [
        ...(VOCI.some((v) => quale.test(v)) ? ['src/app/privacy/page.tsx'] : []),
        // `?? ''` e non `c.text!`: un blocco senza testo esiste (è il caso dei
        // campi non testuali del modulo) e non promette niente — trattarlo come
        // stringa vuota lo esclude, mentre il `!` avrebbe scambiato «non ha testo»
        // per «il testo non c'è più», che è la stessa distinzione che questa prova
        // sorveglia sull'informativa.
        ...(CONSENSI_PERSONALE_FIELDS.some((c) => dichiara(c.text ?? '', valore, unita))
          ? ['src/lib/forms/personale-template.ts (finisce in `consents_log`)']
          : []),
      ]
      // Nessuno lo promette più: non c'è niente da mantenere. È la strada (b)
      // percorsa fino in fondo, e resta legittima. (Che le tre voci ci siano è
      // preteso dalla prova «l'informativa dichiara «…»» qui sopra: se sparissero
      // per distrazione, quella diventa rossa — questa non copre la distrazione,
      // copre la promessa.)
      if (promessoIn.length === 0) return

      const installazioni = installazioniDi(nome)
      const vive = installazioni.filter((m) => APPLICATE.has(m.version) && !soloSuCarta(m.sql))

      expect(
        vive.length,
        `${promessoIn.join(' e ')} promette che «${etichetta}» è conservato ${valore} ${unita}, e ` +
          `nessuna migrazione APPLICATA installa il lavoro \`${nome}\` che dovrebbe applicare quel ` +
          `termine.\n` +
          (installazioni.length === 0
            ? `In supabase/migrations/ non c'è proprio nessun \`cron.schedule('${nome}', …)\`: la ` +
              `route è codice morto.\n`
            : `Il \`cron.schedule('${nome}', …)\` esiste soltanto in ` +
              `${installazioni.map((m) => m.file).join(', ')}, che ` +
              `${installazioni.every((m) => !APPLICATE.has(m.version)) ? 'non compare' : 'non compaiono tutte'} ` +
              `nella fotografia di \`supabase_migrations.schema_migrations\` ` +
              `(__tests__/fixtures/migrazioni-applicate-snapshot.json) e/o è ancora marcata «NON ` +
              `APPLICATA» in testata. Un file SQL non cancella niente.\n`) +
          `Finché resta così, quella riga dell'informativa è una dichiarazione non veritiera ` +
          `(art. 13 §2 lett. a) su una fotografia di carta d'identità di una persona vera.\n` +
          `⚠️ SPOSTARE IL NOME IN \`JOB_CRON_NON_SORVEGLIATI\` NON È UNA VIA D'USCITA DA QUESTA ` +
          `PROVA, ed è deliberato: quella costante decide se /api/health guarda il lavoro, non se ` +
          `il lavoro esiste. Le due prove qui sopra la accettano — questa no, perché la promessa a ` +
          `cui risponde è scritta in un documento pubblico, non in un semaforo.\n` +
          `Le due strade, e nessuna terza: (a) \`apply_migration\` + \`get_advisors\` a 0 ERROR, ` +
          `attestare «APPLICATA il AAAA-MM-GG» in testata e rigenerare la fotografia; ` +
          `(b) togliere il termine da TUTTI i posti che lo promettono — ${promessoIn.join(' e ')} — ` +
          `e allora questa prova non ha più niente da pretendere.`,
      ).toBeGreaterThan(0)
    },
  )

  it('il lavoro è SORVEGLIATO: se smette di girare, /api/health se ne accorge', async () => {
    // Il nome è la CHIAVE con cui `controlloBattitoCron` associa il battito al
    // job: due grafie che si somigliano (`retention-personale` /
    // `personale-retention`) sono peggio di una grafia brutta, perché il job non
    // verrebbe riconosciuto e l'endpoint di salute direbbe «senza battito» per
    // sempre, su un lavoro che gira benissimo.
    const { JOB_CRON, JOB_CRON_NON_SORVEGLIATI } = await import('@/lib/health/controlli')
    const nome = SORGENTE_ROUTE.match(/const JOB = '([^']+)'/)![1]
    const voce = JOB_CRON.find((j) => j.nome === nome)
    expect(
      voce ?? JOB_CRON_NON_SORVEGLIATI.find((j) => j.nome === nome),
      `\`${nome}\` non è né in \`JOB_CRON\` né in \`JOB_CRON_NON_SORVEGLIATI\`: non comparirebbe ` +
        'né fra i job vivi né fra i muti di /api/health, cioè sarebbe invisibile — e una promessa ' +
        'mantenuta da un lavoro che nessuno guarda è una promessa a scadenza. Se lo si toglie da ' +
        '`JOB_CRON` in attesa della migrazione, lo si DICHIARA nell’altra lista con la ragione: le ' +
        'due costanti esistono proprio per distinguere «lasciato fuori apposta» da «dimenticato».',
    ).toBeTruthy()
    if (!voce) return
    expect(voce.finestraMs).toBeGreaterThan(24 * 60 * 60 * 1000)
  })
})
