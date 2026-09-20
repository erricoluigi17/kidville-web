/**
 * «CERTO» O «NON CERTO» — il predicato dell'abbinamento automatico.
 *
 * ─── COSA DECIDE, E COSA NON DECIDE ─────────────────────────────────────────
 * Guarda UN movimento bancario e l'elenco delle voci aperte che lo riguardano, e
 * risponde a una domanda sola: **questo bonifico si può incassare da solo, senza
 * che una persona guardi?** Quattro risposte possibili — `auto-singola`,
 * `auto-composita`, `suggerito` (il giallo di oggi, che una persona conferma) e
 * `da_abbinare` (il rosso di oggi, che resta rosso).
 *
 * Non scrive niente, non legge niente, non logga niente: nessun I/O, nessun
 * Supabase, nessun `Date.now()`. Stesso ingresso → stesso esito, sempre. È la
 * condizione perché la regola sia collaudabile per intero in `vitest` invece che
 * osservata in produzione sui bonifici di famiglie vere.
 *
 * ─── PERCHÉ NON STA DENTRO `riconciliazione.ts` ─────────────────────────────
 * Quel file è territorio congelato: `norm()` e `hashMovimento()` sono l'impronta
 * anti-doppio-import, e toccarle renderebbe re-importabile tutto lo storico. In
 * più `PagamentoAperto` — la forma che il matcher pretende — **non porta** i campi
 * che servono qui (sconto già scontato nel residuo, sede, stato dell'alunno,
 * oblio, contenitore): allargarla farebbe credere che il PUNTEGGIO sappia di sedi
 * e di sconti. Non lo sa. Di là si importa solo `estraiCodiciFiscali`, che è una
 * funzione pura di testo.
 *
 * ─── PERCHÉ SI ENUMERANO I SOTTOINSIEMI ─────────────────────────────────────
 * La formulazione ingenua — «c'è una voce il cui residuo è pari all'importo,
 * quindi è quella» — sceglie, e sceglie in silenzio. Due fratelli: A ha una voce
 * da 100 €, B ne ha due da 50 €, arriva un bonifico da 100 €. La regola ingenua
 * direbbe «certo, la voce di A», mentre `{B1, B2}` quadra esattamente allo stesso
 * modo: incassare su A vuol dire lasciare aperte le due di B e fatturare a chi non
 * ha pagato. Non serve nemmeno che i bambini siano due: voci da 100/60/40 con un
 * bonifico da 100 hanno le stesse due soluzioni dentro un solo fascicolo.
 * L'enumerazione è l'unica formulazione che **non sceglie**: se le combinazioni
 * esatte sono due, l'esito è `suggerito` e decide una persona.
 *
 * Costa poco perché l'insieme è piccolo, e la misura NON è di questo lotto: è
 * quella che già regge `MAX_RIGHE_PER_ELENCO` in `./conciliazione-registra`,
 * fatta in produzione il **2026-09-13 su 499 famiglie con voci aperte** —
 * **massimo 4** voci aperte per famiglia, p99 = 3, **media 1,24**. Si cita per
 * nome invece di riscriverne i numeri sotto una data nuova: attribuire a un
 * conteggio mai eseguito una data e un committente è esattamente il modo in cui
 * la documentazione di questo repository è già arrivata a dire il falso su sé
 * stessa. Il tetto dichiarato è **12 voci** — 2^12 = **4.096** sottoinsiemi nel
 * caso peggiore, un caso che non si presenta — e oltre quel tetto non si
 * enumera: `troppe_voci`, e decide una persona.
 *
 * ─── L'ARITMETICA È QUELLA DEL RESTO DEL REPO ───────────────────────────────
 * L'arrotondamento al centesimo è `round2` di `./transazioni-quadratura`, lo
 * stesso che usano la quadratura della transazione di famiglia e la composizione
 * di un bonifico. Un secondo arrotondamento scritto qui sarebbe una seconda
 * verità sullo stesso centesimo, e le due divergerebbero al primo ritocco.
 * Tolleranza ZERO oltre il centesimo: `33,33 + 33,33 + 33,34` fa 100,00 e quadra,
 * `33,333 × 3` fa 99,99 e non quadra. Un acconto lo decide una persona.
 *
 * ⚠️ QUESTO MODULO NON È ANCORA CHIAMATO DA NESSUNO. Produce un verdetto; chi lo
 * userà per scrivere arriva dopo, e porterà con sé i propri log.
 */

