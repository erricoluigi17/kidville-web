import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { assertSezioneInScope, assertAlunniInSezione, assertSezionePrimariaFirmabile } from '@/lib/auth/scope'
import { assertGradoDocente } from '@/lib/auth/require-grado'
import { eAncoraIscritto } from '@/lib/alunni/stato'
import { CHIAVE_REGISTRO, CHIAVE_REGISTRO_LEGACY, vincoloConflittoAssente } from '@/lib/registro/chiave-orario'
import { logScrittura } from '@/lib/audit/scrittura'
import { risolviValutatore } from '@/lib/audit/valutatore'
import { isOltreScadenza } from '@/lib/primaria/timelock'
import { enqueueNotifichePerAlunni, notificaTitolariScrittura } from '@/lib/primaria/notifiche'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zDataYMD, zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { haUnRuolo, type AppUser } from '@/lib/auth/predicati-ruolo'
import {
  chiaveVoce,
  rispostaPermessoNegato,
  statoVoci,
  verificaPermessoVoce,
  type VocePrimaria,
} from '@/lib/primaria/permesso-voce'
import { getGenitoriDiAlunni } from '@/lib/anagrafiche/legami'
import {
  allegatiRegistroAncheNelCestino,
  allegatiRegistroNelCestino,
  allegatiRegistroVivi,
  allegatiRegistroViviDalJoin,
} from '@/lib/primaria/cestino-allegati-registro'

const getQuerySchema = z.object({
  sectionId: zUuid,
  data: zDataYMD,
})

/**
 * L'ORA DI LEZIONE HA UN RANGE, ED È QUELLO DEL DATABASE.
 *
 * Fino al 2026-09-09 qui c'era `z.union([z.number(), z.string()]).refine(v => !!v)`:
 * qualunque valore truthy passava. Su `registro_orario` c'è invece
 * `CHECK ((ora_lezione >= 1) AND (ora_lezione <= 8))` — misurato su `pg_constraint`
 * il 2026-09-09, e le 14 righe vere stanno fra 1 e 5. Un `oraLezione: 99` arrivava
 * quindi fino a Postgres, che lo rifiutava, e la route rispondeva **500 col
 * messaggio grezzo** di PostgREST: al docente uscivano il nome della tabella e
 * quello del vincolo, e in `app_log` finiva un errore di server per un errore del
 * client.
 *
 * `z.coerce` e non `z.union`: i client mandano storicamente sia `2` sia `'2'`, e
 * una stringa arrivava a `.eq('ora_lezione', '2')` e alla riga di upsert così
 * com'era. Coercendo, il valore che tocca il database è sempre un intero.
 * ⚠️ `Number('')` è `0` e `Number(null)` è `0`: cadono su `.min(1)`, cioè restano
 * rifiutati come prima — ma con un 400 leggibile invece di un 500.
 */
const zOraLezione = z.coerce
  .number({ error: 'Ora di lezione obbligatoria: un numero intero da 1 a 8' })
  .int('Ora di lezione non valida: attesa un\'ora intera da 1 a 8')
  .min(1, 'Ora di lezione non valida: attesa un\'ora da 1 a 8')
  .max(8, 'Ora di lezione non valida: attesa un\'ora da 1 a 8')

// dataConsegnaCompiti resta stringa libera: '' ricade su null via `||` come oggi.
// tipoCompresenza senza enum: il codice attuale non lo vincola (confronta solo 'sostegno').
//
// ⚠️ `argomento`/`compiti`/`dataConsegnaCompiti` sono `.nullish()` — cioè
// OPZIONALI — e la differenza fra «chiave assente» e «chiave vuota» è portante
// (vedi il blocco sui campi condivisi, più sotto): `undefined` significa «non
// te ne sto parlando», `''`/`null` significano «azzeralo». Non renderle
// obbligatorie: il client in assegnazione mirata le OMETTE apposta.
const postBodySchema = z.object({
  sectionId: zUuid,
  data: zDataYMD,
  oraLezione: zOraLezione,
  materiaId: zUuid.nullish(),
  argomento: z.string().nullish(),
  compiti: z.string().nullish(),
  dataConsegnaCompiti: z.string().nullish(),
  tipoCompresenza: z.string().default('principale'),
  argomentoProprio: z.string().nullish(),
  compitiPropri: z.string().nullish(),
  destinatariIds: z.array(zUuid).nullish().transform((v) => v ?? []),
  // Segreteria/Direzione: docente titolare a cui attribuire la firma (risolviValutatore).
  docenteId: zUuid.nullish(),
  daOrario: z.boolean().nullish(),
  /**
   * «I tre condivisi che ti sto mandando li ho IDRATATI dalla riga esistente.»
   *
   * È la chiave che rende sicuro l'azzeramento dei campi CONDIVISI, e nasce da un
   * guasto misurato: `syncPendingRegistro` (`@/lib/offline/syncEngine`) spedisce
   * SEMPRE `argomento`, `compiti` e `dataConsegnaCompiti` — in `LocalPrimariaRegistro`
   * sono `string | null` e vengono serializzati senza condizione — anche quando in
   * coda sono `null`. Da quando la chiave vuota vale «azzera» (vedi il blocco
   * «CHIAVE ASSENTE ≠ CHIAVE VUOTA»), il rientro in rete di una firma accodata
   * CANCELLAVA argomento, compiti e data di consegna scritti da un altro docente,
   * rispondendo 200. La guardia della firma vuota non se ne accorgeva: lasciava
   * passare la richiesta proprio perché l'ora risultava già documentata — cioè
   * proprio per il contenuto che stava per essere cancellato.
   *
   * `undefined`/`false` = «non lo dichiaro» → un campo vuoto NON cancella niente di
   * scritto (torna a comportarsi come prima della correzione). `true` = il client
   * ha davvero letto la riga e il riquadro vuoto rappresenta il suo contenuto.
   *
   * ⚠️ Chi la manda è la MODALE del registro, che idrata i tre campi da `riga`
   * (`teacher/primaria/[sectionId]/registro/page.tsx`). La coda offline no, e non
   * deve: quando accoda non ha letto niente.
   */
  condivisiIdratati: z.boolean().nullish(),
})

// ISO date → giorno_settimana 1..6 (Lun..Sab); domenica (0) → 7 (fuori range).
function giornoSettimana(dataIso: string): number {
  const d = new Date(dataIso + 'T00:00:00').getDay() // 0=Dom..6=Sab
  return d === 0 ? 7 : d
}

/**
 * LO STATO DEL TERMINE DI UNA GIORNATA DEL REGISTRO, per la GET.
 *
 * Valutazioni, note e allegati dichiarano in anticipo quali voci sono bloccate
 * (`statoVoci`); il registro era l'unico che lo scopriva al gesto, con un 423, e
 * lo teneva nel browser di chi aveva fatto il gesto: la Direzione che apriva la
 * pagina non vedeva nessun «Sblocca», e per ottenere quello per slot doveva
 * compilare una firma finta. Qui la GET lo dice per tutti:
 *  · `oltreTermine` — la DATA è oltre il termine `classe_orale` della sede;
 *  · `giornoSbloccato` / `oreSbloccate` — gli sblocchi per giorno e per slot della
 *    data, che valgono anche per le ore mai firmate (senza riga né uuid);
 *  · per ogni riga e ogni firma, `bloccata` da `statoVoci` (voce, slot o giorno).
 *
 * Mai un blocco inventato: un guasto di lettura dà `letto: false` e nessuna voce
 * bloccata (la pagina ripiega sul 423 del gesto). Sotto il termine non si legge
 * niente di più: è il caso di tutti i giorni, e non costa query.
 */
interface StatoTermineGiornata {
  letto: boolean
  oltreTermine: boolean
  giorniLimite: number | null
  giornoSbloccato: boolean
  oreSbloccate: number[]
  /** Le voci (`registro:<id>`, `firma:<id>`) oltre il termine e senza sblocco. */
  bloccate: Set<string>
}

const TERMINE_NON_LETTO: StatoTermineGiornata = {
  letto: false,
  oltreTermine: false,
  giorniLimite: null,
  giornoSbloccato: false,
  oreSbloccate: [],
  bloccate: new Set(),
}

