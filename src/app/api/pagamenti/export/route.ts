import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import * as XLSX from 'xlsx'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { resolveScuoleAttive, scuoleDiUtente } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { oggiFiscaleISO } from '@/lib/format/fiscal-date'
import { calcolaAttestazione, type VoceAttestazione } from '@/lib/pagamenti/attestazione'
import { resolveParentRegistry, type ParentRegistry } from '@/lib/pagamenti/intestatari'
import { anagraficaDaScheda, nomeDaAnagrafica } from '@/lib/fatturazione/intestatario-scelto'
import { righeRetteACarico, type RigaScadenzario } from '@/lib/pagamenti/export-rette-a-carico'
import { leggiABlocchi, type EsitoABlocchi } from '@/lib/pagamenti/leggi-a-blocchi'
import { sediDeiPaganti } from '@/lib/pagamenti/rette-a-carico-server'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// ─── Schemi di validazione input ─────────────────────────────────────────────
const zUuidQueryOpzionale = z.preprocess((v) => (v === '' ? undefined : v), zUuid.optional())

/**
 * K2 — `section_ids`: uuid di sezione separati da virgola (`?section_ids=a,b`),
 * o ripetuti (`?section_ids=a&section_ids=b`, che `parseQuery` consegna come
 * array). Vuoto ⇒ assente (nessun filtro). Un solo valore non uuid ⇒ 400: un
 * filtro scartato in silenzio produrrebbe l'export di TUTTA la sede spacciato
 * per quello di una classe. Tetto a 200: le sezioni di tre plessi sono decine.
 */
const zSectionIds = z.preprocess((v) => {
  if (v === undefined) return undefined
  const grezzi = (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(','))
  const puliti = grezzi.map((x) => x.trim()).filter((x) => x !== '')
  return puliti.length === 0 ? undefined : puliti
}, z.array(zUuid).min(1).max(200).optional())

const getQuerySchema = z
  .object({
    tipo: z.enum(['scadenzario', 'ade']),
    scuola_id: zUuidQueryOpzionale,
    stato: z.string().optional(),
    categoria_id: zUuidQueryOpzionale,
    anno: z.coerce.number().int().min(2000).max(2100).optional(),
    section_ids: zSectionIds,
  })
  .refine((q) => q.tipo !== 'ade' || q.anno !== undefined, "l'export AdE richiede l'anno")
// NB: `section_ids` con `tipo=ade` NON è un 400. Prima di K2 zod scartava la
// chiave e la risposta era 200: il compito chiede «resto invariato», e rifiutarla
// romperebbe il download AdE se l'interfaccia riusa la query dello Scadenzario.
// La comunicazione all'Agenzia delle Entrate resta sull'anno e sulla sede per
// intero: il filtro si IGNORA (niente file parziale) e lo si dice nel log.

const STATO_LABEL: Record<string, string> = {
  da_pagare: 'Da pagare', parziale: 'Parziale', pagato: 'Pagato', scaduto: 'Scaduto',
}

/**
 * K1 (seconda revisione 2026-09-28) — l'etichetta è SEMPRE una stringa. `pagamenti.stato` in
 * produzione è nullable: `STATO_LABEL[null] ?? null` dava `null`, che prima diventava una cella
 * vuota e con la larghezza della colonna (`.length`) faceva rispondere 500 a tutto l'export.
 * Uno stato sconosciuto resta com'è, come prima.
 */
function etichettaStato(stato: string | null | undefined): string {
  return stato ? (STATO_LABEL[stato] ?? stato) : ''
}
const FATTURA_LABEL: Record<string, string> = {
  non_richiesta: 'Da fatturare', in_attesa: 'In attesa SDI', emessa: 'Fatturata', scartata: 'Scartata',
}

interface RigaPagamento {
  scuola_id: string | null
  descrizione: string
  importo: number
  importo_pagato: number | null
  scadenza: string | null
  periodo_competenza: string | null
  /** Nullable in produzione (K1): mai usarlo senza `etichettaStato`. */
  stato: string | null
  tipo: string
  fattura_stato: string | null
  alunni?: { nome?: string; cognome?: string; classe_sezione?: string | null } | null
  payment_categories?: { nome?: string } | null
}

