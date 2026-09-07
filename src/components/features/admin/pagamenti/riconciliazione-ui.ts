/**
 * Modello e pelle della lista a semaforo della Riconciliazione bancaria (v2).
 *
 * Qui vivono i TIPI lato client dei movimenti/suggerimenti, la logica PURA che
 * decide il badge «CF» e la condizione «multi-CF» (aggancio «Incasso unico» che
 * l'esecutore UI-2 collega), e la mappa a semaforo con SFONDI PIENI per stato.
 *
 * Perché sfondi pieni e MAI opacità Tailwind (`/80`, `white/70`): su un fondo
 * colorato l'opacità abbassa il contrasto sotto AA (lezione a11y del ciclo
 * precedente → varianti PIENE). I colori sono token brand, non hex: `@theme
 * inline` li rimappa in Alto Contrasto. L'unico caso che il rimappaggio non
 * copre è il giallo (in HC diventa near-white e il testo chiaro sparirebbe):
 * l'override sta in `globals.css` agganciato a `hcClass`.
 *
 * ⚠️ LA POLITICA DI FATTURAZIONE NON È PIÙ QUI: sta in
 * `@/lib/pagamenti/fatturazione-riga`, perché la legge anche la ROTTA del
 * registro e una rotta non deve importare da `src/components` (la frontiera RSC
 * la prova solo `next build`). Qui resta il CHIP — pelle, etichette, forma — che
 * è roba da schermo. Lock:
 * `__tests__/architecture/fatturazione-riconciliazione-un-motore-solo.test.ts`.
 */
import { formatEuro } from '@/lib/format/valuta'
import { esitoFatturazione, type RigaFatturabile, type TonoFatturazione } from '@/lib/pagamenti/fatturazione-riga'

/**
 * I tipi della politica si rileggono da qui perché questo modulo è il barile
 * della schermata (`MovimentoDialog`, `RiconciliazionePanel`): la DEFINIZIONE
 * però è una sola, e sta nella lib. Un ri-export non è una seconda copia.
 */
export type {
  EsitoFatturazione,
  FatturaMovimentoUi,
  FonteFatturazione,
  RigaFatturabile,
  StatoFattura,
  TonoFatturazione,
} from '@/lib/pagamenti/fatturazione-riga'

export type StatoMovimento = 'da_abbinare' | 'suggerito' | 'confermato' | 'ignorato'

/** Un candidato all'abbinamento calcolato dal server (`lib/pagamenti/riconciliazione.ts`). */
export interface SuggerimentoUi {
  pagamento_id: string
  score: number
  motivi: string[]
  label?: string | null
  /** True se agganciato per codice fiscale (aggancio dominante, ordina primo). */
  cf_match?: boolean
  /** Alunno del pagamento: serve a raggruppare i CF per l'«Incasso unico». */
  alunno_id?: string | null
}

/**
 * Una riga del registro movimenti (GET /api/pagamenti/riconciliazione).
 *
 * ESTENDE `RigaFatturabile`, e non è un dettaglio di stile: i quattro campi che
 * decidono lo stato della fattura sono dichiarati nel motore
 * (`@/lib/pagamenti/fatturazione-riga`), così la riga della lista e la riga che
 * il motore legge non possono divergere senza che `tsc` lo dica. Il perché di
 * ciascuno dei quattro è scritto lì accanto alla sua dichiarazione.
 */
export interface MovimentoUi extends RigaFatturabile {
  id: string
  import_id?: string | null
  scuola_id?: string | null
  data_operazione: string
  importo: number
  causale?: string | null
  controparte?: string | null
  stato: StatoMovimento
  suggerimenti?: SuggerimentoUi[] | null
  confermato_il?: string | null
  /**
   * «Questo bonifico sembra di un'altra sede»: l'aggancio forte sta fuori dai
   * plessi di chi guarda, e i candidati qui sotto sono deboli. `null` = no (o non
   * si è potuto guardare). Lo calcola il server, dove la sede è FRESCA: portarla
   * dentro `SuggerimentoUi` la congelerebbe nel JSONB all'import — una fotografia
   * che invecchia — e non funzionerebbe sulle righe già in registro.
   */
  altra_sede?: AltraSedeUi | null
}

