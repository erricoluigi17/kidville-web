import { describe, it, expect, afterEach } from 'vitest'
import {
    CODICI_ERRORE,
    CODICI_CON_DETTAGLIO,
    messaggioDaCorpo,
    soloCatalogoDaCorpo,
} from '@/lib/ui/esito-fetch'
import itShared from '../../../messages/it/shared.json'
import enShared from '../../../messages/en/shared.json'

// =============================================================================
// I QUATTRO RIFIUTI DI «COMUNICA UN'ASSENZA» HANNO UN TESTO, E LO LEGGE UN GENITORE.
//
// ─── PERCHÉ QUESTI CODICI NON SONO UN ABBELLIMENTO ──────────────────────────
//
// Le schermate delle famiglie non mostrano MAI la prosa del server: il lock
// `__tests__/architecture/errori-server-schermate-famiglia.test.ts` lo impone, e
// il modo in cui lo ottengono è `soloCatalogoDaCorpo` / `messaggioSoloCatalogo`,
// che scartano l'`error` e tengono solo il testo di catalogo del `codice`.
//
// La conseguenza va detta per intero: dentro quel perimetro un rifiuto SENZA
// codice dichiarato non degrada all'italiano — sparisce. Al genitore resta la
// frase generica del componente («non è stato possibile…»), identica per una
// data nel passato, per un appello già fatto e per un guasto del database. Tre
// situazioni con tre rimedi diversi (cambia data · chiama la scuola · riprova
// fra un minuto) ridotte a una sola frase che non dice cosa fare.
//
// Perciò il testo dei quattro rifiuti si verifica QUI, sul comportamento, e non
// solo con l'esistenza delle chiavi: la domanda a cui questo file risponde è
// «che cosa legge il genitore», non «il catalogo è pieno».
//
// La funzione era irraggiungibile da chiunque fin dalla nascita (403 «Disponibile
// solo per la scuola primaria» a nido e infanzia, e la dashboard portava alla
// pagina solo per nido e infanzia): 0 notifiche `assenza_comunicata` in
// produzione. Aprirla a tutti i gradi senza darle dei messaggi vorrebbe dire
// renderla raggiungibile e muta insieme.
// =============================================================================

/** I quattro codici, con la prosa italiana che il server manda accanto. */
const CASI = [
    {
        codice: 'ASSENZA_DATA_PASSATA',
        prosa: 'La data indicata è già passata',
        /** 400 — si comunica in anticipo; per ieri esiste la giustifica. */
        stato: 400,
    },
    {
        codice: 'ASSENZA_GIA_REGISTRATA',
        prosa: 'La presenza di questo giorno è già stata registrata',
        /** 409 — l'insegnante ha già fatto l'appello: non si sovrascrive. */
        stato: 409,
    },
    {
        codice: 'ALUNNO_NON_TROVATO',
        prosa: 'Alunno non trovato',
        /** 404 — l'alunno non esiste (o non è fra i propri figli). */
        stato: 404,
    },
    {
        codice: 'ASSENZA_NON_SALVATA',
        prosa: 'Errore interno',
        /** 500 — la scrittura su `presenze` è fallita. */
        stato: 500,
    },
] as const

const catIt = itShared as Record<string, string>
const catEn = enShared as Record<string, string>

/** Il `lang` dell'elemento radice: è ciò che `RootLayout` scrive da `getLocale()`. */
function conLingua(lang: string) {
    document.documentElement.setAttribute('lang', lang)
}

afterEach(() => {
    document.documentElement.setAttribute('lang', 'it')
})

