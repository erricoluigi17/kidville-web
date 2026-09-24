import { z } from 'zod'
import { zUuid } from '@/lib/validation/common'
import { quandoRelativo } from '@/lib/i18n/quando-relativo'
import type { CODICI_ESITO_CODA } from '@/lib/fatture-coda/giro'

/**
 * ─── GLI AVVISI DELLA CODA FATTURE: COSA DICONO E A CHI (consegna 2c) ──────────────
 *
 * Puro, senza I/O. Riceve i fatti che `fatture_coda_avvisi_prendi` ha appena segnato come
 * avvisati e compone le notifiche (spec: consegna-2c-notifiche.md §3). MAI UN NOME
 * (decisione 21): ogni testo nasce da conteggi, dalla categoria di un codice d'esito e da
 * orari Europe/Rome; nessuna stringa del database entra in una frase. Il messaggio d'esito
 * della voce, che può nominare un intestatario, qui non arriva: la RPC non lo restituisce.
 * In italiano, come tutte le notifiche salvate (`src/lib/notifiche/tipi.ts:7-11`).
 */

type CodiceEsitoCoda = (typeof CODICI_ESITO_CODA)[number]

/** Dove porta ogni avviso. È `CODA_FATTURE_HREF` (`admin-nav-config.ts`): un test li lega. */
export const LINK_CODA_FATTURE = '/admin/coda-fatture'

/**
 * I valori di `notifiche.tipo`. FUORI da `TIPI_NOTIFICA`, di proposito: il catalogo non sa dire
 * «obbligatoria» (ogni sua voce è un interruttore del pannello), e questi avvisi si accodano
 * senza sede, quindi nessun interruttore li spegnerebbe davvero.
 */
export const TIPI_AVVISO_CODA = [
  'fattura_coda_fine',
  'fattura_coda_errori',
  'fattura_coda_da_verificare',
  'fattura_coda_pausa',
  'fattura_coda_sospesa',
  'fattura_coda_ripresa',
] as const
export type TipoAvvisoCoda = (typeof TIPI_AVVISO_CODA)[number]

/** «Da verificare» nel nucleo: non si sa se la fattura è arrivata ad Aruba (`giro.ts`, `classificaEsito` e bidello). */
export const CODICI_DA_VERIFICARE = ['esito_incerto', 'trasporto_da_verificare'] as const satisfies readonly CodiceEsitoCoda[]
/** L'anomalia del nucleo: partita su Aruba e assente dal registro (il 409 di R1). */
export const CODICI_ANOMALIA = ['partita_non_registrata'] as const satisfies readonly CodiceEsitoCoda[]

export type Categoria = 'da_correggere' | 'da_verificare' | 'anomalia'

export function categoria(codice: string): Categoria {
  if ((CODICI_DA_VERIFICARE as readonly string[]).includes(codice)) return 'da_verificare'
  if ((CODICI_ANOMALIA as readonly string[]).includes(codice)) return 'anomalia'
  return 'da_correggere'
}

const zConteggio = z.number().int().min(0)

/** La risposta di `fatture_coda_avvisi_prendi`: solo uuid, codici, conteggi e istanti. */
export const zFattiCoda = z.object({
  errori: z.array(z.object({ gruppo_id: zUuid, creato_da: zUuid, codice: z.string().min(1).max(100) })),
  fini: z.array(
    z.object({
      gruppo_id: zUuid,
      creato_da: zUuid,
      accodata_il: z.string(),
      voci: zConteggio,
      emesse: zConteggio,
      tolte: zConteggio,
      errori: z.record(z.string(), zConteggio),
    }),
  ),
  pausa: z.object({ fino_a: z.string() }).nullable(),
  sospensione: z
    .object({ evento: z.enum(['sospesa', 'ripresa']), il: z.string().nullable(), da: zUuid.nullable() })
    .nullable(),
  in_attesa: z.array(zUuid),
})
export type FattiCoda = z.infer<typeof zFattiCoda>
type GruppoFinito = FattiCoda['fini'][number]

export interface AvvisoCoda {
  tipo: TipoAvvisoCoda
  destinatari: string[]
  titolo: string
  corpo: string
  entitaTipo: 'fattura_coda_gruppo' | null
  entitaId: string | null
}

export interface ContestoAvvisi {
  adesso: Date
  /**
   * Gli admin delle sedi reali. Ricevono i «da verificare» e le anomalie delle voci altrui, la
   * pausa, la sospensione e la ripresa (decisioni 12 e 21). Vuoto se non si sono potuti leggere.
   */
  admin: readonly string[]
  /** Chi ha appena sospeso o ripreso dalla route: non riceve l'avviso del proprio gesto. */
  attore?: string | null
}