/**
 * Il verdetto «altra sede» come arriva dal GET: il NOME del plesso, mai il suo uuid.
 *
 * ⚠️ Un campo solo, e `per_cf` NON c'è più (tolto il 2026-09-07, il giorno dopo
 * esserci entrato): la schermata dice la stessa cosa sia che a parlare sia un
 * codice fiscale sia che sia un punteggio, perché all'operatore serve sapere *che*
 * l'aggancio è altrove. Un campo che viaggia nel JSON e non legge nessuno non è
 * un'informazione in più: è decorazione da mantenere.
 */
export interface AltraSedeUi {
  /** `null` = la sede c'è ma il suo nome non è stato letto: si dice senza nominarla. */
  nome: string | null
}

/**
 * La risposta del GET del registro — e i tre campi che raccontano ciò che il
 * server NON ha potuto fare.
 *
 * `data` da sola non basta a leggere una risposta: un elenco vuoto può voler dire
 * «filtrato, e non c'è niente» oppure «non ho potuto filtrare». Fino al 2026-09-05
 * le due cose arrivavano identiche, e a schermo diventavano la stessa frase —
 * «Nessun movimento in questo stato», cioè «non c'è niente da fatturare» detto
 * dalla schermata che esiste per non far saltare una fattura.
 */
export interface RispostaMovimenti {
  success?: boolean
  data?: MovimentoUi[]
  /** `false` = la tabella del registro non esiste ancora su questo database. */
  disponibile?: boolean
  /**
   * `false` = lo stato di fatturazione non è stato letto (query batch caduta): le
   * righe arrivano NON filtrate, e la schermata deve dirlo invece di mostrarle
   * come se il filtro avesse lavorato. Assente ⇒ disponibile.
   */
  fatturazione_disponibile?: boolean
  /** `true` = la finestra del server era piena: ci sono altre righe oltre a queste. */
  troncato?: boolean
  /**
   * I due numeri delle pillole, quando li si è chiesti (`?conteggi=1`).
   *
   * `null` NON è «zero»: è «non ho potuto contare» — la lettura dello stato di
   * fatturazione è caduta, e in quel caso il server risponde anche
   * `fatturazione_disponibile: false`. Assente ⇒ non sono stati chiesti.
   */
  conteggi?: ConteggiFattura | null
  /** Il corpo del rifiuto, quando `success` non è `true` (`{ error, codice }`). */
  error?: unknown
  codice?: unknown
}

/** Un pagamento aperto (fonte della ricerca manuale): GET /api/pagamenti?solo_aperti=true. */
export interface PagamentoApertoUi {
  id: string
  descrizione?: string | null
  importo: number
  importo_pagato: number
  tipo: string
  alunni?: { nome?: string | null; cognome?: string | null } | null
}

/** Esito di un import CSV (POST /api/pagamenti/riconciliazione). */
export interface EsitoImport {
  nuovi: number
  duplicati: number
  scartate: number
  suggeriti: number
  con_cf?: number
  da_abbinare: number
  /** Addebiti: righe capite benissimo e non importabili per progetto. */
  uscite?: number
  /** Righe oltre il tetto del lettore: NON sono state lette. */
  troncate?: number
  /** Movimenti senza ordinante: il campanello che suona se la banca cambia formato. */
  senza_ordinante?: number
}

/** Il PRIMO suggerimento è un aggancio per CF? → badge «CF» sulla riga. */
export function suggerimentoPrincipaleCf(sugg?: SuggerimentoUi[] | null): boolean {
  return Boolean(sugg && sugg.length > 0 && sugg[0]?.cf_match)
}

/** «n parola» con singolare/plurale scelto sul conteggio (0 e >1 → plurale). */
const plurale = (n: number, uno: string, molti: string): string => `${n} ${n === 1 ? uno : molti}`

