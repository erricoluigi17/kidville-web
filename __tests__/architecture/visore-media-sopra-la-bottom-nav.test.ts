import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LOCK — IL VISORE DEI MEDIA STA SOPRA LA BOTTOM-NAV, NON SOTTO.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ─── LA MISURA CHE HA FATTO NASCERE QUESTO LOCK ─────────────────────────────
 * 2026-09-12, simulatore iPhone 16e (390×844, iOS 26.2), app nativa contro
 * `app.kidville.it`, un video VERTICALE aperto nel visore della galleria
 * insegnante. Il pulsante «Elimina Media» è l'ULTIMO figlio della colonna:
 *   · lo scroller del visore arriva a FINE CORSA — due schermate consecutive
 *     dopo due gesti di scorrimento risultavano identiche al byte (md5
 *     `b62a289f7cdb6e3898d264323dc58fad`);
 *   · del pulsante restava una striscia rossa di ~4 px sotto la pastiglia della
 *     bottom-nav, cioè un bersaglio non premibile.
 * Causa: `MediaGrid` montava il visore a `fixed inset-0 z-50` e le tre
 * bottom-nav sono `fixed bottom-0 … z-50`, dichiarate DOPO `<main>{children}</main>`
 * nei rispettivi layout. A pari `z-index` vince l'ordine di documento: la barra
 * dipingeva sopra il visore, e il riempimento in fondo allo scroller
 * (`env(safe-area-inset-bottom)`, 34 px su iPhone) non basta a scavalcare una
 * barra che ne occupa ~130.
 *
 * ⚠️ Questa misura era ATTESA da un commento di `MediaGrid.tsx` scritto il giorno
 * prima, che diceva «non è corretto a occhio di proposito: una sovrapposizione
 * vera non è dimostrata ai formati comuni … se la misura dirà che c'è, la
 * correzione strutturale è una riga». La misura ha detto che c'è.
 *
 * ─── PERCHÉ UN LOCK E NON SOLTANTO LA CORREZIONE ────────────────────────────
 * Perché la correzione è **un numero**, e un numero si abbassa per distrazione:
 * `z-50` è il valore che Tailwind offre come ultima scala nominale, quindi è
 * anche quello che chiunque scriva d'istinto tornando su quel `div`. Senza una
 * riga che lo misuri, il difetto rientra al primo refactor e nessun test lo vede
 * — jsdom non fa layout, e in `__tests__/` non esiste un solo test che possa
 * accorgersi di due elementi sovrapposti.
 *
 * ─── COSA SI MISURA ─────────────────────────────────────────────────────────
 * Il `z-index` della radice del visore contro quello di OGNI chrome fisso che
 * galleggia sopra la pagina: le tre bottom-nav, e i livelli del cockpit
 * (`/admin/gallery` monta la stessa `MediaGrid` dentro la shell della Direzione).
 * Il confronto è STRETTAMENTE maggiore: «pari» è precisamente il caso che ha
 * prodotto il difetto, perché a pari livello decide l'ordine nel DOM.
 *
 * ⚠️ CIÒ CHE QUESTO LOCK NON PUÒ VEDERE, e va detto perché non se ne tragga una
 * garanzia che non dà: un antenato del visore che crei un CONTESTO
 * D'IMPILAMENTO (un `opacity < 1`, un `transform`, un `will-change`) clampa il
 * livello del visore rispetto ai suoi fratelli, e allora nessun numero scritto
 * qui basta. `MediaGrid` è montata dentro un `motion.div` che anima l'opacità:
 * a riposo framer-motion lascia `opacity: 1` e togle `will-change`, quindi il
 * contesto NON si crea — ma è una proprietà del comportamento di una libreria,
 * non di questo file. La prova che conta resta quella sul dispositivo, ed è
 * scritta sopra con la data.
 *
 * ⚠️ PROVATO A ROMPERSI: riportando la radice del visore a `z-50` questo test
 * diventa rosso su tutte e tre le bottom-nav. Un lock mai visto fallire non è
 * un lock.
 */

const RADICE = process.cwd();

const VISORE = 'src/components/features/gallery/MediaGrid.tsx';

/**
 * Il chrome fisso che galleggia sopra la pagina, con il perché di ognuno.
 *
 * Le tre bottom-nav si leggono dal sorgente: il loro livello non si copia qui,
 * altrimenti il giorno in cui una sale questo lock resta verde citando un numero
 * vecchio — cioè il difetto di `abbassare_soglia_lock_e_decorazione`.
 */
const BARRE: readonly { file: string; chi: string }[] = [
    { file: 'src/components/features/teacher/TeacherBottomNav.tsx', chi: 'bottom-nav insegnante' },
    { file: 'src/components/features/parent/BottomNav.tsx', chi: 'bottom-nav genitore' },
    { file: 'src/components/features/admin/AdminBottomNav.tsx', chi: 'bottom-nav cockpit' },
];

