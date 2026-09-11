import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { verificaIntegrita, BITRATE_MINIMO_BPS, type MisuraConversione, type MotivoNonIntegro } from '@/lib/media/integrita-video'
import { TETTO_GALLERIA_BYTE } from '@/lib/gallery/limiti'

/**
 * IL CANCELLO SULLE CONVERSIONI VIDEO GUASTE — tabellare, e ROSSO se una soglia si muove.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * PERCHÉ LE SOGLIE SONO SCRITTE A MANO QUI DENTRO
 *
 * Questo test NON importa da `integrita-video.ts` nessuna SOGLIA: né `0.5`, né `5%`, né il
 * pavimento dei byte. Sembra duplicazione, ed è l'unica cosa che rende il test un test.
 *
 * Un test che importasse la soglia dal modulo resterebbe VERDE mentre la soglia cambia —
 * si muoverebbero insieme, e non misurerebbe più niente: sarebbe la trappola che questo
 * repo ha già pagato («abbassare la soglia di un lock lo rende decorazione»). Qui i numeri
 * sono l'ATTESA, scritta indipendentemente: se qualcuno porta la tolleranza da 0,5 s a 5 s
 * o la frazione dei fotogrammi da 0,5 a 0,1, questi casi diventano rossi. Verificato
 * davvero, non supposto: entrambe le soglie sono state mosse a mano e il test è diventato
 * rosso, poi sono state rimesse.
 *
 * DUE ECCEZIONI, entrambe per il motivo OPPOSTO — sono numeri che `integrita-video.ts` non
 * ha scelto, e il test deve seguirli invece di fotografarli:
 *
 *  - `TETTO_GALLERIA_BYTE` (`@/lib/gallery/limiti`) è il tetto globale del progetto
 *    Supabase. Scriverne una copia qui renderebbe rosso il test il giorno in cui il bucket
 *    cambia davvero, e per nessun difetto.
 *  - `BITRATE_MINIMO_BPS` è la copia del cap cablato nella CONVERSIONE, e sta in un lock a
 *    parte (in fondo a questo file) che rilegge il sorgente della conversione e pretende che
 *    i due numeri siano uguali. Le SOGLIE derivate da lui restano scritte a mano
 *    (`PAVIMENTO_BYTE_AL_SECONDO`), così un cambio concordato fra i due file resta comunque
 *    rosso qui.
 *
 * I confini sono coperti dal lato che PASSA e dal lato che FALLISCE, uno accanto all'altro:
 * un confine misurato da un solo lato non distingue `>` da `>=`, ed è la differenza fra
 * rifiutare un video sano e accettarne uno rotto.
 */

/** Il pavimento dei byte: un quarto di 600.000 bit/s = 18.750 byte al secondo. Scritto a mano. */
const PAVIMENTO_BYTE_AL_SECONDO = 600_000 / 8 / 4

/**
 * Una conversione SANA, da cui ogni caso si scosta di un campo solo.
 *
 * 10 s in / 10 s out, 2 MB (il pavimento a 10 s è 187.500 byte, il tetto 52 MB), audio
 * presente da entrambi i lati, 240 fotogrammi distinti su 250 attesi (la metà sarebbe 125).
 */
const SANA: MisuraConversione = {
    durataIngressoS: 10,
    durataUscitaS: 10,
    byteUscita: 2_000_000,
    tracciaAudioIngresso: true,
    tracciaAudioUscita: true,
    fotogrammiAttesi: 250,
    fotogrammiDistinti: 240,
}

const con = (scostamento: Partial<MisuraConversione>): MisuraConversione => ({ ...SANA, ...scostamento })

/** `null` = deve essere integro. Altrimenti è il motivo atteso. */
type Atteso = MotivoNonIntegro | null