/**
 * Testo del toast di riepilogo import, con singolare/plurale corretti (E2):
 * «1 nuovo movimento (1 con suggerimento) · 1 già visto · 1 riga scartata».
 * Il dettaglio «per codice fiscale» compare solo se `con_cf > 0`.
 *
 * ─── I DUE PEZZI IN CODA, E PERCHÉ NON SONO LA STESSA COSA ──────────────────
 * Le USCITE sono addebiti: righe capite benissimo e non importabili per progetto. Sul file
 * annuale vero sono 2.225, e finché finivano dentro «scartate» l'operatore leggeva «2.225
 * righe scartate» su un import perfettamente riuscito — cioè un allarme su un esito
 * corretto, che è il modo più rapido di insegnare a qualcuno a non leggere più il toast.
 * Si dicono, ma solo quando ci sono, e con la parola giusta: **ignorate**, non scartate.
 *
 * Le TRONCATE sono l'opposto: righe che il lettore non ha nemmeno guardato, perché oltre il
 * suo tetto. Sono una PERDITA, e il vecchio troncamento era silenzioso. Vanno in evidenza.
 */
export function riepilogoImport(e: EsitoImport): string {
  const cf = e.con_cf ? `, ${e.con_cf} per codice fiscale` : ''
  const suggeriti = `${plurale(e.suggeriti, 'con suggerimento', 'con suggerimenti')}${cf}`
  const uscite = e.uscite ? ` · ${plurale(e.uscite, 'uscita ignorata', 'uscite ignorate')}` : ''
  const troncate = e.troncate
    ? ` · ⚠️ ${plurale(e.troncate, 'riga NON letta', 'righe NON lette')} (limite)`
    : ''
  return (
    `${plurale(e.nuovi, 'nuovo movimento', 'nuovi movimenti')} (${suggeriti})` +
    ` · ${plurale(e.duplicati, 'già visto', 'già visti')}` +
    ` · ${plurale(e.scartate, 'riga scartata', 'righe scartate')}` +
    uscite +
    troncate
  )
}

/**
 * «Multi-CF»: ≥2 suggerimenti agganciati per CF (`cf_match:true`) con `alunno_id`
 * DISTINTI. È la condizione per proporre l'«Incasso unico» di famiglia (un solo
 * bonifico che salda più figli). Qui si calcola soltanto: l'aggancio del bottone
 * lo implementa l'esecutore UI-2 tramite la prop `onIncassoUnico`.
 */
export function movimentoMultiCf(sugg?: SuggerimentoUi[] | null): boolean {
  if (!sugg) return false
  const alunni = new Set<string>()
  for (const s of sugg) if (s.cf_match && s.alunno_id) alunni.add(s.alunno_id)
  return alunni.size >= 2
}

const nomeAlunno = (p: PagamentoApertoUi) =>
  [p.alunni?.nome, p.alunni?.cognome].filter(Boolean).join(' ').trim()

const residuoAperto = (p: PagamentoApertoUi) =>
  Math.max(0, Number(p.importo) - Number(p.importo_pagato || 0))

/** Etichetta leggibile del pagamento aperto (ricerca manuale + suggerimenti senza label). */
export function labelPagamentoAperto(p: PagamentoApertoUi): string {
  const nome = nomeAlunno(p) || '—'
  const desc = p.descrizione || '—'
  return `${nome} · ${desc} (residuo ${formatEuro(residuoAperto(p))})`
}

/** Testo minuscolo su cui filtra la ricerca manuale (nome alunno + descrizione). */
export function testoRicercaPagamento(p: PagamentoApertoUi): string {
  return `${nomeAlunno(p)} ${p.descrizione ?? ''}`.toLowerCase()
}

/**
 * Pelle a semaforo per stato. `bg`/`testo`/`sub` sono token PIENI, verificati AA
 * in luce normale; `hcClass` è la classe-àncora dell'override Alto Contrasto in
 * `globals.css` (unlayered → vince sulle utility Tailwind).
 *
 * Contrasti (luce normale):
 *  · confermato  green        + white → 6,4:1
 *  · suggerito   yellow       + ink   → 7,3:1
 *  · da abbinare error-strong + white → 5,6:1
 *  · ignorato    neutral-soft + ink   → 10,4:1  (sub → 8,9:1)
 */
