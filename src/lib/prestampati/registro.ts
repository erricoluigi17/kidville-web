/**
 * IL REGISTRO DEI DICIASSETTE — l'indice unico dei prestampati.
 *
 * I modelli vivono in due file (`modelli/genitore.ts` e `modelli/segreteria.ts`), scritti
 * da due mani nello stesso momento e con DUE contratti incompatibili: chiave del campo
 * (`nome` di qua, `id` di là), tipi di campo diversi, firma che di qua dice *chi deve
 * firmare* e di là *quale blocco disegna il motore*, titolo costante di qua e funzione
 * delle risposte di là. Il debito è dichiarato nella testata di `modelli/segreteria.ts`.
 *
 * Questo file NON risolve quel debito riscrivendo i due contratti — non sono di questa
 * mano, e un file condiviso riscritto da tre parti si perde a vicenda. Fa una cosa più
 * piccola e più utile subito: costruisce **una vista sola** sopra tutti e diciassette, in
 * cui un pannello, una route o un log possono chiedere «chi può generare questo foglio»,
 * «di chi parla», «che firma pretende» senza sapere da quale dei due file arrivi. Il
 * giorno in cui i due contratti si uniranno, questo file si accorcia: le funzioni di
 * adattamento spariscono, l'elenco resta.
 *
 * ─── È ANCHE IL CANCELLO ────────────────────────────────────────────────────────
 *
 * `prestampato(slug)` è il punto in cui uno slug sconosciuto viene RESPINTO. Nessuna
 * stringa arbitraria deve poter arrivare al render: `document_type` finisce dentro
 * `student_documents`, dentro il nome del file nel bucket e dentro il registro di
 * protocollo, e una stringa scelta da chi chiama sarebbe una riga d'archivio che nessun
 * elenco della segreteria saprà più mostrare. Uno slug che non è qui non è un'eccezione:
 * è un 404.
 *
 * ─── PURO, E DEVE RESTARCI ──────────────────────────────────────────────────────
 *
 * Qui non entrano né Supabase né `next/server` né jsPDF: questo elenco lo importa anche
 * il pannello della segreteria, che è un componente `'use client'`. È il modo in cui in
 * questo repo `vitest` resta verde e `npm run build` cade (memoria del 2026-08-13): il
 * caricamento dei dati sta in `prefill.ts`, la generazione in `render.ts`, e nessuno dei
 * due si importa da qui.
 *
 * Collaudato in `__tests__/lib/prestampati-registro.test.ts`.
 */

import {
  MODELLI_GENITORE,
  type CampoModulo as CampoModuloGenitore,
  type DisponibileA,
  type FirmaRichiesta,
  type ModelloPrestampato as ModelloGenitore,
  type OpzioneCampo,
  type SlugPrestampatoGenitore,
  type TipoCampoModulo as TipoCampoGenitore,
} from '@/lib/prestampati/modelli/genitore'
import {
  MODELLI_SEGRETERIA,
  type ArchiviazionePrestampato,
  type CampoModulo as CampoModuloSegreteria,
  type ProtocolloPrestampato,
  type RuoloPrestampato,
  type SoggettoPrestampato,
  type TipoCampoModulo as TipoCampoSegreteria,
  type VoceRegistroPrestampati,
} from '@/lib/prestampati/modelli/segreteria'
import type { FirmaPrestampato } from '@/lib/prestampati/tipi'

/**
 * I tipi dei due file dei modelli che compaiono nella voce di registro, ri-esposti da qui.
 *
 * Non è comodità: chi importa il registro ha bisogno di `SoggettoPrestampato` per filtrare
 * e di `OpzioneCampo` per disegnare un campo, e senza questa riga ogni pannello importerebbe
 * un pezzo da `modelli/genitore` e uno da `modelli/segreteria` — cioè conoscerebbe la
 * divisione che il registro esiste per nascondere, e la seguirebbe il giorno in cui cambia.
 */
export type {
  ArchiviazionePrestampato,
  ProtocolloPrestampato,
  SoggettoPrestampato,
} from '@/lib/prestampati/modelli/segreteria'
export type { OpzioneCampo } from '@/lib/prestampati/modelli/genitore'

// ─── Gli slug ───────────────────────────────────────────────────────────────────