/**
 * I livelli del cockpit, questi sì come costanti: non sono un `className` unico
 * da cui leggerli, sono una convenzione sparsa su sette punti
 * (`ui/cockpit.tsx`). Il numero qui è il TETTO da superare, e se il cockpit
 * salisse il lock resterebbe verde a torto: per questo la loro fonte è citata,
 * così chi li alza sa dove venire a guardare.
 */
const LIVELLI_COCKPIT: readonly { chi: string; z: number }[] = [
    { chi: 'topbar e sidebar del cockpit (`ui/cockpit.tsx`)', z: 105 },
    { chi: 'foglio «Menu» del cockpit (`ui/cockpit.tsx`)', z: 110 },
    { chi: 'foglio dei filtri (`ui/FoglioFiltri.tsx`)', z: 112 },
];

function leggi(relativo: string): string {
    return fs.readFileSync(path.join(RADICE, relativo), 'utf8');
}

/** `z-50` → 50, `z-[115]` → 115. `null` quando la classe non dichiara un livello. */
function livelloZ(classi: string): number | null {
    const arbitrario = /(?:^|\s)z-\[(\d+)\]/.exec(classi);
    if (arbitrario) return Number(arbitrario[1]);
    const nominale = /(?:^|\s)z-(\d+)(?:\s|$)/.exec(classi);
    return nominale ? Number(nominale[1]) : null;
}

/** Tutte le stringhe `className="…"` di un sorgente. */
function classiDichiarate(src: string): string[] {
    return [...src.matchAll(/className="([^"]*)"/g)].map((m) => m[1]);
}

/**
 * La radice del visore: l'unico `className` di `MediaGrid` che sia insieme
 * `fixed`, `inset-0` e `focus:outline-none` — cioè il `div` con
 * `role="dialog"`, che è anche il solo a prendere il fuoco.
 *
 * Si pretende che ce ne sia ESATTAMENTE UNO: zero vuol dire che il lock ha
 * smesso di trovare ciò che misura (e allora deve parlare, non passare), due
 * vuol dire che non si sa più quale dei due si sta misurando.
 */
const radiciVisore = classiDichiarate(leggi(VISORE)).filter(
    (c) => /(?:^|\s)fixed(?:\s|$)/.test(c) && /(?:^|\s)inset-0(?:\s|$)/.test(c) && c.includes('focus:outline-none'),
);

describe('lock — il visore dei media sta sopra la bottom-nav', () => {
    it('il lock trova la radice del visore (se non la trova non sta misurando niente)', () => {
        expect(
            radiciVisore,
            `In ${VISORE} deve esistere UNA sola classe con \`fixed\`, \`inset-0\` e ` +
                `\`focus:outline-none\`: è la radice del visore. Trovate ${radiciVisore.length}. ` +
                `Se hai cambiato quelle classi aggiorna il riconoscitore qui sopra — non questo numero.`,
        ).toHaveLength(1);
        expect(livelloZ(radiciVisore[0]), `la radice del visore non dichiara nessun \`z-\``).not.toBeNull();
    });

    it('supera il livello di TUTTE le bottom-nav, e non lo pareggia', () => {
        const zVisore = livelloZ(radiciVisore[0]);
        const sotto: string[] = [];
        for (const barra of BARRE) {
            const classi = classiDichiarate(leggi(barra.file)).filter((c) =>
                /(?:^|\s)fixed(?:\s|$)/.test(c) && /(?:^|\s)bottom-0(?:\s|$)/.test(c),
            );
            expect(
                classi.length,
                `non trovo il contenitore fisso di ${barra.chi} in ${barra.file}: il lock è cieco su una barra`,
            ).toBeGreaterThan(0);
            for (const c of classi) {
                const z = livelloZ(c);
                if (z === null) continue;
                if (zVisore === null || zVisore <= z) {
                    sotto.push(`${barra.chi} (${barra.file}) è a z-${z}, il visore a z-${zVisore}`);
                }
            }
        }
        expect(
            sotto,
            'A PARI livello vince l’ordine nel DOM, e le bottom-nav sono dichiarate dopo `<main>`: ' +
                'la barra dipinge sopra il visore e l’ultimo comando della colonna — «Elimina Media» — ' +
                'resta sotto di lei, irraggiungibile anche a scroller finito (misurato su iPhone 16e ' +
                'il 2026-09-12). Il visore va portato sopra, non la barra sotto: `z-[115]` è il valore ' +
                'che `ui/cockpit.tsx` usa già per stare sopra tutto il chrome.',
        ).toEqual([]);
    });

    it('supera anche il chrome del cockpit, dove vive `/admin/gallery`', () => {
        const zVisore = livelloZ(radiciVisore[0]);
        const sotto = LIVELLI_COCKPIT.filter((l) => zVisore === null || zVisore <= l.z).map(
            (l) => `${l.chi} è a z-${l.z}, il visore a z-${zVisore}`,
        );
        expect(
            sotto,
            'la segreteria apre lo stesso visore dentro la shell della Direzione: se il chrome del ' +
                'cockpit gli sta sopra, il difetto misurato sull’app insegnante si ripresenta lì.',
        ).toEqual([]);
    });
});
