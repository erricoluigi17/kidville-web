import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertAlunnoInScope } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { confermaValida } from '@/lib/gdpr/anonimizza'
import { anonimizzaAlunno, anonimizzaParent } from '@/lib/gdpr/esegui'
import { contaCosaDistrugge } from '@/lib/gdpr/cosa-distrugge'
import { leggiAltriFigliIscritti } from '@/lib/gdpr/orfano'
import { eNonPiuIscritto, STATO_RITIRATO } from '@/lib/alunni/stato'
import { parseBody } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// `alunno_id`: contratto storico permissivo (qualunque stringa non vuota; id
// inesistente → 404 a valle, niente vincolo uuid). `mode`: stessi valori del
// check manuale sostituito. `confirm`: verificato da `confermaValida` solo in
// mode=execute (400 dedicato a valle) — .optional() esplicito perché in zod v4
// z.unknown() come chiave di z.object è required a runtime.
const postBodySchema = z.object({
  alunno_id: z.string().min(1),
  mode: z.enum(['dryrun', 'execute']),
  confirm: z.unknown().optional(),
})

// =============================================================================
// Diritto all'oblio (DL-034). SOLO anonimizzazione (no DELETE), preserva audit +
// fisco, dry-run + doppia conferma. Riservato alla Direzione.
//
// ─── QUESTA ROUTE NON SA COME SI ESEGUE UN OBLIO, E FA BENE ─────────────────
//
// Fino al 2026-08-02 lo sapeva: riscriveva a mano tutta la procedura —
// anagrafica, riconciliazione, incassi, cassa, foto, domanda d'iscrizione, file.
// Era la TERZA copia della stessa regola, accanto a `anonimizzaAlunno` e
// `anonimizzaParent`, e come ogni copia era rimasta indietro. Misurato: il canale
// della Direzione — cioè quello che risponde alle richieste vere delle famiglie —
// svuotava due magazzini su sei. Restavano nell'archivio le pagelle del bambino,
// i suoi certificati medici, gli allegati scambiati in chat e i PDF delle
// credenziali (che contengono una password in chiaro), più il registro delle
// scritture con il record integrale del minore. Il lock dei bucket era verde,
// perché controllava le funzioni condivise — che erano giuste.
//
// «Una regola valida per due strade deve vivere in un posto solo, altrimenti
// diverge in silenzio.» Qui le strade erano tre. Da oggi questa route fa solo le
// cose che sono SUE — il gate di ruolo, l'isolamento di sede, il vincolo
// «alunno non iscritto», la doppia conferma sul nominativo, chi sono i genitori
// orfani — e per il resto chiama le stesse funzioni degli altri due canali.
// =============================================================================

const DIREZIONE = ['admin', 'coordinator'] as const

/** Il nome dell'operazione nei log applicativi. */
const OP = 'admin/gdpr/erase:POST'

