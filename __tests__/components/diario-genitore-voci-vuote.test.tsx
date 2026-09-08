import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import itDiario from '../../messages/it/diario.json';

/**
 * IL BAGNO MAI AVVENUTO NON COMPARE PIÙ NEL DIARIO DI UN BAMBINO.
 *
 * ─── IL DIFETTO, MISURATO ──────────────────────────────────────────────────
 * «Salva bagno per tutti» scriveva una riga per ogni bambino presente, con i
 * contatori a zero che `buildInitialState` mette d'ufficio. La narrativa del
 * genitore, non trovando nessun contatore sopra zero, cadeva sulla frase
 * generica: «🚿 Sono stato/a al bagno oggi!». Dal 1° settembre 2026, **323
 * righe su 514 erano in quello stato** — il 63%.
 *
 * Qui si monta la pagina VERA del genitore, perché è lì che la frase si legge.
 * Il controcaso («niente» a pranzo, che è una registrazione vera) è nello stesso
 * file di proposito: un filtro troppo largo passerebbe il primo test e
 * cancellerebbe proprio il bambino che non ha mangiato.
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

/** Le voci devono cadere nel giorno che la pagina mostra: oggi. */
const OGGI = (ora: number) => { const d = new Date(); d.setHours(ora, 0, 0, 0); return d.toISOString(); };

const VOCI = [
    { id: 'e1', tipo_evento: 'bagno', timestamp_evento: OGGI(9),
      dettagli: { pipi: 0, cacca: 0, vasino: 0 }, note: null, notaBambino: null },
    { id: 'e2', tipo_evento: 'pranzo', timestamp_evento: OGGI(11),
      dettagli: { corsi: { primo: 'niente', secondo: null } }, note: null, notaBambino: null },
    { id: 'e3', tipo_evento: 'merenda', timestamp_evento: OGGI(8),
      dettagli: { corsi: { merenda: null } }, note: null, notaBambino: null },
];

// ⚠️ `fetchConCache(chiave, url)`: il PRIMO argomento è la chiave di cache
// (`diario:<alunno>:<data>:<data>`), non l'URL — e il risultato è `{ data, offline }`.
// Sbagliare l'uno o l'altro fa rendere alla pagina «Nessuna voce», e i due test
// negativi qui sotto passerebbero **senza che nulla sia stato provato**: è il
// silenzio scambiato per segnale, la trappola contro cui questo repo mette in
// guardia. Il terzo test — quello che PRETENDE di vedere una frase — è la
// sentinella che lo impedisce.
vi.mock('@/lib/offline/read-cache', () => ({
    fetchConCache: vi.fn(async (chiave: string) => (
        String(chiave).startsWith('diario:') ? { data: VOCI, offline: false } : { data: [], offline: false }
    )),
}));

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ media: [], total: 0 }) })));
});

import ParentDiaryPage from '@/app/(dashboard)/parent/diary/page';

/**
 * Attende che la pagina abbia DAVVERO reso le voci, e poi restituisce lo schermo.
 *
 * Serve un'ancora positiva: un `waitFor` che aspetta un'ASSENZA è soddisfatto dal
 * primo istante, quando le voci non sono ancora arrivate — e il test passa senza
 * aver provato niente. Qui l'ancora è la frase del pranzo «niente», che c'è
 * sempre: solo dopo averla vista si può dire che le altre mancano.
 */
async function diarioReso() {
    render(<ParentDiaryPage />);
    await screen.findByText(new RegExp(itDiario.quantita_niente));
}

describe('diario del genitore — niente frasi su cose mai avvenute', () => {
    it('un bagno con tutti i contatori a zero NON produce nessuna voce', async () => {
        await diarioReso();
        expect(screen.queryByText(itDiario.bagnoGenerico)).not.toBeInTheDocument();
    });

    it('una merenda senza nessuna portata NON dice «Ho mangiato con i miei amici!»', async () => {
        await diarioReso();
        expect(screen.queryByText(itDiario.pastoGenerico)).not.toBeInTheDocument();
    });

    it('ma «niente» a pranzo SÌ: è il bambino che non ha mangiato, ed è ciò che conta sapere', async () => {
        // È anche l'ancora di `diarioReso`: se un domani questa frase sparisse, i
        // due test qui sopra diventerebbero rossi invece di passare a vuoto.
        await diarioReso();
        expect(screen.getByText(new RegExp(itDiario.quantita_niente))).toBeInTheDocument();
    });
});
