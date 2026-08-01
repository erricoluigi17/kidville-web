import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Lock — LA PASSWORD DEGLI ACCOUNT TEST NON RESTA NEI LOG DI MAESTRO.
 *
 * LA STORIA, misurata e non temuta. Maestro scrive la password **in chiaro** dentro
 * `~/.maestro/tests/<run>/maestro.log`, e non c'è modo di impedirglielo dal flow: il
 * 2026-08-01, con due canarini finti, si è verificato che finisce nel log sia il valore
 * passato come variabile d'ambiente sia quello passato con `-e NOME=valore`, e che in più
 * Maestro logga da sé il testo digitato (`Inputting text: <password>`).
 *
 * Non è una password qualunque: è quella, UNICA, dei 41 account TEST che vivono in
 * PRODUZIONE — fra cui `test.segreteria@kidville.test`, che legge l'anagrafica dell'intera
 * sede, e `test.multisede.admin@kidville.test`, che vede tutte e tre le sedi.
 *
 * Il 2026-08-01 sotto `~/.maestro/tests` c'erano **70 file** con la password corrente in
 * chiaro (278 occorrenze) e, dopo averli ripuliti, altre **156 righe** con password già
 * RUOTATE. Il rimedio esisteva già — `esegui.sh` con la sua bonifica — ma:
 *   · nessuno l'aveva mai eseguito, perché il README insegnava `maestro test` a mano;
 *   · e inseguiva UN valore, quello corrente, quindi era cieco su tutti gli altri.
 *
 * QUEST'ULTIMO È IL PUNTO. Una pulizia che insegue un valore diventa cieca da sé a ogni
 * rotazione della password: il giorno dopo la rotazione i log vecchi non vengono più
 * toccati da nessuno, e nessuno se ne accorge perché il file «è passato dalla bonifica».
 * Perciò questo lock non chiede che la bonifica ESISTA — chiede che sia per FORMA.
 *
 * PERCHÉ UN LOCK E NON UNA NOTA. Tutto il resto dello step S12 è sorvegliato da
 * `maestro-flows-selettori.test.ts`; questa metà no, ed è quella che può tornare senza
 * fare rumore: basta che qualcuno «semplifichi» la funzione o riscriva l'esempio nel
 * README. La verifica del contenuto di `~/.maestro/tests` non sta qui di proposito — è
 * fuori dal repo, non esiste in CI, e un lock che dipende dalla macchina di chi lo lancia
 * è un lock che si impara a spegnere.
 */

const RADICE = process.cwd()
const FLOWS = join(RADICE, '.claude', 'maestro-flows')
const SCRIPT = join(FLOWS, 'esegui.sh')

const script = existsSync(SCRIPT) ? readFileSync(SCRIPT, 'utf8') : ''