/**
 * I nove di `modelli/segreteria.ts`, che là `VoceRegistroPrestampati.slug` dichiara come
 * `string`: senza un'unione, `prestampato('typo_qualsiasi')` compilerebbe.
 *
 * Ridichiararli qui è una copia, e una copia si paga: il test pretende che questa unione
 * e gli slug di `MODELLI_SEGRETERIA` coincidano ESATTAMENTE, nei due versi. Un modello
 * nuovo di là senza la sua riga qui è rosso; una riga qui senza modello è rossa uguale.
 */
export type SlugPrestampatoSegreteria =
  | 'nulla_osta'
  | 'richiesta_disponibilita'
  | 'sollecito_pagamento'
  | 'verbale_infortunio'
  | 'valutazione_infanzia'
  | 'certificato_competenze'
  | 'certificato_servizio'
  | 'stampe_sezione'
  | 'registro_presenze'

/** Tutti e diciassette. È anche il `document_type` di chi si archivia. */
export type SlugPrestampato = SlugPrestampatoGenitore | SlugPrestampatoSegreteria

/** Da quale dei due file arriva il modello. Decide come si compone, non chi lo usa. */
export type FamigliaPrestampato = 'genitore' | 'segreteria'

// ─── Chi chiede ─────────────────────────────────────────────────────────────────

/**
 * I tre banchi da cui un prestampato può nascere.
 *
 * NON sono i ruoli dell'app: `AppRole` ne ha sei, e tre di quelli (admin, coordinator,
 * segreteria) stanno tutti dietro allo stesso banco per quel che riguarda la modulistica.
 * Tenerli distinti qui vorrebbe dire ripetere lo stesso elenco di tre ruoli in ognuna
 * delle diciassette righe, e il giorno in cui ne nasce un quarto lo si aggiunge in
 * diciassette punti — o, più probabilmente, in sedici.
 */
export type RuoloRichiedente = 'genitore' | 'segreteria' | 'insegnante'

/**
 * `AppRole` → il banco. I valori di partenza sono quelli di
 * `src/lib/auth/require-staff.ts` ma NON si importano da lì: quel modulo tira dentro
 * `next/server` e il client Supabase service-role, e questo elenco finisce anche in un
 * pannello `'use client'`.
 *
 * `cuoca` non c'è, e non è una dimenticanza: nessuno dei diciassette la nomina fra chi
 * può generare — nemmeno il n. 49, che pure produce l'elenco delle allergie che la cucina
 * usa. Quel foglio glielo stampa la segreteria; darle il pannello vorrebbe dire darle
 * anche il resto, verbali di infortunio compresi.
 */
const BANCO_DEL_RUOLO: Record<string, RuoloRichiedente> = {
  admin: 'segreteria',
  coordinator: 'segreteria',
  segreteria: 'segreteria',
  educator: 'insegnante',
  genitore: 'genitore',
}

/** Il banco di un ruolo dell'app, o `null` per chi non ne ha uno (la cuoca, un ruolo ignoto). */
export function ruoloRichiedente(ruoloApp: string | null | undefined): RuoloRichiedente | null {
  const r = ruoloApp?.trim()
  return r ? (BANCO_DEL_RUOLO[r] ?? null) : null
}

/** I ruoli dell'app che stanno dietro a un banco: serve al gate `requireStaff` della route. */
export function ruoliAppDelBanco(banco: RuoloRichiedente): string[] {
  return Object.keys(BANCO_DEL_RUOLO).filter((r) => BANCO_DEL_RUOLO[r] === banco)
}

// ─── La firma ───────────────────────────────────────────────────────────────────

/**
 * CHE SOTTOSCRIZIONE PRETENDE IL FOGLIO — non quale blocco disegna il motore.
 *
 * I due file dicevano due cose diverse con lo stesso nome: `modelli/genitore.ts` dichiara
 * il requisito (`otp_genitore`, `otp_due_genitori`, `legale_rappresentante`),
 * `modelli/segreteria.ts` il tipo di blocco del motore (`genitore`,
 * `legaleRappresentante`, `nessuna`). Non sono sinonimi: dal requisito si ricava sempre
 * il blocco, dal blocco NON si ricava il requisito — «genitore» non dice se le firme
 * sono una o due, e l'08 ne vuole due.
 *
 * Perciò il registro tiene il REQUISITO, che è l'informazione più ricca, e
 * `bloccoFirma()` ne ricava il disegno. Il verso opposto lo fa `requisitoDaBlocco()`, che
 * è dove i nove della segreteria entrano nell'elenco: perdendo per strada, ed è tutto
 * quello che si perde, la distinzione fra una firma e due — che nessuno dei nove chiede.
 */