async function statoTermineGiornata(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  utente: AppUser,
  sectionId: string,
  /** La sede della classe (letta dalla GET, dopo lo scope): da lì i termini. */
  scuolaId: string | null,
  data: string,
  righe: ReadonlyArray<{ id: string; ora_lezione: number; firme_docenti?: unknown }>,
): Promise<StatoTermineGiornata> {
  const operazione = 'primaria/registro:GET'

  // Lo stesso calcolo della POST (`classe_orale`, data di Roma, termini per sede).
  const lock = await isOltreScadenza(supabase, scuolaId, data, 'classe_orale')
  if (!lock.locked) {
    return { ...TERMINE_NON_LETTO, letto: true, giorniLimite: lock.giorniLimite }
  }

  // ── Le voci scritte: una lettura per lotto, non una per voce ────────────────
  const voci: VocePrimaria[] = []
  for (const r of righe) {
    const base = { sectionId, scuolaId, dataEvento: data, oraLezione: r.ora_lezione }
    // La lezione intera non ha un autore unico (vedi la DELETE): resta allo staff.
    voci.push({ ...base, tipo: 'registro', id: r.id, autoreId: null })
    for (const f of (r.firme_docenti ?? []) as { id: string; maestra_id: string }[]) {
      voci.push({ ...base, tipo: 'firma', id: f.id, autoreId: f.maestra_id })
    }
  }
  const stato = await statoVoci(supabase, utente, voci)
  if (!stato.ok) return TERMINE_NON_LETTO // il guasto l'ha già loggato permesso-voce
  const bloccate = new Set<string>()
  for (const [chiave, e] of stato.esiti) if (e.bloccata) bloccate.add(chiave)

  // ── Le ore mai firmate: sblocchi per slot e per giorno della data ─────────
  const { data: sblocchi, error: sbErr } = await supabase
    .from('sblocchi_audit')
    .select('entita_tipo, ora_lezione')
    .in('entita_tipo', ['giorno', 'registro'])
    .eq('section_id', sectionId)
    .eq('data', data)
  let giornoSbloccato = false
  const oreSbloccate = new Set<number>()
  if (sbErr) {
    const codice = (sbErr as { code?: string }).code ?? ''
    if (codice !== '42703' && codice !== 'PGRST204') {
      logEvento('registro', 'error', { operazione, esito: 'termine-sblocchi-non-letti', sezione: sectionId }, sbErr)
      return TERMINE_NON_LETTO
    }
    // DB E2E non migrato: niente sblocchi per giorno né per slot, cioè lo stato di
    // prima. Non è un guasto, ma si dichiara.
    logEvento('registro', 'info', { operazione, esito: 'termine-sblocchi-non-disponibili-schema', sezione: sectionId }, sbErr)
  } else {
    for (const s of (sblocchi ?? []) as { entita_tipo: string; ora_lezione: number | null }[]) {
      if (s.entita_tipo === 'giorno') giornoSbloccato = true
      else if (s.ora_lezione != null) oreSbloccate.add(Number(s.ora_lezione))
    }
  }

  logEvento('registro', 'info', {
    operazione,
    esito: 'termine-giornata-oltre',
    sezione: sectionId,
    n: bloccate.size,
    per_giorno: giornoSbloccato,
    giorni_limite: lock.giorniLimite,
  })
  return {
    letto: true,
    oltreTermine: true,
    giorniLimite: lock.giorniLimite,
    giornoSbloccato,
    oreSbloccate: [...oreSbloccate].sort((a, b) => a - b),
    bloccate,
  }
}

// GET /api/primaria/registro?sectionId=&data=&userId=
// Restituisce la griglia del giorno: campanelle (con orario pre-compilato) +
// righe di registro firmate (con firme, contenuti propri e destinatari).
//
// ⚠️ La GET resta su `assertSezioneInScope`: la SUPPLENZA allarga la sola FIRMA
// (la POST), non la lettura del registro di una classe non propria. Il docente
// che fa supplenza firma dalla PROPRIA pagina scegliendo la classe nella modale;
// non naviga la griglia altrui, che porta argomenti, compiti e destinatari.
export const GET = withRoute('primaria/registro:GET', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { sectionId, data } = q.data

    const supabase = await createAdminClient()
    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr
    const giorno = giornoSettimana(data)

    // NB: niente embed `utenti(...)` nei join — la relazione firme_docenti/
    // orario_settimanale → utenti non è nel cache PostgREST e farebbe fallire
    // l'intera query (la firma non comparirebbe). I nomi docente si risolvono a parte.
    const [resCampanelle, resOrario, resRighe] = await Promise.all([
      supabase
        .from('campanelle')
        .select('id, ordine, ora_inizio, ora_fine, tipo')
        .eq('section_id', sectionId)
        .eq('giorno_settimana', giorno)
        .order('ordine'),
      supabase
        .from('orario_settimanale')
        .select('campanella_id, materia_id, docente_id, materie(nome, codice)')
        .eq('section_id', sectionId)
        .eq('giorno_settimana', giorno),
      supabase
        .from('registro_orario')
        .select(`
          id, ora_lezione, materia, materia_id, argomento, compiti, data_consegna_compiti, locked_il,
          materie(nome, codice),
          firme_docenti(id, maestra_id, tipo_compresenza, argomento_proprio, compiti_propri, firmato_il),
          registro_destinatari(id, firma_id, alunno_id),
          allegati_registro(id, ambito, tipo, file_url, file_name, eliminato_il)
        `)
        .eq('section_id', sectionId)
        .eq('data', data)
        .order('ora_lezione'),
    ])

    // ═══ IL 200 DEVE DICHIARARE SE HA LETTO ══════════════════════════════════
    //
    // PostgREST non lancia: fino al 2026-09-09 `{ error }` era scartato su tutte
    // e tre le query. Una lettura fallita usciva come `campanelle: []` dentro un
    // 200 formalmente valido, e la griglia mostrava «Nessuna ora» — la STESSA
    // frase che dice la verità quando quel giorno non ci sono davvero lezioni.
    // Dal client, «non l'ho potuto leggere» e «non ce n'è» erano indistinguibili.
    //
    // La forma è quella già scelta da `parent/primaria/assenze:GET`
    // (`letto`/`riepilogoLetto`): il campo dice se QUEL pezzo è stato letto, e il
    // client lo tratta come guasto solo quando vale esplicitamente `false` —
    // `undefined` è «un server più vecchio non lo dichiara», che non è «dichiara
    // di no». Qui i pezzi sono TRE e di pari dignità, quindi tre booleani
    // nominati, e non un `letto` unico che dovrebbe scegliere quale dei tre
    // rappresenta: un oggetto sotto `letto` avrebbe rotto proprio l'idioma
    // `d.letto === false`, perché un oggetto è sempre truthy.
    const guasti: Array<[string, unknown]> = [
      ['campanelle-non-lette', resCampanelle.error],
      ['orario-non-letto', resOrario.error],
      ['righe-non-lette', resRighe.error],
    ]
    for (const [esito, err] of guasti) {
      if (err) {
        logEvento('registro', 'error', {
          operazione: 'primaria/registro:GET', esito, sezione: sectionId,
        }, err)
      }
    }

    const campanelle = resCampanelle.data ?? []
    const orarioCelle = resOrario.data ?? []
    const righe = resRighe.data ?? []

    // Risoluzione nomi docente (firme + orario) senza dipendere dalle FK del cache.
    const docenteIds = new Set<string>()
    for (const c of orarioCelle) if (c.docente_id) docenteIds.add(c.docente_id as string)
    for (const r of righe) for (const f of (r.firme_docenti ?? []) as { maestra_id: string }[]) if (f.maestra_id) docenteIds.add(f.maestra_id)
    const nomiById = new Map<string, { nome: string; cognome: string }>()
    let nomiLetti = true
    if (docenteIds.size) {
      const { data: docenti, error: docentiErr } = await supabase.from('utenti').select('id, nome, cognome').in('id', [...docenteIds])
      if (docentiErr) {
        // Degradazione COSMETICA (le firme restano, senza il nome di chi ha
        // firmato) — ma muta no: senza questa riga «firma di nessuno» e «non ho
        // letto i nomi» erano lo stesso rendering.
        nomiLetti = false
        logEvento('registro', 'warn', {
          operazione: 'primaria/registro:GET', esito: 'nomi-docenti-non-letti',
          sezione: sectionId, n: docenteIds.size,
        }, docentiErr)
      }
      for (const d of docenti ?? []) nomiById.set(d.id, { nome: d.nome, cognome: d.cognome })
    }
    const orarioConNomi = orarioCelle.map((c) => ({ ...c, utenti: c.docente_id ? nomiById.get(c.docente_id as string) ?? null : null }))

    // Il termine della giornata (vedi `statoTermineGiornata`). Un'eccezione qui
    // NON toglie il registro: si degrada a «non letto», e si dichiara.
    let termine: StatoTermineGiornata = TERMINE_NON_LETTO
    if (!resRighe.error) {
      try {
        // La sede della classe (lo scope qui sopra l'ha già verificata): i termini sono per sede.
        const { data: sezione, error: sezErr } = await supabase
          .from('sections')
          .select('scuola_id')
          .eq('id', sectionId)
          .maybeSingle()
        if (sezErr) {
          logEvento('registro', 'error', {
            operazione: 'primaria/registro:GET', esito: 'termine-sezione-non-letta', sezione: sectionId,
          }, sezErr)
        } else termine = await statoTermineGiornata(
          supabase,
          auth.user,
          sectionId,
          (sezione as { scuola_id?: string | null } | null)?.scuola_id ?? null,
          data,
          righe as unknown as { id: string; ora_lezione: number; firme_docenti?: unknown }[],
        )
      } catch (errTermine) {
        logEvento('registro', 'error', {
          operazione: 'primaria/registro:GET', esito: 'termine-non-calcolato', sezione: sectionId,
        }, errTermine)
      }
    }

    const righeConNomi = righe.map((r) => ({
      ...r,
      // Gli allegati nel CESTINO non sono più della lezione (`@/lib/primaria/cestino-allegati-registro`).
      allegati_registro: allegatiRegistroViviDalJoin(r.allegati_registro as { eliminato_il?: string | null }[] | null),
      firme_docenti: ((r.firme_docenti ?? []) as { id: string; maestra_id: string }[]).map((f) => ({
        ...f,
        utenti: nomiById.get(f.maestra_id) ?? null,
        bloccata: termine.bloccate.has(chiaveVoce('firma', f.id)),
      })),
      bloccata: termine.bloccate.has(chiaveVoce('registro', r.id as string)),
    }))

    return NextResponse.json({
      success: true,
      data: {
        giorno,
        campanelle,
        orarioCelle: orarioConNomi,
        righe: righeConNomi,
        termine: {
          letto: termine.letto,
          oltreTermine: termine.oltreTermine,
          giorniLimite: termine.giorniLimite,
          giornoSbloccato: termine.giornoSbloccato,
          oreSbloccate: termine.oreSbloccate,
        },
      },
      campanelleLette: !resCampanelle.error,
      orarioLetto: !resOrario.error,
      righeLette: !resRighe.error,
      nomiDocentiLetti: nomiLetti,
    })
  } catch (err) {
    logErrore({ operazione: 'primaria/registro:GET', stato: 500 }, err)
    // Il `message` dell'eccezione NON esce verso il docente: quello di PostgREST
    // riecheggia filtri e nomi di colonna. Resta nel log, intero, che è dove dice
    // perché — stessa forma di `parent/primaria/assenze:GET`. `LETTURA_FALLITA` è
    // già in catalogo e dice esattamente questo, in entrambe le lingue.
    return NextResponse.json(
      { error: 'Non siamo riusciti a leggere il registro.', codice: 'LETTURA_FALLITA' },
      { status: 500 },
    )
  }
})