export const SEMAFORO: Record<StatoMovimento, {
  label: string
  hcClass: string
  bg: string
  testo: string
  sub: string
}> = {
  confermato: { label: 'Confermato', hcClass: 'kv-recon-row--confermato', bg: 'bg-kidville-green', testo: 'text-kidville-white', sub: 'text-kidville-white' },
  suggerito: { label: 'Suggerito', hcClass: 'kv-recon-row--suggerito', bg: 'bg-kidville-yellow', testo: 'text-kidville-ink', sub: 'text-kidville-ink' },
  da_abbinare: { label: 'Da abbinare', hcClass: 'kv-recon-row--da_abbinare', bg: 'bg-kidville-error-strong', testo: 'text-kidville-white', sub: 'text-kidville-white' },
  ignorato: { label: 'Ignorato', hcClass: 'kv-recon-row--ignorato', bg: 'bg-kidville-neutral-soft', testo: 'text-kidville-ink', sub: 'text-kidville-sub' },
}

/** Filtri per stato del registro (id vuoto = tutti). Passati al GET come `?stato=`. */
export const FILTRI: { id: '' | StatoMovimento; label: string }[] = [
  { id: '', label: 'Tutti' },
  { id: 'da_abbinare', label: 'Da abbinare' },
  { id: 'suggerito', label: 'Suggeriti' },
  { id: 'confermato', label: 'Confermati' },
  { id: 'ignorato', label: 'Ignorati' },
]

// ─── FATTURAZIONE: UN CHIP SULLA RIGA VERDE, NON UN QUINTO STATO ─────────────
//
// Il registro ha quattro stati e soli quattro (`CHECK` sul DB): la riga diventa
// verde alla conferma e resta identica per sempre, anche dopo l'emissione — che
// scrive su `pagamenti.fattura_stato` e mai sul movimento. Su centinaia di righe
// verdi indistinguibili nessuno può dire quali restano da fatturare, e SALTARE
// una fattura non lo ferma nessuno (fatturare due volte sì: c'è la guardia di
// idempotenza dell'emissione). Il dato è DERIVATO e derivato resta.

/**
 * Pelle del chip. Fondi PIENI, mai opacità: il chip vive sopra il fondo VERDE
 * della riga confermata, e `bg-kidville-white/70` su verde scende sotto AA (la
 * lezione già pagata dal semaforo). `hcClass` è l'àncora dell'override Alto
 * Contrasto in `globals.css`: `@theme inline` INLINA l'hex nelle utility, quindi
 * ridefinire i token sotto `[data-contrast="high"]` non ribalta nessuna classe —
 * la superficie si dipinge a mano, fuori da ogni `@layer`.
 *
 * Contrasti MISURATI (luce normale, WCAG 2.x §1.4.3):
 *  · fatturata    white + green        → 6,51:1
 *  · attesa       white + warn-strong  → 5,61:1
 *  · scartata     white + error-strong → 5,62:1
 *  · da_fatturare yellow + ink         → 7,33:1
 */
export const CHIP_FATTURAZIONE: Record<TonoFatturazione, {
  labelKey: string
  hcClass: string
  bg: string
  testo: string
}> = {
  fatturata: { labelKey: 'reconChipFatturata', hcClass: 'kv-recon-chip--fatturata', bg: 'bg-kidville-white', testo: 'text-kidville-green' },
  attesa: { labelKey: 'reconChipAttesaSdi', hcClass: 'kv-recon-chip--attesa', bg: 'bg-kidville-white', testo: 'text-kidville-warn-strong' },
  scartata: { labelKey: 'reconChipScartata', hcClass: 'kv-recon-chip--scartata', bg: 'bg-kidville-white', testo: 'text-kidville-error-strong' },
  da_fatturare: { labelKey: 'reconChipDaFatturare', hcClass: 'kv-recon-chip--da-fatturare', bg: 'bg-kidville-yellow', testo: 'text-kidville-ink' },
}