import { estraiCodiciFiscali } from './riconciliazione'
import { codiceVoce, estraiCodiciVoce } from './codice-voce'
import { round2 } from './transazioni-quadratura'

// ─── Le tre manopole, in testa al file e non sparse nel corpo ────────────────

/**
 * ⚠️ IL RITIRO NON È UNA RINUNCIA, ed è una decisione misurata, non una
 * dimenticanza: **una voce già a registro resta incassabile anche dopo il
 * ritiro**. Un insoluto si salda anche quando il bambino non frequenta più, ed è
 * il caso normale di fine anno — il predicato non crea mai voci nuove, incassa
 * solo su quelle che esistevano già.
 *
 * Il campo `alunnoRitirato` arriva comunque nella forma d'ingresso e la guardia
 * esiste comunque, spenta: invertire la decisione deve costare UNA riga, non
 * un'archeologia in un file di storia.
 *
 * L'annotazione `: boolean` è voluta. Senza, TypeScript restringe il tipo a
 * `false`, il ramo qui sotto diventa codice che il compilatore sa morto, e
 * chi invertisse la costante si troverebbe un errore invece di un comportamento.
 */
export const RINUNCIA_SE_RITIRATO: boolean = false

/** Oltre questo numero di voci candidate non si enumera: vedi la testata. */
export const TETTO_VOCI_CANDIDATE = 12

/**
 * Il tetto sull'importo, in euro.
 *
 * ⚠️ NON È UN SECONDO NUMERO: è **lo stesso** di `MAX_IMPORTO_EURO` in
 * `./conciliazione-registra`, con la stessa identica motivazione, e i due si
 * muovono INSIEME. Se un giorno uno solo dei due si alzasse, questo predicato
 * direbbe «certo» su un importo che la registrazione rifiuta — o il contrario —
 * e nessuno dei due file se ne accorgerebbe.
 *
 * Il riferimento è per NOME e senza numero di riga: un intervallo citato resta
 * fermo mentre il file intorno si muove — ed è già bastato quello, qui dentro,
 * perché una documentazione esatta il giorno in cui è stata scritta dicesse il
 * falso due settimane dopo.
 *
 * Non lo si importa perché sarà `conciliazione-registra` a chiamare
 * `valutaCertezza`: l'import inverso chiuderebbe un ciclo e trascinerebbe
 * logger e Supabase dentro un modulo dichiarato puro. A tenerli agganciati è
 * allora il test `expect(TETTO_IMPORTO).toBe(MAX_IMPORTO_EURO)` in
 * `__tests__/lib/riconciliazione-auto.test.ts`, che diventa rosso al primo
 * scostamento — il legame è verificato, non promesso in un commento.
 *
 * Perché proprio un milione: `round2` moltiplica per 100 PRIMA di dividere,
 * quindi da un input finito come `1e308` produce `Infinity`, e sopra
 * `Number.MAX_SAFE_INTEGER` il centesimo smette proprio di esistere — due numeri
 * diversi diventano lo stesso `double` e «quadra» risponde di sì dove non sa
 * niente. Un milione sta dodici ordini di grandezza sotto quella soglia e due
 * sopra il bonifico scolastico peggiore plausibile. È lo stesso difetto già
 * dichiarato in `conciliazione-composita.ts`; qui si chiude alla porta, dove
 * l'importo entra.
 */
export const TETTO_IMPORTO = 1_000_000

// ─── Le forme ───────────────────────────────────────────────────────────────

/** Una voce aperta, coi soli campi che servono a DECIDERE. */
export interface VoceCertezza {
    pagamentoId: string
    alunnoId: string | null
    scuolaId: string | null
    /**
     * Residuo EFFETTIVO: importo meno sconto meno incassato, clampato a zero —
     * cioè `residuoEffettivo` di `./aging`, calcolato dal chiamante.
     * ⚠️ **Mai quello del matcher** (`importo − importo_pagato`): su una voce
     * scontata i due numeri divergono, e chi dice «certo» userebbe lo sbagliato.
     */
    residuo: number
    /** Codice fiscale dell'ALUNNO, in MAIUSCOLO. */
    cf: string | null
    /** Il fascicolo è già passato per l'oblio GDPR. */
    alunnoAnonimizzato: boolean
    /** L'alunno non frequenta più. Vedi `RINUNCIA_SE_RITIRATO`: NON è una rinuncia. */
    alunnoRitirato: boolean
    /** Sede E2E/Demo: esiste in produzione, e una macchina non incassa lì. */
    sedeFittizia: boolean
    /** `pagamenti.tipo === 'padre'`: il contenitore delle rate, non una voce da incassare. */
    contenitore: boolean
}

