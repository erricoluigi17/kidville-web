import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertAlunnoInScope } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { confermaValida } from '@/lib/gdpr/anonimizza'
import { anonimizzaAlunno, anonimizzaParent } from '@/lib/gdpr/esegui'
import { parentHaAltriFigliIscritti } from '@/lib/gdpr/orfano'
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
    const { data: alunno } = await supabase
      .from('alunni')
      .select('id, nome, cognome, stato, anonimizzato_il, documento_path, codice_fiscale, fiscal_code')
      .eq('id', alunno_id)
      .maybeSingle()
    if (!alunno) return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })

    // Isolamento per sede, PRIMA di qualunque effetto. È l'operazione più grave
    // dell'applicazione — anonimizzazione irreversibile di un minore e dei suoi
    // genitori — e l'unico controllo era il ruolo: la Direzione di un plesso
    // poteva cancellare i dati di un bambino di un altro plesso, e non esiste un
    // annulla. Vale anche in `dryrun`: il dry-run restituisce nome e cognome.
    const fuoriScope = await assertAlunnoInScope(supabase, auth.user, alunno_id)
    if (fuoriScope) return fuoriScope

    // Si cancella SOLO un alunno non iscritto (diritto all'oblio post-uscita).
    if (alunno.stato === 'iscritto') {
      return NextResponse.json(
        { error: 'Operazione consentita solo su alunni non iscritti' },
        { status: 409 }
      )
    }

    // Genitori collegati (anagrafica reale `parents` via `student_parents`).
    const { data: links } = await supabase
      .from('student_parents')
      .select('parent_id')
      .eq('student_id', alunno_id)
    const parentIds = (links ?? []).map((l: { parent_id: string }) => l.parent_id)

    // Genitori "orfani" (nessun altro figlio iscritto) → anonimizzabili.
    const parentiOrfani: string[] = []
    for (const pid of parentIds) {
      const altri = await parentHaAltriFigliIscritti(supabase, pid, alunno_id)
      if (!altri) parentiOrfani.push(pid)
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

      return NextResponse.json({
        dryrun: true,
        alunno: 1,
        parents: parentiOrfani.length,
        parents_non_anonimizzati: parentIds.length - parentiOrfani.length,
        file_da_rimuovere: fileAnagrafica.length,
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
    for (const pid of parentiOrfani) {
      const e = await anonimizzaParent(supabase, pid, at, OP)
      newsVisualizzazioniRimosse += e.newsVisualizzazioniRimosse
      consensiProvaBonificati += e.provaConsensiScrubbate
      pushRimosse += e.pushSubscriptionsRimosse
      iscrizioniAdulti += e.iscrizioniScrubbate
      fileAdultiRimossi += e.fileRimossi
      fileAdultiNonRimossi += e.fileNonRimossi
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
