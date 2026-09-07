import { createHash } from 'crypto'
import { interpretaFogli, tabellaDaTesto } from './estratto-conto/tabella'

// Riconciliazione bancaria: parser CSV (formati export banca italiani) e
// matcher sui pagamenti aperti. Funzioni PURE: l'I/O vive nelle route.
// Contano solo gli ACCREDITI (importo > 0); il match non si auto-conferma mai.

export interface MovimentoCsv {
    data_operazione: string // YYYY-MM-DD
    importo: number
    causale: string
    controparte: string
}

export interface MappingCsv {
    data?: string
    importo?: string
    causale?: string
    controparte?: string
}

export interface PagamentoAperto {
    id: string
    descrizione?: string | null
    importo: number | string
    importo_pagato?: number | string | null
    periodo_competenza?: string | null
    alunno_nome?: string | null
    intestatario_nome?: string | null
    /** CF dell'alunno (Riconciliazione v2): se compare nel movimento è l'aggancio più forte. */
    codice_fiscale?: string | null
    /** Serve all'elenco `cf_match` per l'«Incasso unico» multi-alunno. */
    alunno_id?: string | null
}

export interface Suggerimento {
    pagamento_id: string
    score: number
    motivi: string[]
    label?: string
    /** True se il candidato è agganciato per codice fiscale (aggancio dominante). */
    cf_match?: boolean
    /** Alunno del pagamento: serve alla UI per raggruppare i CF e aprire l'«Incasso unico». */
    alunno_id?: string | null
}

/**
 * ⚠️ `norm()` NON SI TOCCA. È dentro `hashMovimento`, cioè dentro l'impronta che impedisce
 * il doppio import: cambiarla cambierebbe TUTTE le impronte già scritte, e ogni movimento
 * già in registro tornerebbe importabile. Per confrontare le INTESTAZIONI di un foglio
 * esiste una funzione separata, `normIntestazione` — sono due mestieri diversi che si
 * assomigliano, ed è esattamente per questo che stanno in due posti.
 */
const norm = (s: string) =>
    s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim()

/**
 * L'esito di una lettura: i movimenti e i CONTATORI, tenuti separati.
 *
 * I tre campi in coda sono opzionali perché la firma di `parseCsv` non doveva cambiare per
 * i chiamanti di ieri — ma il guscio li valorizza sempre. `uscite` e `scartate` insieme
 * sarebbero un numero solo che non dice niente: sull'estratto annuale vero le uscite sono
 * 2.225 righe capite benissimo e non importabili, e leggerle come «scartate» vuol dire
 * leggere un allarme su un import riuscito.
 */
export interface EsitoParseCsv {
    movimenti: MovimentoCsv[]
    /** Righe dopo l'intestazione senza data o senza importo leggibile. */
    scartate: number
    /** Le intestazioni come sono state risolte (già unite, se erano su due righe). */
    intestazioni: string[]
    /** Righe leggibilissime con importo ≤ 0: sono addebiti, non si importano. */
    uscite?: number
    /** Righe oltre il tetto: il troncamento non è più silenzioso. */
    troncate?: number
    /** Movimenti rimasti senza controparte: il campanello se la banca cambia forma. */
    senzaOrdinante?: number
}

/**
 * IL TESTO DI UN CSV → I MOVIMENTI. Oggi è un GUSCIO, e il motivo vale la pena dirlo.
 *
 * Fino a ieri qui viveva un secondo interprete, scritto solo per il CSV: sinonimi propri,
 * separatore dedotto dalla prima riga, intestazione su una riga sola. Sul file vero della
 * banca dava **zero movimenti su 65** — e la copia CSV di ogni regola divergeva da quella
 * Excel al primo ritocco. L'interprete è uno solo (`estratto-conto/tabella.ts`): un CSV è
 * una matrice di celle di stringhe, un foglio Excel una matrice di celle di numeri, e la
 * differenza finisce lì.
 *
 * La firma resta identica: chi passava di qui non se ne accorge.
 */
