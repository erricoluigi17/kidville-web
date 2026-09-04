import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { render, screen, cleanup } from '@testing-library/react';
import { useForm, type FieldValues } from 'react-hook-form';
import type { FormField } from '@/types/database.types';

// =============================================================================
// I QUATTRO RILIEVI MINORI DEL COLLAUDO VISIVO DELL'11/08/2026, e il motivo per
// cui ognuno è stato chiuso in UN posto solo.
//
// Nessuno dei quattro era un fallimento WCAG pieno: erano il confine più debole
// rimasto, il segno del fuoco raddoppiato, l'assenza di un punto di riferimento
// per chi naviga per regioni e il bersaglio più piccolo della pagina. Proprio
// perché nessuno rompeva niente, nessuno di essi poteva rompersi: erano quattro
// stringhe in quattro file, e nessun test le guardava.
//
// ⚠️ SU COSA SI PUÒ ASSERIRE. jsdom non ha né foglio di stile né layout: i colori
// e le altezze in pixel qui non si misurano, si CALCOLANO — dai token letti in
// `globals.css` e dall'aritmetica delle utility Tailwind, che è deterministica.
// Le misure vere stanno nei commenti dei file toccati e sono state prese nel
// browser, con le transizioni spente e la scheda in PRIMO PIANO (in una scheda
// nascosta Chrome non avanza i fotogrammi e `getComputedStyle` restituisce il
// valore di PARTENZA di una transizione: è la trappola già scritta accanto a
// `SelectField`).
// =============================================================================

const RADICE = process.cwd();
const leggi = (rel: string) => fs.readFileSync(path.join(RADICE, rel), 'utf8');
const CSS = leggi('src/app/globals.css');

// ── WCAG 2.x — il rapporto di contrasto, dagli hex dei token ─────────────────
const canale = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const luminanza = (hex: string) => {
    const h = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    return 0.2126 * canale(r) + 0.7152 * canale(g) + 0.0722 * canale(b);
};
const contrasto = (a: string, b: string) => {
    const [x, y] = [luminanza(a), luminanza(b)];
    const [alto, basso] = x > y ? [x, y] : [y, x];
    return Math.round(((alto + 0.05) / (basso + 0.05)) * 100) / 100;
};

/**
 * Il valore di un token nel PRIMO blocco che lo dichiara, cioè la luce normale.
 * (`[data-contrast="high"]` lo ridichiara più sotto: qui non serve, l'Alto
 * Contrasto lo governa una regola esplicita e non il token — vedi §1c.)
 */
function token(nome: string): string {
    const m = CSS.match(new RegExp(`--color-kidville-${nome}:\\s*(#[0-9A-Fa-f]{6})`));
    if (!m) throw new Error(`token --color-kidville-${nome} non trovato in globals.css`);
    return m[1].toUpperCase();
}

/**
 * Specificità (a,b,c) di un selettore SEMPLICE — id / classi+attributi+
 * pseudo-classi / elementi. Non gestisce `:not()` né i selettori funzionali,
 * e non serve che lo faccia: i quattro selettori di questo file non ne hanno.
 */