export type FirmaPrestampatoRichiesta = FirmaRichiesta | 'nessuna'

/** Il blocco che il motore disegna in fondo al foglio (§3 di `00-impaginazione.md`). */
export function bloccoFirma(firma: FirmaPrestampatoRichiesta): FirmaPrestampato['tipo'] {
  if (firma === 'legale_rappresentante') return 'legaleRappresentante'
  if (firma === 'nessuna') return 'nessuna'
  return 'genitore'
}

function requisitoDaBlocco(blocco: FirmaPrestampato['tipo']): FirmaPrestampatoRichiesta {
  if (blocco === 'legaleRappresentante') return 'legale_rappresentante'
  if (blocco === 'nessuna') return 'nessuna'
  return 'otp_genitore'
}

// ─── Il descrittore del campo, in una forma sola ────────────────────────────────

/** L'unione dei tipi dei due file: nessuno dei due copre l'altro. */
export type TipoCampoPrestampato = TipoCampoGenitore | TipoCampoSegreteria

/**
 * Un campo del modulo, nella forma che il pannello può disegnare senza sapere da quale
 * dei due file arriva.
 *
 * ⚠️ LA CHIAVE SI CHIAMA `nome`, e la scelta va detta perché è arbitraria a metà: i due
 * file la chiamano `nome` e `id`, e qui ne poteva restare una sola. Vince `nome` perché
 * in questo repo `id` è un uuid — `zUuid`, `alunnoId`, `section_id` — e una chiave di
 * campo chiamata `id` accanto a `alunnoId` dentro la stessa richiesta è il tipo di
 * omonimia che si legge sbagliata la prima volta e non si rilegge mai più. Qui `nome` è
 * la chiave dentro le RISPOSTE, cioè la stessa dello schema `zod` del modello.
 */
export interface CampoPrestampato {
  nome: string
  etichetta: string
  tipo: TipoCampoPrestampato
  obbligatorio: boolean
  aiuto?: string
  /** Le alternative di `scelta`/`sceltaMultipla`, o le RIGHE di una `griglia`. */
  opzioni?: readonly OpzioneCampo[]
  /** I valori ammessi su ogni riga di una `griglia` (i livelli di una scala). */
  valoriAmmessi?: readonly OpzioneCampo[]
  /** Più risposte ammesse (i giorni di un permesso ricorrente). */
  multipla?: boolean
  /** Le colonne di una tabella `righe`. */
  colonne?: readonly CampoPrestampato[]
  /** Il campo si mostra solo quando un altro ha uno di questi valori. */
  mostraSe?: { campo: string; valori: readonly (string | boolean)[] }
  /** L'app riempie il campo da qui, e la persona può correggerlo. */
  precompilatoDa?: string
  /** Elenco costruito a runtime perché dipende dall'alunno (i delegati attivi). */
  opzioniDaApp?: 'delegati_attivi'
  /** Chiesto solo a chi emette il documento allo sportello, non alla famiglia. */
  chiestoA?: 'segreteria'
  /** Dove il dato atterrerà quando le migrazioni torneranno possibili. */
  daPromuovereInAnagrafica?: string
}

function daCampoGenitore(c: CampoModuloGenitore): CampoPrestampato {
  return {
    nome: c.nome,
    etichetta: c.etichetta,
    tipo: c.tipo,
    obbligatorio: c.obbligatorio,
    ...(c.aiuto ? { aiuto: c.aiuto } : {}),
    ...(c.opzioni ? { opzioni: c.opzioni } : {}),
    ...(c.multipla ? { multipla: c.multipla } : {}),
    ...(c.colonne ? { colonne: c.colonne.map(daCampoGenitore) } : {}),
    ...(c.mostraSe ? { mostraSe: c.mostraSe } : {}),
    ...(c.precompilatoDa ? { precompilatoDa: c.precompilatoDa } : {}),
    ...(c.opzioniDaApp ? { opzioniDaApp: c.opzioniDaApp } : {}),
    ...(c.chiestoA ? { chiestoA: c.chiestoA } : {}),
    ...(c.daPromuovereInAnagrafica ? { daPromuovereInAnagrafica: c.daPromuovereInAnagrafica } : {}),
  }
}