export function parseCsv(contenuto: string, mapping?: MappingCsv): EsitoParseCsv {
    const { movimenti, scartate, uscite, troncate, senzaOrdinante, intestazioni } = interpretaFogli(
        [{ nome: 'csv', righe: tabellaDaTesto(contenuto) }],
        { mapping },
    )
    return { movimenti, scartate, intestazioni, uscite, troncate, senzaOrdinante }
}

/** Impronta anti re-import: stesso movimento (data+importo+causale) = stesso hash. */
export function hashMovimento(m: MovimentoCsv): string {
    return createHash('sha256')
        .update(`${m.data_operazione}|${m.importo.toFixed(2)}|${norm(m.causale)}`)
        .digest('hex')
}

const MESI_IT = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre']

/**
 * Regex del codice fiscale italiano: 6 lettere + LLLLLLDDLDDLDDDL.
 * `\b` àncora davanti/dietro: senza, "…RSSMRA85T10A562SXX" o un run di lettere più
 * lungo passerebbe come match. Solo forma ESATTA a 16 caratteri, nessun fuzzy.
 */
const CF_REGEX = /\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b/g

/**
 * Variante OMOCODIA: quando due persone collidono, l'Agenzia sostituisce le cifre (da destra)
 * con lettere secondo la mappa fissa 0→L 1→M 2→N 3→P 4→Q 5→R 6→S 7→T 8→U 9→V. Le posizioni
 * "numeriche" del CF accettano allora anche quelle lettere. È comunque un match ESATTO di forma,
 * non un fuzzy: senza questo ramo un CF omocodico non verrebbe MAI riconosciuto.
 */
const CF_OMOCODE_REGEX = /\b[A-Z]{6}[\dLMNPQRSTUV]{2}[A-Z][\dLMNPQRSTUV]{2}[A-Z][\dLMNPQRSTUV]{3}[A-Z]\b/g

/**
 * Estrae i codici fiscali DISTINTI presenti nel testo (causale+controparte).
 * Porta a MAIUSCOLO e applica sia la regex esatta sia quella omocodica. Prova anche una
 * variante SENZA SPAZI: alcuni export bancari spezzano il CF ("RSSMRA 85T10A562S") e, quando
 * è delimitato da punteggiatura, ricomporlo lo rende di nuovo agganciabile. Nessun match
 * cross-token spurio: i `\b` restano ancorati ai delimitatori non-parola superstiti.
 */
export function estraiCodiciFiscali(testo: string): string[] {
    if (!testo) return []
    const su = testo.toUpperCase()
    const trovati = new Set<string>()
    for (const variante of [su, su.replace(/\s+/g, '')]) {
        for (const regex of [CF_REGEX, CF_OMOCODE_REGEX]) {
            const match = variante.match(regex)
            if (match) for (const cf of match) trovati.add(cf)
        }
    }
    return [...trovati]
}

/** Bonus dell'aggancio per CF: domina qualunque combinazione di segnali deboli (max 100). */
const CF_BONUS = 1000

/**
 * ─── LE DUE SOGLIE DELL'AGGANCIO HANNO UN NOME, E NON È COSMESI ──────────────
 *
 * `60` e `20` erano due numeri anonimi dentro `suggerisciMatchPreparato`: «il
 * migliore vale almeno 60 E stacca il secondo di almeno 20». È la definizione di
 * *aggancio forte* di questo progetto, e da oggi la stessa definizione risponde a
 * una SECONDA domanda — «questo bonifico sembra di un'altra sede?»
 * (`agganciaFuoriSede`), che confronta il migliore di FUORI col migliore di
 * DENTRO invece del primo col secondo.
 *
 * Due assi diversi, la stessa soglia. Ricopiare 60 e 20 nella rotta creerebbe due
 * copie che un giorno divergono — e divergerebbero in silenzio, perché nessuna
 * delle due è sbagliata da sola.
 */
export const SOGLIA_AGGANCIO = 60
export const DISTACCO_AGGANCIO = 20

