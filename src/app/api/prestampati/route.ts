import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { assertSezioneInScope, resolveScuoleAttive } from '@/lib/auth/scope'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { logAccessoFascicolo } from '@/lib/primaria/fascicolo-rbac'
import { caricaPrefillAlunno } from '@/lib/prestampati/prefill'
import {
  prestampato,
  ruoloRichiedente,
  SLUG_PRESTAMPATI,
  type VocePrestampato,
} from '@/lib/prestampati/registro'
import {
  cancelloDelModello,
  caricaSezione,
  elencoPerRuolo,
  motivoNonGenerabile,
  SOLO_CONTEGGIO,
  SPIEGAZIONE_NON_GENERABILE,
  voceElenco,
  type ContestoSede,
  type VoceElenco,
} from './banco'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

/**
 * GET /api/prestampati — il pannello della modulistica prestampata.
 *
 * Due domande, una porta sola:
 *
 *  · **senza `modello`** → l'elenco dei fogli che QUEL banco può far nascere, con il loro
 *    soggetto (alunno · sezione · dipendente) e — questa è la parte che il pannello non
 *    saprebbe dedurre — se il pulsante va acceso o spento, e perché. Sei dei diciassette si
 *    firmano nel flusso della famiglia, due pretendono quella stessa firma e oggi non hanno
 *    nessuna schermata che la raccolga, tre aspettano una fonte dati che non esiste ancora:
 *    dirlo qui evita un pulsante che porta a un rifiuto — e dirlo con il motivo GIUSTO evita
 *    di mandare l'educatrice del verbale d'infortunio in un flusso che quel foglio non ce
 *    l'ha (vedi `MotivoNonGenerabile`, in `banco.ts`).
 *  · **con `modello` + il soggetto** → il precompilato GIÀ RISOLTO (ciò che l'app sa e che
 *    quindi il form non deve chiedere) e i campi che restano da chiedere. È la differenza
 *    fra digitalizzare un modulo e digitalizzare la segreteria: un modulo che richiede alla
 *    madre la data di nascita di suo figlio, che la scuola ha in archivio da tre anni, è un
 *    modulo che si compila sul telefono e si abbandona a metà.
 *
 * ⚠️ IL QUARTO MOTIVO LO SA SOLO LA SECONDA DOMANDA, e non è una svista dell'elenco:
 * `legale_rappresentante_assente` sta nella configurazione della SEDE, che con tre plessi
 * non è una sola — lo stesso certificato può essere generabile a Giugliano e non a Cesa. La
 * prima domanda nasce prima che una sede sia stata scelta e non può rispondere; la seconda
 * la sede ce l'ha, perché il precompilato del bambino se la porta dietro, e lì il pulsante
 * si spegne. Oggi non è un caso di scuola: quella chiave, il 2026-08-14, non esisteva su
 * nessuna delle quattro righe di `scuole`.
 *
 * ─── I TRE CANCELLI ─────────────────────────────────────────────────────────────
 *
 *  1. `requireDocente` — personale docente e segreteria. Le stampe di sezione servono
 *     anche alle insegnanti (n. 49), e `requireStaff` le lascerebbe fuori dal foglio che
 *     usano ogni giorno; il genitore e la cuoca restano fuori da qui.
 *  2. il BANCO DEL MODELLO — il registro dichiara da quale banco nasce ciascun foglio, e il
 *     diniego lo emette lo stesso gate con i ruoli di quel banco (`cancelloDelModello`, in
 *     `banco.ts`, che è la stessa funzione che chiama la generazione): un'insegnante non
 *     apre un nulla osta. Il cancello ragiona per BANCO e non per ruolo — i tre ruoli di
 *     sportello sono equivalenti — e cosa questo comporti sta scritto accanto alla chiamata.
 *  3. la PORTATA del soggetto — `caricaPrefillAlunno` per il bambino (che chiama
 *     `requireParentOfStudent`, cioè il gate delle venti route che leggono i dati di un
 *     alunno indicato dal client), `assertSezioneInScope` + le sedi attive per la sezione.
 *     Un bambino — e una sezione — di un'altra sede rispondono 403, non 200 con i dati.
 *
 * ⚠️ Il precompilato NON contiene dati sanitari: `caricaPrefillAlunno` non li legge affatto
 * (allergie, allergeni e note mediche non sono nella sua `select`), e l'elenco di sezione
 * qui torna come CONTEGGIO — le righe con le diete e i recapiti nascono solo al momento
 * della stampa, dentro il PDF, che è il posto in cui devono stare. Il conteggio si prende
 * senza leggerli: `caricaSezione(..., SOLO_CONTEGGIO)`, che è il motivo per cui quegli
 * interruttori esistono.
 *
 * ⚠️ IL REGISTRO DEGLI ACCESSI. Il precompilato di un BAMBINO scrive una riga in
 * `fascicolo_accessi_audit` (`azione: 'view'`), come pretende la regola 5 di
 * `docs/prestampati/README.md` e come fanno già le route sorelle del fascicolo. Quello di
 * una SEZIONE no, e la differenza non è una dimenticanza: qui la sezione risponde con un
 * numero, e un numero non è l'accesso al fascicolo di nessuno. Le venticinque righe di
 * `list` le scrive la generazione, dove i nomi escono davvero (§49 punto 2).
 */