/**
 * La forma del chip, in un posto solo — riga della lista E popup del movimento.
 *
 * Fino al 2026-09-05 lo stesso dato aveva DUE facce: sulla riga «Fatturata» era
 * carta bianca con inchiostro verde e un glifo, dentro il popup era un `Badge`
 * generico (oliva su verde tenue, senza glifo), e «Da fatturare» — l'unico chip
 * che chiede di agire — passava dal giallo pieno al grigio. Due vestiti per lo
 * stesso stato, nella stessa schermata, a due centimetri di distanza.
 *
 * `suCarta` è l'unica differenza ammessa, ed è una differenza di FORMA, mai di
 * pelle: fondo, inchiostro e àncora HC restano identici, perché sono il dato.
 *
 *  · sulla RIGA è una PILLOLA: sta accanto all'etichetta di stato, sopra un fondo
 *    pieno che lo stacca da sé, e lì non c'è nessun comando con cui confondersi;
 *  · sulla CARTA del popup è un'ETICHETTA — angoli quadri, padding stretto, più
 *    il filetto `border-current` (l'inchiostro del tono stesso) senza cui il chip
 *    «Fatturata», che ha fondo bianco, sparirebbe dentro la card.
 *
 * La forma quadra non è un gusto: nel riquadro «Documenti» il chip conviveva con
 * «Ricevuta» e «Invia fattura» — stessa pillola, stesso filetto, stessa altezza —
 * ed era il terzo di tre oggetti identici, l'unico che non si preme. La differenza
 * di geometria è ciò che lo dice anche a chi il colore non lo separa.
 */
export function classiChipFatturazione(
  pelle: Pick<(typeof CHIP_FATTURAZIONE)[TonoFatturazione], 'bg' | 'testo' | 'hcClass'>,
  suCarta = false,
): string {
  return [
    // `kv-recon-chip` è l'àncora dell'override Alto Contrasto in globals.css.
    'kv-recon-chip inline-flex items-center gap-1.5',
    suCarta ? 'rounded-md border-[1.5px] border-current px-2 py-1' : 'rounded-pill px-3 py-1.5',
    'font-barlow text-[11px] font-extrabold uppercase leading-none tracking-[0.03em]',
    pelle.bg,
    pelle.testo,
    pelle.hcClass,
  ].filter(Boolean).join(' ')
}

// ─── «ALTRA SEDE»: UN CHIP DI TESTO, E NON UN QUINTO TONO ────────────────────
//
// ⚠️ NON ENTRA IN `CHIP_FATTURAZIONE`, e non è una questione di ordine. Un quinto
// tono farebbe cadere in cascata `TonoFatturazione`, il `Record` TOTALE
// `FRASE_FATTURAZIONE` e i 75 casi del prodotto cartesiano dei test — ma il
// motivo vero è che direbbe una cosa falsa: «sembra di un'altra sede» non è uno
// stato della fattura, è un'altra domanda, posta su un altro asse.
//
// ⚠️ MAI GIALLO NÉ ROSSO. In questa schermata quei due colori sono riservati a ciò
// che chiede un'azione a CHI GUARDA — le regole di Alto Contrasto in `globals.css`
// lo dicono per esteso sui chip «Da fatturare» e «Scartata». Qui l'azione non c'è:
// il bonifico si abbina dalla sede dell'aggancio, non da questa schermata. Carta
// bianca e inchiostro, come i due chip che informano e basta.
//
// ⚠️ NESSUNA RIGA NUOVA IN `globals.css`: l'àncora `kv-recon-chip` esiste già e
// porta con sé tutto l'Alto Contrasto (carta bianca, inchiostro nero, contorno) —
// ed è anche ciò che salva l'inchiostro dal `:not(.kv-recon-chip)` con cui la riga
// schiarisce i propri discendenti. Il foglio è condiviso con altri lavori.

/** Pelle del chip «altra sede»: le stesse due leve degli altri chip, senza glifo. */
export const CHIP_ALTRA_SEDE = {
  labelKey: 'reconChipAltraSede',
  bg: 'bg-kidville-white',
  testo: 'text-kidville-ink',
} as const

