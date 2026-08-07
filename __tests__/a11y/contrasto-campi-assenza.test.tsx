import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

// =============================================================================
// «Comunica un'assenza» — i campi che il genitore compila, MISURATI sul rendering
// vero, in luce normale E con l'Alto Contrasto acceso.
//
// ─── IL BLOCCANTE (2026-08-07) ───────────────────────────────────────────────
// Su /parent/attendance, con l'Alto Contrasto attivo, il genitore NON VEDE più
// né la data che ha scelto né il motivo che sta scrivendo: entrambi i campi
// calcolano `rgb(255,255,255)` su `rgb(255,255,255)`, cioè **1:1**. Colpisce
// esattamente le persone per cui quella modalità esiste, e le colpisce nel punto
// peggiore — non possono rileggere il giorno prima di premere «Comunica
// assenza», cioè il dato che distingue «avviso la maestra per domani» da «l'ho
// avvisata per ieri».
//
// LA CATENA, per intero:
//   · i due campi non dichiarano NESSUN inchiostro → ereditano
//     `body { color: var(--color-kidville-green) }` (globals.css);
//   · in Alto Contrasto `[data-contrast="high"] body { color: #FFFFFF }` ribalta
//     l'inchiostro EREDITATO…
//   · …ma la card sotto è `bg-kidville-white`, una utility nata da `@theme
//     inline` che porta l'hex #FFFFFF INLINATO: non si ribalta.
//   · Il remap di `--color-kidville-white` a #000000 nel blocco HC raggiunge
//     solo chi legge il token con `var()` — i CSS module. È la trappola già
//     misurata dal repo in `inchiostro-muted-superfici.test.ts` («l'Alto
//     Contrasto NON protegge le utility»).
//   · Nessuna regola `[data-contrast="high"]` scritta a mano copre questa
//     superficie: sono tutte agganciate a classi `kv-*`, e la card del genitore
//     non ne ha nessuna.
// La sorella primaria (`ComunicaAssenzaCard`) è immune PER CASO, non per
// disegno: scrive `text-kidville-ink` sui suoi input.
//
// ─── IL SECONDO DIFETTO: I SEGNAPOSTI ────────────────────────────────────────
// Fuori da `.kv-public` nessuna regola governa `::placeholder`: il browser lo
// deriva da `currentColor` al 50% di alfa. Misurato in Chrome dal collaudo:
// `rgb(143,158,155)` = 2,79:1 sui due campi della card primaria e
// `rgb(128,180,175)` = 2,32:1 sulla textarea 0-6, contro i 4,5:1 di WCAG 1.4.3.
// Il caso che pesa è il campo data della primaria: è MASCHERATO, accetta solo
// `gg/mm/aaaa`, e quel formato è scritto SOLO nel segnaposto — l'unica istruzione
// su come compilare il campo è anche la meno leggibile della schermata.
//
// ─── PERCHÉ UN FILE NUOVO E PERCHÉ LA SONDA È RICOPIATA ──────────────────────
// La sonda della cascata vive in `__tests__/a11y/contrasto-cascata.test.tsx` ed
// esporta due funzioni — ma importare da un file di test ne ESEGUE i `describe`
// dentro questo, contando 40 test due volte. È la stessa ragione, e la stessa
// scelta, di `inchiostro-muted-superfici.test.ts` e `testo-muted-allowlist.test.ts`:
// aritmetica pura e un parser senza stato costano meno dell'accoppiamento.
// La differenza rispetto a quel file: qui la sonda NON misura un frammento di
// HTML scritto a mano — misura i nodi che la pagina VERA produce, così una
// classe tolta domani dal componente cade qui e non in un frammento gemello.
// =============================================================================

const RADICE = process.cwd();
const CSS = fs.readFileSync(path.join(RADICE, 'src', 'app', 'globals.css'), 'utf8');

// ── WCAG 2.x §1.4.3 — il rapporto di contrasto ───────────────────────────────
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
/** Un colore con alfa, COMPOSTO sul suo fondo: è ciò che l'occhio vede davvero. */
const composita = (fg: string, bg: string, alfa: number) => {
    const canali = (h: string) => [0, 2, 4].map((i) => parseInt(h.replace('#', '').slice(i, i + 2), 16));
    const [a, b] = [canali(fg), canali(bg)];
    return `#${[0, 1, 2]
        .map((i) => Math.round(a[i] * alfa + b[i] * (1 - alfa)).toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase()}`;
};

