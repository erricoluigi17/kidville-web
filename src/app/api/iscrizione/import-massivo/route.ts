/**
 * IL GIRO DI OGNI MATTINA — dalle domande ferme agli inviti spediti.
 *
 * Chiamata da `pg_cron` alle 08:10 UTC, che in agosto e settembre sono le 10:10
 * di Roma. Protetta da `x-cron-secret`, come gli altri diciotto lavori.
 *
 * I dieci minuti di scarto non sono un vezzo: `news-digest` gira `0 8 1 * *`
 * (`supabase/migrations/20260720191525_news_cron.sql:109`) e il 1° settembre
 * cadrebbe dentro questa finestra, contendendosi lo stesso limite Resend nello
 * stesso minuto. Spostarsi di dieci minuti toglie la corsa senza acrobazie.
 *
 * ─── LA FINESTRA STA QUI, NON NEL CRON ──────────────────────────────────────
 * Nessun cron sa dire «dal 22 agosto al 10 settembre». Il calendario lo tiene la
 * route: fuori da quelle date esce subito, senza fare niente e senza mandare il
 * riepilogo. Il job resta programmato tutto l'anno e non fa danni — è preferibile
 * a un `cron.unschedule` che qualcuno deve ricordarsi di eseguire.
 *
 * ─── COSA FA, IN ORDINE ─────────────────────────────────────────────────────
 *  0. RIPRENDE gli inviti rimasti indietro (chi aspetta da ieri viene prima)
 *  1. prende in carico un lotto (le più vecchie per prime, prestito 30 minuti)
 *  2. RIVEDE la decisione su ognuna, da capo, con l'elenco e le famiglie di OGGI
 *  3. esegue solo quelle certe, fino al tetto di 90 EMAIL
 *  4. lascia le altre come «da controllare», con il motivo scritto in italiano
 *  5. manda alla sede il riepilogo di cosa è successo
 *
 * Il punto 2 non è una ripetizione inutile: fra ieri e oggi può essere arrivata
 * la domanda di un fratello che risolve una retta, o la segreteria può aver
 * corretto il foglio. Una domanda ferma ieri può partire oggi da sola.
 *
 * ─── IL TETTO È SULLE EMAIL, NON SULLE DOMANDE ──────────────────────────────
 * Decisione del titolare, 2026-08-16. La risorsa scarsa è la quota del provider,
 * e una domanda non ne consuma una quantità fissa: dal 2026-08-16 ogni genitore
 * con un'email ha il suo account, quindi una domanda con due genitori costa il
 * DOPPIO di una con un genitore solo. Un tetto di «48 domande» significherebbe
 * un consumo compreso fra 48 e 96 email che nessuno conosce in anticipo — cioè
 * un numero che sembra un limite e non lo è.
 *
 * Quindi: si stima quanto costa una domanda PRIMA di cominciarla (le caselle
 * distinte dei suoi adulti che non hanno già ricevuto l'invito) e, se non ci
 * sta, la si rinvia INTERA. Mai a metà: una famiglia con un genitore dentro e
 * uno fuori è il solo esito che non si può spiegare a nessuno.
 *
 * La guardia dell'`emailOggi === 0` chiude il caso patologico: una domanda più
 * costosa dell'intero tetto non partirebbe MAI, e resterebbe in coda per sempre
 * senza che nessun log dica perché.
 *
 * ─── `dry_run` ──────────────────────────────────────────────────────────────
 * Con `{"dry_run": true}` fa tutto il ragionamento e NON scrive né manda niente:
 * nessun claim, nessuna anagrafica, nessuna email, nemmeno il riepilogo, e
 * nemmeno la ripresa. È il modo per guardare cosa succederebbe prima che succeda.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { segretoCronValido } from '@/lib/security/segreto-cron'
import { oggiFiscaleISO } from '@/lib/format/fiscal-date'
import { risolviContestoSede } from '@/lib/email/contesto'
import { sendEmailDetailed } from '@/lib/email/send'
import {
  INVITI_AL_GIORNO,
  caricaDecisioni,
  caricaElenco,
  costruisciFamiglie,
  domandaDaRiga,
  fratelliDi,
  trovaDuplicati,
} from '@/lib/iscrizioni/import/lotto'
import { decidi } from '@/lib/iscrizioni/import/analisi'
import { eseguiDomanda } from '@/lib/iscrizioni/import/esegui'
import { invitiPrevisti, riprendiInvitiSospesi } from '@/lib/iscrizioni/import/inviti'

const JOB = 'iscrizioni-import-invio'

/** La finestra decisa dal titolare. Estremi compresi, in ora italiana. */
export const PRIMO_GIORNO = '2026-08-22'
export const ULTIMO_GIORNO = '2026-09-10'

