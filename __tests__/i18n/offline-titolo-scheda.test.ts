import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import catIt from '../../messages/it/offline.json'
import catEn from '../../messages/en/offline.json'

/**
 * IL TITOLO DELLA SCHEDA DI /offline SEGUE LA LINGUA, COME TUTTO IL RESTO.
 *
 * La pagina è `force-static` — scelta corretta: la serve il Service Worker dalla
 * CacheStorage, e a build time il cookie `KV_LOCALE` non esiste. Per questo il
 * documento contiene ENTRAMBE le lingue e uno script inline mostra quella giusta:
 * imposta `documentElement.lang`, nasconde i blocchi `data-kv-lang` non pertinenti
 * e disegna l'elenco tradotto.
 *
 * Il `<title>` era l'unico pezzo rimasto fuori da quella compensazione, perché
 * vive nel `metadata` di Next e non in un blocco marcato. Misurato:
 * `curl -b 'KV_LOCALE=en' /offline | grep '<title>'` → «Kidville — nessuna
 * connessione», con `documentElement.lang === 'en'` e il corpo tutto in inglese.
 *
 * Non serve infrastruttura nuova: la staffetta esiste già, mancava una riga.
 */

const RADICE = process.cwd()
const PAGINA = fs.readFileSync(path.join(RADICE, 'src/app/offline/page.tsx'), 'utf8')

describe('/offline — il titolo della scheda esiste nei due cataloghi', () => {
    it('entrambe le lingue dichiarano `titoloScheda`', () => {
        expect(typeof catIt.titoloScheda).toBe('string')
        expect(typeof catEn.titoloScheda).toBe('string')
    })

    it('e non sono la stessa stringa: sarebbe il difetto travestito da traduzione', () => {
        expect(catEn.titoloScheda)
            .not.toBe(catIt.titoloScheda)
    })
})

describe('/offline — la pagina usa il catalogo, non una stringa cablata', () => {
    it('il `metadata.title` viene dal catalogo italiano', () => {
        expect(PAGINA).toMatch(/title:\s*it\.titoloScheda/)
        expect(PAGINA, 'titolo ancora cablato nel sorgente').not.toContain("title: 'Kidville — nessuna connessione'")
    })

    it('lo script inline corregge anche `document.title` quando la lingua è EN', () => {
        // Lo stesso script che già corregge `lang` e i blocchi `data-kv-lang`:
        // un secondo script sarebbe una seconda strada per la stessa regola.
        expect(PAGINA).toContain('document.title')
        // La stringa inglese va INLINATA a build time (a runtime non c'è il
        // bundle di Next: il documento arriva dalla CacheStorage).
        expect(PAGINA).toMatch(/JSON\.stringify\(en\.titoloScheda\)/)
    })
})