function daCampoSegreteria(c: CampoModuloSegreteria): CampoPrestampato {
  return {
    nome: c.id,
    etichetta: c.etichetta,
    tipo: c.tipo,
    obbligatorio: c.obbligatorio,
    ...(c.aiuto ? { aiuto: c.aiuto } : {}),
    ...(c.opzioni ? { opzioni: c.opzioni } : {}),
    ...(c.valoriAmmessi ? { valoriAmmessi: c.valoriAmmessi } : {}),
  }
}

// ─── La voce di registro ────────────────────────────────────────────────────────

export interface VocePrestampato {
  slug: SlugPrestampato
  /**
   * Il nome del foglio in ITALIANO, per il server: la riga di log, il nome del file nel
   * bucket, l'oggetto del protocollo. **Non è il testo che l'utente legge**: quello sta
   * nei cataloghi (`chiaveEtichetta()`), perché l'interfaccia è bilingue e questo file no.
   * Il test tiene insieme le due cose pretendendo che ogni slug abbia la sua chiave in
   * entrambe le lingue: i due testi possono differire, un modello senza etichetta no.
   */
  etichetta: string
  famiglia: FamigliaPrestampato
  soggetto: SoggettoPrestampato
  /**
   * I banchi che dichiara il modello, **prima** della regola di lettura. Per filtrare si
   * usa `prestampatiPerRuolo()`, non questo campo: la segreteria vede anche ciò che è
   * dichiarato del genitore, e quella regola vive nella query.
   */
  disponibilePer: readonly RuoloRichiedente[]
  firma: FirmaPrestampatoRichiesta
  protocollo: ProtocolloPrestampato
  archiviazione: ArchiviazionePrestampato
  campi: readonly CampoPrestampato[]
}

/**
 * I banchi di un modello del genitore.
 *
 * `genitore` e `genitore_e_segreteria` collassano sullo stesso valore, e non è una perdita
 * nascosta: con la regola di lettura qui sotto — ciò che è del genitore lo vede anche la
 * segreteria — i due casi finiscono comunque nello stesso elenco. La differenza che i due
 * nomi portavano (chi lo fa NASCERE di norma) resta leggibile nel modello, dove serve a
 * chi scrive la route; nel registro sarebbe una distinzione senza conseguenze.
 */
function banchiDelGenitore(disponibileA: DisponibileA): readonly RuoloRichiedente[] {
  return disponibileA === 'segreteria' ? ['segreteria'] : ['genitore']
}

function banchiDellaSegreteria(ruoli: readonly RuoloPrestampato[]): readonly RuoloRichiedente[] {
  const banchi = new Set<RuoloRichiedente>()
  for (const ruolo of ruoli) {
    const banco = ruoloRichiedente(ruolo)
    if (banco) banchi.add(banco)
  }
  return [...banchi]
}

/**
 * LE TRE COSE CHE `modelli/genitore.ts` NON DICHIARA, decise qui una per una.
 *
 *  · **l'etichetta** — là c'è il `titolo`, che è il testo IN MAIUSCOLO stampato sul foglio
 *    («RICHIESTA DI PERMESSO — ENTRATA POSTICIPATA / USCITA ANTICIPATA»): un elenco di
 *    scelta che lo mostrasse sarebbe illeggibile. Le otto righe sono quelle della tabella
 *    di `docs/prestampati/README.md`, copiate da lì e non riscritte;
 *  · **il protocollo** — regola 4 del README: ciò che esce dalla scuola verso un ente
 *    consuma un numero. Sono i due certificati, e basta;
 *  · **l'archiviazione** — regola 3: il PDF finisce in `student_documents` con il suo
 *    `document_type`. I due certificati stanno da entrambe le parti (vanno a un ente *e*
 *    restano nel fascicolo del bambino) e lì vince `student_documents`: è la copia che la
 *    famiglia ritrova, mentre del registro si occupa già `protocollo: 'uscita'`.
 *
 * ⚠️ È un `Record` sull'unione ESATTA degli otto slug, e non una regola dedotta dalla
 * firma («firma il legale rappresentante ⇒ esce dalla scuola»): quella dedurrebbe da un
 * campo che parla d'altro e resterebbe verde il giorno in cui i due assi si scollano. Così
 * invece un modello nuovo di là **non compila** finché qualcuno non decide queste tre
 * cose — che è l'unico momento in cui le decide una persona.
 *
 * ⚠️ `protocollo: 'uscita'` dice che il foglio consuma un numero **quando lo emette la
 * segreteria**. La copia che il genitore si scarica da sé non ne consuma (§4.1 di
 * `00-impaginazione.md`: al suo posto va la dicitura «Copia a uso della famiglia — non
 * protocollata»), ed è una differenza fra due GENERAZIONI dello stesso modello: la decide
 * la route, non questa tabella.
 */