// POST /api/primaria/registro?userId=
// Firma/salva una lezione. Gestisce cofirma e firma indipendente (destinatari).
export const POST = withRoute('primaria/registro:POST', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const {
      sectionId,
      data,
      oraLezione,
      materiaId,
      argomento,
      compiti,
      dataConsegnaCompiti,
      tipoCompresenza,
      argomentoProprio,
      compitiPropri,
      destinatariIds,
      docenteId,
      daOrario,
      condivisiIdratati,
    } = b.data

    const supabase = await createAdminClient()

    // ── SCOPE: la SUPPLENZA nel proprio plesso ───────────────────────────────
    // Gate DEDICATO a questa firma, non `assertSezioneInScope`: la sede resta
    // invalicabile e la classe deve essere `school_type = 'primaria'`, ma per
    // l'`educator` cade il requisito dell'assegnazione in `utenti_sezioni`
    // (decisione del titolare, 2026-09-09: si fa supplenza, e il registro va
    // firmato lo stesso). Il perché quel permesso non si è allargato dentro
    // `assertSezioneInScope` — che lo condividono valutazioni, note, pagelle e
    // fascicolo — sta scritto sopra la funzione, in `@/lib/auth/scope`.
    const scope = await assertSezionePrimariaFirmabile(supabase, auth.user, sectionId)
    if (scope.response) return scope.response
    const supplenza = scope.supplenza

    // ── GRADO: si firma la primaria solo se si insegna alla primaria ─────────
    // Mancava, ed era l'unica delle tre route di primaria a non averlo — cioè
    // l'unica che SCRIVE. Vedi `assertGradoDocente`.
    //
    // È IL CONTRAPPESO DELLA RIGA SOPRA, non una formalità: la supplenza toglie il
    // requisito dell'assegnazione, e senza questo gate un educator di sola infanzia
    // firmerebbe qualunque classe di primaria della sua sede. Misurato il 2026-09-09
    // sui soli ruoli reali, 18 educator su 18 assegnati a una sezione di primaria
    // hanno già il grado — cioè in veste da maestra il gate non chiude la porta a
    // nessuno. La porta la chiude nell'altro verso: `assertGradoDocente` interroga
    // `haRuolo` e non `user.role`, e senza quella riga i **5** educator che hanno il
    // ponte `parents`, non hanno 'primaria' fra i gradi e stanno in una sede con
    // classi di primaria firmavano qui semplicemente cambiando veste.
    const gradoErr = await assertGradoDocente(auth.user, 'primaria')
    if (gradoErr) return gradoErr

    // I destinatari (oscuramento firma indipendente) devono essere alunni della sezione.
    if (destinatariIds.length > 0) {
      const alunniErr = await assertAlunniInSezione(supabase, destinatariIds, sectionId)
      if (alunniErr) return alunniErr
    }

    // La FIRMA del registro deve restare del docente (vincolo FEA). educator → sé
    // stesso; segreteria → docente titolare indicato in body.docenteId, altrimenti 422.
    const vr = await risolviValutatore(supabase, auth.user, sectionId, { docenteId, materiaId })
    if (vr.response) return vr.response
    const firmaUserId = vr.valutatoreId

    // Risolve scuola + nome classe (classe_sezione per compat con il vincolo unico).
    const { data: section, error: sectionErr } = await supabase
      .from('sections')
      .select('id, name, scuola_id')
      .eq('id', sectionId)
      .maybeSingle()
    // PostgREST non lancia: senza questo controllo un GUASTO di lettura usciva
    // come **404 «Sezione non trovata»**, cioè un'affermazione su una riga che
    // non si è letta — e la sezione, un istante prima, era stata trovata dal
    // gate di scope. Modello: `register/lessons/route.ts:133-140`.
    if (sectionErr) {
      logEvento('registro', 'error', {
        operazione: 'primaria/registro:POST', esito: 'sezione-non-risolta', sezione: sectionId,
      }, sectionErr)
      return NextResponse.json({ error: 'Verifica della sezione non riuscita.', codice: 'LETTURA_FALLITA' }, { status: 500 })
    }
    if (!section) return NextResponse.json({ error: 'Sezione non trovata' }, { status: 404 })

    // Riga registro esistente per questo slot? Serve a DUE cose: l'override
    // dello sblocco (sotto) e a sapere se la riga è GIÀ documentata (firma vuota).
    const { data: esistente, error: esistenteErr } = await supabase
      .from('registro_orario')
      .select('id, materia_id, argomento, compiti, data_consegna_compiti')
      .eq('section_id', sectionId)
      .eq('data', data)
      .eq('ora_lezione', oraLezione)
      .maybeSingle()
    // Senza questo controllo una lettura fallita lasciava `esistente` a null:
    // l'override dello sblocco non partiva e il docente riceveva **423 «bloccato,
    // chiedi lo sblocco al dirigente»** su una riga che il dirigente aveva già
    // sbloccato. Un guasto travestito da regola.
    if (esistenteErr) {
      logEvento('registro', 'error', {
        operazione: 'primaria/registro:POST', esito: 'riga-registro-non-risolta',
        sezione: sectionId, ordine: oraLezione,
      }, esistenteErr)
      return NextResponse.json({ error: 'Verifica della riga di registro non riuscita.', codice: 'LETTURA_FALLITA' }, { status: 500 })
    }

    // Vincolo temporale: registro di classe = 'classe_orale' (default 2 giorni).
    const lock = await isOltreScadenza(supabase, section.scuola_id, data, 'classe_orale')
    if (lock.locked) {
      // Override solo se il dirigente ha sbloccato questa riga.
      let overridden = false
      if (esistente) {
        const { data: sblocco, error: sbloccoErr } = await supabase
          .from('sblocchi_audit')
          .select('id')
          .eq('entita_tipo', 'registro')
          .eq('entita_id', esistente.id)
          .limit(1)
          .maybeSingle()
        // Stessa trappola della lettura qui sopra, e stesso danno: `{ error }`
        // scartato → `overridden = false` → 423 su una riga regolarmente
        // sbloccata. Il diniego per guasto si dichiara, non si traveste da lock.
        if (sbloccoErr) {
          logEvento('registro', 'error', {
            operazione: 'primaria/registro:POST', esito: 'sblocco-non-risolto',
            sezione: sectionId, entita_id: esistente.id,
          }, sbloccoErr)
          return NextResponse.json({ error: 'Verifica dello sblocco non riuscita.', codice: 'LETTURA_FALLITA' }, { status: 500 })
        }
        overridden = !!sblocco
      }

      // ── LO SBLOCCO PER SLOT, che è il caso per cui lo sblocco esiste ──────
      //
      // Il ramo qui sopra cerca l'autorizzazione per `entita_id`, e quindi solo
      // `if (esistente)`. Ma un'ora MAI FIRMATA non ha nessuna riga, e nessun
      // uuid da indicare: era esattamente il caso scoperto — la maestra che si
      // assenta due giorni non può più firmare, il dirigente non può
      // autorizzarla, e la pagina gli mostra «Richiedi lo sblocco al dirigente»
      // rivolto a sé stesso. `primaria/sblocca` scrive l'autorizzazione per
      // COORDINATE (section_id, data, ora_lezione); senza questo lettore la
      // scriveva e non la leggeva nessuno: 200 al dirigente, 423 alla maestra.
      // Il DB E2E della CI (non migrato) non ha `section_id`/`data`/`ora_lezione`
      // su `sblocchi_audit`: se lo slot l'ha già detto, il giorno non si chiede.
      let schemaSenzaCoordinate = false
      if (!overridden) {
        const { data: sbloccoSlot, error: slotErr } = await supabase
          .from('sblocchi_audit')
          .select('id')
          .eq('entita_tipo', 'registro')
          .eq('section_id', sectionId)
          .eq('data', data)
          .eq('ora_lezione', oraLezione)
          .limit(1)
          .maybeSingle()
        if (slotErr) {
          // `42703` NON è un guasto: è il DB E2E della CI, che è un progetto
          // separato e non migrato, dove le tre colonne non esistono ancora.
          // Lì «colonna assente» vale «nessuno sblocco per slot» → 423, cioè lo
          // stato precedente a questa funzione. Trattarlo come guasto darebbe
          // 500 dove la CI oggi prende 423: una regressione introdotta dal
          // lettore, non dalla firma. Ogni ALTRO errore resta un guasto vero e
          // si dichiara, invece di travestirsi da lock.
          if ((slotErr as { code?: string }).code === '42703') {
            schemaSenzaCoordinate = true
            logEvento('registro', 'info', {
              operazione: 'primaria/registro:POST',
              esito: 'sblocco-per-slot-non-disponibile-schema',
              sezione: sectionId, ordine: oraLezione,
            }, slotErr)
          } else {
            logEvento('registro', 'error', {
              operazione: 'primaria/registro:POST',
              esito: 'sblocco-slot-non-risolto',
              sezione: sectionId, ordine: oraLezione,
            }, slotErr)
            return NextResponse.json({ error: 'Verifica dello sblocco non riuscita.', codice: 'LETTURA_FALLITA' }, { status: 500 })
          }
        } else if (sbloccoSlot) {
          overridden = true
          // Un successo che si logga: senza, «nessun log» non distingue «non è
          // mai stato sbloccato» da «sbloccato e passato».
          logEvento('registro', 'info', {
            operazione: 'primaria/registro:POST',
            esito: 'firma-tardiva-autorizzata-per-slot',
            sezione: sectionId, ordine: oraLezione,
          })
        }
      }

      // ── LO SBLOCCO DEL GIORNO DELLA CLASSE ────────────────────────────────
      //
      // «Sblocca tutto il registro di questa classe per questa data» (spec
      // 2026-09-24: lo sblocco è «voce per voce E per classe+giorno») scrive
      // `entita_tipo = 'giorno'` con sezione + data. Modifiche ed eliminazioni lo
      // leggevano già (`permesso-voce`); la FIRMA no, e la pagina diceva
      // «giornata sbloccata» a una Direzione la cui maestra prendeva ancora 423
      // firmando l'ora mancante. Stessa tolleranza `42703` del lettore per slot.
      if (!overridden && !schemaSenzaCoordinate) {
        const { data: sbloccoGiorno, error: giornoErr } = await supabase
          .from('sblocchi_audit')
          .select('id')
          .eq('entita_tipo', 'giorno')
          .eq('section_id', sectionId)
          .eq('data', data)
          .limit(1)
          .maybeSingle()
        if (giornoErr) {
          if ((giornoErr as { code?: string }).code === '42703') {
            logEvento('registro', 'info', {
              operazione: 'primaria/registro:POST',
              esito: 'sblocco-per-giorno-non-disponibile-schema',
              sezione: sectionId, ordine: oraLezione,
            }, giornoErr)
          } else {
            logEvento('registro', 'error', {
              operazione: 'primaria/registro:POST',
              esito: 'sblocco-giorno-non-risolto',
              sezione: sectionId, ordine: oraLezione,
            }, giornoErr)
            return NextResponse.json({ error: 'Verifica dello sblocco non riuscita.', codice: 'LETTURA_FALLITA' }, { status: 500 })
          }
        } else if (sbloccoGiorno) {
          overridden = true
          logEvento('registro', 'info', {
            operazione: 'primaria/registro:POST',
            esito: 'firma-tardiva-autorizzata-per-giorno',
            sezione: sectionId, ordine: oraLezione,
          })
        }
      }

      if (!overridden) {
        // Il CODICE e il limite come `rispostaPermessoNegato`: la pagina mostra il
        // numero di giorni sulla riga, e il testo del catalogo nella lingua
        // dell'interfaccia invece della prosa italiana qui sotto.
        logEvento('registro', 'info', {
          operazione: 'primaria/registro:POST',
          esito: 'firma-bloccata-oltre-termine',
          sezione: sectionId, ordine: oraLezione, giorni_limite: lock.giorniLimite,
        })
        return NextResponse.json(
          {
            error: `Registrazione bloccata: superato il termine di ${lock.giorniLimite} giorni. Richiedi lo sblocco al dirigente.`,
            codice: 'VOCE_BLOCCATA',
            giorniLimite: lock.giorniLimite,
            locked: true,
          },
          { status: 423 }
        )
      }
    }

    // P7/B1 — due condizioni DISTINTE (prima erano fuse in `isIndipendente`):
    //  · haDestinatari  = l'assegnazione è mirata ad alunni selezionati → si scrivono i
    //    contenuti "propri" (argomento_proprio/compiti_propri) e si popola
    //    registro_destinatari. Vale per QUALSIASI tipo firma, non solo il sostegno.
    //  · sopprimeCondivisi = QUALSIASI assegnazione mirata NON deve toccare i contenuti
    //    CONDIVISI di classe (argomento/compiti/materia della riga registro_orario). La riga è
    //    CONDIVISA fra i docenti (upsert onConflict classe_sezione,data,ora_lezione): quando un
    //    docente non-titolare assegna ai soli alunni selezionati, il client non mostra nemmeno i
    //    textarea condivisi, che arriverebbero VUOTI — scriverli AZZEREREBBE l'argomento/compiti
    //    del titolare (REGRESSIONE ciclo-1 B1, qui corretta). Il sostegno resta un caso
    //    particolare del generale: comportamento invariato, i suoi condivisi non si toccano mai.
    const haDestinatari = destinatariIds.length > 0
    const sopprimeCondivisi = haDestinatari

    // ═══ CHIAVE ASSENTE ≠ CHIAVE VUOTA, E VUOTO ≠ «CANCELLA QUELLO DI UN ALTRO» ══
    //
    // I contenuti CONDIVISI si scrivono SOLO per l'assegnazione a TUTTA la classe
    // (nessun destinatario). Dentro quel ramo valgono TRE casi, non due:
    //   · chiave assente (`undefined`)  → si OMETTE dall'upsert. Sull'UPDATE di
    //     una riga già firmata dal titolare, `argomento: null` AZZEREREBBE il suo
    //     testo; omettere la chiave lo lascia intatto (e in INSERT vale comunque
    //     il default null della colonna). È la difesa B1, e resta.
    //   · chiave presente e PIENA → si scrive, sempre.
    //   · chiave presente e VUOTA (`''`/`null`) → si scrive `null` **solo se non
    //     cancella niente** (la riga non c'era, o quel campo era già vuoto) oppure
    //     **se il client dichiara `condivisiIdratati`**. Fino al 2026-09-09 qui
    //     c'era `if (valore)`, quindi cancellare l'argomento di classe dalla modale
    //     era IMPOSSIBILE: si svuotava il riquadro, si salvava, e il vecchio testo
    //     tornava al ricaricamento. Nessun errore, nessun log. Il rimedio
    //     (`if (x !== undefined)`) ha però aperto la porta accanto: la coda offline
    //     manda i tre condivisi SEMPRE, `null` compresi, e al rientro in rete
    //     cancellava il testo di un collega. Vedi `condivisiIdratati` nello schema.
    //
    // ⚠️ `materiaId` NON segue la stessa regola, ed è una scelta: in supplenza il
    // client manda `materiaId: null` **cablato** (`altraClasse ? null : …`) perché
    // le materie dell'altra classe non le ha caricate. Lì `null` vuol dire «non lo
    // so», non «cancellala», e trattarlo come un azzeramento cancellerebbe la
    // materia scritta dal titolare sulla riga condivisa.
    const precedente = esistente as { argomento?: string | null; compiti?: string | null; data_consegna_compiti?: string | null } | null

    /**
     * Il valore condiviso da mettere nell'upsert, o `undefined` per non toccarlo.
     * Torna anche `rifiutato: true` quando un azzeramento è stato NEGATO: quello è
     * il segnale che un client sta mandando vuoto ciò che non ha letto, e va contato.
     */
    const condiviso = (
      valore: string | null | undefined,
      vecchio: string | null | undefined,
    ): { scrivi: false; rifiutato: boolean } | { scrivi: true; valore: string | null } => {
      if (valore === undefined) return { scrivi: false, rifiutato: false }
      if (valore) return { scrivi: true, valore }
      if (condivisiIdratati === true || !vecchio) return { scrivi: true, valore: null }
      return { scrivi: false, rifiutato: true }
    }

    const sharedFields: {
      materia_id?: string
      argomento?: string | null
      compiti?: string | null
      data_consegna_compiti?: string | null
    } = {}
    let azzeramentiRifiutati = 0
    if (!sopprimeCondivisi) {
      if (materiaId) sharedFields.materia_id = materiaId
      for (const [campo, arrivato, vecchio] of [
        ['argomento', argomento, precedente?.argomento],
        ['compiti', compiti, precedente?.compiti],
        ['data_consegna_compiti', dataConsegnaCompiti, precedente?.data_consegna_compiti],
      ] as const) {
        const esito = condiviso(arrivato, vecchio)
        if (esito.scrivi) sharedFields[campo] = esito.valore
        else if (esito.rifiutato) azzeramentiRifiutati++
      }
    }

    // ── L'AZZERAMENTO SI CONTA, PERCHÉ DIPENDE DA UN PATTO COL CLIENT ───────
    // Scrivere `null` su un campo condiviso è LEGITTIMO solo se il riquadro che
    // il docente ha lasciato vuoto rappresentava davvero il contenuto della riga.
    // Il patto ora è ESPLICITO (`condivisiIdratati`) e non più implicito, ma resta
    // un patto: perciò l'azzeramento non si vieta — è una funzione che serve — ma
    // si CONTA. Il numero dei campi svuotati, l'ora e la sezione. Mai il testo.
    // Livello `info` e non `warn`: è un gesto voluto dell'utente, non un guasto.
    const azzerati = ([
      ['argomento', sharedFields.argomento, precedente?.argomento],
      ['compiti', sharedFields.compiti, precedente?.compiti],
      ['data_consegna_compiti', sharedFields.data_consegna_compiti, precedente?.data_consegna_compiti],
    ] as const).filter(([campo, nuovo, vecchio]) => campo in sharedFields && nuovo === null && !!vecchio)
    if (azzerati.length) {
      logEvento('registro', 'info', {
        operazione: 'primaria/registro:POST', esito: 'condivisi-azzerati',
        sezione: sectionId, ordine: oraLezione, n: azzerati.length,
      })
    }
    // Il verso opposto, e questo è un `warn`: un client ha mandato VUOTO un campo
    // condiviso che a database è pieno, senza dichiarare di averlo letto. Oggi è la
    // coda offline, che spedisce i tre condivisi sempre; domani potrebbe essere una
    // modale che ha smesso di idratare. Senza questa riga il rifiuto sarebbe muto —
    // e un salvataggio che non salva, in silenzio, è il difetto di partenza.
    if (azzeramentiRifiutati) {
      logEvento('registro', 'warn', {
        operazione: 'primaria/registro:POST', esito: 'azzeramento-condivisi-non-dichiarato',
        sezione: sectionId, ordine: oraLezione, n: azzeramentiRifiutati,
      })
    }

    // ── IL TESTO CONDIVISO CHE VIENE BUTTATO, DETTO INVECE CHE TACIUTO ──────
    // Con un'assegnazione mirata i condivisi si sopprimono, ed è giusto: il testo
    // per gli alunni selezionati non deve finire nella riga di classe (è la
    // regressione B1). Ma se il client ne ha MANDATO uno pieno, quel testo sparisce
    // senza che nessuno lo dica, e la risposta è 200. Non si rifiuta — il sostegno
    // manda legittimamente `materiaId` e il lock
    // `primaria-registro-destinatari.test.ts` (caso c) esige che i condivisi pieni
    // vengano soppressi con 200 — ma si CONTA. `materiaId` resta fuori dal conteggio
    // apposta: il client lo spedisce sempre nella propria classe, anche in
    // assegnazione mirata, e contarlo renderebbe la riga rumore.
    if (sopprimeCondivisi && (argomento || compiti || dataConsegnaCompiti)) {
      logEvento('registro', 'info', {
        operazione: 'primaria/registro:POST', esito: 'condivisi-soppressi-non-scritti',
        sezione: sectionId, ordine: oraLezione,
      })
    }

    // ═══ LA FIRMA CHE NON SCRIVE NIENTE ══════════════════════════════════════
    //
    // Prima del 2026-09-09 questa route rispondeva **200 con la spunta e zero
    // contenuto** in due casi che dal client sono indistinguibili dal successo:
    //
    //  1. il docente sceglie «Alunni selezionati», scrive l'argomento e i compiti
    //     per loro, e NON spunta nessun nome. Il client manda i testi «propri» e
    //     `destinatariIds: []`, e OMETTE i condivisi: i propri si scrivono solo
    //     `if (haDestinatari)`, quindi il testo appena scritto viene buttato via
    //     in silenzio e resta solo la firma.
    //  2. non c'è NIENTE da scrivere: né materia, né condivisi, né propri, e la
    //     riga dell'ora non è documentata da nessun altro.
    //
    // 🔴 SI MISURA SU CIÒ CHE SI SCRIVERÀ, NON SU CIÒ CHE È ARRIVATO, e la prima
    // stesura sbagliava nei DUE versi perché guardava il payload: calcolata prima
    // che `sopprimeCondivisi` buttasse via i condivisi e prima che la regola
    // dell'azzeramento omettesse le chiavi vuote, lasciava passare richieste che
    // non scrivevano niente e ne respingeva altre che scrivevano eccome. Perciò sta
    // QUI, dopo `sharedFields`, e non due blocchi più in su.
    //
    // ⚠️ IL CASO 1 SI QUALIFICA CON `!contenutiCondivisi`, e non è pignoleria: il
    // client manda SEMPRE `argomentoProprio`/`compitiPropri` (sono stato del
    // componente, e `scegliClasse` azzera i destinatari ma NON quei due campi).
    // Un docente che scrive nei riquadri «selezionati», torna su «tutta la
    // classe» e compila l'argomento di classe manda quindi propri + condivisi +
    // zero destinatari: lì il contenuto di classe si salva eccome, e un 400
    // parlerebbe di due riquadri che a schermo non ci sono nemmeno più.
    //
    // ⚠️ IL CASO 2 GUARDA ANCHE LA RIGA GIÀ ESISTENTE, e questo è il punto che
    // rende la regola vera invece che solo severa: una firma di COMPRESENZA o di
    // COFIRMA è legittimamente vuota — «c'ero anch'io in quell'ora» — e
    // l'argomento l'ha già scritto il titolare. Rifiutarla avrebbe tolto una
    // funzione che non ha alcun difetto.
    //
    // ⚠️ E GUARDA LA SUPPLENZA, che è la funzione nuova di questo stesso lavoro.
    // Un supplente firma l'ora di una classe non sua: dell'argomento non sa niente
    // (lo scriverà la titolare) e a schermo non ha nemmeno la tendina della materia,
    // che il client nasconde e cabla a `null`. Il caso NORMALE della supplenza è
    // quindi una firma senza contenuto, e senza questa condizione la funzione nuova
    // inciampava nella guardia nuova con un 400 che suggeriva l'unico rimedio che
    // il supplente non ha. Firmare, lì, È il contenuto — ed è tracciato nell'audit
    // (`firma-in-supplenza`, più sotto).
    const contenutiCondivisi = !!(materiaId || argomento || compiti || dataConsegnaCompiti)
    const contenutiPropri = !!(argomentoProprio || compitiPropri)
    const rigaGiaDocumentata = !!(esistente && (esistente.materia_id || esistente.argomento || esistente.compiti))

    // Ciò che finirà DAVVERO nella riga condivisa: un valore pieno, oppure un `null`
    // che cancella qualcosa (che è una scrittura). Un `null` su un campo già vuoto
    // non è contenuto: è il caso della firma nuova su un'ora mai documentata.
    const scriveCondivisi = (Object.entries(sharedFields) as [keyof typeof sharedFields, string | null][])
      .some(([campo, valore]) => valore !== null || !!(precedente as Record<string, unknown> | null)?.[campo])

    // Un'uscita sola con due motivi, e non due `NextResponse` gemelle: la frase
    // cambia perché il rimedio è diverso — «seleziona un alunno» contro «scrivi
    // qualcosa» — mentre il rifiuto è lo stesso. È il `logEvento` a tenerli
    // distinti in `app_log`, che è dove si contano.
    const motivoFirmaVuota =
      contenutiPropri && !haDestinatari && !contenutiCondivisi
        ? {
            esito: 'firma-senza-destinatari',
            testo:
              "Nessun alunno selezionato: l'argomento e i compiti per gli alunni selezionati non verrebbero salvati. Seleziona almeno un alunno, oppure passa a «Tutta la classe».",
          }
        : !scriveCondivisi && !haDestinatari && !rigaGiaDocumentata && !supplenza
          ? {
              esito: 'firma-senza-contenuto',
              testo: "Firma vuota: indica almeno la materia, l'argomento o i compiti di questa ora.",
            }
          : null
    if (motivoFirmaVuota) {
      logEvento('registro', 'info', {
        operazione: 'primaria/registro:POST', esito: motivoFirmaVuota.esito,
        sezione: sectionId, ordine: oraLezione,
      })
      return NextResponse.json({ error: motivoFirmaVuota.testo }, { status: 400 })
    }

    const rigaRegistro = {
      scuola_id: section.scuola_id,
      section_id: sectionId,
      classe_sezione: section.name,
      data,
      ora_lezione: oraLezione,
      da_orario: daOrario ?? false,
      ...sharedFields,
    }
    let regRes = await supabase
      .from('registro_orario')
      .upsert(rigaRegistro, { onConflict: CHIAVE_REGISTRO })
      .select()
      .single()
    if (vincoloConflittoAssente(regRes.error)) {
      logEvento('registro', 'info', {
        operazione: 'primaria/registro:POST',
        esito: 'vincolo-per-sede-assente-ripiego-legacy',
      })
      regRes = await supabase
        .from('registro_orario')
        .upsert(rigaRegistro, { onConflict: CHIAVE_REGISTRO_LEGACY })
        .select()
        .single()
    }
    const { data: registroRow, error: regErr } = regRes
    // Il `message` di PostgREST NON esce verso il docente: riecheggia nomi di
    // tabella e di vincolo (`registro_orario_ora_lezione_check`). Resta nel log,
    // intero, che è dove dice perché. Stessa forma di `parent/primaria/assenze`.
    if (regErr) {
      logEvento('registro', 'error', {
        operazione: 'primaria/registro:POST', esito: 'riga-registro-non-scritta',
        sezione: sectionId, ordine: oraLezione,
      }, regErr)
      return NextResponse.json({ error: 'Salvataggio della lezione non riuscito' }, { status: 500 })
    }

    // Una sola firma "principale" per ora/materia: un secondo docente non può
    // firmare come principale la stessa riga (usare compresenza/cofirma). Il
    // vincolo è ribadito a DB da un indice parziale unico (migr. 20260708),
    // ma il guard applicativo copre anche il DB E2E non migrato e dà un messaggio chiaro.
    if (tipoCompresenza === 'principale') {
      const { data: altraPrincipale, error: altraErr } = await supabase
        .from('firme_docenti')
        .select('id')
        .eq('registro_id', registroRow.id)
        .eq('tipo_compresenza', 'principale')
        .neq('maestra_id', firmaUserId)
        .limit(1)
        .maybeSingle()
      // `{ error }` scartato = guard saltato: l'indice parziale del database
      // rifiutava poi l'upsert e il docente riceveva un **500 col testo grezzo**
      // invece del 409 leggibile che questo blocco esiste per dare.
      if (altraErr) {
        logEvento('registro', 'error', {
          operazione: 'primaria/registro:POST', esito: 'firma-principale-non-verificata',
          sezione: sectionId, entita_id: registroRow.id,
        }, altraErr)
        return NextResponse.json({ error: 'Verifica della firma principale non riuscita.', codice: 'LETTURA_FALLITA' }, { status: 500 })
      }
      if (altraPrincipale) {
        return NextResponse.json(
          { error: 'Esiste già una firma principale per questa ora. Firma come compresenza o cofirma.' },
          { status: 409 }
        )
      }
    }

    // UPSERT firma del docente. Simmetrico ai condivisi: la chiave NON inviata si
    // OMETTE. La coda offline (`syncEngine.syncPendingRegistro`) manda solo i campi
    // di classe, e prima del 2026-09-09 il suo upsert scriveva comunque
    // `argomento_proprio: null` — cioè il rientro in rete di una firma di classe
    // cancellava i contenuti individualizzati già scritti dallo stesso docente.
    const firmaFields: {
      registro_id: string
      maestra_id: string
      tipo_compresenza: string
      argomento_proprio?: string | null
      compiti_propri?: string | null
    } = {
      registro_id: registroRow.id,
      maestra_id: firmaUserId,
      tipo_compresenza: tipoCompresenza,
    }
    if (argomentoProprio !== undefined) firmaFields.argomento_proprio = haDestinatari ? argomentoProprio || null : null
    if (compitiPropri !== undefined) firmaFields.compiti_propri = haDestinatari ? compitiPropri || null : null

    const { data: firmaRow, error: firmaErr } = await supabase
      .from('firme_docenti')
      .upsert(firmaFields, { onConflict: 'registro_id,maestra_id' })
      .select()
      .single()
    if (firmaErr) {
      logEvento('registro', 'error', {
        operazione: 'primaria/registro:POST', esito: 'firma-non-scritta',
        sezione: sectionId, entita_id: registroRow.id,
      }, firmaErr)
      return NextResponse.json({ error: 'Salvataggio della firma non riuscito' }, { status: 500 })
    }

    // Destinatari (assegnazione mirata): sostituisce quelli della firma. Solo quando
    // l'assegnazione è mirata ad alunni selezionati (haDestinatari); l'assegnazione di
    // classe non tocca la tabella. PostgREST non lancia: controlla ogni ritorno.
    if (haDestinatari && firmaRow) {
      const { error: delDestErr } = await supabase.from('registro_destinatari').delete().eq('firma_id', firmaRow.id)
      if (delDestErr) {
        logErrore({ operazione: 'primaria/registro:POST', evento: 'db', stato: 500 }, delDestErr)
        return NextResponse.json({ error: 'Aggiornamento dei destinatari non riuscito' }, { status: 500 })
      }
      const rows = destinatariIds.map((alunnoId) => ({
        registro_id: registroRow.id,
        firma_id: firmaRow.id,
        alunno_id: alunnoId,
      }))
      if (rows.length) {
        const { error: insDestErr } = await supabase.from('registro_destinatari').insert(rows)
        if (insDestErr) {
          logErrore({ operazione: 'primaria/registro:POST', evento: 'db', stato: 500 }, insDestErr)
          return NextResponse.json({ error: 'Aggiornamento dei destinatari non riuscito' }, { status: 500 })
        }
      }
    }

    // Notifica compiti (buffer). Due destinatari distinti, SENZA doppioni allo stesso
    // genitore: gli alunni selezionati ricevono il testo "proprio"; il RESTO della classe
    // (esclusi i selezionati) riceve il testo condiviso, ma solo se quest'ultimo è stato
    // scritto (non soppresso). Best-effort: un fallimento non blocca il salvataggio, ma
    // NON è muto — si logga (uuid, mai i testi dei compiti).
    try {
      const notificaCompiti = {
        tipo: 'compiti',
        titolo: 'Nuovi compiti assegnati',
        link: '/parent/compiti',
        entitaTipo: 'registro',
        entitaId: registroRow.id,
        scuolaId: section.scuola_id,
      }
      // 1) Alunni selezionati → testo proprio.
      if (haDestinatari && compitiPropri) {
        await enqueueNotifichePerAlunni(supabase, {
          ...notificaCompiti,
          alunnoIds: destinatariIds,
          corpo: compitiPropri.slice(0, 140),
        })
      }
      // 2) Resto della classe → testo condiviso (solo se non soppresso).
      if (compiti && !sopprimeCondivisi) {
        // ─── CHI È «LA CLASSE» ──────────────────────────────────────────────
        // Il vocabolario degli stati è UNO e sta in `@/lib/alunni/stato`: un
        // `sospeso` frequenta e i compiti li riceve, un `ritirato` no. Fino al
        // 2026-09-09 qui non c'era filtro affatto, mentre
        // `primaria/classe/[sectionId]:GET` — che alimenta la STESSA schermata —
        // filtra `stato = 'iscritto'`: due letture della stessa classe che non
        // concordavano. Misurato il 2026-09-09 su produzione: zero alunni con
        // `stato <> 'iscritto'` e `section_id` valorizzato, quindi oggi il verso
        // pericoloso (notificare un ritirato) è chiuso di fatto; la divergenza
        // viva è l'altra, e sta dalla parte giusta di questo filtro.
        type RigaClasse = { id: string; stato?: string | null }
        const conStato = await supabase.from('alunni').select('id, stato').eq('section_id', sectionId)
        let statoNoto = true
        let righeClasse = (conStato.data ?? []) as RigaClasse[]
        let erroreClasse: unknown = conStato.error
        if ((conStato.error as { code?: string } | null)?.code === '42703') {
          // DB E2E non migrato: la colonna non c'è → si degrada APERTI, nessuno
          // escluso. Togliere i compiti a un bambino perché uno schema è indietro
          // è il verso sbagliato in cui sbagliare. Modello: `@/lib/alunni/attivo`.
          logEvento('registro', 'warn', {
            operazione: 'primaria/registro:POST', esito: 'stato-alunni-non-leggibile',
            sezione: sectionId,
          }, conStato.error)
          statoNoto = false
          const senzaStato = await supabase.from('alunni').select('id').eq('section_id', sectionId)
          righeClasse = (senzaStato.data ?? []) as RigaClasse[]
          erroreClasse = senzaStato.error
        }
        if (erroreClasse) {
          logEvento('push', 'warn', {
            operazione: 'primaria/registro:POST',
            esito: 'notifica_compiti_classe_non_risolta',
            sezione: sectionId,
            entita_id: registroRow.id,
          }, erroreClasse)
        } else {
          const esclusi = new Set(destinatariIds)
          const target = righeClasse
            .filter((a) => !statoNoto || eAncoraIscritto(a.stato))
            .map((a) => a.id)
            .filter((id) => !esclusi.has(id))
          if (target.length) {
            await enqueueNotifichePerAlunni(supabase, {
              ...notificaCompiti,
              alunnoIds: target,
              corpo: compiti.slice(0, 140),
            })
          }
        }
      }
    } catch (err) {
      // Il catch NON risponde 500 (best-effort), quindi withRoute non lo vedrebbe: si logga qui.
      logEvento('push', 'warn', {
        operazione: 'primaria/registro:POST',
        esito: 'notifica_compiti_fallita',
        sezione: sectionId,
        entita_id: firmaRow?.id ?? registroRow.id,
      }, err)
    }

    // ── L'AUDIT DEVE POTER RISPONDERE «CHI HA FIRMATO IN UNA CLASSE NON SUA» ──
    // Il flag c'è SEMPRE, anche a `false`: un campo presente solo qualche volta
    // rende «assente» ambiguo fra «non era una supplenza» e «l'ha scritto una
    // versione vecchia», e l'audit serve proprio a rispondere a posteriori.
    // È un booleano: `riduciValoreAudit` lo lascia passare e non porta con sé
    // nulla di personale.
    if (supplenza) {
      logEvento('registro', 'info', {
        operazione: 'primaria/registro:POST', esito: 'firma-in-supplenza',
        sezione: sectionId, ruolo: auth.user.role, ordine: oraLezione,
      })
    }
    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'registro',
      entitaId: registroRow.id,
      azione: 'update',
      scuolaId: section.scuola_id,
      sectionId,
      valoreDopo: { registro: registroRow, firma: firmaRow, supplenza },
    })
    await notificaTitolariScrittura(supabase, { attore: auth.user, sectionId, scuolaId: section.scuola_id, area: 'registro', link: `/teacher/primaria/${sectionId}/registro` })

    return NextResponse.json({ success: true, data: { registro: registroRow, firma: firmaRow }, supplenza })
  } catch (err) {
    logErrore({ operazione: 'primaria/registro:POST', stato: 500 }, err)
    // Il `message` dell'eccezione NON esce verso il docente, ed è il gemello del
    // `catch` della GET, chiuso qualche riga più su per la stessa ragione: quello di
    // PostgREST riecheggia filtri, nomi di tabella e di vincolo
    // (`registro_orario_ora_lezione_check`), e questa è la strada che SCRIVE. Il
    // messaggio intero resta in `logErrore`, che è dove dice perché.
    return NextResponse.json(
      { error: 'Non siamo riusciti a salvare la firma del registro.', codice: 'FIRMA_NON_SALVATA' },
      { status: 500 },
    )
  }
})

