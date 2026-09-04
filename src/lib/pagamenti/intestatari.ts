import type { SupabaseClient } from '@supabase/supabase-js'
import { getGenitoriDiAlunno } from '@/lib/anagrafiche/legami'
import {
  anagraficaDaIntestatarioAltro,
  anagraficaDaPersonaScelta,
  type AnagraficaFatturabile,
  type IntestatarioScelto,
} from '@/lib/fatturazione/intestatario-scelto'

// =============================================================================
// Risolutore intestatari fattura + ripartizione in quote (genitori separati).
//
// Contesto identità (verificato live):
//  · `alunni.intestatario_fatture.adult_id` = **parents.id** (registry PK);
//  · `alunni.retta_split_config.quote[].adult_id` e `pagamenti_quote.adult_id`
//    = **utenti.id** (== auth.uid per staff/genitori-demo);
//  · ponte canonico: `parents.auth_user_id == utenti.id`.
// `resolveParentRegistry` unifica i due spazi tornando SEMPRE una riga `parents`
// (che porta il codice fiscale, obbligatorio per la FatturaPA).
// =============================================================================

export interface ParentRegistry {
  id: string
  first_name: string | null
  last_name: string | null
  fiscal_code: string | null
  residence_address: string | null
  residence_city: string | null
  zip_code: string | null
}

const REG_COLS = 'id, first_name, last_name, fiscal_code, residence_address, residence_city, zip_code'

/**
 * Da un adultId (parents.id OPPURE utenti.id) alla riga `parents` fatturabile.
 * Prova prima parents.id (spazio intestatario_fatture), poi il ponte
 * parents.auth_user_id (spazio quote/utenti). `null` se non risolvibile.
 */
export async function resolveParentRegistry(
  supabase: SupabaseClient,
  adultId: string | null | undefined,
): Promise<ParentRegistry | null> {
  if (!adultId) return null
  const byId = await supabase.from('parents').select(REG_COLS).eq('id', adultId).maybeSingle()
  if (byId.data) return byId.data as ParentRegistry
  const byBridge = await supabase.from('parents').select(REG_COLS).eq('auth_user_id', adultId).maybeSingle()
  return (byBridge.data as ParentRegistry | null) ?? null
}

export interface Quota {
  /**
   * `parents.id` OPPURE `utenti.id` (li unifica `resolveParentRegistry`).
   *
   * `null` quando l'intestatario NON è una riga d'anagrafica ma una persona
   * indicata a mano: allora non c'è niente da rileggere, e la fonte è
   * `anagrafica` qui sotto.
   */
  adultId: string | null
  importo: number
  /** Etichetta leggibile (es. "Mamma", "Papà", nome) — vuota per quota unica. */
  label: string
  /**
   * L'anagrafica dell'intestatario quando non viene da `parents`: il ramo
   * `intestatario_fatture.tipo = 'altro'` della scheda del bambino, o la persona
   * digitata al momento dell'emissione. Presente ⇒ `adultId` è `null`, e
   * l'emissione salta `resolveParentRegistry` scrivendo `quota_adult_id: null`.
   */
  anagrafica?: AnagraficaFatturabile | null
}

/**
 * L'esito dell'applicazione di una scelta manuale alle quote calcolate.
 * `conflitto_quote` non è un errore tecnico: è un rifiuto di merito, e chi lo
 * riceve deve poterlo distinguere da un guasto.
 */
export type EsitoIntestatarioScelto =
  | { ok: true; quote: Quota[] }
  | { ok: false; motivo: 'conflitto_quote' }

