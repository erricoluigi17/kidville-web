import { describe, it, expect } from 'vitest'
import {
    valutaCertezza,
    RINUNCIA_SE_RITIRATO,
    TETTO_VOCI_CANDIDATE,
    TETTO_IMPORTO,
    type VoceCertezza,
    type MovimentoDaValutare,
} from '@/lib/pagamenti/riconciliazione-auto'
import { codiceVoce } from '@/lib/pagamenti/codice-voce'
// ⚠️ L'import vive QUI e non nel sorgente: sarà `conciliazione-registra` a
// chiamare `valutaCertezza`, quindi importarla di là chiuderebbe un ciclo e
// trascinerebbe logger e Supabase dentro un modulo dichiarato puro. È questo
// test a tenere agganciati i due tetti (vedi `TETTO_IMPORTO`).
import { MAX_IMPORTO_EURO } from '@/lib/pagamenti/conciliazione-registra'

// Il predicato PURO dell'abbinamento automatico: «questo bonifico si può
// incassare da solo, senza che una persona guardi?». Niente I/O, niente
// `Math.random()`, niente `Date.now()` — e nessun dato vero: gli uuid sono
// sintetici e i codici fiscali sono forme valide che non appartengono a nessuno.

const SEDE_A = '11111111-1111-4111-8111-111111111111'
const SEDE_B = '22222222-2222-4222-8222-222222222222'
const SEDE_E2E = 'e2e00000-0000-4000-8000-000000000000'
const ALUNNO_A = 'aaaa1111-2222-4333-8444-555555555555'
const ALUNNO_B = 'bbbb1111-2222-4333-8444-666666666666'

const PAG_1 = '00000000-0000-4000-8000-000000000101'
const PAG_2 = '00000000-0000-4000-8000-000000000102'
const PAG_3 = '00000000-0000-4000-8000-000000000103'
/** Con delle LETTERE dentro: serve alla prova sulla collisione di codice. */
const PAG_4 = 'abcdabcd-0000-4000-8000-000000000104'
const PAG_ASSENTE = '00000000-0000-4000-8000-0000000009ff'

/**
 * Codici fiscali SINTETICI, costruiti sulla forma e non su una persona:
 * 6 lettere + 2 cifre + lettera + 2 cifre + lettera + 3 cifre + lettera.
 * Il repository è pubblico: qui non entra l'anagrafica di nessun minore.
 */
const CF_A = 'AAABBB00C00D000E'
const CF_B = 'FFFGGG11H22I333L'
/** Variante OMOCODICA: le cifre sostituite dalle lettere della mappa fissa (0→L … 9→V). */
const CF_OMOCODICO = 'AAABBBLMCNPDQRSE'

const voce = (p: Partial<VoceCertezza> & { pagamentoId: string }): VoceCertezza => ({
    alunnoId: ALUNNO_A,
    scuolaId: SEDE_A,
    residuo: 100,
    cf: CF_A,
    alunnoAnonimizzato: false,
    alunnoRitirato: false,
    sedeFittizia: false,
    contenitore: false,
    ...p,
})

const movimento = (p: Partial<MovimentoDaValutare> = {}): MovimentoDaValutare => ({
    importo: 100,
    causale: '',
    controparte: '',
    pagamentoIdPrecedente: null,
    ...p,
})

/** Una causale che nomina una voce col suo codice, come la ricopia il genitore. */
const conCodice = (...id: string[]) => `PAGAMENTO ${id.map(codiceVoce).join(' ')} GRAZIE`
/**
 * Una causale che porta un codice fiscale. I due delimitatori (`:` e `,`) non sono
 * decorazione: la variante SENZA SPAZI dell'estrattore incolla tutto, e senza
 * punteggiatura ai due lati un CF spezzato dall'export bancario non si recupera.
 */
const conCf = (...cf: string[]) => `BONIFICO CF: ${cf.join(', ')}, RETTA`

describe('valutaCertezza · le esclusioni che precedono tutto (passo 0)', () => {
    it('un movimento RIAPERTO non si auto-riabbina mai, nemmeno col codice giusto', () => {
        // `pagamentoIdPrecedente` è la memoria su cui poggia «un bonifico non si
        // fattura due volte»: una macchina non deve poterla scavalcare.
        const esito = valutaCertezza(
            movimento({ causale: conCodice(PAG_1), pagamentoIdPrecedente: PAG_1 }),
            [voce({ pagamentoId: PAG_1 })],
        )
        expect(esito.esito).toBe('suggerito')
        expect(esito.motivi).toEqual(['movimento_gia_legato'])
        expect(esito.voci).toEqual([])
    })

    it('un importo a zero o negativo resta rosso', () => {
        for (const importo of [0, -100]) {
            const esito = valutaCertezza(movimento({ importo, causale: conCodice(PAG_1) }), [
                voce({ pagamentoId: PAG_1, residuo: importo }),
            ])
            expect(esito.esito, `importo ${importo}`).toBe('da_abbinare')
            expect(esito.motivi).toEqual(['importo_fuori_scala'])
        }
    })

    it('un importo NaN o infinito resta rosso invece di propagarsi', () => {
        for (const importo of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e308]) {
            const esito = valutaCertezza(movimento({ importo, causale: conCodice(PAG_1) }), [
                voce({ pagamentoId: PAG_1 }),
            ])
            expect(esito.esito, `importo ${importo}`).toBe('da_abbinare')
            expect(esito.motivi).toEqual(['importo_fuori_scala'])
        }
    })

    it('un importo oltre il tetto resta rosso, uno esattamente sul tetto no', () => {
        const sopra = valutaCertezza(
            movimento({ importo: TETTO_IMPORTO + 1, causale: conCodice(PAG_1) }),
            [voce({ pagamentoId: PAG_1, residuo: TETTO_IMPORTO + 1 })],
        )
        // ⚠️ `da_abbinare` e non `suggerito`: senza questa riga il test resterebbe
        // verde anche togliendo il tetto dall'importo del MOVIMENTO, perché a
        // rispondere sarebbe il tetto sul RESIDUO della voce — stesso motivo, esito
        // diverso, e la differenza è fra un rosso e un giallo.
        expect(sopra.esito).toBe('da_abbinare')
        expect(sopra.motivi).toEqual(['importo_fuori_scala'])

        const sul = valutaCertezza(movimento({ importo: TETTO_IMPORTO, causale: conCodice(PAG_1) }), [
            voce({ pagamentoId: PAG_1, residuo: TETTO_IMPORTO }),
        ])
        expect(sul.esito).toBe('auto-singola')
    })

    it('il tetto è LO STESSO numero che rifiuta la registrazione, non un secondo milione', () => {
        // Due tetti sullo stesso importo sono due verità: se uno dei due si
        // alzasse, questo predicato direbbe «certo» su una cifra che
        // `conciliazione-registra` rifiuta — o il contrario — e la divergenza non
        // la vedrebbe nessuno. Il sorgente non può importare quella costante (sarà
        // `conciliazione-registra` a chiamare `valutaCertezza`: ciclo, e un modulo
        // puro che si porta dietro logger e Supabase), quindi l'aggancio è qui.
        expect(TETTO_IMPORTO).toBe(MAX_IMPORTO_EURO)
    })
})

