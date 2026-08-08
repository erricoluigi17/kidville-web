import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireParentOfStudent } from '@/lib/auth/require-parent'
import { parseQuery } from '@/lib/validation/http'
import {
  calcolaOreAssenza,
  giornataDaCampanelle,
  type PresenzaInput,
  type StatoPresenza,
} from '@/lib/primaria/oreAssenza'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { oggiFiscaleISO } from '@/lib/format/fiscal-date'
import {
  COLONNE_SORGENTE,
  eAssenzaSoloAnnunciata,
  limitaAgliAnnunciAperti,
  limitaAiFatti,
} from '@/lib/presenze/finestra-trascorsa'

// ── Vista genitore (read-only) delle presenze del figlio. ────────────────────
// A differenza di `parent/primaria/assenze` (cronologia delle sole assenze),
// questo endpoint alimenta la HOME:
//  - `oggi`: stato dell'appello odierno → badge "A scuola" in dashboard;
//    `stato: null` = appello non ancora registrato dal docente.
//  - `riepilogo`: conteggi presenze/assenze/ritardi/uscite degli ultimi 30 giorni
//    (+ monte ore perse per la primaria, riusando il calcolo del registro).
// La tabella `presenze` è condivisa da tutti i gradi (UNIQUE alunno_id,data).
// Auth e scoping ricalcano la route sorella: identità via `getRequestUserId`
// (header/`userId`), lettura per `alunno_id` con service-role.

// studentId lasco (niente zUuid): un valore non-GUID produce lista vuota dalla
// query su `presenze` — stesso criterio di parent/primaria/assenze.
const getQuerySchema = z.object({
  studentId: z.string({ error: 'studentId obbligatorio' }).min(1, 'studentId obbligatorio'),
})

