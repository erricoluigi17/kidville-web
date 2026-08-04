import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TINTA_FUNZIONE, ALIAS_FUNZIONE, tintaFunzione } from '@/lib/ui/tinte-funzioni'

/**
 * LOCK — una funzione, un colore, per chiunque guardi (rilievo T08-F2).
 *
 * ─── IL DIFETTO CHE QUESTO LOCK IMPEDISCE ──────────────────────────────────
 * Fra la bottom-nav del genitore e quella del docente, misurate il 2026-08-03,
 * **non una sola voce omologa** condivideva la tinta: 11 su 11 divergevano. La
 * mensa era verde per il genitore e arancione per il docente, il diario verde di
 * qua e blu di là. Sei di quelle tinte non corrispondevano a nessun token
 * dichiarato. Un genitore che è anche docente — caso reale in una scuola —
 * vedeva due mappe cromatiche in conflitto per le stesse funzioni.
 *
 * ─── PERCHÉ NON BASTA GUARDARE LA MAPPA ────────────────────────────────────
 * `TINTA_FUNZIONE` potrebbe essere perfetta e non essere letta da nessuno: è
 * esattamente ciò che è successo alle variabili `--kv-grade-*` di `globals.css`,
 * che esistevano da mesi con ZERO lettori in tutto `src/`. Un lock che verifica
 * solo la coerenza della mappa sarebbe verde su un'app che continua a scriversi
 * gli hex a mano.
 *
 * Quindi qui si guardano tre cose diverse, e la seconda è quella che conta:
 *   1. la mappa è coerente (nessun alias orfano, nessun valore fuori formato);
 *   2. **le due navigazioni la USANO davvero** — nessun hex letterale nei `tint:`;
 *   3. il modulo resta uno SPECCHIO fedele di `globals.css`.
 *
 * ─── PROVA DI VALIDITÀ, dentro questo stesso file ──────────────────────────
 * L'ultimo `describe` mette alla prova il RILEVATORE con il difetto di ieri
 * ricostruito a mano, invece di fidarsi che «passa perché il repo è pulito». Un
 * lock verde perché non trova violazioni e un lock verde perché non guarda più
 * niente, da fuori, sono identici.
 */

const RADICE = process.cwd()
const NAV_GENITORE = 'src/components/features/parent/BottomNav.tsx'
const NAV_DOCENTE = 'src/components/features/teacher/TeacherBottomNav.tsx'
const GLOBALS = 'src/app/globals.css'

const leggi = (rel: string) => readFileSync(join(RADICE, rel), 'utf8')

