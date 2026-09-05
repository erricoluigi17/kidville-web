import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

// Solo `logClient` è finto: `nomeErrore` resta quello vero, perché è LUI la cosa
// misurata — un mock che restituisse il nome giusto proverebbe solo sé stesso.
vi.mock('@/lib/logging/client', async (importActual) => {
    const actual = await importActual<typeof import('@/lib/logging/client')>();
    return { ...actual, logClient: vi.fn() };
});

import { logClient } from '@/lib/logging/client';
import { ComePagare, type SedeBonifico } from '@/components/features/parent/pagamenti/ComePagare';
import type { VoceCausale } from '@/components/features/parent/pagamenti/CausaleBonifico';

/**
 * «Come pagare» — la card del genitore in /parent/pagamenti (E4).
 *
 * Il difetto che chiude, misurato nello spec del 2026-09-05: la pagina mostrava la
 * causale del bonifico e NON diceva né dove mandare i soldi (IBAN) né a chi è
 * intestato il conto, né che si può pagare anche in contanti. L'IBAN esisteva già
 * in Impostazioni → Fiscale e usciva solo nelle email di sollecito.
 *
 * ⚠️ DATI SINTETICI, repo pubblico. L'IBAN è l'esempio PUBBLICO della Banca
 * d'Italia (IT60X0542811101000000123456) nella forma leggibile a gruppi di quattro
 * che il server già produce; il secondo è lo stesso con due cifre cambiate (non è
 * un conto di nessuno). Nomi, cognomi e intestatario sono inventati.
 */

const IBAN_LEGGIBILE = 'IT60 X054 2811 1010 0000 0123 456';
const IBAN_COMPATTO = 'IT60X0542811101000000123456';
/** Coordinate DIVERSE: due cifre cambiate sull'esempio pubblico. Nessun conto reale. */
const IBAN_ALTRO = 'IT60 X054 2811 1010 0000 0987 654';

const INTESTATARIO = 'Cooperativa Esempio soc. coop.';

const SEDE_UNO: SedeBonifico = {
    id: 'sede-1',
    nome: 'Plesso Uno',
    iban: IBAN_LEGGIBILE,
    intestatario: INTESTATARIO,
};
const SEDE_DUE: SedeBonifico = {
    id: 'sede-2',
    nome: 'Plesso Due',
    iban: IBAN_LEGGIBILE,
    intestatario: INTESTATARIO,
};

const VOCE_UNO: VoceCausale = {
    id: 'p1',
    scuola_id: 'sede-1',
    causale: 'Retta Settembre 2026 - per il minore Mara Bianchi - PLESSO UNO',
    descrizione: 'Retta Settembre 2026',
    importo: 250,
    nome: 'Mara',
    cognome: 'Bianchi',
    hasCf: true,
};
const VOCE_DUE: VoceCausale = {
    id: 'p2',
    scuola_id: 'sede-2',
    causale: 'Retta Settembre 2026 - per il minore Ugo Verdi - PLESSO DUE',
    descrizione: 'Retta Settembre 2026 (Ugo)',
    importo: 90.5,
    nome: 'Ugo',
    cognome: 'Verdi',
    hasCf: true,
};

const scrivi = vi.fn(() => Promise.resolve());

beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window.navigator, 'clipboard', {
        value: { writeText: scrivi },
        configurable: true,
    });
});