export interface RisultatoMatch {
    stato: 'suggerito' | 'da_abbinare'
    suggerimenti: Suggerimento[]
    /** Presente solo con almeno un aggancio CF: true se ≥2 alunni distinti → «Incasso unico». */
    multi?: boolean
    /** Presente solo con almeno un aggancio CF: l'elenco dei pagamenti agganciati per CF. */
    cf_match?: { pagamento_id: string; alunno_id: string | null }[]
}

/**
 * UN PAGAMENTO APERTO CON I SUOI SEGNALI GIÀ CALCOLATI.
 *
 * Non è un'ottimizzazione a occhio: sull'estratto annuale vero sono **6.775 accrediti ×
 * 545 pagamenti aperti = 3,7 milioni di confronti**, e dentro ognuno c'era una `norm()` —
 * cioè un `normalize('NFD')` — rifatta ogni volta sugli stessi nomi, sulle stesse
 * descrizioni, sugli stessi periodi. I nomi dei pagamenti aperti non cambiano fra un
 * movimento e l'altro: si normalizzano UNA volta, all'inizio.
 */
export interface PagamentoPreparato {
    id: string
    alunnoId: string | null
    /** Residuo, arrotondato al centesimo come lo era nel ciclo. */
    residuo: number
    /** I token (>2 caratteri) di ogni nome, già normalizzati: uno per alunno, uno per intestatario. */
    tokenNomi: string[][]
    /** Il mese italiano del periodo di competenza, già risolto. */
    mese: string | null
    /** L'anno-mese `YYYY-MM` del periodo di competenza. */
    ym: string | null
    /** La descrizione normalizzata, o `null` quando il pagamento non ne ha una. */
    descrizioneNorm: string | null
    /** Il CF dell'alunno in MAIUSCOLO, o `null`. */
    cf: string | null
}

/**
 * I pagamenti aperti, normalizzati una volta sola.
 *
 * Il risultato è di sola lettura per progetto: si passa allo stesso `suggerisciMatchPreparato`
 * per ogni movimento del file, e nessuna chiamata lo consuma o lo modifica.
 */
export function preparaAperti(aperti: PagamentoAperto[]): PagamentoPreparato[] {
    return aperti.map((p) => {
        const nomi = [p.alunno_nome, p.intestatario_nome].filter(Boolean) as string[]
        const mese = p.periodo_competenza ? MESI_IT[new Date(p.periodo_competenza).getMonth()] ?? null : null
        return {
            id: p.id,
            alunnoId: p.alunno_id ?? null,
            residuo: Math.round((Number(p.importo) - Number(p.importo_pagato || 0)) * 100) / 100,
            tokenNomi: nomi.map((n) => norm(n).split(' ').filter((t) => t.length > 2)),
            mese,
            ym: p.periodo_competenza ? p.periodo_competenza.slice(0, 7) : null,
            // ⚠️ `p.descrizione` VUOTA non è `''` normalizzato: è «nessuna descrizione».
            //    `testo.includes('')` è sempre vero, e regalerebbe 10 punti a chiunque.
            descrizioneNorm: p.descrizione ? norm(p.descrizione) : null,
            cf: p.codice_fiscale ? String(p.codice_fiscale).toUpperCase() : null,
        }
    })
}

/**
 * Score di un pagamento aperto rispetto al movimento:
 *   +1000 CF dell'alunno nel movimento (DOMINANTE) · +50 residuo esattamente uguale
 *   +25 nome (alunno/intestatario) in causale · +15 mese di competenza citato
 *   +10 descrizione contenuta.
 * "suggerito" con best ≥ 60 E distacco ≥ 20 dal secondo, OPPURE con almeno un CF agganciato.
 * Un CF forza lo stato a 'suggerito' (giallo): MAI auto-conferma. Solo i pagamenti in `aperti`
 * (residuo aperto) sono candidati: un CF che punta a un alunno senza voce aperta NON eleva nulla.
 *
 * Questa è la strada VELOCE: prende i pagamenti già preparati. `suggerisciMatch` qui sotto
 * resta il guscio a una riga, e un test di equivalenza sorveglia che le due strade dicano la
 * stessa cosa — perché due strade che possono divergere, prima o poi divergono.
 */