// ── Parser CSS: regole ordinate, con il contesto delle at-rule ───────────────
type Dich = { prop: string; val: string };
type Regola = { sel: string; dich: Dich[]; contesto: string[]; ordine: number; layer: boolean };

function dichiarazioni(corpo: string): Dich[] {
    return corpo
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.includes(':'))
        .map((s) => ({
            prop: s.slice(0, s.indexOf(':')).trim().toLowerCase(),
            val: s.slice(s.indexOf(':') + 1).trim(),
        }))
        .filter((d) => d.prop.length > 0);
}

function parseRegole(css: string): Regola[] {
    const testo = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const out: Regola[] = [];
    let ordine = 0;
    const scendi = (src: string, contesto: string[]) => {
        let buf = '';
        let i = 0;
        while (i < src.length) {
            const c = src[i];
            if (c === '{') {
                let liv = 1;
                let k = i + 1;
                while (k < src.length && liv > 0) {
                    if (src[k] === '{') liv++;
                    else if (src[k] === '}') liv--;
                    k++;
                }
                const sel = buf.trim().replace(/\s+/g, ' ');
                const corpo = src.slice(i + 1, k - 1);
                if (corpo.includes('{')) scendi(corpo, [...contesto, sel]);
                else {
                    const dich = dichiarazioni(corpo);
                    const pos = ordine++;
                    for (const uno of sel.split(',').map((s) => s.trim()).filter(Boolean)) {
                        out.push({ sel: uno, dich, contesto, ordine: pos, layer: false });
                    }
                }
                buf = '';
                i = k;
                continue;
            }
            if (c === '}' || c === ';') { buf = ''; i++; continue; }
            buf += c;
            i++;
        }
    };
    scendi(testo, []);
    return out;
}

