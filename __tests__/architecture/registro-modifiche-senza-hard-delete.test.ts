import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * LOCK — NESSUN CODICE PUÒ PIÙ SCRIVERE UNA RIGA `hard_delete_gdpr`.
 *
 * ─── IL FATTO, misurato in produzione il 2026-08-12 ─────────────────────────
 *
 * `DELETE /api/admin/students` («Hard Delete GDPR») scriveva l'audit PRIMA di
 * cancellare:
 *
 *     await supabase.from('registro_modifiche').insert({ azione: 'hard_delete_gdpr', … })
 *     const { error } = await supabase.from('alunni').delete()…
 *
 * Ma `alunni` ha SETTE foreign key entranti senza `ON DELETE CASCADE`, e su 33
 * alunni veri 28 avevano pagamenti e 28 un legame con un genitore: la `delete`
 * veniva respinta con `23503` e l'audit restava. In `registro_modifiche` sono
 * rimaste **tre righe** (id 89, 90, 91) che dichiaravano cancellato un bambino
 * ancora iscritto, ciascuna con dentro la copia INTEGRALE della sua riga — note
 * mediche comprese. Tre affermazioni false, e tre copie di dati sanitari di un
 * minore in una tabella d'audit che nessuno riscrive.
 *
 * Le righe sono state rimosse dalla migrazione
 * `20260812194614_bonifica_registro_modifiche_hard_delete.sql`, che nella sua
 * testata dichiara questo lock come la metà mancante: **la bonifica toglie
 * l'effetto, il lock toglie la causa**. Senza, il giorno in cui qualcuno
 * reintroduce una cancellazione «solo per gli alunni senza dati collegati» il
 * difetto torna identico, e a scoprirlo sarebbe di nuovo una query a mano.
 *
 * ─── PERCHÉ IL LETTERALE, E NON «LA ROUTE NON C'È PIÙ» ──────────────────────
 *
 * Perché un lock sull'assenza di un file è verde anche quando la stessa `insert`
 * rinasce altrove — in una route di manutenzione, in uno script, dentro
 * `admin/wipe`. Il letterale è ciò che finisce in colonna, ed è l'unica cosa che
 * si può sorvegliare da qui: se una riga `hard_delete_gdpr` non può più essere
 * scritta da nessun punto di `src/`, quel valore in tabella potrà solo essere
 * storia — cioè la prova di cancellazioni davvero avvenute, che si conserva.
 *
 * ⚠️ NON vieta la parola nei COMMENTI: questo file, la migrazione e la testata di
 * `admin/students/route.ts` raccontano la vicenda e devono poterla nominare. La
 * misura maschera i commenti prima di guardare — altrimenti il lock sarebbe rosso
 * proprio sulla documentazione che lo spiega, e la prima mossa di chi lo vede
 * rosso sarebbe cancellare la spiegazione.
 */

const RADICE = process.cwd()
const SRC = path.join(RADICE, 'src')
const LETTERALE = 'hard_delete_gdpr'

/** Sostituisce i commenti con spazi lasciando INTATTE le stringhe. */
function mascheraCommenti(sorgente: string): string {
    let out = ''
    let i = 0
    let stato: 'code' | 'riga' | 'blocco' | 'str' = 'code'
    let apice = ''
    while (i < sorgente.length) {
        const c = sorgente[i]
        const d = sorgente[i + 1]
        if (stato === 'code') {
            if (c === '/' && d === '/') { stato = 'riga'; out += '  '; i += 2; continue }
            if (c === '/' && d === '*') { stato = 'blocco'; out += '  '; i += 2; continue }
            if (c === '"' || c === "'" || c === '`') { stato = 'str'; apice = c; out += c; i++; continue }
            out += c; i++; continue
        }
        if (stato === 'riga') {
            if (c === '\n') { stato = 'code'; out += '\n' } else out += ' '
            i++; continue
        }
        if (stato === 'blocco') {
            if (c === '*' && d === '/') { stato = 'code'; out += '  '; i += 2; continue }
            out += c === '\n' ? '\n' : ' '; i++; continue
        }
        // stato === 'str'
        if (c === '\\') { out += c + (d ?? ''); i += 2; continue }
        if (c === apice) stato = 'code'
        out += c; i++
    }
    return out
}