describe('ComePagare — bonifico o contanti, con intestatario e IBAN', () => {
    /**
     * ⚠️ Le asserzioni sui NOMI DEI PLESSI passano da qui, non da `screen`.
     *
     * I due pannelli restano ENTRAMBI nel DOM (quello inattivo con `hidden`) e
     * `getByText` non filtra per visibilità: da quando la riga dei plessi compare
     * anche nel pannello dei contanti — stessa frase, stessa chiave — un
     * `screen.getByText('Per le sedi …')` trova due nodi e fallisce, oppure (peggio,
     * ed è il caso che conta) PASSA pescando quello del pannello sbagliato senza
     * misurare niente. `getByRole('tabpanel')` rende invece solo quello esposto.
     */
    const pannelloAttivo = () => within(screen.getByRole('tabpanel'));

    it('rende i due metodi come tab, con «Bonifico» attivo di default', () => {
        render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);

        expect(screen.getByText('Come pagare')).toBeInTheDocument();
        // La lista dei metodi ha un nome proprio: «tablist» senza nome è un gruppo
        // anonimo per chi naviga a voce.
        expect(screen.getByRole('tablist', { name: 'Metodo di pagamento' })).toBeInTheDocument();

        const bonifico = screen.getByRole('tab', { name: 'Bonifico' });
        const contanti = screen.getByRole('tab', { name: 'Contanti' });
        expect(screen.getAllByRole('tab')).toHaveLength(2);

        // Selezione E fuoco tabulabile stanno insieme (tabIndex roving).
        expect(bonifico).toHaveAttribute('aria-selected', 'true');
        expect(bonifico).toHaveAttribute('tabindex', '0');
        expect(contanti).toHaveAttribute('aria-selected', 'false');
        expect(contanti).toHaveAttribute('tabindex', '-1');

        // Un solo pannello nell'albero accessibile: quello del tab attivo.
        const pannelli = screen.getAllByRole('tabpanel');
        expect(pannelli).toHaveLength(1);
        expect(pannelli[0]).toHaveAttribute('aria-labelledby', bonifico.id);
        expect(pannelli[0]).toHaveTextContent(IBAN_LEGGIBILE);
    });

    it('le frecce e Home/End spostano fuoco e selezione', () => {
        render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);
        const bonifico = screen.getByRole('tab', { name: 'Bonifico' });
        const contanti = screen.getByRole('tab', { name: 'Contanti' });

        bonifico.focus();
        fireEvent.keyDown(bonifico, { key: 'ArrowRight' });
        expect(contanti).toHaveAttribute('aria-selected', 'true');
        expect(document.activeElement).toBe(contanti);
        // Il pannello dei contanti dice anche la regola fiscale: non è un dettaglio.
        expect(screen.getByText(/non sono detraibili/)).toBeInTheDocument();

        fireEvent.keyDown(contanti, { key: 'ArrowLeft' });
        expect(bonifico).toHaveAttribute('aria-selected', 'true');
        expect(document.activeElement).toBe(bonifico);

        fireEvent.keyDown(bonifico, { key: 'End' });
        expect(contanti).toHaveAttribute('aria-selected', 'true');
        expect(document.activeElement).toBe(contanti);

        fireEvent.keyDown(contanti, { key: 'Home' });
        expect(bonifico).toHaveAttribute('aria-selected', 'true');
        expect(document.activeElement).toBe(bonifico);
    });

    it('«Copia l’IBAN» mette negli appunti l’IBAN e conferma «Copiato»', async () => {
        render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);

        expect(screen.getByText('Intestato a')).toBeInTheDocument();
        expect(screen.getByText(INTESTATARIO)).toBeInTheDocument();

        const copia = screen.getByRole('button', { name: 'Copia l’IBAN' });
        fireEvent.click(copia);

        // Negli appunti va la forma ELETTRONICA (senza spazi): è quella che ogni
        // home banking accetta. A schermo resta quella a gruppi di quattro.
        expect(scrivi).toHaveBeenCalledWith(IBAN_COMPATTO);
        expect(await screen.findByText('Copiato')).toBeInTheDocument();
        // La strada felice non scrive niente: un log a ogni copia riuscita
        // seppellirebbe le poche righe che raccontano il guasto.
        expect(logClient).not.toHaveBeenCalled();
    });

    // ─── QUANDO GLI APPUNTI DICONO DI NO (collaudo 2026-09-05, rilievo e) ────
    // `navigator.clipboard.writeText` fallisce per motivi diversi e distinguibili:
    // `NotAllowedError` (permesso negato o gesto utente non riconosciuto),
    // `SecurityError` (contesto non sicuro: http, iframe senza permesso), o
    // l'assenza dell'API dentro una WebView. Il `catch` senza binding buttava via
    // proprio la parola che distingue i tre casi — e sono tre correzioni diverse.
    it('appunti negati: la CAUSA finisce nel log, l’IBAN mai', () => {
        scrivi.mockRejectedValueOnce(
            Object.assign(new Error('Write permission denied.'), { name: 'NotAllowedError' }),
        );
        render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);

        fireEvent.click(screen.getByRole('button', { name: 'Copia l’IBAN' }));

        return Promise.resolve().then(() => {
            expect(logClient).toHaveBeenCalledTimes(1);
            const riga = vi.mocked(logClient).mock.calls[0][0];
            expect(riga.livello).toBe('warn');
            expect(riga.messaggio).toContain('NotAllowedError');
            // Nessuna coordinata bancaria nel log, in nessuna delle due forme.
            const testo = JSON.stringify(riga);
            expect(testo).not.toContain(IBAN_COMPATTO);
            expect(testo).not.toContain(IBAN_LEGGIBILE);
        });
    });

    it('appunti assenti del tutto (WebView senza API): la riga esce lo stesso', () => {
        // `nomeErrore` ripiega su `errore` quando ciò che è stato lanciato non è un
        // `Error`: la riga resta, e resta distinguibile da quella con il nome vero.
        scrivi.mockRejectedValueOnce('undefined is not an object');
        render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);

        fireEvent.click(screen.getByRole('button', { name: 'Copia l’IBAN' }));

        return Promise.resolve().then(() => {
            expect(logClient).toHaveBeenCalledTimes(1);
            expect(vi.mocked(logClient).mock.calls[0][0].messaggio).toContain('errore');
        });
    });

    it('senza IBAN configurato: nota di ripiego e nessun bottone di copia', () => {
        render(<ComePagare sedi={[{ ...SEDE_UNO, iban: null }]} voci={[VOCE_UNO]} />);

        expect(
            screen.getByText('Le coordinate bancarie non sono ancora disponibili: chiedile in segreteria.'),
        ).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Copia l’IBAN' })).toBeNull();
        // La card NON sparisce: le causali restano, ed è il senso del ripiego.
        expect(screen.getByText(VOCE_UNO.causale)).toBeInTheDocument();
    });

    it('senza intestatario configurato: lo dice invece di lasciare il vuoto', () => {
        render(<ComePagare sedi={[{ ...SEDE_UNO, intestatario: null }]} voci={[VOCE_UNO]} />);
        expect(screen.getByText('Intestatario non disponibile')).toBeInTheDocument();
    });

    it('due sedi con LE STESSE coordinate: un blocco solo, che le nomina entrambe', () => {
        render(<ComePagare sedi={[SEDE_UNO, SEDE_DUE]} voci={[VOCE_UNO, VOCE_DUE]} />);

        // Un solo IBAN a schermo, un solo «Intestato a», un solo bottone di copia.
        expect(screen.getAllByText(IBAN_LEGGIBILE)).toHaveLength(1);
        expect(screen.getAllByText('Intestato a')).toHaveLength(1);
        expect(screen.getAllByRole('button', { name: 'Copia l’IBAN' })).toHaveLength(1);
        // …ma il blocco dice per quali plessi vale, al plurale giusto.
        expect(pannelloAttivo().getByText('Per le sedi Plesso Uno · Plesso Due')).toBeInTheDocument();
        // Le causali di entrambe le sedi restano, sotto lo stesso conto.
        expect(screen.getByText(VOCE_UNO.causale)).toBeInTheDocument();
        expect(screen.getByText(VOCE_DUE.causale)).toBeInTheDocument();
    });

    it('due sedi con coordinate DIVERSE: due blocchi, ciascuno col proprio conto', () => {
        render(
            <ComePagare
                sedi={[SEDE_UNO, { ...SEDE_DUE, iban: IBAN_ALTRO, intestatario: 'Altra Cooperativa soc. coop.' }]}
                voci={[VOCE_UNO, VOCE_DUE]}
            />,
        );

        expect(screen.getByText(IBAN_LEGGIBILE)).toBeInTheDocument();
        expect(screen.getByText(IBAN_ALTRO)).toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: 'Copia l’IBAN' })).toHaveLength(2);
        // Un blocco per plesso ⇒ singolare, nella stessa pagina in cui l'altro caso
        // di prova ha il plurale: il `count` non è decorativo.
        expect(pannelloAttivo().getByText('Per la sede Plesso Uno')).toBeInTheDocument();
        expect(pannelloAttivo().getByText('Per la sede Plesso Due')).toBeInTheDocument();
    });

    it('una sede sola: nessuna riga di plesso, sarebbe rumore', () => {
        render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);
        expect(screen.queryByText(/^Per l[ae] sed/)).toBeNull();
    });

    it('nessuna voce aperta: non rende niente', () => {
        const { container } = render(<ComePagare sedi={[SEDE_UNO]} voci={[]} />);
        expect(container.firstChild).toBeNull();
    });

    it('le voci di una sede che il server non ha descritto restano visibili col ripiego', () => {
        // Contratto degradato (DB della CI senza `fiscale_config`, o risposta vecchia
        // senza `sedi`): la causale è l'unica cosa che resta, e deve restare.
        const { container } = render(<ComePagare sedi={[]} voci={[VOCE_UNO]} />);
        expect(container.firstChild).not.toBeNull();
        expect(screen.getByText(VOCE_UNO.causale)).toBeInTheDocument();
        expect(
            screen.getByText('Le coordinate bancarie non sono ancora disponibili: chiedile in segreteria.'),
        ).toBeInTheDocument();
    });

    it('token: il CTA è bianco su verde (AA), nessun testo `muted` né giallo', () => {
        const { container } = render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);

        const copia = screen.getByRole('button', { name: 'Copia l’IBAN' });
        expect(copia.className).toContain('bg-kidville-green');
        expect(copia.className).toContain('text-kidville-white');
        expect(copia.className).not.toContain('text-kidville-yellow');

        const html = container.innerHTML;
        expect(html).not.toContain('text-kidville-muted');
        expect(html).toContain('text-kidville-sub');
        // L'ancora dell'Alto Contrasto sta SUL CONTENITORE: le regole di
        // `globals.css` sono `[data-contrast="high"] .kv-come-pagare …` e senza
        // di lei la card resta bianca sul body nero (`@theme inline` inlina l'hex,
        // il rimappaggio dei token non tocca nessuna utility).
        expect(container.firstElementChild).toHaveClass('kv-come-pagare');
    });

    it('a11y: ogni comando della card arriva a 44px di lato', () => {
        const { container } = render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);
        const comandi = [...container.querySelectorAll('button')];
        // Tab (2) + «Copia l'IBAN» + una causale: nessuno sotto la soglia del dito.
        expect(comandi.length).toBeGreaterThanOrEqual(4);
        for (const c of comandi) expect(c.className).toContain('min-h-[44px]');
    });

    /* ────────────────────────────────────────────────────────────────────────
       Il secondo giro (2026-09-05): quello che le schermate hanno mostrato.
       ──────────────────────────────────────────────────────────────────────── */

    it('l’IBAN non si spezza dentro un gruppo di quattro', () => {
        render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);
        const iban = screen.getByText(IBAN_LEGGIBILE);
        // Misurato sulla schermata a 390px: con `break-all` l'IBAN andava a capo
        // in mezzo a un gruppo («…1010 0000 / 0123 456» e, col bottone accanto più
        // largo, «…1010 00 / 00 0123 456») — cioè la riga cambiava PREMENDO
        // «Copia». Senza `break-all` il ritorno a capo cade solo sugli spazi, che
        // nell'IBAN stanno esattamente fra un gruppo di quattro e l'altro.
        expect(iban.className).not.toContain('break-all');
        expect(iban.className).toContain('font-mono');
        // …e non deve nemmeno lasciare un gruppo ORFANO su una riga sua. Quando
        // l'IBAN è entrato nel campo copiabile, i 24px di respiro laterale gliene
        // hanno tolti abbastanza da mandarlo a capo: «… 0000 0123 / 456».
        // `text-[13px]` lo rimette su una riga sola (235px su 250 disponibili);
        // `text-balance` è la rete per un IBAN estero più lungo del nostro.
        expect(iban.className).toContain('text-balance');
        expect(iban.className).toContain('text-[13px]');
        // Nessun `sm:text-base`: la card NON si allarga su desktop — la colonna del
        // genitore la tiene a 398px contro 358 — quindi ingrandire il testo al
        // breakpoint gli toglieva la riga senza dargli spazio, e a 1280 l'IBAN
        // usciva su due righe. Misurato sulle fotografie dei due giri.
        expect(iban.className).not.toContain('sm:text-base');
    });

    it('il bottone dice CHE COSA copia e prende tutta la riga sotto l’IBAN', () => {
        render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);
        const copia = screen.getByRole('button', { name: 'Copia l’IBAN' });
        // Il testo visibile È il nome accessibile: niente `aria-label` che dica una
        // cosa diversa da quella scritta (WCAG 2.5.3).
        expect(copia).toHaveTextContent('Copia l’IBAN');
        expect(copia).not.toHaveAttribute('aria-label');
        // A tutta larghezza, su una riga sua: così premerlo non rimpicciolisce lo
        // spazio dell'IBAN e non lo fa andare a capo in un punto diverso.
        expect(copia.className).toContain('w-full');
    });

    it('il bonifico è raccontato in due passi numerati', () => {
        render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);
        // L'introduzione annuncia i due passi invece di ripetere, cinque righe più
        // in basso, la stessa frase sulla causale.
        expect(screen.getByText(/servono due cose: il conto e la causale/i)).toBeInTheDocument();
        expect(screen.getByText('Il conto')).toBeInTheDocument();
        expect(screen.getByText('La causale')).toBeInTheDocument();
        expect(screen.getByText('1')).toBeInTheDocument();
        expect(screen.getByText('2')).toBeInTheDocument();
    });

    it('la riga dei plessi sta DENTRO il riquadro del conto, non appesa sopra', () => {
        render(<ComePagare sedi={[SEDE_UNO, SEDE_DUE]} voci={[VOCE_UNO, VOCE_DUE]} />);
        const sedi = pannelloAttivo().getByText('Per le sedi Plesso Uno · Plesso Due');
        const iban = screen.getByText(IBAN_LEGGIBILE);
        // Si risale al riquadro dal BORDO e non più dal raggio: da quando l'IBAN sta
        // in un campo copiabile, `rounded-input` non è più univoca dentro il blocco
        // — `closest('.rounded-input')` si fermava al campo, cioè a sé stesso, e il
        // test falliva pur essendo il markup giusto. Il riquadro del conto è l'unica
        // cosa qui dentro che porta un bordo `border-kidville-line`.
        const riquadro = iban.closest('.border-kidville-line');
        expect(riquadro).not.toBeNull();
        expect(riquadro?.contains(sedi)).toBe(true);
    });

    it('nessun movimento gratuito: la pressione è condizionata a `motion-safe`', () => {
        const { container } = render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);
        for (const b of container.querySelectorAll('button')) {
            if (b.className.includes('scale-95')) {
                expect(b.className).toContain('motion-safe:active:scale-95');
            }
        }
    });

    /* ────────────────────────────────────────────────────────────────────────
       Il terzo giro (2026-09-05), dalle schermate a 390px e 1280px.
       ──────────────────────────────────────────────────────────────────────── */

    it('l’IBAN sta in un CAMPO copiabile, con lo stesso vestito della causale', () => {
        render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);
        const iban = screen.getByText(IBAN_LEGGIBILE);
        // Nella card ci sono due sole cose da copiare — l'IBAN e la causale — e
        // nella versione precedente si vestivano in modo diverso: la causale in un
        // campo chiaro riquadrato, l'IBAN come testo nudo. Chi guarda per tre
        // secondi cerca «il rettangolo da cui si copia»: ce n'era uno solo, e non
        // era quello per cui la card esiste. Stesso vestito ⇒ stessa promessa.
        expect(iban.className).toContain('bg-kidville-cream');
        expect(iban.className).toContain('rounded-input');
        expect(iban.className).toContain('font-mono');
    });

    it('nessun raggio fuori scala: solo `card` (16), `input` (12) e `pill`', () => {
        const { container } = render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);
        expect(container.innerHTML).not.toMatch(/rounded-\[/);
    });

    it('entrambi i campi copiabili portano l’ancora dell’Alto Contrasto', () => {
        render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);
        // `@theme inline` INLINA l'hex dentro le utility: né `bg-kidville-white` né
        // `bg-kidville-cream` si ribaltano da soli. Senza questa classe, in Alto
        // Contrasto un campo resterebbe bianco su testo bianco e l'altro sarebbe un
        // #1A1A1A che sul nero della card non si stacca (1,15:1) — il testo si
        // leggerebbe, il RETTANGOLO no. La regola sta in fondo a `globals.css`.
        expect(screen.getByText(IBAN_LEGGIBILE).className).toContain('kv-campo-copiabile');
        expect(screen.getByText(VOCE_UNO.causale).className).toContain('kv-campo-copiabile');
    });

    it('contanti con più plessi: dice IN QUALE segreteria, non «in segreteria»', () => {
        render(<ComePagare sedi={[SEDE_UNO, SEDE_DUE]} voci={[VOCE_UNO, VOCE_DUE]} />);
        fireEvent.click(screen.getByRole('tab', { name: 'Contanti' }));
        // Il difetto è di prodotto, non di grafica: una famiglia con due figli in
        // due plessi legge «in segreteria» e non sa a QUALE presentarsi. I nomi
        // sono già in pagina (il blocco del conto li elenca): tacerli qui è una
        // scelta, e la scelta era sbagliata.
        expect(pannelloAttivo().getByText(/Plesso Uno · Plesso Due/)).toBeInTheDocument();
        expect(pannelloAttivo().getByText(/non sono detraibili/)).toBeInTheDocument();
    });

    it('contanti con un plesso solo: nessun elenco, sarebbe rumore', () => {
        render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);
        fireEvent.click(screen.getByRole('tab', { name: 'Contanti' }));
        expect(pannelloAttivo().getByText(/negli orari di apertura/)).toBeInTheDocument();
        expect(pannelloAttivo().queryByText(/Plesso Uno/)).toBeNull();
    });
});