/**
 * K2 — nome di ogni sede in scope, per la colonna «Sede» degli export.
 *
 * Con tre plessi due «Sezione A» sono la stessa stringa: senza la sede la riga
 * non dice di chi è. Se i nomi non si leggono si risponde 500 (PostgREST non
 * lancia: `{ error }` va guardato) invece di consegnare un export con la
 * colonna vuota, che sembrerebbe giusto e non lo è.
 */
async function nomiDelleSedi(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  sedi: string[],
): Promise<{ nomi?: Map<string, string>; response?: NextResponse }> {
  const { data, error } = await supabase.from('schools').select('id, nome').in('id', sedi)
  if (error) {
    logErrore({ operazione: 'pagamenti/export:GET', stato: 500, evento: 'db' }, error)
    return { response: NextResponse.json({ error: 'Errore nel recupero delle sedi', codice: 'LETTURA_FALLITA' }, { status: 500 }) }
  }
  const nomi = new Map<string, string>()
  for (const s of (data ?? []) as { id: string; nome: string | null }[]) nomi.set(s.id, s.nome ?? '')
  return { nomi }
}

/**
 * K5 (seconda revisione 2026-09-28) — una lettura a blocchi fallita, per errore o per il
 * tetto, è un 500 con `LETTURA_FALLITA`: mai un file con un pezzo in meno.
 *
 * R2 (terza revisione 2026-09-29) — la riga di log è UNA, la scrive QUI, e porta `stato: 500`:
 * `logErrore` con `evento: 'lettura-troncata'` al tetto (i conteggi nel messaggio, come
 * `leggiTutte` di `GET /api/pagamenti`) o `evento: 'db'` con l'errore vero del blocco.
 * `logErrore` alza la marca anti-doppione, e `withRoute` non aggiunge una seconda riga.
 * `leggiABlocchi` non logga: non sa se il chiamante risponderà 500 o 200 (vedi il modulo).
 * Prima il tetto lo loggava lui con `logEvento`, senza `stato`, e alzava la marca: per questo
 * 500 nei log non c'era nessuna riga con lo stato.
 */
function letturaFallita(esito: Extract<EsitoABlocchi<unknown>, { ok: false }>, messaggio: string, tipo: string): NextResponse {
  if (esito.motivo === 'tetto') {
    // Solo il nome della lettura e dei conteggi: mai dati (AGENTS.md, regola 8).
    logErrore(
      { operazione: 'pagamenti/export:GET', stato: 500, evento: 'lettura-troncata' },
      new Error(`lettura-troncata: ${tipo} oltre ${esito.oltre} righe (${esito.n} lette in ${esito.blocchi} blocchi), rifiutata per intero`),
    )
  } else {
    logErrore({ operazione: 'pagamenti/export:GET', stato: 500, evento: 'db' }, esito.error)
  }
  return NextResponse.json({ error: messaggio, codice: 'LETTURA_FALLITA' }, { status: 500 })
}