interface Conteggi {
  daCorreggere: number
  daVerificare: number
  anomalie: number
}

const zero = (): Conteggi => ({ daCorreggere: 0, daVerificare: 0, anomalie: 0 })

function aggiungi(c: Conteggi, codice: string, n = 1): void {
  const k = categoria(codice)
  if (k === 'da_verificare') c.daVerificare += n
  else if (k === 'anomalia') c.anomalie += n
  else c.daCorreggere += n
}

/**
 * «alle 14:30», «domani alle 00:03», «ven 25/09 alle 08:00» (Europe/Rome); con `'dopo le'`
 * «dopo le 11:09», «domani dopo le 00:30». Istante illeggibile → `null`.
 */
export function quando(
  istante: string | null | undefined,
  adesso: Date,
  prima: 'alle' | 'dopo le' = 'alle',
): string | null {
  const q = quandoRelativo(istante, adesso, 'it')
  if (!q) return null
  if (q.giorno === 'oggi') return `${prima} ${q.ora}`
  if (q.giorno === 'domani') return `domani ${prima} ${q.ora}`
  return `${q.data} ${prima} ${q.ora}`
}

/** Le frasi degli errori: col sostantivo («1 fattura») o senza («1», dentro il riepilogo di un gruppo). */
function frasiErrori(c: Conteggi, conNome: boolean): string[] {
  const chi = (n: number) => (conNome ? `${n} ${n === 1 ? 'fattura' : 'fatture'}` : `${n}`)
  const frasi: string[] = []
  if (c.daCorreggere > 0) {
    const n = c.daCorreggere
    frasi.push(
      n === 1
        ? `${chi(n)} non è partita: apri la coda per vedere il motivo, correggi e premi «Rimetti in coda».`
        : `${chi(n)} non sono partite: apri la coda per vedere i motivi, correggi e premi «Rimetti in coda».`,
    )
  }
  if (c.daVerificare > 0) {
    const n = c.daVerificare
    frasi.push(
      n === 1
        ? `Di ${chi(n)} non si sa se è arrivata ad Aruba: controlla sul pannello Aruba prima di rimetterla in coda.`
        : `Di ${chi(n)} non si sa se sono arrivate ad Aruba: controlla sul pannello Aruba prima di rimetterle in coda.`,
    )
  }
  if (c.anomalie > 0) {
    const n = c.anomalie
    frasi.push(
      n === 1
        ? `${chi(n)} risulta partita ma non è a registro: va verificata prima di riprovare.`
        : `${chi(n)} risultano partite ma non sono a registro: vanno verificate prima di riprovare.`,
    )
  }
  return frasi
}

function avvisoFine(g: GruppoFinito, adesso: Date): AvvisoCoda {
  const c = zero()
  for (const [codice, n] of Object.entries(g.errori)) aggiungi(c, codice, n)
  const errori = c.daCorreggere + c.daVerificare + c.anomalie
  const w = quando(g.accodata_il, adesso) ?? 'di recente'
  let titolo: string
  let corpo: string
  if (g.voci === 1 && g.emesse === 1) {
    titolo = 'Fattura inviata'
    corpo = `La fattura messa in coda ${w} è stata inviata.`
  } else if (g.voci === 1 && errori === 1 && c.daCorreggere === 1) {
    titolo = 'Fattura non inviata'
    corpo = `La fattura messa in coda ${w} non è partita: apri la coda per vedere il motivo, correggi e premi «Rimetti in coda».`
  } else if (g.voci === 1 && errori === 1 && c.daVerificare === 1) {
    titolo = 'Fattura da verificare'
    corpo = `Della fattura messa in coda ${w} non si sa se è arrivata ad Aruba: controlla sul pannello Aruba prima di rimetterla in coda.`
  } else if (g.voci === 1 && errori === 1) {
    titolo = 'Fattura da verificare'
    corpo = `La fattura messa in coda ${w} risulta partita ma non è a registro: va verificata prima di riprovare.`
  } else {
    titolo = 'Fatture in coda: finito'
    corpo = [
      `Il gruppo messo in coda ${w}: ${g.emesse} ${g.emesse === 1 ? 'inviata' : 'inviate'} su ${g.voci}.`,
      ...frasiErrori(c, false),
      ...(g.tolte > 0 ? [g.tolte === 1 ? '1 tolta dalla coda.' : `${g.tolte} tolte dalla coda.`] : []),
    ].join(' ')
  }
  return { tipo: 'fattura_coda_fine', destinatari: [g.creato_da], titolo, corpo, entitaTipo: 'fattura_coda_gruppo', entitaId: g.gruppo_id }
}

