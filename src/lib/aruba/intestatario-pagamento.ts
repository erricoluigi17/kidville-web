/**
 * CHI intesta la fattura di UN pagamento: gli stessi dati per chi SCEGLIE e per
 * chi EMETTE.
 *
 * ─── PERCHÉ ESISTE, ed è la stessa ragione di `causale-pagamento.ts` ─────────
 * Il 2026-09-03 la FPR 1948/26 è partita con una descrizione diversa da quella
 * configurata, perché il modale la ricalcolava per conto suo. La lezione era
 * «una regola, un posto», e questo modulo la applica all'altra metà del
 * documento: l'intestatario.
 *
 * Le quote NON si ricalcolano qui: le determina `determinaQuoteFatturazione`, lo
 * STESSO codice che chiama `emettiFatturaPagamento`. Se le due strade
 * divergessero, la segreteria confermerebbe un intestatario e il documento
 * partirebbe con un altro — e un intestatario sbagliato su una fattura emessa si
 * corregge solo con una nota di variazione.
 *
 *   `@/lib/aruba/emissione`                → il documento che parte
 *   `/api/pagamenti/fattura/anteprima`     → quello che si vede prima
 *
 * Il lock `__tests__/architecture/intestatario-fattura-un-motore-solo.test.ts`
 * sorveglia che resti così.
 *
 * ─── I CANDIDATI SONO SOLO I GENITORI DI QUEL BAMBINO ───────────────────────
 * `parents` non ha `scuola_id`: l'isolamento di sede passa dai figli. Una
 * ricerca fra i 735 adulti dell'archivio farebbe affiorare persone di un altro
 * plesso dentro il pagamento di una famiglia, e un omonimo produrrebbe una
 * fattura intestata a un estraneo — col suo codice fiscale e la sua residenza —
 * trasmessa all'Agenzia delle Entrate. L'unione è la stessa della cascata al
 * passo 2c: `student_parents` più il ponte runtime (`getGenitoriDiAlunno`).
 *
 * ─── FAIL-OPEN SULL'AIUTO, FAIL-CLOSED SUL DOCUMENTO ────────────────────────
 * Se una di queste letture fallisce non si propone niente e si logga, ma la
 * causale esce lo stesso: chi deve emettere non resta fermo perché un
 * suggerimento non è arrivato. Mai in silenzio, però (AGENTS.md, regola 6) —
 * senza la riga di log, «nessuna proposta» non si distingue da «nessun bonifico».
 *
 * ⚠️ Nella risposta viaggiano NOMI di adulti (è il senso di un selettore). Nei
 * log non ne entra nessuno: solo uuid, numeri e `esito` (AGENTS.md, regola 8).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  determinaQuoteFatturazione,
  identitaGenitoriDiAlunno,
  REG_COLS_CON_PONTE,
  intestatarioDefaultFamiglia,
  resolveParentRegistry,
  type ParentRegistry,
  type Quota,
} from '@/lib/pagamenti/intestatari'
import { validaCessionario, type ErroriCessionario } from '@/lib/fatturazione/cessionario'
import {
  riconosciOrdinante,
  type CandidatoGenitore,
  type MotivoAbbinamentoOrdinante,
} from '@/lib/pagamenti/ordinante-genitore'
import { alunnoDaPagamento, type AlunnoPerCausale, type PagamentoPerCausale } from './causale-pagamento'
import { logEvento } from '@/lib/logging/logger'

/** Un adulto proponibile come intestatario, col verdetto di fatturabilità. */
export interface CandidatoIntestatario {
  /** `parents.id`: lo stesso spazio di `alunni.intestatario_fatture.adult_id`. */
  adult_id: string
  nome: string
  /** `student_parents.relation_type`, quando c'è. Dal ponte runtime non arriva. */
  relazione: string | null
  fatturabile: boolean
  errori: ErroriCessionario
}

/** Una quota come si vede PRIMA di emettere: chi, quanto, e se si può fatturare. */
export interface QuotaAnteprima {
  /** `null` per un intestatario digitato (nessuna riga d'anagrafica dietro). */
  adult_id: string | null
  label: string
  importo: number
  nome: string
  fatturabile: boolean
  errori: ErroriCessionario
}

