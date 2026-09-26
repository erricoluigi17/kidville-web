import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import itDiario from '../../messages/it/diario.json';
import { intlDateTime } from '@/i18n/config';

/**
 * D3 (2026-09-26) — L'ORARIO DELLE ATTIVITÀ NEL DIARIO DEL GENITORE.
 *
 * Contratto D1: ogni voce di `dettagli.activities[]` può avere `ora_inizio` e
 * `ora_fine` ("HH:MM", facoltativi ciascuno per conto suo). Il genitore legge,
 * per ogni attività, «dalle 10:00 alle 11:00» («dalle 10:00» con il solo inizio,
 * «fino alle 11:00» con la sola fine, niente se non c'è). A lato della voce
 * vede l'ora di inizio della PRIMA attività; se quella non l'ha, l'ora del
 * salvataggio, come prima.
 *
 * Si monta la pagina VERA: è lì che il genitore legge.
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

type Voce = {
    id: string; tipo_evento: string; timestamp_evento: string;
    dettagli: Record<string, unknown> | null; note: string | null; notaBambino: string | null;
};

/** Le voci del test corrente (la pagina le riceve da `fetchConCache`). */
let voci: Voce[] = [];

// ⚠️ Il PRIMO argomento di `fetchConCache` è la chiave di cache (`diario:…`), non
// l'URL: sbagliarla renderebbe «Nessuna voce» e i controlli negativi passerebbero
// senza aver provato niente. Ogni test ha un'ancora POSITIVA prima dei negativi.
vi.mock('@/lib/offline/read-cache', () => ({
    fetchConCache: vi.fn(async (chiave: string) => (
        String(chiave).startsWith('diario:') ? { data: voci, offline: false } : { data: [], offline: false }
    )),
}));

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (String(url).startsWith('/api/diary/checkin')) {
            return { ok: true, status: 200, json: async () => ({ orario_entrata: null, stato: null }) };
        }
        return { ok: true, status: 200, json: async () => ({ media: [], total: 0 }) };
    }));
});

import ParentDiaryPage from '@/app/(dashboard)/parent/diary/page';

