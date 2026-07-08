import { test, expect } from '@playwright/test';
import { storagePath } from '../config/accounts';
import { ALUNNI } from '../config/data';
import { Recorder, apiGet, apiPost, readAppIds, httpOk } from '../lib/harness';

// FASE 6 — Adversarial & scoping. Verifica empirica dei controlli di accesso:
// un genitore NON deve leggere/scrivere i dati di un alunno altrui; endpoint
// staff non raggiungibili da genitore; PII non esposta senza sessione.
//
// A differenza del recorder puro, qui il test FALLISCE (expect) se una qualunque
// violazione persiste: così il loop 30×/50× è significativo. I findings restano
// comunque salvati per il report 360.
test.describe('Adversarial & scoping cross-ruolo', () => {
  // Letture parent scoped per figlio: tutte /api/parent/primaria/{ep}?studentId=
  const PARENT_EP = ['valutazioni', 'note', 'assenze', 'pagella', 'orario'];

  test.describe('con sessione genitore1 (figlio Alunno1)', () => {
    test.use({ storageState: storagePath('genitore1') });

    test('IDOR: genitore legge/scrive dati di un alunno altrui', async ({ page }) => {
      const ids = readAppIds();
      const uid = ids['genitore1'];
      const mine = ALUNNI[1];
      const other = ALUNNI[2]; // figlio di un'ALTRA famiglia
      const rec = new Recorder('adversarial', 'Adversarial');
      const violations: string[] = [];

      // ── E1: letture primaria (proprio=ok, altrui deve dare 403) ──────────────
      for (const ep of PARENT_EP) {
        const mineRes = await apiGet(page, `/api/parent/primaria/${ep}?userId=${uid}&studentId=${mine}`);
        const otherRes = await apiGet(page, `/api/parent/primaria/${ep}?userId=${uid}&studentId=${other}`);
        const leak = httpOk(otherRes.status);
        if (leak) violations.push(`primaria/${ep} altrui=${otherRes.status}`);
        rec.add({
          flusso: 'Scoping parent · IDOR lettura',
          pagina: `/api/parent/primaria/${ep}`,
          step: `${ep}: figlio proprio vs altrui`,
          gravita: leak ? 'bloccante' : 'ok',
          categoria: 'funzionale',
          atteso: 'Accesso al figlio altrui negato (403)',
          osservato: `proprio(Alunno1)=${mineRes.status} · altrui(Alunno2)=${otherRes.status}${leak ? ' → DATI ALTRUI ESPOSTI (IDOR)' : ''}`,
        });
      }

      // ── E1 extra: letture con path/param diversi (presenze, competenze, mensa, locker) ──
      const extraReads: { pagina: string; url: (s: string) => string }[] = [
        { pagina: '/api/parent/presenze', url: (s) => `/api/parent/presenze?userId=${uid}&studentId=${s}` },
        { pagina: '/api/parent/competenze', url: (s) => `/api/parent/competenze?userId=${uid}&studentId=${s}` },
        { pagina: '/api/parent/mensa/allergie', url: (s) => `/api/parent/mensa/allergie?userId=${uid}&alunno_id=${s}` },
        { pagina: '/api/locker/inventory', url: (s) => `/api/locker/inventory?alunno_id=${s}&mode=stock` },
        { pagina: '/api/locker/requests', url: (s) => `/api/locker/requests?alunno_id=${s}` },
      ];
      for (const r of extraReads) {
        const mineRes = await apiGet(page, r.url(mine));
        const otherRes = await apiGet(page, r.url(other));
        const leak = httpOk(otherRes.status);
        if (leak) violations.push(`${r.pagina} altrui=${otherRes.status}`);
        rec.add({
          flusso: 'Scoping parent · IDOR lettura (extra)',
          pagina: r.pagina,
          step: 'figlio proprio vs altrui',
          gravita: leak ? 'bloccante' : 'ok',
          categoria: 'funzionale',
          atteso: 'Figlio altrui negato (403)',
          osservato: `proprio=${mineRes.status} · altrui=${otherRes.status}${leak ? ' → IDOR' : ''}`,
        });
      }

      // ── E2: SCRITTURE su figlio ALTRUI → devono dare 403. Nessuna scrittura sul
      //    proprio figlio (eviterebbe di inquinare i dati con assenze/firme finte). ──
      const writes: { pagina: string; body: Record<string, unknown> }[] = [
        { pagina: '/api/parent/giustifiche-didattiche', body: { studentId: other, data: '2026-01-01', motivo: 'adv' } },
        { pagina: '/api/parent/presenze/comunica-assenza', body: { studentId: other, data: '2026-01-01', motivo: 'adv' } },
        { pagina: '/api/parent/presenze/giustifica', body: { studentId: other, data: '2026-01-01', motivo: 'adv' } },
        { pagina: '/api/parent/primaria/pagella/firma', body: { scrutinioId: '00000000-0000-4000-8000-000000000000', studentId: other } },
      ];
      for (const w of writes) {
        const res = await apiPost(page, w.pagina, w.body);
        const leak = httpOk(res.status);
        if (leak) violations.push(`${w.pagina} scrittura altrui=${res.status}`);
        rec.add({
          flusso: 'Scoping parent · IDOR scrittura',
          pagina: `${w.pagina} (POST)`,
          step: 'scrittura su figlio altrui',
          gravita: leak ? 'bloccante' : (res.status === 403 ? 'ok' : 'minore'),
          categoria: 'funzionale',
          atteso: '403 (verifica legame genitore↔alunno)',
          osservato: `status=${res.status}${leak ? ' → SCRITTURA SU ALUNNO ALTRUI' : ''}`,
        });
      }

      // ── Cross-role: genitore prova una scrittura da DOCENTE/STAFF → deve fallire. ──
      const staffWrite = await apiPost(page, '/api/primaria/valutazioni', {
        alunno_id: mine, section_id: '', materia_id: '', giudizio_sintetico: 'O', tipo: 'orale',
      });
      if (httpOk(staffWrite.status)) violations.push(`primaria/valutazioni (docente) da genitore=${staffWrite.status}`);
      rec.add({
        flusso: 'Scoping cross-ruolo',
        pagina: '/api/primaria/valutazioni (POST)',
        step: 'Genitore tenta scrittura valutazione (endpoint docente)',
        gravita: staffWrite.status === 401 || staffWrite.status === 403 ? 'ok' : (httpOk(staffWrite.status) ? 'bloccante' : 'minore'),
        categoria: 'funzionale',
        atteso: '401/403 (gate requireDocente)',
        osservato: `status=${staffWrite.status}`,
      });

      rec.save();
      expect(violations, `Violazioni IDOR/scoping (genitore): ${violations.join(' | ')}`).toEqual([]);
    });
  });

  test.describe('senza sessione (anonimo)', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test('PII/auth-bypass: endpoint sensibili senza sessione', async ({ page }) => {
      const rec = new Recorder('adversarial-anon', 'Adversarial (anonimo)');
      const mine = ALUNNI[1];
      const violations: string[] = [];

      // 1. admin/students/[id] GET senza alcuna sessione né ruolo.
      const adminStudent = await apiGet(page, `/api/admin/students/${mine}`);
      const exposed = httpOk(adminStudent.status) && !!adminStudent.json && JSON.stringify(adminStudent.json).length > 50;
      if (exposed) violations.push(`admin/students/[id]=${adminStudent.status} (PII esposta)`);
      rec.add({
        flusso: 'PII senza auth',
        pagina: '/api/admin/students/[id] (GET)',
        step: 'Scheda alunno + genitori senza sessione',
        gravita: exposed ? 'bloccante' : 'ok',
        categoria: 'funzionale',
        atteso: '401/403 — nessuna PII',
        osservato: `status=${adminStudent.status}${exposed ? ' → PII ESPOSTA senza autenticazione' : ''}`,
      });

      // 2. parent/primaria/valutazioni con userId arbitrario e senza sessione.
      const forged = await apiGet(page, `/api/parent/primaria/valutazioni?userId=00000000-0000-4000-8000-000000000000&studentId=${mine}`);
      if (httpOk(forged.status)) violations.push(`valutazioni userId falso=${forged.status}`);
      rec.add({
        flusso: 'Auth bypass',
        pagina: '/api/parent/primaria/valutazioni',
        step: 'userId arbitrario, nessuna sessione',
        gravita: httpOk(forged.status) ? 'bloccante' : 'ok',
        categoria: 'funzionale',
        atteso: 'Bloccato senza sessione valida',
        osservato: `status=${forged.status}${httpOk(forged.status) ? ' → accesso con userId falso' : ''}`,
      });

      // 3. locker inventory/requests senza sessione (IDOR anonimo).
      for (const url of [`/api/locker/inventory?alunno_id=${mine}&mode=stock`, `/api/locker/requests?alunno_id=${mine}`]) {
        const res = await apiGet(page, url);
        if (httpOk(res.status)) violations.push(`${url.split('?')[0]}=${res.status}`);
        rec.add({
          flusso: 'Locker senza auth',
          pagina: url.split('?')[0],
          step: 'armadietto senza sessione',
          gravita: httpOk(res.status) ? 'bloccante' : 'ok',
          categoria: 'funzionale',
          atteso: '401/403 senza sessione',
          osservato: `status=${res.status}${httpOk(res.status) ? ' → IDOR anonimo' : ''}`,
        });
      }

      rec.save();
      expect(violations, `Violazioni PII/auth-bypass (anonimo): ${violations.join(' | ')}`).toEqual([]);
    });
  });
});