const casi: [string, Partial<MisuraConversione>, Atteso][] = [
    // ── il caso integro, che è il primo a dover funzionare ──────────────────────────
    ['una conversione sana passa', {}, null],

    // ── 1. durata-illeggibile ───────────────────────────────────────────────────────
    ['durata di uscita null (il chiamante dichiara di non averla)', { durataUscitaS: null }, 'durata-illeggibile'],
    ['durata di uscita Infinity — il caso NORMALE di MediaRecorder, non un caso raro', { durataUscitaS: Infinity }, 'durata-illeggibile'],
    ['durata di uscita -Infinity', { durataUscitaS: -Infinity }, 'durata-illeggibile'],
    ['durata di uscita NaN', { durataUscitaS: NaN }, 'durata-illeggibile'],
    ['durata di INGRESSO NaN: senza di essa il confronto della regola 2 sarebbe cieco', { durataIngressoS: NaN }, 'durata-illeggibile'],
    ['durata di INGRESSO Infinity', { durataIngressoS: Infinity }, 'durata-illeggibile'],
    ['durata di uscita NEGATIVA: fuori dominio quanto un NaN', { durataUscitaS: -3 }, 'durata-illeggibile'],
    ['durata di INGRESSO negativa', { durataIngressoS: -10, durataUscitaS: -10 }, 'durata-illeggibile'],
    [
        'durate NEGATIVE da entrambi i lati, -96 s su -100: misurato, prima passava per INTEGRO perché la tolleranza si prendeva sul valore assoluto',
        { durataIngressoS: -100, durataUscitaS: -96 },
        'durata-illeggibile',
    ],
    [
        'durata di INGRESSO a ZERO: un sorgente di zero secondi non è una misura rispetto a cui giudicare',
        { durataIngressoS: 0, durataUscitaS: 0 },
        'durata-illeggibile',
    ],

    // ── 2. durata-divergente ────────────────────────────────────────────────────────
    ['uscita più lunga di 2 s su 10 (tolleranza 0,5 s)', { durataUscitaS: 12 }, 'durata-divergente'],
    ['uscita troncata a 7 s su 10', { durataUscitaS: 7 }, 'durata-divergente'],
    ['uscita a 0 s con ingresso a 10: la registrazione non ha scritto nulla', { durataUscitaS: 0, byteUscita: 1 }, 'durata-divergente'],

    // ── 3. audio-perduto ────────────────────────────────────────────────────────────
    ['audio presente in ingresso e assente in uscita', { tracciaAudioUscita: false }, 'audio-perduto'],
    ['video girato in SILENZIO: nessun audio da nessuna parte è legittimo', { tracciaAudioIngresso: false, tracciaAudioUscita: false }, null],
    ['audio comparso in uscita senza esserci in ingresso: strano, non un guasto', { tracciaAudioIngresso: false, tracciaAudioUscita: true }, null],

    // ── 4. byte-implausibili ────────────────────────────────────────────────────────
    ['byte a 0', { byteUscita: 0 }, 'byte-implausibili'],
    ['byte negativi', { byteUscita: -1 }, 'byte-implausibili'],
    ['byte NaN: senza il controllo di finitezza passerebbe indenne da tutti i confronti', { byteUscita: NaN }, 'byte-implausibili'],
    ['byte Infinity', { byteUscita: Infinity }, 'byte-implausibili'],
    ['byte sotto il pavimento per la durata (100 kB per 10 s)', { byteUscita: 100_000 }, 'byte-implausibili'],

    // ── 5. fotogrammi-congelati ─────────────────────────────────────────────────────
    ['un solo fotogramma distinto su 250 attesi: la tela era ferma', { fotogrammiDistinti: 1 }, 'fotogrammi-congelati'],
    ['zero fotogrammi distinti su 250 attesi', { fotogrammiDistinti: 0 }, 'fotogrammi-congelati'],
    ['ripetizione tollerata: 130 distinti su 250 (la metà è 125)', { fotogrammiDistinti: 130 }, null],
    [
        'ciclo NON strumentato (0 attesi, 0 distinti): la regola 5 è cieca per costruzione, ed è documentato',
        { fotogrammiAttesi: 0, fotogrammiDistinti: 0 },
        null,
    ],
]

describe('verificaIntegrita — i cinque motivi, e il caso integro', () => {
    it.each(casi)('%s', (_nome, scostamento, atteso) => {
        const esito = verificaIntegrita(con(scostamento))
        if (atteso === null) {
            expect(esito).toEqual({ integro: true })
        } else {
            expect(esito).toEqual({ integro: false, motivo: atteso })
        }
    })
})

