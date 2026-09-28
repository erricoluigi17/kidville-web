import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import itDiario from '../../messages/it/diario.json';

/**
 * IL DIARIO DEL GENITORE E LE ROUTINE (2026-09-28): le routine aggiunte dalla scuola si leggono col
 * loro nome, e il riquadro dell'umore c'è solo se la maestra l'ha segnato. Stessa impalcatura del
 * test della ricarica (`diario-genitore-ricarica-al-ritorno.test.tsx`): pagina VERA, rete finta.
 */

vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
    useSearchParams: () => new URLSearchParams(''),
    useParams: () => ({}),
    usePathname: () => '/parent/diary',
}));
vi.mock('@/lib/auth/use-parent-identity', () => ({
    useParentIdentity: () => ({ parentId: 'p1', studentId: 'a1', ready: true, figliIds: ['a1'] }),
}));
vi.mock('@/lib/auth/use-child-school-type', () => ({
    useChildSchoolType: () => ({ schoolType: 'nido', ready: true }),
}));
vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Errore' }));
vi.mock('@/lib/push/native-register', () => ({ isNativeApp: () => false }));

/** Le risposte del diario, in ordine: ogni chiamata consuma la prossima. */
const h = vi.hoisted(() => ({
    risposte: [] as Array<() => Promise<{ data: unknown; offline: boolean }>>,
    chiavi: [] as string[],
    checkin: [] as Array<() => Promise<unknown>>,
}));

// `fetchConCache(chiave, url)`: il PRIMO argomento è la chiave (`diario:<alunno>:<data>:<data>`).
vi.mock('@/lib/offline/read-cache', () => ({
    fetchConCache: vi.fn(async (chiave: string) => {
        h.chiavi.push(chiave);
        const prossima = h.risposte.shift();
        if (!prossima) throw new Error('nessuna risposta preparata per ' + chiave);
        return prossima();
    }),
}));

import ParentDiaryPage from '@/app/(dashboard)/parent/diary/page';

const oggi = (ora: number) => { const d = new Date(); d.setHours(ora, 0, 0, 0); return d.toISOString(); };

const PRANZO = { id: 'e-pranzo', tipo_evento: 'pranzo', timestamp_evento: oggi(12),
    dettagli: { corsi: { primo: 'niente' } }, note: null, notaBambino: null };

const ok = (data: unknown) => () => Promise.resolve({ data, offline: false });

function risposta(corpo: unknown) {
    return { ok: true, status: 200, json: async () => corpo };
}

beforeEach(() => {
    vi.clearAllMocks();
    h.risposte = [];
    h.chiavi = [];
    h.checkin = [];
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (String(url).startsWith('/api/diary/checkin')) {
            const prossima = h.checkin.shift();
            return prossima ? prossima() : risposta({ stato: null, orario_entrata: null });
        }
        if (String(url).startsWith('/api/diary/students')) return risposta({ nome: 'Ada', cognome: 'B' });
        return risposta({ media: [], total: 0 });
    }));
});

/**
 * LE ROUTINE DELLA SCUOLA NEL DIARIO DEL GENITORE (2026-09-28).
 *
 * Senza una regola, una voce `routine:<id>` sarebbe arrivata al genitore come «Evento — Evento
 * registrato dalla maestra.» 📝: il difetto della frase generica, rifatto per ogni routine che la
 * segreteria aggiunge. Il nome e l'icona vengono dalla FOTOGRAFIA salvata nella voce, così la
 * voce resta leggibile anche quando la routine viene rinominata, spenta o cancellata (le voci già
 * scritte restano visibili: decisione del titolare).
 */
const routine = (id: string, nome: string, emoji: string, risposta: string, valore: unknown) => ({
    id: `e-${id}`, tipo_evento: `routine:${id}`, timestamp_evento: oggi(11),
    dettagli: { nome, emoji, risposta, valore }, note: null, notaBambino: null,
});

describe('diario del genitore — le routine della scuola', () => {
    it('ogni routine si legge col suo nome e il suo valore, per ogni tipo di risposta', async () => {
        h.risposte.push(ok([
            routine('a1b2c3d4', 'Crema solare', '🧴', 'spunta', true),
            routine('e5f6a7b8', 'Biberon', '🍼', 'scelta', ['Poco', 'Tutto']),
            routine('b0b0b0b0', 'Latte', '🥛', 'orario', '10:30'),
            routine('d0d0d0d0', 'Appunto', '📝', 'testo', 'ha giocato col trenino'),
        ]));
        render(<ParentDiaryPage />);

        expect(await screen.findByText('Crema solare')).toBeInTheDocument();
        expect(screen.getByText(itDiario.routineFatto)).toBeInTheDocument();
        expect(screen.getByText('Biberon')).toBeInTheDocument();
        expect(screen.getByText('Poco, Tutto')).toBeInTheDocument();
        expect(screen.getByText(itDiario.routineAlle.replace('{ora}', '10:30'))).toBeInTheDocument();
        expect(screen.getByText('ha giocato col trenino')).toBeInTheDocument();
        expect(screen.queryByText(itDiario.eventoGenerico), 'una routine raccontata con la frase generica').not.toBeInTheDocument();
        expect(screen.queryByText(/routine:/), 'il codice grezzo del tipo a schermo').not.toBeInTheDocument();
    });

    it('una routine lasciata vuota non si mostra (come un bagno a zero)', async () => {
        h.risposte.push(ok([routine('a1b2c3d4', 'Crema solare', '🧴', 'spunta', null), PRANZO]));
        render(<ParentDiaryPage />);
        await screen.findByText(new RegExp(itDiario.quantita_niente));
        expect(screen.queryByText('Crema solare')).not.toBeInTheDocument();
    });
});