describe('valutaCertezza · senza identificativi resta rosso (passo 1)', () => {
    it('causale vuota e controparte assente: nessun identificativo', () => {
        const esito = valutaCertezza(
            movimento({ causale: '', controparte: undefined as unknown as string }),
            [voce({ pagamentoId: PAG_1 })],
        )
        expect(esito.esito).toBe('da_abbinare')
        expect(esito.motivi).toEqual(['nessun_identificativo'])
    })

    it('una causale che non nomina nessuno resta rossa anche con voci aperte pronte', () => {
        const esito = valutaCertezza(movimento({ causale: 'BONIFICO SEPA DISPOSTO IN DATA ODIERNA' }), [
            voce({ pagamentoId: PAG_1 }),
        ])
        expect(esito.esito).toBe('da_abbinare')
        expect(esito.motivi).toEqual(['nessun_identificativo'])
    })
})

describe('valutaCertezza · il codice vince sul codice fiscale (passo 2)', () => {
    it('il caso felice: un codice, una voce, importo esatto → auto-singola', () => {
        const esito = valutaCertezza(movimento({ causale: conCodice(PAG_1) }), [
            voce({ pagamentoId: PAG_1 }),
        ])
        expect(esito.esito).toBe('auto-singola')
        expect(esito.motivi).toEqual(['codice_voce', 'residuo_esatto'])
        expect(esito.voci).toEqual([
            { pagamentoId: PAG_1, alunnoId: ALUNNO_A, scuolaId: SEDE_A, importo: 100 },
        ])
    })

    it('un codice che non risolve NON ripiega sul codice fiscale, che pure quadrerebbe', () => {
        // Se la causale porta un codice e quella voce non è più aperta, proseguire
        // sul CF vuol dire incassare su una voce DIVERSA da quella che la famiglia
        // ha pagato. Senza la guardia questo caso uscirebbe `auto-singola` su PAG_1.
        const esito = valutaCertezza(
            movimento({ causale: `${conCodice(PAG_ASSENTE)} ${conCf(CF_A)}` }),
            [voce({ pagamentoId: PAG_1, residuo: 100 })],
        )
        expect(esito.esito).toBe('suggerito')
        expect(esito.motivi).toEqual(['identificativo_sconosciuto'])
        expect(esito.voci).toEqual([])
    })

    it('un codice su una voce già saldata è un giallo, non un rosso', () => {
        const esito = valutaCertezza(movimento({ causale: conCodice(PAG_1) }), [
            voce({ pagamentoId: PAG_1, residuo: 0 }),
        ])
        expect(esito.esito).toBe('suggerito')
        expect(esito.motivi).toEqual(['voce_gia_saldata'])
    })

    it('un codice su una voce col residuo fuori scala non viene chiamato «già saldata»', () => {
        const esito = valutaCertezza(movimento({ causale: conCodice(PAG_1) }), [
            voce({ pagamentoId: PAG_1, residuo: 1e308 }),
        ])
        expect(esito.esito).toBe('suggerito')
        expect(esito.motivi).toEqual(['importo_fuori_scala'])
    })

    it('…e un residuo FINITO ma oltre il tetto è fuori scala tanto quanto un infinito', () => {
        // ⚠️ Il test qui sopra NON prova il tetto: `round2(1e308)` è `Infinity`,
        // quindi a rispondere è la prima metà della guardia (`!Number.isFinite(r)`)
        // e la seconda (`r > TETTO_IMPORTO`) non viene nemmeno eseguita. Un residuo
        // FINITO ma assurdo è precisamente il caso per cui il milione è stato
        // scelto — le nove righe di `TETTO_IMPORTO` parlano di
        // `Number.MAX_SAFE_INTEGER`, non di infiniti, e un infinito lo fermerebbe
        // qualunque tetto. Senza quella metà questo caso uscirebbe
        // `importo_non_quadra`: «i conti non tornano» invece di «quel numero non è
        // un importo», e l'operatore cercherebbe un centesimo che non esiste.
        const esito = valutaCertezza(movimento({ importo: 100, causale: conCodice(PAG_1) }), [
            voce({ pagamentoId: PAG_1, residuo: TETTO_IMPORTO + 1 }),
        ])
        expect(esito.esito).toBe('suggerito')
        expect(esito.motivi).toEqual(['importo_fuori_scala'])
    })

    it('via CODICE FISCALE una voce già saldata non è «aperta»: resta fuori dalle candidate', () => {
        // Lo specchio, sul ramo del CF, del «codice su una voce già saldata» qui
        // sopra: là la voce era stata NOMINATA in causale e merita una spiegazione,
        // qui nessuno l'aveva nominata e semplicemente non è aperta. È la guardia
        // `r > 0` di `utilizzabile`, e il caso è la forma più ordinaria che esista
        // dopo un pagamento parziale: un fascicolo con una rata già saldata accanto
        // a una aperta. Il residuo della saldata è 0 apposta — nessuna quota utile,
        // così l'unica differenza in gioco resta la guardia: senza, entrerebbe fra
        // le candidate e {aperta} e {aperta, saldata} sommerebbero ENTRAMBE 100,
        // l'esito cadrebbe a `piu_combinazioni` e l'automatismo si spegnerebbe per
        // la maggior parte delle famiglie, col gate verde.
        const esito = valutaCertezza(movimento({ importo: 100, causale: conCf(CF_A) }), [
            voce({ pagamentoId: PAG_1, residuo: 100 }),
            voce({ pagamentoId: PAG_2, residuo: 0 }),
        ])
        expect(esito.esito).toBe('auto-singola')
        expect(esito.motivi).toEqual(['codice_fiscale', 'residuo_esatto'])
        // `toEqual` sull'elenco intero e non `toHaveLength`: deve restare fermo
        // anche QUALE voce si incassa, non soltanto che ne esca una.
        expect(esito.voci).toEqual([
            { pagamentoId: PAG_1, alunnoId: ALUNNO_A, scuolaId: SEDE_A, importo: 100 },
        ])
    })

    it('per l’alunno nominato da un codice valgono SOLO le voci di quel codice', () => {
        // Caso misto: codice per il fratello A, codice fiscale per entrambi.
        // Il CF di A è in causale, quindi senza la restrizione entrerebbe anche la
        // sua voce A2 — che vale ESATTAMENTE l'importo: le combinazioni esatte
        // diventerebbero due (`{A2}` e `{A1,B1}`) e l'esito sarebbe un giallo.
        const esito = valutaCertezza(
            movimento({ importo: 75, causale: `${conCodice(PAG_1)} ${conCf(CF_A, CF_B)}` }),
            [
                voce({ pagamentoId: PAG_1, residuo: 30 }),
                voce({ pagamentoId: PAG_2, residuo: 75 }),
                voce({ pagamentoId: PAG_3, residuo: 45, alunnoId: ALUNNO_B, cf: CF_B, scuolaId: SEDE_B }),
            ],
        )
        expect(esito.esito).toBe('auto-composita')
        expect(esito.motivi).toEqual(['codice_voce', 'codice_fiscale', 'somma_esatta'])
        expect(esito.voci).toEqual([
            { pagamentoId: PAG_1, alunnoId: ALUNNO_A, scuolaId: SEDE_A, importo: 30 },
            { pagamentoId: PAG_3, alunnoId: ALUNNO_B, scuolaId: SEDE_B, importo: 45 },
        ])
    })

    it('un codice fiscale OMOCODICO viene riconosciuto come gli altri', () => {
        const esito = valutaCertezza(movimento({ causale: conCf(CF_OMOCODICO) }), [
            voce({ pagamentoId: PAG_1, cf: CF_OMOCODICO }),
        ])
        expect(esito.esito).toBe('auto-singola')
        expect(esito.motivi).toEqual(['codice_fiscale', 'residuo_esatto'])
    })

    it('un codice fiscale SPEZZATO dagli spazi dell’export bancario si recupera', () => {
        const esito = valutaCertezza(movimento({ causale: 'CF: AAABBB 00C00D000E, RETTA' }), [
            voce({ pagamentoId: PAG_1 }),
        ])
        expect(esito.esito).toBe('auto-singola')
        expect(esito.motivi).toEqual(['codice_fiscale', 'residuo_esatto'])
    })

    it('un codice fiscale MINUSCOLO nella riga di database si aggancia lo stesso', () => {
        // L'interfaccia `VoceCertezza` dichiara «Codice fiscale dell'ALUNNO, in
        // MAIUSCOLO», e il `.toUpperCase()` sulla voce è ciò che regge quando il
        // database dice il contrario — che è il caso normale, perché nessun vincolo
        // di colonna impone la cassa. Il confronto avviene contro un insieme già
        // portato in maiuscolo da `estraiCodiciFiscali`, quindi quella
        // normalizzazione è l'UNICO punto in cui la differenza si può assorbire:
        // togliendola ogni famiglia col `cf` minuscolo scivolerebbe da
        // `auto-singola` a `alunno_senza_voci_aperte` in silenzio. È lo stesso modo
        // di fallire che l'`it` sullo SPAZIO fra causale e controparte sorveglia
        // sull'altro lato dell'ingresso.
        const esito = valutaCertezza(movimento({ causale: conCf(CF_A) }), [
            voce({ pagamentoId: PAG_1, cf: CF_A.toLowerCase() }),
        ])
        expect(esito.esito).toBe('auto-singola')
        expect(esito.motivi).toEqual(['codice_fiscale', 'residuo_esatto'])
        expect(esito.voci).toEqual([
            { pagamentoId: PAG_1, alunnoId: ALUNNO_A, scuolaId: SEDE_A, importo: 100 },
        ])
    })

    it('il codice fiscale arriva dalla CONTROPARTE, non solo dalla causale', () => {
        // ⚠️ La `controparte` è METÀ dell'ingresso del passo 1, ed è il campo in
        // cui l'export bancario mette l'ordinante: è la ragione per cui anche il
        // matcher storico legge `causale + controparte` (`riconciliazione.ts`).
        // Senza questo `it` una riga tolta per distrazione dimezzerebbe la portata
        // dell'automatismo col gate verde: la causale qui non nomina NESSUNO.
        const esito = valutaCertezza(
            movimento({ causale: 'BONIFICO DISPOSTO', controparte: `BNF ORDINANTE ${CF_A}` }),
            [voce({ pagamentoId: PAG_1 })],
        )
        expect(esito.esito).toBe('auto-singola')
        expect(esito.motivi).toEqual(['codice_fiscale', 'residuo_esatto'])
        expect(esito.voci).toEqual([
            { pagamentoId: PAG_1, alunnoId: ALUNNO_A, scuolaId: SEDE_A, importo: 100 },
        ])
    })

    it('anche il CODICE VOCE arriva dalla controparte', () => {
        // Il gemello del precedente sull'altro identificativo: se la causale e la
        // controparte non fossero davvero concatenate, questo uscirebbe
        // `nessun_identificativo`.
        const esito = valutaCertezza(
            movimento({ causale: 'BONIFICO SEPA', controparte: `ORD ${codiceVoce(PAG_1)} .` }),
            [voce({ pagamentoId: PAG_1, cf: null })],
        )
        expect(esito.esito).toBe('auto-singola')
        expect(esito.motivi).toEqual(['codice_voce', 'residuo_esatto'])
        expect(esito.voci).toEqual([
            { pagamentoId: PAG_1, alunnoId: ALUNNO_A, scuolaId: SEDE_A, importo: 100 },
        ])
    })

    it('fra causale e controparte c’è uno SPAZIO, e non è un dettaglio di stile', () => {
        // I due campi si concatenano con uno spazio in mezzo. Toglierlo non rompe
        // niente in modo visibile: rompe solo l'identificativo che sta IN CODA alla
        // causale, perché entrambi gli estrattori sono ancorati a un delimitatore
        // (`\b` per il CF, il lookahead `(?![0-9A-Z])` per il codice voce) e la
        // prima lettera della controparte glielo toglie. Misurato sugli estrattori
        // veri: `estraiCodiciFiscali('RETTA ' + CF_A + 'ROSSI M')` torna vuoto. Cioè
        // ogni movimento che porta il riferimento in fondo scivolerebbe da
        // automatico a `da_abbinare` in silenzio, col gate verde. I due `it` qui
        // sopra provano che la controparte viene LETTA, non che le due metà restino
        // due token distinti.
        const esito = valutaCertezza(
            movimento({ causale: `RETTA ${CF_A}`, controparte: 'ROSSI M' }),
            [voce({ pagamentoId: PAG_1 })],
        )
        expect(esito.esito).toBe('auto-singola')
        expect(esito.motivi).toEqual(['codice_fiscale', 'residuo_esatto'])
    })

    it('…e lo stesso vale per il CODICE VOCE in coda alla causale', () => {
        // Il gemello sull'altro identificativo: senza lo spazio il lookahead finale
        // di `RE_SIGILLO` incontra la `R` di «ROSSI» e il codice non esiste più.
        const esito = valutaCertezza(
            movimento({ causale: `RETTA ${codiceVoce(PAG_1)}`, controparte: 'ROSSI M' }),
            [voce({ pagamentoId: PAG_1, cf: null })],
        )
        expect(esito.esito).toBe('auto-singola')
        expect(esito.motivi).toEqual(['codice_voce', 'residuo_esatto'])
    })

    it('una voce SENZA pagamentoId non entra: sarebbe un incasso su un riferimento vuoto', () => {
        // Le tre forme che una colonna di database produce davvero per «vuoto».
        // Senza il filtro finiscono tutte in indice sotto la chiave `''`, superano
        // il ramo del codice fiscale (che non passa da `codiceVoce`) e possono
        // arrivare dentro `voci` con `pagamentoId: ''`: un incasso automatico
        // contro un riferimento di pagamento che non esiste.
        for (const vuoto of ['', '   ', undefined as unknown as string]) {
            const esito = valutaCertezza(movimento({ importo: 100, causale: conCf(CF_A) }), [
                voce({ pagamentoId: PAG_1, residuo: 100 }),
                voce({ pagamentoId: vuoto, residuo: 100 }),
            ])
            // Il residuo della riga senza id è scelto uguale apposta: se entrasse
            // creerebbe una SECONDA combinazione esatta, e l'esito cadrebbe a
            // `piu_combinazioni`. Cioè il difetto si vede due volte — nell'esito e
            // nell'elenco — e nessuna delle due letture dipende dall'altra.
            expect(esito.esito, `pagamentoId ${JSON.stringify(vuoto)}`).toBe('auto-singola')
            expect(esito.voci).toEqual([
                { pagamentoId: PAG_1, alunnoId: ALUNNO_A, scuolaId: SEDE_A, importo: 100 },
            ])
        }
    })

    it('due righe identiche per la stessa voce si contano UNA volta sola', () => {
        // A deduplicare è la `Map` per `pagamentoId`: senza di lei i sottoinsiemi
        // che quadrano sarebbero due — la stessa voce presa «da sinistra» e «da
        // destra» — e l'esito sarebbe un giallo su una voce sola.
        const doppia = voce({ pagamentoId: PAG_1, residuo: 100 })
        const esito = valutaCertezza(movimento({ causale: conCf(CF_A) }), [doppia, { ...doppia }])
        expect(esito.esito).toBe('auto-singola')
        expect(esito.voci).toEqual([
            { pagamentoId: PAG_1, alunnoId: ALUNNO_A, scuolaId: SEDE_A, importo: 100 },
        ])
    })

    it('la stessa voce nominata DUE VOLTE — dal codice e dal suo CF — entra una volta sola', () => {
        // La deduplicazione fra i due rami non è quella della `Map` `perId` (che
        // guarda l'elenco in ingresso): è `if (gia.has(id)) continue` nel ramo del
        // codice fiscale. Di solito non serve, perché una voce presa dal codice
        // porta il suo alunno in `alunniConCodice` e il ramo CF salta l'intero
        // fascicolo. Ma quell'indice è per ALUNNO, e qui l'alunno è vuoto: la
        // scorciatoia non può scattare, e senza la clausola la STESSA voce entra due
        // volte fra le candidate. Oggi il doppione non produce una scrittura
        // sbagliata solo perché lo intercetta una SECONDA guardia
        // (`alunno_mancante` sul ramo a più voci) — per caso, non per costruzione:
        // l'esito passerebbe da `auto-singola` a `suggerito`.
        const esito = valutaCertezza(
            movimento({ importo: 50, causale: `RETTA ${codiceVoce(PAG_1)} ${conCf(CF_A)}` }),
            [voce({ pagamentoId: PAG_1, residuo: 50, alunnoId: null })],
        )
        expect(esito.esito).toBe('auto-singola')
        expect(esito.voci).toEqual([
            { pagamentoId: PAG_1, alunnoId: null, scuolaId: SEDE_A, importo: 50 },
        ])
    })

    it('due righe IN CONFLITTO sullo stesso pagamentoId: vince la PRIMA', () => {
        // Il test qui sopra non prova questa riga: con due copie identiche la
        // scelta non può esistere. La clausola `perId.has(id)` non serve a
        // deduplicare (lo fa la `Map`, dove un `set` ripetuto sovrascrive): serve a
        // decidere QUALE delle due righe in conflitto si crede, e la risposta è «la
        // prima». Senza quella clausola vincerebbe l'ULTIMA, il residuo creduto
        // sarebbe 100 e questo caso uscirebbe `auto-singola`: un incasso, non un
        // giallo. È la differenza che il test deve tenere ferma.
        const esito = valutaCertezza(movimento({ importo: 100, causale: conCf(CF_A) }), [
            voce({ pagamentoId: PAG_1, residuo: 60 }),
            voce({ pagamentoId: PAG_1, residuo: 100 }),
        ])
        expect(esito.esito).toBe('suggerito')
        expect(esito.motivi).toEqual(['residuo_non_capiente'])
        expect(esito.voci).toEqual([])
    })

    it('due voci che producono lo STESSO codice lo rendono non risolvibile', () => {
        // Una collisione di codice è astronomicamente improbabile sugli uuid veri
        // (~1,5e-4 su ~619 voci aperte), ma qui si riproduce alla lettera: `codiceVoce`
        // normalizza l'id a minuscolo, quindi due `pagamentoId` che differiscono
        // solo per le maiuscole sono due righe distinte con un codice solo. La
        // direzione sicura è rinunciare, non incassare sulla prima delle due.
        const su = PAG_4.toUpperCase()
        expect(su).not.toBe(PAG_4)
        expect(codiceVoce(su)).toBe(codiceVoce(PAG_4))
        const esito = valutaCertezza(movimento({ causale: conCodice(PAG_4) }), [
            voce({ pagamentoId: PAG_4 }),
            voce({ pagamentoId: su }),
        ])
        expect(esito.esito).toBe('suggerito')
        expect(esito.motivi).toEqual(['identificativo_sconosciuto'])
    })
})