function specificita(sel: string): [number, number, number] {
    const senzaAttr = sel.replace(/\[[^\]]*\]/g, '§');
    const a = (senzaAttr.match(/#[\w-]+/g) ?? []).length;
    const b =
        (senzaAttr.match(/\.[\w-]+/g) ?? []).length +
        (senzaAttr.match(/§/g) ?? []).length +
        (senzaAttr.match(/(?<!:):[\w-]+/g) ?? []).length;
    const c = (senzaAttr.match(/(^|[\s>+~])([a-z][\w-]*)/g) ?? []).length;
    return [a, b, c];
}
const piuForte = (x: [number, number, number], y: [number, number, number]) =>
    x[0] !== y[0] ? x[0] > y[0] : x[1] !== y[1] ? x[1] > y[1] : x[2] > y[2];

/** La posizione della prima occorrenza di un selettore nel foglio, o -1. */
const dove = (sel: string) => CSS.indexOf(sel);

// ── Un `FieldRenderer` di tipo `radio` da solo: la card di scelta al naturale ─
function CardDiScelta({ campo }: { campo: FormField }) {
    const {
        register,
        control,
        formState: { errors },
    } = useForm<FieldValues>();
    return (
        <FieldRenderer
            field={campo}
            modelId="m"
            register={register}
            control={control}
            error={errors[campo.id]}
        />
    );
}

const CAMPO_RADIO: FormField = {
    id: 'fascia',
    type: 'radio',
    label: 'Fascia',
    required: true,
    options: [{ value: 'a', label: 'Nido (0-3)' }],
};

import { FieldRenderer, SCELTA_STRUTTURA, SCELTA_LIBERA } from '@/components/features/forms/FieldRenderer';

afterEach(() => cleanup());

// =============================================================================
// §1 — IL CONTORNO DELLA CARD DI SCELTA SU CREMA
//
// `neutral` #8A958F è tarato sul BIANCO del riempimento (3,10:1, appena sopra i
// 3:1 di WCAG 1.4.11); sulla crema della pagina vale 2,79:1, e sotto la soglia
// ci finisce ogni card di scelta del modulo pubblico. Il riempimento non aiuta:
// bianco su crema è 1,11:1, quindi quel contorno è l'unico indizio del bordo.
// =============================================================================
describe('§1 · Il contorno della card di scelta su superficie crema', () => {
    it('1a · i numeri: dal 2026-09-04 `neutral` passa su ENTRAMBE le superfici, come `sub`', () => {
        const crema = token('cream');
        const bianco = token('white');
        expect([crema, bianco]).toEqual(['#FEF1E4', '#FFFFFF']);

        // Il difetto era, in una riga: lo STESSO colore passava sul bianco e non
        // sulla crema. CHIUSO il 2026-09-04 allineando `--color-kidville-neutral`
        // a `muted`: ora regge su ENTRAMBE le superfici, ed e' questo che si
        // asserisce. Il controllo positivo — che la sonda sappia vedere un colore
        // sotto soglia — resta due righe piu' giu' su `line`, che sta a 1,23:1.
        expect(contrasto(token('neutral'), bianco)).toBeGreaterThanOrEqual(3);
        expect(contrasto(token('neutral'), crema)).toBeGreaterThanOrEqual(3);
        expect(contrasto(token('line'), bianco)).toBeLessThan(3);
        expect(contrasto(token('neutral'), crema)).toBe(3.43);

        // Il rimedio: `sub` si vede da entrambi i lati del confine.
        expect(contrasto(token('sub'), crema)).toBe(5.82);
        expect(contrasto(token('sub'), bianco)).toBe(6.46);
        // E all'hover il contorno MIGLIORA invece di sparire.
        expect(contrasto(token('green'), crema)).toBeGreaterThanOrEqual(3);
    });

    it('1b · il gancio è ancora attaccato: la card porta `border-kidville-neutral` su una `<label>`', () => {
        render(<CardDiScelta campo={CAMPO_RADIO} />);
        const card = screen.getByRole('radio').closest('label') as HTMLElement;
        expect(card.tagName).toBe('LABEL');
        expect(card.className).toContain('border-kidville-neutral');
        // La regola vive sulla SUPERFICIE e aggancia `label` + quel token: se la
        // card cambiasse token o smettesse di essere una `<label>`, la regola
        // resterebbe scritta e non toccherebbe più niente — cioè il difetto
        // tornerebbe col gate verde. (La copia gemella nelle card di sede del
        // wizard insegnanti è tenuta identica a questa da
        // `__tests__/components/CandidaturaInsegnanteWizard-forma-visiva.test.tsx`.)
        expect(SCELTA_LIBERA).toContain('border-kidville-neutral');
    });

    it('1c · la cascata: riposo → `sub`, hover → verde pieno, Alto Contrasto → nero', () => {
        const RIPOSO = '.bg-kidville-cream label[class*="border-kidville-neutral"]';
        const HOVER = `${RIPOSO}:hover`;
        const HC_RIPOSO = `[data-contrast="high"] ${RIPOSO}`;
        const HC_HOVER = `[data-contrast="high"] ${HOVER}`;
        const HC_PUBBLICO = '[data-contrast="high"] .kv-public [class*="border-kidville-"]';

        for (const sel of [RIPOSO, HOVER, HC_RIPOSO, HC_HOVER, HC_PUBBLICO]) {
            expect(dove(sel), `selettore assente da globals.css: ${sel}`).toBeGreaterThan(-1);
        }

        // L'hover deve battere la utility `hover:border-*` del componente (0,2,0),
        // altrimenti il contorno smette di rispondere al mouse: è l'inciampo dei
        // 19 select del cockpit, già pagato e raccontato in `globals.css`.
        expect(piuForte(specificita(HOVER), [0, 2, 0])).toBe(true);
        expect(piuForte(specificita(HOVER), specificita(RIPOSO))).toBe(true);

        // A riposo l'Alto Contrasto PUBBLICO deve continuare a vincere sul token.
        expect(piuForte(specificita(HC_PUBBLICO), specificita(RIPOSO))).toBe(true);

        // …ma NON basta sull'hover: (0,3,0) contro (0,3,1). Senza la guardia
        // dedicata, in HC il verde è #FFFFFF su card bianca — passare col mouse
        // cancellerebbe il contorno. La guardia c'è, e sta DOPO.
        expect(piuForte(specificita(HOVER), specificita(HC_PUBBLICO))).toBe(true);
        expect(piuForte(specificita(HC_HOVER), specificita(HOVER))).toBe(true);
        // Il riposo della guardia pareggia con l'hover (0,3,1) e vince per ORDINE.
        expect(specificita(HC_RIPOSO)).toEqual(specificita(HOVER));
        expect(dove(HC_RIPOSO)).toBeGreaterThan(dove(HOVER));
    });
});

// =============================================================================
// §2 — UN ANELLO DI FUOCO SOLO
//
// Le card rese da `FieldRenderer` mostravano DUE anelli concentrici col Tab:
// l'`outline` di 2px sull'input (16×16) più un `box-shadow` di 4px dato alla
// `<label>` (632×51) da `focus-within:ring-2 ring-offset-2`. Le card della sede,
// un passo prima nello stesso modulo, ne mostravano UNO.
// =============================================================================
describe('§2 · Il fuoco disegna un anello solo', () => {
    it('2a · `SCELTA_STRUTTURA` non porta più nessun `focus-within:ring-*`', () => {
        expect(SCELTA_STRUTTURA).not.toMatch(/focus-within:ring/);
    });

    it('2b · la card resa non ha classi di anello, e il controllo resta a fuoco per conto suo', () => {
        render(<CardDiScelta campo={CAMPO_RADIO} />);
        const radio = screen.getByRole('radio');
        const card = radio.closest('label') as HTMLElement;
        expect(card.className).not.toMatch(/ring/);
        // L'anello lo dà `:focus-visible` di `globals.css`, fuori da ogni
        // `@layer`, sul controllo VERO — quello che il Tab raggiunge.
        expect(CSS).toMatch(/:focus-visible/);
        expect(radio).toBeInTheDocument();
    });

    it('2c · nessuno dei due wizard pubblici se lo riscrive addosso', () => {
        for (const file of [
            'src/components/features/public/CandidaturaInsegnanteWizard.tsx',
            'src/components/features/public/EnrollmentWizard.tsx',
        ]) {
            const src = leggi(file);
            // Solo il codice: i commenti raccontano il difetto e devono poterlo
            // NOMINARE senza far cadere il lock.
            const senzaCommenti = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
            expect(senzaCommenti, `${file}: anello di fuoco riscritto sulla card`).not.toMatch(
                /focus-within:ring/,
            );
        }
    });
});

// =============================================================================
// §3 — IL PUNTO DI RIFERIMENTO PER CHI NAVIGA PER REGIONI
//
// `document.querySelector('main')` tornava `null` su tutti e cinque i passi di
// `/lavora-con-noi`, e non c'era nessun `nav`/`header`/`aside`. Non è un
// fallimento WCAG A/AA — la struttura per intestazioni c'è ed è corretta — ma è
// il landmark che permette a uno screen reader di saltare al contenuto.
// =============================================================================
describe('§3 · Il landmark della pagina', () => {
    const PAGINA = 'src/app/lavora-con-noi/page.tsx';

    it('3a · la pagina avvolge il wizard in un `<main>`', () => {
        const src = leggi(PAGINA).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        expect(src).toMatch(/<main>/);
        expect(src).toMatch(/<main>[\s\S]*<CandidaturaInsegnanteWizard[\s\S]*<\/main>/);
    });

    it('3b · la colonna di contesto resta un `<div>`: dentro un `<main>` un `aside` è annidato', () => {
        // `landmark-complementary-is-top-level`: un `complementary` dentro `main`
        // è un rilievo axe. La colonna vive nella griglia a due colonne del
        // wizard — cioè dentro il `<main>` — e per essere un `aside` legittimo
        // dovrebbe starne fuori, che è esattamente ciò che non può fare.
        const wizard = leggi('src/components/features/public/CandidaturaInsegnanteWizard.tsx');
        const senzaCommenti = wizard.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
        expect(senzaCommenti).not.toMatch(/<aside/);
        // E il commento accanto al `<div>` non promette più il contrario: la
        // condizione al futuro («il giorno in cui questa pagina prendesse un
        // <main>») è diventata il presente e il testo lo dice.
        expect(wizard).not.toMatch(/il giorno in cui questa\s*\n?\s*pagina prendesse un/);
    });
});

// =============================================================================
// §4 — IL COMANDO DI ALTO CONTRASTO NON È PIÙ IL BERSAGLIO PIÙ PICCOLO
//
// Misurato a 360px: 148×38, mentre i comandi del wizard nella stessa schermata
// stanno tutti a 44. Passa la soglia AA (§2.5.8, 24×24) ma non la raccomandata
// (§2.5.5, 44×44) — e su un modulo che si compila dal telefono è proprio il
// comando che cerca chi ci vede poco.
// =============================================================================
describe('§4 · La taglia del comando di Alto Contrasto', () => {
    const FILE = 'src/components/ui/PublicContrastButton.tsx';

    it('4a · l’aritmetica arriva a 44px: `py-3` + interlinea `text-sm` + il bordo', () => {
        const src = leggi(FILE);
        const classi = src.match(/const CLASSI =\s*([\s\S]*?)\n\n/)?.[1] ?? '';
        expect(classi).toMatch(/\bpy-3\b/);
        expect(classi).toMatch(/\btext-sm\b/);
        expect(classi).toMatch(/\bborder\b/);

        const riempimento = 3 * 4 * 2; // py-3 = 0.75rem per lato = 12px × 2
        const interlinea = 20; // text-sm → line-height 1.25rem
        const bordo = 1 * 2;
        const altezza = riempimento + interlinea + bordo;
        expect(altezza).toBe(46);
        expect(altezza).toBeGreaterThanOrEqual(44);
        // `py-2.5` si sarebbe fermato a 42: sotto la raccomandazione.
        expect(2.5 * 4 * 2 + interlinea + bordo).toBeLessThan(44);
    });

    it('4b · resta un posto solo per tutte le superfici pubbliche', () => {
        // Se un domani una pagina si ricopiasse la stringa invece di montare il
        // componente, la taglia tornerebbe a divergere pagina per pagina — che è
        // il modo in cui il link di ritorno era rimasto indietro su tre pagine
        // su cinque prima di `PublicPageHeader`.
        const src = leggi(FILE);
        expect(src).toMatch(/export function PublicContrastButton/);
        expect(leggi('src/components/ui/PublicPageHeader.tsx')).toContain('<PublicContrastButton');
        expect(leggi('src/components/features/public/EnrollmentWizard.tsx')).toContain(
            '<PublicContrastButton',
        );
    });
});