describe('lock architettura · la password TEST non sopravvive nei log di Maestro', () => {
    it("l'esecutore con la bonifica esiste ed è eseguibile", () => {
        expect(
            existsSync(SCRIPT),
            `Manca \`.claude/maestro-flows/esegui.sh\`. È l'unico posto in cui la password degli ` +
            `account TEST di produzione viene tolta dai log di Maestro: senza, ogni esecuzione ` +
            `di un flow la lascia in chiaro su disco.`,
        ).toBe(true)
        // Un file non eseguibile è un file che nessuno lancerà: si tornerebbe a
        // `maestro test` a mano, cioè al difetto.
        expect(
            (statSync(SCRIPT).mode & 0o111) !== 0,
            `\`esegui.sh\` non ha il bit di esecuzione: \`chmod +x .claude/maestro-flows/esegui.sh\`.`,
        ).toBe(true)
    })

    it('la bonifica è agganciata a trap EXIT INT TERM, non alla fine dello script', () => {
        // Il caso pericoloso è quello in cui lo script NON arriva in fondo: flow fallito,
        // Ctrl-C, timeout dell'orchestratore. Se la pulizia sta in coda, lì il segreto resta.
        const trap = /trap\s+bonifica\s+EXIT\s+INT\s+TERM/.exec(script)
        expect(
            trap?.[0],
            `La bonifica deve essere agganciata a \`trap bonifica EXIT INT TERM\`: se sta in coda ` +
            `allo script, un flow fallito o un Ctrl-C lasciano la password su disco — ed è ` +
            `esattamente quando un collaudo va male che si preme Ctrl-C.`,
        ).toBeTruthy()
    })

    it('la bonifica maschera per FORMA, non solo il valore corrente', () => {
        // ⟵ IL CUORE DEL LOCK. `s/\Q$p\E/***/g` da solo era il difetto del 2026-08-01:
        // ripuliva la password di oggi e lasciava intatte tutte quelle di ieri.
        const perForma = [
            { chiave: 'MAESTRO_KV_PASSWORD=', re: /MAESTRO_KV_PASSWORD=\)/ },
            { chiave: 'Inputting text: ', re: /Inputting text: \)/ },
        ]
        const assenti = perForma.filter((p) => !p.re.test(script)).map((p) => p.chiave)
        expect(
            assenti,
            `La bonifica non maschera per FORMA questi punti: una pulizia che insegue il solo ` +
            `valore corrente è cieca sulle password già ruotate, e lo diventa da sé a ogni ` +
            `rotazione. Il 2026-08-01 restavano 156 righe in chiaro proprio per questo.`,
        ).toEqual([])

        // Controllo positivo: senza la sostituzione del valore corrente, le due regex per
        // forma non coprirebbero un log che scrive la password in una riga di forma nuova.
        expect(
            /\\Q\$p\\E/.test(script),
            `Sparita la sostituzione del valore corrente (\`s/\\Q$p\\E/***/g\`): la bonifica per ` +
            `forma copre i due punti noti, non una riga che Maestro imparasse a scrivere domani.`,
        ).toBe(true)
    })

    it('la bonifica guarda tutti i file, non tre estensioni indovinate', () => {
        const find = /find\s+"\$dir"\s+-type\s+f([^\n]*)/.exec(script)
        expect(find, 'Non trovo il `find` della bonifica in esegui.sh').toBeTruthy()
        expect(
            find?.[1] ?? '',
            `Il \`find\` della bonifica filtra per estensione. Quella terna (\`*.log\`, \`*.json\`, ` +
            `\`*.txt\`) era un'ipotesi su come Maestro nomina i suoi file, e un'ipotesi sbagliata ` +
            `qui si paga in segreti: deve passare su -type f e basta.`,
        ).not.toMatch(/-name/)
    })

    it('lo script non contiene la password: la legge da KV_TEST_PASSWORD', () => {
        expect(
            /KV_TEST_PASSWORD/.test(script),
            `\`esegui.sh\` deve prendere la password da \`KV_TEST_PASSWORD\` — la sorgente unica ` +
            `di tutto il repo (\`e2e/lib/test-password.mjs\`, \`scripts/seed-test-sedi.mjs\`).`,
        ).toBe(true)
        // Assente → si esce, senza default e senza stringa vuota: una password vuota
        // farebbe girare la bonifica su `s//***/g`, che è un modo elaborato di non pulire.
        expect(
            /if\s+\[\[\s+-z\s+"\$PW"\s+\]\]/.test(script),
            `Senza la guardia sul valore vuoto, \`esegui.sh\` lancerebbe il flow con una password ` +
            `vuota e la bonifica girerebbe a vuoto.`,
        ).toBe(true)
    })

    it('nessun documento insegna a lanciare i flow con la password in variabile', () => {
        // È il difetto che ha prodotto i 70 file: il README mostrava
        // `maestro test -e KV_PASSWORD="$MAESTRO_KV_PASSWORD" …` e non nominava esegui.sh.
        // Chi segue la documentazione riempie i log, e lo fa in buona fede.
        const documenti = readdirSync(FLOWS)
            .filter((f) => f.endsWith('.md') || f.endsWith('.yaml'))
            .map((f) => ({ nome: f, testo: readFileSync(join(FLOWS, f), 'utf8') }))

        const colpevoli: string[] = []
        for (const d of documenti) {
            d.testo.split('\n').forEach((riga, i) => {
                // Si cerca l'INVOCAZIONE, non la parola: i file possono (e devono) parlare
                // del problema, spiegarlo e citare il nome della variabile.
                if (/^\s*maestro\s+test\b/.test(riga)) colpevoli.push(`${d.nome}:${i + 1}`)
                if (/-e\s+KV_PASSWORD=/.test(riga)) colpevoli.push(`${d.nome}:${i + 1}`)
            })
        }
        expect(
            [...new Set(colpevoli)].sort(),
            `Questi punti insegnano a invocare Maestro direttamente. I flow si lanciano SEMPRE da ` +
            `\`.claude/maestro-flows/esegui.sh\`: è l'unica strada che poi ripulisce i log. Una ` +
            `riga di documentazione che mostra l'altra è il modo più efficace di riempirli di ` +
            `nuovo — è così che ci sono finiti 70 file.`,
        ).toEqual([])
    })
})
