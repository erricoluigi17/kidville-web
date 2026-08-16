import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive, scuoleDiUtente } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { anonimizzaParent, anonimizzaAlunno, type AlunnoOblio } from '@/lib/gdpr/esegui'
import { contaCosaDistrugge, sommaConteggiOblio } from '@/lib/gdpr/cosa-distrugge'
import { eNonPiuIscritto, eAncoraIscritto } from '@/lib/alunni/stato'
import { schemaAssente } from '@/lib/news/schema-assente'
import { parseBody } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// =============================================================================
// Evasione delle richieste di cancellazione account (Direzione).
// GET: elenco richieste pending arricchito (nome genitore + figli). POST: dry-run
// / execute → anonimizza il genitore + i figli NON iscritti (i figli iscritti
// restano: la scuola è titolare del trattamento per gli iscritti).
// =============================================================================

const DIREZIONE = ['admin', 'coordinator'] as const
const CONFERMA = 'ANONIMIZZA'

const postBodySchema = z.object({
  id: z.string().min(1),
  mode: z.enum(['dryrun', 'execute']),
  confirm: z.unknown().optional(),
})

export const GET = withRoute('admin/gdpr/richieste:GET', async (request: NextRequest) => {
  const auth = await requireStaff(request, [...DIREZIONE])
  if (auth.response) return auth.response
  try {
    const admin = await createAdminClient()
    // Isolamento per sede: la colonna `scuola_id` c'era già su questa tabella e
    // veniva LETTA nella POST, ma non confrontata con niente — e qui non era
    // nemmeno letta. Scope vuoto ⇒ nessuna richiesta.
    const plessi = await resolveScuoleAttive(request, admin, auth.user)
    const { data: richieste, error } = await admin
      .from('richieste_cancellazione')
      .select('id, parent_id, creata_il')
      .in('scuola_id', plessi)
      .eq('stato', 'pending')
      .order('creata_il', { ascending: true })
    if (error) {
      if (schemaAssente(error)) return NextResponse.json([])
      logErrore({ operazione: 'admin/gdpr/richieste:GET', stato: 500 }, error)
      return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
    }

    // Scope dei FIGLI, distinto dal filtro dell'elenco: i conteggi mostrati qui
    // devono coincidere con ciò che la POST anonimizzerà davvero, e quella non
    // dipende dal cookie del SedeSelector (vedi il commento nella POST).
    const accessibili = await scuoleDiUtente(admin, auth.user)

    const rows = (richieste ?? []) as { id: string; parent_id: string; creata_il: string }[]
    const out: Array<Record<string, unknown>> = []
    // Le tre letture dell'elenco degradano a «—» e a «0 figli», e fino al terzo
    // collaudo lo facevano IN SILENZIO: la Direzione leggeva «0 figli» su una
    // richiesta che ne aveva, senza nessun segnale. Qui non si può rispondere
    // 500 (una richiesta illeggibile non deve nascondere le altre nove), ma il
    // degrado si CONTA: `warn`, con solo uuid e conteggi. Il numero su cui si
    // agisce davvero resta quello del `dryrun`, che ora si ferma sul guasto.
    const conteggiIncerti = (esito: string, richiestaId: string, err: unknown) => {
      logEvento('gdpr', 'warn', {
        operazione: 'admin/gdpr/richieste:GET',
        esito,
        richiesta: richiestaId,
      }, err)
    }

    for (const r of rows) {
      const { data: parent, error: parentErr } = await admin
        .from('parents')
        .select('first_name, last_name')
        .eq('id', r.parent_id)
        .maybeSingle()
      if (parentErr) conteggiIncerti('nome-genitore-non-letto', r.id, parentErr)
      const nome = parent
        ? `${(parent.first_name ?? '').toString().trim()} ${(parent.last_name ?? '').toString().trim()}`.trim()
        : ''

      const { data: links, error: linksErr } = await admin
        .from('student_parents')
        .select('student_id')
        .eq('parent_id', r.parent_id)
      if (linksErr) conteggiIncerti('legami-non-letti', r.id, linksErr)
      const childIds = ((links ?? []) as { student_id: string }[]).map((l) => l.student_id)
      let iscritti = 0
      let nonIscritti = 0
      let fuoriScope = 0
      if (childIds.length > 0) {
        const { data: figli, error: figliErr } = await admin
          .from('alunni')
          .select('id, stato, anonimizzato_il, scuola_id')
          .in('id', childIds)
        if (figliErr) conteggiIncerti('figli-non-letti', r.id, figliErr)
        for (const f of (figli ?? []) as {
          stato: string | null
          anonimizzato_il: string | null
          scuola_id: string | null
        }[]) {
          if (f.anonimizzato_il) continue
          // Un figlio di un altro plesso non entra nei conteggi di QUESTA
          // Direzione: si dichiara a parte, così il numero mostrato è quello su
          // cui si potrà davvero agire. Sede assente ⇒ fuori scope (fail-closed).
          if (!f.scuola_id || !accessibili.includes(f.scuola_id)) {
            fuoriScope++
            continue
          }
          // Lo stesso confine dell'esecuzione (`eNonPiuIscritto` qui sotto): questo
          // conteggio è ciò che la Direzione legge nell'elenco delle richieste,
          // e se contasse i figli in un modo diverso da come poi li anonimizza,
          // mostrerebbe un numero che non descrive l'operazione che sta per fare.
          if (eAncoraIscritto(f.stato)) iscritti++
          else nonIscritti++
        }
      }
      out.push({
        id: r.id,
        creata_il: r.creata_il,
        parent_nome: nome || '—',
        alunni_iscritti: iscritti,
        alunni_non_iscritti: nonIscritti,
        alunni_fuori_scope: fuoriScope,
      })
    }
    return NextResponse.json(out)
  } catch (err) {
    logErrore({ operazione: 'admin/gdpr/richieste:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
  }
})

export const POST = withRoute('admin/gdpr/richieste:POST', async (request: NextRequest) => {
  const auth = await requireStaff(request, [...DIREZIONE])
  if (auth.response) return auth.response

  const b = await parseBody(request, postBodySchema)
  if ('response' in b) return b.response
  const { id, mode, confirm } = b.data

  try {
    const admin = await createAdminClient()
    const { data: richiesta, error: errR } = await admin
      .from('richieste_cancellazione')
      .select('id, parent_id, stato, scuola_id')
      .eq('id', id)
      .maybeSingle()
    if (errR) {
      if (schemaAssente(errR)) return NextResponse.json({ error: 'Richiesta non trovata' }, { status: 404 })
      logErrore({ operazione: 'admin/gdpr/richieste:POST', stato: 500 }, errR)
      return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
    }
    if (!richiesta) return NextResponse.json({ error: 'Richiesta non trovata' }, { status: 404 })

    // Isolamento per sede, PRIMA di anonimizzare: `scuola_id` era letto e mai
    // confrontato. Una sede nulla ⇒ si NEGA, non si apre: non c'è modo di
    // stabilire il plesso e questa operazione è irreversibile. In produzione la
    // tabella è vuota (verificato il 2026-07-30), quindi la regola stretta non
    // lascia indietro nessuna richiesta già presentata.
    const plessi = await resolveScuoleAttive(request, admin, auth.user)
    const sedeRichiesta = (richiesta.scuola_id as string | null) ?? null
    if (!sedeRichiesta || !plessi.includes(sedeRichiesta)) {
      return NextResponse.json({ error: 'Richiesta fuori dal tuo plesso' }, { status: 403 })
    }

    if (richiesta.stato !== 'pending') {
      return NextResponse.json({ error: 'Richiesta già gestita' }, { status: 409 })
    }

    const parentId = richiesta.parent_id as string

    // ─── SE NON SI SA CHI, NON SI TOCCA NIENTE (rilievo T15) ────────────────
    //
    // PostgREST non lancia: ritorna `{ error }` (AGENTS.md, regola 7). Queste due
    // letture non stabiliscono un dettaglio, stabiliscono l'INSIEME su cui l'oblio
    // agisce: con `links` a `[]` il flusso proseguiva fino in fondo —
    // `childIds=[]` → `figli=[]` → nessun `anonimizzaAlunno` → `esito.alunni = 0`
    // → richiesta marcata `evasa`. Il genitore anonimizzato, i BAMBINI no, e la
    // pratica chiusa: un oblio eseguito a metà che risulta concluso non lo ripete
    // più nessuno.
    //
    // Il controllo sta PRIMA di `anonimizzaParent`, e non è un dettaglio d'ordine:
    // fermarsi dopo lascerebbe comunque l'oblio a metà, solo dall'altro lato.
    // La richiesta resta `pending`, cioè ripetibile — che è la sola forma di
    // riparazione possibile per un'operazione senza annulla.
    //
    // La rotta sorella `admin/gdpr/erase` ha questo identico controllo sulla
    // stessa identica query dal 2026-08-07: qui non era arrivato.
    const { data: links, error: linksErr } = await admin
      .from('student_parents')
      .select('student_id')
      .eq('parent_id', parentId)
    if (linksErr && !schemaAssente(linksErr)) {
      logErrore({ operazione: 'admin/gdpr/richieste:POST', stato: 500, evento: 'db' }, linksErr)
      return NextResponse.json({ error: 'Errore interno', codice: 'GDPR_ERASE_NON_RIUSCITO' }, { status: 500 })
    }
    const childIds = ((links ?? []) as { student_id: string }[]).map((l) => l.student_id)
    type Figlio = {
      id: string
      stato: string | null
      anonimizzato_il: string | null
      scuola_id: string | null
      documento_path: string | null
      codice_fiscale: string | null
      fiscal_code: string | null
    }
    let figli: Figlio[] = []
    if (childIds.length > 0) {
      // Stessa regola della lettura qui sopra: senza l'anagrafica non si sa
      // quali figli sono iscritti (si mantengono) e quali no (si anonimizzano).
      // Un elenco vuoto per guasto anonimizzerebbe zero minori dichiarando di
      // averli trattati tutti.
      const { data, error: figliErr } = await admin
        .from('alunni')
        .select('id, stato, anonimizzato_il, scuola_id, documento_path, codice_fiscale, fiscal_code')
        .in('id', childIds)
      if (figliErr && !schemaAssente(figliErr)) {
        logErrore({ operazione: 'admin/gdpr/richieste:POST', stato: 500, evento: 'db' }, figliErr)
        return NextResponse.json({ error: 'Errore interno', codice: 'GDPR_ERASE_NON_RIUSCITO' }, { status: 500 })
      }
      figli = (data ?? []) as Figlio[]
    }

    // ─── ISOLAMENTO FRA SEDI DEI FIGLI (F5) ──────────────────────────────────
    // La sede della RICHIESTA era verificata (sopra), quella dei FIGLI no: si
    // raccoglievano tutti i legami di `student_parents` e si anonimizzava ogni
    // non iscritto. Un genitore con figli in due plessi bastava perché la
    // Direzione di uno rendesse IRREVERSIBILMENTE anonimo il minore dell'altro —
    // e ne cancellasse il documento dallo storage — senza che la Direzione
    // competente lo vedesse mai. La route gemella `admin/gdpr/erase` fa
    // `assertAlunnoInScope` esattamente per questo motivo: le due strade
    // divergevano sull'operazione più grave dell'applicazione, quella senza annulla.
    //
    // Lo scope è `scuoleDiUtente` — le sedi ACCESSIBILI — e NON
    // `resolveScuoleAttive`: il cookie del SedeSelector è una preferenza di
    // vista, e non può decidere quale minore riceve l'oblio che suo padre ha
    // chiesto. Con `resolveScuoleAttive` una spunta tolta dalla barra avrebbe
    // ridotto in silenzio l'esecuzione, e la richiesta si chiude qui: il figlio
    // saltato non sarebbe stato ripreso da nessuno. Per admin/coordinator (gli
    // unici ruoli ammessi) il filtro per sede coincide con `assertAlunnoInScope`,
    // che per loro non aggiunge il vincolo di sezione.
    //
    // Sede assente sulla riga ⇒ fuori scope: un minore senza plesso non è
    // attribuibile a nessuna Direzione, e questa operazione non si indovina.
    const accessibili = await scuoleDiUtente(admin, auth.user)
    const vivi = figli.filter((f) => !f.anonimizzato_il)
    const inScope = vivi.filter((f) => f.scuola_id && accessibili.includes(f.scuola_id))
    const fuoriScope = vivi.length - inScope.length
    // ELENCO, non negazione — ed è l'istanza più grave, perché qui l'oblio è in
    // BLOCCO e la Direzione conferma vedendo dei CONTEGGI, non dei nomi. Fino al
    // 2026-08-12 era `f.stato !== 'iscritto'`: un fratello soltanto `sospeso`
    // (iscritto a tutti gli effetti) veniva anonimizzato insieme agli altri, e
    // nessuno l'avrebbe mai saputo. `eAncoraIscritto` è il complemento esatto di
    // `eNonPiuIscritto`: i due numeri qui sotto non possono divergere.
    const nonIscritti = inScope.filter((f) => eNonPiuIscritto(f.stato))
    const iscrittiMantenuti = inScope.filter((f) => eAncoraIscritto(f.stato)).length

    if (mode === 'dryrun') {
      // ⚠️ E QUI IL DRY-RUN SMETTE DI MOSTRARE SOLO DEI CONTEGGI DI PERSONE.
      //
      // Fino al 2026-08-13 rispondeva quattro numeri — genitore, figli non
      // iscritti, figli mantenuti, figli fuori scope — e la Direzione digitava
      // ANONIMIZZA senza che da nessuna parte fosse scritto che se ne vanno le
      // PAGELLE dei bambini, i loro CERTIFICATI MEDICI, le foto, gli allegati di
      // chat e il PDF delle credenziali del genitore. Il commento venti righe
      // più su lo diceva («qui l'oblio è in BLOCCO e la Direzione conferma
      // vedendo dei CONTEGGI»): un commento non è un avviso, e questo è il
      // canale che evade la richiesta VERA di una famiglia, su più figli con una
      // conferma sola.
      //
      // `contaCosaDistrugge` fa SOLE `SELECT`, gira per ciascun figlio che verrà
      // anonimizzato e i totali si sommano con `sommaConteggiOblio`, dove un
      // solo `null` annulla la somma: un totale che salta un bambino non
      // misurato è più basso del vero e ha l'aria di una misura.
      const conteggi = sommaConteggiOblio(
        await Promise.all(nonIscritti.map((f) => contaCosaDistrugge(admin, f.id, 'admin/gdpr/richieste:POST'))),
      )

      // I documenti d'identità che escono dal bucket: quello di ogni figlio
      // anonimizzato più quello del genitore, che qui è SEMPRE anonimizzato (la
      // richiesta è sua). Come nella route sorella è un MINIMO — gli allegati
      // che solo la domanda d'iscrizione conosce si trovano eseguendo — e il
      // riquadro lo scrive: «almeno N».
      const documenti = nonIscritti
        .map((f) => f.documento_path)
        .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      let fileDaRimuovere: number | null = documenti.length
      const { data: docParent, error: errDocParent } = await admin
        .from('parents')
        .select('documento_path')
        .eq('id', parentId)
        .maybeSingle()
      if (errDocParent && !schemaAssente(errDocParent)) {
        // PostgREST non lancia: senza questo controllo un guasto di lettura
        // diventerebbe «nessun documento», cioè un numero più basso del vero
        // presentato come misura. `null` ⇒ il riquadro dice «non misurato».
        logErrore({ operazione: 'admin/gdpr/richieste:POST', evento: 'dryrun_documento_genitore' }, errDocParent)
        fileDaRimuovere = null
      } else if (typeof docParent?.documento_path === 'string' && docParent.documento_path.trim().length > 0) {
        fileDaRimuovere = documenti.length + 1
      }

      return NextResponse.json({
        dryrun: true,
        parent: 1,
        alunni_non_iscritti: nonIscritti.length,
        alunni_iscritti_mantenuti: iscrittiMantenuti,
        alunni_fuori_scope: fuoriScope,
        ...conteggi,
        file_da_rimuovere: fileDaRimuovere,
      })
    }

    // execute: conferma testuale.
    if (typeof confirm !== 'string' || confirm.trim().toUpperCase() !== CONFERMA) {
      return NextResponse.json({ error: `Conferma non valida: digita ${CONFERMA}` }, { status: 400 })
    }

    const at = new Date().toISOString()
    const op = 'admin/gdpr/richieste:POST'

    // Il residuo NON si tace: la richiesta si chiude qui (stato 'evasa') ma una
    // parte dell'oblio resta da fare in un altro plesso. Riga PERSISTITA (`gdpr`
    // è in EVENTI_PERSISTITI) con solo conteggi e uuid: nessun dato di minori.
    if (fuoriScope > 0) {
      logEvento('gdpr', 'warn', {
        operazione: op,
        esito: 'figli-fuori-scope',
        richiesta: id,
        n: fuoriScope,
      })
    }

    // 1. Anonimizza il genitore richiedente.
    const rParent = await anonimizzaParent(admin, parentId, at, op)
    const newsVisualizzazioniRimosse = rParent.newsVisualizzazioniRimosse
    // W5: prove di consenso ripulite di `ip`/`user_agent` (il fatto resta).
    const consensiProvaBonificati = rParent.provaConsensiScrubbate ?? 0
    let segnalazioni = rParent.segnalazioniBonificate
    let sospensioni = rParent.sospensioniBonificate
    // S22 — l'oblio segue il dato: domanda d'iscrizione, allegati e foto. I
    // conteggi arrivano fin qui perché un oblio PARZIALE dev'essere visibile a
    // chi lo esegue e a chi rilegge la richiesta fra un mese: `esito` viene
    // persistito sulla riga e nell'audit. `?? 0` per prudenza sui campi nuovi.
    let iscrizioni = rParent.iscrizioniScrubbate ?? 0
    let file = rParent.fileRimossi ?? 0
    let fileNonRimossi = rParent.fileNonRimossi ?? 0
    let fotoRimosse = 0
    let fotoSganciate = 0
    // Il motivo dell'assenza (`presenze.giustificazione_testo`) e le note
    // d'appello: testo libero di natura sanitaria di un minore, che fino al
    // 2026-08-07 nessun canale di oblio toccava. Il conteggio arriva fin qui —
    // e da qui sulla riga della richiesta — perché è la prova che quel testo è
    // stato tolto davvero.
    let presenzeBonificate = 0
    // Le notifiche già recapitate che nominavano il minore: la campanella è un
    // archivio, non un rivolo. Arriva fin qui per la stessa ragione delle altre
    // — un oblio si racconta con dei numeri, non con un «fatto».
    let notificheRimosse = rParent.notificheRimosse ?? 0

    // 2. Anonimizza i figli NON iscritti + bonifica finanziaria/UGC collegata.
    let ricon = 0
    let incassi = 0
    let cassa = 0
    // Gli archivi che non si sono potuti nemmeno GUARDARE, i due canali sommati.
    // Vedi `anonimizzaAlunno.lettureFallite`: senza questo numero, un `42501` su
    // `student_documents` faceva marcare la richiesta come `evasa` — con un esito
    // che diceva zero file non rimossi — mentre il fascicolo sanitario del bambino
    // non era stato nemmeno letto.
    let lettureFallite = rParent.lettureFallite ?? 0
    for (const f of nonIscritti) {
      const r = await anonimizzaAlunno(admin, f as AlunnoOblio, at, op)
      ricon += r.riconciliazione
      incassi += r.incassi
      cassa += r.cassa
      file += r.file
      fileNonRimossi += r.fileNonRimossi ?? 0
      iscrizioni += r.iscrizioniScrubbate ?? 0
      fotoRimosse += r.fotoRimosse ?? 0
      fotoSganciate += r.fotoSganciate ?? 0
      segnalazioni += r.segnalazioniBonificate
      sospensioni += r.sospensioniBonificate
      presenzeBonificate += r.presenzeBonificate ?? 0
      notificheRimosse += r.notificheRimosse ?? 0
      lettureFallite += r.lettureFallite ?? 0
    }

    // Un oblio incompleto non passa inosservato: alla famiglia è stato risposto
    // che quei file non ci sono più. Riga PERSISTITA (`gdpr` è in
    // EVENTI_PERSISTITI), solo conteggi e uuid. «Incompleto» sono DUE cose: file
    // rimasti dentro, e archivi che nessuno ha potuto aprire.
    if (fileNonRimossi > 0 || lettureFallite > 0) {
      logEvento('gdpr', 'error', {
        operazione: op,
        esito: 'oblio-parziale',
        richiesta: id,
        n_file: fileNonRimossi,
        n_letture_fallite: lettureFallite,
      })
    }

    const esito = {
      parent: 1,
      alunni: nonIscritti.length,
      // Sopravvive alla richiesta: chi la rilegge fra un mese deve poter sapere
      // che un pezzo di quell'oblio è rimasto in carico a un altro plesso.
      alunni_fuori_scope: fuoriScope,
      news_visualizzazioni_rimosse: newsVisualizzazioniRimosse,
      consensi_prova_bonificati: consensiProvaBonificati,
      riconciliazione_bonificati: ricon,
      incassi_bonificati: incassi,
      cassa_bonificati: cassa,
      file_rimossi: file,
      n_file_non_rimossi: fileNonRimossi,
      // Sopravvive alla richiesta come gli altri conteggi: chi la rilegge fra un
      // mese deve poter sapere che quell'oblio è stato marcato «evaso» senza che
      // qualcuno abbia potuto guardare dentro N archivi.
      letture_fallite: lettureFallite,
      iscrizioni_scrubbate: iscrizioni,
      foto_rimosse: fotoRimosse,
      foto_sganciate: fotoSganciate,
      segnalazioni_bonificate: segnalazioni,
      sospensioni_bonificate: sospensioni,
      presenze_bonificate: presenzeBonificate,
      notifiche_rimosse: notificheRimosse,
    }

    // 3. Marca la richiesta come evasa.
    const { error: errUpd } = await admin
      .from('richieste_cancellazione')
      .update({ stato: 'evasa', evasa_il: at, evasa_da: auth.user.id, aggiornata_il: at, esito })
      .eq('id', id)
    if (errUpd) logErrore({ operazione: op, evento: 'marca_evasa' }, errUpd)

    // 4. Audit immutabile (solo conteggi/uuid: nessuna PII).
    await logScrittura(admin, {
      attore: auth.user,
      entitaTipo: 'gdpr_richiesta_cancellazione',
      entitaId: id,
      azione: 'update',
      scuolaId: auth.user.scuola_id ?? null,
      valoreDopo: { parent_id: parentId, ...esito },
    })

    return NextResponse.json({ ok: true, ...esito })
  } catch (err) {
    logErrore({ operazione: 'admin/gdpr/richieste:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
  }
})
