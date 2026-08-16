/**
 * Il giro: dalle domande ferme in coda alla decisione su ciascuna.
 *
 * ─── COSA FA, E COSA NON FA ─────────────────────────────────────────────────
 * Questo modulo legge — l'elenco di classe della sede, le domande in attesa, le
 * famiglie — e per ogni domanda chiama `decidi()`. Non scrive niente e non manda
 * niente: è ciò che permette alla PROVA A VUOTO di dire davvero «ecco cosa avrei
 * fatto», con i numeri veri, senza toccare un dato.
 *
 * ─── LE FAMIGLIE SI RICONOSCONO DAL GENITORE, NON DAL COGNOME ───────────────
 * Serve a una cosa sola ma decisiva: risolvere i «vedi fratello». Misurato il
 * 2026-08-16 sulle 198 domande di Giugliano, raggruppando per codice fiscale
 * dell'adulto si formano 37 famiglie, e il legame regge dove il cognome
 * fallirebbe:
 *   · `DE CURTIS SARA` e `DE CURTIS SOFIA` stanno in DUE domande separate;
 *   · una famiglia ha un figlio `MAZZEI` e uno `TESONE` sotto lo stesso genitore.
 * Un raggruppamento per cognome avrebbe sbagliato in entrambi i casi — e nel
 * secondo avrebbe attribuito a un bambino la retta di un estraneo.
 *
 * ─── PERCHÉ SI GUARDANO TUTTE LE DOMANDE, NON SOLO QUELLE DEL LOTTO ─────────
 * Il fratello che risolve la retta può stare in una domanda che oggi non è nel
 * lotto, o che è già stata lavorata ieri. Le famiglie si costruiscono su TUTTE
 * le domande della sede: costa una lettura in più e chiude un intero genere di
 * «da controllare» che sarebbero solo apparenti.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { abbina, type RigaElenco } from './abbinamento'
import { normalizzaNome } from './normalizza'
import {
  decidi,
  preferibile,
  type AdultoDomanda,
  type DecisioniDellaDomanda,
  type BambinoDomanda,
  type Decisione,
  type Domanda,
} from './analisi'

export interface EsitoDomanda {
  submissionId: string
  scuolaId: string | null
  creataIl: string
  decisione: Decisione
}

export interface RapportoLotto {
  scuolaId: string | null
  elencoCaricatoIl: string | null
  righeElenco: number
  domandeEsaminate: number
  daInviare: number
  daControllare: number
  duplicate: number
  /** Chi sarebbe partito, in ordine di arrivo (le più vecchie per prime). */
  esiti: EsitoDomanda[]
}

/**
 * IL TETTO GIORNALIERO, IN EMAIL — non in domande.
 *
 * Novanta è il numero che il titolare ha fissato il 2026-08-16 sulla risorsa
 * scarsa, cioè la quota del provider (100 al giorno; il riepilogo di fine giro è
 * la novantunesima e ci sta dentro).
 *
 * Non è un tetto sulle DOMANDE, e la differenza è tutta pratica: dal 2026-08-16
 * ogni genitore con un'email ha il suo account, e 100 domande su 390 ne portano
 * due. Contare le domande vorrebbe dire non sapere quante email escono — «48
 * domande» sarebbe un consumo qualsiasi fra 48 e 96.
 *
 * Resa misurata sul vero: 479 account su 390 domande = 1,23 email a domanda;
 * 437 bambini su 390 domande = 1,12. Novanta email valgono quindi circa 73
 * famiglie e 82 bambini al giorno: Giugliano da sola (196 domande, 241 account)
 * si esaurisce in tre giri, tutte e tre le sedi in sei. La finestra è di venti
 * giorni.
 */
export const INVITI_AL_GIORNO = 90

interface RigaSubmission {
  id: string
  scuola_id: string | null
  created_at: string
  data: unknown
}

