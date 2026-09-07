// Allergeni alimentari canonici (i 14 dell'allegato II Reg. UE 1169/2011).
// Usati sia per taggare le portate del menu sia per le allergie degli alunni,
// così il match è su chiavi normalizzate e non su confronto di testo libero.
import { useTranslations } from 'next-intl'

export type AllergeneKey =
  | 'glutine' | 'crostacei' | 'uova' | 'pesce' | 'arachidi' | 'soia' | 'latte'
  | 'frutta_a_guscio' | 'sedano' | 'senape' | 'sesamo' | 'solfiti' | 'lupini' | 'molluschi'

export interface AllergeneDef {
  key: AllergeneKey
  label: string       // etichetta IT mostrata in UI
  emoji: string
  sinonimi: string[]  // termini per inferire l'allergene da testo libero
}

// Ordine = ordine di visualizzazione nelle checkbox.
export const ALLERGENI: AllergeneDef[] = [
  { key: 'glutine', label: 'Glutine', emoji: '🌾', sinonimi: ['glutine', 'grano', 'frumento', 'gluten', 'farro', 'orzo', 'segale', 'avena', 'kamut', 'pane', 'pasta', 'farina'] },
  { key: 'crostacei', label: 'Crostacei', emoji: '🦐', sinonimi: ['crostacei', 'crostaceo', 'gambero', 'gamberi', 'gamberetti', 'scampi', 'granchio', 'aragosta', 'mazzancolle'] },
  { key: 'uova', label: 'Uova', emoji: '🥚', sinonimi: ['uovo', 'uova', 'albume', 'tuorlo', 'frittata', 'maionese'] },
  { key: 'pesce', label: 'Pesce', emoji: '🐟', sinonimi: ['pesce', 'merluzzo', 'tonno', 'salmone', 'acciughe', 'acciuga', 'alici', 'nasello', 'platessa', 'sgombro'] },
  { key: 'arachidi', label: 'Arachidi', emoji: '🥜', sinonimi: ['arachide', 'arachidi', 'nocciolina', 'noccioline', 'burro di arachidi'] },
  { key: 'soia', label: 'Soia', emoji: '🫘', sinonimi: ['soia', 'soja', 'tofu', 'edamame'] },
  { key: 'latte', label: 'Latte / lattosio', emoji: '🥛', sinonimi: ['latte', 'lattosio', 'latticini', 'formaggio', 'formaggi', 'burro', 'panna', 'yogurt', 'parmigiano', 'mozzarella', 'ricotta', 'besciamella', 'grana'] },
  { key: 'frutta_a_guscio', label: 'Frutta a guscio', emoji: '🌰', sinonimi: ['frutta a guscio', 'noci', 'noce', 'nocciola', 'nocciole', 'mandorla', 'mandorle', 'pistacchio', 'pistacchi', 'anacardi', 'pinoli', 'noci pecan', 'noci macadamia'] },
  { key: 'sedano', label: 'Sedano', emoji: '🥬', sinonimi: ['sedano'] },
  { key: 'senape', label: 'Senape', emoji: '🟡', sinonimi: ['senape', 'mostarda'] },
  { key: 'sesamo', label: 'Sesamo', emoji: '◯', sinonimi: ['sesamo', 'tahin', 'tahini'] },
  { key: 'solfiti', label: 'Solfiti', emoji: '🍷', sinonimi: ['solfiti', 'solfito', 'anidride solforosa', 'so2'] },
  { key: 'lupini', label: 'Lupini', emoji: '🫛', sinonimi: ['lupini', 'lupino'] },
  { key: 'molluschi', label: 'Molluschi', emoji: '🦑', sinonimi: ['molluschi', 'mollusco', 'vongole', 'cozze', 'calamari', 'calamaro', 'polpo', 'seppia', 'seppie', 'lumache', 'ostriche'] },
]

const BY_KEY = new Map(ALLERGENI.map(a => [a.key, a]))
export const ALLERGENE_KEYS = ALLERGENI.map(a => a.key)

export function isAllergeneKey(k: string): k is AllergeneKey {
  return BY_KEY.has(k as AllergeneKey)
}

