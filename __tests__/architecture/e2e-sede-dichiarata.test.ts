import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * LOCK · lo `storageState` dell'admin E2E DICHIARA la sua sede — e un altro spec
 * collauda apposta il caso in cui non la dichiara.
 *
 * ─── IL FATTO, MISURATO (2026-08-12) ────────────────────────────────────────
 *
 * In produzione non esiste un admin mono-sede: i due admin veri hanno TRE sedi
 * ciascuno (Giugliano, Aversa, Cesa). Con più di una sede accessibile e nessuna
 * dichiarata, `sedeCorrente` è `null` e ogni pagina sotto `SedeRequired`
 * (contabilità, news, mensa, modulistica, primaria, impostazioni, SIDI) mostra
 * `SedeNotice` al posto dei propri pannelli: è il prodotto che fa ciò per cui è
 * scritto — quelle pagine lavorano su UNA sede alla volta.
 *
 * Aggiunto al seed il ponte `utenti_scuole` che rende l'admin di collaudo
 * multi-sede (serve ai moduli pubblici), sei spec preesistenti sono diventati
 * rossi — 4 di contabilità e 2 di news — accusando pannelli sani. Il rimedio non
 * è nelle asserzioni: è nello STATO DI PARTENZA. L'admin vero lavora quasi
 * sempre con il cookie `sedi_attive` scritto (dura un anno), quindi lo
 * `storageState` deve rispecchiarlo.
 *
 * ─── PERCHÉ UN LOCK, E NON SOLO IL COMMENTO NEL FILE ────────────────────────
 *
 * Perché quella riga, letta fra sei mesi, sembra superflua: «un cookie nel
 * setup? togliamolo». Toglierla non rompe niente subito — riporta il banco di
 * prova a una configurazione che in produzione NON ESISTE (un admin con una
 * sede sola), e i sei spec tornano verdi collaudando un caso irreale. È il
 * genere di regressione che nessun rosso segnala, e l'unica cosa che se ne
 * accorgerebbe è un utente vero. Qui costa due secondi dentro `vitest`.
 *
 * ─── COSA CONTROLLA ─────────────────────────────────────────────────────────
 *
 *  1. il setup dell'admin scrive il cookie `sedi_attive` PRIMA di salvare il
 *     proprio `storageState` (l'ordine è il punto: dopo, non finirebbe nel file);
 *  2. esiste uno spec che quel cookie se lo TOGLIE, cioè che collauda il primo
 *     schermo dell'admin multi-sede — altrimenti, dichiarando la sede ovunque,
 *     il caso tornerebbe scoperto com'era prima;
 *  3. nessuno spec si aspetta righe del «Plesso di Collaudo» partendo da uno
 *     scope che lo esclude. È la trappola scoperta scrivendo il punto 1: quel
 *     cookie non è solo una preferenza della UI — `resolveScuoleAttive` ci scopa
 *     OGNI lettura del server, quindi la pratica del personale, che nasce su
 *     quella sede, sarebbe sparita dal cockpit con un rosso che accusa il
 *     pannello. Per quegli spec esiste `STORAGE.adminTutteLeSedi`;
 *  4. le controprove: i due riconoscitori sanno dire di NO. Un lock che non sa
 *     fallire è un lock che non guarda.
 */

const RADICE = process.cwd()
const SETUP = join(RADICE, 'e2e', 'auth.setup.ts')
const SPEC_SCELTA = join(RADICE, 'e2e', 'admin-scelta-sede.spec.ts')

const COME_SI_CORREGGE =
    "Il setup dell'admin (`e2e/auth.setup.ts`) deve aggiungere il cookie `sedi_attive` " +
    '(valore: `IDS.SCUOLA`) PRIMA di `storageState({ path: STORAGE.admin })`. ' +
    "Senza, l'admin del seed riproduce una configurazione che in produzione non esiste " +
    '(mono-sede) e sei spec diventano rossi su pannelli sani. Il caso «senza cookie» ha ' +
    'il suo spec dedicato: `e2e/admin-scelta-sede.spec.ts`.'

/**
 * Il setup dell'admin dichiara la sede prima di salvare lo stato?
 *
 * Funzione pura sul TESTO del file: è ciò che permette al punto 3 di provarla su
 * un caso finto, invece di fidarsi che il controllo funzioni.
 */
function dichiaraLaSedePrimaDiSalvare(sorgente: string): boolean {
    const cookie = sorgente.indexOf('sedi_attive')
    if (cookie < 0) return false
    if (!/addCookies\s*\(/.test(sorgente)) return false
    // `\b` dopo `admin`: `STORAGE.adminTutteLeSedi` è un ALTRO stato — quello
    // senza cookie — e va salvato PRIMA. Cercare la sottostringa nuda
    // troverebbe lui e misurerebbe l'ordine sbagliato.
    const salvataggio = sorgente.search(/\bSTORAGE\.admin\b/)
    if (salvataggio < 0) return false
    return cookie < salvataggio
}

/** I modi in cui uno spec nomina la sede dei moduli pubblici. */
const NOMINA_LA_SEDE_DI_COLLAUDO = /Plesso di Collaudo|SCUOLA_COLLAUDO|NOMI_SEDI\.collaudo/

/**
 * Uno spec che si aspetta righe del «Plesso di Collaudo» partendo dallo stato
 * admin CON la sede dichiarata è rosso in CI e non può sapersi qui: quel cookie
 * non tocca solo la UI, `resolveScuoleAttive` ci scopa ogni lettura del server.
 * Deve usare lo stato «Tutte le sedi», oppure gestirsi il cookie da sé.
 */
function scopeCoerente(sorgente: string): boolean {
    if (!/\bSTORAGE\.admin\b/.test(sorgente)) return true
    if (!NOMINA_LA_SEDE_DI_COLLAUDO.test(sorgente)) return true
    return sorgente.includes('adminTutteLeSedi') || sorgente.includes('sedi_attive')
}

describe('LOCK · la sede dell’admin E2E è dichiarata nello storageState', () => {
    it('il setup scrive `sedi_attive` prima di salvare lo stato dell’admin', () => {
        const sorgente = readFileSync(SETUP, 'utf8')
        expect(dichiaraLaSedePrimaDiSalvare(sorgente), COME_SI_CORREGGE).toBe(true)
        // Il valore è l'id della sede del seed, non un letterale incollato: gli
        // uuid di sede non si scrivono a mano (vedi il lock delle migrazioni).
        expect(sorgente).toMatch(/value:\s*IDS\.SCUOLA\b/)
    })

    it('il caso SENZA cookie resta collaudato: lo spec della scelta lo cancella apposta', () => {
        const spec = readFileSync(SPEC_SCELTA, 'utf8')
        expect(spec).toMatch(/clearCookies\(\{\s*name:\s*'sedi_attive'/)
        // E ci arriva da autenticato: altrimenti collauderebbe la pagina di login.
        expect(spec).toContain('STORAGE.admin')
    })

    it('gli spec che leggono il «Plesso di Collaudo» non partono da uno scope che lo esclude', () => {
        // La trappola, misurata il 2026-08-12 mentre si scriveva questa riga: il
        // cookie `sedi_attive` non è solo una preferenza della UI —
        // `resolveScuoleAttive` (`src/lib/auth/scope.ts`) ci scopa OGNI lettura del
        // server. Dichiarando la sede principale nello `storageState` dell'admin,
        // i due spec del personale — la cui pratica nasce sul «Plesso di Collaudo»,
        // la sede che i moduli pubblici vedono — avrebbero smesso di trovarla, con
        // un rosso che accusa il cockpit invece dello scope. Sarebbe emerso solo in
        // CI, dopo trenta minuti.
        const colpevoli = readdirSync(join(RADICE, 'e2e'))
            .filter((f) => f.endsWith('.spec.ts'))
            .filter((f) => !scopeCoerente(readFileSync(join(RADICE, 'e2e', f), 'utf8')))
        expect(
            colpevoli,
            'Questi spec nominano la sede dei moduli pubblici ma partono da `STORAGE.admin`, che '
            + 'dichiara la sede principale: le loro righe sono fuori scope. Si usa '
            + '`STORAGE.adminTutteLeSedi` (lo stato «Tutte le sedi»), oppure ci si gestisce il '
            + 'cookie `sedi_attive` nello spec.',
        ).toEqual([])
    })

    it('controprova: un setup che NON dichiara la sede viene riconosciuto', () => {
        const senzaCookie = [
            "setup('storageState admin', async ({ page }) => {",
            '  await login(page, EMAILS.admin);',
            "  await page.context().storageState({ path: STORAGE.admin });",
            '});',
        ].join('\n')
        expect(dichiaraLaSedePrimaDiSalvare(senzaCookie)).toBe(false)

        // E nemmeno l'ordine sbagliato passa: un cookie aggiunto DOPO il
        // salvataggio non entra nel file, e il banco di prova resterebbe com'era.
        const ordineSbagliato = [
            "  await page.context().storageState({ path: STORAGE.admin });",
            "  await page.context().addCookies([{ name: 'sedi_attive', value: IDS.SCUOLA }]);",
        ].join('\n')
        expect(dichiaraLaSedePrimaDiSalvare(ordineSbagliato)).toBe(false)

        // Stessa onestà per il controllo di scope: uno spec che si aspetta righe
        // del Plesso di Collaudo partendo da `STORAGE.admin` va riconosciuto, e
        // lo stesso spec con lo stato «Tutte le sedi» va lasciato passare.
        expect(scopeCoerente(
            "test.use({ storageState: STORAGE.admin });\nawait expect(p.getByText('Plesso di Collaudo'))",
        )).toBe(false)
        expect(scopeCoerente(
            "test.use({ storageState: STORAGE.adminTutteLeSedi });\n'Plesso di Collaudo'",
        )).toBe(true)
    })
})