describe('valutaCertezza · identificativi che non portano a nessuna voce (passo 3)', () => {
    it('un CF riconosciuto ma senza voci aperte diventa GIALLO, non resta rosso', () => {
        const esito = valutaCertezza(movimento({ causale: conCf(CF_A) }), [
            voce({ pagamentoId: PAG_1, alunnoId: ALUNNO_B, cf: CF_B }),
        ])
        expect(esito.esito).toBe('suggerito')
        expect(esito.motivi).toEqual(['alunno_senza_voci_aperte'])
        expect(esito.voci).toEqual([])
    })

    it('lo stesso vale con il registro delle voci aperte vuoto', () => {
        const esito = valutaCertezza(movimento({ causale: conCf(CF_A) }), [])
        expect(esito.esito).toBe('suggerito')
        expect(esito.motivi).toEqual(['alunno_senza_voci_aperte'])
    })
})

describe('valutaCertezza · le rinunce di sicurezza (passo 4)', () => {
    const conUnaVoce = (p: Partial<VoceCertezza>) =>
        valutaCertezza(movimento({ causale: conCodice(PAG_1) }), [voce({ pagamentoId: PAG_1, ...p })])

    it('una voce CONTENITORE non si incassa: le rate resterebbero aperte', () => {
        const esito = conUnaVoce({ contenitore: true })
        expect(esito.esito).toBe('suggerito')
        expect(esito.motivi).toEqual(['voce_contenitore'])
    })

    it('una voce SENZA SEDE non si incassa: il documento non saprebbe che sede dichiarare', () => {
        const esito = conUnaVoce({ scuolaId: null })
        expect(esito.esito).toBe('suggerito')
        expect(esito.motivi).toEqual(['sede_ignota'])
    })

    it('in una sede FITTIZIA (E2E/Demo) una macchina non incassa', () => {
        const esito = conUnaVoce({ scuolaId: SEDE_E2E, sedeFittizia: true })
        expect(esito.esito).toBe('suggerito')
        expect(esito.motivi).toEqual(['sede_fittizia'])
    })

    it('su un fascicolo già passato per l’OBLIO non si scrive', () => {
        const esito = conUnaVoce({ alunnoAnonimizzato: true })
        expect(esito.esito).toBe('suggerito')
        expect(esito.motivi).toEqual(['alunno_anonimizzato'])
    })

    it('un solo motivo per ogni violazione, in ordine dichiarato e non in quello del database', () => {
        // Le quattro rinunce VIVE tutte insieme, e in un ordine d'ingresso che è
        // l'inverso di quello dichiarato: la prima voce viola l'ultima posizione
        // dell'elenco, la seconda le prime due. `alunno_ritirato` resta fuori perché
        // è dormiente per costruzione (`RINUNCIA_SE_RITIRATO`), quindi questo è
        // l'ordine intero, non un campione: `ORDINE_RINUNCE_VOCE` esiste
        // dichiaratamente «a rendere l'esito deterministico», e con meno di così
        // metà di quella promessa resterebbe senza prova — spostare
        // `alunno_mancante` in testa all'elenco lascerebbe il gate verde.
        const esito = valutaCertezza(movimento({ importo: 100, causale: conCf(CF_A) }), [
            voce({ pagamentoId: PAG_1, residuo: 60, alunnoAnonimizzato: true }),
            voce({ pagamentoId: PAG_2, residuo: 40, contenitore: true, scuolaId: null, alunnoId: null }),
        ])
        expect(esito.esito).toBe('suggerito')
        expect(esito.motivi).toEqual([
            'voce_contenitore',
            'sede_ignota',
            'alunno_anonimizzato',
            'alunno_mancante',
        ])
    })

    it('un ALUNNO RITIRATO resta incassabile: un insoluto si salda anche a fine anno', () => {
        // ⚠️ Non è una dimenticanza, è una decisione: vedi `RINUNCIA_SE_RITIRATO`.
        expect(RINUNCIA_SE_RITIRATO).toBe(false)
        const esito = conUnaVoce({ alunnoRitirato: true })
        expect(esito.esito).toBe('auto-singola')
        expect(esito.motivi).toEqual(['codice_voce', 'residuo_esatto'])
    })

    it('senza ALUNNO si rinuncia sul ramo a più voci…', () => {
        const esito = valutaCertezza(movimento({ importo: 100, causale: conCf(CF_A) }), [
            voce({ pagamentoId: PAG_1, residuo: 60, alunnoId: null }),
            voce({ pagamentoId: PAG_2, residuo: 40, alunnoId: null }),
        ])
        expect(esito.esito).toBe('suggerito')
        expect(esito.motivi).toEqual(['alunno_mancante'])
    })

    it('…ma non su una voce singola, dove il pagante lo dice il pagamento stesso', () => {
        const esito = conUnaVoce({ alunnoId: null })
        expect(esito.esito).toBe('auto-singola')
        expect(esito.voci).toEqual([
            { pagamentoId: PAG_1, alunnoId: null, scuolaId: SEDE_A, importo: 100 },
        ])
    })
})