/**
 * Applica alle quote l'intestatario scelto a mano.
 *
 *   nessuna quota → ACCETTA: ne crea UNA con l'intestatario scelto e il totale
 *   una quota      → ACCETTA: sostituisce l'intestatario, lascia importo ed etichetta
 *   due o più      → RIFIUTA: `conflitto_quote`
 *
 * ─── PERCHÉ CON I GENITORI SEPARATI SI RIFIUTA, invece di far vincere la scelta ─
 *
 *  1. FISCALE. La ripartizione esiste perché ciascun genitore riceva un documento
 *     per la PROPRIA quota, e la detrazione si porta sulla fattura intestata a chi
 *     ha pagato. Un documento unico cancella la detrazione dell'altro genitore.
 *     L'ordinante di un bonifico dice CHI HA SPOSTATO IL DENARO, non COME SI
 *     RIPARTISCE IL COSTO: sono due domande diverse, e solo la seconda decide qui.
 *
 *  2. FORZA DELLE FONTI. Lo split è configurato per-figlio da una persona, a volte
 *     ricalcato su un accordo di separazione; una proposta dall'ordinante è una
 *     deduzione da un estratto conto. La fonte debole non sovrascrive la forte in
 *     silenzio — è la stessa famiglia di difetto che il 2026-09-03 ha prodotto la
 *     FPR 1948/26, dove una casella precompilata batteva il modello configurato.
 *
 *  3. LA VIA D'USCITA ESISTE GIÀ, e il messaggio del 409 la nomina: si modificano
 *     le `pagamenti_quote` nell'editor di Segreteria. Non si sta chiudendo una
 *     porta, si sta indicando quella giusta.
 *
 * Il rifiuto vive QUI, lato server, e resta valido anche se l'interfaccia non
 * offrirà mai il comando su un pagamento ripartito: un client vecchio o una
 * chiamata a mano non devono poterlo aggirare.
 *
 * Funzione PURA: la regola si prova senza Supabase, e `determinaQuoteFatturazione`
 * — che ha quattro chiamanti — non cambia firma.
 */
export function applicaIntestatarioScelto(
  quote: Quota[],
  scelto: IntestatarioScelto | null | undefined,
  totale: number,
): EsitoIntestatarioScelto {
  if (!scelto) return { ok: true, quote }
  if (quote.length > 1) return { ok: false, motivo: 'conflitto_quote' }

  const base = quote[0]
  const importo = base ? base.importo : round2(totale)
  const label = base ? base.label : ''

  if (scelto.tipo === 'adult') {
    return { ok: true, quote: [{ adultId: scelto.adult_id, importo, label }] }
  }
  return {
    ok: true,
    quote: [{ adultId: null, importo, label, anagrafica: anagraficaDaPersonaScelta(scelto) }],
  }
}