function testo(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Estrae la domanda dal jsonb del form, senza dare per scontato niente. */
export function domandaDaRiga(r: RigaSubmission): Domanda {
  const d = (r.data ?? {}) as { children?: unknown; adults?: unknown }
  const bambini: BambinoDomanda[] = Array.isArray(d.children)
    ? d.children.map((c) => {
        const o = (c ?? {}) as Record<string, unknown>
        return {
          nome: testo(o.nome),
          cognome: testo(o.cognome),
          codiceFiscale: testo(o.codice_fiscale).toUpperCase() || null,
          dataNascita: testo(o.data_nascita) || null,
        }
      })
    : []
  const adulti: AdultoDomanda[] = Array.isArray(d.adults)
    ? d.adults.map((a) => {
        const o = (a ?? {}) as Record<string, unknown>
        return {
          nome: testo(o.first_name),
          cognome: testo(o.last_name),
          email: testo(o.email).toLowerCase() || null,
          codiceFiscale: testo(o.fiscal_code).toUpperCase() || null,
          ruolo: testo(o.ruolo) || null,
        }
      })
    : []
  return { id: r.id, scuolaId: r.scuola_id, creataIl: r.created_at, bambini, adulti }
}

/**
 * Le famiglie: dal codice fiscale di un adulto all'insieme dei suoi figli,
 * presi da tutte le domande della sede.
 */
export function costruisciFamiglie(domande: Domanda[]): Map<string, BambinoDomanda[]> {
  const perAdulto = new Map<string, BambinoDomanda[]>()
  for (const d of domande) {
    for (const a of d.adulti) {
      const cf = a.codiceFiscale
      if (!cf || cf.length !== 16) continue
      const l = perAdulto.get(cf) ?? []
      for (const b of d.bambini) l.push(b)
      perAdulto.set(cf, l)
    }
  }
  return perAdulto
}

/**
 * Dato un bambino, le righe dell'elenco dei suoi FRATELLI (lui escluso).
 * Sono le righe su cui `risolviRetta` cerca l'unica cifra di famiglia.
 */
export function fratelliDi(
  domanda: Domanda,
  famiglie: Map<string, BambinoDomanda[]>,
  elenco: readonly RigaElenco[],
): (b: BambinoDomanda) => RigaElenco[] {
  return (b) => {
    const suo = normalizzaNome(`${b.cognome} ${b.nome}`)
    const insieme = new Map<string, BambinoDomanda>()

    // fratelli della stessa domanda
    for (const altro of domanda.bambini) {
      const k = normalizzaNome(`${altro.cognome} ${altro.nome}`)
      if (k && k !== suo) insieme.set(k, altro)
    }
    // fratelli in altre domande, riconosciuti dal genitore
    for (const a of domanda.adulti) {
      if (!a.codiceFiscale) continue
      for (const altro of famiglie.get(a.codiceFiscale) ?? []) {
        const k = normalizzaNome(`${altro.cognome} ${altro.nome}`)
        if (k && k !== suo) insieme.set(k, altro)
      }
    }

    // I fratelli si cercano nell'elenco con LO STESSO metro del bambino, cioè
    // `abbina` — non con un confronto più stretto.
    //
    // Misurato il 2026-08-16 durante la prova a vuoto: qui c'era `normalizzaNome(r.nome) === k`,
    // e `DE SIO GIUNTO IDA` risultava «rimando cieco» pur avendo il fratello
    // THIAGO nell'elenco, perché la segreteria l'ha scritto `DESIO GIUNTO` tutto
    // attaccato. Due metri diversi sullo stesso confronto producono un «da
    // controllare» che non ha nessuna ragione di esistere — e che la segreteria
    // avrebbe dovuto risolvere a mano per niente.
    const righe: RigaElenco[] = []
    for (const b2 of insieme.values()) {
      const e = abbina(b2.nome, b2.cognome, elenco)
      if (e.tipo === 'unico') righe.push(e.riga)
    }
    return righe
  }
}

/**
 * I doppioni: lo stesso bambino (stesso codice fiscale) in due domande diverse.
 * Restituisce, per ogni domanda perdente, quale domanda vale al suo posto.
 */
export function trovaDuplicati(domande: Domanda[]): Map<string, { id: string; motivo: string }> {
  const perCf = new Map<string, Domanda[]>()
  for (const d of domande) {
    for (const b of d.bambini) {
      if (!b.codiceFiscale || b.codiceFiscale.length !== 16) continue
      const l = perCf.get(b.codiceFiscale) ?? []
      if (!l.some((x) => x.id === d.id)) l.push(d)
      perCf.set(b.codiceFiscale, l)
    }
  }

  const perdenti = new Map<string, { id: string; motivo: string }>()
  for (const [, gruppo] of perCf) {
    if (gruppo.length < 2) continue
    let vincitrice = gruppo[0]
    for (const d of gruppo.slice(1)) if (preferibile(d, vincitrice)) vincitrice = d
    for (const d of gruppo) {
      if (d.id === vincitrice.id) continue
      perdenti.set(d.id, {
        id: vincitrice.id,
        motivo: `Lo stesso bambino risulta iscritto in più di una domanda (stesso codice fiscale). Vale quella del ${vincitrice.creataIl.slice(0, 10)}, che è la più completa fra quelle arrivate; questa resta come doppione.`,
      })
    }
  }
  return perdenti
}

/** Le righe dell'elenco attivo di una sede. */
export async function caricaElenco(
  supabase: SupabaseClient,
  scuolaId: string,
): Promise<{ righe: RigaElenco[]; caricatoIl: string | null }> {
  const { data: caricamento, error: e1 } = await supabase
    .from('iscrizioni_elenco_caricamenti')
    .select('id, caricato_il')
    .eq('scuola_id', scuolaId)
    .eq('attivo', true)
    .maybeSingle()
  // PostgREST non lancia: si controlla il valore di ritorno, sempre.
  if (e1) throw new Error(`elenco non leggibile: ${e1.message}`)
  if (!caricamento) return { righe: [], caricatoIl: null }

  const { data, error } = await supabase
    .from('iscrizioni_elenco_righe')
    .select('id, classe, nome, riga_excel, retta, retta_testo')
    .eq('caricamento_id', (caricamento as { id: string }).id)
  if (error) throw new Error(`righe dell'elenco non leggibili: ${error.message}`)

  const righe = (data ?? []).map((r) => {
    const o = r as { id: string; classe: string; nome: string; riga_excel: number; retta: string | number | null; retta_testo: string | null }
    return {
      id: o.id,
      classe: o.classe,
      nome: o.nome,
      riga: o.riga_excel,
      retta: o.retta === null ? null : Number(o.retta),
      rettaTesto: o.retta_testo,
    }
  })
  return { righe, caricatoIl: (caricamento as { caricato_il: string }).caricato_il }
}

/**
 * Le decisioni già prese da una persona, per domanda.
 *
 * Si leggono a ogni giro e non si «consumano»: una decisione è una risposta che
 * resta valida finché qualcuno non la cambia, non un gettone che si spende.
 */
export async function caricaDecisioni(
  supabase: SupabaseClient,
  submissionIds: string[],
): Promise<Map<string, DecisioniDellaDomanda>> {
  const per = new Map<string, DecisioniDellaDomanda>()
  if (submissionIds.length === 0) return per

  const { data, error } = await supabase
    .from('iscrizioni_decisioni')
    .select('submission_id, bambino_norm, classe, retta, a_carico_di, nota')
    .in('submission_id', submissionIds)
  // PostgREST non lancia. Su un ambiente che non conosce ancora la tabella
  // (`PGRST205`/`42P01`, il DB di collaudo della CI) si degrada in silenzio: non
  // avere decisioni significa solo che nessun caso è stato risolto a mano.
  if (error) {
    const codice = (error as { code?: string }).code
    if (codice === 'PGRST205' || codice === '42P01') return per
    throw new Error(`decisioni non leggibili: ${error.message}`)
  }

  for (const r of data ?? []) {
    const o = r as {
      submission_id: string
      bambino_norm: string
      classe: string | null
      retta: string | number | null
      a_carico_di: string | null
      nota: string | null
    }
    const dellaDomanda = per.get(o.submission_id) ?? new Map()
    dellaDomanda.set(normalizzaNome(o.bambino_norm), {
      classe: o.classe,
      retta: o.retta === null ? null : Number(o.retta),
      aCaricoDi: o.a_carico_di,
      nota: o.nota,
    })
    per.set(o.submission_id, dellaDomanda)
  }
  return per
}

/**
 * La PROVA A VUOTO: decide su ogni domanda in attesa e riporta cosa avrebbe
 * fatto. Nessuna scrittura, nessun invio, nessun claim — si può eseguire tutte
 * le volte che si vuole senza conseguenze.
 */
export async function analizzaLotto(
  supabase: SupabaseClient,
  scuolaId: string,
  max = INVITI_AL_GIORNO,
): Promise<RapportoLotto> {
  const { righe, caricatoIl } = await caricaElenco(supabase, scuolaId)

  const { data, error } = await supabase
    .from('enrollment_submissions')
    .select('id, scuola_id, created_at, data')
    .eq('scuola_id', scuolaId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
  if (error) throw new Error(`domande non leggibili: ${error.message}`)

  const tutte = (data ?? []).map((r) => domandaDaRiga(r as unknown as RigaSubmission))
  const famiglie = costruisciFamiglie(tutte)
  const duplicati = trovaDuplicati(tutte)
  const decisioni = await caricaDecisioni(supabase, tutte.map((d) => d.id))

  const esiti: EsitoDomanda[] = []
  let daInviare = 0
  let daControllare = 0
  let duplicate = 0

  for (const d of tutte) {
    // Il tetto vale sugli INVII, non sull'esame: fermarsi a 90 domande
    // esaminate lascerebbe invisibile tutto ciò che sta oltre, e la segreteria
    // non saprebbe mai quante correzioni ha davanti.
    const decisione = decidi(
      d,
      righe,
      fratelliDi(d, famiglie, righe),
      duplicati.get(d.id),
      decisioni.get(d.id),
    )
    if (decisione.tipo === 'invia') daInviare++
    else if (decisione.tipo === 'duplicata') duplicate++
    else daControllare++
    esiti.push({ submissionId: d.id, scuolaId: d.scuolaId, creataIl: d.creataIl, decisione })
  }

  return {
    scuolaId,
    elencoCaricatoIl: caricatoIl,
    righeElenco: righe.length,
    domandeEsaminate: tutte.length,
    daInviare: Math.min(daInviare, Number.MAX_SAFE_INTEGER),
    daControllare,
    duplicate,
    esiti: esiti.slice(0, Math.max(max, 0) || esiti.length),
  }
}