function avvisoErrori(utente: string, c: Conteggi): AvvisoCoda {
  const n = c.daCorreggere + c.daVerificare + c.anomalie
  const titolo =
    c.daCorreggere === 0
      ? n === 1 ? 'Fattura da verificare' : `${n} fatture da verificare`
      : n === 1 ? 'Fattura non inviata' : `${n} fatture non inviate`
  const corpo = [...frasiErrori(c, true), 'Le altre fatture in coda continuano da sole.'].join(' ')
  return { tipo: 'fattura_coda_errori', destinatari: [utente], titolo, corpo, entitaTipo: null, entitaId: null }
}

function avvisoAdmin(admin: string, c: Conteggi): AvvisoCoda {
  const n = c.daVerificare + c.anomalie
  return {
    tipo: 'fattura_coda_da_verificare',
    destinatari: [admin],
    titolo: n === 1 ? 'Fattura da verificare' : `${n} fatture da verificare`,
    corpo: frasiErrori({ daCorreggere: 0, daVerificare: c.daVerificare, anomalie: c.anomalie }, true).join(' '),
    entitaTipo: null,
    entitaId: null,
  }
}

/** Gli avvisi di una chiamata. Un avviso senza destinatari non esce. */
export function componiAvvisi(fatti: FattiCoda, ctx: ContestoAvvisi): AvvisoCoda[] {
  const avvisi: AvvisoCoda[] = []
  const finiti = new Set(fatti.fini.map((g) => g.gruppo_id))

  for (const g of fatti.fini) avvisi.push(avvisoFine(g, ctx.adesso))

  // Gli errori di un gruppo finito in questa chiamata stanno già nel suo avviso di fine.
  const perAccodante = new Map<string, Conteggi>()
  for (const e of fatti.errori) {
    if (finiti.has(e.gruppo_id)) continue
    const c = perAccodante.get(e.creato_da) ?? zero()
    aggiungi(c, e.codice)
    perAccodante.set(e.creato_da, c)
  }
  for (const [utente, c] of perAccodante) avvisi.push(avvisoErrori(utente, c))

  // Agli admin ogni «da verificare» e ogni anomalia, UNA volta: le voci che hanno accodato
  // loro le hanno già nel proprio avviso.
  const admin = [...new Set(ctx.admin)]
  for (const a of admin) {
    const c = zero()
    for (const e of fatti.errori) {
      if (e.creato_da !== a && categoria(e.codice) !== 'da_correggere') aggiungi(c, e.codice)
    }
    if (c.daVerificare + c.anomalie > 0) avvisi.push(avvisoAdmin(a, c))
  }

  // Pausa, sospensione e ripresa fermano o fanno ripartire le fatture di TUTTE le sedi: a chi
  // ha fatture in attesa e agli admin (decisioni 12 e 21), ciascuno una volta sola.
  const inAttesaEAdmin = [...new Set([...fatti.in_attesa, ...admin])]
  if (fatti.pausa) {
    avvisi.push({
      tipo: 'fattura_coda_pausa',
      destinatari: inAttesaEAdmin,
      titolo: 'Invio fatture in pausa',
      // «dopo le», non «alle»: `pausa_fino_a` è la fine della pausa, e le fatture ripartono
      // col primo giro che la segue (un tick del cron, o la sveglia di un accodamento).
      corpo: `Aruba ha chiesto di rallentare: le fatture in coda ripartono da sole ${quando(fatti.pausa.fino_a, ctx.adesso, 'dopo le') ?? 'fra poco'}.`,
      entitaTipo: null,
      entitaId: null,
    })
  }
  if (fatti.sospensione) {
    const s = fatti.sospensione
    // Chi ha premuto non riceve l'avviso del proprio gesto: `da` per la sospensione (lo scrive
    // la riga di stato), l'attore della route per entrambe.
    const esclusi = new Set([s.da, ctx.attore].filter((x): x is string => typeof x === 'string'))
    const destinatari = inAttesaEAdmin.filter((u) => !esclusi.has(u))
    avvisi.push(
      s.evento === 'sospesa'
        ? {
            tipo: 'fattura_coda_sospesa',
            destinatari,
            titolo: 'Coda fatture sospesa',
            corpo: `Un amministratore ha sospeso l’invio ${quando(s.il, ctx.adesso) ?? 'poco fa'}: le fatture restano in coda, nello stesso ordine, e ripartono alla ripresa.`,
            entitaTipo: null,
            entitaId: null,
          }
        : {
            tipo: 'fattura_coda_ripresa',
            destinatari,
            titolo: 'Coda fatture ripresa',
            corpo: 'L’invio delle fatture è ripreso: partono da sole, nell’ordine della coda.',
            entitaTipo: null,
            entitaId: null,
          },
    )
  }
  return avvisi.filter((a) => a.destinatari.length > 0)
}