/**
 * LA STRUMENTAZIONE DEI FOTOGRAMMI, QUANDO CONSEGNA UNA MISURA ROTTA.
 *
 * Questi casi sono stati MISURATI sul modulo prima del guard, e passavano tutti per integri:
 * `distinti < 0.5 * attesi` con un `NaN` da una parte è `false`, e con un `attesi` negativo è
 * falso sempre. Cioè un video CONGELATO con il contatore guasto veniva ACCETTATO e arrivava
 * al genitore — sulla regola che prende il sintomo riferito dal titolare, e nel verso
 * peggiore: non un falso rifiuto, un falso via libera.
 *
 * Sono in una tabella loro e non fra i `casi` perché dicono una cosa diversa dalle soglie:
 * non «quanto» è troppo poco, ma «misura inattendibile = rifiuto». Togliendo il guard dal
 * modulo, tutti e sei diventano rossi.
 */
const strumentazioneRotta: [string, Partial<MisuraConversione>][] = [
    ['attesi NaN, distinti 0 — un video fermo che passava per integro', { fotogrammiAttesi: NaN, fotogrammiDistinti: 0 }],
    ['distinti NaN', { fotogrammiDistinti: NaN }],
    ['attesi negativi (-100): il confronto sarebbe falso sempre', { fotogrammiAttesi: -100, fotogrammiDistinti: 0 }],
    ['distinti negativi (-1): un contatore non torna indietro', { fotogrammiDistinti: -1 }],
    ['attesi Infinity', { fotogrammiAttesi: Infinity, fotogrammiDistinti: 0 }],
    ['distinti Infinity: più disegni nuovi che disegni, è una misura rotta', { fotogrammiDistinti: Infinity }],
]

describe('verificaIntegrita — una misura dei fotogrammi ROTTA è un rifiuto, non un via libera', () => {
    it.each(strumentazioneRotta)('%s', (_nome, scostamento) => {
        expect(verificaIntegrita(con(scostamento))).toEqual({ integro: false, motivo: 'fotogrammi-congelati' })
    })
})

/**
 * I CONFINI, misurati da entrambi i lati.
 *
 * Ogni coppia è «esattamente sulla soglia → passa» e «un filo oltre → fallisce». Le soglie
 * del modulo sono strette (`>` e `<`), quindi il valore esatto è ancora buono: è una scelta
 * e va inchiodata, altrimenti un domani diventa `>=` e nessuno lo nota.
 */