export const GET = withRoute('parent/presenze:GET', async (request: NextRequest) => {
  try {
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { studentId } = q.data

    const auth = await requireParentOfStudent(request, studentId)
    if (auth.response) return auth.response

    const supabase = await createAdminClient()

    // «NON C'È» E «NON L'HO POTUTO LEGGERE» NON SONO LA STESSA COSA.
    //
    // PostgREST non lancia: l'errore torna nel valore. Senza questo controllo una
    // lettura fallita lasciava `alunno` a `null` e il flusso cadeva nella porta
    // del 404 qui sotto — al genitore si diceva che suo figlio non esiste, per un
    // guasto del database. È la stessa bugia che la route gemella
    // (`comunica-assenza`) dichiara di aver corretto, e che qui era rimasta.
    const { data: alunno, error: alunnoErr } = await supabase
      .from('alunni')
      .select('id, section_id, scuola_id')
      .eq('id', studentId)
      .maybeSingle()
    if (alunnoErr) {
      logErrore({ operazione: 'parent/presenze:GET', stato: 500, evento: 'db' }, alunnoErr)
      return NextResponse.json(
        { error: 'Errore interno', codice: 'PRESENZE_NON_LETTE' },
        { status: 500 },
      )
    }
    if (!alunno) {
      return NextResponse.json(
        { error: 'Alunno non trovato', codice: 'ALUNNO_NON_TROVATO' },
        { status: 404 },
      )
    }

    // Tipo scuola della sezione (per la vista adattiva lato client).
    let schoolType: string | null = null
    if (alunno.section_id) {
      const { data: sez, error: sezErr } = await supabase
        .from('sections')
        .select('school_type')
        .eq('id', alunno.section_id)
        .maybeSingle()
      if (sezErr) {
        // `warn` e non `error`: la vista degrada a «grado sconosciuto», che è
        // recuperabile. Muto no: senza questa riga un grado illeggibile è
        // indistinguibile da una sezione che il grado non ce l'ha, e la home del
        // genitore della primaria perde il monte ore senza che nessuno sappia
        // perché.
        logEvento('registro', 'warn', {
          operazione: 'parent/presenze:GET',
          esito: 'grado-non-letto',
          sezione_id: alunno.section_id as string,
        }, sezErr)
      }
      schoolType = sez?.school_type ?? null
    }

    // «Oggi» nel fuso Europe/Rome, non in UTC. Il runtime (Vercel) gira in UTC:
    // con `new Date().toISOString()` — che è ciò che stava qui — fra mezzanotte e
    // le 01:00 (02:00 in ora legale) italiane la data restituita è ancora quella
    // del giorno prima. Qui costa DUE errori insieme: il badge della home mostra
    // l'appello di ieri, e un'assenza ormai passata resta nell'elenco di quelle
    // annullabili. È lo stesso difetto per cui esiste `oggiFiscaleISO()`.
    const oggiData = oggiFiscaleISO()
    // La finestra dei 30 giorni si ancora allo STESSO giorno italiano: due sorgenti
    // diverse per "oggi" nella stessa risposta si contraddirebbero proprio nella
    // fascia in cui il fuso morde.
    const from = new Date(Date.parse(`${oggiData}T00:00:00Z`) - 30 * 86_400_000)
      .toISOString()
      .slice(0, 10)

    const [oggiRes, periodoRes, comunicateRes] = await Promise.all([
      // Presenza di oggi (può non esistere se l'appello non è ancora stato fatto).
      //
      // Le colonne della PROVENIENZA si chiedono anche qui, e non per esibirle:
      // sul giorno corrente la data non discrimina, e senza di esse un'assenza
      // soltanto ANNUNCIATA dal genitore usciva come `stato: 'assente'` —
      // contraddicendo il contratto dichiarato in cima a questa rotta e il
      // messaggio neutro di `PresenzeTodayCard`.
      supabase
        .from('presenze')
        .select(`stato, orario_entrata, orario_uscita, ${COLONNE_SORGENTE}`)
        .eq('alunno_id', studentId)
        .eq('data', oggiData)
        .maybeSingle(),
      // Presenze degli ultimi 30 giorni per il riepilogo — i soli FATTI.
      // `limitaAiFatti` aggiunge al tetto temporale il filtro sulla sorgente:
      // il `.lte` da solo non può escludere una riga che cade su OGGI, che è
      // esattamente il giorno preimpostato dal modulo del genitore.
      limitaAiFatti(
        supabase
          .from('presenze')
          .select('stato, orario_entrata, orario_uscita, data')
          .eq('alunno_id', studentId)
          .gte('data', from),
        'data',
        oggiData,
      ),
      // Assenze COMUNICATE dal genitore e ancora annullabili. Senza questo
      // elenco il genitore non rivede ciò che ha inviato — e non può annullarlo.
      //
      // I tre termini che le distinguono NON si scrivono più qui: sono la stessa
      // finestra che `comunica-assenza:DELETE` applica per decidere se accettare
      // l'annullamento, e che `eAssenzaSoloAnnunciata` applica per tenere gli
      // annunci fuori dai conteggi. Erano ricopiati, e coincidevano — finché
      // qualcuno non avesse toccato uno dei due: il genitore avrebbe visto il
      // bottone «Annulla» su una riga che il server rifiuta, o non l'avrebbe
      // visto su una che poteva ancora ritirare. Una regola valida per due
      // strade deve vivere in un posto solo.
      limitaAgliAnnunciAperti(
        supabase
          .from('presenze')
          .select('id, data, giustificazione_testo, stato')
          .eq('alunno_id', studentId),
        'data',
        oggiData,
      ).order('data', { ascending: true }),
    ])

    // PostgREST NON lancia: l'errore torna nel valore, e un try/catch qui attorno
    // non scatterebbe mai. La home non deve rompersi per un elenco accessorio, ma
    // il degrado non può essere muto: senza questa riga «nessuna assenza
    // comunicata» sarebbe indistinguibile da «la query non ha funzionato».
    //
    // ⚠️ IL LOG NON BASTA, E QUESTA È LA LEZIONE CHE COSTA. Il log lo leggiamo
    // NOI; il genitore legge lo schermo, e lo schermo riceveva un 200 valido con
    // `comunicate: []` — cioè «non hai comunicato nessuna assenza» detto a chi ne
    // ha, e che quindi non può nemmeno annullarle. Le due schermate che lo
    // consumano hanno un ramo d'errore già scritto e funzionante che su questo
    // guasto non veniva MAI raggiunto, perché la risposta era formalmente buona.
    // Da qui `comunicateLette` (più sotto, nel payload): il degrado si DICHIARA.
    if (comunicateRes.error) {
      logEvento(
        'registro',
        'error',
        { operazione: 'parent/presenze:GET', esito: 'comunicate_non_lette' },
        comunicateRes.error,
      )
    }

    // LO STESSO TRATTAMENTO ALLE ALTRE DUE LETTURE, ed è la parte che mancava.
    //
    // `oggi` e `periodo` destrutturavano il solo `data`: una lettura fallita
    // usciva come `stato: null` («l'appello non è ancora stato fatto») e come una
    // fila di ZERI nel riepilogo («tuo figlio non è mai stato assente»), con un
    // 200 valido e senza una riga di log. Un guasto che si traveste da dato è
    // peggio di un errore: nessuno lo cerca, perché a schermo non c'è niente di
    // strano.
    //
    // La home NON si rompe — sono due riquadri, non l'app — ma il degrado si
    // DICHIARA, come già fa `comunicate`: i due flag qui sotto sono l'unica cosa
    // che permette a chi guarda lo schermo di distinguere «non ne hai» da «non
    // sono riuscito a leggerle». Il log lo leggiamo noi; il genitore legge lo
    // schermo.
    const oggiRow = oggiRes.data
    const periodo = periodoRes.data
    if (oggiRes.error) {
      logEvento(
        'registro',
        'error',
        { operazione: 'parent/presenze:GET', esito: 'appello-oggi-non-letto', alunno_id: studentId },
        oggiRes.error,
      )
    }
    if (periodoRes.error) {
      logEvento(
        'registro',
        'error',
        { operazione: 'parent/presenze:GET', esito: 'riepilogo-non-letto', alunno_id: studentId },
        periodoRes.error,
      )
    }
    // Solo metadati: `giustificazione_testo` è testo libero scritto da un genitore
    // (può contenere motivi di salute del bambino) e non entra in nessun log.
    const comunicate = (comunicateRes.data ?? []) as {
      id: string
      data: string
      giustificazione_testo: string | null
      stato: string
    }[]

    const rows = (periodo ?? []) as {
      stato: string
      orario_entrata: string | null
      orario_uscita: string | null
    }[]
    const conteggi = { presenze: 0, assenze: 0, ritardi: 0, uscite: 0 }
    for (const r of rows) {
      if (r.stato === 'presente') conteggi.presenze++
      else if (r.stato === 'assente') conteggi.assenze++
      else if (r.stato === 'ritardo') conteggi.ritardi++
      else if (r.stato === 'uscita_anticipata') conteggi.uscite++
    }

    const riepilogo: Record<string, unknown> = { from, to: oggiData, ...conteggi }

    // Primaria: monte ore perse, riusando il calcolo del registro di classe.
    if (schoolType === 'primaria' && alunno.section_id) {
      const { data: campanelle, error: campanelleErr } = await supabase
        .from('campanelle')
        .select('ora_inizio, ora_fine, tipo')
        .eq('section_id', alunno.section_id)
      if (campanelleErr) {
        // Senza campanelle il monte ore esce a zero: un numero, non un vuoto —
        // cioè la forma di degrado che si legge come un dato. Il calcolo prosegue
        // (il resto della home vale comunque), ma la riga resta.
        logEvento('registro', 'error', {
          operazione: 'parent/presenze:GET',
          esito: 'campanelle-non-lette',
          sezione_id: alunno.section_id as string,
        }, campanelleErr)
      }
      const giornata = giornataDaCampanelle(campanelle ?? [])
      const presenzeInput: PresenzaInput[] = rows.map((r) => ({
        stato: r.stato as StatoPresenza,
        orario_entrata: r.orario_entrata,
        orario_uscita: r.orario_uscita,
      }))
      riepilogo.ore = calcolaOreAssenza(presenzeInput, giornata)
    }

    return NextResponse.json({
      success: true,
      data: {
        schoolType,
        oggi: {
          // ANNUNCIATO NON È ACCADUTO (Q4). Una riga scritta dal genitore e non
          // ancora lavorata dall'appello NON è lo stato del bambino a scuola: è
          // un avviso che riguarda il resto della giornata. Restituirla come
          // `stato: 'assente'` faceva dire alla home «ASSENTE» prima che
          // qualcuno l'avesse visto — o non visto — entrare.
          //
          // `null` è il valore che il contratto di questa rotta dichiara da
          // sempre («appello non ancora registrato dal docente») e che
          // `PresenzeTodayCard` rende con un messaggio neutro. Ciò che il
          // genitore ha comunicato lo rivede in `comunicate`, dove può anche
          // annullarlo: si toglie dal CONTEGGIO, non dalla vista.
          //
          // Il giorno si DICHIARA (`data: oggiData`) invece di lasciarlo
          // indovinare: la `select` qui sopra non porta la colonna `data`, e da
          // R15 l'annuncio ha una scadenza che si valuta proprio su quella. Senza
          // dichiararlo si ricadrebbe sul ramo prudente della funzione — stesso
          // risultato oggi, ma per caso invece che per costruzione.
          stato: (eAssenzaSoloAnnunciata({ ...oggiRow, data: oggiData }, oggiData)
            ? null
            : oggiRow?.stato ?? null) as StatoPresenza | null,
          orario_entrata: oggiRow?.orario_entrata ?? null,
          orario_uscita: oggiRow?.orario_uscita ?? null,
        },
        riepilogo,
        comunicate,
        /**
         * L'elenco è stato LETTO DAVVERO? Additivo di proposito: `oggi` e
         * `riepilogo` non cambiano forma, perché ci vive sopra
         * `PresenzeTodayCard`, e nessun client esistente si rompe se lo ignora.
         *
         * È l'unica cosa che permette a chi guarda lo schermo di distinguere
         * «non ne hai» da «non sono riuscito a leggerle»: con il solo
         * `comunicate: []` le due situazioni sono lo stesso 200, e la seconda
         * toglie al genitore anche il modo di annullare ciò che ha comunicato.
         *
         * `true` quando la query è andata a buon fine, ANCHE se non ha trovato
         * niente: il vuoto vero è un'informazione, e va detto come tale.
         */
        comunicateLette: !comunicateRes.error,
        /**
         * Gli stessi due flag per le altre due letture. Sono SEPARATI perché sono
         * due query e possono fallire una per volta: `oggi` alimenta il badge «A
         * scuola», `riepilogo` i conteggi dei 30 giorni. Un flag solo per
         * entrambe direbbe «non lo so» anche della metà che si è letta bene.
         *
         * Additivi, come `comunicateLette`: nessun client esistente si rompe se
         * li ignora, e chi vuole distinguere «zero assenze» da «non sono
         * riuscito a contarle» ora ha di che.
         */
        oggiLetto: !oggiRes.error,
        riepilogoLetto: !periodoRes.error,
      },
    })
  } catch (err) {
    logErrore({ operazione: 'parent/presenze:GET', stato: 500 }, err)
    // Il messaggio dell'eccezione NON esce verso il genitore: era
    // `{ error: err.message }`, cioè prosa inglese di libreria — nomi di colonne,
    // dettagli del pool — mostrata a una famiglia. Il motivo tecnico resta nel
    // log, che è dove serve, e a schermo va un codice che la lingua ce l'ha.
    return NextResponse.json(
      { error: 'Errore interno', codice: 'PRESENZE_NON_LETTE' },
      { status: 500 },
    )
  }
})
