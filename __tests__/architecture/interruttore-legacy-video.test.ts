import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { BLOCCO_LEGACY_VIDEO_ATTIVO } from '@/lib/media/interruttore-legacy-video'

/**
 * LOCK — il blocco del percorso vecchio dei video ha UN SOLO INTERRUTTORE.
 *
 * ─── PERCHÉ UN LOCK, E NON UN COMMENTO ──────────────────────────────────────
 * Il blocco entra nel codice adesso e si accende il giorno del rilascio: è una
 * regola di rilascio, non di codice. Tutto il peso di quel disegno sta su una
 * frase — «si accende cambiando un valore in un posto solo» — e una frase non si
 * fa rispettare da sola. Se il giorno del rilascio gli interruttori fossero due,
 * uno dei due resterebbe spento: il percorso vecchio si chiuderebbe a metà, e
 * nessuno se ne accorgerebbe finché una maestra non chiama per dire che i video
 * di una sede non si caricano più. Questo file rende quel giorno impossibile.
 *
 * ⚠️ IL TEST GEMELLO È QUELLO CHE CONTA DAVVERO:
 * `__tests__/api/video-legacy-blocco.test.ts` sostituisce quell'unico valore e
 * misura che TUTTE E TRE le porte si ribaltino insieme — la prova empirica che
 * uno solo basta. Qui si misura l'altra metà: che non ce ne sia un secondo, e
 * che nessuna porta si sottragga.
 */

const RADICE = process.cwd()
const SRC = join(RADICE, 'src')
const INTERRUTTORE = 'src/lib/media/interruttore-legacy-video.ts'
const DECISIONE = 'src/lib/media/blocco-legacy-video.ts'

/**
 * Sostituisce i commenti con spazi lasciando INTATTE le stringhe e i ritorni a
 * capo. È la stessa funzione di `errori-con-codice.test.ts`, e serve per la
 * stessa ragione: qui i commenti PARLANO di `true` e di `false` («si cambia
 * `false` in `true`»), e un lock che leggesse il file come testo grezzo
 * conterebbe le parole della spiegazione insieme al codice.
 */
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
        if (c === '\\') { out += c + (d ?? ''); i += 2; continue }
        if (c === apice) stato = 'code'
        out += c; i++
    }
    return out
}

function sorgentiDi(dir: string): string[] {
    const out: string[] = []
    const visita = (d: string): void => {
        for (const voce of readdirSync(d)) {
            const p = join(d, voce)
            if (statSync(p).isDirectory()) visita(p)
            else if (/\.tsx?$/.test(p)) out.push(p)
        }
    }
    visita(dir)
    return out
}

const rel = (p: string) => relative(RADICE, p).split('\\').join('/')

/** Il codice di ogni file di `src/`, coi commenti già tolti. */
const CODICE = new Map<string, string>(
    sorgentiDi(SRC).map((p) => [rel(p), mascheraCommenti(readFileSync(p, 'utf8'))]),
)

describe('l\'interruttore del blocco legacy è uno solo', () => {
    it('è una riga sola, e il suo valore è un letterale booleano scritto lì', () => {
        const codice = CODICE.get(INTERRUTTORE)
        expect(codice, `${INTERRUTTORE} deve esistere: è l'interruttore`).toBeDefined()
        const righe = (codice ?? '').split('\n').map((r) => r.trim()).filter((r) => r !== '')
        // UNA riga di codice e basta. Il resto del file è la spiegazione di quando
        // si accende: se un giorno comparisse una seconda riga — un `process.env`,
        // una data, un secondo flag per canale — questo test diventa rosso PRIMA
        // che qualcuno ci costruisca sopra.
        expect(righe).toEqual(['export const BLOCCO_LEGACY_VIDEO_ATTIVO: boolean = false'])
    })

    it('oggi è SPENTO: si scrive presto, si accende tardi', () => {
        // Non è una preferenza. Accenderlo prima che la pipeline nuova funzioni
        // toglie l'unico modo di caricare un video che le famiglie e le maestre
        // hanno: il percorso vecchio chiuso e quello nuovo non ancora aperto.
        // Il giorno del rilascio questa riga diventa `toBe(true)`, insieme al
        // valore — e sono le uniche due righe da toccare in tutto il repo.
        expect(BLOCCO_LEGACY_VIDEO_ATTIVO).toBe(false)
    })

    it('lo legge un solo file: la decisione non si duplica in giro per `src/`', () => {
        const lettori = [...CODICE.entries()]
            .filter(([percorso, codice]) => percorso !== INTERRUTTORE && codice.includes('BLOCCO_LEGACY_VIDEO_ATTIVO'))
            .map(([percorso]) => percorso)
            .sort()
        // Un secondo lettore vorrebbe dire una seconda condizione da tenere
        // allineata a mano: la forma esatta in cui un interruttore diventa due.
        expect(lettori).toEqual([DECISIONE])
    })
})

