import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertSezioneInScope } from '@/lib/auth/scope'
import { parseBody } from '@/lib/validation/http'
import { zDataYMD, zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { MOTIVAZIONE_SBLOCCO_MAX } from '@/lib/primaria/sblocco-motivazione'

/**
 * I tipi che si sbloccano. `giorno` non è una riga: è la CLASSE in una DATA
 * (sezione + data), e copre ogni voce di quel giorno (spec 2026-09-24: lo
 * sblocco della Direzione è «voce per voce E per classe+giorno»). Il lettore di
 * tutti questi tipi è `src/lib/primaria/permesso-voce.ts`; lo slot del registro lo
 * legge anche `primaria/registro:POST`.
 */
const ENTITA_TIPI = ['registro', 'valutazione', 'nota', 'impreparato', 'allegato', 'firma', 'giorno'] as const
type EntitaTipo = (typeof ENTITA_TIPI)[number]

/** Dove sta la riga di ciascun tipo indirizzato per `entitaId`. */
const TABELLA_DI: Record<Exclude<EntitaTipo, 'giorno'>, string> = {
  registro: 'registro_orario',
  valutazione: 'valutazioni',
  nota: 'note_disciplinari',
  impreparato: 'giustifiche_didattiche',
  allegato: 'allegati_registro',
  firma: 'firme_docenti',
}

/**
 * Le colonne che PostgREST può non conoscere: `sblocchi_audit` le riceve dalla
 * migrazione `…_sblocchi_audit_per_slot`, e il database E2E della CI è un
 * progetto separato che non viene migrato. Su un INSERT che le nomina risponde
 * `PGRST204`; `42703` è la forma che arriva da Postgres. Vedi il ripiego sotto.
 */
const COLONNA_ASSENTE = new Set(['PGRST204', '42703'])

/**
 * `23514` (check_violation) su questo INSERT vuol dire una cosa sola: il vincolo
 * di `sblocchi_audit` è quello VECCHIO (tipi `registro/valutazione/nota`, bersaglio
 * senza `giorno`), perché la forma del corpo l'ha già garantita zod. È uno schema
 * non aggiornato — la migrazione `…_primaria_modifica_elimina` non è arrivata su
 * quel database — e si dichiara 503, non 500 né un finto 200.
 */
const VINCOLO_VECCHIO = '23514'

/**
 * L'ora della campanella: lo stesso intervallo del vincolo
 * `registro_orario_ora_lezione_check` (1..8). Fuori da lì una lezione non esiste,
 * quindi non c'è niente da sbloccare: meglio un 400 qui che una riga d'audit che
 * autorizza uno slot impossibile — e che nessuno ricollegherebbe mai a un'ora vera.
 *
 * `coerce` perché il client manda il numero d'ordine della campanella talvolta
 * come stringa (`primaria/registro:POST` accetta entrambe le forme).
 */
const zOraLezione = z.coerce
  .number({ error: 'oraLezione non valida' })
  .int('oraLezione deve essere un numero intero')
  .min(1, 'oraLezione fuori dalla campanella (1..8)')
  .max(8, 'oraLezione fuori dalla campanella (1..8)')

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
//
// DUE MODI DI INDIRIZZARE LO SBLOCCO, e sono alternativi:
//
//  · `entitaId`            → una riga che ESISTE già (registro firmato in ritardo
//                            da correggere, valutazione, nota);
//  · `sectionId+data+oraLezione` → uno SLOT, cioè un'ora che non è MAI stata
//                            firmata e che quindi una riga non ce l'ha.
//
// Il secondo caso è la ragione per cui questa route è stata riscritta: finché
// pretendeva `entitaId`, chi non aveva firmato in tempo non poteva più farlo
// (`primaria/registro:POST` risponde 423) e il dirigente non poteva autorizzarlo,
// perché l'uuid da sbloccare non esisteva. Il ciclo era chiuso.
const postBodySchemaBase = z.object({
  entitaTipo: z.enum(ENTITA_TIPI, { error: `entitaTipo in ${ENTITA_TIPI.join('/')}` }),
  entitaId: zUuid.optional(),
  sectionId: zUuid.optional(),
  data: zDataYMD.optional(),
  oraLezione: zOraLezione.optional(),
  // `trim()` PRIMA di `min(1)`: la colonna è NOT NULL perché la riga è la sola traccia
  // di un'autorizzazione a scrivere in ritardo, e «   » la riempirebbe senza dire niente.
  // Il bottone ripulisce già, ma il gate vero è qui: la route si chiama anche senza bottone.
  // Il tetto evita di trasformare l'audit in un deposito di testo libero, e sta in un
  // modulo puro perché la textarea del bottone lo usa come `maxLength`: un numero solo.
  motivazione: z
    .string()
    .trim()
    .min(1, 'motivazione obbligatoria')
    .max(MOTIVAZIONE_SBLOCCO_MAX, `motivazione oltre ${MOTIVAZIONE_SBLOCCO_MAX} caratteri`),
})

const postBodySchema = postBodySchemaBase.superRefine((b, ctx) => {
  // ── Il GIORNO della classe: sezione + data, e nient'altro ──────────────────
  // Né `entitaId` (non è una riga) né `oraLezione` (è il giorno intero): un
  // campo in più vorrebbe dire una richiesta che non sa che cosa sta chiedendo.
  if (b.entitaTipo === 'giorno') {
    if (b.entitaId || b.oraLezione !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['entitaTipo'],
        message: 'Lo sblocco del giorno indica solo la classe e la data (sectionId + data)',
      })
      return
    }
    if (!b.sectionId || !b.data) {
      ctx.addIssue({
        code: 'custom',
        path: ['data'],
        message: 'Lo sblocco del giorno va indicato per intero: sectionId e data',
      })
    }
    return
  }

  const slot = [b.sectionId, b.data, b.oraLezione]
  const pezziSlot = slot.filter((v) => v !== undefined).length
  if (b.entitaId && pezziSlot > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['entitaId'],
      message: 'Indica la riga (entitaId) OPPURE lo slot (sectionId+data+oraLezione), non entrambi',
    })
    return
  }
  if (!b.entitaId && pezziSlot === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['entitaId'],
      message: 'Indica la riga (entitaId) oppure lo slot (sectionId+data+oraLezione)',
    })
    return
  }
  if (!b.entitaId && pezziSlot < 3) {
    // Uno slot a metà è la richiesta più pericolosa che possa arrivare: «sblocca
    // quella classe», senza dire quando. Si rifiuta invece di indovinare. (Chi
    // vuole il giorno intero lo chiede per nome: `entitaTipo: 'giorno'`.)
    ctx.addIssue({
      code: 'custom',
      path: ['oraLezione'],
      message: 'Lo slot va indicato per intero: sectionId, data e oraLezione',
    })
    return
  }
  // Valutazioni, note, impreparati, allegati e firme non stanno in un'ora mai
  // firmata: hanno una riga o non esistono. Accettare lo slot lì significherebbe
  // scrivere un'autorizzazione che nessuna route andrà mai a cercare.
  if (!b.entitaId && b.entitaTipo !== 'registro') {
    ctx.addIssue({
      code: 'custom',
      path: ['entitaTipo'],
      message: 'Lo sblocco per slot vale solo per il registro: per gli altri indica entitaId',
    })
  }
})