/**
 * Le classi del chip «altra sede». UNA SOLA VARIANTE: la pillola della riga.
 *
 * Passa dallo STESSO vestito dei chip di fatturazione: geometria, carattere e
 * pillola non sono ricopiati qui, così non possono divergere. Cambia solo la
 * pelle, che è il dato. `hcClass` è vuota di proposito — non serve nessuna
 * eccezione all'Alto Contrasto: la regola comune di `.kv-recon-chip` è già quella
 * giusta per un chip di carta bianca che non chiede niente.
 *
 * ⚠️ NIENTE PARAMETRO `suCarta`, e non è una svista. C'era, valeva `true` per la
 * «carta del popup», e nel popup un chip non c'è: là il verdetto è una `<section>`
 * di testo, perché la cosa da dire è una frase, non un'etichetta. Quel ramo non
 * era chiamato da nessun punto di `src/` — lo teneva vivo il solo test, che lo
 * asseriva in tre punti: una variante che nessuno rende e che, al primo cambio di
 * geometria dei chip di fatturazione, andava riallineata senza che niente a
 * schermo la mostrasse. Se un giorno il popup vorrà il chip, si rimette il
 * parametro INSIEME al punto che lo monta.
 */
export function classiChipAltraSede(): string {
  return classiChipFatturazione({ bg: CHIP_ALTRA_SEDE.bg, testo: CHIP_ALTRA_SEDE.testo, hcClass: '' })
}

/**
 * La FRASE che accompagna il chip nel popup: una per tono, nessuna condivisa.
 *
 * Il popup scriveva «Fattura già emessa per questo pagamento» anche su una
 * fattura «in attesa SDI» — che è falso: il documento è partito, la risposta non
 * è arrivata, e può ancora tornare indietro scartato. E su «scartata», l'unico
 * stato in cui qualcuno DEVE rifare il lavoro, non diceva niente: un chip rosso e
 * nessuna istruzione. Un `Record` totale sui quattro toni, così un tono nuovo non
 * può nascere muto né ereditare per sbaglio la frase di un altro.
 */
export const FRASE_FATTURAZIONE: Record<TonoFatturazione, string> = {
  fatturata: 'movdlgFatturaGiaEmessa',
  attesa: 'movdlgFatturaInAttesa',
  scartata: 'movdlgFatturaScartata',
  da_fatturare: 'movdlgFatturaDaEmettere',
}

/** Il risultato di `chipFatturazione`: la pelle del tono, più cosa scriverci dentro. */
export interface ChipFatturazioneUi {
  labelKey: string
  /** Valori per `t(labelKey, params)`: c'è solo quando l'etichetta ha un segnaposto. */
  params?: Record<string, string | number>
  tono: TonoFatturazione
  hcClass: string
  bg: string
  testo: string
}