const getQuerySchema = z
  .object({
    /**
     * Uno dei diciassette. È un `enum` sul registro e non una stringa libera: uno slug
     * inventato è un errore del CLIENT e va detto con un 400 nella forma di tutte le altre
     * route, non con un 404 costruito a mano. Il registro resta comunque il cancello — è
     * lui che genera questo elenco.
     */
    modello: z.enum(SLUG_PRESTAMPATI).optional(),
    alunnoId: zUuid.optional(),
    sezioneId: zUuid.optional(),
  })
  .superRefine((v, ctx) => {
    const voce = v.modello ? prestampato(v.modello) : null
    if (!voce) return
    // Il soggetto lo dichiara il modello, non chi chiama: chiedere il precompilato di un
    // nulla osta senza dire di quale bambino è una richiesta incompleta, non una risposta
    // vuota. Dirlo con la 400 di `parseQuery` mette il messaggio accanto al campo giusto.
    if (voce.soggetto === 'alunno' && !v.alunnoId) {
      ctx.addIssue({
        code: 'custom',
        path: ['alunnoId'],
        message: 'Indicare il bambino di cui si vuole il prestampato',
      })
    }
    if (voce.soggetto === 'sezione' && !v.sezioneId) {
      ctx.addIssue({
        code: 'custom',
        path: ['sezioneId'],
        message: 'Indicare la sezione di cui si vuole la stampa',
      })
    }
  })

/**
 * La voce dell'elenco più i campi che il form deve ancora chiedere.
 *
 * `contesto` è quello di `motivoNonGenerabile`: quando la sede è nota — cioè dopo aver
 * letto il precompilato del bambino — la voce esce già con `generabile: false` e il motivo,
 * invece di accendere un pulsante che la generazione rifiuterà. È il principio che
 * `banco.ts` enuncia su sé stesso: «un pulsante che porta a un 422 è peggio di un pulsante
 * spento».
 */
function descrittore(
  voce: VocePrestampato,
  contesto: ContestoSede = {},
): VoceElenco & { campi: VocePrestampato['campi'] } {
  return { ...voceElenco(voce, contesto), campi: voce.campi }
}