/** Specificità CSS (a,b,c) — id / classi+attributi+pseudo-classi / elementi. */
function specificita(sel: string): [number, number, number] {
    const s = sel.replace(/\\./g, 'µ');
    const id = (s.match(/#[-\wµ]+/g) ?? []).length;
    const cls = (s.match(/\.[-\wµ]+/g) ?? []).length;
    const attr = (s.match(/\[[^\]]*\]/g) ?? []).length;
    const pcl = (s.match(/(?<![:\w])::?[-\w]+/g) ?? []).filter((p) => !p.startsWith('::')).length;
    const pel = (s.match(/::[-\w]+/g) ?? []).length;
    const elementi = (
        s
            .replace(/\[[^\]]*\]/g, ' ')
            .replace(/[.#]{1}[-\wµ]+/g, ' ')
            .replace(/::?[-\w]+(\([^)]*\))?/g, ' ')
            .match(/[a-zA-Z][-\w]*/g) ?? []
    ).length;
    return [id, cls + attr + pcl, elementi + pel];
}

/** I token `--color-kidville-*` dichiarati in un blocco di `globals.css`. */
function token(selettore: string, regole: Regola[]): Record<string, string> {
    const blocco = regole.filter((r) => r.sel === selettore);
    expect(blocco.length, `blocco «${selettore}» presente in globals.css`).toBeGreaterThan(0);
    const out: Record<string, string> = {};
    for (const d of blocco.flatMap((r) => r.dich)) {
        const m = d.prop.match(/^--color-kidville-([a-z0-9-]+)$/);
        const h = d.val.match(/^#[0-9A-Fa-f]{6}$/);
        if (m && h) out[m[1]] = h[0].toUpperCase();
    }
    return out;
}

const REGOLE_CSS = parseRegole(CSS);
const T = token('@theme inline', REGOLE_CSS);
const T_HC = token('[data-contrast="high"]', REGOLE_CSS);

/**
 * Le utility Tailwind dei token, come le emette davvero il compilatore: con
 * `@theme inline` l'hex è INLINATO nella classe, NON è un `var()`. È il motivo
 * per cui il remap dei token in Alto Contrasto non le tocca — ed è la metà
 * mancante che, sommata all'inchiostro ereditato che invece SI ribalta, produce
 * il bianco su bianco. Vivono in `@layer utilities` → perdono contro qualunque
 * regola non-layered di `globals.css`.
 */
function utilityTailwind(): Regola[] {
    const out: Regola[] = [];
    let o = 0;
    for (const [nome, hex] of Object.entries(T)) {
        out.push({ sel: `.text-kidville-${nome}`, dich: [{ prop: 'color', val: hex }], contesto: [], ordine: o++, layer: true });
        out.push({ sel: `.bg-kidville-${nome}`, dich: [{ prop: 'background-color', val: hex }], contesto: [], ordine: o++, layer: true });
    }
    out.push({ sel: '.text-white', dich: [{ prop: 'color', val: '#FFFFFF' }], contesto: [], ordine: o++, layer: true });
    out.push({ sel: '.bg-white', dich: [{ prop: 'background-color', val: '#FFFFFF' }], contesto: [], ordine: o++, layer: true });
    return out;
}

const REGOLE = [...utilityTailwind(), ...REGOLE_CSS];

type Prop = 'color' | 'background-color';

function valoreProp(r: Regola, prop: Prop): string | null {
    let v: string | null = null;
    for (const d of r.dich) {
        if (d.prop === prop) v = d.val;
        else if (prop === 'background-color' && d.prop === 'background') {
            if (!/gradient|url\(/i.test(d.val)) {
                const m = d.val.match(/#[0-9A-Fa-f]{3,6}\b|var\(\s*--[-\w]+\s*\)/i);
                if (m) v = m[0];
            }
        }
    }
    return v;
}

/** Confronto lessicografico dei pesi di cascata: `a` batte `b`? */
function batte(a: number[], b: number[]): boolean {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
}

/** La dichiarazione che VINCE su `el` per `prop`: livello → specificità → ordine. */
function vince(el: Element, prop: Prop, regole: Regola[]): string | null {
    let miglioreVal: string | null = null;
    let migliore: number[] | null = null;
    for (const r of regole) {
        if (r.contesto.length > 0) continue;
        const v = valoreProp(r, prop);
        if (v === null) continue;
        let ok = false;
        try {
            ok = el.matches(r.sel);
        } catch {
            ok = false;
        }
        if (!ok) continue;
        const [a, b, c] = specificita(r.sel);
        const peso = [r.layer ? 0 : 1, a, b, c, r.ordine];
        if (migliore === null || batte(peso, migliore)) {
            migliore = peso;
            miglioreVal = v;
        }
    }
    return miglioreVal;
}

function risolviVar(v: string, hc: boolean): string | null {
    const m = v.match(/var\(\s*(--color-kidville-[a-z0-9-]+)\s*\)/);
    if (m) {
        const nome = m[1].replace('--color-kidville-', '');
        return (hc ? T_HC[nome] : undefined) ?? T[nome] ?? null;
    }
    const h = v.match(/#[0-9A-Fa-f]{6}\b/);
    return h ? h[0].toUpperCase() : null;
}

function coloreTesto(el: Element, hc: boolean, regole = REGOLE): string {
    for (let n: Element | null = el; n; n = n.parentElement) {
        const v = vince(n, 'color', regole);
        if (v) {
            const c = risolviVar(v, hc);
            if (c) return c;
        }
    }
    return hc ? '#FFFFFF' : T.green;
}

function sfondo(el: Element, hc: boolean, regole = REGOLE): string {
    for (let n: Element | null = el; n; n = n.parentElement) {
        const v = vince(n, 'background-color', regole);
        if (v) {
            const c = risolviVar(v, hc);
            if (c) return c;
        }
    }
    return hc ? '#000000' : T.cream;
}

function misuraEl(el: Element, hc: boolean) {
    const fg = coloreTesto(el, hc);
    const bg = sfondo(el, hc);
    return { fg, bg, rapporto: contrasto(fg, bg) };
}

/**
 * Il colore del SEGNAPOSTO, modellato come fa il browser.
 *
 * Se il campo dichiara un token (`placeholder-kidville-<nome>`) vale quello, e
 * come tutte le utility di `@theme inline` è INLINATO: non si ribalta in Alto
 * Contrasto. Altrimenti vale il ripiego dell'agente utente — `currentColor` al
 * 50% di alfa — composto sul fondo effettivo del campo.
 *
 * Il modello NON è dedotto: i suoi due esiti coincidono, canale per canale, con
 * ciò che il collaudo ha misurato in Chrome con `getComputedStyle(campo,
 * '::placeholder')` (vedi il controllo positivo qui sotto). Restano fuori le
 * scritture con alfa (`placeholder-kidville-green/40`): non ne usa nessuno dei
 * tre campi, e la loro superficie pubblica ha già la sua regola in globals.css.
 */
function coloreSegnaposto(el: Element, hc: boolean): { colore: string; dichiarato: boolean } {
    const cls = el.getAttribute('class') ?? '';
    const m = cls.match(/(?:^|\s)placeholder-kidville-([a-z0-9-]+)(?=\s|$)/);
    if (m && T[m[1]]) return { colore: T[m[1]], dichiarato: true };
    return { colore: composita(coloreTesto(el, hc), sfondo(el, hc), 0.5), dichiarato: false };
}

// ── Il contorno di prova: la pagina vera, non un frammento gemello ───────────
const identita = vi.hoisted(() => ({ parentId: 'p-1' as string | null, studentId: 's-1' as string | null, ready: true }));

vi.mock('@/lib/auth/use-parent-identity', () => ({
    useParentIdentity: () => ({
        parentId: identita.parentId,
        studentId: identita.studentId,
        figliIds: identita.studentId ? [identita.studentId] : [],
        ready: identita.ready,
    }),
}));

vi.mock('next/navigation', () => ({
    usePathname: () => '/parent/attendance',
    useSearchParams: () => new URLSearchParams(),
    useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

import ParentAttendancePage from '@/app/(dashboard)/parent/attendance/page';
import { ComunicaAssenzaCard } from '@/components/features/parent/ComunicaAssenzaCard';
// Le etichette si CHIEDONO AL CATALOGO, non si ricopiano: scritte a mano qui
// dentro, il file è diventato rosso il 2026-08-08 su una riscrittura di
// glossario che non toccava una riga di questi componenti — e il rosso parlava
// di contrasto mentre il problema era un apostrofo tipografico.
import itServizi from '../../messages/it/parentServizi.json';
import itPrimaria from '../../messages/it/parentPrimaria.json';

/**
 * L'istruzione del campo: esiste, è LEGATA al campo (`aria-describedby`), punta
 * a un nodo che c'è davvero, ha del testo, ed è visibile — non un testo per soli
 * screen reader (chi vede male ne ha bisogno quanto chi ascolta). WCAG 3.3.2.
 */
function controllaIstruzione(campo: HTMLElement, dove: string) {
    const descritto = campo.getAttribute('aria-describedby');
    expect(descritto, `${dove}: il campo data non ha nessuna descrizione associata`).toBeTruthy();
    for (const id of descritto!.split(/\s+/).filter(Boolean)) {
        const aiuto = document.getElementById(id);
        expect(aiuto, `${dove}: nessun elemento con id="${id}"`).toBeTruthy();
        expect((aiuto!.textContent ?? '').trim().length, `${dove}: l'aiuto è vuoto`).toBeGreaterThan(0);
        expect(aiuto!.className).not.toMatch(/sr-only|hidden/);
    }
}

const fetchMock = vi.fn();

const PRESENZE_VUOTE = {
    ok: true,
    status: 200,
    json: async () => ({
        success: true,
        data: {
            schoolType: 'infanzia',
            oggi: { stato: null, orario_entrata: null, orario_uscita: null },
            riepilogo: { from: '2026-07-12', to: '2026-08-11', presenze: 0, assenze: 0, ritardi: 0, uscite: 0 },
            comunicate: [],
            comunicateLette: true,
        },
    }),
};

beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue(PRESENZE_VUOTE);
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    document.documentElement.removeAttribute('data-contrast');
    cleanup();
});

/** Monta /parent/attendance e restituisce i due campi, con l'Alto Contrasto come chiesto. */
async function campiZeroSei(hc: boolean) {
    document.documentElement.setAttribute('data-contrast', hc ? 'high' : 'normal');
    render(<ParentAttendancePage />);
    const giorno = await screen.findByLabelText(itServizi.attendanceGiorno);
    const motivo = screen.getByLabelText(itServizi.attendanceMotivo);
    return { giorno, motivo };
}

/** Monta la card della primaria col modulo APERTO e restituisce i due campi. */
async function campiPrimaria(hc: boolean) {
    document.documentElement.setAttribute('data-contrast', hc ? 'high' : 'normal');
    render(<ComunicaAssenzaCard studentId="s-1" parentId="p-1" />);
    // La card si rilegge da sé l'elenco al montaggio: la promessa va lasciata
    // risolvere PRIMA di toccare il DOM, altrimenti l'aggiornamento di stato
    // arriva fuori da `act()` e sporca l'output del gate con un warning.
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: itPrimaria.comunicaApri }));
    return {
        data: screen.getByLabelText(/Giorno dell['’]assenza/i),
        motivo: screen.getByLabelText(/^Motivo/i),
    };
}

// =============================================================================
describe('a11y §0 · la sonda — prima di misurare, si dimostra che misura', () => {
    it('la specificità è quella del CSS, non una stima', () => {
        expect(specificita('body')).toEqual([0, 0, 1]);
        expect(specificita('[data-contrast="high"] body')).toEqual([0, 1, 1]);
        expect(specificita('.kv-public ::placeholder')).toEqual([0, 1, 1]);
    });

    it('taratura della formula del contrasto', () => {
        expect(contrasto('#000000', '#FFFFFF')).toBe(21);
        expect(contrasto('#FFFFFF', '#FFFFFF')).toBe(1);
    });

    it('una regola NON-layered batte l’utility inlinata: è così che nasce il bianco su bianco', () => {
        // `[data-contrast="high"] body { color:#FFF }` ribalta l'inchiostro EREDITATO…
        expect(T_HC.green).toBe('#FFFFFF');
        // …mentre `bg-kidville-white` porta l'hex dentro di sé e resta BIANCA.
        expect(T.white).toBe('#FFFFFF');
        document.documentElement.setAttribute('data-contrast', 'high');
        document.body.innerHTML = '<form class="bg-kidville-white"><input id="sonda" /></form>';
        const el = document.getElementById('sonda')!;
        const m = misuraEl(el, true);
        expect(m.fg).toBe('#FFFFFF');
        expect(m.bg).toBe('#FFFFFF');
        expect(m.rapporto).toBe(1);
        document.body.innerHTML = '';
    });

    it('CONTROLLO POSITIVO: il modello del segnaposto coincide con la misura di Chrome', () => {
        // Collaudo del 2026-08-07, `getComputedStyle(campo, '::placeholder')`:
        //  · campi della card primaria (inchiostro `ink`) → rgb(143,158,155) = 2,79:1
        //  · textarea 0-6 (inchiostro EREDITATO dal body, verde) → rgb(128,180,175) = 2,32:1
        // Il modello «currentColor al 50% composto sul fondo» li riproduce entrambi a
        // meno di un livello di quantizzazione (Chrome miscela in oklab).
        expect(composita(T.ink, T.white, 0.5)).toBe('#8F9E9C'); // Chrome: rgb(143,158,155)
        expect(composita(T.green, T.white, 0.5)).toBe('#80B5AF'); // Chrome: rgb(128,180,175)
        expect(contrasto(composita(T.ink, T.white, 0.5), T.white)).toBe(2.79);
        expect(contrasto(composita(T.green, T.white, 0.5), T.white)).toBeLessThan(2.5);
    });
});

// =============================================================================
// §1 — IL BLOCCANTE: i due campi di /parent/attendance in Alto Contrasto.
// =============================================================================
describe('a11y §1 · /parent/attendance — con l’Alto Contrasto acceso i campi si LEGGONO', () => {
    it('la data scelta si legge in Alto Contrasto (oggi: bianco su bianco, 1:1)', async () => {
        const { giorno } = await campiZeroSei(true);
        const m = misuraEl(giorno, true);
        expect(
            m.rapporto,
            `inchiostro ${m.fg} su fondo ${m.bg}: il genitore non può rileggere il giorno che ha scelto`,
        ).toBeGreaterThanOrEqual(4.5);
    });

    it('il motivo che si sta scrivendo si legge in Alto Contrasto', async () => {
        const { motivo } = await campiZeroSei(true);
        const m = misuraEl(motivo, true);
        expect(m.rapporto, `inchiostro ${m.fg} su fondo ${m.bg}`).toBeGreaterThanOrEqual(4.5);
    });

    it('e in luce normale non peggiorano (regressione al contrario)', async () => {
        const { giorno, motivo } = await campiZeroSei(false);
        expect(misuraEl(giorno, false).rapporto).toBeGreaterThanOrEqual(4.5);
        expect(misuraEl(motivo, false).rapporto).toBeGreaterThanOrEqual(4.5);
    });

    it('l’inchiostro è DICHIARATO sul campo, non ereditato dal body', async () => {
        // È la causa radice, non il sintomo: finché il colore arriva per eredità,
        // basta una regola HC sul `body` (che c'è, e serve) per farlo sparire su
        // una superficie che non si ribalta. Il campo deve portarsi il suo.
        const { giorno, motivo } = await campiZeroSei(true);
        for (const el of [giorno, motivo]) {
            expect(
                vince(el, 'color', REGOLE),
                `${el.id}: nessuna regola dichiara l'inchiostro DIRETTAMENTE sul campo`,
            ).toBeTruthy();
        }
    });
});

// =============================================================================
// §2 — I SEGNAPOSTI, sui tre campi della funzione, in entrambe le modalità.
// =============================================================================
describe('a11y §2 · i segnaposti sono TESTO, e come tale si leggono', () => {
    it('/parent/attendance — il segnaposto del motivo regge AA (oggi 2,32:1)', async () => {
        for (const hc of [false, true]) {
            const { motivo } = await campiZeroSei(hc);
            const s = coloreSegnaposto(motivo, hc);
            expect(s.dichiarato, `segnaposto non dichiarato: cade sul 50% di currentColor`).toBe(true);
            expect(contrasto(s.colore, sfondo(motivo, hc)), `${s.colore} su ${sfondo(motivo, hc)} (hc=${hc})`)
                .toBeGreaterThanOrEqual(4.5);
            cleanup();
        }
    });

    it('primaria — il segnaposto del campo DATA regge AA: è l’unica istruzione che il campo dà', async () => {
        for (const hc of [false, true]) {
            const { data } = await campiPrimaria(hc);
            const s = coloreSegnaposto(data, hc);
            expect(s.dichiarato, 'segnaposto non dichiarato: cade sul 50% di currentColor').toBe(true);
            expect(contrasto(s.colore, sfondo(data, hc)), `${s.colore} su ${sfondo(data, hc)} (hc=${hc})`)
                .toBeGreaterThanOrEqual(4.5);
            cleanup();
        }
    });

    it('primaria — anche il segnaposto del motivo regge AA', async () => {
        for (const hc of [false, true]) {
            const { motivo } = await campiPrimaria(hc);
            const s = coloreSegnaposto(motivo, hc);
            expect(s.dichiarato).toBe(true);
            expect(contrasto(s.colore, sfondo(motivo, hc))).toBeGreaterThanOrEqual(4.5);
            cleanup();
        }
    });

    it('il colore dichiarato NON viene poi sbiadito dal browser (il quirk di Firefox)', () => {
        // `placeholder-kidville-sub` emette solo `color:#55615c`. Firefox applica di
        // suo `::placeholder { opacity: .54 }` — quirk storico, documentato da MDN:
        // composto sul bianco riporterebbe quel colore intorno a 2,3:1, cioè
        // riaprirebbe il difetto appena chiuso. `.kv-public ::placeholder` porta
        // `opacity: 1` proprio per questo, ma è scopata alle superfici PUBBLICHE, e
        // queste tre schermate sono di dashboard. Serve la regola nuda.
        const nude = REGOLE_CSS.filter(
            (r) => r.sel === '::placeholder' && r.dich.some((d) => d.prop === 'opacity' && d.val.startsWith('1')),
        );
        expect(
            nude.length,
            'manca in globals.css una `::placeholder { opacity: 1 }` NON scopata: fuori da ' +
            '`.kv-public` il colore dichiarato sui campi torna sbiadito su Firefox',
        ).toBeGreaterThan(0);
        // …e toglie SOLO l'opacità: nessun colore, altrimenti scavalcherebbe in
        // blocco ogni `placeholder-*` dei componenti (le utility sono layered).
        expect(nude.flatMap((r) => r.dich).map((d) => d.prop)).toEqual(['opacity']);
    });

    it('il campo data ha un’ISTRUZIONE persistente e visibile, non solo un segnaposto', async () => {
        // ─── COS'È CAMBIATO, IL 2026-08-08, E PERCHÉ ────────────────────────
        // Questo test pretendeva la stringa `gg/mm/aaaa` dentro l'aiuto, perché
        // il campo era un `type="text"` MASCHERATO e il formato era
        // un'informazione obbligatoria: un segnaposto sparisce al primo
        // carattere digitato, e chi sbaglia non ha più modo di sapere qual era.
        //
        // Il campo ora è l'`<input type="date">` nativo — lo stesso della
        // schermata gemella, che il collaudo aveva segnalato come divergente
        // (due campi diversi per la stessa funzione). Su un campo nativo il
        // formato lo DISEGNA IL SISTEMA: scriverlo nell'aiuto sarebbe falso
        // appena il browser è in inglese, cioè si trasformerebbe da istruzione
        // in bugia. L'aiuto dichiara adesso l'intervallo ammesso — ciò che `min`
        // impone davvero.
        //
        // Quello che il test difende NON è cambiato, ed è il requisito vero
        // (WCAG 3.3.2): un'istruzione che esiste, è legata al campo, e si vede.
        // In più ora vale per ENTRAMBE le schermate: prima ne copriva una sola,
        // e l'altra di istruzione non ne aveva nessuna.
        const { data } = await campiPrimaria(false);
        controllaIstruzione(data, 'card primaria');
        cleanup();

        document.documentElement.setAttribute('data-contrast', 'normal');
        render(<ParentAttendancePage />);
        controllaIstruzione(await screen.findByLabelText(itServizi.attendanceGiorno), '/parent/attendance');
    });
});

// =============================================================================
// §3 — LE DUE FRASI. Quella che spiega, e quella che conferma.
//
// `text-kidville-muted` (#9AA6A2) su `bg-kidville-white` vale 2,51:1, contro i
// 4,5:1 di WCAG 1.4.3 AA — e nessuna delle due è «testo grande» (14px/400 e
// 16px/400). La seconda è l'UNICA riga che dice per quale giorno l'assenza è
// stata comunicata: chi non la legge non può accorgersi di aver avvisato la
// maestra per il giorno sbagliato.
//
// Il debito era ALLOWLISTATO (`docs/superpowers/testo-muted-allowlist.json`, 3
// occorrenze per questo file), quindi il lock restava verde mentre il difetto
// c'era. L'allowlist è nata per far SCENDERE il debito, non per congelarlo: qui
// si misura il rendering vero, dove un'allowlist non arriva.
// =============================================================================
describe('a11y §3 · le frasi di /parent/attendance si leggono (WCAG 1.4.3)', () => {
    it('la riga che spiega («Indica il giorno…») regge AA sulla card bianca', async () => {
        document.documentElement.setAttribute('data-contrast', 'normal');
        render(<ParentAttendancePage />);
        const frase = await screen.findByText(/Indica il giorno dell/i);
        const m = misuraEl(frase, false);
        expect(m.rapporto, `${m.fg} su ${m.bg}`).toBeGreaterThanOrEqual(4.5);
    });

    it('la riga che CONFERMA — l’unica che dice per quale giorno — regge AA', async () => {
        document.documentElement.setAttribute('data-contrast', 'normal');
        render(<ParentAttendancePage />);
        await screen.findByLabelText(itServizi.attendanceGiorno);

        fireEvent.click(screen.getByRole('button', { name: itServizi.attendanceComunicaAssenza }));
        // La frase si chiede al CATALOGO (fino al segnaposto `{data}`): ricopiata
        // a mano, questo test è diventato rosso su una riscrittura di glossario
        // che non toccava una riga del componente misurato.
        const inizioConferma = itServizi.attendanceInviataTesto.split('{')[0].trim();
        const frase = await screen.findByText((_t, nodo) => (nodo?.textContent ?? '').includes(inizioConferma), {
            selector: 'p',
        });

        const m = misuraEl(frase, false);
        expect(
            m.rapporto,
            `${m.fg} su ${m.bg}: è la sola riga che dice PER QUALE GIORNO l'assenza è partita`,
        ).toBeGreaterThanOrEqual(4.5);
    });
});