/** Il movimento bancario, coi soli campi che servono a DECIDERE. */
export interface MovimentoDaValutare {
    importo: number
    causale: string
    controparte: string
    /** Valorizzato = riga già legata a un pagamento in passato, cioè RIAPERTA. */
    pagamentoIdPrecedente: string | null
}

/** I motivi che AGGANCIANO: perché questo esito è certo. */
export type MotivoAggancio =
    | 'codice_voce'
    | 'codice_fiscale'
    | 'residuo_esatto'
    | 'somma_esatta'

/**
 * I motivi che RINUNCIANO: perché questo esito NON è certo.
 *
 * ⚠️ `alunno_ritirato` è **dormiente**: non viene mai emesso finché
 * `RINUNCIA_SE_RITIRATO` è `false`. Sta nell'unione perché invertire quella
 * costante deve restare una riga sola.
 */
export type MotivoRinuncia =
    | 'nessun_identificativo'
    | 'identificativo_sconosciuto'
    | 'voce_gia_saldata'
    | 'alunno_senza_voci_aperte'
    | 'importo_non_quadra'
    | 'residuo_non_capiente'
    | 'piu_combinazioni'
    | 'troppe_voci'
    | 'sede_ignota'
    | 'sede_fittizia'
    | 'alunno_anonimizzato'
    | 'alunno_ritirato'
    | 'voce_contenitore'
    | 'importo_fuori_scala'
    | 'movimento_gia_legato'
    | 'alunno_mancante'

/**
 * I motivi sono ENUMERATI, non prosa libera: li leggeranno un log (dove la
 * redazione è a lista bianca e una frase in italiano sarebbe redatta comunque) e
 * una schermata (dove vanno tradotti). Una stringa libera qui diventerebbe testo
 * non traducibile in entrambi i posti.
 */
export type MotivoCertezza = MotivoAggancio | MotivoRinuncia

/** Una voce su cui il verdetto dice di incassare, con la quota che le tocca. */
export interface VoceIncassabile {
    pagamentoId: string
    alunnoId: string | null
    /** Mai nullo: una voce senza sede non arriva mai fin qui (`sede_ignota`). */
    scuolaId: string
    /** Il residuo della voce, al centesimo: la combinazione quadra ESATTAMENTE. */
    importo: number
}

export type EsitoCertezza = {
    esito: 'auto-singola' | 'auto-composita' | 'suggerito' | 'da_abbinare'
    /**
     * ⚠️ Popolato **solo** sugli esiti automatici. Su `suggerito` e `da_abbinare`
     * è vuoto di proposito: non sono «le voci proposte», sono «le voci su cui si
     * incassa», e consegnare un elenco a chi non deve incassare è il modo in cui
     * un chiamante distratto trasforma un giallo in una scrittura.
     */
    voci: VoceIncassabile[]
    motivi: MotivoCertezza[]
}

// ─── La macchina ────────────────────────────────────────────────────────────

/** Testo che arriva da una riga di database: può non essere una stringa. */
const testoDi = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Identificativo che arriva da una riga di database: normalizzato, mai `null`. */
const idDi = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/**
 * Il residuo al centesimo, **o `NaN`**. Fuori scala non vale 0 e non vale
 * «tanto»: resta un `NaN`, e sono i due rami che leggono questa funzione a
 * fermarlo, ciascuno a modo suo. Il ramo del CODICE VOCE esce
 * `importo_fuori_scala` (quella voce era stata NOMINATA in causale: chiamarla
 * «già saldata» sarebbe una bugia comoda); il ramo del CODICE FISCALE scarta la
 * voce e basta (`utilizzabile`), perché una voce così non è «aperta» e nessuno
 * l'aveva nominata. In nessuno dei due un `NaN` entra fra le candidate, quindi
 * non può avvelenare la somma di un sottoinsieme.
 */