// ═══ DELETE — ELIMINARE LA PROPRIA FIRMA, O LA LEZIONE INTERA ═══════════════
//
// Spec 2026-09-24, «2 Primaria» e «Decisioni aggiunte prima del lancio»:
//  · `?firmaId=` — chi ha firmato elimina la PROPRIA firma, con i suoi
//    destinatari. Se era l'UNICA firma della lezione, sparisce la lezione.
//  · `?registroId=` — la lezione intera: solo Segreteria e Direzione
//    (`segreteria`/`admin`/`coordinator`).
// Chi e fino a quando lo decide `@/lib/primaria/permesso-voce` (tipo `firma` o
// `registro`, termine sulla `data` della lezione, sblocchi per voce, slot o
// giorno). Cancellazione VERA, con la traccia `logScrittura('delete')`.
//
// ─── GLI ALLEGATI NON SI CANCELLANO CON LA LEZIONE ──────────────────────────
// Vanno nel CESTINO per 7 giorni (`eliminato_il`, `eliminato_da`, più lo slot
// d'origine `slot_section_id`/`slot_data`/`slot_ora_lezione`), e si possono
// ripristinare solo rifirmando lo stesso slot. L'ORDINE È PORTANTE: prima il
// cestino, poi il DELETE della lezione. Con la migrazione
// `20260924220000_primaria_modifica_elimina.sql` la FK diventa `ON DELETE SET
// NULL`, e il vincolo `allegati_registro_senza_lezione_nel_cestino_check`
// rifiuta (23514) un allegato senza lezione che non sia nel cestino con lo slot:
// nell'ordine inverso il DELETE fallirebbe. Se il DELETE della lezione fallisce
// DOPO il cestino, il cestino si annulla sugli stessi id: un allegato nel cestino
// accanto alla SUA lezione ancora viva sarebbe un file sparito senza motivo.
//
// ─── LA NOTIFICA «NUOVI COMPITI» ─────────────────────────────────────────────
// Quella già partita (`push_inviata_il` valorizzato) resta: nessuna rettifica.
// Quella ancora in coda (buffer di 10') si RITIRA, e solo dopo la scrittura
// riuscita — ritirarla e poi non riuscire a eliminare lascerebbe compiti veri
// senza avviso. Lezione eliminata → tutte le sue `compiti` in coda. Firma
// eliminata (la lezione resta) → solo quelle col testo PROPRIO di quella firma,
// ai genitori dei SUOI destinatari: i compiti di classe restano validi.
//
// Nessuna coda offline: eliminare chiede la connessione.
const deleteQuerySchema = z
  .object({
    firmaId: zUuid.optional(),
    registroId: zUuid.optional(),
  })
  .refine((q) => !!q.firmaId !== !!q.registroId, {
    message: 'Indica la firma (firmaId) oppure la lezione (registroId), non entrambe',
  })

