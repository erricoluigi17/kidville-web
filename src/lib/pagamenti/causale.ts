// Il MOTORE delle causali: un modello a segnaposto reso coi dati del pagamento,
// personalizzabile per categoria (pannello Contabilità → Causali).
//
// Serve DUE strade, e da qui in avanti una sola volta:
//   · la causale del BONIFICO che il genitore ricopia — predefinito
//     «{descrizione} {codice} - per il minore {nome_completo} - {codice_fiscale} - {sede}»;
//     scriverla per intero rende univoco l'abbinamento automatico (riconciliazione), e il
//     `{codice}` dice QUALE voce si sta pagando quando la famiglia ne ha più d'una aperta
//     — il codice fiscale dice di CHI è il pagamento, non di CHE COSA;
//   · la causale della FATTURA elettronica (campo 2.1.1.11), il cui modello e i cui
//     limiti stanno in `./causale-fattura`, che di qui riusa motore e catalogo.
// Erano due configurazioni indipendenti perché sono due documenti diversi; il modo
// di RISOLVERLE (categoria → «Predefinito» → modello di fabbrica) è invece uno solo,
// e vive in `modelloCausale` — la lezione già pagata in questo repo: una regola valida
// per due strade deve vivere in un posto solo.
//
// Il CF del minore va SOLO al genitore (card «Copia», email di sollecito, XML della
// fattura), MAI nei log.
//
// Funzioni PURE, senza I/O: condivise da UI genitore, solleciti, fatture e anteprima admin.

import { sessoDaCodiceFiscale } from '@/lib/fiscale/codice-fiscale'

export interface DatiCausale {
    descrizione?: string | null
    nome?: string | null
    cognome?: string | null
    codiceFiscale?: string | null
    sede?: string | null
    /** Mese di competenza in lettere it-IT (es. «settembre»), da periodo_competenza. */
    mese?: string | null
    /** Anno di competenza (es. «2026»). */
    anno?: string | number | null
    /** Importo già formattato it-IT (es. «€ 150,00»). */
    importo?: string | null
    /** Scadenza già formattata it-IT (es. «30/09/2026»). */
    scadenza?: string | null
    /**
     * Il codice della voce in forma CANONICA, col sigillo: `#K7MXN3P`.
     *
     * Arriva **già calcolato** da chi chiama (`codiceVoce` in `./codice-voce`), esattamente
     * come `importo` e `scadenza` arrivano già formattati: questo modulo riceve valori, non
     * li produce. Calcolarlo qui vorrebbe dire che il motore delle causali deve conoscere
     * l'id della riga di pagamento — e l'anteprima dell'admin, che nessun pagamento ce l'ha
     * sottomano, dovrebbe inventarsene uno per mostrare un esempio.
     */
    codice?: string | null
}

/** «Nome Cognome» ripulito: niente spazi doppi né «undefined» da campi assenti. */
export function nomeCompleto({ nome, cognome }: Pick<DatiCausale, 'nome' | 'cognome'>): string {
    return [nome, cognome]
        .map((s) => (s ?? '').trim())
        .filter(Boolean)
        .join(' ')
}

/** true se il CF è presente e non vuoto (dopo trim). */
export function haCodiceFiscale(cf?: string | null): boolean {
    return !!(cf && cf.trim())
}

/**
 * Nome sede per la causale: MAIUSCOLO, senza il prefisso «Kidville».
 * «Kidville Giugliano» → «GIUGLIANO». Vuoto/assente → «».
 */
export function sedeCausale(nome?: string | null): string {
    return (nome ?? '').trim().toUpperCase().replace(/^KIDVILLE\s+/, '').trim()
}

/**
 * «del minore» / «della minore»: l'articolo si ricava dal SESSO scritto nel codice
 * fiscale del bambino (giorno di nascita maggiorato di 40 al femminile), non da un
 * campo dell'anagrafica — che per il sesso non esiste.
 *
 * Codice fiscale assente o illeggibile → stringa VUOTA, mai un maschile «di default».
 * Il segnaposto vive dentro un segmento («a favore {minore} {nome_completo}») e un
 * valore vuoto lo lascia comunque leggibile — «a favore Mario Rossi» — mentre un
 * genere indovinato finirebbe stampato su una fattura elettronica, cioè su un
 * documento fiscale che si corregge solo con una nota di variazione.
 */
export function articoloMinore(codiceFiscale?: string | null): string {
    const sesso = codiceFiscale ? sessoDaCodiceFiscale(codiceFiscale) : null
    if (sesso === null) return ''
    return sesso === 'F' ? 'della minore' : 'del minore'
}

