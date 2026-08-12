import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * LOCK — il guscio dei moduli pubblici si scrive in UN posto solo.
 *
 * ─── IL DIFETTO CHE QUESTO LOCK IMPEDISCE ──────────────────────────────────
 *
 * `/iscrizione` (`EnrollmentWizard`, 884 righe) e `/lavora-con-noi`
 * (`CandidaturaInsegnanteWizard`, 2274) sono nati l'uno RICOPIANDO l'altro, e
 * l'11/08/2026 stava per nascerne un terzo (`/anagrafica-personale`) copiando il
 * secondo. Ogni copia porta con sé la forma e NON porta le misure: è già
 * successo, e si vede a occhio confrontando i due file di allora —
 *
 *   · la barra di avanzamento: `h-1.5` con la testa gialla di qua (il primo
 *     `#FDC400` di una schermata che ne contava ZERO), `h-1` senza testa di là;
 *   · l'impaginatura: `lg:max-w-[59.5rem]` di qua, con dietro la curva dei
 *     margini misurata a sei larghezze (360→16, 640→20, 768→68, 1024→20,
 *     1280→148, 1440→228) e la constatazione che a 1024 il contenuto si
 *     AVVICINAVA al bordo di 48 px; `max-w-2xl` e basta di là;
 *   · i comandi: `flex-1` sul guscio di là — cioè i bottoni spinti in fondo alla
 *     finestra con 180-327 px di vuoto in mezzo — tolto di qua dopo la misura.
 *
 * Nessuna di queste differenze era un difetto di compilazione, nessuna rompeva
 * un test, e nessuna si vede leggendo un file solo. Un terzo modulo che copia il
 * secondo ripete l'operazione una terza volta, e da quel giorno le misure vanno
 * riportate in tre posti — cioè non ci verranno riportate.
 *
 * ─── COSA GUARDA, ESATTAMENTE ──────────────────────────────────────────────
 *
 * Le STRINGHE DI CLASSE che compongono il guscio: la griglia a due colonne (con
 * le collocazioni esplicite dei tre figli) e la barra di avanzamento. Non
 * l'esistenza di un import, che si aggira ricopiando il markup accanto
 * all'import; non un conteggio di righe, che cala rinominando. Le classi sono
 * ciò che DECIDE l'impaginazione, ed è ciò che una copia porta con sé.
 *
 * Il lock guarda `src/components/features/public/**` e basta: è il perimetro dei
 * moduli pubblici. Le pagine che li montano possono nominare le stesse classi in
 * un commento — `src/app/lavora-con-noi/page.tsx` lo fa — e non è una copia del
 * guscio: è una nota su di esso.
 *
 * ─── PERCHÉ C'È ANCHE IL CONTROLLO POSITIVO ────────────────────────────────
 *
 * Un lock verde perché non trova violazioni e un lock verde perché non guarda
 * più niente, da fuori, sono identici. Se il guscio venisse riscritto con altre
 * classi, la scansione qui sotto continuerebbe a passare su un repo che ha di
 * nuovo tre gusci: perciò ogni firma dev'essere PRESENTE nel file dei pezzi, e
 * l'ultimo `describe` mette alla prova il rilevatore con la copia ricostruita a
 * mano.
 */

const RADICE = process.cwd();
const CARTELLA_PUBBLICA = path.join('src', 'components', 'features', 'public');
/** L'unico file in cui il guscio può essere scritto. */
const PEZZI = path.join(CARTELLA_PUBBLICA, 'wizard', 'pezzi-wizard-pubblico.tsx');

/**
 * Le firme del guscio: stringhe di classe che, messe altrove, sono una COPIA.
 *
 * Sono scelte fra quelle che portano una misura addosso — la larghezza massima,
 * la collocazione dei tre figli, l'altezza e i colori della barra — e non fra
 * quelle generiche (`flex`, `mt-4`, `bg-kidville-cream`), che vivono legittimamente
 * in cento posti. Una firma qui dentro deve valere questa frase: «se la leggo in
 * un altro file, quel file sta ridisegnando il guscio».
 */
