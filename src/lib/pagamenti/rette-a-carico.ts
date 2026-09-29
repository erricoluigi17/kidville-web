/**
 * ─── LA RETTA A CARICO DI UN FRATELLO, VISTA DALLA CONTABILITÀ ─────────────────
 *
 * `alunni.retta_a_carico_di` (dal 2026-08-16) dice che la retta di un bambino la paga un
 * fratello: entrambe le strade che generano le rette lo SALTANO. Fino al 2026-09-28 la
 * vista Rette lo mostrava comunque come «Non generata», cioè come un bambino dimenticato,
 * e «Genera mancanti» lo contava senza mai poterlo generare.
 *
 * Questo modulo è PURO: tipi, testi, anomalie. Il PREFISSO italiano qui sotto («Paga il
 * fratello Mario Rossi (Sez. C)») è lo stesso del catalogo `it` (`adminContabilita.dashACarico`),
 * e lo usa l'export Excel.
 *
 * COSA È GARANTITO, E DA QUALE LOCK (R6, terza revisione 2026-09-29). Fino a qui questo
 * commento diceva che schermo ed Excel dicono «la stessa frase»: è vero solo in parte.
 *  · Il PREFISSO è identico per ogni sesso (M, F, assente), con o senza classe e — dalla quarta
 *    revisione (Q8) — con nome e cognome vuoti: lo verifica il LOCK di
 *    `__tests__/pagamenti/rette-a-carico.test.ts`. Lo schermo passa il messaggio ICU da
 *    `ripulisciFrase`, come fa qui `prefissoPaganteIt`: nessuno spazio doppio, iniziale o finale.
 *  · La parola dello STATO dopo « · » è identica per i QUATTRO stati noti (`da_pagare`,
 *    `parziale`, `pagato`, `scaduto`): lo verifica C7 in
 *    `__tests__/api/pagamenti-export-rette-a-carico.test.ts`, che lega `STATI_PAGAMENTO` del
 *    cruscotto a `STATO_LABEL` dell'export.
 *  · Per uno stato NULL o sconosciuto i due mezzi DIVERGONO, e nessun lock li lega: il
 *    cruscotto ripiega su «Da pagare» (`STATI[stato] ?? STATI.da_pagare`), l'Excel scrive la
 *    frase senza stato (NULL) o lo stato grezzo (sconosciuto). Ciascun mezzo fa esattamente ciò
 *    che fa, nello STESSO mezzo, sulla riga del fratello che paga — ed è questo che chiede D3:
 *    il badge segue la riga del pagante, non l'altro mezzo.
 */

export type SessoPagante = 'M' | 'F' | null

export interface PaganteRetta {
  id: string
  nome: string
  cognome: string
  sesso: SessoPagante
  classe_sezione: string | null
  /** `stato === 'iscritto'` e nessuna data di archiviazione. */
  iscritto: boolean
  scuola_id: string | null
}

export interface LegameRetta {
  /** Il bambino A CARICO. */
  alunno_id: string
  /** La sede del bambino a carico. */
  scuola_id: string | null
  pagante: PaganteRetta
}

export type AnomaliaPagante = 'non-iscritto' | 'altra-sede' | null

/** Fra chi paga e lo stato della sua retta: identico a schermo e nell'Excel. */
export const SEPARATORE_STATO = ' · '

export function sessoDa(gender: unknown): SessoPagante {
  if (typeof gender !== 'string') return null
  const g = gender.trim().toUpperCase()
  return g === 'M' || g === 'F' ? g : null
}

export function nomePagante(p: Pick<PaganteRetta, 'nome' | 'cognome'>): string {
  return `${p.nome ?? ''} ${p.cognome ?? ''}`.replace(/\s+/g, ' ').trim()
}

/**
 * Q8 (quarta revisione 2026-09-29) — una frase composta da pezzi che possono essere VUOTI: il
 * loader mette '' al posto di un nome o di un cognome NULL, e il catalogo ICU ha uno spazio fra
 * la parola e `{nome}` («Paga il fratello {nome}», «… {nome}}: retta da verificare»). Con un nome
 * vuoto usciva «Paga il fratello␣␣(Sez. C)», e senza nome né classe «Paga il fratello␣» — e
 * con « · Da pagare» dietro, di nuovo due spazi. Qui: ogni corsa di spazi diventa uno, via quelli
 * in testa, in coda e davanti ai due punti. La usano l'Excel (`prefissoPaganteIt`) e lo schermo
 * (`BadgeRettaACarico`, sul messaggio ICU formattato): il lock schermo = Excel la applica uguale.
 */
export function ripulisciFrase(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/ :/g, ':').trim()
}

/** «Mario Rossi (Sez. C)»; senza classe, solo il nome (D5); senza nome, solo «(Sez. C)» (Q8). */
export function nomeConClasse(p: Pick<PaganteRetta, 'nome' | 'cognome' | 'classe_sezione'>): string {
  const classe = ripulisciFrase(p.classe_sezione ?? '')
  return [nomePagante(p), classe ? `(${classe})` : ''].filter(Boolean).join(' ')
}

/** I valori del messaggio ICU `dashACarico`/`dashACaricoVerifica`: ICU vuole una stringa, «nd» = sesso assente. */
export function valoriPrefisso(p: Pick<PaganteRetta, 'nome' | 'cognome' | 'classe_sezione' | 'sesso'>): { sesso: string; nome: string } {
  return { sesso: p.sesso ?? 'nd', nome: nomeConClasse(p) }
}