function sorgenti(dir = SRC): string[] {
    const out: string[] = []
    for (const voce of fs.readdirSync(dir, { withFileTypes: true })) {
        const assoluto = path.join(dir, voce.name)
        if (voce.isDirectory()) { out.push(...sorgenti(assoluto)); continue }
        if (!/\.tsx?$/.test(voce.name)) continue
        out.push(path.relative(RADICE, assoluto).split(path.sep).join('/'))
    }
    return out
}

/** Le occorrenze del letterale nel CODICE (commenti esclusi), con `file:riga`. */
function occorrenzeNelCodice(): string[] {
    const trovate: string[] = []
    for (const f of sorgenti()) {
        const src = mascheraCommenti(fs.readFileSync(path.join(RADICE, f), 'utf8'))
        src.split('\n').forEach((riga, i) => {
            if (riga.includes(LETTERALE)) trovate.push(`${f}:${i + 1}`)
        })
    }
    return trovate
}

describe('lock — `hard_delete_gdpr` non può più essere scritto da src/', () => {
    it('nessun punto di src/ nomina il letterale fuori dai commenti', () => {
        expect(
            occorrenzeNelCodice(),
            'Qualcuno può di nuovo scrivere in `registro_modifiche` una riga che dichiara ' +
                'cancellato un alunno. Il 2026-08-12 quelle righe erano TRE, tutte false: l’audit ' +
                'veniva scritto prima della `delete`, la FK la respingeva (28 alunni su 33) e in ' +
                'tabella restava la copia integrale della riga di un minore — note mediche ' +
                'comprese — sotto un’etichetta che diceva «eliminato». Il ciclo di vita ' +
                'dell’alunno passa da `POST /api/admin/students/archivia`, che è reversibile e ' +
                'non cancella niente; l’oblio vero (art. 17) resta in `admin/gdpr/erase`, dietro ' +
                'una richiesta registrata.',
        ).toEqual([])
    })

    it('la scansione VEDE davvero il letterale (controllo positivo)', () => {
        // Senza questa prova il test qui sopra sarebbe verde anche con un
        // `mascheraCommenti` che cancella tutto o una `sorgenti()` che non
        // restituisce niente: «zero occorrenze» e «non ho guardato» hanno lo
        // stesso colore.
        expect(sorgenti().length).toBeGreaterThan(500)

        const conCodice = mascheraCommenti(
            `const a = { azione: '${LETTERALE}' } // ${LETTERALE}\n/* ${LETTERALE} */\n`,
        )
        // la stringa sopravvive…
        expect(conCodice).toContain(`'${LETTERALE}'`)
        // …e le due copie nei commenti sono sparite: resta UNA sola occorrenza.
        expect(conCodice.split(LETTERALE).length - 1).toBe(1)
    })

    it('la migrazione di bonifica esiste ancora (l’effetto e la causa vanno insieme)', () => {
        // Il lock toglie la causa; le tre righe false le ha tolte la migrazione. Se
        // qualcuno cancellasse quel file da `supabase/migrations`, un ambiente
        // ricostruito da zero non avrebbe la bonifica e questo lock, da solo,
        // sembrerebbe raccontare una storia già chiusa.
        const dir = path.join(RADICE, 'supabase/migrations')
        const bonifica = fs
            .readdirSync(dir)
            .filter((f) => f.includes('bonifica_registro_modifiche_hard_delete'))
        expect(
            bonifica,
            'Manca la migrazione che ha rimosso da `registro_modifiche` le righe ' +
                '`hard_delete_gdpr` false. Vedi 20260812194614_bonifica_registro_modifiche_hard_delete.sql.',
        ).toHaveLength(1)
    })
})