export function suggerisciMatchPreparato(mov: MovimentoCsv, aperti: PagamentoPreparato[]): RisultatoMatch {
    const testo = norm(`${mov.causale} ${mov.controparte}`)
    const cfSet = new Set(estraiCodiciFiscali(`${mov.causale} ${mov.controparte}`))
    const candidati: Suggerimento[] = []
    const cfMatches: { pagamento_id: string; alunno_id: string | null }[] = []
    const alunniConCf = new Set<string>()

    for (const p of aperti) {
        let score = 0
        const motivi: string[] = []
        if (p.residuo === mov.importo) { score += 50; motivi.push('importo esatto') }

        const nomeTrovato = p.tokenNomi.some(
            (tokens) => tokens.length > 0 && tokens.every((t) => testo.includes(t)),
        )
        if (nomeTrovato) { score += 25; motivi.push('nome in causale') }

        if (p.ym !== null) {
            if ((p.mese && testo.includes(p.mese)) || testo.includes(p.ym)) { score += 15; motivi.push('periodo citato') }
        }

        if (p.descrizioneNorm !== null && testo.includes(p.descrizioneNorm)) { score += 10; motivi.push('descrizione in causale') }

        const cfMatch = p.cf !== null && cfSet.has(p.cf)
        if (cfMatch) {
            score += CF_BONUS
            motivi.push('codice fiscale')
            cfMatches.push({ pagamento_id: p.id, alunno_id: p.alunnoId })
            if (p.alunnoId) alunniConCf.add(p.alunnoId)
        }

        if (score > 0) candidati.push({ pagamento_id: p.id, score, motivi, alunno_id: p.alunnoId, ...(cfMatch ? { cf_match: true } : {}) })
    }

    candidati.sort((a, b) => b.score - a.score)
    // Con agganci CF NON si cappano i candidati per codice fiscale a 3: una famiglia con ≥4 figli
    // perderebbe i suggerimenti oltre il terzo, mentre il totale precompilato è l'intero bonifico →
    // l'«Incasso unico» allocherebbe corto. Si tengono TUTTI i cf_match, poi si riempie fino a 3 con
    // i migliori non-CF. Senza CF il comportamento resta identico (i primi 3 per score).
    const cfMatched = candidati.filter((c) => c.cf_match)
    const nonCf = candidati.filter((c) => !c.cf_match)
    const top = [...cfMatched, ...nonCf].slice(0, Math.max(3, cfMatched.length))
    const best = top[0]
    const second = top[1]
    const haCf = cfMatches.length > 0
    // Un CF agganciato vale sempre "suggerito" (giallo): anche con due fratelli a pari punteggio,
    // dove il distacco è 0 e la regola standard direbbe "da_abbinare".
    const suggerito = haCf || (!!best && best.score >= SOGLIA_AGGANCIO && (!second || best.score - second.score >= DISTACCO_AGGANCIO))

    const out: RisultatoMatch = { stato: suggerito ? 'suggerito' : 'da_abbinare', suggerimenti: top }
    if (haCf) {
        out.multi = alunniConCf.size >= 2
        out.cf_match = cfMatches
    }
    return out
}

/**
 * Il guscio di sempre: prepara e cerca in un colpo solo.
 *
 * Resta esportato con la firma di ieri perché è quello che usano i test e chi cerca il
 * match di UN movimento. Su un file intero si chiama `preparaAperti` una volta e poi
 * `suggerisciMatchPreparato` per ogni riga.
 */
export function suggerisciMatch(mov: MovimentoCsv, aperti: PagamentoAperto[]): RisultatoMatch {
    return suggerisciMatchPreparato(mov, preparaAperti(aperti))
}

