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

// La SEDE su cui gira la campagna: dall'ambiente, mai cablata. Fino al 2026-07-31
// qui c'era l'uuid di Kidville Giugliano; dal 2026-07-29 i plessi di produzione
// sono tre e una campagna che scrive nel plesso sbagliato non se ne accorge.
// Stessa regola della password: manca ⇒ si fallisce subito. Vedi
// e2e/lib/scuola-collaudo.mjs (la variante .mjs usata dagli script di seed).
function requireScuolaCollaudo(): string {
  const valore = (process.env.KV_SCUOLA_ID || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(valore)) {
    throw new Error(
      "Manca (o non è un uuid) la variabile d'ambiente KV_SCUOLA_ID: è la sede su cui gira la " +
        'campagna 360°. Le sedi di produzione sono TRE — prendi l\'uuid da `select id, nome from ' +
        "scuole` ed esportalo prima di rilanciare:  export KV_SCUOLA_ID='…'",
    );
  }
  return valore;
}

export const PASSWORD = requireTestPassword();
export const SECTION_1A = 'bb4e9f8a-c737-4d41-8634-02f8f8e48601';
export const SCUOLA_COLLAUDO = requireScuolaCollaudo();

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