/** Chi può eliminare la lezione INTERA. Gli altri eliminano solo la propria firma. */
const RUOLI_LEZIONE_INTERA = ['segreteria', 'admin', 'coordinator'] as const

/** Le colonne che il database E2E della CI (non migrato) può non avere. */
const CESTINO_ASSENTE = new Set(['42703', 'PGRST204'])

/**
 * Perché il conteggio degli allegati sul DB NON migrato non filtra il cestino: lì la
 * colonna `eliminato_il` non esiste (è proprio l'errore che ha portato qui), e la FK è
 * ancora in CASCADE: ogni allegato, qualunque cosa sia, verrebbe cancellato con la lezione.
 */
const MOTIVO_ALLEGATI_SENZA_CESTINO =
  'sul database non migrato la colonna eliminato_il non esiste e la FK verso la lezione è ancora ' +
  'ON DELETE CASCADE: si contano TUTTI gli allegati della lezione, perché eliminarla li ' +
  'cancellerebbe tutti insieme ai loro file.'

type LezioneDaEliminare = {
  id: string
  scuola_id: string
  section_id: string
  data: string
  ora_lezione: number
  materia_id: string | null
  argomento: string | null
  compiti: string | null
  data_consegna_compiti: string | null
}

type FirmaDaEliminare = {
  id: string
  registro_id: string | null
  maestra_id: string
  tipo_compresenza: string | null
  argomento_proprio: string | null
  compiti_propri: string | null
}