const confini: [string, Partial<MisuraConversione>, Atteso][] = [
    // ── il confine ASSOLUTO: 0,5 s. Con ingresso a 4 s il 5% sarebbe 0,2 s, quindi vince lo 0,5. ──
    ['scarto di ESATTAMENTE 0,5 s su un ingresso di 4 s: passa', { durataIngressoS: 4, durataUscitaS: 4.5 }, null],
    ['scarto di 0,6 s su un ingresso di 4 s: fallisce', { durataIngressoS: 4, durataUscitaS: 4.6 }, 'durata-divergente'],
    [
        'scarto di 0,3 s su 4 s: è il 7,5% (oltre il 5%) ma sotto lo 0,5 s, e passa — la soglia è il MASSIMO dei due, non il minimo',
        { durataIngressoS: 4, durataUscitaS: 4.3 },
        null,
    ],
    [
        'uscita di ZERO secondi con un ingresso di 0,4 s e UN byte: la tolleranza assoluta la assorbiva, e passava per integra — misurato',
        { durataIngressoS: 0.4, durataUscitaS: 0, byteUscita: 1, fotogrammiAttesi: 10, fotogrammiDistinti: 10 },
        'durata-divergente',
    ],

    // ── il confine RELATIVO: 5%. Con ingresso a 100 s il 5% (5 s) supera lo 0,5 s e vince lui. ──
    [
        'scarto di ESATTAMENTE il 5% (5 s su 100): passa',
        { durataIngressoS: 100, durataUscitaS: 105, byteUscita: 20_000_000 },
        null,
    ],
    [
        'scarto del 5,2% (5,2 s su 100): fallisce',
        { durataIngressoS: 100, durataUscitaS: 105.2, byteUscita: 20_000_000 },
        'durata-divergente',
    ],
    [
        'scarto di 3 s su 100: sei volte lo 0,5 s ma sotto il 5%, e passa — di nuovo il MASSIMO dei due',
        { durataIngressoS: 100, durataUscitaS: 103, byteUscita: 20_000_000 },
        null,
    ],

    // ── il confine del PAVIMENTO dei byte: 18.750 byte al secondo (un quarto di 600 kbit/s). ──
    [
        'byte ESATTAMENTE sul pavimento per 10 s (187.500): passa',
        { byteUscita: PAVIMENTO_BYTE_AL_SECONDO * 10 },
        null,
    ],
    [
        'un byte sotto il pavimento per 10 s (187.499): fallisce',
        { byteUscita: PAVIMENTO_BYTE_AL_SECONDO * 10 - 1 },
        'byte-implausibili',
    ],
    [
        'il pavimento segue la DURATA: 187.499 byte su un video di 1 s stanno larghi (pavimento 18.750)',
        { durataIngressoS: 1, durataUscitaS: 1, byteUscita: PAVIMENTO_BYTE_AL_SECONDO * 10 - 1, fotogrammiAttesi: 25, fotogrammiDistinti: 24 },
        null,
    ],

    // ── il confine del TETTO: quello del bucket, importato, non copiato. ──
    ['byte ESATTAMENTE sul tetto del bucket: passa', { byteUscita: TETTO_GALLERIA_BYTE }, null],
    ['un byte sopra il tetto del bucket: fallisce', { byteUscita: TETTO_GALLERIA_BYTE + 1 }, 'byte-implausibili'],

    // ── il confine dei FOTOGRAMMI: metà degli attesi. ──
    ['ESATTAMENTE metà dei fotogrammi attesi (50 su 100): passa', { fotogrammiAttesi: 100, fotogrammiDistinti: 50 }, null],
    ['un fotogramma sotto la metà (49 su 100): fallisce', { fotogrammiAttesi: 100, fotogrammiDistinti: 49 }, 'fotogrammi-congelati'],
    [
        'la metà non si arrotonda: 50 distinti su 101 attesi (metà = 50,5) fallisce',
        { fotogrammiAttesi: 101, fotogrammiDistinti: 50 },
        'fotogrammi-congelati',
    ],
]

describe('verificaIntegrita — i confini delle soglie, da entrambi i lati', () => {
    it.each(confini)('%s', (_nome, scostamento, atteso) => {
        const esito = verificaIntegrita(con(scostamento))
        if (atteso === null) {
            expect(esito).toEqual({ integro: true })
        } else {
            expect(esito).toEqual({ integro: false, motivo: atteso })
        }
    })
})

/**
 * L'ORDINE, che è un contratto e non una preferenza.
 *
 * «La prima regola che fallisce vince» decide il `motivo` che finisce nel log, quindi decide
 * dove si guarderà fra sei mesi. Ogni caso qui rompe DUE regole insieme e pretende il nome
 * di quella che sta più in alto: se qualcuno riordina i controlli, questi casi lo dicono.
 */
const precedenze: [string, Partial<MisuraConversione>, MotivoNonIntegro][] = [
    [
        'durata illeggibile batte tutto il resto (audio perso, zero byte, tela ferma)',
        { durataUscitaS: null, tracciaAudioUscita: false, byteUscita: 0, fotogrammiDistinti: 0 },
        'durata-illeggibile',
    ],
    [
        'durata divergente batte audio perduto: i byte e i fotogrammi descriverebbero un altro video',
        { durataUscitaS: 20, tracciaAudioUscita: false },
        'durata-divergente',
    ],
    [
        'audio perduto batte byte implausibili: un file muto pesa anche MENO, e la causa vera è l’audio',
        { tracciaAudioUscita: false, byteUscita: 0 },
        'audio-perduto',
    ],
    [
        'byte implausibili batte fotogrammi congelati: è il prezzo dichiarato dell’ordine, entrambe rifiutano',
        { byteUscita: 0, fotogrammiDistinti: 0 },
        'byte-implausibili',
    ],
    [
        'byte implausibili batte anche una strumentazione dei fotogrammi ROTTA: il guard sta dentro la regola 5, che è l’ultima',
        { byteUscita: 0, fotogrammiAttesi: NaN },
        'byte-implausibili',
    ],
]