const SCELTE_GENITORE: Record<
  SlugPrestampatoGenitore,
  { etichetta: string; protocollo: ProtocolloPrestampato; archiviazione: ArchiviazionePrestampato }
> = {
  scheda_sanitaria: {
    etichetta: 'Scheda sanitaria',
    protocollo: 'nessuno',
    archiviazione: 'student_documents',
  },
  autorizzazione_farmaci: {
    etichetta: 'Autorizzazione somministrazione farmaci',
    protocollo: 'nessuno',
    archiviazione: 'student_documents',
  },
  dieta_speciale: {
    etichetta: 'Richiesta dieta speciale',
    protocollo: 'nessuno',
    archiviazione: 'student_documents',
  },
  delega_ritiro: {
    etichetta: 'Delega al ritiro',
    protocollo: 'nessuno',
    archiviazione: 'student_documents',
  },
  permesso_orario: {
    etichetta: 'Permesso entrata posticipata / uscita anticipata',
    protocollo: 'nessuno',
    archiviazione: 'student_documents',
  },
  autorizzazione_uscita: {
    etichetta: 'Autorizzazione uscita didattica / gita',
    protocollo: 'nessuno',
    archiviazione: 'student_documents',
  },
  certificato_iscrizione_frequenza: {
    etichetta: 'Certificato di iscrizione e frequenza',
    protocollo: 'uscita',
    archiviazione: 'student_documents',
  },
  certificato_bonus_nido: {
    etichetta: 'Certificato per Bonus Asilo Nido INPS',
    protocollo: 'uscita',
    archiviazione: 'student_documents',
  },
}

function daModelloGenitore(m: ModelloGenitore): VocePrestampato {
  const scelte = SCELTE_GENITORE[m.slug]
  return {
    slug: m.slug,
    etichetta: scelte.etichetta,
    famiglia: 'genitore',
    // Tutti e otto parlano di un bambino: non esiste una scheda sanitaria di sezione.
    soggetto: 'alunno',
    disponibilePer: banchiDelGenitore(m.disponibileA),
    firma: m.firma,
    protocollo: scelte.protocollo,
    archiviazione: scelte.archiviazione,
    campi: m.campi.map(daCampoGenitore),
  }
}

function daVoceSegreteria(v: VoceRegistroPrestampati): VocePrestampato {
  return {
    slug: v.slug as SlugPrestampatoSegreteria,
    etichetta: v.etichetta,
    famiglia: 'segreteria',
    soggetto: v.soggetto,
    disponibilePer: banchiDellaSegreteria(v.disponibilePer),
    firma: requisitoDaBlocco(v.firma),
    protocollo: v.protocollo,
    archiviazione: v.archiviazione,
    campi: v.campi.map(daCampoSegreteria),
  }
}

// ─── L'elenco ───────────────────────────────────────────────────────────────────

/**
 * I diciassette, nell'ordine di `docs/prestampati/README.md`: prima gli otto della
 * famiglia (05…28), poi i nove della segreteria e delle insegnanti (30…50). L'ordine è
 * quello in cui la specifica li elenca, ed è l'unico ordine che qualcuno ha scelto.
 */
export const PRESTAMPATI: readonly VocePrestampato[] = [
  ...MODELLI_GENITORE.map(daModelloGenitore),
  ...MODELLI_SEGRETERIA.map(daVoceSegreteria),
]

/** Gli slug, nello stesso ordine. Comodo per gli elenchi e per i test. */
export const SLUG_PRESTAMPATI: readonly SlugPrestampato[] = PRESTAMPATI.map((v) => v.slug)

const PER_SLUG = new Map<string, VocePrestampato>(PRESTAMPATI.map((v) => [v.slug, v]))

/**
 * IL CANCELLO. La voce di uno slug, o `null`.
 *
 * `null` e non un'eccezione: uno slug che non esiste è una richiesta sbagliata, non un
 * guasto del server, e va risposto con un 404 — mai con un 500 che finisce nei log degli
 * errori insieme alle cose rotte davvero.
 */
export function prestampato(slug: string | null | undefined): VocePrestampato | null {
  const s = slug?.trim()
  return s ? (PER_SLUG.get(s) ?? null) : null
}

