/**
 * Dire quale genitore ha fatto il bonifico — o dire che non si sa.
 *
 * ─── PERCHÉ L'INSIEME DI RICERCA È PICCOLISSIMO ─────────────────────────────
 * Il chiamante passa i candidati GIÀ ristretti: i genitori di QUEL bambino, non
 * i 735 adulti dell'archivio. Questo modulo non interroga niente e non sa da
 * dove arrivino.
 *
 * La ragione è il costo asimmetrico dello sbaglio. Un omonimo, qui, non mette un
 * bambino nella classe sbagliata: produce **una fattura intestata a un estraneo,
 * col suo codice fiscale e la sua residenza, trasmessa all'Agenzia delle
 * Entrate**, e si corregge solo con una nota di variazione. Quindi l'insieme è
 * il minimo che risponda alla domanda.
 *
 * ─── SOLO UGUAGLIANZA, MAI SOMIGLIANZA ──────────────────────────────────────
 * È la stessa regola di `src/lib/iscrizioni/import/abbinamento.ts` — la sua
 * testata porta i tre refusi veri su cui una soglia di somiglianza si sarebbe
 * rotta, e non li si ricopia qui — e vale a maggior ragione, perché lì lo
 * sbaglio si vede (una maestra cerca un bambino che non c'è) e qui no.
 *
 * `similitudine` serve solo a ordinare i «forse cercavi» che si mostrano a chi
 * deve scegliere: **nessuna soglia decide mai**. Il prezzo di questa severità è
 * misurato ed è basso: su 60 ordinanti di un estratto conto mensile confrontati
 * con i 735 genitori dell'archivio, 42 hanno corrispondenza esatta e unica e
 * NESSUNO è ambiguo. Ristretto ai due o tre genitori di un bambino solo,
 * l'ambiguità diventa quasi impossibile — ma il ramo `ambiguo` esiste lo stesso,
 * perché «quasi» non è una garanzia e il caso che non si è previsto è quello che
 * arriva in fattura.
 *
 * Per la stessa ragione qui non c'è nessuna «pulizia» di titoli o abbreviazioni
 * bancarie: ogni lista di sinonimi è una regola fuzzy travestita da normalizzazione.
 *
 * ─── LE DUE FASI, IN QUEST'ORDINE ───────────────────────────────────────────
 *  1. UGUAGLIANZA, nelle tre forme di `abbina()` — nome normalizzato, stesse
 *     parole in ordine diverso, stesso nome con gli spazi altrove.
 *  2. SOTTOINSIEME, e solo se la prima non ha trovato nessuno: tutte le parole
 *     del candidato stanno nel nome dell'ordinante, che ne porta altre. Il caso
 *     tipico è il conto cointestato — la banca scrive i due intestatari uno
 *     dopo l'altro — ma non è l'unico, e il codice non può saperlo.
 *
 * L'ordine non è un dettaglio di efficienza: chi corrisponde esattamente è anche
 * sottoinsieme di sé stesso, quindi fondere le due fasi renderebbe «ambiguo»
 * proprio il caso più chiaro che esista.
 *
 * ─── PURO ───────────────────────────────────────────────────────────────────
 * Nessun I/O, nessun Supabase e nessun logger: `@/lib/logging/logger` trascina
 * `node:crypto`, e questo modulo deve poter girare anche nel browser.
 */
import {
  normalizzaNome,
  senzaSpazi,
  similitudine,
  stessiToken,
  tokenNome,
} from '@/lib/iscrizioni/import/normalizza'

/** Un genitore del bambino, come lo passa il chiamante. */
export interface CandidatoGenitore {
  /** `parents.id` — l'identificatore che viaggerà come intestatario della fattura. */
  adultId: string
  /** Il nome come sta in anagrafica, senza ritocchi. */
  nome: string
}