export interface IntestatarioAnteprima {
  /**
   * Il bambino di questo pagamento: serve a chi chiede «ricordo la scelta sulla
   * scheda di ⟨nome⟩?». Sta QUI e non accanto al blocco perché è parte della
   * stessa decisione — con due posti da cui leggerlo, domani due posti
   * direbbero chi è l'alunno e il dialogo dovrebbe metterli d'accordo.
   *
   * ⚠️ Il nome è un dato personale di un MINORE. Viaggia nella risposta (dove
   * sta già, dentro la causale) e non entra in nessun log.
   */
  alunno: { id: string; nome: string } | null
  quote: QuotaAnteprima[]
  /** Due o più quote: l'intestatario non si sceglie, si modificano le quote. */
  ripartito: boolean
  candidati: CandidatoIntestatario[]
  /** Chi propone il bonifico, e PERCHÉ. Mai una proposta muta. */
  proposta: { adult_id: string; motivo: MotivoAbbinamentoOrdinante } | null
  /** Il nome che la banca ha scritto come ordinante, se lo si è potuto leggere. */
  ordinante: string | null
}

/** La forma minima del pagamento che serve: quella che l'anteprima ha già in mano. */
export interface PagamentoPerIntestatario {
  id?: string
  importo?: number | string | null
  alunno_id?: string | null
  /** L'alunno annidato che `SELECT_PAGAMENTO_CAUSALE` porta già con sé. */
  alunni?: AlunnoPerCausale | AlunnoPerCausale[] | null
}

/**
 * Il blocco quando non c'è niente da dire — e quando qualcosa è andato storto.
 *
 * Esiste come costante perché il chiamante deve poterlo restituire senza
 * inventarsi una forma sua: un blocco assente e un blocco vuoto si distinguono
 * a schermo, un blocco improvvisato no.
 */
export const INTESTATARIO_ANTEPRIMA_VUOTO: IntestatarioAnteprima = {
  alunno: null,
  quote: [],
  ripartito: false,
  candidati: [],
  proposta: null,
  ordinante: null,
}

function s(v: unknown): string {
  return v == null ? '' : String(v)
}

function nomeIntero(reg: { first_name?: string | null; last_name?: string | null }): string {
  return [reg.first_name, reg.last_name].filter(Boolean).join(' ').trim()
}

function verdetto(a: Parameters<typeof validaCessionario>[0]): { fatturabile: boolean; errori: ErroriCessionario } {
  const errori = validaCessionario(a)
  return { fatturabile: Object.keys(errori).length === 0, errori }
}

interface AlunnoEconomico {
  id?: string | null
  cognome?: string | null
  genitori_separati?: boolean | null
  retta_split_config?: { quote?: { adult_id: string; importo: number | string; etichetta?: string | null }[] } | null
  intestatario_fatture?: { tipo?: string | null; adult_id?: string | null; dati?: unknown } | null
}

/**
 * I campi ECONOMICI del bambino: una lettura a parte, di proposito.
 *
 * La causale non ne ha bisogno, e tenerli fuori dalla sua `select` significa che
 * un guasto qui non può impedire all'anteprima di dire cosa uscirà scritto sul
 * documento. È lo stesso confine di `leggiResidenzaEstesa` in `emissione.ts`:
 * ciò che serve al documento sta sulla strada fail-closed, ciò che aiuta chi
 * opera degrada da solo — e lo dice.
 */
async function leggiAlunnoEconomico(
  supabase: SupabaseClient,
  alunnoId: string,
): Promise<AlunnoEconomico | null> {
  const { data, error } = await supabase
    .from('alunni')
    .select('id, cognome, genitori_separati, retta_split_config, intestatario_fatture')
    .eq('id', alunnoId)
    .maybeSingle()
  if (error) {
    // Niente `msg` accanto a un errore: il messaggio di PostgREST è già la
    // notizia (quale colonna o quale permesso manca). Il «cosa si perde» sta in
    // `esito`, che è in lista bianca e resta leggibile in tabella.
    logEvento('fattura', 'warn', {
      operazione: 'componiIntestatarioPagamento:alunno',
      esito: 'alunno-economico-non-letto',
    }, error)
    return null
  }
  return (data ?? null) as AlunnoEconomico | null
}