/** Vero solo per uno dei diciassette: restringe anche il tipo. */
export function slugPrestampato(slug: string | null | undefined): slug is SlugPrestampato {
  return prestampato(slug) !== null
}

/**
 * I QUATTRO ASSI su cui i diciassette si restringono. Si combinano in **AND**: ogni criterio
 * in più toglie righe, non ne aggiunge — che è la sola lettura in cui «di chi parla» e «che
 * firma vuole» insieme rispondono alla domanda che qualcuno sta facendo.
 *
 * `famiglia` e `firma` sono nati per il catalogo a schermo, e stanno qui e non nel browser
 * per una ragione misurata altrove in questo repo: una seconda definizione di «da quale
 * famiglia viene questo modello», scritta accanto a quella del registro, diverge alla prima
 * modifica e nessun gate se ne accorge. Qui la definizione resta una sola, e un pannello che
 * la usa la CHIEDE invece di ricostruirla.
 */
export interface FiltriPrestampati {
  /** Di chi parla il foglio: un bambino, una sezione, un dipendente. */
  soggetto?: SoggettoPrestampato
  /** Solo ciò che consuma (o non consuma) un numero di protocollo. */
  protocollo?: ProtocolloPrestampato
  /** Da quale dei due file dei modelli arriva: decide come si compone, non chi lo usa. */
  famiglia?: FamigliaPrestampato
  /**
   * Che sottoscrizione pretende il foglio. È il REQUISITO, non il blocco disegnato:
   * `otp_genitore` e `otp_due_genitori` restano due valori distinti, perché la differenza
   * fra una firma e due è l'unica che il blocco perde.
   */
  firma?: FirmaPrestampatoRichiesta
}

/**
 * L'elenco che un banco può generare.
 *
 * ⚠️ LA REGOLA DI LETTURA, ed è asimmetrica di proposito: **un modello dichiarato
 * disponibile al genitore lo è anche alla segreteria; non viceversa.** Chi sta allo
 * sportello deve poter stampare alla famiglia che ha davanti la stessa delega che la
 * famiglia si compilerebbe da sola — è il caso normale di una segreteria scolastica, e
 * negarglielo la manderebbe a farsi mandare il modulo per email. Il verso opposto no: il
 * verbale di infortunio, il certificato di servizio di una dipendente e il registro delle
 * presenze di una sezione non nascono dal telefono di un genitore.
 *
 * La regola vive QUI e non dentro `disponibilePer`, e la differenza conta: nel dato
 * sarebbe una riga che dichiara un permesso che nessuno ha scritto, e fra sei mesi
 * nessuno saprebbe più se «segreteria» sul n. 05 l'ha deciso qualcuno o l'ha aggiunta
 * questa funzione.
 *
 * L'insegnante NON eredita niente: vede solo ciò che la nomina.
 */
export function prestampatiPerRuolo(
  ruolo: RuoloRichiedente,
  filtri: FiltriPrestampati = {},
): VocePrestampato[] {
  return PRESTAMPATI.filter((v) => {
    const dichiarato = v.disponibilePer.includes(ruolo)
    const ereditato = ruolo === 'segreteria' && v.disponibilePer.includes('genitore')
    if (!dichiarato && !ereditato) return false
    if (filtri.soggetto && v.soggetto !== filtri.soggetto) return false
    if (filtri.protocollo && v.protocollo !== filtri.protocollo) return false
    if (filtri.famiglia && v.famiglia !== filtri.famiglia) return false
    if (filtri.firma && v.firma !== filtri.firma) return false
    return true
  })
}

/**
 * La chiave di catalogo dell'etichetta, dentro i namespace `prestampatiGenitore` e
 * `prestampatiSegreteria` (`modelli.<slugInCamelCase>`).
 *
 * Esiste perché l'etichetta che l'utente legge è tradotta e quella che il server logga
 * no: sono due testi, e due testi divergono. Quello che non può divergere è la CHIAVE, ed
 * è ciò che il test verifica — per tutti e diciassette, in tutte e due le lingue. Un
 * modello nuovo senza la sua voce di catalogo si vedrebbe altrimenti solo a schermo, dove
 * next-intl mostra il nome della chiave al posto del testo.
 */
export function chiaveEtichetta(slug: SlugPrestampato): string {
  return `modelli.${slug.replace(/_(.)/g, (_, c: string) => c.toUpperCase())}`
}