interface Voce {
  adultId: string
  peso: number
  label: string
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Ripartisce `totale` fra le voci in proporzione ai pesi; arrotonda a 2 decimali
 * e assegna il resto (centesimi) alla PRIMA quota così che la somma sia esatta.
 */
export function ripartisci(voci: Voce[], totale: number): Quota[] {
  if (voci.length === 0) return []
  const sommaPesi = voci.reduce((s, v) => s + v.peso, 0)
  const base = sommaPesi > 0 ? voci.map((v) => (totale * v.peso) / sommaPesi) : voci.map(() => totale / voci.length)
  const arrot = base.map(round2)
  const resto = round2(totale - arrot.reduce((s, x) => s + x, 0))
  return voci.map((v, i) => ({
    adultId: v.adultId,
    importo: i === 0 ? round2(arrot[0] + resto) : arrot[i],
    label: v.label,
  }))
}

export interface PagamentoQuoteInput {
  id: string
  importo: number | string
}
export interface AlunnoQuoteInput {
  id?: string | null
  genitori_separati?: boolean | null
  retta_split_config?: { quote?: { adult_id: string; importo: number | string; etichetta?: string | null }[] } | null
  /**
   * `alunni.intestatario_fatture`, nelle DUE forme che la scheda del bambino sa
   * scrivere: `{ tipo: 'adult', adult_id }` e `{ tipo: 'altro', dati: {…} }`.
   * Le righe più vecchie non hanno `tipo` e portano solo `adult_id`.
   */
  intestatario_fatture?: { tipo?: string | null; adult_id?: string | null; dati?: unknown } | null
}

/**
 * Intestatario di DEFAULT della famiglia (Contabilità v2): il primo genitore del
 * bambino con `parents.intestatario_default = true`. Usato solo in assenza di
 * eccezione per-figlio. Retry-less sulla colonna: se `intestatario_default` non
 * esiste (DB E2E CI non migrato, 42703) → `null`, così si cade sul fallback.
 */
export async function intestatarioDefaultFamiglia(
  supabase: SupabaseClient,
  alunnoId: string,
): Promise<string | null> {
  const { data: sp } = await supabase.from('student_parents').select('parent_id').eq('student_id', alunnoId)
  const parentIds = [...new Set(((sp ?? []) as { parent_id?: string | null }[]).map((r) => r.parent_id).filter(Boolean) as string[])]
  if (parentIds.length === 0) return null
  const def = await supabase
    .from('parents')
    .select('id')
    .in('id', parentIds)
    .eq('intestatario_default', true)
    .limit(1)
    .maybeSingle()
  if (def.error) return null // colonna assente (42703) o errore → fallback
  return (def.data as { id?: string } | null)?.id ?? null
}

/**
 * CHI sono i genitori di un bambino, nelle DUE sorgenti — in un posto solo.
 *
 * `student_parents` (anagrafica, spazio `parents.id`) unito al ponte runtime
 * `legame_genitori_alunni` (spazio `utenti.id`): è la stessa unione del passo 2c
 * della cascata, e con la sola anagrafica i tutori di un bambino importato dal
 * modulo pubblico «non risultavano» — difetto già pagato una volta.
 *
 * ⚠️ `completo` copre la lettura di `student_parents` E la risoluzione del ponte
 * in `parents.id`: se una delle due non risponde, chi usa questo insieme per
 * RIFIUTARE riceve «non lo so», non «no». Resta scoperta la lettura INTERNA di
 * `legame_genitori_alunni` dentro `getGenitoriDiAlunno`, che degrada per conto
 * suo (logga e restituisce ciò che ha): in una giornata in cui fallisce quella,
 * un genitore noto al SOLO ponte runtime non comparirebbe qui. Chi usa questo
 * insieme per RIFIUTARE deve saperlo: il costo di quel caso è un messaggio di
 * troppo, non un documento fiscale sbagliato, e la lettura fallita lascia
 * comunque la sua riga di log.
 */
export interface GenitoriDiAlunno {
  /**
   * `parents.id` — l'UNICO elenco che conta per confrontare un intestatario
   * scelto, e l'unione delle due sorgenti già RISOLTA nello stesso spazio:
   * l'anagrafica (`student_parents.parent_id`) più il ponte runtime, portato di
   * là con `parents.auth_user_id`.
   *
   * ⚠️ LA RISOLUZIONE STA QUI, E NON DAL CHIAMANTE. Finché il ponte restava
   * nello spazio `utenti.id`, l'anteprima esponeva un genitore col suo
   * `parents.id` (risolto per conto suo) e l'emissione confrontava quello stesso
   * id con un elenco che non lo conteneva: l'app offriva una scelta e poi la
   * rifiutava con 422, dando la colpa a chi aveva premuto. Due mappe della
   * stessa cosa divergono appena qualcuno le calcola in due posti.
   */
  parentIds: string[]
  /** `utenti.id` dal ponte runtime: resta esposto perché una chiamata a mano può parlarlo. */
  accountIds: string[]
  /** `student_parents` ha risposto: si può concludere «non è un genitore». */
  completo: boolean
  /** `student_parents.relation_type`, per `parents.id`. */
  relazioni: Map<string, string | null>
  /** Le righe `parents` dei genitori noti dal solo ponte, già lette. */
  registriDalPonte: ParentRegistryConPonte[]
}

/** Una riga `parents` con il ponte, per chi deve unire i due spazi d'identità. */
export interface ParentRegistryConPonte extends ParentRegistry {
  auth_user_id?: string | null
}

/** Le colonne che servono a chi mostra un candidato: il registro più il ponte. */
export const REG_COLS_CON_PONTE = `${REG_COLS}, auth_user_id`

export async function identitaGenitoriDiAlunno(
  supabase: SupabaseClient,
  alunnoId: string,
): Promise<GenitoriDiAlunno> {
  const relazioni = new Map<string, string | null>()
  const { data, error } = await supabase
    .from('student_parents')
    .select('parent_id, relation_type')
    .eq('student_id', alunnoId)
  const righe = ((data ?? []) as { parent_id?: string | null; relation_type?: string | null }[]).filter(
    (r) => typeof r.parent_id === 'string',
  )
  for (const r of righe) relazioni.set(r.parent_id as string, r.relation_type ?? null)
  const accountIds = await getGenitoriDiAlunno(supabase, alunnoId)
  const parentIds = new Set(righe.map((r) => r.parent_id as string))

  // Il ponte, portato nello spazio del REGISTRO. `getGenitoriDiAlunno` scarta i
  // `parents` senza account, quindi questo giro aggiunge solo chi un account ce
  // l'ha — ed è esattamente chi l'anteprima mostra fra i candidati.
  let registriDalPonte: ParentRegistryConPonte[] = []
  let ponteLetto = true
  if (accountIds.length > 0) {
    const ponte = await supabase.from('parents').select(REG_COLS_CON_PONTE).in('auth_user_id', accountIds)
    // PostgREST NON LANCIA (AGENTS.md, regola 7). Se questa lettura fallisce non
    // si può concludere «non è un genitore»: chi decide un'emissione non deve
    // leggere «no» dove la verità è «non lo so».
    ponteLetto = !ponte.error
    registriDalPonte = (ponte.data ?? []) as ParentRegistryConPonte[]
    for (const p of registriDalPonte) if (p.id) parentIds.add(p.id)
  }

  return {
    parentIds: [...parentIds],
    accountIds,
    completo: !error && ponteLetto,
    relazioni,
    registriDalPonte,
  }
}

/**
 * L'adulto scelto a mano è un genitore di QUEL bambino?
 *
 * `null` = non si è potuto stabilire (la lettura non ha risposto): chi decide
 * un'emissione non deve poter leggere «no» dove la verità è «non lo so».
 * L'`adultId` può arrivare in entrambi gli spazi d'identità e si confronta con
 * l'insieme GIÀ RISOLTO da `identitaGenitoriDiAlunno` — la stessa risoluzione
 * che alimenta i candidati dell'anteprima. È il punto: finché le due liste
 * venivano da due letture diverse, l'app proponeva un genitore e poi lo
 * rifiutava (6 famiglie in produzione, di cui 4 con riga `parents`).
 * La select estesa vive in `REG_COLS_CON_PONTE` e resta separata da `REG_COLS`:
 * aggiungere `auth_user_id` a quest'ultima farebbe fallire l'INTERA select con
 * `42703` sui database non migrati, su quattro strade che oggi funzionano.
 */
export async function adultoEGenitoreDi(
  supabase: SupabaseClient,
  alunnoId: string,
  adultId: string,
): Promise<boolean | null> {
  const g = await identitaGenitoriDiAlunno(supabase, alunnoId)
  // Entrambi gli spazi: `parentIds` è già l'unione risolta (anagrafica + ponte),
  // `accountIds` copre chi arriva con l'id dell'account — sono la stessa persona
  // e devono valere tutti e due.
  if (g.parentIds.includes(adultId) || g.accountIds.includes(adultId)) return true
  return g.completo ? false : null
}

/**
 * Determina le quote di fatturazione di un pagamento. Priorità:
 *  1) ordine divise (`divise_ordini.pagamento_id`) → quota UNICA a chi ha ordinato;
 *  2) alunno con genitori separati →
 *     a) `pagamenti_quote` esplicite del pagamento, se presenti;
 *     b) proporzioni da `retta_split_config.quote` scalate sull'importo;
 *     c) 50/50 sui due tutori (`legame_genitori_alunni`);
 *  3) default → quota UNICA a `intestatario_fatture.adult_id`.
 * Somma sempre esatta (resto alla prima quota). `[]` se nessun intestatario.
 */
export async function determinaQuoteFatturazione(
  supabase: SupabaseClient,
  pagamento: PagamentoQuoteInput,
  alunno: AlunnoQuoteInput,
): Promise<Quota[]> {
  const totale = round2(Number(pagamento.importo))

  // 1) Ordine divise → quota unica all'ordinante.
  const { data: ordine } = await supabase
    .from('divise_ordini')
    .select('parent_id')
    .eq('pagamento_id', pagamento.id)
    .maybeSingle()
  if (ordine?.parent_id) {
    return [{ adultId: ordine.parent_id as string, importo: totale, label: 'Divise' }]
  }

  // 2) Genitori separati.
  if (alunno.genitori_separati) {
    // 2a) quote esplicite del pagamento (l'editor Segreteria le tiene = importo).
    const { data: quote } = await supabase
      .from('pagamenti_quote')
      .select('adult_id, importo, etichetta')
      .eq('pagamento_id', pagamento.id)
    if (quote && quote.length > 0) {
      const mapped = (quote as { adult_id: string; importo: number | string; etichetta: string | null }[]).map((q) => ({
        adultId: q.adult_id,
        importo: round2(Number(q.importo)),
        label: q.etichetta ?? '',
      }))
      // Congruenza fiscale: la somma delle quote esplicite deve pareggiare il
      // totale del pagamento (le quote potrebbero non essere state aggiornate se
      // l'importo è cambiato). L'eventuale differenza va sulla prima quota, così
      // Σ quote == totale e non si sotto/sovra-fattura.
      const somma = round2(mapped.reduce((s, x) => s + x.importo, 0))
      const diff = round2(totale - somma)
      if (diff !== 0) mapped[0] = { ...mapped[0], importo: round2(mapped[0].importo + diff) }
      return mapped
    }
    // 2b) proporzioni da retta_split_config scalate sull'importo del pagamento.
    const cfg = alunno.retta_split_config
    if (cfg?.quote && cfg.quote.length > 0) {
      return ripartisci(
        cfg.quote.map((q) => ({ adultId: q.adult_id, peso: Number(q.importo) || 0, label: q.etichetta ?? '' })),
        totale,
      )
    }
    // 2c) 50/50 sui due tutori noti — unione runtime (`legame_genitori_alunni`)
    //     + anagrafica (`student_parents` via ponte `parents.auth_user_id`).
    //     Con la sola runtime i due tutori "non risultavano", la ripartizione
    //     50/50 saltava e la fattura finiva intestata a una persona sola.
    if (alunno.id) {
      const ids = await getGenitoriDiAlunno(supabase, alunno.id)
      if (ids.length >= 2) {
        return ripartisci(ids.slice(0, 2).map((id, i) => ({ adultId: id, peso: 1, label: i === 0 ? 'Genitore 1' : 'Genitore 2' })), totale)
      }
    }
  }

  // 3) Eccezione per-figlio → intestatario unico (vince sul default famiglia).
  //
  // ⚠️ IL RAMO `'altro'` NON RICADE SUL DEFAULT DI FAMIGLIA, e non è prudenza:
  // fino al 2026-09-04 questa cascata leggeva `adult_id` e basta, quindi una
  // scelta esplicita di «intesta a un'altra persona» veniva SALTATA e la fattura
  // usciva a nome del genitore marcato di default — o non usciva affatto (422),
  // senza che nulla lo dicesse. Qui la scelta passa con la sua anagrafica al
  // seguito, anche INCOMPLETA: a fermarla è `validaCessionario` in emissione,
  // che nomina i campi mancanti. Ripiegare sarebbe rifare il difetto di oggi in
  // un posto nuovo.
  const intest = alunno.intestatario_fatture
  if (intest?.tipo === 'altro') {
    return [{ adultId: null, importo: totale, label: '', anagrafica: anagraficaDaIntestatarioAltro(intest.dati) }]
  }
  const adultId = intest?.adult_id
  if (adultId) return [{ adultId, importo: totale, label: '' }]

  // 4) DEFAULT FAMIGLIA → parents.intestatario_default fra i genitori del bambino.
  if (alunno.id) {
    const def = await intestatarioDefaultFamiglia(supabase, alunno.id)
    if (def) return [{ adultId: def, importo: totale, label: '' }]
  }

  // 5) Fallback: nessun intestatario risolvibile.
  return []
}