/** Il prefisso in italiano (D1): la stessa frase del catalogo `it`, ripulita come a schermo (Q8). */
export function prefissoPaganteIt(p: Pick<PaganteRetta, 'nome' | 'cognome' | 'classe_sezione' | 'sesso'>): string {
  const parola = p.sesso === 'M' ? 'Paga il fratello' : p.sesso === 'F' ? 'Paga la sorella' : 'A carico di'
  return ripulisciFrase(`${parola} ${nomeConClasse(p)}`)
}

/** Prefisso + « · stato» (D2). Senza stato, il solo prefisso. */
export function componiBadge(prefisso: string, stato?: string | null): string {
  return stato ? `${prefisso}${SEPARATORE_STATO}${stato}` : prefisso
}

/** Il testo intero in italiano: la colonna «Stato» dell'export (D14). */
export function testoPaganteIt(p: Pick<PaganteRetta, 'nome' | 'cognome' | 'classe_sezione' | 'sesso'>, stato?: string | null): string {
  return componiBadge(prefissoPaganteIt(p), stato)
}

/**
 * D12. Il non iscritto vince: se chi paga è uscito, che sia anche in un'altra sede è un
 * dettaglio. Le sedi si confrontano come arrivano dal database (forma canonica).
 */
export function anomaliaPagante(l: LegameRetta): AnomaliaPagante {
  if (!l.pagante.iscritto) return 'non-iscritto'
  if (l.pagante.scuola_id !== l.scuola_id) return 'altra-sede'
  return null
}

export function indicizzaLegami(legami: readonly LegameRetta[]): Map<string, LegameRetta> {
  return new Map(legami.map((l) => [l.alunno_id, l]))
}

const eIdValido = (v: unknown): v is string => typeof v === 'string' && v !== ''
const eSedeValida = (v: unknown): v is string | null => v === null || eIdValido(v)

/**
 * K6 (seconda revisione 2026-09-28) — si valida OGNI campo che il cruscotto usa, non solo
 * quelli del nome: una `classe_sezione` numerica faceva lanciare `.trim()` (in `nomeConClasse`)
 * e cadere tutta la Contabilità; un `iscritto` assente accendeva il falso avviso rosso «Chi
 * paga non risulta iscritto». Gli id e le sedi sono stringhe NON vuote (o `null` per le sedi):
 * si confrontano con quelli del cruscotto, non si validano come uuid — le fixture e l'uuid
 * canonico del database passano allo stesso modo.
 */
function eLegame(x: unknown): x is LegameRetta {
  if (!x || typeof x !== 'object') return false
  const l = x as Record<string, unknown>
  const p = l.pagante as Record<string, unknown> | null | undefined
  if (!p || typeof p !== 'object') return false
  return eIdValido(l.alunno_id) && eSedeValida(l.scuola_id)
    && eIdValido(p.id) && typeof p.nome === 'string' && typeof p.cognome === 'string'
    && (p.sesso === 'M' || p.sesso === 'F' || p.sesso === null)
    && (p.classe_sezione === null || typeof p.classe_sezione === 'string')
    && typeof p.iscritto === 'boolean'
    && eSedeValida(p.scuola_id)
}

/**
 * Il corpo della GET, controllato. `null` = forma inattesa: è un GUASTO, non «nessun
 * legame», e il chiamante lo dice a schermo. Le voci malformate (vedi `eLegame`) si scartano
 * una a una, e si CONTANO: uno scarto muto è un bambino che torna «Non generata» senza che
 * nessuno sappia perché — il cruscotto logga il conteggio (mai chi).
 */
export function legamiDaRisposta(data: unknown): { legami: LegameRetta[]; scartati: number } | null {
  if (!Array.isArray(data)) return null
  const legami = data.filter(eLegame)
  return { legami, scartati: data.length - legami.length }
}

/**
 * `a_carico_non_visibili` della GET: i bambini a carico il cui pagante sta in una sede che
 * l'utente non legge (solo i loro id). «Nessuno» è l'array vuoto, e solo quello. Un valore che
 * non è una stringa non vuota si scarta e si conta come in `legamiDaRisposta` (l'id si confronta
 * con quelli del cruscotto, non si valida come uuid).
 *
 * `null` = il campo non è un array — ASSENTE, `null` o altro: una forma inattesa, cioè un GUASTO
 * come `data` non array in `legamiDaRisposta`, e il chiamante lo dice a schermo senza usare
 * niente di quella risposta.
 *  · R10 (terza revisione 2026-09-29): un campo presente e non array era «uno scarto», e il
 *    cruscotto mostrava come veri i legami di una risposta che per metà non capiva.
 *  · Q4 (quarta revisione 2026-09-29): il campo ASSENTE (o `null`) valeva «nessuno», giustificato
 *    come «risposta di prima del 28/09». Quella risposta non esiste: la route nasce con questa
 *    funzionalità e ha sempre avuto il campo. Senza, i bambini non visibili tornavano «Non
 *    generata» e mancanti sotto legami mostrati come veri, e senza un segnale.
 */
export function nonVisibiliDaRisposta(v: unknown): { ids: string[]; scartati: number } | null {
  if (!Array.isArray(v)) return null
  const ids = v.filter((x): x is string => typeof x === 'string' && x !== '')
  return { ids, scartati: v.length - ids.length }
}