/** Ogni `{ id: 'x', … tint: … }` di un file di navigazione, con la forma del `tint`. */
function vociDiNavigazione(sorgente: string): { id: string; tint: string; riga: number }[] {
    const out: { id: string; tint: string; riga: number }[] = []
    sorgente.split('\n').forEach((riga, i) => {
        const id = /\{\s*id:\s*'([a-zA-Z]+)'/.exec(riga)
        const tint = /tint:\s*([^,]+)/.exec(riga)
        if (id && tint) out.push({ id: id[1], tint: tint[1].trim(), riga: i + 1 })
    })
    return out
}

describe('lock — le tinte delle funzioni sono uniche fra i ruoli', () => {
    it('ogni alias punta a una funzione che esiste davvero', () => {
        const orfani = Object.entries(ALIAS_FUNZIONE)
            .filter(([, canonico]) => !(canonico in TINTA_FUNZIONE))
            .map(([alias, canonico]) => `${alias} → ${canonico}`)
        expect(
            orfani,
            'Un alias punta a una funzione che non è nella mappa: `tintaFunzione` restituirebbe ' +
            '`undefined`, e in `style={{ background: tinta + "18" }}` diventerebbe la stringa ' +
            '«undefined18» — cioè nessuno sfondo, in silenzio.',
        ).toEqual([])
    })

    it('ogni tinta è un hex a sei cifre (serve per la concatenazione con l’alfa)', () => {
        const fuoriFormato = Object.entries(TINTA_FUNZIONE)
            .filter(([, v]) => !/^#[0-9A-Fa-f]{6}$/.test(v))
            .map(([k, v]) => `${k} = ${v}`)
        expect(
            fuoriFormato,
            'Questi valori finiscono in una CONCATENAZIONE che costruisce un colore con alfa ' +
            '(`tinta + "18"`). Un `var(--x)` produrrebbe `var(--x)18`, che non è un colore e ' +
            'viene scartato: è la lezione «hex→var mai su base-di-concat-alpha», già pagata.',
        ).toEqual([])
    })

    // ⟵ IL CUORE DEL LOCK
    it('le due navigazioni prendono la tinta dalla mappa, non da un hex scritto a mano', () => {
        const colpevoli: string[] = []
        for (const file of [NAV_GENITORE, NAV_DOCENTE]) {
            for (const v of vociDiNavigazione(leggi(file))) {
                if (/^'#/.test(v.tint) || /^"#/.test(v.tint)) {
                    colpevoli.push(`${file}:${v.riga} — id '${v.id}' usa ${v.tint}`)
                }
            }
        }
        expect(
            colpevoli,
            'Una voce di navigazione si scrive la tinta a mano invece di chiederla a ' +
            '`tintaFunzione(id)`. È così che le due navigazioni sono arrivate a divergere su ' +
            '11 voci su 11: nessuno lo aveva deciso, semplicemente ognuna se le è riscritte.',
        ).toEqual([])
    })

    it('le voci omologhe hanno la STESSA tinta nei due ruoli', () => {
        const genitore = new Map(vociDiNavigazione(leggi(NAV_GENITORE)).map((v) => [v.id, v]))
        const docente = new Map(vociDiNavigazione(leggi(NAV_DOCENTE)).map((v) => [v.id, v]))

        const divergenti: string[] = []
        for (const [id] of genitore) {
            const canonico = ALIAS_FUNZIONE[id] ?? id
            // La voce del docente che corrisponde: stesso id, oppure un alias che porta lì.
            const omologa = [...docente.keys()].find((k) => (ALIAS_FUNZIONE[k] ?? k) === canonico)
            if (omologa === undefined) continue
            const a = tintaFunzione(id)
            const b = tintaFunzione(omologa)
            if (a !== b) divergenti.push(`${id} (${a}) ≠ ${omologa} (${b})`)
        }
        expect(
            divergenti,
            'La stessa funzione ha due colori a seconda di chi guarda. Il design system di questo ' +
            'repo dichiara tinte per-DATO, mai per-RUOLO: se una divergenza è voluta, va decisa nel ' +
            'design e non lasciata nascere da due file che non si parlano.',
        ).toEqual([])
    })

    it('il modulo è uno SPECCHIO fedele di globals.css', () => {
        const css = leggi(GLOBALS)
        const sorgente = leggi('src/lib/ui/tinte-funzioni.ts')

        // Le variabili che il modulo dichiara di rispecchiare, con il valore che si aspetta.
        const attese = [...sorgente.matchAll(/'(kv-(?:grade|subj)-[a-z]+|color-kidville-sub)':\s*'(#[0-9A-Fa-f]{6})'/g)]
        expect(
            attese.length,
            'Nessuna variabile rispecchiata trovata: la regex di questo lock non riconosce più la ' +
            'forma di `TINTE_SORGENTE`, quindi il confronto qui sotto girerebbe a vuoto.',
        ).toBeGreaterThan(5)

        const disallineate: string[] = []
        for (const [, nome, valore] of attese) {
            const inCss = new RegExp(`--${nome}:\\s*(#[0-9A-Fa-f]{6})`, 'i').exec(css)
            if (inCss === null) {
                disallineate.push(`--${nome} non esiste più in globals.css`)
            } else if (inCss[1].toLowerCase() !== valore.toLowerCase()) {
                disallineate.push(`--${nome}: globals.css dice ${inCss[1]}, il modulo dice ${valore}`)
            }
        }
        expect(
            disallineate,
            'Il modulo è uno specchio dichiarato di `globals.css`: se i due lati divergono, ' +
            'l’interfaccia mostra un colore che il tema non conosce — e l’Alto Contrasto, che ' +
            'rimappa le variabili CSS, non lo raggiunge.',
        ).toEqual([])
    })
})

/**
 * PROVA DI VALIDITÀ PERMANENTE — il rilevatore messo alla prova sul difetto vero.
 *
 * Queste asserzioni non guardano il repo: costruiscono a mano la riga com'era
 * prima della correzione e pretendono che il rilevatore la veda. Se domani
 * qualcuno «semplifica» `vociDiNavigazione` e smette di riconoscere la forma,
 * questi test cadono anche con il repo pulito.
 */
describe('il rilevatore riconosce la forma vietata', () => {
    it('vede un hex scritto a mano dentro un `tint:`', () => {
        const riga = "{ id: 'mensa', label: t('x'), icon: A, href: '/y', tint: '#1F8A5B', grado: 'comune' },"
        const voci = vociDiNavigazione(riga)
        expect(voci).toHaveLength(1)
        expect(voci[0].id).toBe('mensa')
        expect(/^'#/.test(voci[0].tint)).toBe(true)
    })

    it('NON si accende su una voce che chiede la tinta alla mappa', () => {
        const riga = "{ id: 'mensa', label: t('x'), icon: A, href: '/y', tint: tintaFunzione('mensa'), grado: 'comune' },"
        const voci = vociDiNavigazione(riga)
        expect(voci).toHaveLength(1)
        expect(/^'#/.test(voci[0].tint)).toBe(false)
    })

    it('gli alias del docente risolvono alla stessa tinta della voce del genitore', () => {
        // Erano i quattro casi in cui la stessa funzione ha due nomi: se un alias
        // sparisse, la divergenza tornerebbe senza che nessun altro test se ne accorga.
        expect(tintaFunzione('appello')).toBe(tintaFunzione('presenze'))
        expect(tintaFunzione('bacheca')).toBe(tintaFunzione('avvisi'))
        expect(tintaFunzione('messaggi')).toBe(tintaFunzione('chat'))
        expect(tintaFunzione('moduli')).toBe(tintaFunzione('modulistica'))
    })
})
