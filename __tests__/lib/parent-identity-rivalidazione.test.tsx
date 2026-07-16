import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// Mock next/navigation controllabile per-test (come use-session-identity.test).
// Serve perché use-parent-identity importa useSearchParams e, a catena,
// useSessionIdentity (useRouter/usePathname). Riferimenti STABILI per non
// mandare in loop gli effect che li hanno nelle deps.
const mockReplace = vi.fn();
const mockRouter = { replace: mockReplace, refresh: vi.fn() };
let mockSearch = new URLSearchParams();
let mockPathname = '/parent/mensa';

vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => mockSearch,
  usePathname: () => mockPathname,
}));

import {
  useParentIdentity,
  rivalidaFiglio,
  decidiFiglioRivalidato,
  fetchFigliIds,
} from '@/lib/auth/use-parent-identity';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mockSearch = new URLSearchParams();
  mockPathname = '/parent/mensa';
  vi.stubGlobal('fetch', fetchMock);
});

function studentsOk(ids: string[]) {
  return { ok: true, json: async () => ({ success: true, data: ids.map((id) => ({ id })) }) };
}

describe('decidiFiglioRivalidato (decisione pura)', () => {
  it('(a) noto NON tra i figli → primo figlio + segnala aggiorna e rimuovi cache', () => {
    const r = decidiFiglioRivalidato('stantio', ['A', 'B']);
    expect(r).toEqual({ studentId: 'A', aggiornaCache: true, rimuoviCache: true });
  });

  it('(b) noto valido (tra i figli) → resta, nessun tocco alla cache', () => {
    const r = decidiFiglioRivalidato('B', ['A', 'B']);
    expect(r).toEqual({ studentId: 'B', aggiornaCache: false, rimuoviCache: false });
  });

  it('(c) lista non determinabile (null = fetch fallita) → degrada al noto, cache intatta', () => {
    const r = decidiFiglioRivalidato('qualcosa', null);
    expect(r).toEqual({ studentId: 'qualcosa', aggiornaCache: false, rimuoviCache: false });
  });

  it('(d) nessun noto → primo figlio, aggiorna cache (comportamento storico)', () => {
    const r = decidiFiglioRivalidato(null, ['A', 'B']);
    expect(r).toEqual({ studentId: 'A', aggiornaCache: true, rimuoviCache: false });
  });

  it('noto stantio ma genitore SENZA figli → studentId null, cache rimossa', () => {
    const r = decidiFiglioRivalidato('stantio', []);
    expect(r).toEqual({ studentId: null, aggiornaCache: false, rimuoviCache: true });
  });
});

describe('rivalidaFiglio (mock fetch)', () => {
  it('(a) noto NON tra i figli → primo figlio + aggiorna cache', async () => {
    fetchMock.mockResolvedValueOnce(studentsOk(['A', 'B']));
    const r = await rivalidaFiglio('stantio', 'P1');
    expect(r).toEqual({ studentId: 'A', aggiornaCache: true, rimuoviCache: true });
  });

  it('(b) noto valido → resta', async () => {
    fetchMock.mockResolvedValueOnce(studentsOk(['A', 'B']));
    const r = await rivalidaFiglio('A', 'P1');
    expect(r.studentId).toBe('A');
    expect(r.rimuoviCache).toBe(false);
  });

  it('(c) fetch fallita (rete) → degrada al noto', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const r = await rivalidaFiglio('stantio', 'P1');
    expect(r).toEqual({ studentId: 'stantio', aggiornaCache: false, rimuoviCache: false });
  });

  it('(c2) endpoint 4xx/5xx (non-ok) → degrada al noto', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    const r = await rivalidaFiglio('stantio', 'P1');
    expect(r).toEqual({ studentId: 'stantio', aggiornaCache: false, rimuoviCache: false });
  });

  it('(d) nessun noto → primo figlio', async () => {
    fetchMock.mockResolvedValueOnce(studentsOk(['A']));
    const r = await rivalidaFiglio(null, 'P1');
    expect(r).toEqual({ studentId: 'A', aggiornaCache: true, rimuoviCache: false });
  });

  it('senza parentId non si rivalida → degrada al noto (nessuna fetch)', async () => {
    const r = await rivalidaFiglio('noto', null);
    expect(r).toEqual({ studentId: 'noto', aggiornaCache: false, rimuoviCache: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passa x-user-id e userId al backend', async () => {
    fetchMock.mockResolvedValueOnce(studentsOk(['A']));
    await rivalidaFiglio(null, 'P1');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/parent/students?userId=P1',
      expect.objectContaining({ headers: { 'x-user-id': 'P1' } }),
    );
  });
});

describe('fetchFigliIds (mock fetch)', () => {
  it('estrae gli id degli alunni dalla risposta', async () => {
    fetchMock.mockResolvedValueOnce(studentsOk(['A', 'B']));
    expect(await fetchFigliIds('P1')).toEqual(['A', 'B']);
  });
  it('rete giù → null (non determinabile)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    expect(await fetchFigliIds('P1')).toBeNull();
  });
  it('non-ok → null', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({}) });
    expect(await fetchFigliIds('P1')).toBeNull();
  });
});

describe('useParentIdentity — rivalidazione al mount (self-heal cache stantia)', () => {
  it('cache stantia (alunno altrui/inesistente) → passa al primo figlio e riscrive la cache', async () => {
    window.localStorage.setItem('kv_user_id', 'P1');
    window.localStorage.setItem('kv_student_id', 'stantio');
    fetchMock.mockResolvedValue(studentsOk(['A', 'B']));

    const { result } = renderHook(() => useParentIdentity());
    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(result.current.studentId).toBe('A');
    expect(window.localStorage.getItem('kv_student_id')).toBe('A');
  });

  it('cache valida → resta invariata', async () => {
    window.localStorage.setItem('kv_user_id', 'P1');
    window.localStorage.setItem('kv_student_id', 'A');
    fetchMock.mockResolvedValue(studentsOk(['A', 'B']));

    const { result } = renderHook(() => useParentIdentity());
    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(result.current.studentId).toBe('A');
    expect(window.localStorage.getItem('kv_student_id')).toBe('A');
  });

  it('nessuna cache → primo figlio (comportamento storico invariato)', async () => {
    window.localStorage.setItem('kv_user_id', 'P1');
    fetchMock.mockResolvedValue(studentsOk(['A', 'B']));

    const { result } = renderHook(() => useParentIdentity());
    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(result.current.studentId).toBe('A');
    expect(window.localStorage.getItem('kv_student_id')).toBe('A');
  });

  it('rete giù → degrada al noto senza cancellare la cache', async () => {
    window.localStorage.setItem('kv_user_id', 'P1');
    window.localStorage.setItem('kv_student_id', 'noto');
    fetchMock.mockRejectedValue(new Error('offline'));

    const { result } = renderHook(() => useParentIdentity());
    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(result.current.studentId).toBe('noto');
    expect(window.localStorage.getItem('kv_student_id')).toBe('noto');
  });

  it('una sola fetch a /api/parent/students per mount (nessun loop)', async () => {
    window.localStorage.setItem('kv_user_id', 'P1');
    window.localStorage.setItem('kv_student_id', 'A');
    fetchMock.mockResolvedValue(studentsOk(['A', 'B']));

    const { result } = renderHook(() => useParentIdentity());
    await waitFor(() => expect(result.current.ready).toBe(true));

    const chiamateStudents = fetchMock.mock.calls.filter(
      ([url]) => typeof url === 'string' && url.includes('/api/parent/students'),
    );
    expect(chiamateStudents).toHaveLength(1);
  });
});
