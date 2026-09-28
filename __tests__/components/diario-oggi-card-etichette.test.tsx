import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import itEtichette from '../../messages/it/etichette.json';

/**
 * LA CARD «OGGI A SCUOLA» CHIAMA OGNI VOCE COL SUO NOME (2026-09-28).
 *
 * Stampava il codice del tipo, maiuscolato a mano (`titleCase`): «Nanna inizio», «Attivita» senza
 * accento — e da oggi avrebbe stampato «Routine:a1b2c3d4» per ogni routine aggiunta dalla scuola.
 * Ora passa dalla stessa etichetta della pagina del diario, e per le routine della scuola dal nome
 * salvato nella voce.
 */

vi.mock('@/lib/push/native-register', () => ({ isNativeApp: () => false }));
vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Errore' }));

import { DiaryTodayCard } from '@/components/features/parent/home/DiaryTodayCard';

const ora = new Date().toISOString();
let voci: unknown[] = [];

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => voci })));
});

describe('card «Oggi a scuola» — le etichette', () => {
    it('i tipi base col loro nome, la routine della scuola col suo', async () => {
        voci = [
            { id: 'e1', tipo_evento: 'nanna_inizio', timestamp_evento: ora, dettagli: { orario_inizio: '12:30' }, note: null },
            { id: 'e2', tipo_evento: 'attivita', timestamp_evento: ora, dettagli: { activities: [{ tipo: 'pittura', descrizione: 'acquerelli' }] }, note: null },
            { id: 'e3', tipo_evento: 'routine:a1b2c3d4', timestamp_evento: ora, dettagli: { nome: 'Crema solare', emoji: '🧴', risposta: 'spunta', valore: true }, note: null },
        ];
        render(<DiaryTodayCard studentId="a1" href="/parent/diary" />);

        expect(await screen.findByText(itEtichette.evento_nanna_inizio)).toBeInTheDocument();
        expect(screen.getByText(itEtichette.evento_attivita)).toBeInTheDocument();
        expect(screen.getByText('Crema solare')).toBeInTheDocument();
        expect(screen.queryByText(/Nanna inizio|Attivita\b|Routine:/)).not.toBeInTheDocument();
    });
});

describe('card «Oggi a scuola» — seconda revisione critica (2026-09-28)', () => {
    it('una voce tenuta in piedi dalla sola nota del BAMBINO c\'è, con la sua nota', async () => {
        voci = [{ id: 'e1', tipo_evento: 'routine:a1b2c3d4', timestamp_evento: ora, dettagli: { nome: 'Crema solare', emoji: '🧴', risposta: 'spunta', valore: null }, note: null, notaBambino: 'Non ha voluto la crema' }];
        render(<DiaryTodayCard studentId="a1" href="/parent/diary" />);
        expect(await screen.findByText('Crema solare')).toBeInTheDocument();
        expect(screen.getByText('Non ha voluto la crema')).toBeInTheDocument();
    });

    it('per una routine a orario, l\'ora è quella SEGNATA', async () => {
        const quindici = new Date(); quindici.setHours(15, 47, 0, 0);
        voci = [{ id: 'e1', tipo_evento: 'routine:b0b0b0b0', timestamp_evento: quindici.toISOString(), dettagli: { nome: 'Latte', emoji: '🥛', risposta: 'orario', valore: '10:30' }, note: null }];
        render(<DiaryTodayCard studentId="a1" href="/parent/diary" />);
        expect(await screen.findByText('Latte')).toBeInTheDocument();
        expect(screen.getByText('10:30')).toBeInTheDocument();
    });
});
