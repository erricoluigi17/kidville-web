import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertAlunnoInScope, scuoleDiUtente } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { confermaValida, nomeConferma } from '@/lib/gdpr/anonimizza'
import { eNonPiuIscritto, STATO_RITIRATO } from '@/lib/alunni/stato'
import { RUOLI_LIBERA_SPAZIO, colonnaAssente } from '@/lib/alunni/archiviazione'
import {
  BUCKET_INTATTI,
  TABELLE_INTATTE,
  contaSpazio,
  liberaSpazio,
} from '@/lib/alunni/libera-spazio'
import { parseBody } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// =============================================================================
// LIBERA SPAZIO — il secondo tempo dell'archiviazione di un alunno.
//
// Foto, video e messaggi via; registri e pagamenti intatti. Il modello a due
// tempi è del titolare (2026-08-12): prima si ARCHIVIA — reversibile, anagrafica
// intatta — e solo da quell'elenco si LIBERA SPAZIO, che invece non torna.
//
// ─── LA FORMA È QUELLA DELL'OBLIO, DI PROPOSITO ────────────────────────────
//
// `{ alunno_id, mode: 'dryrun'|'execute', confirm }` è lo stesso contratto di
// `admin/gdpr/erase`. Non è pigrizia: davanti a un pulsante senza annulla,
// l'abitudine dell'operatore è una difesa — si guarda il dry-run, si digita il
// nominativo, si esegue — e ripeterla identica costa zero e vale molto. Vale lo
// stesso per i test, che hanno già lo stampo.
//
// ─── QUESTA ROUTE NON SA COME SI LIBERA LO SPAZIO, E FA BENE ────────────────
//
// Il motore sta in `@/lib/alunni/libera-spazio`, con l'elenco scritto di ciò che
// NON si tocca. Qui restano le cose che sono SUE: il gate di ruolo, l'isolamento
// di sede, il vincolo «non più iscritto», la conferma sul nominativo e il
// registro immutabile della scrittura. È la lezione già pagata su `gdpr/erase`,
// che riscriveva a mano la procedura ed era la terza copia di una regola: come
// ogni copia era rimasta indietro, e svuotava due magazzini su sei.
// =============================================================================

const postBodySchema = z.object({
  alunno_id: z.string().min(1),
  mode: z.enum(['dryrun', 'execute']),
  // Verificato da `confermaValida` solo in `execute` (400 dedicato a valle):
  // `.optional()` esplicito perché in zod v4 `z.unknown()` come chiave di
  // `z.object` è comunque required a runtime.
  confirm: z.unknown().optional(),
})

/** Il nome dell'operazione nei log applicativi. */
const OP = 'admin/students/libera-spazio:POST'