/** I genitori di QUEL bambino, come righe `parents`. Unione delle due sorgenti. */
async function leggiCandidati(
  supabase: SupabaseClient,
  alunnoId: string,
): Promise<{ candidati: CandidatoIntestatario[]; registri: Map<string, ParentRegistry> }> {
  const registri = new Map<string, ParentRegistry>()

  // ⚠️ UNA SOLA DEFINIZIONE DI «CHI SONO I GENITORI DI QUESTO BAMBINO», e questa
  // volta è vera: `parentIds` è l'insieme GIÀ RISOLTO nello spazio del registro,
  // ed è LO STESSO che l'emissione confronta in `adultoEGenitoreDi`.
  //
  // Il commento che stava qui prima prometteva la stessa cosa e non era vero:
  // l'emissione confrontava `parents.id` con un elenco che conteneva `utenti.id`,
  // quindi un genitore noto al solo ponte veniva PROPOSTO dall'anteprima e poi
  // RIFIUTATO con 422 — l'app offriva una scelta e dava la colpa a chi la
  // premeva. Le due mappe non si costruiscono più due volte: si legge questa.
  const { parentIds, completo, relazioni, registriDalPonte } = await identitaGenitoriDiAlunno(supabase, alunnoId)
  if (!completo) {
    logEvento('fattura', 'warn', {
      operazione: 'componiIntestatarioPagamento:candidati',
      esito: 'candidati-anagrafica-non-letti',
      // ⚠️ `alunno_id`, non `pagamento_id`: sotto una chiave che dice «pagamento»
      // c'era l'uuid di un ALUNNO, e chi interroga i log leggerebbe un fatto
      // sbagliato senza modo di accorgersene.
      alunno_id: alunnoId,
    })
  }

  // Le righe dei genitori noti dal SOLO ponte arrivano già lette da
  // `identitaGenitoriDiAlunno`, che le ha usate per costruire `parentIds`: qui
  // non si rilegge nulla, così le due mappe non possono divergere nemmeno per
  // una riga apparsa fra le due query.
  for (const p of registriDalPonte) if (p.id) registri.set(p.id, p)

  // Restano da leggere solo quelli che il ponte non ha già portato.
  const daLeggere = parentIds.filter((id) => !registri.has(id))
  if (daLeggere.length > 0) {
    const { data, error } = await supabase.from('parents').select(REG_COLS_CON_PONTE).in('id', daLeggere)
    if (error) {
      logEvento('fattura', 'warn', {
        operazione: 'componiIntestatarioPagamento:candidati',
        esito: 'candidati-registro-non-letto',
      }, error)
    }
    for (const p of (data ?? []) as ParentRegistry[]) registri.set(p.id, p)
  }

  const candidati = [...registri.values()].map((p) => ({
    adult_id: p.id,
    nome: nomeIntero(p),
    relazione: relazioni.get(p.id) ?? null,
    ...verdetto({
      codice_fiscale: p.fiscal_code,
      nome: p.first_name,
      cognome: p.last_name,
      indirizzo: p.residence_address,
      cap: p.zip_code,
      comune: p.residence_city,
    }),
  }))
  return { candidati, registri }
}

interface MovimentoOrdinante {
  controparte: string | null
  importo: number
  confermato_il: string | null
}

/**
 * Il nome che la banca ha scritto come ordinante di QUESTO pagamento.
 *
 * Più righe confermate sullo stesso pagamento (un saldo in due tranche): decide
 * quella di importo maggiore, a parità la più recente. Se le due maggiori
 * pareggiano su tutto e portano ordinanti diversi non si propone niente:
 * un'ambiguità non è un suggerimento, e qui il falso positivo costa una fattura
 * intestata a un estraneo.
 */
