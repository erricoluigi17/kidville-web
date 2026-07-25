import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import sharedIt from '../../messages/it/shared.json';
import sharedEn from '../../messages/en/shared.json';
import { ScattaFotoButton } from '@/components/features/native/ScattaFotoButton';
import { fotocameraNativaDisponibile } from '@/lib/native/camera';

/**
 * Cinque host passavano `label="Scatta foto"` cablato in italiano mentre
 * l'`aria-label` dello STESSO bottone era tradotto: è precisamente il modo in
 * cui due etichette dello stesso elemento divergono. Ora il testo visibile viene
 * dalla stessa chiave dell'aria-label, e questi test lo difendono.
 */

vi.mock('@/lib/native/camera', () => ({
    fotocameraNativaDisponibile: vi.fn(),
    scegliFotoNativa: vi.fn(async () => []),
}));
const mockDisponibile = vi.mocked(fotocameraNativaDisponibile);

const RADICE = process.cwd();

/** Gli host che avevano il testo cablato. */
const HOST = [
    'src/app/(dashboard)/teacher/primaria/[sectionId]/registro/page.tsx',
    'src/app/(dashboard)/teacher/primaria/[sectionId]/fascicolo/page.tsx',
    'src/components/features/avvisi/AvvisoForm.tsx',
    'src/components/features/admin/pagamenti/CassaMovimentoModal.tsx',
    'src/components/features/teacher/tasks/TaskCard.tsx',
];

beforeEach(() => {
    vi.clearAllMocks();
    mockDisponibile.mockReturnValue(true);
});
afterEach(() => cleanup());

describe('i18n — «Scatta foto»', () => {
    it('nessun host cabla più il testo in italiano', () => {
        // Lock sul SORGENTE e non solo sul render: montare `fascicolo/page.tsx` o
        // `registro/page.tsx` richiederebbe una catena di fetch al mount, e un
        // test fragile smette presto di essere eseguito.
        for (const rel of HOST) {
            const codice = fs.readFileSync(path.join(RADICE, rel), 'utf8');
            expect(codice, `${rel} cabla ancora il testo`).not.toContain('label="Scatta foto"');
        }
    });

    it('senza `label` il bottone mostra il testo TRADOTTO', () => {
        // Il mock di next-intl risolve sui testi italiani reali: se la chiave
        // sparisse, qui comparirebbe la stringa "shared.scattaFoto".
        render(<ScattaFotoButton onFile={() => {}} />);
        expect(screen.getByText('Scatta foto')).toBeInTheDocument();
    });

    it('con `soloIcona` resta solo l’icona, ma l’aria-label c’è', () => {
        // È il caso della barra della chat, dove non c'è spazio per il testo.
        render(<ScattaFotoButton onFile={() => {}} soloIcona />);
        expect(screen.queryByText('Scatta foto')).toBeNull();
        expect(screen.getByLabelText('Scatta foto')).toBeInTheDocument();
    });

    it('una `label` esplicita vince ancora sul default', () => {
        render(<ScattaFotoButton onFile={() => {}} label="Fotografa il documento" />);
        expect(screen.getByText('Fotografa il documento')).toBeInTheDocument();
    });

    it('su web non rende nulla: l’input di sempre resta l’unico trigger', () => {
        mockDisponibile.mockReturnValue(false);
        const { container } = render(<ScattaFotoButton onFile={() => {}} />);
        expect(container.firstChild).toBeNull();
    });
});

describe('i18n — etichette del foglio nativo', () => {
    const CHIAVI = ['cameraTitolo', 'cameraScatta', 'cameraLibreria', 'cameraAnnulla'] as const;

    it('esistono in italiano e in inglese', () => {
        for (const k of CHIAVI) {
            expect(sharedIt, `manca in IT: ${k}`).toHaveProperty(k);
            expect(sharedEn, `manca in EN: ${k}`).toHaveProperty(k);
        }
    });

    it('le rese inglesi non sono un copia-incolla dell’italiano', () => {
        for (const k of ['cameraTitolo', 'cameraScatta', 'cameraLibreria'] as const) {
            expect(sharedEn[k]).not.toBe(sharedIt[k]);
        }
    });

    it('esistono anche le stringhe del prompt biometrico', () => {
        // Erano cablate in italiano dentro `biometric.ts`, che è una lib e non
        // può tradurre da sé: ora arrivano come parametro da questi cataloghi.
        for (const k of ['bioAnnulla', 'bioTitoloAndroid', 'bioSottotitoloAndroid', 'bioFallbackIos'] as const) {
            expect(sharedIt).toHaveProperty(k);
            expect(sharedEn).toHaveProperty(k);
        }
    });
});