/**
 * Perché la proposta è quella. Viaggia fino all'interfaccia: una proposta muta
 * non si può né confermare né smentire.
 *
 * ─── PERCHÉ SONO TRE E NON UNO ──────────────────────────────────────────────
 * I tre casi di sottoinsieme si concludono allo stesso modo — un `adultId` —
 * ma per ragioni che l'operatore deve poter distinguere, perché è lui a
 * confermare. «Proposto Tizio, che sulla scheda del bambino è l'intestatario
 * delle fatture» è vero quando ha deciso la scheda ed è **falso** quando
 * semplicemente l'altro nome sul bonifico non lo conosciamo.
 *
 * Con un solo valore, chi scrive quel messaggio avrebbe due strade: dire una
 * cosa non vera, oppure ricavarsi la ragione da sé riguardando i candidati e
 * gli intestatari — cioè riscrivere questa regola una seconda volta, altrove.
 * È esattamente la divergenza che questo modulo esiste per evitare, e la si
 * chiude qui, restituendo il motivo invece di lasciarlo dedurre.
 *
 * I nomi dicono il MECCANISMO (che il codice ha verificato), non un'ipotesi sul
 * conto (che non ha verificato): un candidato contenuto nell'ordinante può
 * essere un cointestatario, ma anche un nome composto registrato a metà —
 * `Verdi Anna` in anagrafica contro `VERDI ANNA MARIA` sul bonifico — e lì
 * «cointestato» mentirebbe.
 */
export type MotivoAbbinamentoOrdinante =
  /** Scritto uguale: normalizzato, stesse parole, o stessi spazi altrove. */
  | 'bonifico_esatto'
  /** Un solo candidato è contenuto nell'ordinante: nessuno con cui confonderlo. */
  | 'sottoinsieme_unico'
  /** Più candidati contenuti: ha deciso `alunni.intestatario_fatture`. */
  | 'sottoinsieme_scheda'
  /** Più candidati contenuti: ha deciso `parents.intestatario_default`. */
  | 'sottoinsieme_famiglia'

export type EsitoOrdinante =
  /** Un solo genitore risponde: si può proporre (e va detto perché). */
  | { tipo: 'unico'; adultId: string; motivo: MotivoAbbinamentoOrdinante }
  /** Più d'uno: non si sceglie, si chiede. Mai «il primo». */
  | { tipo: 'ambiguo'; candidati: CandidatoGenitore[] }
  /** Nessuno: non si inventa. `simili` serve solo a far vedere il refuso. */
  | { tipo: 'assente'; simili: CandidatoGenitore[] }

/**
 * Chi, per questo bambino, è già stato indicato come intestatario delle fatture.
 * Sono **le stesse due fonti**, nello stesso ordine, della cascata di
 * `determinaQuoteFatturazione` (`src/lib/pagamenti/intestatari.ts`): qui non si
 * introduce una terza nozione di «chi è l'intestatario».
 */
export interface IntestatariNoti {
  /** `alunni.intestatario_fatture.adult_id` — l'eccezione per-figlio, che vince. */
  intestatarioScheda?: string | null
  /** `parents.intestatario_default` fra i genitori del bambino. */
  intestatarioFamiglia?: string | null
}

/** Quanti «forse cercavi» si mostrano. Tre: un elenco più lungo non si legge. */
const SIMILI_MOSTRATI = 3

/**
 * Sotto i due token il sottoinsieme non significa niente: un solo nome proprio
 * dentro una stringa lunga capita per caso, e `MARIO` sta dentro mezzo paese.
 */
const TOKEN_MINIMI_PER_SOTTOINSIEME = 2

/**
 * Riconosce l'ordinante di un bonifico fra i genitori di un bambino.
 *
 * `ordinante` è il nome così come l'ha scritto la banca; `candidati` sono i
 * genitori di quel bambino e nessun altro.
 */