// Il nome dentro `withRoute` resta un LETTERALE, non `OP`: il lock
// `__tests__/architecture/logging-coverage.test.ts` scandisce il sorgente e lo
// confronta carattere per carattere con `<path>:<METODO>`. Una costante lo
// renderebbe illeggibile allo scanner — cioè spegnerebbe il presidio, in silenzio.
export const POST = withRoute('admin/students/libera-spazio:POST', async (request: Request) => {
  // ⚠️ SOLO LA DIREZIONE, e l'elenco NON è scritto qui. Archiviare si annulla —
  // si riporta lo stato a `iscritto` e il bambino ricompare — mentre questa toglie
  // file da tre bucket e cancella il testo dei messaggi: non esiste un ripristino.
  // Il confine fra i due gesti passa esattamente di qui, ed è lo stesso confine
  // dell'oblio.
  //
  // L'elenco vive in `@/lib/alunni/archiviazione` perché lo legge anche il filtro
  // di cortesia del client (`AlunniArchiviatiView`), che fino al 2026-08-13 lo
  // ribatteva a mano: due copie che possono divergere in silenzio, e la divergenza
  // qui vuol dire o un comando offerto a chi prenderà 403, o un comando nascosto a
  // chi ne ha diritto. Che il gate riceva ESATTAMENTE questo elenco lo asserisce
  // il test sul valore letterale — senza quella riga, aggiungere `'segreteria'`
  // lasciava verdi 49 test dedicati e 1017 di architettura (misurato).
  const auth = await requireStaff(request, [...RUOLI_LIBERA_SPAZIO])
  if (auth.response) return auth.response

  const b = await parseBody(request, postBodySchema)
  if ('response' in b) return b.response
  const { alunno_id, mode, confirm } = b.data

  try {
    const supabase = await createAdminClient()

    // 1. ISOLAMENTO DI SEDE, prima di qualunque lettura di dettaglio e prima di
    //    qualunque effetto. Vale anche in `dryrun`, che restituisce il nominativo
    //    da digitare: senza, la Direzione di un plesso leggerebbe il nome di un
    //    bambino di un altro plesso — e poi potrebbe cancellargli le foto.
    //    `assertAlunnoInScope` risponde da sé 404 se l'alunno non esiste.
    const fuoriScope = await assertAlunnoInScope(supabase, auth.user, alunno_id)
    if (fuoriScope) return fuoriScope

    // 2. L'ANAGRAFICA, CON IL FILTRO DI SEDE ACCANTO AL GATE — due reti, non una.
    //
    //    ⚠️ Qui c'era il solo `.eq('id', …)`, e l'asimmetria era al contrario:
    //    `archivia` e `riattiva` — che si annullano — portavano due difese, e
    //    l'unica operazione SENZA annulla ne aveva una. Il filtro non sostituisce
    //    il gate e non lo ripete: il gate impedisce di NOMINARE la riga di un
    //    altro plesso, il filtro impedisce che una corsa fra il gate e questa
    //    lettura ne faccia rientrare una — e a valle di questa lettura c'è una
    //    cancellazione di file che non torna indietro.
    //
    //    «NON C'È» E «NON L'HO POTUTO LEGGERE» NON SONO LA STESSA COSA: PostgREST
    //    non lancia, e senza il controllo del valore di ritorno una lettura
    //    fallita uscirebbe dalla porta del 404, cioè direbbe che il bambino non
    //    esiste a chi sta per liberare il suo spazio.
    const plessi = await scuoleDiUtente(supabase, auth.user)
    const { data: alunno, error: alunnoErr } = await supabase
      .from('alunni')
      .select('id, nome, cognome, stato, scuola_id, spazio_liberato_il')
      .eq('id', alunno_id)
      .in('scuola_id', plessi)
      .maybeSingle()
    if (alunnoErr) {
      // `spazio_liberato_il` arriva dalla migrazione `20260812194517`, e il DB
      // E2E della CI è un progetto separato e NON migrato: là PostgREST risponde
      // `42703`. È la stessa decisione dei due gemelli (`archivia`, `riattiva`),
      // e qui pesa di più: un 500 «Errore interno» invita a riprovare, e su un
      // ambiente senza quelle colonne riprovare non serve a niente. Il rimedio
      // non è aspettare un minuto, è applicare la migrazione — e va detto.
      if (colonnaAssente(alunnoErr)) return archivioNonDisponibile(alunno_id)
      logErrore({ operazione: OP, stato: 500, evento: 'db' }, alunnoErr)
      return NextResponse.json(
        { error: 'Errore interno', codice: 'SPAZIO_NON_LIBERATO' },
        { status: 500 },
      )
    }
    if (!alunno) {
      // Il gate è passato e la riga non c'è più: o è sparita, o è uscita dallo
      // scope fra il gate e questa lettura. Il secondo caso è l'unico che il
      // filtro di sede può produrre da solo, e senza questa riga sarebbe
      // indistinguibile da un 404 qualunque.
      logEvento('multi_sede', 'warn', {
        operazione: OP,
        esito: 'alunno-non-piu-in-scope',
        entita_tipo: 'alunni',
        entita_id: alunno_id,
      })
      return NextResponse.json(
        { error: 'Alunno non trovato', codice: 'SPAZIO_ALUNNO_NON_TROVATO' },
        { status: 404 },
      )
    }

    // 3. SOLO DA «NON PIÙ ISCRITTI», e il permesso arriva da un ELENCO CHIUSO
    //    (`STATI_NON_PIU_ISCRITTO`), non dalla negazione `stato !== 'iscritto'`.
    //    La differenza non è di stile: `alunni.stato` è una varchar senza `CHECK`
    //    e la PATCH admin la valida con `z.unknown()`, quindi una negazione
    //    lascerebbe passare `sospeso` — un bambino che frequenta — e ogni stato
    //    che qualcuno aggiungerà domani alla tendina. Rifiutare si ripete;
    //    cancellare le foto del bambino sbagliato no.
    if (!eNonPiuIscritto(alunno.stato)) {
      // Il rifiuto LASCIA TRACCIA, con lo stato che l'ha causato: se un giorno
      // l'elenco chiuso diventerà troppo stretto, questa riga è l'unico modo di
      // accorgersene — a schermo si vedrebbe solo un 409 «corretto». `tipo` è in
      // lista bianca e `stato` è un valore fra pochi, non un testo scritto da
      // qualcuno.
      logEvento('gdpr', 'warn', {
        operazione: OP,
        esito: 'spazio-rifiutato-ancora-iscritto',
        entita_tipo: 'alunni',
        entita_id: alunno_id,
        tipo: alunno.stato ?? 'assente',
      })
      return NextResponse.json(
        {
          error: `Operazione consentita solo su alunni con stato «${STATO_RITIRATO}»: archivia prima l'alunno`,
          codice: 'SPAZIO_ALUNNO_ANCORA_ISCRITTO',
        },
        { status: 409 },
      )
    }

    // Ciò che NON si tocca viaggia in ENTRAMBE le risposte, non solo nel dry-run:
    // è la promessa su cui la Direzione decide, e va riletta anche a cose fatte.
    const nonTocca = { tabelle: [...TABELLE_INTATTE], bucket: [...BUCKET_INTATTI] }

    if (mode === 'dryrun') {
      const conta = await contaSpazio(supabase, alunno_id, OP)
      if (!conta.ok) {
        // Un conteggio inventato è una conferma inventata: il dry-run è ciò che
        // l'operatore LEGGE prima di digitare il nominativo, e «zero foto» al
        // posto di «non ho potuto guardare» gli farebbe approvare un numero che
        // nessuno ha misurato.
        return NextResponse.json(
          { error: 'Errore interno', codice: 'SPAZIO_NON_LIBERATO' },
          { status: 500 },
        )
      }
      return NextResponse.json({
        dryrun: true,
        ...conta.conti,
        // Già liberato una volta? La scheda deve poterlo dire, altrimenti una
        // seconda esecuzione sembra non aver fatto niente.
        spazio_liberato_il: alunno.spazio_liberato_il ?? null,
        nominativo_conferma: nomeConferma(alunno),
        non_tocca: nonTocca,
      })
    }

    // 4. LA CONFERMA SI DIGITA. Non un secondo click: da qui non si torna
    //    indietro, e un click si dà anche per sbaglio.
    if (!confermaValida(confirm, alunno)) {
      return NextResponse.json(
        {
          error: 'Conferma non valida: digita ESATTAMENTE il nominativo (Cognome Nome)',
          codice: 'SPAZIO_CONFERMA_NON_VALIDA',
        },
        { status: 400 },
      )
    }

    const risultato = await liberaSpazio(supabase, alunno_id, OP)
    if (!risultato.ok) {
      // Il motore si ferma sulle letture che DECIDONO (i thread, i messaggi):
      // lì «non lo so» non può travestirsi da «non c'è niente», perché a valle
      // c'è una cancellazione. Nessuna riga è stata toccata: si riprova.
      return NextResponse.json(
        { error: 'Errore interno', codice: 'SPAZIO_NON_LIBERATO' },
        { status: 500 },
      )
    }
    const esito = risultato.esito

    // 5. IL REGISTRO IMMUTABILE, coi soli CONTEGGI: nessun nome, nessun percorso.
    //    Fra dieci anni la domanda «di questo bambino che cosa è stato tolto, e
    //    chi l'ha deciso?» deve avere una riga da leggere.
    //
    //    ⚠️ LA SEDE È QUELLA DELL'ALUNNO, NON QUELLA DELL'OPERATORE. Qui c'era
    //    `auth.user.scuola_id`, e su una traccia di chi-ha-toccato-cosa non è un
    //    dettaglio: `test.multisede.admin` vede tutte e tre le sedi, quindi la
    //    sua sede PRIMARIA finiva scritta accanto alla distruzione irreversibile
    //    fatta in un altro plesso. Il gemello `archivia` lo faceva già giusto
    //    (`prima.scuola_id`), e questa riga è la sola che fra dieci anni dovrà
    //    rispondere a «in quale plesso».
    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'alunno_spazio_liberato',
      entitaId: alunno_id,
      azione: 'update',
      scuolaId: (alunno.scuola_id as string | null) ?? null,
      valoreDopo: { alunno_id, ...esito },
    })

    return NextResponse.json({ ok: true, ...esito, non_tocca: nonTocca })
  } catch (err) {
    logErrore({ operazione: OP, stato: 500 }, err)
    return NextResponse.json(
      { error: 'Errore interno', codice: 'SPAZIO_NON_LIBERATO' },
      { status: 500 },
    )
  }
})