describe('verificaIntegrita — la prima regola che fallisce vince', () => {
    it.each(precedenze)('%s', (_nome, scostamento, atteso) => {
        expect(verificaIntegrita(con(scostamento))).toEqual({ integro: false, motivo: atteso })
    })
})

/**
 * IL PAVIMENTO DEI BYTE SEGUE IL CAP DELLA CONVERSIONE — il lock che il puntatore non era.
 *
 * `BITRATE_MINIMO_BPS` è l'UNICO numero che `integrita-video.ts` copia a mano da un altro
 * file: il cap del bitrate che la conversione passa a `MediaRecorder`. Non lo si può
 * importare — quel modulo è tutto DOM e tirarlo dentro romperebbe la purezza che è la ragione
 * d'esistere del cancello — quindi la copia resta, e questo lock è ciò che le impedisce di
 * divergere. Se domani il cap passa a 300 kbps, il pavimento qui rifiuterebbe video sani in
 * silenzio: con questo lock diventa rosso.
 *
 * Prima di questo giro, al posto del lock c'era una CITAZIONE, e puntava a
 * `processing.ts` riga ~252 — esatta contro un `HEAD` vecchio e falsa sul file, perché la
 * conversione era intanto stata spostata e `processing.ts` è diventato un barile di 75 righe.
 * Una citazione invecchia da sola e non fa rumore; un lock invecchia diventando rosso.
 *
 * ⚠️ IL LOCK CERCA PER CONTENUTO, NON PER NOME DI FILE — per non rompersi al prossimo
 * spostamento: scorre tutti i `.ts` di `src/lib/media` e cerca la forma
 * `Math.max(<n>, Math.min(… bitrate …))`. Se nessuno la contiene, il lock NON passa in
 * silenzio: fallisce dicendo che il puntatore è diventato cieco e va ripuntato. Un lock che
 * non trova più ciò che sorveglia e resta verde è la definizione di decorazione.
 */
const CARTELLA_MEDIA = join(process.cwd(), 'src', 'lib', 'media')

/** Il sorgente di un modulo, PRIVATO DEI COMMENTI: i due lock qui sotto guardano il CODICE. */
const senzaCommenti = (testo: string) =>
    testo.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')

const leggi = (nome: string) => senzaCommenti(readFileSync(join(CARTELLA_MEDIA, nome), 'utf8'))

const capDichiaratiNellaConversione = readdirSync(CARTELLA_MEDIA)
    // ⚠️ SE STESSO ESCLUSO, e non è pignoleria: il commento di `BITRATE_MINIMO_BPS` cita quella
    // riga per esteso, quindi il modulo si trovava DA SÉ. Misurato: il lock riportava due
    // occorrenze, `integrita-video.ts` e `video-mediarecorder.ts`. Bastava che la conversione
    // sparisse dalla cartella e il lock avrebbe continuato a confrontare il modulo col proprio
    // commento — verde, e cieco esattamente come il puntatore che sostituisce.
    .filter((nome) => nome.endsWith('.ts') && nome !== 'integrita-video.ts')
    .flatMap((nome) => [...leggi(nome).matchAll(/Math\.max\(\s*(\d[\d_]*)\s*,\s*Math\.min\([^)]*bitrate[^)]*\)\s*\)/g)]
        .map((trovato) => ({ nome, valore: Number(trovato[1].replace(/_/g, '')) })))