const residuoAl2 = (v: VoceCertezza): number => {
    const r = round2(Number(v?.residuo))
    return Number.isFinite(r) ? r : Number.NaN
}

/** Un residuo utilizzabile: finito, positivo, dentro la scala. */
const utilizzabile = (r: number): boolean => Number.isFinite(r) && r > 0 && r <= TETTO_IMPORTO

/**
 * L'ORDINE IN CUI SI NOMINANO LE RINUNCE DI SICUREZZA. Serve a rendere l'esito
 * **deterministico**: senza, i motivi uscirebbero nell'ordine in cui capitano le
 * voci nell'elenco, cioè nell'ordine che il database ha restituito quel giorno.
 */
const ORDINE_RINUNCE_VOCE: readonly MotivoRinuncia[] = [
    'voce_contenitore',
    'sede_ignota',
    'sede_fittizia',
    'alunno_anonimizzato',
    'alunno_ritirato',
    'alunno_mancante',
]

const giallo = (...motivi: MotivoCertezza[]): EsitoCertezza => ({ esito: 'suggerito', voci: [], motivi })
const rosso = (...motivi: MotivoCertezza[]): EsitoCertezza => ({ esito: 'da_abbinare', voci: [], motivi })

/**
 * IL VERDETTO SU UN MOVIMENTO. Funzione pura: non tocca `aperte`, non guarda
 * l'orologio, non chiama niente che non sia aritmetica e testo.
 *
 * ─── LA REGOLA, PER ESTESO ──────────────────────────────────────────────────
 *
 * **Passo 0 — le esclusioni che precedono tutto.**
 *  · un movimento RIAPERTO (`pagamentoIdPrecedente` valorizzato) non si
 *    auto-riabbina mai: quel campo è la memoria su cui poggia la guardia «un
 *    bonifico non si fattura due volte», e una macchina non deve scavalcarla;
 *  · un importo non positivo, non finito o oltre il tetto resta rosso.
 *
 * **Passo 1 — gli identificativi.** Codici voce e codici fiscali si estraggono da
 * causale + controparte. Senza nessuno dei due il movimento resta rosso: è la
 * grande maggioranza dell'estratto, e resta esattamente come oggi.
 *
 * **Passo 2 — il codice vince sul codice fiscale.** Ogni codice risolve ad al più
 * una voce. Un codice che non risolve è un giallo, **e non si ripiega sul CF**:
 * se la causale porta `#K7MXN3P` e quella voce non è più aperta, proseguire sul
 * codice fiscale vuol dire incassare su una voce DIVERSA da quella che la
 * famiglia ha pagato. L'insieme candidato: per ogni alunno che ha almeno un
 * codice in causale, **solo** le voci nominate dai suoi codici; per gli alunni
 * nominati dal **solo** codice fiscale, **tutte** le loro voci aperte. Copre il
 * caso misto — codice per un fratello, CF per l'altro — senza scegliere niente.
 *
 * **Passo 3 — identificativi che risolvono, insieme candidato vuoto** → giallo,
 * `alunno_senza_voci_aperte`. È una decisione del titolare: quel movimento
 * diventa giallo con quel motivo, non resta rosso.
 *
 * **Passo 4 — le rinunce di sicurezza.** Basta UNA voce candidata che violi.
 * Non si usa «il resto»: il bonifico è di quella famiglia, e assegnarne una parte
 * a un sottoinsieme delle sue voci è una decisione, non un fatto.
 *
 * **Passo 5 — la regola, in tre righe.** `S` = i sottoinsiemi non vuoti delle
 * voci candidate la cui somma dei residui è esattamente l'importo:
 * `|S| = 0` → giallo (`residuo_non_capiente` se l'importo supera la somma di
 * tutte le candidate, altrimenti `importo_non_quadra`); `|S| ≥ 2` → giallo,
 * `piu_combinazioni`; `|S| = 1` → **automatico**, singolo o composito.
 */
