import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { withRoute } from '@/lib/logging/with-route'
import { logEvento } from '@/lib/logging/logger'
import { inviaCopiaAllaSede } from '@/lib/candidature/copia-alla-sede'
import { INSEGNANTE_FIELDS, CONSENSI_INSEGNANTI_FIELDS } from '@/lib/forms/insegnanti-template'
import { formattaIstante } from '@/i18n/config'

// =============================================================================
// L'INOLTRO DELL'ARRETRATO ALLE CASELLE DEI PLESSI.
//
// ─── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
// La copia automatica al plesso è nata il 2026-08-20 (PR #91). Le candidature
// arrivate PRIMA non l'hanno mai ricevuta, e due di quelle arrivate dopo l'hanno
// persa per il difetto del destinatario multiplo (PR #94). Questa rotta manda
// all'indietro ciò che non è mai partito — la STESSA email, costruita dallo
// stesso codice, perché una copia «di recupero» scritta a parte diverge dalla
// copia vera al primo cambio di template.
//
// ─── PERCHÉ RESTA, INVECE DI ESSERE UNO SCRIPT USA-E-GETTA ───────────────────
// Nasce per un arretrato, ma la sua ragione non scade con quello: ogni volta che
// una copia al plesso fallisce — il provider dice «non oggi», una sede non ha
// l'email in anagrafica, un difetto come quello del 20 agosto — resta una
// candidatura che la segreteria non ha mai visto arrivare in posta. Senza questa
// rotta l'unico rimedio sarebbe riscriverla da capo ogni volta.
//
// `copia_inviata_il` rende la domanda «chi non l'ha ancora ricevuta?» una query,
// e questa rotta è la risposta.
//
// ─── L'IDEMPOTENZA È NEL DATABASE, NON NELLA BUONA VOLONTÀ ───────────────────
// `copia_inviata_il` viene scritta SOLO dopo un esito positivo vero del provider.
// Due chiamate di fila non raddoppiano le email: la seconda non trova più niente
// da mandare. Senza quella colonna, un secondo clic significherebbe un centinaio
// di email alle sedi.
//
// ─── IL TETTO DEL PROVIDER SI RISPETTA, NON SI SCOPRE ────────────────────────
// Resend sta intorno alle 100 email al giorno ed è già conteso con
// `INVITI_AL_GIORNO = 90` del cron delle iscrizioni. Perciò: un tetto per
// chiamata (`max`), e soprattutto **un 429 ferma il giro**. Continuare dopo un
// «non oggi» vorrebbe dire bruciare decine di tentativi che falliscono tutti, e
// — peggio — segnare come inviate righe che non sono partite.
// =============================================================================

const OPERAZIONE = 'candidature/inoltro-arretrato:POST'

/**
 * Il tetto per chiamata, quando il corpo non lo dice.
 *
 * Basso di proposito: chi lancia questa rotta la lancia più volte guardando il
 * resoconto, invece di scoprire a cose fatte di aver esaurito la quota di un
 * cron che spedisce le credenziali alle famiglie.
 */
const MAX_DEFAULT = 25

/** Il tetto assoluto: nemmeno chiedendolo si manda più di così in un colpo. */
const MAX_ASSOLUTO = 60

const Corpo = z
  .object({
    max: z.number().int().positive().max(MAX_ASSOLUTO).optional(),
    /** `true` = conta e basta, non spedisce niente e non scrive niente. */
    prova: z.boolean().optional(),
  })
  .strict()

/**
 * Il momento in cui il caricamento del curriculum è comparso nel modulo
 * pubblico: PR #85 in produzione, `b43a556e`, 2026-08-15T00:48:42Z.
 *
 * Serve a distinguere due frasi che alla sede suonano uguali e non lo sono:
 * «non ne ha caricato uno» (una scelta di chi si è candidato) e «non poteva
 * caricarlo» (il modulo non lo chiedeva ancora). Dire la prima quando è vera la
 * seconda accusa una persona di una negligenza che non ha commesso.
 *
 * Misurato sui dati veri il 2026-08-20: **una** candidatura su 51 sta di qua dal
 * confine. Una sola persona — ed è comunque quella che riceverebbe l'accusa.
 */
const CV_CARICABILE_DA = Date.parse('2026-08-15T00:48:42Z')