/** Le coordinate con cui il registro ritrova un'autorizzazione senza conoscere l'uuid. */
interface Slot {
  data: string
  oraLezione: number
}

/**
 * L'UNICA risposta di guasto di questa route: un `logErrore` solo, un corpo solo.
 *
 * Perché una funzione e non due `NextResponse.json` scritte accanto ai due punti
 * in cui si guasta: la prosa di PostgREST non deve MAI arrivare a chi sta
 * lavorando («Could not find the 'section_id' column of 'sblocchi_audit' in the
 * schema cache» è inglese, e racconta com'è fatto lo schema), e una regola scritta
 * in due posti diverge al primo ritocco. Il messaggio vero resta nel log, dove
 * serve, insieme all'`evento` che dice QUALE passo è caduto.
 *
 * `schemaIncompleto` separa due guasti che si somigliano e si curano in modo
 * opposto: uno **schema non aggiornato** non è un difetto del server ma una
 * funzione che su quel database non c'è ancora (il progetto E2E della CI non
 * viene migrato), e un 503 lo distingue dai 500 veri quando si contano in
 * `app_log`.
 */
function guasto(evento: string, err: unknown, schemaIncompleto = false): NextResponse {
  // Due rami, ciascuno col suo codice LETTERALE (il lock `errori-con-codice` li
  // deve poter leggere): la regola resta una — un log, un corpo, niente prosa.
  if (schemaIncompleto) {
    logErrore({ operazione: 'primaria/sblocca:POST', stato: 503, evento }, err)
    return NextResponse.json(
      {
        error: 'Questo tipo di sblocco non è disponibile su questo ambiente: schema non aggiornato',
        codice: 'SBLOCCO_NON_DISPONIBILE',
      },
      { status: 503 },
    )
  }
  logErrore({ operazione: 'primaria/sblocca:POST', stato: 500, evento }, err)
  return NextResponse.json({ error: 'Sblocco non registrato', codice: 'SBLOCCO_NON_REGISTRATO' }, { status: 500 })
}

