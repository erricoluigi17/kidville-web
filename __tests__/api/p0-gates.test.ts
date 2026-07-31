import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextResponse, NextRequest } from 'next/server';

// Un singolo mock del modulo auth pilota sia i gate docente sia quelli staff.
vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: vi.fn(),
  requireStaff: vi.fn(),
}));

import { requireDocente, requireStaff } from '@/lib/auth/require-staff';
import * as grades from '@/app/api/grades/route';
import * as notes from '@/app/api/notes/route';
import * as attDaily from '@/app/api/attendance/daily/route';
import * as attMonthly from '@/app/api/attendance/monthly/route';
import * as gallery from '@/app/api/gallery/route';
import * as galleryUpload from '@/app/api/gallery/upload/route';
// `seed-db` e `admin/seed-full` sono state CANCELLATE il 2026-07-31 (audit
// multi-sede): cablavano l'uuid di una sede e `.env.local` punta al database di
// produzione, quindi in `npm run dev` un POST avrebbe creato una scuola vera. Il
// sigillo `sealDangerous` protegge però altre 15 route ancora vive: la sua prova
// resta, spostata su `debug-supabase`.
import * as debugSupabase from '@/app/api/debug-supabase/route';

const denied = () =>
  ({ response: NextResponse.json({ error: 'denied' }, { status: 403 }) }) as never;

// NextRequest: alcune di queste route leggono ora il cookie `sedi_attive` per
// filtrare per sede. Qui il gate nega comunque prima, ma il TIPO deve reggere.
function req() {
  return new NextRequest('http://localhost', { method: 'POST', body: '{}' });
}

describe('P0/S3 — gate wiring sugli endpoint docente', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireDocente).mockResolvedValue(denied());
  });

  const cases: Array<[string, () => Promise<Response>]> = [
    ['grades GET', () => grades.GET(req())],
    ['grades POST', () => grades.POST(req())],
    ['notes GET', () => notes.GET(req())],
    ['notes POST', () => notes.POST(req())],
    ['attendance/daily GET', () => attDaily.GET(req() as never)],
    ['attendance/daily POST', () => attDaily.POST(req() as never)],
    ['attendance/monthly GET', () => attMonthly.GET(req() as never)],
    ['gallery POST', () => gallery.POST(req())],
    ['gallery upload POST', () => galleryUpload.POST(req())],
  ];

  for (const [name, call] of cases) {
    it(`${name}: 403 quando il gate nega (e il gate viene invocato)`, async () => {
      const res = await call();
      expect(res.status).toBe(403);
      expect(requireDocente).toHaveBeenCalled();
    });
  }
});

describe('P0/S3 — seal endpoint pericolosi (debug-supabase)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('debug-supabase è riservato ad admin (403 per non-admin)', async () => {
    vi.mocked(requireStaff).mockResolvedValue(denied());
    const res = await debugSupabase.GET(new Request('http://localhost'));
    expect(res.status).toBe(403);
    expect(requireStaff).toHaveBeenCalledWith(expect.anything(), ['admin']);
  });

  it('debug-supabase restituisce 404 in produzione (prima di ogni gate)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const res = await debugSupabase.GET(new Request('http://localhost'));
    expect(res.status).toBe(404);
  });
});
