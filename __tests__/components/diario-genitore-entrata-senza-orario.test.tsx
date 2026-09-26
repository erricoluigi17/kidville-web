import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import itDiario from '../../messages/it/diario.json';

/**
 * A1 (2026-09-26) — IL GENITORE VEDE CHE IL FIGLIO È ARRIVATO, MA NON A CHE ORA.
 *
 * Il titolare ha chiesto di togliere l'ORARIO d'ingresso al genitore quando il
 * bambino è «presente» (resta solo sul «ritardo», dove è l'ora del docente).
 * `GET /api/diary/checkin` ora risponde `orario_entrata: null` per i presenti e
 * manda lo `stato` del giorno. La pagina, che prima leggeva solo l'orario, con
 * `null` perdeva tre cose insieme: la card «Entrata», la timeline col banner
 * dell'umore e — senza voci della maestra — mostrava «Nessuna voce» a un bambino
 * in classe. Qui si monta la pagina VERA e si guarda cosa legge il genitore.
 */

vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
    useSearchParams: () => new URLSearchParams(''),
    useParams: () => ({}),
    usePathname: () => '/parent/diary',
}));
vi.mock('@/lib/auth/use-parent-identity', () => ({
    useParentIdentity: () => ({ parentId: 'p1', studentId: 'a1', studentName: 'Ada', ready: true, children: [] }),
}));
vi.mock('@/lib/auth/use-child-school-type', () => ({
    useChildSchoolType: () => ({ isPrimaria: false, ready: true, gradoScolastico: 'infanzia' }),
}));
vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Errore' }));

// Nessuna voce della maestra: è il caso in cui la regressione si vedeva di più
// (stato vuoto «Nessuna voce» al posto dell'arrivo).
vi.mock('@/lib/offline/read-cache', () => ({
    fetchConCache: vi.fn(async () => ({ data: [], offline: false })),
}));

/** Risposta della route di checkin per il test corrente. */
let checkin: { orario_entrata: string | null; stato?: string | null } = { orario_entrata: null, stato: null };

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (String(url).startsWith('/api/diary/checkin')) {
            return { ok: true, status: 200, json: async () => checkin };
        }
        return { ok: true, status: 200, json: async () => ({ media: [], total: 0 }) };
    }));
});

import ParentDiaryPage from '@/app/(dashboard)/parent/diary/page';

const ORARIO = /\b\d{1,2}:\d{2}\b/;