/**
 * Il chip di fatturazione di una riga, o `null` se non se ne mostra nessuno.
 *
 * ─── DUE FONTI, E UN ORDINE CHE NON È ARBITRARIO (2026-09-05, fusione) ──────
 *
 * Lo stesso fatto arriva da due parti, e non sono un doppione:
 *  · `fattura` viene da `fatture_emesse` — i DOCUMENTI davvero registrati, quota
 *    per quota, col loro numero;
 *  · `fattura_stato` viene da `pagamenti` — il riassunto che l'emissione scrive
 *    sul pagamento, una riga sola e senza numeri.
 *
 * Quando la prima ha qualcosa di POSITIVO da dire (un documento c'è, oppure ce
 * n'era uno e lo SdI l'ha respinto) vince lei, perché è la fonte e perché porta
 * il numero: «Fattura FPR 1947/26» dice all'operatore quale documento cercare,
 * «Fatturata» no. Un `fattura_stato` fermo a `emessa` su un documento poi
 * scartato direbbe «fatto» di un lavoro da rifare.
 *
 * Ciò che la prima NON dimostra è l'assenza: `da_fatturare` lì significa solo
 * «nessuna riga in `fatture_emesse`», e da sola non basta a chiedere di agire —
 * per quello serve sapere che il pagamento è SALDATO, e quel dato sta sull'altra
 * fonte. Quindi il ramo `da_fatturare` ricade sulla tabella di verità del motore
 * (`esitoFatturazione` in `@/lib/pagamenti/fatturazione-riga`), che pretende due
 * campi.
 *
 * ⚠️ QUI NON SI DECIDE NIENTE: il verdetto arriva dal motore, e questa funzione
 * sceglie soltanto che cosa scriverci dentro. Una scala di ripiego ricopiata qui
 * è la divergenza che è già costata una riga in due bidoni opposti. Lock:
 * `__tests__/architecture/fatturazione-riconciliazione-un-motore-solo.test.ts`.
 *
 * ⚠️ «Da fatturare» è l'unico caso che pretende DUE campi: `non_richiesta` su un
 * pagamento non ancora saldato non è un invito ad agire, è rumore su una riga che
 * non si può fatturare — l'emissione la rifiuterebbe.
 *
 * `fattura_stato`/`pagamento_stato` il server li valorizza esclusivamente sui
 * movimenti confermati di una sede dell'operatore (stessa minimizzazione delle
 * label dei suggerimenti), quindi su una riga suggerita/ignorata arrivano `null`
 * e il chip non nasce — senza duplicare qui la regola di visibilità del server.
 * Su `fattura` quella regola non c'è, e la fa `pagamento_id`: senza abbinamento
 * non esiste nessun pagamento da fatturare, e un documento su una riga non
 * abbinata sarebbe comunque roba d'altri.
 */
export function chipFatturazione(m: RigaFatturabile): ChipFatturazioneUi | null {
  const esito = esitoFatturazione(m)
  if (!esito) return null
  // La FONTE non è un dettaglio da buttare: le due etichette che nominano il
  // DOCUMENTO — il suo numero, e «da riemettere» — si possono dire solo quando a
  // parlare sono i documenti. Dal riassunto escono le etichette secche.
  if (esito.fonte === 'documenti' && esito.tono === 'fatturata') {
    // Senza numeri leggibili si ripiega sull'etichetta secca: «Fattura » con il
    // segnaposto vuoto sarebbe una frase troncata a metà.
    return esito.numeri.length === 0
      ? { tono: 'fatturata', ...CHIP_FATTURAZIONE.fatturata }
      : { tono: 'fatturata', ...CHIP_FATTURAZIONE.fatturata, labelKey: 'reconFatturaEmessa', params: { n: esito.numeri.length, numeri: esito.numeri.join(' · ') } }
  }
  // «Scartata, da riemettere», non la sola parola «Scartata»: è l'unico stato in
  // cui qualcuno DEVE rifare il lavoro, e l'etichetta lo dice invece di lasciarlo
  // dedurre dal colore.
  if (esito.fonte === 'documenti' && esito.tono === 'scartata') {
    return { tono: 'scartata', ...CHIP_FATTURAZIONE.scartata, labelKey: 'reconFatturaScartata' }
  }
  return { tono: esito.tono, ...CHIP_FATTURAZIONE[esito.tono] }
}

/**
 * Sottofiltro «Fatturazione», componibile col filtro per stato: passato al GET
 * come `?fattura=`. I due tagli utili sono asimmetrici per progetto — «da
 * fatturare» è la lista di lavoro, «fatturate» è la verifica — e implicano
 * entrambi i CONFERMATI, gli unici su cui la fatturazione esista.
 *
 * ⚠️ DUE BIDONI, QUATTRO CHIP: L'ETICHETTA LI DEVE NOMINARE TUTTI.
 *
 * I chip delle righe dicono quattro parole (Da fatturare · Fatturata · In attesa
 * SDI · Scartata), i tagli del server sono due e li aggregano a coppie:
 * `da_fatturare` comprende le SCARTATE (una fattura respinta va rifatta) e
 * `fatturate` comprende le IN ATTESA (il documento è partito, la risposta no).
 * Finché le etichette dicevano solo «Da fatturare» e «Fatturate», premere la prima
 * restituiva una riga col chip «SCARTATA»: un filtro che risponde una parola
 * diversa da quella chiesta si legge come rotto, anche quando ha ragione.
 *
 * Gli `id` NON si allargano senza toccare la rotta: `?fattura=` è validato da
 * `z.enum(['da_fatturare','fatturate'])` in `api/pagamenti/riconciliazione`, e un
 * valore in più tornerebbe 400 — cioè un filtro che non filtra. Si allarga
 * l'etichetta, che è ciò che mancava: dice per intero cosa c'è nel suo bidone.
 * Lock: `__tests__/pagamenti/riconciliazione-ui.test.ts`.
 */