const bodySchema = z
  .object({
    dry_run: z.boolean().optional(),
    scuola_id: z.string().uuid().optional(),
    /** Il tetto di EMAIL del giro, non di domande. */
    max_inviti: z.number().int().min(0).max(500).optional(),
    /** Solo per il collaudo: ignora la finestra del calendario. */
    forza_fuori_finestra: z.boolean().optional(),
  })
  .partial()
  .optional()

export function dentroLaFinestra(oggi: string): boolean {
  return oggi >= PRIMO_GIORNO && oggi <= ULTIMO_GIORNO
}

export const POST = withRoute('iscrizione/import-massivo:POST', async (request: Request) => {
  const t0 = Date.now()
  // Il battito vive FUORI dal try, e si scrive nel `finally`. Dentro, un giro
  // che eccepisce non lascerebbe nessun `esito: 'ok'`, e /api/health conterebbe
  // muto un job che invece ha girato — la stessa cecità che gli altri due lavori
  // della famiglia hanno già chiuso mettendolo in un `finally`.
  let inviate = 0
  let battito = false
  /**
   * IL BATTITO NON SI EMETTE SE IL GATE HA DETTO NO, e non è un dettaglio.
   *
   * Questa porta è pubblica e senza tetto di frequenza: se il `finally` scrivesse
   * anche sul ramo 401, un bot che bussa diecimila volte scriverebbe diecimila
   * righe in `app_log` di produzione — con dentro la frase «concluso con errore»
   * su un gate che invece ha funzionato benissimo. È la stessa classe di guasto
   * che `__tests__/api/cron-battito.test.ts` blocca sulle altre cinque route
   * («il POST anonimo non fabbrica il segnale»); lì l'invariante è scritta sul
   * livello `error`, quindi una riga `warn` le sarebbe sfuggita.
   */
  let gateSuperato = false
  try {
    const secret = request.headers.get('x-cron-secret')
    if (!segretoCronValido(secret)) {
      // Si grida solo se l'header c'è ma non torna: su un POST anonimo si tace,
      // altrimenti un `curl` fabbrica l'allarme.
      if (secret) {
        logEvento('cron', 'error', {
          operazione: JOB,
          esito: 'secret-errato',
          msg: process.env.CRON_SECRET
            ? `${JOB}: x-cron-secret non corrispondente`
            : `${JOB}: CRON_SECRET non configurato in questo ambiente`,
        })
      }
      return NextResponse.json({ error: 'Non autorizzato', codice: 'CRON_NON_AUTORIZZATO' }, { status: 401 })
    }
    gateSuperato = true

    const corpo = bodySchema.parse(await request.json().catch(() => ({}))) ?? {}
    const dryRun = corpo.dry_run === true
    const tetto = corpo.max_inviti ?? INVITI_AL_GIORNO

    logEvento('cron', 'info', { operazione: JOB, esito: 'avviato', msg: `${JOB}: avviato` })

    const oggi = oggiFiscaleISO()
    if (!dentroLaFinestra(oggi) && corpo.forza_fuori_finestra !== true) {
      // Non è un errore: è il calendario. Battito «ok» a zero, e nessun riepilogo
      // — una casella che riceve venti email «non ho fatto niente» smette di
      // essere letta, e il giorno che serve davvero non la guarda nessuno.
      battito = true
      return NextResponse.json({ success: true, fuoriFinestra: true, oggi })
    }

    const supabase = await createAdminClient()

    // ── 0. LA RIPRESA, PRIMA DI TUTTO ─────────────────────────────────────
    // Chi aspetta da ieri viene prima di chi arriva oggi: sono i secondi
    // genitori il cui invito non è partito, e senza questo passo la loro
    // domanda — ormai `approved` — non verrebbe ripresa da nessuno.
    let ripresi = 0
    let quotaEsaurita = false
    if (!dryRun) {
      const ripresa = await riprendiInvitiSospesi(supabase, tetto)
      ripresi = ripresa.spedite
      quotaEsaurita = ripresa.rinviata
    }
    /** Le email uscite in questo giro. È ciò che il tetto misura. */
    let emailOggi = ripresi

    // Le sedi da lavorare: quelle che hanno un elenco di classe attivo. Senza
    // elenco non c'è niente da cui leggere la classe, e si tacerebbe.
    let sedi: string[] = []
    if (corpo.scuola_id) {
      sedi = [corpo.scuola_id]
    } else {
      const { data, error } = await supabase
        .from('iscrizioni_elenco_caricamenti')
        .select('scuola_id')
        .eq('attivo', true)
      if (error) {
        logEvento('cron', 'error', { operazione: JOB, esito: 'query-fallita', msg: `${JOB}: elenchi non leggibili` }, error)
        return NextResponse.json(
          { error: 'Il giro delle iscrizioni non è stato eseguito', codice: 'IMPORT_ISCRIZIONI_NON_ESEGUITO' },
          { status: 500 },
        )
      }
      sedi = [...new Set((data ?? []).map((r) => (r as { scuola_id: string }).scuola_id))]
    }

    let gia = 0
    let daControllare = 0
    let duplicate = 0
    let fallite = 0
    let restano = 0
    const bloccate: string[] = []

    /**
     * I CONTATORI PER SEDE, e non solo quelli globali.
     *
     * Il riepilogo di fine giro va alla casella della SUA sede. Mandarne uno
     * solo, alla prima sede lavorata, con dentro i numeri di tutte e tre,
     * significa che Aversa e Cesa non ricevono niente e non sanno di avere
     * domande «da controllare» ferme in attesa di una persona — mentre
     * Giugliano legge conteggi che non sono i suoi. È la trappola multi-sede che
     * questo progetto conosce già («ogni scrittura dichiara la sua sede»), qui
     * applicata a un invio.
     */
    const contatoriPerSede = new Map<string, ContatoriSede>()
    const perSede = (sede: string): ContatoriSede => {
      const c = contatoriPerSede.get(sede) ?? {
        inviate: 0, fallite: 0, daControllare: 0, duplicate: 0, restano: 0, gia: 0, emailSpedite: 0,
      }
      contatoriPerSede.set(sede, c)
      return c
    }

    for (const scuolaId of sedi) {
      if (quotaEsaurita) break
      const { righe } = await caricaElenco(supabase, scuolaId)
      if (righe.length === 0) continue

      // Il lotto: le domande prendibili, dalle più vecchie. In prova a vuoto NON
      // si prende in carico niente — un dry-run che lascia il segno non è a vuoto.
      let ids: string[] = []
      if (dryRun) {
        const { data } = await supabase
          .from('enrollment_submissions')
          .select('id')
          .eq('scuola_id', scuolaId)
          .eq('status', 'pending')
          .order('created_at', { ascending: true })
        ids = (data ?? []).map((r) => (r as { id: string }).id)
      } else {
        const { data, error } = await supabase.rpc('iscrizioni_prendi_in_carico', {
          p_scuola_id: scuolaId,
          p_max: 300,
        })
        if (error) {
          logEvento('cron', 'error', { operazione: JOB, esito: 'query-fallita', sede_id: scuolaId, msg: `${JOB}: lotto non preso` }, error)
          return NextResponse.json(
            { error: 'Il giro delle iscrizioni non è stato eseguito', codice: 'IMPORT_ISCRIZIONI_NON_ESEGUITO' },
            { status: 500 },
          )
        }
        ids = (data ?? []).map((r: unknown) => (typeof r === 'string' ? r : (r as { submission_id: string }).submission_id))
      }
      if (ids.length === 0) continue

      // Le famiglie si costruiscono su TUTTE le domande della sede, non sul solo
      // lotto: il fratello che risolve una retta può stare fuori dal lotto.
      const { data: tutteRighe } = await supabase
        .from('enrollment_submissions')
        .select('id, scuola_id, created_at, data')
        .eq('scuola_id', scuolaId)
      const tutte = (tutteRighe ?? []).map((r) => domandaDaRiga(r as never))
      const perId = new Map(tutte.map((d) => [d.id, d]))
      const grezzoPerId = new Map(
        (tutteRighe ?? []).map((r) => [(r as { id: string }).id, (r as { data: unknown }).data]),
      )
      const famiglie = costruisciFamiglie(tutte)
      const duplicati = trovaDuplicati(tutte)
      const decisioni = await caricaDecisioni(supabase, ids)

      for (const id of ids) {
        if (quotaEsaurita) break
        const domanda = perId.get(id)
        if (!domanda) continue

        const decisione = decidi(
          domanda,
          righe,
          fratelliDi(domanda, famiglie, righe),
          duplicati.get(id),
          decisioni.get(id),
        )

        if (decisione.tipo === 'duplicata') {
          duplicate++
          perSede(scuolaId).duplicate++
          if (!dryRun) {
            await supabase.rpc('iscrizioni_sospendi', {
              p_submission_id: id,
              p_stato: 'duplicata',
              p_motivo: decisione.motivo,
              p_duplicata_di: decisione.di,
            })
          }
          continue
        }

        if (decisione.tipo === 'da_controllare') {
          daControllare++
          perSede(scuolaId).daControllare++
          if (!dryRun) {
            await supabase.rpc('iscrizioni_sospendi', {
              p_submission_id: id,
              p_stato: 'da_controllare',
              p_motivo: decisione.motivo,
            })
          }
          continue
        }

        // ── IL TETTO, MISURATO PRIMA DI COMINCIARE ────────────────────────
        // Quanto costa questa domanda: le caselle distinte dei suoi adulti che
        // non hanno già ricevuto il loro invito. Si guarda PRIMA, perché a metà
        // strada non si può più tornare indietro senza lasciare una famiglia
        // spaccata in due.
        //
        // ⚠️ ANCHE IN PROVA A VUOTO si usa `invitiPrevisti`, che è una SELECT e
        // non scrive niente. Contare qui le sole caselle distinte — senza
        // togliere quelle già invitate — farebbe SOVRASTIMARE il costo dal
        // secondo giorno in poi, e quindi SOTTOSTIMARE quante domande
        // partirebbero: esattamente il numero per cui la prova a vuoto esiste.
        const previste = await invitiPrevisti(supabase, domanda.adulti.map((a) => a.email))

        // La guardia: se non è ancora uscita nessuna email si procede comunque.
        // Senza, una domanda che da sola costa più del tetto resterebbe in coda
        // per sempre — e nessuno saprebbe che è lei a non passare mai.
        //
        // `previste > 0` chiude il caso speculare: una domanda che non costa
        // NIENTE (genitori già invitati, il suo unico effetto sarebbe chiudere
        // l'anagrafica gratis) veniva rinviata a domani con scritto «sarebbero
        // servite 0 email e il tetto era già stato raggiunto» — una frase che si
        // contraddice da sola, su una domanda che non consuma quota. Nella
        // finestra di venti giorni il tetto si satura per costruzione, quindi
        // non è un caso di laboratorio.
        if (previste > 0 && emailOggi > 0 && emailOggi + previste > tetto) {
          restano++
          perSede(scuolaId).restano++
          if (!dryRun) {
            await supabase.rpc('iscrizioni_sospendi', {
              p_submission_id: id,
              p_stato: 'in_attesa',
              p_motivo: `Rinviata a domani: sarebbero servite ${previste} email e oggi il tetto di ${tetto} era già stato raggiunto.`,
            })
          }
          continue
        }

        if (dryRun) {
          inviate++
          perSede(scuolaId).inviate++
          perSede(scuolaId).emailSpedite += previste
          emailOggi += previste
          continue
        }

        const esito = await eseguiDomanda(
          supabase,
          domanda,
          (grezzoPerId.get(id) ?? {}) as never,
          decisione.assegnazioni,
          scuolaId,
        )
        emailOggi += esito.emailSpedite
        perSede(scuolaId).emailSpedite += esito.emailSpedite

        if (esito.esito === 'inviata') { inviate++; perSede(scuolaId).inviate++ }
        else if (esito.esito === 'gia_invitata') { gia++; perSede(scuolaId).gia++ }
        else if (esito.esito === 'rinviata') {
          // Quota esaurita: non è un fallimento e non consuma un tentativo. Il
          // giro finisce qui e riprende domani — un 429 non si risolve al
          // messaggio dopo, e insistere brucerebbe tutta la coda residua.
          restano++
          perSede(scuolaId).restano++
          quotaEsaurita = true
        } else {
          fallite++
          perSede(scuolaId).fallite++
          bloccate.push(id)
        }

        // Lo stesso passo del digest: ~2 al secondo. È il limite del provider.
        await new Promise((r) => setTimeout(r, 550))
      }
    }

    // Un riepilogo PER SEDE, alla casella di quella sede. Gli inviti ripresi
    // sono l'unico numero che resta globale — la ripresa attraversa le sedi per
    // costruzione (guarda il registro, non il lotto) — e per non attribuirli a
    // un plesso che non li ha fatti si contano solo nel primo riepilogo.
    if (!dryRun) {
      let ripresiDaDire = ripresi
      for (const [sede, c] of contatoriPerSede) {
        if (c.inviate === 0 && c.fallite === 0 && c.daControllare === 0 && ripresiDaDire === 0) continue
        await mandaRiepilogo(supabase, sede, { ...c, ripresi: ripresiDaDire, quotaEsaurita })
        ripresiDaDire = 0
      }
    }

    battito = true
    return NextResponse.json({
      success: true,
      dryRun,
      oggi,
      inviate,
      giaInvitate: gia,
      daControllare,
      duplicate,
      fallite,
      restanoPerDomani: restano,
      bloccate: bloccate.length,
      invitiRipresi: ripresi,
      emailSpedite: emailOggi,
      quotaEsaurita,
    })
  } catch (err) {
    logErrore({ operazione: JOB, evento: 'cron', ms: Date.now() - t0, stato: 500 }, err)
    return NextResponse.json(
      { error: 'Il giro delle iscrizioni non è stato eseguito', codice: 'IMPORT_ISCRIZIONI_NON_ESEGUITO' },
      { status: 500 },
    )
  } finally {
    // Il battito che /api/health legge. Anche quando il giro è andato storto si
    // scrive che è GIRATO: «nessun log» non deve poter significare due cose.
    //
    // ⚠️ L'ESITO CAMBIA, NON SOLO IL LIVELLO. Il lock di famiglia
    // (`__tests__/api/cron-battito.test.ts`) riconosce un giro riuscito con
    // `evento === 'cron' && campi.esito === 'ok'`, SENZA guardare il livello:
    // scrivere `esito: 'ok'` a livello `warn` su un giro esploso a metà
    // significherebbe farlo contare come riuscito da chiunque abbia copiato
    // quella query — e chiunque l'ha copiata. `/api/health` guarda l'operazione
    // e non l'esito, quindi il battito resta valido in entrambi i casi.
    if (gateSuperato) {
      logEvento('cron', battito ? 'info' : 'warn', {
        operazione: JOB,
        esito: battito ? 'ok' : 'errore',
        ms: Date.now() - t0,
        n: inviate,
        msg: battito ? `${JOB}: ok` : `${JOB}: concluso con errore`,
      })
    }
  }
})