describe('diario del genitore — l\'umore c\'è solo se la maestra l\'ha segnato', () => {
    // Le tre sedi vere hanno l'umore SPENTO: il riquadro diceva a ogni genitore, ogni giorno,
    // «Presto la maestra potrà segnalare come è andata» — una promessa che la sede non manteneva.
    it('senza voce d\'umore, niente riquadro', async () => {
        h.risposte.push(ok([PRANZO]));
        render(<ParentDiaryPage />);
        await screen.findByText(new RegExp(itDiario.quantita_niente));
        expect(screen.queryByText(itDiario.umoreTitolo)).not.toBeInTheDocument();
        expect(screen.queryByText(/Presto la maestra/), 'la promessa di un umore che la sede non segna').not.toBeInTheDocument();
    });

    it('con la voce d\'umore, il riquadro c\'è', async () => {
        h.risposte.push(ok([PRANZO, { id: 'e-umore', tipo_evento: 'umore', timestamp_evento: oggi(9), dettagli: { umore: 'felice' }, note: null, notaBambino: null }]));
        render(<ParentDiaryPage />);
        expect(await screen.findByText(new RegExp(itDiario.umoreTitolo))).toBeInTheDocument();
    });
});

describe('diario del genitore — seconda revisione critica (2026-09-28)', () => {
    it('ALTA · una routine a spunta NON segnata, tenuta in piedi da una nota, non dice «Fatto ✓»', async () => {
        // La maestra spunta «Crema solare» a 3 bambini su 20 e scrive la nota di sezione: gli altri
        // 17 genitori leggevano «Fatto ✓». Con una routine «Farmaco» sarebbe pericoloso.
        h.risposte.push(ok([
            { ...routine('a1b2c3d4', 'Crema solare', '🧴', 'spunta', null), note: 'Domani portate la crema' },
            { ...routine('e5f6a7b8', 'Biberon', '🍼', 'scelta', null), notaBambino: 'Ha preferito il bicchiere' },
        ]));
        render(<ParentDiaryPage />);
        expect(await screen.findByText(/Domani portate la crema/)).toBeInTheDocument();
        expect(screen.getByText(/Ha preferito il bicchiere/)).toBeInTheDocument();
        expect(screen.queryByText(itDiario.routineFatto), 'un «Fatto» mai segnato').not.toBeInTheDocument();
        expect(screen.queryByText(itDiario.eventoGenerico)).not.toBeInTheDocument();
    });

    it('voci tutte mute e nessun ingresso: lo stato vuoto c\'è, non una pagina bianca', async () => {
        h.risposte.push(ok([{ id: 'e-n', tipo_evento: 'nanna_inizio', timestamp_evento: oggi(13), dettagli: { orario_inizio: '' }, note: null, notaBambino: null }]));
        render(<ParentDiaryPage />);
        expect(await screen.findByText(itDiario.vuotoTitolo)).toBeInTheDocument();
    });

    it('la nota scritta nel riquadro dell\'umore arriva al genitore', async () => {
        h.risposte.push(ok([{ id: 'e-umore', tipo_evento: 'umore', timestamp_evento: oggi(9), dettagli: { umore: 'felice' }, note: 'Giornata di sole', notaBambino: 'Ha riso tanto' }]));
        render(<ParentDiaryPage />);
        expect(await screen.findByText(/Giornata di sole/)).toBeInTheDocument();
        expect(screen.getByText(/Ha riso tanto/)).toBeInTheDocument();
    });

    it('per una routine a orario, a lato c\'è l\'ORA SEGNATA, non quella del salvataggio', async () => {
        h.risposte.push(ok([{ ...routine('b0b0b0b0', 'Latte', '🥛', 'orario', '10:30'), timestamp_evento: oggi(15) }]));
        render(<ParentDiaryPage />);
        expect(await screen.findByText('10:30')).toBeInTheDocument();
        expect(screen.queryByText('15:00')).not.toBeInTheDocument();
    });

    it('le routine della scuola vengono dopo quelle base, dalla PIÙ PRESTO alla più tardi', async () => {
        h.risposte.push(ok([
            { ...routine('b0b0b0b0', 'Latte', '🥛', 'spunta', true), timestamp_evento: oggi(15) },
            { ...routine('a1b2c3d4', 'Crema solare', '🧴', 'spunta', true), timestamp_evento: oggi(9) },
            PRANZO,
        ]));
        render(<ParentDiaryPage />);
        const latte = await screen.findByText('Latte');
        const crema = screen.getByText('Crema solare');
        const pranzo = screen.getByText(/Pranzo/i, { selector: 'p.font-barlow' });
        expect(pranzo.compareDocumentPosition(crema) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(crema.compareDocumentPosition(latte) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
});
