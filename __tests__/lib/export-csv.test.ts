import { describe, it, expect } from 'vitest'
import { CSV_BOM, csvCell, csvCellSicura, csvRiga, csvDocumento } from '@/lib/export/csv'

/**
 * `@/lib/export/csv` — i test del MODULO, che fino al 2026-09-19 non esistevano.
 *
 * Il modulo si dichiara «la casa UNICA delle due regole che un file scaricabile
 * deve rispettare» e il default per gli export futuri, ma `grep -rl "lib/export/csv"
 * __tests__` non trovava niente: era esercitato solo DI RIMBALZO dalla route
 * dell'esportazione delle adesioni. Un modulo condiviso provato solo attraverso un
 * suo chiamante è provato per i casi di quel chiamante, e i casi che sono sfuggiti
 * sono precisamente quelli qui sotto.
 *
 * LA FALLA MISURATA. `AVVIO_FORMULA` era `/^[=+\-@]/`: il carattere di formula
 * doveva essere il PRIMO in assoluto. Con una tabulazione o un ritorno a capo
 * davanti, `=1+1` usciva indenne — e nel caso di `\r` usciva CITATO e non
 * disinnescato, che è il peggiore dei due perché ha l'aria di essere stato
 * trattato. La regola ora comincia con `\s*`.
 *
 * ⚠️ È RAGGIUNGIBILE OGGI, non in teoria: nomi ed etichetta dell'export passano da
 * `.trim()`, la colonna **Classe** no — `classe_sezione` è testo libero digitato in
 * segreteria e arriva nella cella così com'è.
 */

describe('csvCellSicura — cita E disinnesca', () => {
    it('disinnesca i quattro caratteri di formula', () => {
        expect(csvCellSicura('=1+1')).toBe('"\'=1+1"')
        expect(csvCellSicura('+1')).toBe('"\'+1"')
        expect(csvCellSicura('-1')).toBe('"\'-1"')
        expect(csvCellSicura('@x')).toBe('"\'@x"')
    })

    it('disinnesca anche quando davanti c’è della SPAZIATURA (la falla del 2026-09-19)', () => {
        // Tab: prima non era né citata né disinnescata — usciva `\t=1+1` tale e quale.
        expect(csvCellSicura('\t=1+1')).toBe('"\'\t=1+1"')
        // CR e LF: prima erano CITATE ma non disinnescate (`"\r=1+1"`), e la
        // citazione da sola non disarma niente — lo dice il modulo stesso.
        expect(csvCellSicura('\r=1+1')).toBe('"\'\r=1+1"')
        expect(csvCellSicura('\n=1+1')).toBe('"\'\n=1+1"')
        // Lo spazio normale, che è il modo più banale di arrivarci.
        expect(csvCellSicura(' =1+1')).toBe('"\' =1+1"')
    })

    it('il payload classico di iniezione non esce eseguibile', () => {
        const v = csvCellSicura('=cmd|\'/c calc\'!A1')
        expect(v.startsWith('"\'=')).toBe(true)
    })

    it('CONTROPROVA: una cella normale non viene toccata', () => {
        expect(csvCellSicura('Rossi')).toBe('Rossi')
        expect(csvCellSicura('1A')).toBe('1A')
        expect(csvCellSicura(3)).toBe('3')
        // Spaziatura senza formula dietro: resta quella che era, niente apice.
        expect(csvCellSicura('  Rossi')).toBe('  Rossi')
        // Vuoti: stringa vuota, non «null»/«undefined» scritti nel foglio.
        expect(csvCellSicura(null)).toBe('')
        expect(csvCellSicura(undefined)).toBe('')
    })

    it('cita separatori e virgolette secondo RFC 4180', () => {
        expect(csvCellSicura('Rossi, Mario')).toBe('"Rossi, Mario"')
        expect(csvCellSicura('a;b')).toBe('"a;b"')
        expect(csvCellSicura('dice "ciao"')).toBe('"dice ""ciao"""')
        expect(csvCellSicura('riga1\nriga2')).toBe('"riga1\nriga2"')
        expect(csvCellSicura('riga1\rriga2')).toBe('"riga1\rriga2"')
    })
})

describe('csvCell — cita e basta, DI PROPOSITO', () => {
    /**
     * È il contratto dichiarato dal modulo: `csvCell` serve ai valori che
     * scriviamo NOI (intestazioni costanti, etichette fisse). Se un giorno
     * qualcuno la «riparasse» facendole disinnescare le formule, le due funzioni
     * diventerebbero la stessa cosa e la distinzione — che è l'unica difesa
     * contro chi sceglie quella sbagliata senza pensarci — sparirebbe in
     * silenzio. Questo test è rosso su quella riparazione.
     */
    it('NON disinnesca: la formula resta una formula', () => {
        expect(csvCell('=1+1')).toBe('=1+1')
        expect(csvCell('@x')).toBe('@x')
        expect(csvCell('\t=1+1')).toBe('\t=1+1')
    })

    it('cita però sì, `\\r` compreso', () => {
        expect(csvCell('a,b')).toBe('"a,b"')
        expect(csvCell('a;b')).toBe('"a;b"')
        expect(csvCell('a"b')).toBe('"a""b"')
        expect(csvCell('a\nb')).toBe('"a\nb"')
        // `\r` è la differenza con la copia privata che stava in
        // `src/lib/import/template.ts` (regex `/[",\n;]/`): senza, la cella
        // usciva non citata e spezzava la riga.
        expect(csvCell('a\rb')).toBe('"a\rb"')
    })

    it('null/undefined → cella vuota', () => {
        expect(csvCell(null)).toBe('')
        expect(csvCell(undefined)).toBe('')
    })
})

describe('csvRiga / csvDocumento', () => {
    it('la riga usa la forma SICURA per default', () => {
        expect(csvRiga(['Rossi', '=1+1'])).toBe('Rossi,"\'=1+1"')
    })

    it('il documento porta il BOM e termina le righe con CRLF', () => {
        const doc = csvDocumento(['Nome'], [['Rossi'], ['Bianchi']])
        expect(doc.startsWith(CSV_BOM)).toBe(true)
        expect(doc).toBe(`${CSV_BOM}Nome\r\nRossi\r\nBianchi\r\n`)
    })
})