export function valutaCertezza(
    mov: MovimentoDaValutare,
    aperte: readonly VoceCertezza[],
): EsitoCertezza {
    // ─── Passo 0 ────────────────────────────────────────────────────────────
    if (idDi(mov?.pagamentoIdPrecedente) !== '') return giallo('movimento_gia_legato')

    const importo = round2(Number(mov?.importo))
    if (!utilizzabile(importo)) return rosso('importo_fuori_scala')

    // ─── Passo 1 ────────────────────────────────────────────────────────────
    const testo = `${testoDi(mov?.causale)} ${testoDi(mov?.controparte)}`
    const codiciInCausale = estraiCodiciVoce(testo)
    const cfInCausale = new Set(estraiCodiciFiscali(testo))
    if (codiciInCausale.length === 0 && cfInCausale.size === 0) return rosso('nessun_identificativo')

    // ─── L'indice delle voci ────────────────────────────────────────────────
    // Si deduplica per `pagamentoId`: la stessa voce contata due volte
    // raddoppierebbe il residuo dell'insieme candidato, e due sottoinsiemi
    // indistinguibili diventerebbero `piu_combinazioni` su una voce sola.
    const perId = new Map<string, VoceCertezza>()
    for (const v of Array.isArray(aperte) ? aperte : []) {
        const id = idDi(v?.pagamentoId)
        if (id === '' || perId.has(id)) continue
        perId.set(id, v)
    }

    // Codice → voce. ⚠️ Una COLLISIONE (due voci con lo stesso codice) rende quel
    // codice NON risolvibile, invece di farlo risolvere alla prima delle due. Con
    // 1.242.071.040 codici ammessi (20^7 meno i tutto-cifre e i tutto-lettere, il
    // conto è in `codice-voce.ts`) e ~619 voci aperte in tutto — 499 famiglie per
    // la media di 1,24 della misura citata in testata, non un numero a parte — è
    // un evento da ~1,5e-4 (n(n−1)/2N). Raro, ma l'esito sbagliato non sarebbe un
    // giallo di troppo: sarebbe un incasso sulla voce di un altro bambino. La
    // direzione sicura costa tre righe.
    const perCodice = new Map<string, VoceCertezza | null>()
    for (const v of perId.values()) {
        const c = codiceVoce(v.pagamentoId)
        if (c === '') continue
        perCodice.set(c, perCodice.has(c) ? null : v)
    }

    // ─── Passo 2 ────────────────────────────────────────────────────────────
    const candidate: VoceCertezza[] = []
    const gia = new Set<string>()
    /** Gli alunni che hanno almeno un codice in causale: per loro valgono SOLO quei codici. */
    const alunniConCodice = new Set<string>()
    /** La PROVENIENZA di ogni candidata, che poi diventa il motivo d'aggancio. */
    const daCodice = new Set<string>()
    const daCf = new Set<string>()

    for (const c of codiciInCausale) {
        const v = perCodice.get(c) ?? null
        if (v === null) return giallo('identificativo_sconosciuto')
        const r = residuoAl2(v)
        // Un residuo fuori scala non è «già saldato»: è un numero che nessuno può
        // aver inteso, e merita il proprio motivo invece di una bugia comoda.
        if (!Number.isFinite(r) || r > TETTO_IMPORTO) return giallo('importo_fuori_scala')
        if (r <= 0) return giallo('voce_gia_saldata')
        const id = idDi(v.pagamentoId)
        if (!gia.has(id)) {
            gia.add(id)
            candidate.push(v)
            daCodice.add(id)
        }
        const alunno = idDi(v.alunnoId)
        if (alunno !== '') alunniConCodice.add(alunno)
    }

    for (const v of perId.values()) {
        const cf = testoDi(v?.cf).toUpperCase()
        if (cf === '' || !cfInCausale.has(cf)) continue
        // L'alunno è già nominato da un codice: per lui valgono SOLO le voci di
        // quei codici, non tutto il suo fascicolo.
        const alunno = idDi(v.alunnoId)
        if (alunno !== '' && alunniConCodice.has(alunno)) continue
        // Via codice fiscale si prendono «tutte le sue voci APERTE»: una voce già
        // saldata, o con un residuo fuori scala, semplicemente non è aperta — e
        // qui non c'è nessun codice che la nominasse, quindi non c'è niente da
        // spiegare all'operatore. È la stessa asimmetria del ramo qui sopra.
        if (!utilizzabile(residuoAl2(v))) continue
        const id = idDi(v.pagamentoId)
        // Non far rientrare dal codice fiscale una voce che il codice voce ha già
        // preso. La scorciatoia qui sopra non basta: indicizza per ALUNNO, e su una
        // voce con l'alunno vuoto non può scattare — senza questa riga la STESSA
        // voce entrerebbe due volte fra le candidate.
        if (gia.has(id)) continue
        gia.add(id)
        candidate.push(v)
        daCf.add(id)
    }

    // ─── Passo 3 ────────────────────────────────────────────────────────────
    // Ci si arriva solo dal ramo del codice fiscale (quello del codice voce, se è
    // passato, ha lasciato almeno una candidata). E copre due casi che dall'elenco
    // delle sole voci aperte sono INDISTINGUIBILI: un CF di un alunno che non ha
    // più niente da pagare, e un CF che non è di nessuno. Dirli diversi sarebbe
    // inventare l'informazione che manca.
    if (candidate.length === 0) return giallo('alunno_senza_voci_aperte')

    // ─── Passo 4 ────────────────────────────────────────────────────────────
    const violati = new Set<MotivoRinuncia>()
    // `alunno_mancante` vale solo sul ramo a PIÙ VOCI: la conferma su voce singola
    // legge l'intestatario dal pagamento stesso e tollera un `alunno_id` nullo,
    // mentre la composizione deriva il pagante dall'alunno di ogni riga.
    const piuVoci = candidate.length > 1
    for (const v of candidate) {
        if (v.contenitore) violati.add('voce_contenitore')
        if (idDi(v.scuolaId) === '') violati.add('sede_ignota')
        if (v.sedeFittizia) violati.add('sede_fittizia')
        if (v.alunnoAnonimizzato) violati.add('alunno_anonimizzato')
        if (RINUNCIA_SE_RITIRATO && v.alunnoRitirato) violati.add('alunno_ritirato')
        if (piuVoci && idDi(v.alunnoId) === '') violati.add('alunno_mancante')
    }
    if (violati.size > 0) return giallo(...ORDINE_RINUNCE_VOCE.filter((m) => violati.has(m)))

    // ─── Passo 5 ────────────────────────────────────────────────────────────
    if (candidate.length > TETTO_VOCI_CANDIDATE) return giallo('troppe_voci')

    const residui = candidate.map(residuoAl2)
    let totale = 0
    for (const r of residui) totale = round2(totale + r)

    // L'enumerazione: una maschera di bit per sottoinsieme, `0` escluso (il vuoto
    // non è una combinazione). Si esce al SECONDO successo — l'esito è già deciso,
    // e contarli tutti costerebbe senza dire niente di più.
    let vincente = 0
    let quante = 0
    const limite = 1 << candidate.length
    for (let maschera = 1; maschera < limite; maschera++) {
        let somma = 0
        for (let i = 0; i < residui.length; i++) {
            if (maschera & (1 << i)) somma = round2(somma + residui[i])
        }
        if (somma !== importo) continue
        quante++
        if (quante === 1) vincente = maschera
        else break
    }

    if (quante === 0) return giallo(importo > totale ? 'residuo_non_capiente' : 'importo_non_quadra')
    if (quante > 1) return giallo('piu_combinazioni')

    const voci: VoceIncassabile[] = []
    for (let i = 0; i < candidate.length; i++) {
        if (!(vincente & (1 << i))) continue
        const v = candidate[i]
        voci.push({
            pagamentoId: idDi(v.pagamentoId),
            alunnoId: idDi(v.alunnoId) === '' ? null : idDi(v.alunnoId),
            scuolaId: idDi(v.scuolaId),
            importo: residui[i],
        })
    }

    // I motivi d'aggancio descrivono come è nato l'INSIEME CANDIDATO, non solo la
    // combinazione vincente: la certezza viene dall'enumerazione su tutto
    // l'insieme — sono le voci entrate e NON scelte a rendere certa quella scelta.
    // Un identificativo presente in causale ma che non ha portato nessuna voce
    // (un CF di un alunno già coperto dai suoi codici) non si nomina.
    const motivi: MotivoCertezza[] = []
    if (daCodice.size > 0) motivi.push('codice_voce')
    if (daCf.size > 0) motivi.push('codice_fiscale')
    motivi.push(voci.length === 1 ? 'residuo_esatto' : 'somma_esatta')

    return { esito: voci.length === 1 ? 'auto-singola' : 'auto-composita', voci, motivi }
}