/**
 * La riga da sbloccare, risolta fino alla CLASSE (per lo scope) e, dove c'è,
 * allo SLOT della lezione (per l'audit). Firma e allegato non hanno una sezione
 * propria: la ereditano dalla riga di `registro_orario` a cui appartengono.
 */
type Risolta =
  | { trovata: true; sectionId: string; slot: Slot | null }
  | { trovata: false; risposta: NextResponse }

// POST /api/primaria/sblocca?userId=
// Override del dirigente sul vincolo temporale. Riservato alla dirigenza
// (admin/coordinator). Registra la motivazione in `sblocchi_audit`.
// body: { entitaTipo, motivazione } + { entitaId } | { sectionId, data, oraLezione }
//                                   | (entitaTipo 'giorno') { sectionId, data }
//
// ⚠️ VINCOLO DI RILASCIO — QUESTA ROUTE SCRIVE, E NON SI LEGGE DA SOLA.
// La riga d'audit ha DUE lettori: `primaria/registro:POST` (la firma di un'ora,
// per riga e per slot) e `src/lib/primaria/permesso-voce.ts` (modifica ed
// eliminazione di ogni voce, per voce, per slot e per `giorno`). Il contratto
// con `permesso-voce` è collaudato DA CAPO A FONDO, con questa route e il lettore
// sullo stesso database finto, in
// `__tests__/api/primaria-sblocco-contratto-permesso-voce.test.ts` (giorno,
// impreparato, firma, allegato); le due metà da sole in
// `__tests__/lib/primaria-permesso-voce.test.ts` e
// `__tests__/api/primaria-sblocca-tipi-estesi.test.ts`.
// Sul registro: finché quel lettore cercava l'override soltanto per
// `entita_id` (dentro `if (esistente)`), uno sblocco per SLOT rispondeva 200 e non
// sblocca niente: il dirigente legge «autorizzato» e la maestra continua a
// prendere 423. Un'operazione che dichiara successo senza fare nulla è il guasto
// che questo repo ha già pagato più volte, e qui sarebbe invisibile — nessun
// errore, nessun log, nessuna differenza per chi guarda.
// Il contratto fra le due route è collaudato in
// `__tests__/api/primaria-sblocco-slot-contratto-registro.test.ts`, che resta
// ROSSO finché il lettore per slot non esiste. **Non si rilascia questa route —
// né il bottone che la chiama — con quel test rosso.**
export const POST = withRoute('primaria/sblocca:POST', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request, ['admin', 'coordinator'])
    if (auth.response) return auth.response

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { entitaTipo, entitaId, motivazione } = b.data

    const supabase = await createAdminClient()

    // Dentro l'handler e non in un helper di modulo: le letture per id qui sotto
    // stanno così nello stesso span del gate `assertSezioneInScope` che le copre
    // (lock `isolamento-sede-coverage`).
    const risolviEntita = async (
      tipo: Exclude<EntitaTipo, 'giorno'>,
      id: string,
    ): Promise<Risolta> => {
      const nonTrovata = (): Risolta => ({
        trovata: false,
        risposta: NextResponse.json(
          { error: 'Entità da sbloccare non trovata', codice: 'SBLOCCO_VOCE_NON_TROVATA' },
          { status: 404 },
        ),
      })

      // Del registro servono anche le coordinate: registrandole nell'audit, il
      // registro ritrova l'autorizzazione con UNA sola interrogazione — per slot —
      // sia che la riga esistesse già, sia che non esista ancora.
      const colonne =
        tipo === 'registro'
          ? 'id, section_id, data, ora_lezione'
          : tipo === 'firma' || tipo === 'allegato'
            ? 'id, registro_id'
            : 'id, section_id'
      // Un allegato nel CESTINO (`eliminato_il` valorizzato) per il resto dell'app non
      // esiste: la spec vuole che ogni lettura di `allegati_registro` lo escluda,
      // tranne cestino e purga. Senza il filtro, un allegato eliminato da solo — che
      // conserva il suo `registro_id` — si risolverebbe fino alla classe e
      // l'audit autorizzerebbe una voce invisibile.
      const leggi = (escludiCestino: boolean) => {
        let q = supabase.from(TABELLA_DI[tipo]).select(colonne).eq('id', id)
        if (escludiCestino) q = q.is('eliminato_il', null)
        return q.maybeSingle<{
          id: string
          section_id?: string | null
          registro_id?: string | null
          data?: string
          ora_lezione?: number
        }>()
      }
      // PostgREST NON lancia: senza questo controllo una lettura fallita sarebbe
      // indistinguibile da «entità inesistente», e il dirigente leggerebbe un 404
      // che gli dice di aver sbagliato lui.
      let { data: entita, error: letturaErr } = await leggi(tipo === 'allegato')
      if (
        letturaErr &&
        tipo === 'allegato' &&
        COLONNA_ASSENTE.has((letturaErr as { code?: string }).code ?? '')
      ) {
        // DEGRADO sul database E2E della CI, che non è migrato: là `eliminato_il`
        // non esiste (42703/PGRST204), e quindi non esiste nemmeno un cestino da
        // escludere. Si rilegge senza il filtro — lo stesso schema del ripiego su
        // `sblocchi_audit` qui sotto — e lo si dice nel log invece di tacerlo.
        logEvento('registro', 'info', {
          operazione: 'primaria/sblocca:POST',
          esito: 'sblocco-allegato-colonna-cestino-assente-ripiego',
          entita_tipo: tipo,
        })
        ;({ data: entita, error: letturaErr } = await leggi(false))
      }
      if (letturaErr) return { trovata: false, risposta: guasto('sblocco_entita_non_letta', letturaErr) }
      if (!entita) return nonTrovata()

      if (tipo === 'firma' || tipo === 'allegato') {
        // Due casi DISTINTI, che qui non si confondono più:
        //  · «nel cestino» (`eliminato_il` valorizzato) → già escluso dalla lettura
        //    sopra: 404, come una voce che non c'è;
        //  · «senza lezione» (`registro_id` NULL, la lezione è stata eliminata e la
        //    FK l'ha azzerato) → si ripristina rifirmando lo slot, non sbloccandolo.
        //    Nessuna classe da verificare vuol dire nessuno sblocco da scrivere.
        if (!entita.registro_id) {
          return {
            trovata: false,
            risposta: NextResponse.json(
              { error: 'La voce non è legata a nessuna lezione: niente da sbloccare', codice: 'VOCE_SENZA_LEZIONE' },
              { status: 409 },
            ),
          }
        }
        const { data: lezione, error: lezErr } = await supabase
          .from('registro_orario')
          .select('id, section_id, data, ora_lezione')
          .eq('id', entita.registro_id)
          .maybeSingle<{ id: string; section_id: string | null; data: string; ora_lezione: number | null }>()
        if (lezErr) return { trovata: false, risposta: guasto('sblocco_lezione_non_letta', lezErr) }
        if (!lezione?.section_id) return nonTrovata()
        return {
          trovata: true,
          sectionId: lezione.section_id,
          slot: lezione.ora_lezione != null ? { data: lezione.data, oraLezione: Number(lezione.ora_lezione) } : null,
        }
      }

      if (!entita.section_id) return nonTrovata()
      const slot =
        tipo === 'registro' && entita.data && entita.ora_lezione != null
          ? { data: entita.data, oraLezione: Number(entita.ora_lezione) }
          : null
      return { trovata: true, sectionId: entita.section_id, slot }
    }

    // ─── 1. Si risolve la SEZIONE (e, dove c'è, lo slot o il giorno) ──────────
    // Lo scope si verifica PRIMA di scrivere audit o lock: niente sblocchi
    // cross-plesso, e niente righe d'audit su id inesistenti.
    let sectionId: string
    let slot: Slot | null = null
    let giorno: string | null = null

    if (entitaTipo === 'giorno') {
      // `superRefine` garantisce sezione e data, e nient'altro.
      sectionId = b.data.sectionId as string
      giorno = b.data.data as string
    } else if (entitaId) {
      const risolta = await risolviEntita(entitaTipo, entitaId)
      if (!risolta.trovata) return risolta.risposta
      sectionId = risolta.sectionId
      slot = risolta.slot
    } else {
      // Lo slot arriva dal corpo già validato: `superRefine` garantisce che i tre
      // pezzi ci siano tutti e che il tipo sia `registro`.
      sectionId = b.data.sectionId as string
      slot = { data: b.data.data as string, oraLezione: b.data.oraLezione as number }
    }

    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr

    // ─── 2. La riga d'audit ─────────────────────────────────────────────────
    const rigaAudit: Record<string, unknown> = {
      entita_tipo: entitaTipo,
      entita_id: entitaId ?? null,
      dirigente_id: auth.user.id,
      motivazione,
    }
    if (slot) {
      rigaAudit.section_id = sectionId
      rigaAudit.data = slot.data
      rigaAudit.ora_lezione = slot.oraLezione
    } else if (giorno) {
      // Il giorno della classe: sezione + data, ora NULL. È la forma che
      // `permesso-voce` cerca con `entita_tipo = 'giorno'`.
      rigaAudit.section_id = sectionId
      rigaAudit.data = giorno
      rigaAudit.ora_lezione = null
    }

    let ins = await supabase.from('sblocchi_audit').insert(rigaAudit).select().single()

    // DEGRADAZIONE sul database non migrato (il progetto E2E della CI è separato
    // e non riceve le migrazioni): le tre colonne dello slot non esistono e
    // PostgREST risponde `PGRST204` nominandone una. Se c'è un `entitaId` si
    // riprova SENZA di esse — è esattamente lo sblocco di prima, e la forma
    // storica non deve regredire per una colonna che quel database non ha.
    if (ins.error && COLONNA_ASSENTE.has((ins.error as { code?: string }).code ?? '') && entitaId) {
      logEvento('registro', 'info', {
        operazione: 'primaria/sblocca:POST',
        esito: 'sblocco-colonne-slot-assenti-ripiego-riga',
        entita_tipo: entitaTipo,
      })
      ins = await supabase
        .from('sblocchi_audit')
        .insert({ entita_tipo: entitaTipo, entita_id: entitaId, dirigente_id: auth.user.id, motivazione })
        .select()
        .single()
    }

    if (ins.error) {
      // Qui ci arriva anche lo slot puro su un database non migrato: là il
      // ripiego non esiste, perché non c'è nessuna riga da indirizzare al posto
      // delle coordinate. Meglio un 503 dichiarato che un 200 che non ha
      // registrato niente — e che farebbe credere al dirigente di aver autorizzato.
      const codiceErr = (ins.error as { code?: string }).code ?? ''
      const schemaIncompleto = COLONNA_ASSENTE.has(codiceErr) || codiceErr === VINCOLO_VECCHIO
      return guasto(
        schemaIncompleto ? 'sblocco_schema_incompleto' : 'sblocco_non_registrato',
        ins.error,
        schemaIncompleto,
      )
    }

    // ─── 3. Il lock persistito ──────────────────────────────────────────────
    // Il blocco effettivo è calcolato in API (`isOltreScadenza`) e l'esistenza
    // della riga d'audit fa da override: azzerare `locked_il` è pulizia, non il
    // presidio. Un errore qui NON annulla lo sblocco — ma si logga, perché
    // resterebbe una riga marcata bloccata che nessuno riscriverà.
    const tabellaLock =
      entitaTipo === 'registro' ? 'registro_orario' : entitaTipo === 'valutazione' ? 'valutazioni' : null
    if (entitaId && tabellaLock) {
      const { error: lockErr } = await supabase.from(tabellaLock).update({ locked_il: null }).eq('id', entitaId)
      if (lockErr) {
        logEvento(
          'registro',
          'warn',
          {
            operazione: 'primaria/sblocca:POST',
            esito: 'lock-persistito-non-azzerato',
            entita_tipo: entitaTipo,
            sezione: sectionId,
          },
          lockErr,
        )
      }
    }

    // Il SUCCESSO si logga: `sblocchi_audit` conta 0 righe in produzione, quindi
    // «nessun log» oggi significa insieme «nessuno ha mai sbloccato niente» e «gli
    // sblocchi non partono» — l'ambiguità che questo repo ha già pagato una volta.
    // La MOTIVAZIONE non entra: è testo libero scritto su una classe di minori.
    logEvento('registro', 'info', {
      operazione: 'primaria/sblocca:POST',
      esito: 'sblocco-registrato',
      entita_tipo: entitaTipo,
      per_slot: !entitaId && !giorno,
      per_giorno: !!giorno,
      sezione: sectionId,
      data: slot?.data ?? giorno ?? null,
      ordine: slot?.oraLezione ?? null,
      dirigente: auth.user.id,
    })

    return NextResponse.json({ success: true, data: ins.data })
  } catch (err) {
    logErrore({ operazione: 'primaria/sblocca:POST', stato: 500 }, err)
    // Il messaggio vero resta nel log: al client un codice, mai `err.message`.
    return NextResponse.json({ error: 'Sblocco non registrato', codice: 'SBLOCCO_NON_REGISTRATO' }, { status: 500 })
  }
})