/**
 * Modello PREDEFINITO del BONIFICO (retro-compatibile con la causale storica).
 *
 * Il `{codice}` sta nel PRIMO segmento, attaccato alla descrizione, e non in coda: il
 * campo causale dell'home banking si taglia **da destra**, e in coda il codice sarebbe
 * il primo pezzo a sparire — proprio nelle causali più lunghe, che sono quelle delle
 * famiglie con più voci aperte, cioè esattamente il caso per cui il codice esiste.
 *
 * Senza `codice` fra i dati il segmento rende la sola descrizione: la stringa esce
 * identica **byte per byte** a quella storica, e le causali già in circolazione
 * continuano a valere (lock in `__tests__/lib/pagamenti-causale.test.ts`).
 */
export const DEFAULT_CAUSALE_TEMPLATE = '{descrizione} {codice} - per il minore {nome_completo} - {codice_fiscale} - {sede}'

/** Una voce del catalogo dei segnaposto: chiave · etichetta · esempio d'anteprima. */
export interface SegnapostoCausale {
    chiave: string
    label: string
    esempio: string
}

/** Segnaposto disponibili per l'editor admin (chiave · etichetta · esempio d'anteprima). */
export const PLACEHOLDER_CAUSALE: SegnapostoCausale[] = [
    { chiave: 'descrizione', label: 'Descrizione voce', esempio: 'Retta Settembre 2026' },
    // ESEMPIO DI SOLE LETTERE, DI PROPOSITO — stessa disciplina del CF sintetico qui
    // sotto, e per la stessa ragione: l'esempio finisce nel tooltip del chip, cioè a
    // schermo, e questo repository è pubblico. `codiceVoce` non produce MAI una forma
    // del genere (impone almeno una cifra E almeno una lettera) ed `estraiCodiciVoce`
    // per lo stesso vincolo la rifiuta: se qualcuno ricopiasse questo esempio dentro
    // una causale vera, non aggancerebbe nessun movimento e nessuna voce di nessuno.
    // Un esempio con una cifra dentro sarebbe invece un codice a tutti gli effetti.
    { chiave: 'codice', label: 'Codice della voce', esempio: '#MNKPRTF' },
    // L'esempio è al maschile perché lo è il CF sintetico dell'anteprima: se un
    // giorno cambiasse, va cambiato anche qui — è la stessa persona finta.
    { chiave: 'minore', label: 'Del/della minore', esempio: 'del minore' },
    { chiave: 'nome_completo', label: 'Nome e cognome', esempio: 'Mario Rossi' },
    { chiave: 'nome', label: 'Nome', esempio: 'Mario' },
    { chiave: 'cognome', label: 'Cognome', esempio: 'Rossi' },
    // CF SINTETICO col metro di `@/lib/fiscale/codice-fiscale` (nota finale): codice
    // catastale `Z999` non assegnato e carattere di controllo VOLUTAMENTE sbagliato
    // (la checksum vorrebbe `S`). L'esempio finisce nel tooltip del chip, cioè a
    // schermo, e questo repository è pubblico: un codice con checksum valida —
    // com'era `RSSMRA85T10A562S`, A562 = Ferrara — potrebbe essere di una persona vera.
    { chiave: 'codice_fiscale', label: 'Codice fiscale', esempio: 'RSSMRA85T10Z999X' },
    // Segnaposto, non un plesso: l'esempio finisce nel tooltip del chip, e dal
    // 2026-07-29 le sedi sono tre — «GIUGLIANO» qui suggeriva il plesso sbagliato
    // a chi ne sta configurando un altro (R13).
    { chiave: 'sede', label: 'Sede', esempio: '<SEDE>' },
    { chiave: 'mese', label: 'Mese di competenza', esempio: 'settembre' },
    { chiave: 'anno', label: 'Anno', esempio: '2026' },
    { chiave: 'importo', label: 'Importo', esempio: '€ 150,00' },
    { chiave: 'scadenza', label: 'Scadenza', esempio: '30/09/2026' },
]

