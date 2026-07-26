// ID reali di produzione (sede Kidville Giugliano) usati dalla campagna
// «collaudo-giornata». Solo dati TEST. Fonte: query prod 2026-07-17 +
// e2e/primaria-360/config/data.ts.
import { requireTestPassword } from '../../lib/test-password.mjs';

export const PROD_BASE = 'https://app.kidville.it';
export const SCUOLA_GIUGLIANO = 'd53b0fbc-a9eb-4073-b302-73d1d5abd529';
export const SECTION_1A = 'bb4e9f8a-c737-4d41-8634-02f8f8e48601'; // primaria
export const SECTION_INFANZIA = '219cab6a-2bf3-48d6-a443-b7aecda40f42';

// Tag su ogni dato testuale scritto dalla campagna (audit + cleanup).
export const TAG = '[E2E-GIORNATA]';

// Password comune degli account TEST (login via auth.users, invariato). NON è nel repo:
// arriva dalla variabile d'ambiente KV_TEST_PASSWORD — vedi e2e/lib/test-password.mjs.
export const PASSWORD = requireTestPassword();

// Casella reale (Gmail, sub-addressing +tag) su cui instradare gli OTP/credenziali
// dei firmatari, leggibile via MCP kidville-mail. Si aggiorna SOLO utenti.email
// (non auth.users.email → login invariato); ripristinata nel cleanup.
export const OTP_INBOX = (tag) => `lerrico7+${tag}@gmail.com`;

// Alunno1..10 Test PRI (sezione TEST 1A).
export const ALUNNI_1A = {
  1: 'b5ed40dc-9195-45bc-bbb7-59e4ffb478f6',
  2: '85995f7f-75bc-433e-9f09-d4c04d88d48c',
  3: 'aaacb836-8d02-422d-88cb-ea99cf8e3c56',
  4: 'cb0d83cf-00d1-4dcc-91b0-85668fe392d6',
  5: '52380841-daaa-4ae3-876c-91954839390e',
  6: 'fcb67036-8846-463f-ba44-744d3183f324',
  7: 'cb4a3305-48a2-4107-8b40-998e776f93b9',
  8: 'b54c8ce9-a77e-4434-8689-db3ccb0b3746',
  9: 'cca20211-fefc-44df-8929-d5c44452c656',
  10: '2f2e5ab6-3c1c-476c-8490-f7582249b391',
};

// Alunno1..10 Test INF (sezione TEST Infanzia).
export const ALUNNI_INF = {
  1: '6cdce65b-c2de-4e2a-b805-1e10a24845fa',
  2: 'e10b9da4-5abd-4b81-b365-9457c99bcd92',
  3: 'f14b961b-f3d8-4ee1-805f-d4100a6ae2ae',
  4: '2d282f76-e8c8-4c04-97be-dc492c79d8fd',
  5: '0708bd83-f2e8-4b9b-9541-7fc7ef99d2b0',
  6: 'd0e6fc30-911d-46ec-a22e-6b6439ac105e',
  7: 'dca5488d-946f-48a7-94a1-a81358d98a07',
  8: 'f4c61ece-b8fd-421d-ac11-72ee5f389bfb',
  9: '39d9df05-b673-4e16-8d74-75f91a8de261',
  10: 'cf249c09-f56f-40a7-bcd8-1e1b1db916ab',
};

// Materie TEST 1A (fonte primaria-360/config/data.ts).
export const MATERIE = {
  italiano: 'c730f585-9d45-43d7-93a2-73e3c7202b8e',
  matematica: 'fbd38536-c5e1-4547-acab-e27fc2d1da76',
  inglese: '458f4be9-374e-4a56-8665-e13f8ae517d9',
  arte: '4d58e45b-dd4d-4313-b7da-74a18cdb5d00',
  religione: '46acaa02-f077-4f6f-8f3d-62990e4bae17',
};

// Materia principale per docente primaria (indice 1-based).
export const DOCENTE_MATERIA = {
  1: { nome: 'Italiano', id: MATERIE.italiano },
  2: { nome: 'Matematica', id: MATERIE.matematica },
  3: { nome: 'Inglese', id: MATERIE.inglese },
  4: { nome: 'Arte e Immagine', id: MATERIE.arte },
  5: { nome: 'Religione/Alternativa', id: MATERIE.religione },
};

// Modulo firmabile "Autorizzazione gita" (FEA/OTP) — id fisso allineato al seed
// primaria-360 (già in prod).
export const FORM_MODEL_GITA = 'fea60000-0000-4000-8000-000000000001';

// Legami da seedare per gli scenari familiari complessi (INSERT idempotenti in
// legame_genitori_alunni; nel cleanup si rimuovono quelli tag [E2E-GIORNATA]).
export const SEED_LEGAMI = {
  // G-MULTI: genitore2 (già → Alunno2 PRI) acquisisce un 2° figlio (Alunno3 PRI).
  multiFiglio: { genitoreEmail: 'test.pri.genitore2@kidville.test', alunnoId: ALUNNI_1A[3] },
  // G-MIX: genitore10 primaria (già → Alunno10 PRI) acquisisce un figlio infanzia (Alunno10 INF).
  infanziaPrimaria: { genitoreEmail: 'test.pri.genitore10@kidville.test', alunnoId: ALUNNI_INF[10] },
};