// GET /api/pagamenti/export?tipo=scadenzario — XLSX per la segreteria/commercialista
export const GET = withRoute('pagamenti/export:GET', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { scuola_id: scuolaId, stato, categoria_id: categoriaId } = q.data
    // Il filtro classi vale SOLO per lo Scadenzario: per l'AdE non si applica.
    const sectionIds = q.data.tipo === 'scadenzario' ? q.data.section_ids : undefined
    if (q.data.tipo === 'ade' && q.data.section_ids) {
      logEvento('pagamento', 'info', {
        tipo: 'export-ade-classi-ignorate', azione: 'pagamenti/export:GET',
        utente: user.id, ruolo: user.role, classi: q.data.section_ids.length,
      })
    }

    const supabase = await createAdminClient()
    const sediAttive = await resolveScuoleAttive(request, supabase, user)

    // Accountability GDPR: gli export contengono PII (nomi, sezioni, importi; il
    // ramo AdE anche i codici fiscali). Registra chi esporta cosa e quando.
    await logScrittura(supabase, {
      attore: user,
      entitaTipo: 'export_pagamenti',
      azione: 'insert',
      scuolaId: scuolaId && sediAttive.includes(scuolaId) ? scuolaId : sediAttive[0] ?? null,
      valoreDopo: {
        tipo: q.data.tipo, anno: q.data.anno ?? null, sedi: sediAttive,
        classi: sectionIds ?? null,
      },
    })

    const sedi = await nomiDelleSedi(supabase, sediAttive)
    if (sedi.response) return sedi.response
    const nomiSedi = sedi.nomi!

    if (q.data.tipo === 'ade') {
      return exportAde(supabase, sediAttive, q.data.anno!, nomiSedi)
    }

    // K2 — filtro classi. `!inner` SOLO quando le classi si chiedono: senza,
    // PostgREST non scarta la voce il cui alunno è fuori dalle sezioni, le mette
    // soltanto `alunni: null` — e l'export «della Sezione A» conterrebbe tutta la
    // sede. Senza filtro resta il join normale, così le voci senza alunno restano.
    const embedAlunni = sectionIds
      ? 'alunni!inner ( nome, cognome, classe_sezione, section_id )'
      : 'alunni ( nome, cognome, classe_sezione )'
    // A blocchi (C2, 2026-09-28): senza `range` PostgREST consegnava le prime 1000 righe e
    // taceva — il 28/09 le esportabili delle tre sedi erano 1.150. Una query NUOVA per blocco;
    // `leggiABlocchi` aggiunge `id` dopo `scadenza`, perché fra rette con la stessa scadenza
    // Postgres non garantisce l'ordine e due blocchi si sovrapporrebbero.
    const costruisci = () => {
      let query = supabase
        .from('pagamenti')
        .select(`
          scuola_id, descrizione, importo, importo_pagato, scadenza, periodo_competenza, stato, tipo, fattura_stato,
          payment_categories ( nome ),
          ${embedAlunni}
        `)
        .in('scuola_id', sediAttive)
        .order('scadenza', { ascending: true })
      if (scuolaId && sediAttive.includes(scuolaId)) query = query.eq('scuola_id', scuolaId)
      if (stato) query = query.eq('stato', stato)
      if (categoriaId) query = query.eq('categoria_id', categoriaId)
      if (sectionIds) query = query.in('alunni.section_id', sectionIds)
      return query
    }

    const letti = await leggiABlocchi<RigaPagamento>(costruisci)
    if (!letti.ok) return letturaFallita(letti, 'Errore nel recupero dei pagamenti', 'export-scadenzario')

    // I contenitori padre non sono voci esigibili: nell'export contano le rate.
    const righe: RigaScadenzario[] = letti.righe
      .filter((p) => p.tipo !== 'padre')
      .map((p) => ({
        // K2 — prima colonna: con più plessi è la prima cosa che serve sapere.
        Sede: p.scuola_id ? (nomiSedi.get(p.scuola_id) ?? '') : '',
        Alunno: [p.alunni?.nome, p.alunni?.cognome].filter(Boolean).join(' '),
        Sezione: p.alunni?.classe_sezione ?? '',
        Categoria: p.payment_categories?.nome ?? '',
        Descrizione: p.descrizione,
        Scadenza: p.scadenza ?? '',
        'Importo €': Number(p.importo),
        'Pagato €': Number(p.importo_pagato || 0),
        'Residuo €': Math.max(0, Number(p.importo) - Number(p.importo_pagato || 0)),
        Stato: etichettaStato(p.stato),
        Fattura: p.stato === 'pagato' ? (FATTURA_LABEL[p.fattura_stato ?? 'non_richiesta'] ?? '') : '',
      }))

    // D14 — i bambini con la retta a carico di un fratello: una riga a importi zero per ogni
    // retta del pagante. Si intercalano per scadenza; il sort è STABILE: a pari scadenza restano
    // prima le righe vere, poi quelle a carico, ciascuna nell'ordine in cui è stata letta.
    // `pagamenti.scadenza` è NOT NULL (dal baseline): una cella «Scadenza» vuota oggi non può
    // arrivare. `chiave` la manderebbe comunque in fondo — è una DIFESA, per il giorno in cui la
    // colonna diventasse nullable, non un caso che accade (R11c, terza revisione 2026-09-29).
    const sediBambini = scuolaId && sediAttive.includes(scuolaId) ? [scuolaId] : sediAttive
    const aCarico = await righeRetteACarico(supabase, {
      sediBambini,
      // K4: unite alle sedi dei bambini — da sola questa seconda `scuoleDiUtente`, su un errore,
      // dà `[]` e le righe dei bambini sparirebbero anche col pagante nella loro sede.
      sediPaganti: sediDeiPaganti(sediBambini, await scuoleDiUtente(supabase, user)),
      sectionIds,
      stato,
      categoriaId,
      nomiSedi,
      etichettaStato,
    })
    const chiave = (s: string) => s || '￿'
    const tutte = [...righe, ...aCarico].sort((a, b) => {
      const x = chiave(a.Scadenza), y = chiave(b.Scadenza)
      return x < y ? -1 : x > y ? 1 : 0
    })

    const ws = XLSX.utils.json_to_sheet(tutte)
    // «Stato» si allarga con la frase più lunga che contiene: «Da pagare» sta in 10 caratteri,
    // «Paga il fratello Mario Rossi (Sez. C) · Da pagare» ne ha 50–60 (e in 10 si leggeva
    // «Paga il f»). Tetto a 60: oltre, una colonna larga mezzo schermo non aiuta nessuno.
    // `String(… ?? '')` anche se `Stato` nasce già stringa (K1): una colonna più stretta è un
    // difetto estetico, un export in 500 per una cella è un difetto vero.
    const larghezzaStato = Math.min(60, tutte.reduce((max, r) => Math.max(max, String(r.Stato ?? '').length), 10))
    ws['!cols'] = [{ wch: 20 }, { wch: 24 }, { wch: 12 }, { wch: 12 }, { wch: 34 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: larghezzaStato }, { wch: 14 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Scadenzario')
    // Nessun dato personale: conteggi e numero di classi filtrate.
    logEvento('pagamento', 'info', {
      tipo: 'export-scadenzario', azione: 'pagamenti/export:GET',
      utente: user.id, ruolo: user.role, attive: sediAttive.length,
      classi: sectionIds?.length ?? 0, n: tutte.length, a_carico: aCarico.length,
    })

    // SheetJS ritorna Buffer in Node: cast ad ArrayBuffer per NextResponse
    const rawBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as unknown
    const nodeBuffer = rawBuffer as { buffer: ArrayBuffer; byteOffset: number; byteLength: number }
    const arrayBuffer = nodeBuffer.buffer.slice(nodeBuffer.byteOffset, nodeBuffer.byteOffset + nodeBuffer.byteLength)
    const oggi = oggiFiscaleISO()
    return new NextResponse(new Uint8Array(arrayBuffer as ArrayBuffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="scadenzario-${oggi}.xlsx"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/export:GET', stato: 500 }, err)
    // Con codice anche qui (R4, terza revisione 2026-09-29; lock `errori-con-codice`): la route
    // LEGGE e basta — l'unica scrittura, la traccia d'accesso di `logScrittura`, non lancia —,
    // e gli altri suoi 500 portano già `LETTURA_FALLITA`. Un'eccezione imprevista resta «non
    // sono riuscito a leggere i dati, riprova», come nella GET gemella `rette-a-carico`.
    return NextResponse.json({ error: 'Internal Server Error', codice: 'LETTURA_FALLITA' }, { status: 500 })
  }
})

interface AlunnoAde {
  id: string
  nome?: string | null
  cognome?: string | null
  codice_fiscale?: string | null
  opposizione_ade?: boolean | null
  intestatario_fatture?: { tipo?: string | null; adult_id?: string | null; dati?: unknown } | null
  scuola_id?: string | null
}
interface IncassoAde {
  importo: number
  metodo?: string | null
  pagamenti?: {
    alunno_id: string
    descrizione?: string | null
    payment_categories?: { slug?: string | null } | null
  } | null
}

// Export per la comunicazione delle spese scolastiche all'AdE (obbligo dal
// periodo d'imposta 2022, invio entro il 16 marzo): criterio di cassa
// sull'anno solare, SOLO quote tracciabili di categorie ammesse. Il foglio
// "Escluse" motiva ogni esclusione (opposizione, contanti, categorie
// non detraibili, CF pagatore mancante) per il controllo del commercialista.
async function exportAde(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  sediAttive: string[],
  anno: number,
  nomiSedi: Map<string, string>,
) {
  // A BLOCCHI anche qui (C2, 2026-09-28), per la stessa ragione dello Scadenzario: gli alunni
  // sono TUTTI quelli delle sedi (ritirati compresi, vedi `elenchi-operativi-solo-iscritti`) e
  // gli incassi quelli di un anno intero, e PostgREST avrebbe tagliato l'uno e l'altro a 1000
  // righe in silenzio — cioè omesso dalla comunicazione all'Agenzia delle Entrate le spese di
  // chi finiva oltre il taglio. L'ordine stabile (`id`) lo mette `leggiABlocchi`.
  // select('*') sugli alunni: tollera i DB senza opposizione_ade (e2e CI).
  const alunniLetti = await leggiABlocchi<AlunnoAde>(
    () => supabase.from('alunni').select('*').in('scuola_id', sediAttive),
  )
  // `exportAde` è un ramo della stessa route: `operazione` resta quella di `withRoute`. Al
  // tetto (K5) un 500 e non un file: una comunicazione all'AdE con delle spese in meno non
  // deve poter uscire.
  if (!alunniLetti.ok) return letturaFallita(alunniLetti, 'Errore nel recupero degli alunni', 'export-ade-alunni')

  const incassiLetti = await leggiABlocchi<IncassoAde>(
    () => supabase
      .from('incassi')
      .select('importo, metodo, data_incasso, pagamenti!inner ( alunno_id, scuola_id, descrizione, payment_categories ( slug ) )')
      .gte('data_incasso', `${anno}-01-01`)
      .lte('data_incasso', `${anno}-12-31`)
      .in('pagamenti.scuola_id', sediAttive),
  )
  if (!incassiLetti.ok) return letturaFallita(incassiLetti, 'Errore nel recupero degli incassi', 'export-ade-incassi')

  const perAlunno = new Map<string, VoceAttestazione[]>()
  for (const i of incassiLetti.righe) {
    const alunnoId = i.pagamenti?.alunno_id
    if (!alunnoId) continue
    const arr = perAlunno.get(alunnoId) ?? []
    arr.push({
      importo: i.importo,
      metodo: i.metodo,
      categoria_slug: i.pagamenti?.payment_categories?.slug ?? null,
      descrizione: i.pagamenti?.descrizione ?? '—',
    })
    perAlunno.set(alunnoId, arr)
  }

  const regCache = new Map<string, ParentRegistry | null>()
  const daComunicare: Record<string, unknown>[] = []
  const escluse: Record<string, unknown>[] = []

  // K7 (seconda revisione 2026-09-28) — l'ordine dei due fogli. Prima della lettura a blocchi
  // gli alunni si leggevano senza `order` (nessun ordine garantito) e nessuno li riordinava; ora
  // `leggiABlocchi` li consegna per `id`, cioè per uuid: a caso, per chi legge. Si ordina qui
  // per sede (la prima colonna), cognome, nome e — fra omonimi — `id`, così due export dello
  // stesso anno escono identici. Solo l'ordine: le righe sono le stesse.
  const collatore = new Intl.Collator('it')
  const sedeDi = (a: AlunnoAde) => (a.scuola_id ? (nomiSedi.get(a.scuola_id) ?? '') : '')
  const alunniOrdinati = [...alunniLetti.righe].sort((a, b) =>
    collatore.compare(sedeDi(a), sedeDi(b))
    || collatore.compare(a.cognome ?? '', b.cognome ?? '')
    || collatore.compare(a.nome ?? '', b.nome ?? '')
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  for (const al of alunniOrdinati) {
    const voci = perAlunno.get(al.id) ?? []
    if (voci.length === 0) continue
    const r = calcolaAttestazione(voci)
    const nome = `${al.nome ?? ''} ${al.cognome ?? ''}`.trim()
    // K2 — la sede dell'ALUNNO, prima colonna di entrambi i fogli.
    const sede = al.scuola_id ? (nomiSedi.get(al.scuola_id) ?? '') : ''

    if (r.nonTracciabile > 0) {
      escluse.push({ Sede: sede, Alunno: nome, Motivo: 'quota non tracciabile (contanti/altro)', 'Importo €': r.nonTracciabile })
    }
    if (r.escluso > 0) {
      escluse.push({ Sede: sede, Alunno: nome, Motivo: 'categoria non detraibile (divise/materiale)', 'Importo €': r.escluso })
    }
    if (r.detraibile <= 0) continue

    if (al.opposizione_ade) {
      escluse.push({ Sede: sede, Alunno: nome, Motivo: 'opposizione della famiglia alla comunicazione', 'Importo €': r.detraibile })
      continue
    }

    // L'intestatario DIGITATO sulla scheda (`tipo: 'altro'`) non ha una riga
    // `parents`: leggere solo `adult_id` escludeva la riga per «codice fiscale del
    // pagatore mancante» — cioè toglieva a quella famiglia la detrazione, con una
    // motivazione che descriveva il nostro codice invece del suo caso.
    // ⚠️ L'opposizione della famiglia resta dov'è, PRIMA di qui: un intestatario
    // digitato non deve poter far comunicare all'Agenzia delle Entrate una spesa
    // che qualcuno ha chiesto di non comunicare.
    const digitata = anagraficaDaScheda(al.intestatario_fatture)
    const adultId = digitata ? null : al.intestatario_fatture?.adult_id ?? null
    let reg: ParentRegistry | null = null
    if (adultId) {
      if (regCache.has(adultId)) reg = regCache.get(adultId) ?? null
      else {
        reg = await resolveParentRegistry(supabase, adultId)
        regCache.set(adultId, reg)
      }
    }
    const cfPagatore = digitata ? (digitata.codice_fiscale ?? '') : (reg?.fiscal_code ?? '')
    if (!cfPagatore) {
      escluse.push({ Sede: sede, Alunno: nome, Motivo: 'codice fiscale del pagatore mancante', 'Importo €': r.detraibile })
      continue
    }

    daComunicare.push({
      Sede: sede,
      'CF alunno': al.codice_fiscale ?? '',
      Alunno: nome,
      'CF pagatore': cfPagatore,
      Pagatore: digitata
        ? nomeDaAnagrafica(digitata)
        : [reg?.first_name, reg?.last_name].filter(Boolean).join(' '),
      'Importo comunicabile €': r.detraibile,
      Anno: anno,
    })
  }

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(daComunicare), 'Da comunicare')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(escluse), 'Escluse')

  const rawBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as unknown
  const nodeBuffer = rawBuffer as { buffer: ArrayBuffer; byteOffset: number; byteLength: number }
  const arrayBuffer = nodeBuffer.buffer.slice(nodeBuffer.byteOffset, nodeBuffer.byteOffset + nodeBuffer.byteLength)
  return new NextResponse(new Uint8Array(arrayBuffer as ArrayBuffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="comunicazione-ade-${anno}.xlsx"`,
      'Cache-Control': 'no-store',
    },
  })
}
