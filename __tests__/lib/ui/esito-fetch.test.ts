import { describe, it, expect, afterEach } from 'vitest'
import { messaggioErrore, CODICI_ERRORE } from '@/lib/ui/esito-fetch'
import itShared from '../../../messages/it/shared.json'
import enShared from '../../../messages/en/shared.json'

// =============================================================================
// IL CANALE D'ERRORE DEL SERVER PARLA UNA LINGUA SOLA — e non è quella di chi legge.
//
// Il collaudo del 2026-07-31 (localizzazione F1 e F2) ha misurato questo: con
// `<html lang="en">` la modale «New notice» mostrava «Sede non accessibile» e
// «Specificare la sede (scuola_id) per questa operazione». Italiano, e per giunta
// col nome della colonna del database in mezzo.
//
// La causa non è una traduzione dimenticata: è che il testo NASCE sul server,
// dove locale e catalogo non esistono, e il client lo rende testualmente. Perciò
// il rimedio non è tradurre due stringhe — è dare al canale un CODICE stabile e
// tradurre QUELLO, con la prosa del server come ripiego.
//
// Il ripiego non si toglie: 1498 risposte d'errore in `src/` non hanno ancora un
// codice (vedi `__tests__/architecture/errori-con-codice.test.ts`), e finché è
// così la prosa italiana è meglio del silenzio.
// =============================================================================

/** Una `Response` finta, come quella che arriva da `fetch`. */
function risposta(body: unknown, { json = true } = {}): Response {
    return {
        json: async () => {
            if (!json) throw new SyntaxError('Unexpected end of JSON input')
            return body
        },
    } as unknown as Response
}

/** Il `lang` dell'elemento radice: è ciò che `RootLayout` scrive da `getLocale()`. */
function conLingua(lang: string) {
    document.documentElement.setAttribute('lang', lang)
}

afterEach(() => {
    document.documentElement.setAttribute('lang', 'it')
})

describe('messaggioErrore — il codice si traduce, la prosa è il ripiego', () => {
    it('interfaccia INGLESE: il codice diventa testo del catalogo EN, non la prosa italiana', async () => {
        conLingua('en')
        const testo = await messaggioErrore(
            risposta({ error: 'Sede non accessibile', codice: 'SEDE_NON_ACCESSIBILE' }),
            'fallback',
        )

        expect(testo).toBe(enShared.erroreSedeNonAccessibile)
        // L'asserzione che conta davvero: non è più l'italiano del server.
        expect(testo).not.toBe('Sede non accessibile')
        expect(testo).not.toMatch(/accessibile/i)
    })

    it('interfaccia ITALIANA: lo stesso codice diventa testo del catalogo IT', async () => {
        conLingua('it')
        const testo = await messaggioErrore(
            risposta({ error: 'Sede non accessibile', codice: 'SEDE_NON_ACCESSIBILE' }),
            'fallback',
        )

        expect(testo).toBe(itShared.erroreSedeNonAccessibile)
    })

    it('il 400 dell’ambiguità: in EN è inglese, e in NESSUNA lingua nomina `scuola_id`', async () => {
        conLingua('en')
        const en = await messaggioErrore(
            risposta({
                error: 'Specificare la sede a cui si riferisce questa operazione',
                codice: 'SEDE_DA_SPECIFICARE',
            }),
            'fallback',
        )
        conLingua('it')
        const it = await messaggioErrore(
            risposta({
                error: 'Specificare la sede a cui si riferisce questa operazione',
                codice: 'SEDE_DA_SPECIFICARE',
            }),
            'fallback',
        )

        expect(en).toBe(enShared.erroreSedeDaSpecificare)
        expect(it).toBe(itShared.erroreSedeDaSpecificare)
        expect(en).not.toMatch(/scuola_id/)
        expect(it).not.toMatch(/scuola_id/)
    })

    it('SENZA codice: resta la prosa del server (le 1498 risposte non ancora convertite)', async () => {
        conLingua('en')
        const testo = await messaggioErrore(risposta({ error: 'Alunno non trovato' }), 'fallback')
        expect(testo).toBe('Alunno non trovato')
    })

    it('codice SCONOSCIUTO: la prosa, mai la chiave di catalogo a schermo', async () => {
        conLingua('en')
        const testo = await messaggioErrore(
            risposta({ error: 'Qualcosa è andato storto', codice: 'CODICE_MAI_DICHIARATO' }),
            'fallback',
        )
        // Il modo più facile di sbagliare questo fix è mostrare `errore.CODICE_…`
        // all'utente al posto del testo. Meglio l'italiano che una chiave.
        expect(testo).toBe('Qualcosa è andato storto')
        expect(testo).not.toMatch(/errore/i)
    })

    it('codice SENZA prosa: il fallback del chiamante, mai la stringa vuota', async () => {
        const testo = await messaggioErrore(risposta({ codice: 'CODICE_MAI_DICHIARATO' }), 'fallback')
        expect(testo).toBe('fallback')
    })

    it('corpo non JSON o vuoto: il fallback del chiamante (comportamento invariato)', async () => {
        expect(await messaggioErrore(risposta(null, { json: false }), 'fallback')).toBe('fallback')
        expect(await messaggioErrore(risposta({}), 'fallback')).toBe('fallback')
        expect(await messaggioErrore(risposta({ error: '   ' }), 'fallback')).toBe('fallback')
    })

    it('lingua col sottotag di regione (`en-GB`): inglese, non il ripiego italiano', async () => {
        // Oggi `RootLayout` scrive `lang="en"` (verificato sul server di sviluppo:
        // `Cookie: KV_LOCALE=en` → `<html lang="en">`), ma la regione della lingua
        // è già decisa in `@/i18n/config` (`en-GB`) e il giorno in cui finisse
        // nell'attributo, un confronto esatto farebbe tornare TUTTI gli errori in
        // italiano — in silenzio, e con questo file verde.
        conLingua('en-GB')
        const testo = await messaggioErrore(
            risposta({ error: 'Sede non accessibile', codice: 'SEDE_NON_ACCESSIBILE' }),
            'fallback',
        )
        expect(testo).toBe(enShared.erroreSedeNonAccessibile)
    })

    it('lingua sconosciuta o assente: italiano, non la chiave e non l’inglese', async () => {
        conLingua('de')
        const testo = await messaggioErrore(
            risposta({ error: 'Sede non accessibile', codice: 'SEDE_NON_ACCESSIBILE' }),
            'fallback',
        )
        expect(testo).toBe(itShared.erroreSedeNonAccessibile)
    })

    it('ogni codice dichiarato ha la sua chiave in ENTRAMBI i cataloghi, e i testi differiscono', () => {
        const it = itShared as Record<string, string>
        const en = enShared as Record<string, string>
        for (const [codice, chiave] of Object.entries(CODICI_ERRORE)) {
            expect(it[chiave], `manca ${chiave} in messages/it/shared.json (codice ${codice})`).toBeTruthy()
            expect(en[chiave], `manca ${chiave} in messages/en/shared.json (codice ${codice})`).toBeTruthy()
            // Controllo POSITIVO accanto a quello negativo: una traduzione inglese
            // copiata dall'italiano passerebbe qualunque test sull'esistenza della
            // chiave, e a schermo sarebbe identica al difetto che stiamo chiudendo.
            expect(en[chiave], `la voce EN di ${chiave} è identica all'italiana`).not.toBe(it[chiave])
        }
    })
})