/** Valori dei segnaposto ricavati dai dati (CF/sede normalizzati). */
function valoriSegnaposto(dati: DatiCausale): Record<string, string> {
    const cf = (dati.codiceFiscale ?? '').trim().toUpperCase()
    return {
        descrizione: (dati.descrizione ?? '').trim(),
        nome: (dati.nome ?? '').trim(),
        cognome: (dati.cognome ?? '').trim(),
        nome_completo: nomeCompleto(dati),
        minore: articoloMinore(cf),
        codice_fiscale: cf,
        cf, // alias comodo
        sede: sedeCausale(dati.sede),
        mese: (dati.mese ?? '').trim(),
        anno: dati.anno != null ? String(dati.anno).trim() : '',
        importo: (dati.importo ?? '').trim(),
        scadenza: (dati.scadenza ?? '').trim(),
        codice: (dati.codice ?? '').trim().toUpperCase(),
    }
}

/**
 * Rende un MODELLO di causale sostituendo i segnaposto `{chiave}` coi dati, lavorando
 * PER SEGMENTO (separatore « - »): un segmento che contiene segnaposto ma li ha TUTTI
 * vuoti viene OMESSO (niente label penzolante tipo «per il minore» senza nome, né doppi
 * trattini); il testo fisso senza segnaposto resta sempre; gli spazi doppi si comprimono.
 * Così le parti assenti (CF/sede) spariscono con grazia e il predefinito riproduce
 * esattamente il formato storico.
 */
export function renderCausale(template: string, dati: DatiCausale): string {
    const v = valoriSegnaposto(dati)
    // Difesa: un `template` non-stringa (config malformata via API diretta) NON deve
    // far esplodere `.split` (→ 500 sull'intera lista pagamenti del genitore) → si
    // ricade sul modello predefinito.
    const tpl = typeof template === 'string' ? template : DEFAULT_CAUSALE_TEMPLATE
    return tpl
        .split(' - ')
        .map((seg) => {
            const placeholders = seg.match(/\{([a-z_]+)\}/g) ?? []
            // Segmento con segnaposto ma tutti vuoti → si omette del tutto.
            if (placeholders.length > 0 && !placeholders.some((p) => (v[p.slice(1, -1)] ?? '') !== '')) {
                return ''
            }
            return seg.replace(/\{([a-z_]+)\}/g, (_m, k: string) => v[k] ?? '').replace(/\s+/g, ' ').trim()
        })
        .filter(Boolean)
        .join(' - ')
        .trim()
}

/** Chiave della riga «Predefinito» dentro un JSONB di modelli (le altre sono slug di categoria). */
export const CHIAVE_CAUSALE_DEFAULT = 'default'

/**
 * Un JSONB FLAT di modelli: `{ default?: string, <slug-categoria>: string }`.
 * `unknown` nei valori è voluto — arriva dal database e può contenere qualunque cosa
 * (una riga salvata prima che la route filtrasse i non-stringa, o una PATCH diretta).
 */
export type ConfigCausali = Record<string, unknown> | null | undefined

/** Il valore solo se è una stringa con del testo dentro; altrimenti `undefined`. */
function modelloUtile(valore: unknown): string | undefined {
    return typeof valore === 'string' && valore.trim() !== '' ? valore : undefined
}

/**
 * Il MODELLO da usare per una voce: **riga della categoria → «Predefinito» → modello
 * di fabbrica**. È la regola che decide quale causale legge il genitore e quale finisce
 * sulla fattura, e fino a oggi era scritta tre volte (elenco pagamenti, solleciti, e
 * — mai davvero — la fatturazione).
 *
 * Una riga vuota, di soli spazi o non-stringa **conta come assente**: è la stessa
 * promessa che l'editor fa a chi svuota un campo («torna al Predefinito»), e vale anche
 * per le righe già in archivio, salvate prima che la route filtrasse i non-stringa.
 */
export function modelloCausale(
    config: ConfigCausali,
    slugCategoria: string | null | undefined,
    predefinito: string,
): string {
    return risolviModelloCausale(config, slugCategoria, predefinito).modello
}

/**
 * Da QUALE riga della configurazione viene il modello che si sta usando.
 *
 * Serve a una schermata che deve dirlo a chi sta per emettere un documento
 * irreversibile: «questa causale viene dal modello della categoria» non è la stessa
 * frase di «viene dal modello di fabbrica, perché nessuno ha configurato niente», e
 * la seconda è un invito ad andare a configurare.
 */
export type OrigineModelloCausale = 'categoria' | 'predefinito' | 'fabbrica'

/**
 * La regola di risoluzione **e** il ramo che ha vinto, in un colpo solo.
 *
 * `modelloCausale` delega qui invece di ripetere la cascata: due copie che divergono
 * manderebbero al genitore e alla fattura due stringhe diverse per lo stesso
 * pagamento — è già successo, ed è la ragione per cui questa regola vive in un posto
 * solo (v. la testata di `modelloCausale`).
 */