export function allergeneLabel(k: string): string {
  return BY_KEY.get(k as AllergeneKey)?.label ?? k
}

/**
 * Hook locale-aware per l'etichetta di un allergene (namespace `etichette`,
 * chiavi `allergene_<code>`). Da usare nei componenti client. Chiave assente
 * → fallback alla funzione pura `allergeneLabel` (IT o codice grezzo), MAI la
 * chiave i18n. `allergeneLabel`/`allergeneEmoji` restano per il server (route,
 * notifiche): non tradurle lì.
 */
export function useAllergeneLabel(): (k: string) => string {
  const t = useTranslations('etichette')
  return (k: string) => {
    const key = `allergene_${k}`
    return t.has(key) ? t(key) : allergeneLabel(k)
  }
}

export function allergeneEmoji(k: string): string {
  return BY_KEY.get(k as AllergeneKey)?.emoji ?? '⚠️'
}

// Tiene solo le chiavi valide e deduplica, preservando l'ordine canonico.
export function normalizzaAllergeni(keys: unknown): AllergeneKey[] {
  const set = new Set<string>(Array.isArray(keys) ? keys.map(String) : [])
  return ALLERGENE_KEYS.filter(k => set.has(k))
}

// ─────────────────────────────────────────────────────────────────────────────
// «NESSUNA ALLERGIA» — la negazione si riconosce a VOCABOLARIO INTERO
//
// In `alunni.allergies` c'è testo scritto da persone, e una parte di quel testo
// dice il contrario di quel che la colonna promette: «Nessuna», «N/A», «nessuna
// allergia nota». Quelle righe non sono allergie e non vanno contate.
//
// ⚠️ IL CRITERIO A SOTTOSTRINGA CANCELLA UN BAMBINO VERO. `scripts/backfill_allergeni.mjs`
// cercava `/\bnessun/` DOVUNQUE nella stringa. In produzione (misurato il 2026-09-07)
// c'è un testo che dice, in sostanza, «non ha allergie riconosciute ma ha un fastidio
// al lattosio… non mangia crudi di nessun tipo… non mangia molluschi»: quella regex lo
// dichiara NEGAZIONE e lo toglie dai contatori E dagli elenchi della cucina, cioè
// proprio dal foglio di chi gli prepara il piatto.
//
// Quindi: una stringa è una negazione solo se OGNI sua parola (punteggiatura
// ignorata) appartiene a un vocabolario chiuso e piccolo. **Una parola sconosciuta
// ⇒ NON è una negazione ⇒ il bambino resta.** È l'unica direzione d'errore
// accettabile quando in mezzo c'è la sicurezza alimentare: contare di più costa una
// verifica, contare di meno costa un piatto sbagliato.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Il vocabolario della negazione. Volutamente CORTO: allungarlo rende più stringhe
 * «negazioni», cioè toglie bambini dagli elenchi — è la direzione che fa male.
 * `nessun*` è a prefisso (nessun/nessuna/nessuno/nessun'…) e sta in `NEGATORI`.
 *
 * ⚠️ QUESTO È IL CONTORNO, NON LA NEGAZIONE. Sono i sostantivi e i participi che
 * accompagnano il negatore: «allergia», «intolleranza», «segnalata», «presente».
 * Da soli non negano niente.
 */
const PAROLE_NEGAZIONE = new Set([
  'no', 'none', 'na',
  'assente', 'assenti',
  'allergia', 'allergie',
  'intolleranza', 'intolleranze',
  'nota', 'note', 'noto', 'noti',
  'particolare', 'particolari',
  'allergene', 'allergeni',
  'conosciuta', 'conosciute',
  'segnalata', 'segnalate',
  'rilevata', 'rilevate',
  'presente', 'presenti',
  'nulla', 'niente',
  'patologia', 'patologie',
])

/**
 * LE PAROLE CHE NEGANO DAVVERO. Almeno una deve esserci, altrimenti la frase è
 * un'AFFERMAZIONE fatta di parole innocue.
 *
 * ⚠️ SENZA QUESTA SECONDA CONDIZIONE «allergia presente» ERA UNA NEGAZIONE. Il
 * vocabolario contiene sia i sostantivi sia i participi, quindi «allergie
 * presenti», «intolleranza rilevata», «patologie presenti» — frasi che dicono
 * l'ESATTO CONTRARIO — passavano il «ogni parola è nel vocabolario» e il bambino
 * spariva dall'elenco della cucina, dall'alert del pranzo e dalla home del
 * docente. Era una PERDITA rispetto al criterio vecchio («testo non vuoto»), cioè
 * proprio la direzione d'errore che il blocco qui sopra vieta per iscritto.
 * `nessun*` resta a prefisso: nessun/nessuna/nessuno/nessun'…
 */
const NEGATORI = new Set(['no', 'none', 'na', 'niente', 'nulla', 'assente', 'assenti'])

/** `true` per `nessun`, `nessuna`, `nessuno`, `nessun'altra`… */
function nega(parola: string): boolean {
  return parola.startsWith('nessun') || NEGATORI.has(parola)
}

/**
 * Le parole di un testo, senza accenti e senza punteggiatura. `n/a` (e `n.a.`)
 * diventa `na` PRIMA che la barra sparisca: altrimenti si spezzerebbe in due
 * lettere sole, e `n/a` non sarebbe più riconosciuto.
 * Testo fatto di sola punteggiatura (`-`, `/`, `//`) ⇒ nessuna parola.
 */
function paroleDi(testo?: string | null): string[] {
  return String(testo ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\bn\s*[/.]\s*a\b/g, ' na ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * `true` quando il testo libero dice «niente allergie» (o non dice nulla).
 * Vuoto ⇒ negazione: non c'è niente da mettere in un elenco.
 *
 * Due condizioni, e servono entrambe:
 *  · OGNI parola sta nel vocabolario chiuso (una parola sconosciuta ⇒ resta);
 *  · ALMENO UNA è un negatore vero (`nessun*`, `no`, `none`, `n/a`, `niente`,
 *    `nulla`, `assente/i`), altrimenti «allergia presente» sarebbe una negazione.
 */
export function isNegazione(testo?: string | null): boolean {
  const parole = paroleDi(testo)
  if (parole.length === 0) return true
  return parole.every((p) => nega(p) || PAROLE_NEGAZIONE.has(p)) && parole.some(nega)
}

// Inferisce allergeni dal testo libero (es. alunni.allergies "lattosio, fragole").
// Usato come fallback quando l'alunno non ha ancora allergeni strutturati.
export function inferisciAllergeniDaTesto(testo?: string | null): AllergeneKey[] {
  if (!testo) return []
  const t = testo.toLowerCase()
  const out: AllergeneKey[] = []
  for (const a of ALLERGENI) {
    if (a.sinonimi.some(s => t.includes(s))) out.push(a.key)
  }
  return out
}

/** Le due colonne da cui si sa se un bambino ha un'allergia: chiavi + testo libero. */
export interface AllergieAlunno {
  allergeni?: string[] | null
  allergies?: string | null
}

/**
 * Allergeni «effettivi» di un alunno: le chiavi spuntate se ci sono, altrimenti
 * quelle inferite dal testo libero.
 *
 * ⚠️ QUI NON C'È UNA GUARDIA DI NEGAZIONE, E NON È UNA DIMENTICANZA. Fino al
 * 2026-09-07 il ramo del testo cominciava con `if (isNegazione(opts.allergies))
 * return []`, e il commento accanto prometteva: «senza, "nessuna allergia al
 * latte" inferirebbe `latte` da un testo che dice l'opposto». Misurato, la
 * promessa era falsa in due modi indipendenti:
 *  · `isNegazione('nessuna allergia al latte')` è `false` — «al» e «latte» non
 *    stanno nel vocabolario chiuso — quindi proprio su quella frase la guardia
 *    non scattava mai;
 *  · e quando scattava non cambiava niente: nessuna parola del vocabolario
 *    contiene il nome di un allergene, quindi su una negazione vera
 *    `inferisciAllergeniDaTesto` restituisce già `[]`. Provato togliendo la
 *    riga: 102 test su 102 restavano verdi. Provato sui dati veri (2026-09-07,
 *    657 iscritti non archiviati): il contatore vale **27 con la guardia e 27
 *    senza**.
 *
 * Che «nessuna allergia al latte» infersca `latte` NON è un difetto da
 * correggere: è la direzione d'errore che il blocco in testa a questo file
 * dichiara l'unica accettabile — contare di più costa una verifica, contare di
 * meno costa un piatto sbagliato. Una guardia «più intelligente» toglierebbe un
 * bambino da un elenco della cucina sulla base di una frase capita a metà.
 *
 * L'invariante che rendeva inutile la guardia — «un testo riconosciuto come
 * negazione non nomina mai un allergene» — non vive più in una riga che nessuno
 * ha mai visto fallire: è un test su tutti i sinonimi dei 14 UE
 * (`__tests__/lib/allergeni-motore.test.ts`), che diventa rosso il giorno in cui
 * `PAROLE_NEGAZIONE` si allarga fino a inghiottire il nome di un cibo.
 */
export function allergeniAlunno(opts: AllergieAlunno): AllergeneKey[] {
  const strutturati = normalizzaAllergeni(opts.allergeni)
  if (strutturati.length > 0) return strutturati
  return inferisciAllergeniDaTesto(opts.allergies)
}

/**
 * IL CONTATORE (A) — «quanti bambini hanno un'allergia».
 *
 * È la domanda a cui rispondono le StatCard, i badge dell'anagrafica e il riquadro
 * del docente, e dal 2026-09-07 la risposta viene dagli ALLERGENI (spuntati o
 * inferiti dai 14 UE), mai da `note_mediche` — che è un'altra colonna, etichettata
 * dal modulo d'iscrizione «Note Mediche (BES, DSA, patologie)» e finita sotto la
 * parola «Allergie» per una svista che si contava da sola.
 *
 * ⚠️ NON è il criterio degli elenchi della cucina: un testo «fragole» (allergia
 * vera, fuori dai 14) qui vale `false`. Per il piatto di un bambino si usa
 * `haAllergiaOperativa`, che non butta via niente.
 */
export function haAllergiaConteggiabile(opts: AllergieAlunno): boolean {
  return allergeniAlunno(opts).length > 0
}

/**
 * L'ELENCO OPERATIVO (B) — «cosa NON mettere nel piatto di questo bambino».
 *
 * Qui non si conta, si decide: un testo che dice «fragole», «kiwi» o «nichel» —
 * fuori dai 14 allergeni UE, quindi invisibile al contatore — deve continuare a
 * comparire. Escono solo le negazioni («Nessuna», «N/A»), che non sono un'allergia
 * ma il modo in cui qualcuno ha scritto «niente».
 */
export function haAllergiaOperativa(opts: AllergieAlunno): boolean {
  if (chiaviAllergeni(opts).length > 0) return true
  const testo = (opts.allergies ?? '').trim()
  return testo.length > 0 && !isNegazione(testo)
}

/**
 * Le chiavi di `alunni.allergeni` COSÌ COME STANNO IN ARCHIVIO, canoniche o no.
 *
 * ⚠️ NON è `normalizzaAllergeni`, ed è voluto. Quella tiene le 14 chiavi UE e
 * scarta il resto in SILENZIO: è la cosa giusta per confrontare un bambino col
 * menu del giorno (le chiavi devono combaciare), ed è la cosa sbagliata su una
 * superficie operativa — se in archivio c'è `['nichel']`, il prestampato di banco
 * la stampa e l'alert del pranzo la faceva sparire. Due elenchi di cucina sullo
 * stesso dato con due regole opposte, e quella che scartava era la meno prudente.
 */
export function chiaviAllergeni(opts: AllergieAlunno): string[] {
  return (Array.isArray(opts.allergeni) ? opts.allergeni : [])
    .map((k) => String(k ?? '').trim())
    .filter((k) => k !== '')
}

/**
 * COSA SI LEGGE ACCANTO AL NOME su una superficie operativa (foglio della cucina,
 * alert del pranzo, scheda attività): le chiavi etichettate PIÙ il testo libero.
 *
 * Nasce dalla composizione di `colonnaAllergie` in
 * `src/app/api/prestampati/banco.ts` — che dal 2026-09-07 chiama questa, invece
 * di ricopiarla — e sta qui perché la usano in cinque. Le due fonti si SOMMANO e
 * nessuna copre l'altra: il report mensa faceva vincere il testo, e per un
 * bambino con `latte` spuntato e la parola «nessuna» scritta a mano la cucina
 * leggeva «nessuna» accanto al suo nome — mentre il motore, giustamente, lo
 * teneva in elenco.
 *
 * ⚠️ NON è «uguale a `colonnaAllergie`», e per un po' il docblock l'ha detto:
 * quella sommava le due colonne ma NON toglieva la negazione, quindi il foglio
 * della cucina stampava «Nessuna» accanto al nome di 6 bambini su 657 (misurato
 * il 2026-09-07) mentre ogni altra superficie li teneva fuori. Le due funzioni
 * erano scambiabili solo a leggerle in fretta; adesso sono la stessa.
 *
 * Il testo non si infersce e non si riassume: «fragole» non è fra i 14 UE e
 * sparirebbe. Esce solo la negazione, che è il modo in cui qualcuno ha scritto
 * «niente». `etichetta` è sostituibile perché i componenti client traducono
 * (`useAllergeneLabel`), mentre le rotte usano la funzione pura.
 */
export function etichetteAllergie(
  opts: AllergieAlunno,
  etichetta: (k: string) => string = allergeneLabel,
): string[] {
  const testo = (opts.allergies ?? '').trim()
  return [
    ...chiaviAllergeni(opts).map(etichetta),
    ...(testo !== '' && !isNegazione(testo) ? [testo] : []),
  ]
}

// ─────────────────────────────────────────────────────────────────────────────
// IL RESIDUO — cosa resta da scrivere quando i chip hanno già parlato
//
// MISURATO sullo screenshot della home docente (2026-09-07): una riga mostrava il
// chip «🥜 ARACHIDI» e, a due centimetri, il testo «ARACHIDI»; un'altra il chip
// «🥛 LATTE / LATTOSIO» seguito da «LATTOSIO, FRAGOLE». Lo stesso dato scritto due
// volte sulla stessa riga, in una colonna larga il 58% dello schermo di un telefono.
//
// Il testo libero non si può togliere — è l'unico posto in cui compare «fragole»,
// che fra i 14 allergeni UE non c'è e che nessun chip dirà mai — ma deve dire solo
// la parte che i chip non hanno già detto.
//
// ⚠️ LA DIREZIONE D'ERRORE È DICHIARATA, ed è la stessa del blocco in testa a
// questo file: su sicurezza alimentare **si può mostrare qualcosa in più, mai in
// meno**. Perciò un frammento si toglie SOLO quando, normalizzato, è ESATTAMENTE
// un sinonimo (o l'etichetta, o la chiave) di un allergene che sta già lì accanto
// in forma di chip: in quel caso l'informazione non si perde, si è solo spostata
// di due centimetri. In ogni altro caso — una frase, una parola sconosciuta, un
// sinonimo di un allergene che chip non ne ha — il frammento RESTA.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * I separatori di un elenco scritto a mano: virgola, punto e virgola, barra,
 * punto mediano, a capo.
 *
 * ⚠️ NON la congiunzione « e », di proposito. Spezzare «arachidi e noci» toglierebbe
 * entrambi i pezzi e mostrerebbe MENO — la direzione vietata — mentre lasciandola
 * intera la frase resta a schermo accanto ai chip: una ripetizione, che è il
 * fastidio che si sta correggendo, ma dalla parte giusta dell'errore.
 */
const SEPARATORI_ELENCO = /[,;/\n·]+/

/** Un frammento ridotto a parole: minuscolo, senza accenti, senza punteggiatura. */
function formaConfronto(testo: string): string {
  return paroleDi(testo).join(' ')
}

/**
 * Le forme di testo che un chip DICE GIÀ: per ogni chiave mostrata, i suoi
 * sinonimi, la sua etichetta e la chiave stessa (che è ciò che si legge sul chip
 * quando la chiave è fuori dalle 14 UE, es. `nichel`).
 */
function formeCoperte(chiavi: string[]): Set<string> {
  const coperte = new Set<string>()
  for (const k of chiavi) {
    const chiave = String(k ?? '').trim()
    if (chiave === '') continue
    coperte.add(formaConfronto(chiave))
    const def = BY_KEY.get(chiave as AllergeneKey)
    if (!def) continue
    coperte.add(formaConfronto(def.label))
    for (const s of def.sinonimi) coperte.add(formaConfronto(s))
  }
  coperte.delete('')
  return coperte
}

/**
 * Il testo libero da mostrare ACCANTO ai chip: quello di archivio meno i pezzi
 * che i chip già dicono. Stringa vuota ⇒ non c'è niente da scrivere.
 *
 * @param testo `alunni.allergies` così com'è in archivio
 * @param chiavi le chiavi che a schermo diventano chip (`chiaviAllergeni` +
 *   `allergeniAlunno`, cioè quelle dell'archivio più quelle inferite)
 *
 * ⚠️ SE NON SI TOGLIE NIENTE, IL TESTO TORNA IDENTICO. La ricomposizione con la
 * virgola avviene solo quando almeno un frammento è caduto: altrimenti un testo
 * come «1/2 porzione di latte», che la barra spezza in due, tornerebbe riscritto
 * come «1, 2 porzione di latte» — un dato di cucina cambiato da una funzione di
 * presentazione.
 *
 * La negazione («Nessuna», «N/A») non si mostra mai, qui come in
 * `etichetteAllergie`: non è un'allergia, è il modo in cui qualcuno ha scritto
 * «niente». Sta dentro questa funzione e non nel chiamante perché ogni superficie
 * che mostra il residuo deve prendersi la stessa regola senza doverla ricordare.
 */
export function testoResiduoAllergie(testo: string | null | undefined, chiavi: string[]): string {
  const intero = String(testo ?? '').trim()
  if (intero === '' || isNegazione(intero)) return ''

  const coperte = formeCoperte(chiavi)
  if (coperte.size === 0) return intero

  const superstiti: string[] = []
  let tolto = false
  for (const pezzo of intero.split(SEPARATORI_ELENCO)) {
    const forma = formaConfronto(pezzo)
    // Solo punteggiatura fra due separatori: non è un frammento, non è una perdita.
    if (forma === '') continue
    if (coperte.has(forma)) { tolto = true; continue }
    superstiti.push(pezzo.trim())
  }
  if (!tolto) return intero
  return superstiti.join(', ')
}

export interface PortateAllergeni {
  primo?: string[]
  secondo?: string[]
  contorno?: string[]
  frutta?: string[]
}
// Alias: stessa forma usata in resolveMenu (allergeni per portata).
export type AllergeniPortate = PortateAllergeni

// Union di tutti gli allergeni delle portate di un giorno (chiavi canoniche).
export function allergeniDelGiorno(perPortata?: PortateAllergeni | null): AllergeneKey[] {
  if (!perPortata) return []
  const all = [
    ...(perPortata.primo ?? []),
    ...(perPortata.secondo ?? []),
    ...(perPortata.contorno ?? []),
    ...(perPortata.frutta ?? []),
  ]
  return normalizzaAllergeni(all)
}

export interface ConflittoAllergia {
  allergene: AllergeneKey
  portate: ('primo' | 'secondo' | 'contorno' | 'frutta')[]
}

// Conflitti tra le allergie di un alunno e gli allergeni del menu del giorno:
// per ogni allergene in comune indica in quali portate compare.
export function conflittiAllergie(
  allergeniAlunno: string[],
  perPortata?: PortateAllergeni | null
): ConflittoAllergia[] {
  if (!perPortata) return []
  const alunno = new Set(normalizzaAllergeni(allergeniAlunno))
  const portate: ('primo' | 'secondo' | 'contorno' | 'frutta')[] = ['primo', 'secondo', 'contorno', 'frutta']
  const out: ConflittoAllergia[] = []
  for (const key of ALLERGENE_KEYS) {
    if (!alunno.has(key)) continue
    const inPortate = portate.filter(p => (perPortata[p] ?? []).includes(key))
    if (inPortate.length > 0) out.push({ allergene: key, portate: inPortate })
  }
  return out
}