describe('Diario del genitore — l\'arrivo senza orario per i presenti (A1)', () => {
    it('presente: card «Entrata» SENZA ora, niente «Nessuna voce», banner dell\'umore presente', async () => {
        checkin = { orario_entrata: null, stato: 'presente' };
        render(<ParentDiaryPage />);
        // Ancora POSITIVA: la frase d'arrivo senza orario deve comparire.
        const frase = await screen.findByText(itDiario.narrativaEntrataSenzaOrario);
        expect(frase).toBeTruthy();
        expect(screen.getByText(itDiario.entrataLabel)).toBeTruthy();
        expect(screen.getByText(itDiario.umoreTitolo)).toBeTruthy();
        // Solo dopo averla vista si può dire che lo stato vuoto non c'è.
        expect(screen.queryByText(itDiario.vuotoTitolo)).toBeNull();
        // E nessun orario scritto nella card.
        const card = frase.closest('div')!;
        expect(card.textContent ?? '').not.toMatch(ORARIO);
    });

    it('presente MA con orario nella risposta: la pagina non lo mostra lo stesso (guardia lato client)', async () => {
        // Una route regredita, o un server vecchio a metà deploy, potrebbe mandare
        // l'ora anche a un presente: il requisito è «se non è ritardo, nessun orario»,
        // e non deve reggersi solo sul server.
        checkin = { orario_entrata: '08:05', stato: 'presente' };
        render(<ParentDiaryPage />);
        // Ancora POSITIVA: la card d'arrivo c'è, con la frase senza orario.
        const frase = await screen.findByText(itDiario.narrativaEntrataSenzaOrario);
        expect(screen.getByText(itDiario.entrataLabel)).toBeTruthy();
        expect(screen.queryByText(itDiario.narrativaEntrataAlle.replace('{orario}', '08:05'))).toBeNull();
        expect(frase.closest('div')!.textContent ?? '').not.toMatch(ORARIO);
        expect(document.body.textContent ?? '').not.toContain('08:05');
    });

    it('uscita anticipata con orario nella risposta: nessuna ora d\'ingresso', async () => {
        checkin = { orario_entrata: '08:05', stato: 'uscita_anticipata' };
        render(<ParentDiaryPage />);
        await screen.findByText(itDiario.narrativaEntrataSenzaOrario);
        expect(document.body.textContent ?? '').not.toContain('08:05');
    });

    it('risposta di un server precedente (orario senza `stato`): l\'ora resta, come prima', async () => {
        // Il campo `stato` proprio assente, come nella risposta vecchia.
        checkin = { orario_entrata: '08:05' };
        render(<ParentDiaryPage />);
        const attesa = itDiario.narrativaEntrataAlle.replace('{orario}', '08:05');
        expect(await screen.findByText(attesa)).toBeTruthy();
    });

    it('uscita anticipata: arrivato comunque, card SENZA ora d\'ingresso', async () => {
        checkin = { orario_entrata: null, stato: 'uscita_anticipata' };
        render(<ParentDiaryPage />);
        await screen.findByText(itDiario.narrativaEntrataSenzaOrario);
        expect(screen.queryByText(itDiario.vuotoTitolo)).toBeNull();
    });

    it('ritardo: card con l\'orario registrato dal docente', async () => {
        checkin = { orario_entrata: '09:40', stato: 'ritardo' };
        render(<ParentDiaryPage />);
        const attesa = itDiario.narrativaEntrataAlle.replace('{orario}', '09:40');
        expect(await screen.findByText(attesa)).toBeTruthy();
        expect(screen.queryByText(itDiario.narrativaEntrataSenzaOrario)).toBeNull();
        expect(screen.queryByText(itDiario.vuotoTitolo)).toBeNull();
    });

    it('assente: nessuna card d\'arrivo, resta lo stato vuoto', async () => {
        checkin = { orario_entrata: null, stato: 'assente' };
        render(<ParentDiaryPage />);
        // Ancora positiva: lo stato vuoto compare.
        expect(await screen.findByText(itDiario.vuotoTitolo)).toBeTruthy();
        expect(screen.queryByText(itDiario.entrataLabel)).toBeNull();
        expect(screen.queryByText(itDiario.narrativaEntrataSenzaOrario)).toBeNull();
    });

    it('appello non fatto (stato null): nessuna card d\'arrivo', async () => {
        checkin = { orario_entrata: null, stato: null };
        render(<ParentDiaryPage />);
        expect(await screen.findByText(itDiario.vuotoTitolo)).toBeTruthy();
        expect(screen.queryByText(itDiario.entrataLabel)).toBeNull();
    });

    // ─── `stato` PRESENTE nella risposta = server nuovo: decide lo stato, non l'orario ───
    //
    // Solo la risposta di un server precedente (proprietà `stato` ASSENTE) conta
    // l'orario come arrivo. Se `stato` c'è — anche `null` — l'orario non decide più
    // né l'arrivo né la sua visibilità: un orario rimasto su un assente (route
    // regredita, riga di presenze passata da presente ad assente) non deve dire al
    // genitore che il figlio è a scuola.

    it('assente CON un orario rimasto nella risposta: nessuna card «Entrata», resta lo stato vuoto', async () => {
        checkin = { orario_entrata: '08:05', stato: 'assente' };
        render(<ParentDiaryPage />);
        // Ancora POSITIVA: lo stato vuoto compare.
        expect(await screen.findByText(itDiario.vuotoTitolo)).toBeTruthy();
        expect(screen.queryByText(itDiario.entrataLabel)).toBeNull();
        expect(screen.queryByText(itDiario.narrativaEntrataSenzaOrario)).toBeNull();
        expect(document.body.textContent ?? '').not.toContain('08:05');
    });

    it('appello non fatto (stato null ESPLICITO) CON un orario: stato vuoto e nessuna ora', async () => {
        // `stato: null` esplicito è un server NUOVO: non va confuso col campo
        // mancante del server vecchio.
        checkin = { orario_entrata: '08:05', stato: null };
        render(<ParentDiaryPage />);
        expect(await screen.findByText(itDiario.vuotoTitolo)).toBeTruthy();
        expect(screen.queryByText(itDiario.entrataLabel)).toBeNull();
        expect(document.body.textContent ?? '').not.toContain('08:05');
    });
});