// ─── «QUESTO BONIFICO SEMBRA DI UN'ALTRA SEDE» ───────────────────────────────
//
// IL DIFETTO, misurato in produzione il 2026-09-07: i suggerimenti si calcolano
// contro i pagamenti aperti di TUTTE le sedi — è deliberato, l'estratto conto
// della banca è unico e cross-sede — ma la schermata poi mostra a ogni segreteria
// solo i candidati della PROPRIA sede. Su 236 movimenti con suggerimenti, 86 hanno
// candidati in più plessi e, per l'operatore di Giugliano, **64 righe non
// confermate hanno l'aggancio forte altrove con candidati locali deboli**: 64
// righe che invitavano a un abbinamento sbagliato, cioè a registrare l'incasso
// sulla voce di un altro bambino. (Il «234 / 85 / 67» di poche ore prima non
// escludeva le confermate, ed è già invecchiato: il registro cresce.)
//
// La domanda è la stessa di `suggerisciMatchPreparato` — «c'è un aggancio forte?»
// — posta su un ALTRO ASSE: non il primo contro il secondo, ma il migliore di
// FUORI contro il migliore di DENTRO. Stesse due soglie, un posto solo.

/** Un candidato come lo vede questa domanda: chi, quanto forte, e se è un CF. */
export interface CandidatoSede {
  pagamento_id: string
  score: number
  cf_match?: boolean
}

/** Il verdetto: la sede che ha l'aggancio forte, e se a dirlo è un codice fiscale. */
export interface VerdettoAltraSede {
  scuola_id: string
  per_cf: boolean
}

/**
 * Il bonifico ha un aggancio forte FUORI dalle sedi dell'operatore?
 *
 * Funzione PURA: nessuna lettura, nessun I/O. `sedeDi` è la mappa
 * `pagamento → scuola_id` che la rotta ha già in mano (`pagamenti(id, scuola_id)`,
 * la stessa query che minimizza i label): il verdetto non costa nessuna query.
 *
 * ─── LA REGOLA, PER ESTESO ───────────────────────────────────────────────────
 *  1. i candidati si partizionano in DENTRO (sede risolta e in `sediAttive`),
 *     FUORI (sede risolta e non in `sediAttive`) e IGNOTI (sede assente);
 *  2. un `cf_match` DENTRO chiude la domanda: `null`, e nessuno degli altri due
 *     punti viene interrogato — è l'aggancio più forte che esista;
 *  3. un `cf_match` FUORI decide da solo: `per_cf: true`, e la sede è quella del
 *     cf_match col punteggio più alto;
 *  4. altrimenti vale il distacco: `bestFuori >= SOGLIA_AGGANCIO` **e**
 *     `bestFuori - bestDentro >= DISTACCO_AGGANCIO`, con `bestDentro = 0` quando
 *     dentro non c'è nessuno;
 *  5. in ogni altro caso `null`.
 *
 * ⚠️ GLI IGNOTI NON CONTANO DA NESSUNA PARTE, ed è una decisione: `pagamenti.scuola_id`
 * è NULLABLE (misurato), e un pagamento che non è stato letto — o che è sparito —
 * non è «di un'altra sede». Contarlo fra i FUORI accuserebbe un plesso a caso;
 * contarlo fra i DENTRO alzerebbe `bestDentro` e spegnerebbe un verdetto vero.
 *
 * ⚠️ `bestDentro = 0` E NON «VERDETTO AUTOMATICO» QUANDO DENTRO È VUOTO. Un
 * bonifico con un solo candidato debole altrove non è «di un'altra sede»: è un
 * bonifico che nessuno ha capito, e dirlo sarebbe una bugia detta con sicurezza.
 * La soglia resta la stessa in tutti e due i casi.
 *
 * ⚠️ IL CASO DI BORDO CHE SEMBRA UN BUG E NON LO È — sta scritto qui perché è
 * quello che qualcuno segnalerà: i suggerimenti si calcolano ALL'IMPORT e si
 * cappano a 3 non-CF (`suggerisciMatchPreparato`). Se i primi tre sono tutti di
 * Cesa, il candidato di Giugliano **non è mai stato salvato**: `bestDentro` vale
 * 0, il distacco è tutto il punteggio di Cesa, e la regola scatta. È voluto — la
 * schermata non ha nessun candidato locale da proporre, e proprio per questo
 * l'unica cosa vera da dire è che il bonifico sembra di un altro plesso.
 *
 * ⚠️ IL CF DENTRO BATTE TUTTO (il punto 2), e serve al bonifico di famiglia coi
 * fratelli in due plessi: lì il candidato locale È un aggancio per codice fiscale
 * — il più forte che esista, quello da cui si apre l'«Incasso unico» — e annunciare
 * «i suggerimenti qui sotto sono deboli» sarebbe semplicemente falso.
 *
 * ⚠️ E LA GUARDIA È UN'USCITA, NON UNA CONDIZIONE DEL SOLO RAMO per_cf. Fino al
 * 2026-09-07 era `&& !cfDentro` sul punto 3, e qui c'era scritto che il punto 4
 * «lo risolve da sé: due punteggi CF quasi pari, distacco ~0». Non è vero, ed è
 * aritmetica: un `cf_match` vale `CF_BONUS` (1000) PIÙ i segnali deboli, che
 * arrivano a 100. Bastano i +50 dell'«importo esatto» da un lato solo per fare
 * distacco 50 — più che sufficiente — e il verdetto scattava proprio sul caso che
 * questo paragrafo diceva di proteggere. In produzione oggi (2026-09-07) i
 * movimenti con un CF dentro E uno fuori sono 0 su 236: era latente, non attivo.
 */