/** Le colonne del modulo: gli `id` dei campi SONO i nomi delle colonne. */
const COLONNE_MODULO = INSEGNANTE_FIELDS.map((f) => f.id).join(', ')

interface RigaConsenso {
  field_id?: unknown
  accepted?: unknown
}

/**
 * I consensi come li vuole la copia: una chiave per OGNI consenso del template,
 * anche per quelli non spuntati.
 *
 * ⚠️ Si parte dal TEMPLATE e non da ciò che sta in `consents_log`: un consenso
 * assente dallo snapshot deve viaggiare come `false` esplicito, così la sede
 * legge «No» invece di non leggere niente. «Non gliel'ho chiesto» e «ha detto
 * no» non sono la stessa cosa, e in una casella di posta la differenza fra le
 * due è invisibile se una delle due semplicemente non compare.
 */
function consensiDaLog(consentsLog: unknown): Record<string, boolean> {
  const blocchi = (consentsLog as { blocchi?: unknown } | null)?.blocchi
  const presi = new Map<string, boolean>()
  if (Array.isArray(blocchi)) {
    for (const b of blocchi as RigaConsenso[]) {
      if (typeof b?.field_id === 'string') presi.set(b.field_id, b.accepted === true)
    }
  }
  return Object.fromEntries(CONSENSI_INSEGNANTI_FIELDS.map((c) => [c.id, presi.get(c.id) === true]))
}