const FIRME: { classe: string; cosaE: string }[] = [
    { classe: 'lg:grid-cols-[minmax(0,1fr)_16rem]', cosaE: 'la griglia a due colonne del passo' },
    { classe: 'lg:col-start-1', cosaE: 'la collocazione di contenuto e comandi nella griglia' },
    { classe: 'lg:col-start-2', cosaE: 'la collocazione della colonna di contesto' },
    { classe: 'lg:row-start-1', cosaE: 'la prima riga della griglia (contenuto e contesto)' },
    { classe: 'lg:row-start-2', cosaE: 'la seconda riga della griglia (i comandi)' },
    { classe: 'lg:max-w-[59.5rem]', cosaE: 'la larghezza massima misurata a sei larghezze di finestra' },
    { classe: 'h-1.5 w-full bg-kidville-cream-dark', cosaE: 'la traccia della barra di avanzamento' },
    { classe: 'bg-kidville-green transition-all duration-300', cosaE: 'il riempimento della barra di avanzamento' },
    { classe: 'absolute right-0 top-0 h-full w-6 bg-kidville-yellow', cosaE: 'la testa gialla della barra' },
];

/** Ogni `.ts`/`.tsx` sotto `src/components/features/public`, in percorso relativo. */
function sorgentiPubbliche(dir = path.join(RADICE, CARTELLA_PUBBLICA)): string[] {
    const out: string[] = [];
    for (const voce of fs.readdirSync(dir, { withFileTypes: true })) {
        const assoluto = path.join(dir, voce.name);
        if (voce.isDirectory()) {
            out.push(...sorgentiPubbliche(assoluto));
            continue;
        }
        if (!/\.tsx?$/.test(voce.name)) continue;
        out.push(path.relative(RADICE, assoluto).split(path.sep).join('/'));
    }
    return out;
}

const RELATIVO_PEZZI = PEZZI.split(path.sep).join('/');

/** Le firme trovate in un sorgente, con la riga in cui compaiono. */
function firmeIn(sorgente: string): { classe: string; cosaE: string; riga: number }[] {
    const righe = sorgente.split('\n');
    const trovate: { classe: string; cosaE: string; riga: number }[] = [];
    for (const firma of FIRME) {
        const i = righe.findIndex((r) => r.includes(firma.classe));
        if (i >= 0) trovate.push({ ...firma, riga: i + 1 });
    }
    return trovate;
}

const AIUTO = [
    '',
    'Il guscio dei moduli pubblici sta in `src/components/features/public/wizard/pezzi-wizard-pubblico.tsx`',
    'e si USA, non si ricopia:',
    '',
    '    import { GuscioPubblico, BarraAvanzamento, ColonnaCentrale, ContatorePassi,',
    '             TestataPasso, GrigliaPasso, ComandiWizard, PannelloErroreInvio,',
    '             PannelloConferma, ColonnaContesto, EscaHoneypot }',
    "      from '@/components/features/public/wizard/pezzi-wizard-pubblico'",
    '',
    'Se il pezzo che ti serve non esiste ancora, AGGIUNGILO LÌ e usalo da qui: una',
    'seconda copia di queste classi è una seconda impaginazione da mantenere, ed è',
    'esattamente il modo in cui `/iscrizione` e `/lavora-con-noi` sono arrivate ad',
    'avere due barre di avanzamento diverse senza che nessun test diventasse rosso.',
].join('\n');