export function agganciaFuoriSede(
  suggerimenti: readonly CandidatoSede[],
  sedeDi: (pagamentoId: string) => string | null | undefined,
  sediAttive: ReadonlySet<string>,
): VerdettoAltraSede | null {
  const dentro: CandidatoSede[] = []
  const fuori: { candidato: CandidatoSede; sede: string }[] = []
  for (const s of suggerimenti) {
    const sede = sedeDi(s.pagamento_id)
    // `null`, `undefined` e la stringa vuota sono tutti «non lo so»: si esce, e
    // il candidato non pesa da nessuna delle due parti.
    if (sede == null || sede === '') continue
    if (sediAttive.has(sede)) dentro.push(s)
    else fuori.push({ candidato: s, sede })
  }
  return agganciaForte(dentro, fuori)
}

/** La sede che l'app ha DEDOTTO per un movimento, e quanto è sicura di dirlo. */
export interface SedeDedotta {
  scuola_id: string
  /** `true` solo quando a deciderlo è un codice fiscale: l'aggancio più forte che esista. */
  certa: boolean
}

/**
 * Di quale sede sembra questo bonifico?
 *
 * Sorella di `agganciaFuoriSede`, stessa regola e STESSE SOGLIE — non una loro
 * parafrasi: entrambe passano da `agganciaForte`, cambia solo come si partizionano
 * i candidati. Là il taglio è il perimetro dell'operatore, qui è la sede candidata:
 * per ogni sede X si chiede «X batte tutte le altre?», con le stesse due soglie.
 *
 * ⚠️ RISPONDE `null` MOLTO SPESSO, ed è il punto. Sotto soglia, o con due sedi che
 * pareggiano, non si nomina un plesso: misurato sui 219 movimenti non confermati di
 * produzione, 9 hanno un pareggio di punteggio massimo fra sedi diverse, e su quelli
 * scegliere «la prima dell'elenco» sarebbe una bugia detta con sicurezza — la stessa
 * che `agganciaFuoriSede` si vieta. Il `null` è il bidone «sede non riconosciuta»,
 * cioè le righe che il titolare chiama «i rossi da controllare».
 *
 * ⚠️ NON si allarga la soglia per dedurre di più. Nominare un plesso sulla base di
 * 25 punti di somiglianza di nome renderebbe FALSA l'avvertenza che la schermata
 * scrive accanto al filtro: «questa è la sede che l'app ha dedotto».
 *
 * Due sedi non possono vincere insieme: se entrambe avessero un `cf_match`, ognuna
 * sarebbe il `cfDentro` dell'altra e `agganciaForte` risponderebbe `null` a tutt'e
 * due — la regola si difende da sola, senza un caso speciale scritto qui.
 *
 * Funzione PURA. `sedeDi` è la stessa mappa `pagamento → scuola_id` che la rotta ha
 * già in mano: nessuna query in più.
 */