export const POST = withRoute('admin/candidature-insegnanti/inoltro-arretrato:POST', async (request: NextRequest) => {
  // ── IL GATE ─────────────────────────────────────────────────────────────
  //
  // ⚠️ QUI PRIMA C'ERA UN TOKEN IN UNA VARIABILE D'AMBIENTE, e l'ho tolto perché
  // i lock di architettura avevano ragione. Per farlo passare avrei dovuto
  // iscrivere questa rotta fra le PUBBLICHE — dove il lock
  // «il TETTO dell'allowlist può solo SCENDERE» monta una cricca deliberata
  // contro le porte senza identità. Non era un ostacolo da aggirare: era la
  // diagnosi giusta. Questa non è una rotta pubblica, è una rotta
  // d'amministrazione, e un segreto in una variabile non è un'identità — non
  // dice CHI ha premuto, e su un'azione che spedisce decine di email con dati
  // personali a caselle vere «chi» è la sola cosa che conterà quando qualcuno lo
  // chiederà.
  //
  // Solo `admin` e `coordinator`: la stessa coppia che decide su una candidatura
  // in `candidature-insegnanti:PATCH`. Chi non può approvare non può nemmeno
  // spedire l'intero arretrato ai plessi.
  const auth = await requireStaff(request, ['admin', 'coordinator'])
  if (auth.response) return auth.response

  const b = Corpo.safeParse(await request.json().catch(() => ({})))
  if (!b.success) {
    return NextResponse.json({ error: 'Richiesta non valida.', codice: 'CORPO_NON_VALIDO' }, { status: 400 })
  }
  const max = b.data.max ?? MAX_DEFAULT
  const prova = b.data.prova === true

  const supabase = await createAdminClient()

  // ── CHI DEVE ANCORA RICEVERE LA SUA COPIA ───────────────────────────────
  const { data: righe, error: errLettura } = await supabase
    .from('candidature_insegnanti')
    .select(`id, creata_il, cv_path, consents_log, ${COLONNE_MODULO}, candidature_sedi(scuola_id)`)
    .is('copia_inviata_il', null)
    .order('creata_il', { ascending: true })
    .limit(max)

  // PostgREST non lancia: ritorna `{ error }`. Un `try/catch` qui non scatterebbe.
  if (errLettura !== null) {
    logEvento('candidatura', 'error', { operazione: OPERAZIONE, esito: 'lettura-fallita' }, errLettura)
    return NextResponse.json({ error: 'Lettura non riuscita.', codice: 'LETTURA_FALLITA' }, { status: 500 })
  }
  const daFare = (righe ?? []) as unknown as Record<string, unknown>[]

  // I nomi dei plessi, una volta sola: la copia li nomina in chiaro perché la
  // legge una persona, e un uuid in una casella di posta non dice niente.
  const { data: sedi } = await supabase.from('scuole').select('id, nome')
  const nomeDi = new Map(((sedi ?? []) as { id: string; nome: string }[]).map((s) => [s.id, s.nome]))

  if (prova) {
    return NextResponse.json({
      prova: true,
      da_inviare: daFare.length,
      senza_curriculum: daFare.filter((r) => !r.cv_path).length,
      multi_sede: daFare.filter((r) => ((r.candidature_sedi as unknown[]) ?? []).length > 1).length,
    })
  }

  let inviate = 0
  let fallite = 0
  let senzaSede = 0
  let fermato: string | null = null

  for (const r of daFare) {
    const scuoleIds: string[] = ((r.candidature_sedi as { scuola_id: string }[] | null) ?? []).map((x) => x.scuola_id)
    if (scuoleIds.length === 0) {
      // Una candidatura senza righe di sede non ha un destinatario: mandarla
      // «da qualche parte» sarebbe peggio che non mandarla. Si conta e si dice.
      senzaSede++
      logEvento('candidatura', 'error', {
        operazione: OPERAZIONE,
        esito: 'arretrata-senza-riga-di-sede',
        entita_id: r.id as string,
        msg: 'candidatura senza nessuna riga in candidature_sedi: non ha un plesso a cui essere inoltrata',
      })
      continue
    }

    const dati: Record<string, unknown> = {}
    for (const f of INSEGNANTE_FIELDS) dati[f.id] = r[f.id]

    const creata = typeof r.creata_il === 'string' ? Date.parse(r.creata_il) : Number.NaN
    const curriculumNonPrevisto =
      !r.cv_path && Number.isFinite(creata) && creata < CV_CARICABILE_DA

    const esito = await inviaCopiaAllaSede(supabase, {
      scuoleIds,
      dati,
      consensi: consensiDaLog(r.consents_log),
      sediScelte: scuoleIds.map((id) => nomeDi.get(id) ?? id),
      inviataIl: formattaIstante(new Date(String(r.creata_il)), 'it', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
      }),
      entitaId: r.id as string,
      cvPath: (r.cv_path as string | null) ?? null,
      curriculumNonPrevisto,
    })

    if (esito.ok) {
      const { error: errSegno } = await supabase
        .from('candidature_insegnanti')
        .update({ copia_inviata_il: new Date().toISOString() })
        .eq('id', r.id as string)
      if (errSegno !== null) {
        // L'email È partita. Non poterlo scrivere significa che al prossimo giro
        // parte di nuovo: un doppione, non una perdita. Ma va detto forte, perché
        // se succede su tutte le righe l'inoltro non finisce mai.
        logEvento('candidatura', 'error', {
          operazione: OPERAZIONE,
          esito: 'copia-inviata-ma-non-segnata',
          entita_id: r.id as string,
          msg: 'la copia è partita ma copia_inviata_il non è stata scritta: al prossimo giro ripartirà, come doppione',
        }, errSegno)
      }
      inviate++
      continue
    }

    if (esito.rinviabile) {
      // «Non oggi» non è «non si può». Si ferma il giro: insistere brucerebbe
      // tentativi che falliscono tutti, e il resto dell'arretrato è ancora lì
      // domani. La riga NON viene segnata: non è partita.
      fermato = 'quota-del-provider-esaurita'
      logEvento('candidatura', 'warn', {
        operazione: OPERAZIONE,
        esito: 'inoltro-interrotto-per-quota',
        n_inviate: inviate,
        msg: 'il provider ha risposto 429: l’inoltro si ferma qui e riprende alla prossima chiamata',
      })
      break
    }

    fallite++
    logEvento('candidatura', 'error', {
      operazione: OPERAZIONE,
      esito: 'copia-arretrata-non-inviata',
      entita_id: r.id as string,
    }, new Error('la copia alla sede non è partita'))
  }

  logEvento('candidatura', 'info', {
    operazione: OPERAZIONE,
    esito: 'inoltro-arretrato-concluso',
    n_inviate: inviate,
    n_fallite: fallite,
    n_senza_sede: senzaSede,
  })

  return NextResponse.json({
    inviate,
    fallite,
    senza_riga_di_sede: senzaSede,
    esaminate: daFare.length,
    fermato,
  })
})