describe('valutaCertezza · la regola non sceglie (passo 5)', () => {
    it('due fratelli con residui uguali e un bonifico pari a uno → piu_combinazioni', () => {
        const esito = valutaCertezza(movimento({ importo: 100, causale: conCf(CF_A, CF_B) }), [
            voce({ pagamentoId: PAG_1, residuo: 100 }),
            voce({ pagamentoId: PAG_2, residuo: 100, alunnoId: ALUNNO_B, cf: CF_B, scuolaId: SEDE_B }),
        ])
        expect(esito.esito).toBe('suggerito')
        expect(esito.motivi).toEqual(['piu_combinazioni'])
        expect(esito.voci).toEqual([])
    })

    it('A da 100 contro B da 50+50: la regola ingenua sceglierebbe A, questa no', () => {
        const esito = valutaCertezza(movimento({ importo: 100, causale: conCf(CF_A, CF_B) }), [
            voce({ pagamentoId: PAG_1, residuo: 100 }),
            voce({ pagamentoId: PAG_2, residuo: 50, alunnoId: ALUNNO_B, cf: CF_B, scuolaId: SEDE_B }),
            voce({ pagamentoId: PAG_3, residuo: 50, alunnoId: ALUNNO_B, cf: CF_B, scuolaId: SEDE_B }),
        ])
        expect(esito.esito).toBe('suggerito')
        expect(esito.motivi).toEqual(['piu_combinazioni'])
    })

    it('vale anche dentro un solo bambino: 100/60/40 con un bonifico da 100', () => {
        const esito = valutaCertezza(movimento({ importo: 100, causale: conCf(CF_A) }), [
            voce({ pagamentoId: PAG_1, residuo: 100 }),
            voce({ pagamentoId: PAG_2, residuo: 60 }),
            voce({ pagamentoId: PAG_3, residuo: 40 }),
        ])
        expect(esito.esito).toBe('suggerito')
        expect(esito.motivi).toEqual(['piu_combinazioni'])
    })

    it('una sola combinazione su più voci → auto-composita', () => {
        const esito = valutaCertezza(movimento({ importo: 100, causale: conCf(CF_A) }), [
            voce({ pagamentoId: PAG_1, residuo: 60 }),
            voce({ pagamentoId: PAG_2, residuo: 40 }),
        ])
        expect(esito.esito).toBe('auto-composita')
        expect(esito.motivi).toEqual(['codice_fiscale', 'somma_esatta'])
        expect(esito.voci).toEqual([
            { pagamentoId: PAG_1, alunnoId: ALUNNO_A, scuolaId: SEDE_A, importo: 60 },
            { pagamentoId: PAG_2, alunnoId: ALUNNO_A, scuolaId: SEDE_A, importo: 40 },
        ])
    })

    it('si incassa sul SOTTOINSIEME che quadra, non su tutte le candidate', () => {
        // ⚠️ Il caso che manca a tutti gli altri: qui l'insieme CANDIDATO ({100,
        // 70}) è un soprainsieme STRETTO della combinazione vincente ({100}).
        // Altrove le due coincidono, e finché coincidono la riga che estrae il
        // sottoinsieme (`if (!(vincente & (1 << i))) continue`) non è tenuta ferma
        // da niente: toglierla lascia il gate verde e fa uscire DUE voci per 170 €
        // su un bonifico da 100. È l'unica riga che rende utile l'enumerazione
        // descritta in testata, ed è questo `it` a sorvegliarla.
        const esito = valutaCertezza(movimento({ importo: 100, causale: conCf(CF_A) }), [
            voce({ pagamentoId: PAG_1, residuo: 100 }),
            voce({ pagamentoId: PAG_2, residuo: 70 }),
        ])
        // `toEqual` sull'elenco intero e non `toHaveLength`: deve restare fermo
        // anche QUALE voce si incassa e con quale quota, non soltanto quante sono.
        expect(esito.voci).toEqual([
            { pagamentoId: PAG_1, alunnoId: ALUNNO_A, scuolaId: SEDE_A, importo: 100 },
        ])
        // Il totale incassato non può superare il bonifico: la somma è l'invariante
        // che un'estrazione sbagliata rompe per prima.
        expect(esito.voci.reduce((s, v) => s + v.importo, 0)).toBe(100)
        // ⚠️ DUE candidate, UNA voce incassata: è il solo caso in cui «una sola
        // voce» e «una sola candidata» divergono, cioè il solo in cui l'etichetta
        // si può sbagliare. E l'etichetta non è cosmesi: decide quale strada di
        // SCRITTURA prende il chiamante — conferma su voce singola contro
        // composizione via RPC.
        expect(esito.esito).toBe('auto-singola')
        expect(esito.motivi).toEqual(['codice_fiscale', 'residuo_esatto'])
    })

    it('lo specchio: tre candidate, DUE incassate → auto-composita', () => {
        // L'altra metà della prova qui sopra. Da solo nessuno dei due basta: con
        // una sola voce incassata su due candidate si vede l'etichetta sbagliata,
        // con due incassate su tre si vede l'estrazione sbagliata (senza il filtro
        // uscirebbero tutte e tre, per 115 € su un bonifico da 100).
        const esito = valutaCertezza(movimento({ importo: 100, causale: conCf(CF_A) }), [
            voce({ pagamentoId: PAG_1, residuo: 60 }),
            voce({ pagamentoId: PAG_2, residuo: 40 }),
            voce({ pagamentoId: PAG_3, residuo: 15 }),
        ])
        expect(esito.esito).toBe('auto-composita')
        expect(esito.motivi).toEqual(['codice_fiscale', 'somma_esatta'])
        expect(esito.voci).toEqual([
            { pagamentoId: PAG_1, alunnoId: ALUNNO_A, scuolaId: SEDE_A, importo: 60 },
            { pagamentoId: PAG_2, alunnoId: ALUNNO_A, scuolaId: SEDE_A, importo: 40 },
        ])
        expect(esito.voci.reduce((s, v) => s + v.importo, 0)).toBe(100)
    })

    it('un importo maggiore della somma di tutte le candidate → residuo_non_capiente', () => {
        const esito = valutaCertezza(movimento({ importo: 500, causale: conCf(CF_A) }), [
            voce({ pagamentoId: PAG_1, residuo: 120 }),
            voce({ pagamentoId: PAG_2, residuo: 80 }),
        ])
        expect(esito.esito).toBe('suggerito')
        expect(esito.motivi).toEqual(['residuo_non_capiente'])
    })

    it('un ACCONTO non si spalma da solo: importo_non_quadra', () => {
        const esito = valutaCertezza(movimento({ importo: 50, causale: conCf(CF_A) }), [
            voce({ pagamentoId: PAG_1, residuo: 120 }),
        ])
        expect(esito.esito).toBe('suggerito')
        expect(esito.motivi).toEqual(['importo_non_quadra'])
    })

    it('oltre il tetto di voci non si enumera: troppe_voci', () => {
        const molte = Array.from({ length: TETTO_VOCI_CANDIDATE + 1 }, (_, i) =>
            voce({ pagamentoId: `00000000-0000-4000-8000-0000000002${String(i).padStart(2, '0')}`, residuo: 10 }),
        )
        const esito = valutaCertezza(movimento({ importo: 10, causale: conCf(CF_A) }), molte)
        expect(esito.esito).toBe('suggerito')
        expect(esito.motivi).toEqual(['troppe_voci'])
    })

    it('esattamente al tetto si enumera ancora', () => {
        const molte = Array.from({ length: TETTO_VOCI_CANDIDATE }, (_, i) =>
            voce({ pagamentoId: `00000000-0000-4000-8000-0000000003${String(i).padStart(2, '0')}`, residuo: i + 1 }),
        )
        // 1+2+…+12 = 78: solo l'insieme intero quadra con 78.
        const esito = valutaCertezza(movimento({ importo: 78, causale: conCf(CF_A) }), molte)
        expect(esito.esito).toBe('auto-composita')
        expect(esito.voci).toHaveLength(TETTO_VOCI_CANDIDATE)
    })
})