export function sedeDedotta(
  suggerimenti: readonly CandidatoSede[],
  sedeDi: (pagamentoId: string) => string | null | undefined,
): SedeDedotta | null {
  const conSede: { candidato: CandidatoSede; sede: string }[] = []
  for (const s of suggerimenti) {
    const sede = sedeDi(s.pagamento_id)
    if (sede == null || sede === '') continue
    conSede.push({ candidato: s, sede })
  }
  if (conSede.length === 0) return null

  const vincitori: SedeDedotta[] = []
  for (const sede of new Set(conSede.map((c) => c.sede))) {
    const fuori = conSede.filter((c) => c.sede === sede)
    const dentro = conSede.filter((c) => c.sede !== sede).map((c) => c.candidato)
    const v = agganciaForte(dentro, fuori)
    if (v) vincitori.push({ scuola_id: v.scuola_id, certa: v.per_cf })
  }
  return vincitori.length === 1 ? vincitori[0]! : null
}

/**
 * I punti 2-5 della regola qui sopra, con la PARTIZIONE COME PARAMETRO.
 *
 * ⚠️ È questo che rende l'estrazione lecita: la regola non è «il migliore contro
 * il secondo», è «il migliore di UN insieme contro il migliore dell'ALTRO», e le
 * due asimmetrie che la fanno funzionare — l'uscita quando `fuori` è vuoto, e
 * `bestDentro = 0` quando `dentro` è vuoto — vivono DENTRO questa funzione, non
 * fuori. Una versione «cieca al perimetro», che confrontasse il migliore col
 * secondo dell'elenco, sarebbe un'altra regola: misurata sui 219 movimenti non
 * confermati di produzione divergerebbe su 39 righe per un operatore di Aversa e
 * su altre 39 per uno di Cesa.
 *
 * Chi chiama decide che cosa siano «dentro» e «fuori»: `agganciaFuoriSede`
 * partiziona per PERIMETRO dell'operatore, `sedeDedotta` per SEDE candidata. La
 * regola è la stessa, e non esiste in due copie.
 */
function agganciaForte(
  dentro: readonly CandidatoSede[],
  fuori: readonly { candidato: CandidatoSede; sede: string }[],
): VerdettoAltraSede | null {
  if (fuori.length === 0) return null

  // ⚠️ UN `cf_match` DENTRO CHIUDE LA DOMANDA, E LA CHIUDE PER TUTTI I PUNTI.
  // Fino al 2026-09-07 questa guardia era appesa al solo ramo per_cf (`&& !cfDentro`)
  // e il commento sopra sosteneva che al punto 3 il caso «si risolve da sé, due
  // punteggi CF quasi pari». È falso, e la prova è aritmetica: un `cf_match` vale
  // `CF_BONUS` (1000) PIÙ i segnali deboli, che arrivano a 100 — il solo «importo
  // esatto» ne fa 50, cioè più del distacco richiesto. Sul bonifico di famiglia coi
  // fratelli in due plessi, con la quota di Cesa pari al bonifico e quella di casa no,
  // il verdetto scattava: il popup annunciava «i suggerimenti qui sotto sono deboli»
  // sopra un aggancio per CODICE FISCALE e ne declassava il «Conferma questo».
  const cfDentro = dentro.some((s) => s.cf_match === true)
  if (cfDentro) return null

  const cfFuori = fuori.filter((f) => f.candidato.cf_match === true)
  if (cfFuori.length > 0) {
    const migliore = cfFuori.reduce((a, b) => (b.candidato.score > a.candidato.score ? b : a))
    return { scuola_id: migliore.sede, per_cf: true }
  }

  const bestFuori = fuori.reduce((a, b) => (b.candidato.score > a.candidato.score ? b : a))
  const bestDentro = dentro.reduce((max, s) => Math.max(max, s.score), 0)
  const forte = bestFuori.candidato.score >= SOGLIA_AGGANCIO
    && bestFuori.candidato.score - bestDentro >= DISTACCO_AGGANCIO
  return forte ? { scuola_id: bestFuori.sede, per_cf: false } : null
}