describe('lock — un solo guscio per i wizard pubblici', () => {
    it('ogni firma del guscio è DAVVERO in `pezzi-wizard-pubblico.tsx` (controllo positivo)', () => {
        const pezzi = fs.readFileSync(path.join(RADICE, PEZZI), 'utf8');
        const assenti = FIRME.filter((f) => !pezzi.includes(f.classe)).map((f) => `${f.classe} — ${f.cosaE}`);
        expect(
            assenti,
            [
                'Firme dichiarate qui e assenti dal file dei pezzi. O il guscio è stato riscritto',
                'con altre classi — e allora questo elenco va aggiornato, perché altrimenti il lock',
                'sorveglia stringhe che non esistono più e passa su qualunque cosa — oppure il',
                'pezzo è stato cancellato.',
            ].join('\n'),
        ).toEqual([]);
    });

    it('nessun altro file di `features/public` scrive le classi della griglia o della barra', () => {
        const violazioni: string[] = [];
        for (const rel of sorgentiPubbliche()) {
            if (rel === RELATIVO_PEZZI) continue;
            const sorgente = fs.readFileSync(path.join(RADICE, rel), 'utf8');
            for (const t of firmeIn(sorgente)) {
                violazioni.push(`${rel}:${t.riga} → ${t.classe} (${t.cosaE})`);
            }
        }
        expect(violazioni, AIUTO).toEqual([]);
    });

    it('i due wizard esistenti sono nel perimetro, cioè il lock li sta guardando davvero', () => {
        // Senza questa riga il test qui sopra sarebbe verde anche su una cartella
        // vuota o su un percorso sbagliato: «zero violazioni» e «zero file» sono
        // la stessa asserzione vista da fuori.
        const sorgenti = sorgentiPubbliche();
        expect(sorgenti).toContain('src/components/features/public/CandidaturaInsegnanteWizard.tsx');
        expect(sorgenti).toContain('src/components/features/public/EnrollmentWizard.tsx');
        expect(sorgenti).toContain(RELATIVO_PEZZI);
    });
});

/**
 * PROVA DI VALIDITÀ — il rilevatore vede il difetto, ricostruito a mano.
 *
 * È il terzo modulo che ricopia il guscio invece di importarlo: markup identico,
 * import assente. Se `firmeIn` non lo segnalasse, il lock qui sopra sarebbe verde
 * per la ragione sbagliata.
 */
describe('lock — prova di validità del rilevatore', () => {
    const COPIA_DEL_GUSCIO = `
        export function AnagraficaPersonaleWizard() {
          return (
            <div className="kv-public flex min-h-screen flex-col bg-kidville-cream text-kidville-ink">
              <div className="h-1.5 w-full bg-kidville-cream-dark">
                <div className="relative h-full bg-kidville-green transition-all duration-300" style={{ width: '20%' }}>
                  <span aria-hidden="true" className="absolute right-0 top-0 h-full w-6 bg-kidville-yellow" />
                </div>
              </div>
              <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-5 sm:py-8 lg:max-w-[59.5rem] lg:px-8">
                <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_16rem] lg:items-start lg:gap-x-10">
                  <div className="lg:col-start-1 lg:row-start-1">…</div>
                  <div className="lg:col-start-1 lg:row-start-2">…</div>
                  <div className="lg:col-start-2 lg:row-start-1">…</div>
                </div>
              </div>
            </div>
          )
        }
    `;

    it('una copia del guscio viene segnalata, e su TUTTE le firme', () => {
        const trovate = firmeIn(COPIA_DEL_GUSCIO).map((t) => t.classe);
        expect(trovate.sort()).toEqual(FIRME.map((f) => f.classe).sort());
    });

    it('un modulo pubblico che USA i pezzi non viene segnalato', () => {
        const USO_CORRETTO = `
            import { GuscioPubblico, BarraAvanzamento, GrigliaPasso }
              from '@/components/features/public/wizard/pezzi-wizard-pubblico'

            export function AnagraficaPersonaleWizard() {
              return (
                <GuscioPubblico>
                  <BarraAvanzamento indice={0} totale={5} />
                  <GrigliaPasso contenuto={null} comandi={null} contesto={null} />
                </GuscioPubblico>
              )
            }
        `;
        expect(firmeIn(USO_CORRETTO)).toEqual([]);
    });
});
