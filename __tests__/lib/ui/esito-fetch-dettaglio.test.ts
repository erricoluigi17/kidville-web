import { describe, it, expect, afterEach } from 'vitest'
import { messaggioErrore, CODICI_CON_DETTAGLIO, CODICI_ERRORE } from '@/lib/ui/esito-fetch'
import itShared from '../../../messages/it/shared.json'
import enShared from '../../../messages/en/shared.json'

/**
 * IL CODICE TRADOTTO NON DEVE MANGIARSI IL DETTAGLIO.
 *
 * Rilievo del collaudo del 2026-08-01: `messaggioErrore` diceva una cosa e la
 * sua documentazione un'altra. Il commento accanto a `CLASSI_FUORI_SEDE`
 * prometteva «il `error` accanto elenca QUALI: il codice dà la frase tradotta,
 * la prosa il dettaglio che solo il server conosce»; il corpo della funzione,
 * appena trovava un codice, **restituiva quello e basta**.
 *
 * Conseguenza concreta: un avviso rifiutato perché due classi non stanno nella
 * sede scelta mostrava «Alcune classi destinatarie non appartengono alla sede
 * dell'avviso: controlla i destinatari» — e QUALI, che è l'unica cosa che dice
 * all'operatore che cosa correggere, non arrivava mai a schermo.
 *
 * ─── PERCHÉ UN ELENCO E NON «SEMPRE LA PROSA» ────────────────────────────────
 *
 * Perché i codici esistono proprio per NON mostrare la prosa: nasce sul server,
 * dove il locale non c'è, ed è quella che faceva leggere a una segretaria
 * inglese «Specificare la sede (scuola_id) per questa operazione». Appenderla
 * sempre riaprirebbe il difetto che i codici hanno chiuso.
 *
 * Perciò l'aggiunta è DICHIARATA per codice, e questo test verifica entrambi i
 * lati: che il dichiarato porti il dettaglio e che il non-dichiarato resti muto.
 *
 * LIMITE RESIDUO, dichiarato invece che nascosto: il dettaglio resta nella
 * lingua del server (i nomi delle classi sono nomi propri, il resto no). Si
 * chiude quando il server manda l'elenco in un campo suo invece che dentro la
 * frase — allora qui si comporrà «frase tradotta + elenco» e basta.
 */

/** Una `Response` finta, come quella che arriva da `fetch`. */
function risposta(body: unknown): Response {
    return { json: async () => body } as unknown as Response
}

function conLingua(lang: string) {
    document.documentElement.setAttribute('lang', lang)
}

afterEach(() => {
    document.documentElement.setAttribute('lang', 'it')
})

/** La prosa VERA di `src/app/api/avvisi/route.ts` quando rifiuta i destinatari. */
const PROSA_SERVER =
    'Classi non presenti nella sede selezionata: 3 ANNI A, 4 ANNI B. Controlla la sede di pubblicazione.'

describe('messaggioErrore — il dettaglio del server arriva a schermo', () => {
    it('CLASSI_FUORI_SEDE: la frase è tradotta E l\'elenco delle classi c\'è', async () => {
        conLingua('en')
        const testo = await messaggioErrore(
            risposta({ error: PROSA_SERVER, codice: 'CLASSI_FUORI_SEDE' }),
            'fallback',
        )
        // La frase resta nella lingua dell'interfaccia…
        expect(testo).toContain(enShared.erroreClassiFuoriSede)
        // …e le due classi, che solo il server conosce, arrivano all'operatore.
        expect(testo).toContain('3 ANNI A')
        expect(testo).toContain('4 ANNI B')
    })

    it('…anche in italiano, dove le due parti non devono raddoppiarsi', async () => {
        conLingua('it')
        const testo = await messaggioErrore(
            risposta({ error: PROSA_SERVER, codice: 'CLASSI_FUORI_SEDE' }),
            'fallback',
        )
        expect(testo).toContain(itShared.erroreClassiFuoriSede)
        expect(testo).toContain('3 ANNI A')
        // Il testo di catalogo compare UNA volta sola.
        expect(testo.split(itShared.erroreClassiFuoriSede).length - 1).toBe(1)
    })

    it('un codice NON dichiarato resta muto: la prosa italiana non torna a schermo', async () => {
        // È il controllo che tiene onesta la correzione: senza, «mostra sempre la
        // prosa» passerebbe il test qui sopra e riaprirebbe il difetto F1/F2 del
        // collaudo precedente.
        conLingua('en')
        const testo = await messaggioErrore(
            risposta({
                error: 'Specificare la sede (scuola_id) per questa operazione',
                codice: 'SEDE_DA_SPECIFICARE',
            }),
            'fallback',
        )
        expect(testo).toBe(enShared.erroreSedeDaSpecificare)
        expect(testo).not.toMatch(/scuola_id/)
    })

    it('codice dichiarato ma senza prosa: solo la frase tradotta, mai un trattino orfano', async () => {
        conLingua('en')
        const soloCodice = await messaggioErrore(risposta({ codice: 'CLASSI_FUORI_SEDE' }), 'fallback')
        expect(soloCodice).toBe(enShared.erroreClassiFuoriSede)

        const prosaVuota = await messaggioErrore(
            risposta({ error: '   ', codice: 'CLASSI_FUORI_SEDE' }),
            'fallback',
        )
        expect(prosaVuota).toBe(enShared.erroreClassiFuoriSede)
    })

    it('prosa IDENTICA al testo tradotto: non la si scrive due volte', async () => {
        conLingua('it')
        const testo = await messaggioErrore(
            risposta({ error: itShared.erroreClassiFuoriSede, codice: 'CLASSI_FUORI_SEDE' }),
            'fallback',
        )
        expect(testo).toBe(itShared.erroreClassiFuoriSede)
    })

    it('l\'elenco dei codici col dettaglio è dichiarato e contiene solo codici veri', async () => {
        // Un insieme che citasse un codice inesistente sarebbe inerte per sempre:
        // nessuno se ne accorgerebbe, perché il ramo non scatterebbe mai.
        expect(CODICI_CON_DETTAGLIO.size).toBeGreaterThan(0)
        for (const codice of CODICI_CON_DETTAGLIO) {
            expect(Object.keys(CODICI_ERRORE)).toContain(codice)
        }
        // E la maggioranza dei codici NON è dichiarata: l'aggiunta è l'eccezione.
        expect(CODICI_CON_DETTAGLIO.size).toBeLessThan(Object.keys(CODICI_ERRORE).length)
    })
})