describe('nessuna porta si sottrae al blocco', () => {
    it('ogni route API che tratta i video passa da `videoLegacyDaFermare`', () => {
        // Il criterio non è un elenco scritto a mano — quello invecchia il giorno
        // in cui nasce la quarta porta. È una MISURA: una route che si comporta
        // diversamente per i video (`startsWith('video/')`) è, per definizione, una
        // porta che i video li riceve. Se non chiama il blocco, resterebbe aperta
        // il giorno dell'accensione.
        //
        // ⚠️ `src/app/api/video-uploads/**` è fuori di proposito: è la pipeline
        // NUOVA, cioè la porta verso cui il 409 manda le app aggiornate. Bloccarla
        // sarebbe chiudere anche la strada d'uscita.
        const scoperte = [...CODICE.entries()]
            .filter(([percorso]) => percorso.startsWith('src/app/api/'))
            .filter(([percorso]) => !percorso.startsWith('src/app/api/video-uploads/'))
            .filter(([, codice]) => /startsWith\(\s*['"]video\//.test(codice))
            .filter(([, codice]) => !codice.includes('videoLegacyDaFermare'))
            .map(([percorso]) => percorso)
            .sort()
        expect(scoperte).toEqual([])
    })

    it('le tre porte storiche sono coperte tutte e tre, e si chiamano queste', () => {
        // Il controllo positivo accanto a quello negativo: senza, il test qui sopra
        // resterebbe verde anche il giorno in cui qualcuno cancellasse le tre
        // chiamate insieme al ramo `startsWith('video/')` — cioè proprio quando il
        // blocco è sparito.
        const coperte = [...CODICE.entries()]
            .filter(([percorso, codice]) => percorso.startsWith('src/app/api/') && codice.includes('videoLegacyDaFermare'))
            .map(([percorso]) => percorso)
            .sort()
        expect(coperte).toEqual([
            'src/app/api/gallery/upload-url/route.ts',
            'src/app/api/gallery/upload/route.ts',
            'src/app/api/news/upload/route.ts',
        ])
    })

    it('il modulo del blocco lo importano SOLO route API, mai un componente', () => {
        // Non è pignoleria di architettura: `blocco-legacy-video` tira dentro
        // `@/app/api/video-uploads/risposte` e `@/lib/logging/logger`, cioè il
        // client service-role del server. Un componente che lo importasse se li
        // porterebbe nel bundle del BROWSER — è esattamente il guasto raccontato
        // nella testata di `src/lib/gallery/limiti.ts`, che per quel motivo è un
        // file senza nemmeno un import.
        const importatori = [...CODICE.entries()]
            .filter(([percorso]) => percorso !== DECISIONE)
            .filter(([, codice]) => codice.includes("from '@/lib/media/blocco-legacy-video'"))
            .map(([percorso]) => percorso)
            .sort()
        expect(importatori.filter((p) => !p.startsWith('src/app/api/'))).toEqual([])
    })

    it('fuori dalla pipeline nuova, `CLIENT_UPDATE_REQUIRED` lo nomina un file solo', () => {
        // Il codice di bordo nasce nel contratto e la risposta si costruisce in un
        // posto solo. Un secondo 409 scritto a mano da qualche altra parte sarebbe
        // un blocco che l'interruttore non governa: acceso quando non deve, o —
        // peggio — spento il giorno in cui tutti gli altri si accendono.
        const fuori = [...CODICE.entries()]
            .filter(([percorso]) => !percorso.startsWith('src/lib/media/video/'))
            .filter(([percorso]) => !percorso.startsWith('src/app/api/video-uploads/'))
            .filter(([, codice]) => codice.includes('CLIENT_UPDATE_REQUIRED'))
            .map(([percorso]) => percorso)
            .sort()
        expect(fuori).toEqual([DECISIONE])
    })
})