export function riconosciOrdinante(
  ordinante: string | null | undefined,
  candidati: readonly CandidatoGenitore[],
  intestatari: IntestatariNoti = {},
): EsitoOrdinante {
  const cercato = normalizzaNome(ordinante)
  // Un ordinante illeggibile non abbina il candidato che ha il nome vuoto: due
  // stringhe vuote sono uguali, ma non sono la stessa persona.
  if (!cercato || candidati.length === 0) {
    return { tipo: 'assente', simili: candidati.length === 0 ? [] : piuSimili(cercato, candidati) }
  }

  // ── Fase 1: uguaglianza, nelle tre forme. ──────────────────────────────────
  // La prima forma sembra sussunta dalla seconda — chi è scritto identico ha per
  // forza anche le stesse parole — e non lo è: `perEsatto` è un SOTTOINSIEME di
  // `perToken`, quindi togliere questo ritorno anticipato non cambierebbe chi si
  // trova, ma renderebbe «ambiguo» un ordinante scritto lettera per lettera come
  // l'anagrafica non appena esiste un doppione con nome e cognome invertiti.
  const perEsatto = candidati.filter((c) => normalizzaNome(c.nome) === cercato)
  if (perEsatto.length > 0) return esitoEsatto(perEsatto)

  const token = tokenNome(cercato)
  const perToken = candidati.filter((c) => stessiToken(tokenNome(c.nome), token))
  if (perToken.length > 0) return esitoEsatto(perToken)

  const saldato = senzaSpazi(cercato)
  const perSaldatura = candidati.filter((c) => senzaSpazi(c.nome) === saldato)
  if (perSaldatura.length > 0) return esitoEsatto(perSaldatura)

  // ── Fase 2: sottoinsieme (il caso tipico è il conto cointestato). ──────────
  const inSottoinsieme = candidati.filter((c) => contenutoIn(tokenNome(c.nome), token))

  if (inSottoinsieme.length === 1) {
    // Il resto del nome è una persona che non abbiamo — o non è una persona
    // affatto: quella che abbiamo è comunque l'unica che risponda alla domanda.
    return { tipo: 'unico', adultId: inSottoinsieme[0].adultId, motivo: 'sottoinsieme_unico' }
  }

  if (inSottoinsieme.length > 1) {
    // Due genitori sullo stesso bonifico: decide chi è già marcato come
    // intestatario, nell'ordine della cascata delle quote. Il motivo dice QUALE
    // delle due fonti ha deciso, perché è quello che l'operatore deve leggere
    // per sapere se confermare.
    const daScheda = trova(inSottoinsieme, intestatari.intestatarioScheda)
    if (daScheda) return { tipo: 'unico', adultId: daScheda.adultId, motivo: 'sottoinsieme_scheda' }

    const daFamiglia = trova(inSottoinsieme, intestatari.intestatarioFamiglia)
    if (daFamiglia) return { tipo: 'unico', adultId: daFamiglia.adultId, motivo: 'sottoinsieme_famiglia' }

    return { tipo: 'ambiguo', candidati: inSottoinsieme }
  }

  return { tipo: 'assente', simili: piuSimili(cercato, candidati) }
}

/** Uno solo si propone; due o più si chiedono. */
function esitoEsatto(trovati: CandidatoGenitore[]): EsitoOrdinante {
  return trovati.length === 1
    ? { tipo: 'unico', adultId: trovati[0].adultId, motivo: 'bonifico_esatto' }
    : { tipo: 'ambiguo', candidati: trovati }
}

/** Tutte le parole del candidato stanno nel nome dell'ordinante (e sono almeno due). */
function contenutoIn(candidato: Set<string>, ordinante: Set<string>): boolean {
  if (candidato.size < TOKEN_MINIMI_PER_SOTTOINSIEME) return false
  for (const t of candidato) if (!ordinante.has(t)) return false
  return true
}

/** Un intestatario che non è fra i candidati non sceglie per loro. */
function trova(
  candidati: readonly CandidatoGenitore[],
  adultId: string | null | undefined,
): CandidatoGenitore | undefined {
  if (!adultId) return undefined
  return candidati.find((c) => c.adultId === adultId)
}

/**
 * I nomi più vicini, per l'elenco a schermo. Serve a far vedere il refuso a chi
 * può correggerlo, non a scegliere: nessuna soglia, nessun taglio dal basso.
 */
function piuSimili(cercato: string, candidati: readonly CandidatoGenitore[]): CandidatoGenitore[] {
  return [...candidati]
    .map((c) => ({ c, s: similitudine(cercato, c.nome) }))
    .sort((a, b) => b.s - a.s || a.c.nome.localeCompare(b.c.nome))
    .slice(0, SIMILI_MOSTRATI)
    .map((x) => x.c)
}
