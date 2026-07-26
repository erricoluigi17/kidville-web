import path from 'node:path';

// Costanti del test 360° Primaria (prod, sezione TEST 1A).
export const BASE_URL = process.env.KV360_BASE || 'http://localhost:3000';

// Password comune degli account TEST: MAI nel repo (sono account attivi in produzione,
// e il repository è stato pubblico). Si passa dall'ambiente; se manca si fallisce subito,
// altrimenti il difetto riemerge più tardi come un misterioso login rifiutato.
// Vedi e2e/lib/test-password.mjs.
function requireTestPassword(): string {
  const valore = (process.env.KV_TEST_PASSWORD || '').trim();
  if (!valore) {
    throw new Error(
      "Manca la variabile d'ambiente KV_TEST_PASSWORD (password comune degli account TEST " +
        'test.*@kidville.test, non scritta nel repo). Prendila dal gestore di credenziali del ' +
        "titolare ed esportala prima di rilanciare:  export KV_TEST_PASSWORD='…'",
    );
  }
  return valore;
}

export const PASSWORD = requireTestPassword();
export const SECTION_1A = 'bb4e9f8a-c737-4d41-8634-02f8f8e48601';
export const SCUOLA_GIUGLIANO = 'd53b0fbc-a9eb-4073-b302-73d1d5abd529';

// Prefisso identificativo su ogni dato testuale scritto (audit/cleanup).
export const TAG = '[E2E360]';

export type Area = 'admin' | 'teacher' | 'parent';

export interface Account {
  key: string;
  email: string;
  area: Area;
  landing: RegExp;
  label: string;
  /** Per i genitori: numero alunno collegato (1..10). */
  studentN?: number;
  /** Per i genitori: relazione con l'alunno. */
  relation?: 'mother' | 'father';
}

export const SEGRETERIA: Account = {
  key: 'segreteria',
  email: 'test.pri.segreteria@kidville.test',
  area: 'admin',
  landing: /\/admin/,
  label: 'Segreteria',
};

export const DOCENTI: Account[] = Array.from({ length: 5 }, (_, i) => ({
  key: `docente${i + 1}`,
  email: `test.pri.docente${i + 1}@kidville.test`,
  area: 'teacher' as Area,
  landing: /\/teacher/,
  label: `Docente ${i + 1}`,
}));

// 10 alunni × { madre, padre } = 20 personas genitore.
// Madri = account esistenti test.pri.genitore{n}; Padri = nuovi test.pri.genitore{n}p (seed).
const MADRI: Account[] = Array.from({ length: 10 }, (_, i) => ({
  key: `genitore${i + 1}`,
  email: `test.pri.genitore${i + 1}@kidville.test`,
  area: 'parent' as Area,
  landing: /\/parent/,
  label: `Madre A${i + 1}`,
  studentN: i + 1,
  relation: 'mother' as const,
}));
const PADRI: Account[] = Array.from({ length: 10 }, (_, i) => ({
  key: `genitore${i + 1}p`,
  email: `test.pri.genitore${i + 1}p@kidville.test`,
  area: 'parent' as Area,
  landing: /\/parent/,
  label: `Padre A${i + 1}`,
  studentN: i + 1,
  relation: 'father' as const,
}));
export const GENITORI: Account[] = [...MADRI, ...PADRI];

export const ALL_ACCOUNTS: Account[] = [SEGRETERIA, ...DOCENTI, ...GENITORI];

export const AUTH_DIR = path.join(__dirname, '..', '.auth');
export const RUN_DIR = path.join(__dirname, '..', 'run');
export const SHOTS_DIR = path.join(RUN_DIR, 'screenshots');
export const FINDINGS_DIR = path.join(RUN_DIR, 'findings');

export const storagePath = (key: string) => path.join(AUTH_DIR, `${key}.json`);
export const idsPath = path.join(AUTH_DIR, 'app-ids.json');