describe('BITRATE_MINIMO_BPS — non può divergere dal cap cablato nella conversione', () => {
    it('il cap si trova ancora in src/lib/media: il puntatore non è cieco', () => {
        expect(
            capDichiaratiNellaConversione.map((c) => c.nome),
            'nessun file in src/lib/media dichiara ancora un cap nella forma Math.max(<n>, Math.min(..., bitrate)): '
            + 'la conversione e stata riscritta e questo lock va RIPUNTATO sul posto nuovo, non cancellato',
        ).not.toHaveLength(0)
    })

    it.each(capDichiaratiNellaConversione)('$nome dichiara lo stesso pavimento di BITRATE_MINIMO_BPS', ({ nome, valore }) => {
        expect(
            valore,
            `${nome} passa a MediaRecorder un bitrate minimo di ${valore} bit/s, `
            + `mentre integrita-video.ts calcola il pavimento dei byte su ${BITRATE_MINIMO_BPS}: `
            + 'allineare la costante (e le soglie scritte a mano in questo test)',
        ).toBe(BITRATE_MINIMO_BPS)
    })
})

describe('verificaIntegrita — resta PURA, e il modulo resta senza DOM', () => {
    it('non muta la misura ricevuta', () => {
        const misura = con({ durataUscitaS: 12 })
        const copia = { ...misura }
        verificaIntegrita(misura)
        expect(misura).toEqual(copia)
    })

    it('due chiamate sulla stessa misura danno lo stesso esito', () => {
        const misura = con({ fotogrammiDistinti: 3 })
        expect(verificaIntegrita(misura)).toEqual(verificaIntegrita(misura))
    })

    /**
     * Il sorgente del modulo, PRIVATO DEI COMMENTI.
     *
     * Perché si spogliano: il lock qui sotto vuole i nomi dei globali del browser nel CODICE,
     * e questo modulo di quei nomi parla molto in prosa (spiega proprio come NON usarli).
     * Cercarli nel testo intero costringerebbe a scrivere i commenti a mezze parole, e un
     * lock che deforma la documentazione che sorveglia finisce disattivato.
     */
    const sorgenteSenzaCommenti = leggi('integrita-video.ts')

    it('il codice non nomina nessun globale del browser: si deve poter testare senza browser', () => {
        // Perché un lock sul TESTO e non solo la prova che i test girano: sotto jsdom
        // `document` e `window` ESISTONO, quindi un DOM che si infilasse qui dentro non
        // renderebbe rosso nessun caso — girerebbe benissimo nei test e romperebbe solo la
        // strada che gira in un worker o sul server. Il ramo che nessun test prende è
        // esattamente il ramo che si rompe.
        //
        // ⚠️ IL PERIMETRO, dichiarato perché nessuno creda il lock più stretto di quanto è.
        // Prende i NOMI, anche quando non sono seguiti da un punto: la versione precedente
        // pretendeva `[.[]` subito dopo, e un alias (`const g = globalThis`, poi
        // `g.document...`) le passava davanti indisturbato — provato. NON prende un accesso
        // costruito a runtime (`Reflect.get(eval('this'), 'document')`) né un globale
        // raggiunto dentro un modulo importato: per quel secondo buco c'è il lock sugli
        // import, qui sotto.
        expect(sorgenteSenzaCommenti).not.toMatch(
            /\b(?:document|window|navigator|self|globalThis|location|localStorage|MediaRecorder|HTMLMediaElement|HTMLVideoElement|File|Blob|URL)\b/,
        )
    })

    it('non importa niente oltre i limiti del bucket: la purezza non si aggira per via transitiva', () => {
        // Il lock sui nomi non vedrebbe un `import` di un modulo che il DOM lo tocca per
        // conto suo. La lista è volutamente CHIUSA e di una voce sola: ogni import nuovo qui
        // dentro va deciso, non subito. `@/lib/gallery/limiti` è ammesso perché è per
        // costruzione un file di soli numeri, senza nessun import proprio (lo dice la sua
        // intestazione, e la build l'ha già imposto una volta).
        const importati = [...sorgenteSenzaCommenti.matchAll(/from\s+'([^']+)'/g)].map((trovato) => trovato[1])
        expect(importati).toEqual(['@/lib/gallery/limiti'])
    })
})