async function leggiOrdinante(supabase: SupabaseClient, pagamentoId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('riconciliazione_movimenti')
    .select('controparte, importo, confermato_il')
    .eq('pagamento_id', pagamentoId)
    .eq('stato', 'confermato')
  if (error) {
    // FAIL-OPEN, e detto: la causale e l'elenco dei candidati escono lo stesso,
    // manca solo la preselezione. Sul DB E2E della CI (non migrato) qui arriva un
    // `42703`, e questa riga è ciò che lo distingue da «non c'è nessun bonifico».
    logEvento('fattura', 'warn', {
      operazione: 'componiIntestatarioPagamento:ordinante',
      esito: 'ordinante-non-letto',
      pagamento_id: pagamentoId,
    }, error)
    return null
  }
  const righe = ((data ?? []) as MovimentoOrdinante[])
    .filter((r) => s(r.controparte).trim() !== '')
    .sort((a, b) => Number(b.importo) - Number(a.importo) || s(b.confermato_il).localeCompare(s(a.confermato_il)))
  if (righe.length === 0) return null

  const [primo, secondo] = righe
  const pareggio =
    secondo !== undefined &&
    Number(secondo.importo) === Number(primo.importo) &&
    s(secondo.confermato_il) === s(primo.confermato_il) &&
    s(secondo.controparte).trim() !== s(primo.controparte).trim()
  if (pareggio) return null

  return s(primo.controparte).trim()
}

/** Nome ed esito di fatturabilità di UNA quota. */
async function quotaAnteprima(
  supabase: SupabaseClient,
  q: Quota,
  registri: Map<string, ParentRegistry>,
): Promise<QuotaAnteprima> {
  if (q.anagrafica) {
    return {
      adult_id: null,
      label: q.label,
      importo: q.importo,
      nome: [q.anagrafica.nome, q.anagrafica.cognome].filter(Boolean).join(' ').trim(),
      ...verdetto(q.anagrafica),
    }
  }
  // La mappa dei candidati copre entrambi gli spazi di identità (`parents.id` e
  // `utenti.id` via `auth_user_id`): la quota esplicita di un genitore separato
  // arriva nello spazio degli account, l'eccezione per-figlio in quello del
  // registro. Solo se non è nessuno dei due si interroga il database.
  const perId = q.adultId ? registri.get(q.adultId) : undefined
  const perPonte = q.adultId
    ? [...registri.values()].find((p) => (p as { auth_user_id?: string | null }).auth_user_id === q.adultId)
    : undefined
  const reg = perId ?? perPonte ?? (await resolveParentRegistry(supabase, q.adultId))
  if (!reg) {
    return {
      adult_id: q.adultId,
      label: q.label,
      importo: q.importo,
      nome: '',
      fatturabile: false,
      errori: { codice_fiscale: 'mancante', nome: 'mancante', cognome: 'mancante' },
    }
  }
  return {
    // Normalizzato allo spazio del REGISTRO, così l'interfaccia può confrontarlo
    // con `candidati[].adult_id` senza sapere da quale sorgente venga la quota.
    adult_id: reg.id,
    label: q.label,
    importo: q.importo,
    nome: nomeIntero(reg),
    ...verdetto({
      codice_fiscale: reg.fiscal_code,
      nome: reg.first_name,
      cognome: reg.last_name,
      indirizzo: reg.residence_address,
      cap: reg.zip_code,
      comune: reg.residence_city,
    }),
  }
}

/**
 * Il blocco `intestatario` dell'anteprima: quote di oggi, candidati possibili e
 * — se il bonifico lo dice — una proposta col suo motivo.
 */