export function risolviModelloCausale(
    config: ConfigCausali,
    slugCategoria: string | null | undefined,
    predefinito: string,
): { modello: string; origine: OrigineModelloCausale } {
    const cfg = config && typeof config === 'object' ? config : {}
    const perCategoria = slugCategoria ? modelloUtile(cfg[slugCategoria]) : undefined
    if (perCategoria) return { modello: perCategoria, origine: 'categoria' }
    const perDefault = modelloUtile(cfg[CHIAVE_CAUSALE_DEFAULT])
    if (perDefault) return { modello: perDefault, origine: 'predefinito' }
    return { modello: predefinito, origine: 'fabbrica' }
}

/** Il segnaposto del codice, scritto UNA volta: qui lo si cerca e qui lo si inserisce. */
const SEGNAPOSTO_CODICE = '{codice}'

/**
 * Garantisce il segnaposto del codice in un modello che non lo cita.
 *
 * ─── PERCHÉ L'INSERIMENTO AUTOMATICO ESISTE ─────────────────────────────────────
 * Le tre sedi hanno modelli propri in `admin_settings.causali_config`, scritti quando il
 * codice non esisteva, e il titolare ha chiesto che il codice ci sia **comunque**.
 * Migrare quel JSONB darebbe una riga giusta oggi e sbagliata alla prima modifica
 * dell'admin: il pannello riscrive il campo per intero, quindi chi ritocca la propria
 * causale ributterebbe fuori il `{codice}` senza accorgersene, e senza un errore da
 * nessuna parte. La garanzia deve stare in LETTURA, cioè qui.
 *
 * Resta una garanzia, non un'imposizione: l'admin può mettere `{codice}` dove vuole e
 * quella posizione viene rispettata (il modello lo cita già → si torna indietro intatti,
 * niente doppioni). Riceve l'inserimento solo chi non lo scrive o lo cancella.
 *
 * ─── PERCHÉ NEL SEGMENTO DELLA DESCRIZIONE, E MAI IN CODA ───────────────────────
 * Il campo causale della banca si taglia **da destra**: accodato, il codice è il primo
 * pezzo che sparisce, e sparirebbe dalle causali più lunghe — quelle delle famiglie con
 * più voci aperte, cioè il caso per cui il codice esiste.
 */
export function conCodiceVoce(template: string): string {
    const tpl = typeof template === 'string' ? template : DEFAULT_CAUSALE_TEMPLATE
    if (tpl.includes(SEGNAPOSTO_CODICE)) return tpl
    const segmenti = tpl.split(' - ')
    // Nessun `{descrizione}` nel modello: `findIndex` torna -1 e il `Math.max` porta al
    // PRIMO segmento, che è comunque la testa della causale. Mai la coda, in nessun caso.
    const i = Math.max(0, segmenti.findIndex((s) => s.includes('{descrizione}')))
    segmenti[i] = `${segmenti[i]} ${SEGNAPOSTO_CODICE}`
    return segmenti.join(' - ')
}

/**
 * La causale consigliata col MODELLO indicato (o il predefinito): stringa da
 * copiare/incollare nel bonifico. Parti assenti omesse.
 *
 * ⚠️ DIVERGE DA `renderCausale`, E LA DIVERGENZA È LA SCELTA: solo di qui il modello
 * passa per `conCodiceVoce`. L'append vive in questo ramo e **non** dentro il motore
 * perché il motore è condiviso con la causale della fattura elettronica, che il codice
 * non lo porta (decisione del titolare, v. `./causale-fattura`). Un `if` là dentro
 * sarebbe esattamente la divergenza che il lock `causale-fattura-un-motore-solo` esiste
 * per impedire: due documenti che partono dallo stesso modello e finiscono su due
 * stringhe diverse, in silenzio — `renderCausale` omette con grazia i segmenti vuoti, e
 * la grazia è proprio ciò che renderebbe invisibile lo scarto.
 */
export function causaleBonifico(dati: DatiCausale, template?: string | null): string {
    return renderCausale(conCodiceVoce(template || DEFAULT_CAUSALE_TEMPLATE), dati)
}

/**
 * La riga per il corpo dell'email di sollecito, col modello (o il predefinito).
 * Se non c'è nulla da comporre (tutti i campi assenti) ritorna stringa vuota.
 */
export function rigaCausaleSollecito(dati: DatiCausale, template?: string | null): string {
    const causale = causaleBonifico(dati, template)
    if (!causale) return ''
    return `Per pagare tramite bonifico, indicate come causale: "${causale}".`
}