/**
 * Le colonne dell'archiviazione non esistono in questo database.
 *
 * È lo stato del DB E2E della CI, che è un progetto SEPARATO e non migrato. La
 * risposta è 503 e non 500 perché il rimedio non è «riprova fra un minuto»: è
 * applicare la migrazione. Il testo e il codice sono gli stessi dei due gemelli
 * (`archivia`, `riattiva`): all'operatore la rotta che ha chiamato non interessa,
 * gli interessa che l'archivio dei «non più iscritti» qui non c'è.
 *
 * ⚠️ E NON si degrada togliendo la colonna e riprovando, come fa il resto del
 * repo: `spazio_liberato_il` è il SEGNO che il lavoro è stato fatto. Senza quella
 * colonna la rotta cancellerebbe foto e messaggi e non avrebbe dove scriverlo —
 * una distruzione irreversibile senza la riga che la ricorda.
 */
function archivioNonDisponibile(alunnoId: string): NextResponse {
  logEvento('gdpr', 'error', {
    operazione: OP,
    esito: 'colonne-archiviazione-assenti',
    entita_tipo: 'alunni',
    entita_id: alunnoId,
  })
  return NextResponse.json(
    {
      error:
        'L\'archivio dei «non più iscritti» non è disponibile su questo ambiente: nessuna modifica è stata registrata.',
      codice: 'ARCHIVIO_NON_DISPONIBILE',
    },
    { status: 503 },
  )
}