/** I numeri di UNA sede: è la sua casella che li riceve. */
interface ContatoriSede {
  inviate: number
  fallite: number
  daControllare: number
  duplicate: number
  restano: number
  gia: number
  emailSpedite: number
}

/** Il riepilogo di fine giro, alla casella della sede. */
async function mandaRiepilogo(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  scuolaId: string | null,
  n: ContatoriSede & { ripresi: number; quotaEsaurita: boolean },
): Promise<void> {
  const sede = await risolviContestoSede(supabase, scuolaId, JOB)
  if (!sede.email) return

  const righe = [
    `Iscrizioni completate oggi: ${n.inviate}`,
    `Email di accesso spedite: ${n.emailSpedite} (una per ogni genitore con un indirizzo)`,
    `Inviti rimasti indietro e ripresi oggi: ${n.ripresi}`,
    `Già invitati in precedenza (nessuna email rimandata): ${n.gia}`,
    `Da controllare a mano: ${n.daControllare}`,
    `Doppioni chiusi: ${n.duplicate}`,
    `Rinviate a domani per il tetto giornaliero: ${n.restano}`,
    `Non riuscite (riprovano domani): ${n.fallite}`,
  ]
  const coda = n.quotaEsaurita
    ? [
        '',
        'Il giro si è fermato prima del previsto perché il fornitore delle email ha segnalato di aver raggiunto il limite giornaliero. Non è un guasto e non si è perso niente: le domande rimaste riprendono domani mattina.',
      ]
    : []
  const testo = [
    'Riepilogo dell’import automatico delle iscrizioni.',
    '',
    ...righe,
    ...coda,
    '',
    'Le domande «da controllare» si vedono in Segreteria → Iscrizioni: accanto a ognuna c’è scritto perché si è fermata.',
  ].join('\n')

  const esito = await sendEmailDetailed({
    to: sede.email,
    subject: `Iscrizioni: ${n.inviate} completate, ${n.daControllare} da controllare`,
    text: testo,
  })
  if (!esito.ok) {
    logEvento('cron', 'error', { operazione: JOB, esito: 'riepilogo-non-inviato' }, new Error(esito.error ?? ''))
  }
}
