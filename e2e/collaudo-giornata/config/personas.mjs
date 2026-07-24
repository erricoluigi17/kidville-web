// Cast della campagna «collaudo-giornata». Ogni persona = un agente LLM.
// Login via auth.users (email @kidville.test, password comune). I firmatari hanno
// `otpInbox` = casella reale (Gmail +tag) su cui il seed reindirizza utenti.email
// per leggere gli OTP via MCP kidville-mail.
//
// device: 'desktop' (Chrome MCP) | 'ios' (Maestro sim) | 'android' (Maestro AVD)
// seed: true → account/legame da creare o modificare in seed/seed-giornata.mjs

import { OTP_INBOX } from './data.mjs';

export const PERSONAS = [
  // ── Staff desktop ─────────────────────────────────────────────────────────
  { id: 'P-DIR', ruolo: 'Direzione', email: 'test.pri.segreteria@kidville.test',
    area: 'admin', device: 'desktop', competenza: 'esperta',
    scenario: 'coordinator = dirigenza ST!; assegna docenti↔sezioni; pubblica pagelle/scrutinio' },
  { id: 'P-SEGR', ruolo: 'Segreteria', email: 'test.segreteria@kidville.test',
    area: 'admin', device: 'desktop', competenza: 'esperta',
    scenario: 'sportello; import iscrizioni, pagamenti, avvisi, mensa; NEGATIVO: non chiude scrutinio' },
  { id: 'P-CUOCA', ruolo: 'Cuoca', email: 'test.cuoca@kidville.test', seed: true,
    area: 'admin', device: 'desktop', competenza: 'media',
    scenario: 'solo Report Cucina; fallback su P-SEGR se il seed cuoca non riesce' },

  // ── Docenti (mobile) ──────────────────────────────────────────────────────
  { id: 'T-INF', ruolo: 'Docente infanzia', email: 'test.inf.docente1@kidville.test',
    area: 'teacher', device: 'android', competenza: 'media',
    scenario: 'appello + diario 0-6 + galleria + locker (TEST Infanzia)' },
  { id: 'T-PRI', ruolo: 'Docente primaria', email: 'test.pri.docente1@kidville.test',
    area: 'teacher', device: 'ios', competenza: 'esperta',
    scenario: 'Italiano/coord.; registro + valutazioni + note + scrutinio (TEST 1A)' },
  { id: 'T-PRI2', ruolo: 'Docente primaria 2ª materia', email: 'test.pri.docente2@kidville.test',
    area: 'teacher', device: 'android', competenza: 'media',
    scenario: 'Matematica; valutazioni concorrenti (co-docenza)' },
  { id: 'T-MISTO', ruolo: 'Docente infanzia+primaria', email: 'test.misto.docente@kidville.test', seed: true,
    area: 'teacher', device: 'android', competenza: 'esperta',
    scenario: 'gradi=[infanzia,primaria]; GradeWorldSwitch' },

  // ── Genitori (mobile) ─────────────────────────────────────────────────────
  { id: 'G-INF', ruolo: 'Genitore infanzia', email: 'test.inf.genitore1@kidville.test',
    area: 'parent', device: 'ios', competenza: 'media', otpInbox: OTP_INBOX('ginf'),
    scenario: 'Alunno1 Test INF; legge diario/presenze/avvisi, firma moduli' },
  { id: 'G-PRI-M', ruolo: 'Genitore primaria (madre)', email: 'test.pri.genitore1@kidville.test',
    area: 'parent', device: 'android', competenza: 'media', otpInbox: OTP_INBOX('gprim'),
    scenario: 'Alunno1 Test PRI; firma gita/pagella/nota; multi-tutore con G-PRI-P' },
  { id: 'G-PRI-P', ruolo: 'Genitore primaria (padre)', email: 'test.pri.genitore1p@kidville.test',
    area: 'parent', device: 'ios', competenza: 'scarso', otpInbox: OTP_INBOX('gprip'),
    scenario: 'Alunno1 Test PRI; comunica assenza; utente medio scarso (errori §5)' },
  { id: 'G-MULTI', ruolo: 'Genitore multi-figlio', email: 'test.pri.genitore2@kidville.test', seed: true,
    area: 'parent', device: 'android', competenza: 'media', otpInbox: OTP_INBOX('gmulti'),
    scenario: 'Alunno2 + Alunno3 Test PRI (2° legame da seed); switch tra profili figlio' },
  { id: 'G-MIX', ruolo: 'Genitore infanzia+primaria', email: 'test.pri.genitore10@kidville.test', seed: true,
    area: 'parent', device: 'ios', competenza: 'media', otpInbox: OTP_INBOX('gmix'),
    scenario: 'Alunno10 Test PRI + Alunno10 Test INF (legame da seed); due cicli separati' },
  { id: 'G-SCARSO', ruolo: 'Genitore «utente scarso»', email: 'test.pri.genitore5@kidville.test',
    area: 'parent', device: 'android', competenza: 'molto scarso', otpInbox: OTP_INBOX('gscarso'),
    scenario: 'Alunno5 Test PRI; produce gli errori del §5 (campi vuoti, doppio invio, cutoff, IDOR)' },

  // ── Flussi speciali ───────────────────────────────────────────────────────
  { id: 'G-NUOVO', ruolo: 'Nuova famiglia (iscrizione)', email: OTP_INBOX('gnuovo'),
    area: 'public', device: 'desktop', competenza: 'media',
    scenario: 'compila /iscrizione (anonimo) → P-SEGR importa → riceve credenziali → 1° login+onboarding' },
  { id: 'X-DOPPIO', ruolo: 'Doppio profilo docente+genitore', email: 'test.doppio@kidville.test', seed: true,
    area: 'teacher', device: 'android', competenza: 'esperta',
    scenario: 'stesso auth_user con ruolo educator + genitore; ?scegli=1 + cookie kv-active-role' },
];

export const byId = (id) => PERSONAS.find((p) => p.id === id);
export const firmatari = () => PERSONAS.filter((p) => p.otpInbox);
export const daSeedare = () => PERSONAS.filter((p) => p.seed);