describe('valutaCertezza · il centesimo, senza tolleranza', () => {
    it('33,33 + 33,33 + 33,34 fa 100,00 e quadra', () => {
        const esito = valutaCertezza(movimento({ importo: 100, causale: conCf(CF_A) }), [
            voce({ pagamentoId: PAG_1, residuo: 33.33 }),
            voce({ pagamentoId: PAG_2, residuo: 33.33 }),
            voce({ pagamentoId: PAG_3, residuo: 33.34 }),
        ])
        expect(esito.esito).toBe('auto-composita')
        expect(esito.voci.map((v) => v.importo)).toEqual([33.33, 33.33, 33.34])
    })

    it('la somma si arrotonda a ogni passo, non solo alla fine', () => {
        // Questa terna è scelta, non presa a caso: `28,40 + 35,80 + 35,80` sommati
        // in virgola mobile NUDA fanno 99.99999999999999, cioè NON l'importo. È
        // l'unica forma di prova che distingue l'arrotondamento dentro il ciclo da
        // «tanto i centesimi tornano comunque»: con le terne ovvie (33,33 × 2 +
        // 33,34) la somma grezza fa esattamente 100 e il test resta verde anche
        // togliendo `round2`.
        const esito = valutaCertezza(movimento({ importo: 100, causale: conCf(CF_A) }), [
            voce({ pagamentoId: PAG_1, residuo: 28.4 }),
            voce({ pagamentoId: PAG_2, residuo: 35.8 }),
            voce({ pagamentoId: PAG_3, residuo: 35.8 }),
        ])
        expect(28.4 + 35.8 + 35.8, 'la premessa della prova: la somma nuda non fa 100').not.toBe(100)
        expect(esito.esito).toBe('auto-composita')
        expect(esito.voci).toHaveLength(3)
    })

    it('la QUOTA scritta in `voci` è il residuo ARROTONDATO, non quello grezzo', () => {
        // `residuoEffettivo` (`lib/pagamenti/aging.ts`) NON arrotonda, e in virgola
        // mobile produce code sotto il centesimo anche partendo da colonne
        // `numeric(10,2)`: 300 − 199,99 − 0,01 fa 99.99999999999999, non 100.
        // Quel numero è la quota che il chiamante scriverà sull'incasso, e il
        // contratto di `VoceIncassabile.importo` dice «al centesimo». Perciò
        // `toBe(100)` e non `toBeCloseTo`: con la coda dentro, questo è rosso.
        const grezzo = 300 - 199.99 - 0.01
        expect(grezzo, 'la premessa della prova: il residuo grezzo NON è 100').not.toBe(100)
        const esito = valutaCertezza(movimento({ importo: 100, causale: conCf(CF_A) }), [
            voce({ pagamentoId: PAG_1, residuo: grezzo }),
        ])
        expect(esito.esito).toBe('auto-singola')
        expect(esito.voci[0]?.importo).toBe(100)
    })

    it('anche l’IMPORTO del movimento si arrotonda, non solo la quota della voce', () => {
        // Lo stesso difetto del test qui sopra guardato dall'altro lato. La coda
        // sotto il centesimo può arrivare dal movimento tanto quanto dalla voce —
        // un importo composto a monte (netto di una commissione, somma di due
        // righe) la porta con sé — e un importo con la coda non quadra più con
        // NESSUN sottoinsieme: l'automatismo diventa un giallo `importo_non_quadra`
        // senza che nessuno sappia perché.
        const grezzo = 300 - 199.99 - 0.01
        expect(grezzo, 'la premessa della prova: l’importo grezzo NON è 100').not.toBe(100)
        const esito = valutaCertezza(movimento({ importo: grezzo, causale: conCf(CF_A) }), [
            voce({ pagamentoId: PAG_1, residuo: 100 }),
        ])
        expect(esito.esito).toBe('auto-singola')
        expect(esito.voci[0]?.importo).toBe(100)
    })

    it('33,333 × 3 fa 99,99 e non quadra: il centesimo mancante non si regala', () => {
        const esito = valutaCertezza(movimento({ importo: 100, causale: conCf(CF_A) }), [
            voce({ pagamentoId: PAG_1, residuo: 33.333 }),
            voce({ pagamentoId: PAG_2, residuo: 33.333 }),
            voce({ pagamentoId: PAG_3, residuo: 33.333 }),
        ])
        expect(esito.esito).toBe('suggerito')
        expect(esito.motivi).toEqual(['residuo_non_capiente'])
    })

    it('una voce col residuo ENORME viene scartata invece di far esplodere la somma', () => {
        const esito = valutaCertezza(movimento({ importo: 100, causale: conCf(CF_A) }), [
            voce({ pagamentoId: PAG_1, residuo: 100 }),
            voce({ pagamentoId: PAG_2, residuo: 1e308 }),
        ])
        expect(esito.esito).toBe('auto-singola')
        expect(esito.voci).toEqual([
            { pagamentoId: PAG_1, alunnoId: ALUNNO_A, scuolaId: SEDE_A, importo: 100 },
        ])
    })

    it('una voce col residuo FINITO ma oltre il tetto resta fuori, e si vede dal MOTIVO', () => {
        // ⚠️ Il test qui sopra non prova il tetto: `round2(1e308)` è `Infinity`, e a
        // scartare la voce è `Number.isFinite`. Questo è il caso che il milione
        // esiste per fermare — un numero finito che nessuno ha mai inteso come euro
        // — e l'asserzione è sul MOTIVO perché è lì che la differenza si vede: con
        // la voce fuori scala FUORI dalle candidate il totale è 100, l'importo lo
        // supera e il motivo è `residuo_non_capiente`; lasciandola dentro il totale
        // diventerebbe 1.000.101 e il motivo scivolerebbe a `importo_non_quadra`,
        // cioè «cerca il centesimo che manca» su un fascicolo che non ha i soldi.
        const esito = valutaCertezza(movimento({ importo: 500, causale: conCf(CF_A) }), [
            voce({ pagamentoId: PAG_1, residuo: 100 }),
            voce({ pagamentoId: PAG_2, residuo: TETTO_IMPORTO + 1 }),
        ])
        expect(esito.esito).toBe('suggerito')
        expect(esito.motivi).toEqual(['residuo_non_capiente'])
        expect(esito.voci).toEqual([])
    })

    it('…e una voce ESATTAMENTE sul tetto entra ancora: il confine è chiuso, non aperto', () => {
        // L'altro lato del confine, che nessun altro `it` tiene fermo: quello del
        // passo 0 fa coincidere i due tetti (importo E residuo al milione) e passa
        // dal ramo del CODICE, dove risponde `r > TETTO_IMPORTO`; qui si passa dal
        // codice fiscale, dove risponde `r <= TETTO_IMPORTO` dentro `utilizzabile`.
        // Stringere quel `<=` in `<` farebbe sparire la voce dalle candidate e
        // l'esito diventerebbe `alunno_senza_voci_aperte`.
        const esito = valutaCertezza(
            movimento({ importo: TETTO_IMPORTO, causale: conCf(CF_A) }),
            [voce({ pagamentoId: PAG_1, residuo: TETTO_IMPORTO })],
        )
        expect(esito.esito).toBe('auto-singola')
        expect(esito.voci).toEqual([
            { pagamentoId: PAG_1, alunnoId: ALUNNO_A, scuolaId: SEDE_A, importo: TETTO_IMPORTO },
        ])
    })

    it('«scartata» vuol dire FUORI dall’insieme candidato, non «somma NaN»', () => {
        // L'assunto qui sopra da solo non prova niente: una voce con residuo
        // `Infinity` lasciata dentro renderebbe NaN ogni sottoinsieme che la
        // contiene, e l'esito sarebbe lo stesso per il motivo sbagliato. Il tetto
        // sulle voci candidate è l'unico punto in cui la differenza si VEDE: con la
        // voce enorme scartata le candidate sono dodici e si enumera, tenendola
        // dentro sarebbero tredici e uscirebbe `troppe_voci`.
        const dodici = Array.from({ length: TETTO_VOCI_CANDIDATE }, (_, i) =>
            voce({ pagamentoId: `00000000-0000-4000-8000-0000000004${String(i).padStart(2, '0')}`, residuo: 10 }),
        )
        const esito = valutaCertezza(movimento({ importo: 120, causale: conCf(CF_A) }), [
            ...dodici,
            voce({ pagamentoId: PAG_1, residuo: 1e308 }),
        ])
        expect(esito.esito).toBe('auto-composita')
        expect(esito.voci).toHaveLength(TETTO_VOCI_CANDIDATE)
    })
})

describe('valutaCertezza · è una funzione PURA', () => {
    const aperte: VoceCertezza[] = [
        voce({ pagamentoId: PAG_1, residuo: 60 }),
        voce({ pagamentoId: PAG_2, residuo: 40 }),
    ]
    const mov = movimento({ importo: 100, causale: conCf(CF_A) })

    it('non tocca l’array in ingresso né le voci che contiene', () => {
        const prima = JSON.stringify(aperte)
        Object.freeze(aperte)
        for (const v of aperte) Object.freeze(v)
        // In un modulo ES (strict mode) una scrittura su un oggetto congelato
        // lancia: se la funzione mutasse qualcosa, questo `expect` non ci arriva.
        expect(() => valutaCertezza(mov, aperte)).not.toThrow()
        expect(JSON.stringify(aperte)).toBe(prima)
    })

    it('due chiamate identiche danno lo stesso esito', () => {
        expect(valutaCertezza(mov, aperte)).toEqual(valutaCertezza(mov, aperte))
    })
})