const COLONNE_LEZIONE = 'id, scuola_id, section_id, data, ora_lezione, materia_id, argomento, compiti, data_consegna_compiti'
const COLONNE_FIRMA = 'id, registro_id, maestra_id, tipo_compresenza, argomento_proprio, compiti_propri'

export const DELETE = withRoute('primaria/registro:DELETE', async (request: NextRequest) => {
  const operazione = 'primaria/registro:DELETE'
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, deleteQuerySchema)
    if ('response' in q) return q.response
    const { firmaId, registroId } = q.data
    const user = auth.user

    // La lezione intera è della Segreteria e della Direzione: il docente elimina
    // la propria firma. Si nega PRIMA di leggere qualunque cosa.
    if (registroId && !haUnRuolo(user, RUOLI_LEZIONE_INTERA)) {
      logEvento('registro', 'info', { operazione, esito: 'lezione-intera-negata-ruolo', ruolo: user.role })
      return NextResponse.json(
        { error: 'Solo la Segreteria e la Direzione possono eliminare la lezione intera.', codice: 'LEZIONE_ELIMINA_SOLO_STAFF' },
        { status: 403 },
      )
    }

    const supabase = await createAdminClient()

    const guasto = (esito: string, err: unknown, campi: Record<string, string | number | null> = {}) => {
      logEvento('registro', 'error', { operazione, esito, ...campi }, err)
      return NextResponse.json(
        { error: 'Non siamo riusciti a eliminare dal registro. Ricarica e controlla.', codice: 'REGISTRO_NON_ELIMINATO' },
        { status: 500 },
      )
    }
    const letturaFallita = (esito: string, err: unknown, campi: Record<string, string | number | null> = {}) => {
      logEvento('registro', 'error', { operazione, esito, ...campi }, err)
      return NextResponse.json({ error: 'Lettura del registro non riuscita.', codice: 'LETTURA_FALLITA' }, { status: 500 })
    }
    const lezioneNonTrovata = () =>
      NextResponse.json({ error: 'Lezione non trovata', codice: 'LEZIONE_NON_TROVATA' }, { status: 404 })

    // ── 1. LA VOCE: firma (con la sua lezione) oppure lezione ─────────────────
    let firma: FirmaDaEliminare | null = null
    let idLezione: string
    if (firmaId) {
      const { data: f, error: fErr } = await supabase
        .from('firme_docenti')
        .select(COLONNE_FIRMA)
        .eq('id', firmaId)
        .maybeSingle()
      if (fErr) return letturaFallita('firma-non-letta', fErr, { firma_id: firmaId })
      if (!f || !(f as FirmaDaEliminare).registro_id) {
        return NextResponse.json({ error: 'Firma non trovata', codice: 'FIRMA_NON_TROVATA' }, { status: 404 })
      }
      firma = f as FirmaDaEliminare
      idLezione = firma.registro_id as string
    } else {
      idLezione = registroId as string
    }

    const { data: l, error: lErr } = await supabase
      .from('registro_orario')
      .select(COLONNE_LEZIONE)
      .eq('id', idLezione)
      .maybeSingle()
    if (lErr) return letturaFallita('lezione-non-letta', lErr, { registro_id: idLezione })
    if (!l || !(l as LezioneDaEliminare).section_id) return lezioneNonTrovata()
    const lezione = l as LezioneDaEliminare

    // ── 2. SCOPE. La firma segue la POST: chi ha firmato in SUPPLENZA deve poter
    //    togliere la propria firma da una classe non sua (stessa sede, primaria,
    //    grado). La lezione intera è della Segreteria/Direzione del plesso.
    if (firma) {
      const scope = await assertSezionePrimariaFirmabile(supabase, user, lezione.section_id)
      if (scope.response) return scope.response
      const gradoErr = await assertGradoDocente(user, 'primaria')
      if (gradoErr) return gradoErr
    } else {
      // Lo stesso gate della firma e della POST, non `assertSezioneInScope`:
      // `registro_orario` è CONDIVISO col registro 0-6 (`register/lessons:POST`
      // ci scrive le lezioni di nido e infanzia), e da questa porta si cancellano
      // solo lezioni di PRIMARIA. Per lo staff (`vedeTutteLeClassi`) equivale a
      // sede + `school_type = 'primaria'`: altrimenti 403 `CLASSE_NON_DI_PRIMARIA`.
      const scope = await assertSezionePrimariaFirmabile(supabase, user, lezione.section_id)
      if (scope.response) return scope.response
    }

    // ── 3. CHI E FINO A QUANDO ────────────────────────────────────────────────
    const permesso = await verificaPermessoVoce(supabase, user, {
      tipo: firma ? 'firma' : 'registro',
      id: firma ? firma.id : lezione.id,
      // La lezione intera non ha un autore unico: resta solo lo staff (già
      // verificato qui sopra), e il termine vale anche per lui.
      autoreId: firma ? firma.maestra_id : null,
      sectionId: lezione.section_id,
      scuolaId: lezione.scuola_id,
      dataEvento: String(lezione.data).slice(0, 10),
      oraLezione: lezione.ora_lezione,
    })
    if (!permesso.ok) return rispostaPermessoNegato(permesso)

    // ── 4. LE FIRME DELLA LEZIONE: l'ultima porta via la lezione ──────────────
    const { data: firmeLette, error: firmeErr } = await supabase
      .from('firme_docenti')
      .select('id, maestra_id, tipo_compresenza')
      .eq('registro_id', lezione.id)
    if (firmeErr) return letturaFallita('firme-lezione-non-lette', firmeErr, { registro_id: lezione.id })
    const firme = (firmeLette ?? []) as { id: string; maestra_id: string; tipo_compresenza: string | null }[]

    // ═══ 4a. SOLO LA FIRMA: la lezione ha altre firme e resta ═══════════════
    // ⚠️ La finestra fra questa lettura e il DELETE è di millisecondi: una
    // cofirma che arrivasse proprio lì verrebbe cancellata con la lezione. Non
    // c'è un DELETE condizionato su un'altra tabella in PostgREST; lo si accetta
    // e lo si scrive.
    if (firma && firme.some((f) => f.id !== firma!.id)) {
      const { data: destLetti, error: destErr } = await supabase
        .from('registro_destinatari')
        .select('id, alunno_id')
        .eq('firma_id', firma.id)
      if (destErr) return letturaFallita('destinatari-non-letti', destErr, { firma_id: firma.id })
      const destinatari = (destLetti ?? []) as { id: string; alunno_id: string }[]

      // I destinatari se ne vanno con la firma: `registro_destinatari_firma_id_fkey`
      // è `ON DELETE CASCADE` (misurato su `pg_constraint` il 2026-09-25). Un solo
      // DELETE, quindi atomico: mai una firma rimasta senza i suoi destinatari —
      // che la farebbe leggere come assegnata a tutta la classe.
      const { data: cancellate, error: delErr } = await supabase
        .from('firme_docenti')
        .delete()
        .eq('id', firma.id)
        .eq('registro_id', lezione.id)
        .select('id')
      if (delErr) return guasto('firma-non-eliminata', delErr, { firma_id: firma.id })
      if (((cancellate ?? []) as unknown[]).length === 0) {
        return NextResponse.json({ error: 'Firma non trovata', codice: 'FIRMA_NON_TROVATA' }, { status: 404 })
      }

      // Nessun DELETE esplicito sui destinatari: la cascata la fa la FK
      // `registro_destinatari_firma_id_fkey`, `ON DELETE CASCADE` già nella
      // baseline (quindi anche sul DB E2E non migrato), come per la lezione.
      // I destinatari letti qui sopra servono solo al ritiro della notifica e
      // all'audit.

      // La notifica in coda col testo PROPRIO di questa firma, ai genitori dei
      // SUOI destinatari. Best-effort: l'eliminazione è già avvenuta.
      let notificheRitirate = 0
      let ritiroRiuscito = true
      if (firma.compiti_propri && destinatari.length) {
        try {
          const perAlunno = await getGenitoriDiAlunni(supabase, destinatari.map((d) => d.alunno_id))
          const genitori = [...new Set([...perAlunno.values()].flat())]
          if (genitori.length) {
            const { data: ritirate, error: ritiroErr } = await supabase
              .from('notifiche')
              .delete()
              .eq('tipo', 'compiti')
              .eq('entita_tipo', 'registro')
              .eq('entita_id', lezione.id)
              .eq('corpo', firma.compiti_propri.slice(0, 140))
              .in('utente_id', genitori)
              .is('push_inviata_il', null)
              .select('id')
            if (ritiroErr) {
              ritiroRiuscito = false
              logEvento('notifica', 'error', { operazione, esito: 'ritiro-compiti-fallito', tipo: 'compiti', firma_id: firma.id }, ritiroErr)
            } else {
              notificheRitirate = ((ritirate ?? []) as unknown[]).length
            }
          }
        } catch (err) {
          ritiroRiuscito = false
          logEvento('notifica', 'error', { operazione, esito: 'ritiro-compiti-fallito', tipo: 'compiti', firma_id: firma.id }, err)
        }
      }

      await logScrittura(supabase, {
        attore: user,
        entitaTipo: 'firma',
        entitaId: firma.id,
        azione: 'delete',
        scuolaId: lezione.scuola_id,
        sectionId: lezione.section_id,
        valorePrima: {
          firma,
          destinatari: destinatari.map((d) => d.alunno_id),
          registro_id: lezione.id,
          data: lezione.data,
          ora_lezione: lezione.ora_lezione,
        },
        valoreDopo: null,
      })
      await notificaTitolariScrittura(supabase, {
        attore: user, sectionId: lezione.section_id, scuolaId: lezione.scuola_id,
        area: 'registro', link: `/teacher/primaria/${lezione.section_id}/registro`,
      })
      logEvento('registro', 'info', {
        operazione, esito: 'firma-eliminata',
        firma_id: firma.id, registro_id: lezione.id, sezione: lezione.section_id,
        n_destinatari: destinatari.length, notifiche_ritirate: notificheRitirate,
        ritiro_riuscito: ritiroRiuscito,
      }, undefined, { distingui: ['firma_id'] })
      return NextResponse.json({
        success: true,
        data: {
          eliminata: 'firma',
          firmaId: firma.id,
          registroId: lezione.id,
          allegatiNelCestino: 0,
          notificheRitirate,
        },
      })
    }

    // ═══ 4b. LA LEZIONE: intera, oppure con la sua ultima firma ═════════════
    const motivo = firma ? 'ultima-firma' : 'lezione-intera'
    const adesso = new Date().toISOString()

    // Il cestino. Lo slot si scrive dalla lezione ANCHE se il trigger
    // `trg_allegati_registro_copia_slot` l'ha già copiato all'aggancio: è lo
    // stesso valore, e l'allegato non dipende dalla memoria di un trigger per
    // poter tornare a casa.
    const cestino = await allegatiRegistroVivi(
      supabase
        .from('allegati_registro')
        .update({
          eliminato_il: adesso,
          eliminato_da: user.id,
          slot_section_id: lezione.section_id,
          slot_data: lezione.data,
          slot_ora_lezione: lezione.ora_lezione,
        })
        .eq('registro_id', lezione.id),
    ).select('id')
    let allegatiNelCestino: string[] = []
    if (cestino.error) {
      if (!CESTINO_ASSENTE.has((cestino.error as { code?: string }).code ?? '')) {
        return guasto('allegati-non-cestinati', cestino.error, { registro_id: lezione.id })
      }
      // DB NON MIGRATO (l'E2E della CI): le colonne del cestino non esistono, e
      // lì la FK è ancora `ON DELETE CASCADE` — eliminare la lezione CANCELLEREBBE
      // gli allegati senza cestino, lasciando i file orfani nello Storage. Senza
      // allegati non c'è niente da perdere e si procede; con allegati si rifiuta.
      // Qui non c'è un cestino da escludere: la colonna non esiste.
      const { data: presenti, error: presentiErr } = await allegatiRegistroAncheNelCestino(
        supabase
          .from('allegati_registro')
          .select('id')
          .eq('registro_id', lezione.id),
        MOTIVO_ALLEGATI_SENZA_CESTINO,
      )
      if (presentiErr) return letturaFallita('allegati-non-letti', presentiErr, { registro_id: lezione.id })
      const n = ((presenti ?? []) as unknown[]).length
      logEvento('registro', n ? 'warn' : 'info', {
        operazione, esito: 'cestino-allegati-non-disponibile-schema', registro_id: lezione.id, n,
      }, cestino.error)
      if (n) {
        return NextResponse.json(
          { error: 'La lezione ha allegati e il cestino non è ancora disponibile: non è stata eliminata.', codice: 'REGISTRO_CESTINO_NON_DISPONIBILE' },
          { status: 503 },
        )
      }
    } else {
      allegatiNelCestino = ((cestino.data ?? []) as { id: string }[]).map((a) => a.id)
      // Gli allegati GIÀ nel cestino (un file sostituito) di questa lezione hanno
      // lo slot per costruzione: la migrazione P0 lo ha riempito su tutti gli
      // allegati esistenti, e il trigger `trg_allegati_registro_copia_slot` lo
      // copia a ogni INSERT e a ogni UPDATE di `registro_id`. Il SET NULL della FK
      // li lascia quindi rintracciabili senza un secondo UPDATE qui.
    }

    // La cancellazione. Firme e destinatari se ne vanno con la lezione
    // (`firme_docenti_registro_id_fkey`, `registro_destinatari_registro_id_fkey`:
    // `ON DELETE CASCADE`). La sede è quella della riga LETTA, ripetuta qui.
    const { data: eliminate, error: delLezErr } = await supabase
      .from('registro_orario')
      .delete()
      .eq('id', lezione.id)
      .eq('scuola_id', lezione.scuola_id)
      .select('id')
    const nessunaRiga = !delLezErr && ((eliminate ?? []) as unknown[]).length === 0
    if (delLezErr || nessunaRiga) {
      // Il cestino si annulla: gli allegati tornano alla loro lezione, che è viva.
      if (allegatiNelCestino.length) {
        const { error: annullaErr } = await allegatiRegistroNelCestino(
          supabase
            .from('allegati_registro')
            .update({ eliminato_il: null, eliminato_da: null })
            .in('id', allegatiNelCestino)
            .eq('registro_id', lezione.id),
        )
        if (annullaErr) {
          logEvento('registro', 'error', {
            operazione, esito: 'cestino-non-annullato', registro_id: lezione.id, n: allegatiNelCestino.length,
          }, annullaErr)
        }
      }
      if (delLezErr) return guasto('lezione-non-eliminata', delLezErr, { registro_id: lezione.id })
      return lezioneNonTrovata()
    }

    // La notifica «nuovi compiti» ancora in coda si ritira; quella partita resta.
    let notificheRitirate = 0
    const { data: ritirate, error: ritiroErr } = await supabase
      .from('notifiche')
      .delete()
      .eq('tipo', 'compiti')
      .eq('entita_tipo', 'registro')
      .eq('entita_id', lezione.id)
      .is('push_inviata_il', null)
      .select('id')
    if (ritiroErr) {
      // `error` benché l'eliminazione sia riuscita: l'avviso partirà per compiti
      // che non esistono più.
      logEvento('notifica', 'error', { operazione, esito: 'ritiro-compiti-fallito', tipo: 'compiti', registro_id: lezione.id }, ritiroErr)
    } else {
      notificheRitirate = ((ritirate ?? []) as unknown[]).length
    }

    await logScrittura(supabase, {
      attore: user,
      entitaTipo: 'registro',
      entitaId: lezione.id,
      azione: 'delete',
      scuolaId: lezione.scuola_id,
      sectionId: lezione.section_id,
      valorePrima: {
        registro: lezione,
        firme,
        firma_eliminata: firma?.id ?? null,
        allegati_nel_cestino: allegatiNelCestino,
        motivo,
      },
      valoreDopo: null,
    })
    await notificaTitolariScrittura(supabase, {
      attore: user, sectionId: lezione.section_id, scuolaId: lezione.scuola_id,
      area: 'registro', link: `/teacher/primaria/${lezione.section_id}/registro`,
    })
    logEvento('registro', 'info', {
      operazione, esito: 'lezione-eliminata', tipo: motivo,
      registro_id: lezione.id, sezione: lezione.section_id,
      n_firme: firme.length, allegati_nel_cestino: allegatiNelCestino.length,
      notifiche_ritirate: notificheRitirate, ritiro_riuscito: !ritiroErr,
    }, undefined, { distingui: ['registro_id'] })

    return NextResponse.json({
      success: true,
      data: {
        eliminata: 'lezione',
        firmaId: firma?.id ?? null,
        registroId: lezione.id,
        allegatiNelCestino: allegatiNelCestino.length,
        notificheRitirate,
      },
    })
  } catch (err) {
    logErrore({ operazione, stato: 500 }, err)
    return NextResponse.json(
      { error: 'Non siamo riusciti a eliminare dal registro. Ricarica e controlla.', codice: 'REGISTRO_NON_ELIMINATO' },
      { status: 500 },
    )
  }
})