describe('comunica assenza — i quattro rifiuti arrivano a schermo, e nella lingua giusta', () => {
    it('ogni codice è DICHIARATO e tradotto in entrambe le lingue', () => {
        const dichiarati = CODICI_ERRORE as Record<string, string>
        for (const { codice } of CASI) {
            const chiave = dichiarati[codice]
            expect(chiave, `${codice} non è dichiarato in CODICI_ERRORE`).toBeTruthy()
            expect(catIt[chiave]?.trim(), `manca ${chiave} in messages/it/shared.json`).toBeTruthy()
            expect(catEn[chiave]?.trim(), `manca ${chiave} in messages/en/shared.json`).toBeTruthy()
            // Una traduzione inglese copiata dall'italiana passerebbe qualunque
            // controllo sull'esistenza della chiave, e a schermo sarebbe il difetto.
            expect(catEn[chiave], `la voce EN di ${chiave} è identica all'italiana`).not.toBe(catIt[chiave])
        }
    })

    it('interfaccia ITALIANA: il genitore legge la frase del suo caso, non il ripiego generico', () => {
        conLingua('it')
        for (const { codice, prosa } of CASI) {
            const chiave = (CODICI_ERRORE as Record<string, string>)[codice]
            const testo = soloCatalogoDaCorpo({ error: prosa, codice }, 'Non è stato possibile completare l’operazione')
            expect(testo, `${codice}: il genitore legge il ripiego generico`).toBe(catIt[chiave])
        }
    })

    it('interfaccia INGLESE: inglese, e mai la prosa italiana del server', () => {
        conLingua('en')
        for (const { codice, prosa } of CASI) {
            const chiave = (CODICI_ERRORE as Record<string, string>)[codice]
            const testo = soloCatalogoDaCorpo({ error: prosa, codice }, 'Something went wrong')
            expect(testo, `${codice}: non è il testo EN di catalogo`).toBe(catEn[chiave])
            expect(testo, `${codice}: a schermo è arrivata la prosa del server`).not.toBe(prosa)
        }
    })

    it('anche dalla strada del cockpit (`messaggioDaCorpo`) vince il catalogo, senza coda italiana', () => {
        // `messaggioDaCorpo` è l'altra porta: mostra la prosa del server quando non
        // riconosce un codice, e appende il dettaglio per i codici di
        // `CODICI_CON_DETTAGLIO`. Nessuno di questi quattro ci sta dentro — la prosa
        // che il server manda accanto non aggiunge niente che la frase tradotta non
        // dica — e se un giorno ce lo mettesse, chi legge in inglese ritroverebbe
        // l'italiano appeso in coda. Questa è la prova che non succede.
        conLingua('en')
        for (const { codice, prosa } of CASI) {
            const chiave = (CODICI_ERRORE as Record<string, string>)[codice]
            expect(CODICI_CON_DETTAGLIO.has(codice), `${codice} è finito in CODICI_CON_DETTAGLIO`).toBe(false)
            const testo = messaggioDaCorpo({ error: prosa, codice }, 'Something went wrong')
            expect(testo).toBe(catEn[chiave])
            expect(testo, `${codice}: la prosa italiana è finita in coda`).not.toContain(prosa)
        }
    })

    it('i quattro testi sono DIVERSI fra loro, in tutte e due le lingue', () => {
        // Il modo più facile di sbagliare questo lavoro non è dimenticare un codice:
        // è mapparne due sulla stessa chiave di catalogo. Il lock `errori-con-codice`
        // non lo vedrebbe — i codici sarebbero dichiarati e tradotti, cioè SBAGLIATI e
        // non mancanti — ed è esattamente la trappola documentata su
        // `NEWS_FILE_SOSTITUITI_NON_RIMOSSI`: a chi aveva cambiato la copertina di un
        // articolo lo schermo raccontava una cancellazione che nessuno aveva chiesto.
        for (const [lingua, cat] of [['it', catIt], ['en', catEn]] as const) {
            const testi = CASI.map(({ codice }) => cat[(CODICI_ERRORE as Record<string, string>)[codice]])
            expect(new Set(testi).size, `due codici mostrano la stessa frase in ${lingua}: ${testi.join(' · ')}`).toBe(
                CASI.length,
            )
        }
    })

    it('nessuno dei quattro testi nomina una colonna o una tabella del database', () => {
        // La metà del fallimento F2 del 2026-07-31 che non riguarda la lingua: a un
        // genitore `section_id` non dice niente, e a chiunque altro racconta com'è
        // fatto lo schema. Qui il rischio è concreto — i quattro rifiuti nascono
        // attorno a `presenze`, `alunno_id`, `giustificata_da`.
        const vietate = /alunno_id|section_id|sectionId|scuola_id|giustificat[ao]_da|\bpresenze\b|PGRST|42703/
        for (const [lingua, cat] of [['it', catIt], ['en', catEn]] as const) {
            for (const { codice } of CASI) {
                const chiave = (CODICI_ERRORE as Record<string, string>)[codice]
                expect(cat[chiave] ?? '', `${codice} (${lingua}) nomina il database`).not.toMatch(vietate)
            }
        }
    })
})
