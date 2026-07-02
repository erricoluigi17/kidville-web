import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextResponse } from 'next/server';

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
import * as seedDb from '@/app/api/seed-db/route';

const denied = () =>
  ({ response: NextResponse.json({ error: 'denied' }, { status: 403 }) }) as never;

function req() {
  return new Request('http://localhost', { method: 'POST', body: '{}' });
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

describe('P0/S3 — seal endpoint pericolosi (seed-db)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('seed-db è riservato ad admin (403 per non-admin)', async () => {
    vi.mocked(requireStaff).mockResolvedValue(denied());
    const res = await seedDb.GET(new Request('http://localhost'));
    expect(res.status).toBe(403);
    expect(requireStaff).toHaveBeenCalledWith(expect.anything(), ['admin']);
  });

  it('seed-db restituisce 404 in produzione (prima di ogni gate)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const res = await seedDb.POST(new Request('http://localhost'));
    expect(res.status).toBe(404);
  });
});