export async function componiIntestatarioPagamento(
  supabase: SupabaseClient,
  pag: PagamentoPerIntestatario,
): Promise<IntestatarioAnteprima> {
  const alunnoId = s(pag.alunno_id)
  const pagamentoId = s(pag.id)
  if (!alunnoId || !pagamentoId) return INTESTATARIO_ANTEPRIMA_VUOTO

  // Il nome NON si rilegge: sta già nella riga che l'anteprima ha in mano
  // (`alunnoDaPagamento`), e una seconda lettura potrebbe dire un nome diverso
  // da quello che è finito nella causale dello stesso documento.
  //
  // Serve al modale per due cose sole: scrivere il nome nella casella «ricorda
  // questo intestatario sulla scheda di ⟨bambino⟩», e sapere QUALE scheda
  // aggiornare dopo — e solo dopo — un'emissione riuscita. Una SECONDA fonte per
  // l'identità del bambino è il difetto del 2026-09-02: l'area 0-6 cercava per
  // NOME ciò che era legato per uuid, e rispondeva 200 con l'elenco vuoto.
  // Qui la fonte è una sola, ed è la stessa da cui esce la causale.
  const bimbo = alunnoDaPagamento(pag as unknown as PagamentoPerCausale)
  const nomeBimbo = [bimbo?.nome, bimbo?.cognome].filter(Boolean).join(' ').trim()

  const alunno = await leggiAlunnoEconomico(supabase, alunnoId)
  const { candidati, registri } = await leggiCandidati(supabase, alunnoId)

  const quote = await determinaQuoteFatturazione(
    supabase,
    { id: pagamentoId, importo: Number(pag.importo) },
    {
      id: alunnoId,
      genitori_separati: alunno?.genitori_separati,
      retta_split_config: alunno?.retta_split_config,
      intestatario_fatture: alunno?.intestatario_fatture,
    },
  )

  const ordinante = await leggiOrdinante(supabase, pagamentoId)

  // Le DUE fonti della cascata, nello stesso ordine: qui non nasce una terza
  // nozione di «chi è l'intestatario». `'altro'` non porta un `adult_id`, e un
  // `adult_id` che non c'è non deve fingere di esserci.
  const intestatarioScheda =
    alunno?.intestatario_fatture?.tipo === 'altro' ? null : alunno?.intestatario_fatture?.adult_id ?? null
  const intestatarioFamiglia = await intestatarioDefaultFamiglia(supabase, alunnoId)

  const perRiconoscimento: CandidatoGenitore[] = candidati.map((c) => ({ adultId: c.adult_id, nome: c.nome }))
  const esito = riconosciOrdinante(ordinante, perRiconoscimento, { intestatarioScheda, intestatarioFamiglia })

  let proposta: IntestatarioAnteprima['proposta'] = null
  if (esito.tipo === 'unico') {
    // ⚠️ NESSUN `?? candidati[0]`. Un ripiego sul primo elemento intesterebbe la
    // fattura alla persona sbagliata in SILENZIO: se l'id non si risolve è un
    // guasto da dire, non da tappare.
    const scelto = candidati.find((c) => c.adult_id === esito.adultId)
    if (scelto) {
      proposta = { adult_id: scelto.adult_id, motivo: esito.motivo }
      // IL BATTITO (AGENTS.md, regola 5). Il MECCANISMO sta dentro `esito` e non
      // in un campo `motivo`: `motivo` non è nella lista bianca di `redact` e non
      // ce lo si aggiunge «perché sarebbe comodo vederlo», mentre `esito` resta
      // in chiaro in tabella e si interroga con un `like 'proposta-%'`. Senza
      // questa riga, al primo import dell'estratto conto non si potrebbe contare
      // quanti abbinamenti esatti contro quanti per sottoinsieme — cioè quanto
      // vale davvero l'aiuto — se non leggendo i nomi, che qui non entrano.
      logEvento('fattura', 'info', {
        operazione: 'componiIntestatarioPagamento:proposta',
        esito: `proposta-${esito.motivo}`,
        pagamento_id: pagamentoId,
        // Quanti adulti c'erano fra cui scegliere: un numero, non un elenco.
        candidati: candidati.length,
      })
    } else {
      logEvento('fattura', 'warn', {
        operazione: 'componiIntestatarioPagamento:proposta',
        esito: 'proposta-non-risolta',
        pagamento_id: pagamentoId,
        msg: 'l’adulto proposto non è fra i candidati letti: nessuna proposta invece di quella sbagliata',
      })
    }
  }

  return {
    alunno: bimbo?.id ? { id: bimbo.id, nome: nomeBimbo } : null,
    quote: await Promise.all(quote.map((q) => quotaAnteprima(supabase, q, registri))),
    ripartito: quote.length > 1,
    candidati,
    proposta,
    ordinante,
  }
}