export const FILTRI_FATTURA: { id: '' | 'da_fatturare' | 'fatturate'; labelKey: string }[] = [
  { id: '', labelKey: 'reconFiltroTutte' },
  { id: 'da_fatturare', labelKey: 'reconFiltroDaFatturare' },
  { id: 'fatturate', labelKey: 'reconFiltroFatturate' },
]

/**
 * I DUE NUMERI DELLE PILLOLE, come li manda il server (`?conteggi=1`).
 *
 * ⚠️ `parziale` non è un dettaglio di presentazione: dice che la finestra del
 * server era PIENA, cioè che i due numeri sono un MINIMO. Senza, la schermata
 * scriverebbe «12» dove il vero è «almeno 12» — e su questa schermata un totale
 * finto è peggio di nessun totale, perché una fattura saltata non la ferma
 * nessuna guardia.
 *
 * ⚠️ E i due numeri NON sono parti di uno stesso totale, per quanto accostati lo
 * sembrino: «Da fatturare» pretende `pagamento_stato === 'pagato'`, che fuori
 * dalle proprie sedi è `null`, quindi è la lista di lavoro della PROPRIA sede;
 * «Fatturate» guarda i DOCUMENTI ed è cross-sede. È voluto (la prima è una lista
 * di cose da fare, la seconda un controllo) ed è dichiarato nell'etichetta
 * accessibile del gruppo di pillole.
 */
export interface ConteggiFattura {
  da_fatturare: number
  fatturate: number
  /** `true` = la finestra del server era piena: i due numeri sono un minimo. */
  parziale: boolean
}

/**
 * Il numero da scrivere su UNA pillola, o `null` se non se ne scrive nessuno.
 *
 * ⚠️ «TUTTE» NON PORTA NUMERO, e non è una dimenticanza. Quella pillola non è un
 * terzo bidone: è l'ASSENZA del filtro. Un numero lì conterebbe la finestra
 * corrente — che cambia col filtro di STATO, e che non è la somma dei due bidoni
 * (le righe senza chip non stanno in nessuno dei due) — cioè risponderebbe a una
 * domanda diversa da quella che sembra.
 *
 * ⚠️ `conteggi === null` → `null`, MAI `0`. Uno zero è un'affermazione («non ne
 * resta nessuna da fare») e lì non la sappiamo: un numero non letto è un numero
 * inventato. Uno zero LETTO invece si scrive — è l'informazione più bella che
 * questa schermata possa dare — ed è per questo che i due casi non si possono
 * confondere in un falsy.
 */
export function numeroPillolaFattura(
  id: (typeof FILTRI_FATTURA)[number]['id'],
  conteggi: ConteggiFattura | null | undefined,
): number | null {
  if (!conteggi) return null
  if (id === 'da_fatturare') return conteggi.da_fatturare
  if (id === 'fatturate') return conteggi.fatturate
  return null
}

/**
 * Il numero come si legge sulla pillola: «12», oppure «≥ 12» quando è un minimo.
 *
 * Il segno c'è o non c'è, e non esiste una terza forma: è l'unica cosa che
 * distingue un totale da una finestra piena, e deve restare leggibile in una
 * pillola larga tre caratteri.
 */
export function etichettaConteggio(n: number, parziale: boolean): string {
  return parziale ? `≥ ${n}` : String(n)
}