// Ora del SALVATAGGIO: 13:47 UTC = 15:47 a Roma (settembre, ora legale). Minuti
// «strani» apposta, perché non coincidano con nessun orario d'attività.
const SALVATAGGIO = '2026-09-26T13:47:00.000Z';
const oraSalvataggio = (iso: string) =>
    intlDateTime('it', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

const dalleAlle = (inizio: string, fine: string) =>
    itDiario.attivitaOrarioDalleAlle.replace('{inizio}', inizio).replace('{fine}', fine);
const dalle = (inizio: string) => itDiario.attivitaOrarioDalle.replace('{inizio}', inizio);
const finoAlle = (fine: string) => itDiario.attivitaOrarioFinoAlle.replace('{fine}', fine);

function attivita(id: string, activities: unknown[], ts = SALVATAGGIO): Voce {
    return { id, tipo_evento: 'attivita', timestamp_evento: ts, dettagli: { activities }, note: null, notaBambino: null };
}

/** La riga (il `<p>`) che contiene la descrizione data: ancora positiva. */
async function riga(descrizione: string): Promise<string> {
    const el = await screen.findByText(new RegExp(descrizione));
    return el.textContent ?? '';
}

describe('Diario del genitore — orario di ogni attività (D3, punto 1)', () => {
    it('inizio e fine → «dalle … alle …»; solo inizio → «dalle …»; solo fine → «fino alle …»; nessuno → come prima', async () => {
        voci = [attivita('e1', [
            { tipo: 'pittura', descrizione: 'tema autunno', partecipazione: 'autonomia', ora_inizio: '10:00', ora_fine: '11:00' },
            { tipo: 'musica', descrizione: 'canti in cerchio', ora_inizio: '', ora_fine: null },
            { tipo: 'lettura', descrizione: 'una fiaba', ora_fine: '12:30' },
            { tipo: 'gioco', descrizione: 'costruzioni', ora_inizio: '13:05' },
        ])];
        render(<ParentDiaryPage />);

        const pittura = await riga('tema autunno');
        expect(pittura).toContain(dalleAlle('10:00', '11:00'));
        // La descrizione e la partecipazione restano quelle di prima.
        expect(pittura).toContain(itDiario.partecipazione_autonomia);

        // Nessun orario: la riga è esattamente quella di sempre.
        const musica = await riga('canti in cerchio');
        expect(musica).toBe(`🎵 ${itDiario.attivitaHoFatto.replace('{label}', itDiario.attivita_musica)}: canti in cerchio`);

        const lettura = await riga('una fiaba');
        expect(lettura).toContain(finoAlle('12:30'));
        expect(lettura).not.toContain(dalle('12:30'));

        const gioco = await riga('costruzioni');
        expect(gioco).toContain(dalle('13:05'));
        // «dalle 13:05» e basta: niente «alle …» dopo.
        expect(gioco).not.toMatch(/13:05.*\d{2}:\d{2}/);
    });

    it('un orario fuori formato non viene mostrato (né «aggiustato»)', async () => {
        voci = [attivita('e1', [
            { tipo: 'pittura', descrizione: 'acquerelli', ora_inizio: '9:30', ora_fine: '10:00:00' },
        ])];
        render(<ParentDiaryPage />);
        const r = await riga('acquerelli');
        expect(r).not.toMatch(/\d{1,2}:\d{2}/);
    });

    // Solo PARITÀ dei cataloghi: la pagina montata in inglese si controlla in
    // `diario-genitore-attivita-orario-en.test.tsx`.
    it('le tre chiavi dell\'orario esistono anche nel catalogo en, tradotte', async () => {
        const en = (await import('../../messages/en/diario.json')).default as Record<string, string>;
        for (const k of ['attivitaOrarioDalleAlle', 'attivitaOrarioDalle', 'attivitaOrarioFinoAlle']) {
            expect(typeof en[k]).toBe('string');
            expect(en[k]).not.toBe((itDiario as Record<string, string>)[k]);
        }
    });
});

describe('Diario del genitore — ora a lato della voce attività (D3, punto 2)', () => {
    it('con l\'inizio della PRIMA attività: a lato c\'è quello, non l\'ora del salvataggio', async () => {
        voci = [attivita('e1', [
            { tipo: 'pittura', descrizione: 'tema autunno', ora_inizio: '09:15', ora_fine: '10:00' },
        ])];
        render(<ParentDiaryPage />);
        await riga('tema autunno');
        // L'elemento dell'ora a lato contiene SOLO l'ora: match esatto.
        expect(screen.getByText('09:15')).toBeTruthy();
        expect(screen.queryByText(oraSalvataggio(SALVATAGGIO))).toBeNull();
    });

    it('la prima attività SENZA inizio: ora del salvataggio, anche se una successiva ce l\'ha', async () => {
        voci = [attivita('e1', [
            { tipo: 'pittura', descrizione: 'tema autunno', ora_fine: '10:00' },
            { tipo: 'musica', descrizione: 'canti', ora_inizio: '11:20' },
        ])];
        render(<ParentDiaryPage />);
        await riga('tema autunno');
        expect(screen.getByText(oraSalvataggio(SALVATAGGIO))).toBeTruthy();
        expect(oraSalvataggio(SALVATAGGIO)).toBe('15:47');
        expect(screen.queryByText('11:20')).toBeNull();
    });

    it('le altre voci (non attività) tengono l\'ora del salvataggio, ANCHE se hanno `activities` con un orario', async () => {
        // La voce di pranzo porta apposta `dettagli.activities` con un `ora_inizio`:
        // senza la guardia sul tipo (`tipo_evento === 'attivita'`) a lato del pranzo
        // comparirebbe 07:10 invece dell'ora del salvataggio.
        voci = [
            attivita('e1', [{ tipo: 'pittura', descrizione: 'tema autunno', ora_inizio: '09:15' }]),
            { id: 'e2', tipo_evento: 'pranzo', timestamp_evento: '2026-09-26T10:05:00.000Z',
              dettagli: { corsi: { primo: 'tutto' }, activities: [{ ora_inizio: '07:10' }] },
              note: null, notaBambino: null },
        ];
        render(<ParentDiaryPage />);
        await riga('tema autunno');
        // Ancora positiva: l'ora di lato del pranzo è quella del salvataggio (12:05 a Roma).
        expect(oraSalvataggio('2026-09-26T10:05:00.000Z')).toBe('12:05');
        expect(screen.getByText('12:05')).toBeTruthy();
        expect(screen.queryByText('07:10')).toBeNull();
    });

    it('fra due registrazioni d\'attività vince l\'ULTIMA SALVATA, anche se il suo orario è più presto', async () => {
        // La deduplica resta sull'ora del SALVATAGGIO: la correzione della maestra
        // (salvata dopo, con l'attività spostata alle 08:30) deve battere la
        // registrazione vecchia (salvata prima, con l'attività alle 11:00). Se la
        // deduplica usasse l'ora mostrata, la correzione andrebbe persa.
        voci = [
            attivita('vecchia', [{ tipo: 'pittura', descrizione: 'versione vecchia', ora_inizio: '11:00' }], '2026-09-26T09:00:00.000Z'),
            attivita('nuova', [{ tipo: 'pittura', descrizione: 'versione corretta', ora_inizio: '08:30' }], '2026-09-26T12:00:00.000Z'),
        ];
        render(<ParentDiaryPage />);
        await riga('versione corretta');
        expect(screen.getByText('08:30')).toBeTruthy();
        expect(screen.queryByText(/versione vecchia/)).toBeNull();
    });
});