// Il nome dentro `withRoute` resta un LETTERALE, non `OP`: il lock
// `__tests__/architecture/logging-coverage.test.ts` scandisce il sorgente e lo
// confronta carattere per carattere con `<path>:<METODO>`. Una costante lo
// renderebbe illeggibile allo scanner — cioè spegnerebbe il presidio che
// garantisce che ogni route abbia un nome, e per giunta in silenzio.
export const POST = withRoute('admin/gdpr/erase:POST', async (request: Request) => {
  const auth = await requireStaff(request, [...DIREZIONE])
  if (auth.response) return auth.response

  const b = await parseBody(request, postBodySchema)
  if ('response' in b) return b.response
  const { alunno_id, mode, confirm } = b.data

  try {
    const supabase = await createAdminClient()
    // «NON C'È» E «NON L'HO POTUTO LEGGERE» NON SONO LA STESSA COSA — e qui la
    // differenza è la più cara dell'applicazione. PostgREST non lancia: senza il
    // controllo del valore di ritorno, una lettura fallita usciva dalla porta del
    // 404 qui sotto, cioè a una richiesta di cancellazione ex art. 17 si
    // rispondeva **che il bambino non esiste**. È l'unica risposta che nessuno
    // pensa di riprovare: la richiesta della famiglia si chiude lì.
    const { data: alunno, error: alunnoErr } = await supabase
      .from('alunni')
      .select('id, nome, cognome, stato, anonimizzato_il, documento_path, codice_fiscale, fiscal_code')
      .eq('id', alunno_id)
      .maybeSingle()
    if (alunnoErr) {
      logErrore({ operazione: OP, stato: 500, evento: 'db' }, alunnoErr)
      return NextResponse.json({ error: 'Errore interno', codice: 'GDPR_ERASE_NON_RIUSCITO' }, { status: 500 })
    }
    if (!alunno) return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })

    // Isolamento per sede, PRIMA di qualunque effetto. È l'operazione più grave
    // dell'applicazione — anonimizzazione irreversibile di un minore e dei suoi
    // genitori — e l'unico controllo era il ruolo: la Direzione di un plesso
    // poteva cancellare i dati di un bambino di un altro plesso, e non esiste un
    // annulla. Vale anche in `dryrun`: il dry-run restituisce nome e cognome.
    const fuoriScope = await assertAlunnoInScope(supabase, auth.user, alunno_id)
    if (fuoriScope) return fuoriScope

    // Si cancella SOLO un alunno non più iscritto (diritto all'oblio post-uscita).
    //
    // Il permesso arriva da un ELENCO (`STATI_NON_PIU_ISCRITTO`), non dalla
    // negazione `stato === 'iscritto'` che stava qui fino al 2026-08-12: quella
    // lasciava passare `sospeso` — un bambino iscritto a tutti gli effetti — e
    // ogni stato che qualcuno avrebbe aggiunto in futuro alla tendina. La colonna
    // non ha vincolo `CHECK` e la PATCH admin la valida con `z.unknown()`: senza
    // elenco chiuso, un refuso nello stato autorizzava un'anonimizzazione
    // irreversibile. Rifiutare un oblio si ripete; eseguirlo per sbaglio no.
    if (!eNonPiuIscritto(alunno.stato)) {
      // Il rifiuto LASCIA TRACCIA, e con `tipo` si sa da QUALE stato è stato
      // rifiutato, senza doverlo indovinare. `tipo` è nella lista bianca della
      // redazione e `alunni.stato` non è un dato personale: è un valore fra
      // pochi, non un testo scritto da qualcuno.
      //
      // ⚠️ MA QUESTA PORTA È QUASI SEMPRE CHIUSA, e prima qui c'era scritto il
      // contrario («è il solo modo in cui l'elenco chiuso può crescere quando
      // serve davvero»). Misurato: `OblioPanel` prende la lista da
      // `gdpr/candidates` e manda a `erase` solo gli `id` di QUELLA lista, cioè
      // solo alunni che l'allowlist ha già ammesso — dall'interfaccia questo 409
      // non si raggiunge. Il punto in cui un bambino sparisce in silenzio è
      // l'elenco, ed è lì che ora si logga (`candidates`, `esito:
      // 'candidati-esclusi-fuori-elenco'`). Questa riga resta perché la route è
      // chiamabile anche fuori dal pannello, e un rifiuto non deve mai essere muto.
      logEvento('gdpr', 'warn', {
        operazione: OP,
        esito: 'oblio-rifiutato-ancora-iscritto',
        entita_tipo: 'alunni',
        entita_id: alunno_id,
        tipo: alunno.stato ?? 'assente',
      })
      // Il messaggio dice lo stato CHE SERVE, non quello che basterebbe: dopo il
      // passaggio all'elenco chiuso «alunni non iscritti» era diventato
      // ingannevole, perché un bambino `trasferito` non è iscritto e veniva
      // comunque rifiutato — e chi leggeva non aveva modo di capire che cosa
      // fare. Un rifiuto che non dice come si sblocca è un rifiuto che torna.
      return NextResponse.json(
        { error: `Operazione consentita solo su alunni con stato «${STATO_RITIRATO}»` },
        { status: 409 }
      )
    }

    // Genitori collegati (anagrafica reale `parents` via `student_parents`).
    //
    // ⚠️ QUI L'ERRORE SI FERMA, NON SI DEGRADA. Senza il controllo, una lettura
    // fallita lasciava `parentIds` a `[]`: l'oblio proseguiva, anonimizzava il
    // bambino e **non toccava nessun adulto**, rispondendo 200 con «0 genitori».
    // Un oblio eseguito a metà è peggio di un oblio fallito — il secondo si
    // ripete, il primo risulta concluso e lascia in chiaro nomi, codici fiscali e
    // documenti d'identità di due adulti, senza che nessuno lo sappia mai.
    // È l'unico punto di questa route in cui una lista vuota è indistinguibile da
    // un guasto e ha conseguenze irreversibili: si esce, e si riprova.
    const { data: links, error: linksErr } = await supabase
      .from('student_parents')
      .select('parent_id')
      .eq('student_id', alunno_id)
    if (linksErr) {
      logErrore({ operazione: OP, stato: 500, evento: 'db' }, linksErr)
      return NextResponse.json({ error: 'Errore interno', codice: 'GDPR_ERASE_NON_RIUSCITO' }, { status: 500 })
    }
    const parentIds = (links ?? []).map((l: { parent_id: string }) => l.parent_id)

    // Genitori "orfani" (nessun altro figlio iscritto) → anonimizzabili.
    //
    // ⚠️ IL GUASTO DI LETTURA SI FERMA QUI COME SI FERMA DODICI RIGHE SOPRA, e
    // per la stessa ragione detta in un verso peggiore: se la lettura dei
    // fratelli fallisce, «nessun altro figlio» e «non sono riuscito a chiederlo»
    // sono la stessa risposta — e la prima manda all'anonimizzazione
    // irreversibile un adulto il cui bambino frequenta ancora.
    // `leggiAltriFigliIscritti` non ritorna più un booleano proprio per rendere
    // impossibile la confusione: senza guardare `ok` non si arriva a
    // `haAltriFigli`.
    const parentiOrfani: string[] = []
    for (const pid of parentIds) {
      const esito = await leggiAltriFigliIscritti(supabase, pid, alunno_id)
      if (!esito.ok) {
        logErrore({ operazione: OP, stato: 500, evento: 'db' }, esito.errore)
        return NextResponse.json({ error: 'Errore interno', codice: 'GDPR_ERASE_NON_RIUSCITO' }, { status: 500 })
      }
      if (!esito.haAltriFigli) parentiOrfani.push(pid)
    }

    if (mode === 'dryrun') {
      // Il dry-run conta i DOCUMENTI D'IDENTITÀ che si toglieranno: quello del
      // bambino e quello di ogni adulto orfano. Fino al 2026-07-31 contava solo
      // il primo, e annunciava «1 file da rimuovere» mentre nel bucket ce n'erano
      // di più — quelli degli adulti, che nessuno rimuoveva mai (privacy F3).
      // È una STIMA per chi deve confermare: i percorsi che solo la domanda
      // d'iscrizione conosce si scoprono in fase di esecuzione.
      const docOrfani: (string | null)[] = []
      if (parentiOrfani.length > 0) {
        const { data: docRows, error: errDoc } = await supabase
          .from('parents')
          .select('documento_path')
          .in('id', parentiOrfani)
        // PostgREST non lancia: senza questo controllo un guasto di lettura
        // diventerebbe «nessun documento», cioè un dry-run che rassicura.
        if (errDoc) logErrore({ operazione: OP, evento: 'raccolta_documenti_orfani' }, errDoc)
        for (const r of (docRows ?? []) as { documento_path?: string | null }[]) {
          docOrfani.push(r.documento_path ?? null)
        }
      }
      const fileAnagrafica = [
        alunno.documento_path ? String(alunno.documento_path) : null,
        ...docOrfani,
      ].filter((p): p is string => typeof p === 'string' && p.trim().length > 0)

      // ⚠️ E QUI IL DRY-RUN SMETTE DI DIRE SOLO «file da rimuovere: N».
      //
      // Quel numero c'è ancora — sono i documenti d'identità in `form_attachments`
      // — ma da solo faceva confermare un'operazione IRREVERSIBILE senza dire che
      // se ne vanno le PAGELLE del bambino e i suoi CERTIFICATI MEDICI. Non erano
      // nascosti: semplicemente non erano scritti in nessun punto che un operatore
      // potesse leggere prima di digitare il nominativo.
      //
      // `contaCosaDistrugge` fa SOLE `SELECT`: siamo prima della conferma, su
      // un'operazione che non ha un annulla. E dove non riesce a leggere risponde
      // `null`, non `0`: un dry-run che rassicura su un numero mai misurato è
      // peggio di un dry-run che ammette di non sapere.
      const conteggi = await contaCosaDistrugge(supabase, alunno_id, OP)

      return NextResponse.json({
        dryrun: true,
        alunno: 1,
        parents: parentiOrfani.length,
        parents_non_anonimizzati: parentIds.length - parentiOrfani.length,
        file_da_rimuovere: fileAnagrafica.length,
        ...conteggi,
        nominativo_conferma: `${(alunno.cognome ?? '').trim()} ${(alunno.nome ?? '').trim()}`.trim().toUpperCase(),
      })
    }

    // execute: doppia conferma sul nominativo.
    if (!confermaValida(confirm, alunno)) {
      return NextResponse.json(
        { error: 'Conferma non valida: digita ESATTAMENTE il nominativo (Cognome Nome)' },
        { status: 400 }
      )
    }

    const at = new Date().toISOString()

    // 1. IL MINORE, con tutto ciò che lo riguarda: anagrafica, bonifica
    //    finanziaria (riconciliazione/incassi/cassa), testo libero UGC, foto di
    //    galleria, domanda d'iscrizione, pagelle, certificati medici, allegati di
    //    chat e registro delle scritture. Una funzione sola, la stessa degli
    //    altri due canali.
    const esitoAlunno = await anonimizzaAlunno(
      supabase,
      {
        id: alunno_id,
        documento_path: alunno.documento_path as string | null,
        codice_fiscale: alunno.codice_fiscale as string | null,
        fiscal_code: alunno.fiscal_code as string | null,
      },
      at,
      OP,
    )

    // 2. I GENITORI ORFANI, uno per uno. `anonimizzaParent` raccoglie da sé
    //    l'`auth_user_id`, il codice fiscale e il percorso del documento PRIMA
    //    di azzerarli — che è l'ordine da cui dipende tutto il resto (senza il
    //    CF la domanda d'iscrizione dell'adulto non si ritrova più).
    let newsVisualizzazioniRimosse = 0
    let consensiProvaBonificati = 0
    let pushRimosse = 0
    let iscrizioniAdulti = 0
    let fileAdultiRimossi = 0
    let fileAdultiNonRimossi = 0
    let notificheRimosse = esitoAlunno.notificheRimosse
    for (const pid of parentiOrfani) {
      const e = await anonimizzaParent(supabase, pid, at, OP)
      newsVisualizzazioniRimosse += e.newsVisualizzazioniRimosse
      consensiProvaBonificati += e.provaConsensiScrubbate
      pushRimosse += e.pushSubscriptionsRimosse
      iscrizioniAdulti += e.iscrizioniScrubbate
      fileAdultiRimossi += e.fileRimossi
      fileAdultiNonRimossi += e.fileNonRimossi
      notificheRimosse += e.notificheRimosse
    }

    const nFileNonRimossi = esitoAlunno.fileNonRimossi + fileAdultiNonRimossi

    const esito = {
      alunno: 1,
      parents: parentiOrfani.length,
      file_rimossi: esitoAlunno.file + fileAdultiRimossi,
      n_file_non_rimossi: nFileNonRimossi,
      iscrizioni_scrubbate: esitoAlunno.iscrizioniScrubbate + iscrizioniAdulti,
      foto_rimosse: esitoAlunno.fotoRimosse,
      foto_sganciate: esitoAlunno.fotoSganciate,
      riconciliazione_bonificati: esitoAlunno.riconciliazione,
      incassi_bonificati: esitoAlunno.incassi,
      cassa_bonificati: esitoAlunno.cassa,
      // Il motivo dell'assenza scritto dalla famiglia e le note d'appello del
      // docente (`presenze.giustificazione_testo` / `note_appello`): testo libero
      // di natura sanitaria, che fino al 2026-08-07 nessun canale di oblio
      // toccava. Sta nella risposta perché è la parte che si racconta alla
      // famiglia: «quante righe del registro portavano ancora un suo testo».
      presenze_bonificate: esitoAlunno.presenzeBonificate,
      news_visualizzazioni_rimosse: newsVisualizzazioniRimosse,
      consensi_prova_bonificati: consensiProvaBonificati,
      // I dispositivi che smettono di ricevere le notifiche della scuola. Sta
      // nell'esito e non solo nei log perché è la parte dell'oblio che la famiglia
      // VEDE: se il telefono continua a suonare, «fatto» è una parola vuota.
      push_subscriptions_rimosse: pushRimosse,
      // Le notifiche già recapitate che nominavano il minore (la campanella dei
      // docenti e quella del genitore). La scadenza automatica a dodici mesi
      // chiude il «per sempre»; l'art. 17 chiede «senza ingiustificato ritardo»,
      // e questo è il numero che lo dimostra.
      notifiche_rimosse: notificheRimosse,
    }

    // Un oblio incompleto non può passare inosservato: riga PERSISTITA (`gdpr` è
    // in EVENTI_PERSISTITI) con soli conteggi e uuid. Alla famiglia è stato
    // promesso che quei file non ci sono più.
    if (nFileNonRimossi > 0) {
      logEvento('gdpr', 'error', {
        operazione: OP,
        esito: 'oblio-parziale',
        entita_tipo: 'alunni',
        entita_id: alunno_id,
        n_file: nFileNonRimossi,
        msg: `${OP}: ${nFileNonRimossi} file di un interessato NON sono usciti dall'archivio`,
      })
    } else {
      // Evento critico → si logga anche il SUCCESSO. Con i soli errori, «nessun
      // log» non distingue «tutto a posto» da «non è mai partito niente»: è
      // esattamente l'ambiguità che ha nascosto per mesi il guasto delle email.
      logEvento('gdpr', 'info', {
        operazione: OP,
        esito: 'oblio-eseguito',
        entita_tipo: 'alunni',
        entita_id: alunno_id,
        n_file: esito.file_rimossi,
        // Quante righe del registro portavano ancora un testo scritto dalla
        // famiglia o dal docente. È un CONTEGGIO — nessun testo, nessun nome —
        // e sta qui perché `gdpr` è persistito: senza, fra sei mesi la domanda
        // «il motivo dell'assenza è stato tolto davvero?» non ha una query.
        n_presenze: esito.presenze_bonificate,
      })
    }

    // 3. Log immutabile dell'oblio (solo conteggi/uuid: nessuna PII).
    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'gdpr_oblio',
      entitaId: alunno_id,
      azione: 'update',
      scuolaId: auth.user.scuola_id ?? null,
      valoreDopo: { alunno_id, parents_anonimizzati: parentiOrfani, ...esito },
    })

    return NextResponse.json({ ok: true, ...esito })
  } catch (err) {
    logErrore({ operazione: OP, stato: 500 }, err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Errore interno' },
      { status: 500 }
    )
  }
})