export const GET = withRoute('prestampati:GET', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const user = auth.user

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { modello, alunnoId, sezioneId } = q.data

    if (!modello) {
      // Il banco `null` non è raggiungibile dopo `requireDocente` — i suoi quattro ruoli
      // hanno tutti un banco — ma dedurlo da una promessa scritta altrove è il modo in cui
      // un giorno un ruolo nuovo entrerebbe qui senza che nessuno se ne accorga. Senza
      // banco, elenco vuoto: alla domanda «cosa posso generare?» la risposta onesta è
      // «niente», e un elenco vuoto la dice.
      //
      // ⚠️ IL RAMO STAVA PRIMA DI QUESTO `if`, e rispondeva all'ALTRA domanda: un ruolo
      // senza banco che chiedeva un MODELLO preciso riceveva `200 {"modelli":[]}` — cioè un
      // sì con una lista vuota a una domanda a cui la risposta è no. Misurato con una sonda
      // (ruolo `cuoca` forzato, `?modello=nulla_osta&alunnoId=…`). Nessun dato usciva, ma
      // «non ti è permesso» e «ecco, non c'è niente» sono due risposte diverse, e la seconda
      // manda chi legge a cercare un difetto nell'elenco. Adesso da qui in giù si parla di
      // UN modello, e a rispondere è il cancello.
      const banco = ruoloRichiedente(user.role)
      const modelli = banco ? elencoPerRuolo(banco) : []
      logEvento('modulistica', 'info', {
        operazione: 'prestampati:GET',
        esito: 'elenco',
        utente: user.id,
        ruolo: user.role,
        n: modelli.length,
      })
      return NextResponse.json({ success: true, data: { modelli } })
    }

    // ⚠️ QUESTO `if` NON SI ESEGUE MAI, ed è giusto che resti. `z.enum(SLUG_PRESTAMPATI)`
    // ha già ristretto `modello` a uno dei diciassette, quindi `prestampato()` non può
    // tornare `null`: il ramo serve al RESTRINGIMENTO DI TIPO, perché la firma di
    // `prestampato()` parla di stringhe qualunque e `tsc` non sa che questa non lo è.
    // Toglierlo vorrebbe dire un `!` — che è la stessa fiducia, senza la rete — oppure una
    // seconda funzione non-nullable nel registro, che è un file di un'altra mano.
    const voce = prestampato(modello)
    if (!voce) {
      return NextResponse.json(
        { error: 'Prestampato non riconosciuto.', codice: 'PRESTAMPATO_SCONOSCIUTO' },
        { status: 404 },
      )
    }

    // Il cancello del BANCO DEL MODELLO, che è lo stesso del POST: un'insegnante non apre
    // un nulla osta. Vive in `banco.ts` perché due copie dello stesso cancello divergono
    // (vedi la nota là).
    //
    // ⚠️ RAGIONA PER BANCO, NON PER RUOLO, e la differenza va detta perché il commento che
    // stava qui prometteva l'altra cosa — «la segreteria non compila un documento di
    // valutazione» — che è falsa. `ruoliAppDelModello` chiede al REGISTRO in quali banchi
    // sta il modello e poi riespande ciascun banco nei suoi ruoli dell'app: il documento di
    // valutazione dichiara `['educator','coordinator','admin']`, che collassano su
    // `insegnante` + `segreteria`, e da lì tornano `['admin','coordinator','segreteria']` —
    // cioè passa anche il ruolo `segreteria`, che il modello non nomina. Lo stesso vale per
    // il certificato delle competenze. È la conseguenza voluta di avere TRE banchi e non sei
    // ruoli (`RuoloRichiedente`, in `registro.ts`): allo sportello, admin, coordinatrice e
    // segretaria sono la stessa persona per quel che riguarda la modulistica. Chi volesse il
    // cancello sul ruolo dichiarato deve intersecare `voce.disponibilePer` dentro
    // `ruoliAppDelModello`, non aggiungere un controllo qui: due cancelli sullo stesso
    // passaggio divergono, ed è la ragione per cui questo vive in un posto solo.
    const negato = await cancelloDelModello(request, voce, user.role)
    if (negato) return negato

    const supabase = await createAdminClient()

    // Un foglio che allo sportello non nasce non fa leggere l'anagrafica di nessuno: si
    // restituiscono i suoi campi e il motivo, e nient'altro. Ciò che non si legge non si
    // può perdere.
    const motivo = motivoNonGenerabile(voce)
    if (motivo) {
      // ⚠️ `motivo` E `spiegazione` NON SONO LO STESSO CAMPO, e l'ordine di preferenza è
      // quello: `motivo` è l'enumerato — `firma_da_raccogliere`, `firma_senza_flusso`,
      // `fonte_dati_assente` — ed è ciò che il pannello traduce con il catalogo della
      // lingua in cui sta lavorando; `spiegazione` è la prosa del SERVER, che nasce dove il
      // locale non esiste ed è quindi italiana per costruzione.
      //
      // Su un'app bilingue mostrare la seconda è il difetto che i codici d'errore hanno
      // chiuso una volta (`errori-con-codice`, collaudo del 31/07: «Sede non accessibile»
      // dentro un'interfaccia inglese). Le tre chiavi corrispondenti sono CHIESTE in
      // `messages/it|en/prestampatiSegreteria.json` — file che non sono di questa mano: la
      // richiesta è nelle note del lavoro — e finché non ci sono, `spiegazione` è il
      // ripiego che dice comunque qualcosa invece di niente.
      //
      // `motivo` esce già dentro `modello` (`voceElenco`), che è ciò che l'elenco senza
      // parametri restituisce: qui si ripete accanto a `spiegazione` perché chi legge
      // questa risposta guarda quel campo, e una risposta in cui il dato buono sta due
      // livelli più in là è una risposta in cui si prende quello sbagliato.
      return NextResponse.json({
        success: true,
        data: {
          modello: descrittore(voce),
          motivo,
          spiegazione: SPIEGAZIONE_NON_GENERABILE[motivo],
          prefill: null,
        },
      })
    }

    if (voce.soggetto === 'sezione') {
      // `sections` viene letta DUE volte per la stessa richiesta — qui dentro
      // (`scope.ts`, che guarda `scuola_id`) e poco più giù in `caricaSezione`, che ha
      // bisogno anche di `name` e `school_type`. Vale per tutte e due le route. Nessun
      // danno di correttezza — è la stessa riga, letta a un millisecondo di distanza — ma
      // sono due andate e ritorno dove ne basterebbe una. Si chiude il giorno in cui
      // `assertSezioneInScope` restituirà la riga letta invece di `null`, ed è una modifica
      // in `src/lib/auth/scope.ts`: segnalata, non fatta qui.
      const fuoriPortata = await assertSezioneInScope(supabase, user, sezioneId)
      if (fuoriPortata) return fuoriPortata

      // `sezioneId` c'è per costruzione (lo schema lo esige quando il soggetto è una
      // sezione), ma il tipo resta opzionale: il ripiego evita un `!` che si fida di una
      // garanzia scritta trenta righe più su.
      //
      // ⚠️ `SOLO_CONTEGGIO`: né diete, né note sanitarie, né recapiti, né insegnanti.
      // Questa risposta contiene un NUMERO — leggere allergie e note mediche di venticinque
      // bambini per rispondere «25» è esattamente il difetto che questo file dichiara di non
      // voler avere. I quattro interruttori esistono per questa riga.
      //
      // ⚠️ `sediAmmesse` è il SECONDO strato, lo stesso che il ramo dell'alunno applica
      // trenta righe più giù: `assertSezioneInScope` verifica i plessi dell'utente, questo
      // rispetta anche la selezione di sede del cookie. Senza, le due strade rispondevano
      // in modo diverso alla stessa domanda — «questa sede è quella che hai davanti?» — e
      // la sezione era la più permissiva delle due. Il rifiuto arriva dentro
      // `caricaSezione`, prima che i bambini vengano letti.
      const caricata = await caricaSezione(supabase, sezioneId ?? '', {
        ...SOLO_CONTEGGIO,
        sediAmmesse: await resolveScuoleAttive(request, supabase, user),
      })
      if (caricata.response) return caricata.response
      const sezione = caricata.sezione

      // ⚠️ DUE NUMERI E NON UNO, ed è la differenza fra ciò che si LEGGE e ciò che si
      // STAMPA. `caricaSezione` porta gli iscritti E i sospesi — lo dichiara, «mai i
      // ritirati» — mentre la stampa i sospesi li esclude salvo richiesta esplicita
      // (`includi_sospesi`, che nasce `false`). Con il solo `alunni.length` il pannello
      // annunciava «25» e il foglio ne stampava 23, senza che niente lo dicesse: due numeri
      // che si contraddicono, di cui uno stampato e appeso. Il criterio è lo stesso del
      // modello (`attivo !== false`), non uno somigliante.
      const iscritti = sezione.alunni.filter((a) => a.attivo !== false).length
      const sospesi = sezione.alunni.length - iscritti

      logEvento('modulistica', 'info', {
        operazione: 'prestampati:GET',
        esito: 'prefill-sezione',
        utente: user.id,
        tipo: voce.slug,
        sezione_id: sezione.sezioneId,
        scuola_id: sezione.scuolaId,
        n: sezione.alunni.length,
      })

      return NextResponse.json({
        success: true,
        data: {
          modello: descrittore(voce),
          prefill: {
            soggetto: 'sezione',
            sezioneId: sezione.sezioneId,
            scuolaId: sezione.scuolaId,
            nome: sezione.nome,
            livello: sezione.livello,
            sede: sezione.sede,
            // CONTEGGI, non le righe: chi compila il form deve sapere quanti bambini
            // finiranno sul foglio, non chi sono e cosa non possono mangiare. Separati,
            // perché il pannello possa scrivere «23 iscritti, 2 sospesi (esclusi salvo
            // richiesta)» — che è la frase vera.
            alunni: { iscritti, sospesi },
          },
        },
      })
    }

    // Soggetto alunno. Il gate di portata è dentro `caricaPrefillAlunno`, che risponde già
    // 401/403/404/409/422/503 con i codici del catalogo: qui non si riscrive nessuna di
    // quelle regole — una regola valida per due strade deve vivere in un posto solo.
    const esito = await caricaPrefillAlunno(request, supabase, alunnoId ?? '')
    if (esito.response) return esito.response
    const prefill = esito.prefill

    // La sede dell'alunno deve stare fra quelle attive di chi guarda. È il secondo strato,
    // e non un doppione del primo: `requireParentOfStudent` verifica il PLESSO PRIMARIO e
    // la sezione, questo rispetta anche la selezione di sede del cookie — cioè risponde
    // «questo bambino non è nella sede che hai davanti» invece di mostrarlo comunque.
    const sedi = await resolveScuoleAttive(request, supabase, user)
    if (!sedi.includes(prefill.scuolaId)) return rifiutoSede('SEDE_NON_ACCESSIBILE')

    // ── IL REGISTRO DEGLI ACCESSI (regola 5 di `docs/prestampati/README.md`) ──
    // DOPO i due gate, mai prima: si registra un accesso AVVENUTO, e una riga scritta
    // sopra un 403 racconterebbe una lettura che non c'è stata. `view` e non `list`
    // perché qui si guarda un bambino solo. `app_log` non è un sostituto — trenta
    // giorni di retention, e non è il registro che il Garante chiede — e questa riga
    // resta anche quando il foglio poi non si genera: l'anagrafica è stata comunque
    // letta.
    await logAccessoFascicolo(supabase, {
      alunnoId: prefill.alunnoId,
      utenteId: user.id,
      azione: 'view',
      finalita: `Precompilato prestampato ${voce.slug}`,
      request,
    })

    // ── IL MOTIVO CHE SI VEDE SOLO ADESSO ─────────────────────────────────────
    // Gli altri tre stanno nel registro e si sanno prima di leggere qualunque cosa; questo
    // sta in `scuole.config.anagrafica` e si sa solo qui, perché è `caricaPrefillAlunno` a
    // leggerlo. Cinque dei sei fogli generabili si chiudono con la firma del legale
    // rappresentante, e senza quel nome il render li rifiuta: dirlo QUI spegne il pulsante
    // prima che qualcuno lo prema — «un pulsante che porta a un 422 è peggio di un pulsante
    // spento», che è il principio che questo stesso codice enuncia in `banco.ts`.
    //
    // Il precompilato si restituisce lo stesso, e non è una contraddizione con il ramo che
    // sopra risponde `prefill: null`: là il motivo si sapeva PRIMA di leggere, e leggere
    // sarebbe stato aprire l'anagrafica di un minore per niente. Qui l'anagrafica è già
    // stata letta — è il solo modo di scoprire questo motivo — e nasconderla dopo non la
    // rimette dov'era. Il form si compila, il pulsante resta spento, la frase dice dove si
    // ripara.
    const motivoDiSede = motivoNonGenerabile(voce, {
      legaleRappresentante: prefill.legaleRappresentante,
    })

    logEvento('modulistica', 'info', {
      operazione: 'prestampati:GET',
      esito: 'prefill-alunno',
      utente: user.id,
      tipo: voce.slug,
      alunno_id: prefill.alunnoId,
      scuola_id: prefill.scuolaId,
      // L'enumerato passa la lista bianca di `redact` ed è ciò che si conta in SQL: è la
      // misura di quante volte lo sportello si è fermato per una configurazione di sede
      // incompleta, che oggi in produzione è ogni volta.
      ...(motivoDiSede ? { evento: `non-generabile:${motivoDiSede}` } : {}),
    })

    return NextResponse.json({
      success: true,
      data: {
        modello: descrittore(voce, { legaleRappresentante: prefill.legaleRappresentante }),
        // `motivo` e `spiegazione` accanto al descrittore, come nel ramo del rifiuto
        // anticipato e per la stessa ragione: chi legge questa risposta guarda quel campo, e
        // una risposta in cui il dato buono sta due livelli più in là è una risposta in cui
        // si prende quello sbagliato.
        ...(motivoDiSede
          ? { motivo: motivoDiSede, spiegazione: SPIEGAZIONE_NON_GENERABILE[motivoDiSede] }
          : {}),
        prefill: {
          soggetto: 'alunno',
          alunnoId: prefill.alunnoId,
          scuolaId: prefill.scuolaId,
          sezioneId: prefill.sezioneId,
          legaleRappresentante: prefill.legaleRappresentante,
          // `dati` è il precompilato dei modelli, così com'è: nome, nascita, codice
          // fiscale, sezione, sede, ente gestore, genitori, anno scolastico. Niente dati
          // sanitari — `caricaPrefillAlunno` non li legge affatto.
          dati: prefill.dati,
        },
      },
    })
  } catch (err) {
    // Il messaggio interno resta nel log: su una rotta che parla dei documenti di un
    // minore, il testo di un'eccezione può nominare tabelle e vincoli.
    //
    // ⚠️ `stato` È LO STATUS CHE SI RESTITUISCE DAVVERO, e qui erano due numeri diversi:
    // il log diceva 500 e la risposta 503. Chi cerca in `app_log` la riga di un 503 non la
    // trovava, e chi leggeva `stato=500` andava a cercare un 500 mai servito — due bugie
    // che si coprono a vicenda. Ed è 500 e non 503 anche nella risposta: un'eccezione
    // imprevista è un difetto permanente, non un guasto temporaneo. Il 503 resta dov'è vero
    // — la lettura fallita di `banco.ts`, che una seconda volta può riuscire.
    //
    // ⚠️ MA A SCHERMO NON CAMBIA NIENTE, e va detto invece di lasciarlo credere. Questa
    // correzione riguarda lo STATUS e il log, non la frase: il pannello mostra il testo di
    // catalogo del `codice` (`messaggioDaCorpo`, in `src/lib/ui/esito-fetch.ts`, che scarta
    // `error`), e la frase di `PRESTAMPATI_ELENCO_NON_LETTO` finisce con «Riprova fra
    // qualche minuto» in tutte e due le lingue. Quindi l'operatore quel pulsante lo
    // ripreme lo stesso.
    //
    // Il codice giusto per un'eccezione imprevista — una frase che non inviti a riprovare —
    // oggi non esiste: dei 51 codici del catalogo la cui frase non dice «riprova», nessuno
    // parla di un guasto interno. Crearne uno vuol dire toccare `CODICI_ERRORE` e i due
    // cataloghi, che non sono di questa mano: **è chiesto nelle note del lavoro**, insieme
    // alle tre chiavi dei motivi. Finché non c'è, questo codice è il meno sbagliato — dice
    // almeno che l'elenco non si è letto — e questo commento non promette di più.
    logErrore({ operazione: 'prestampati:GET', stato: 500 }, err)
    return NextResponse.json(
      {
        error: 'Non è stato possibile leggere la modulistica.',
        codice: 'PRESTAMPATI_ELENCO_NON_LETTO',
      },
      { status: 500 },
    )
  }
})
