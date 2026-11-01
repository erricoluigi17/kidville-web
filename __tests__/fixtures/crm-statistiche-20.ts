import type { AppuntamentoRow, AzioneRow, BambinoRow, SchedaRow } from '@/lib/crm/tipi'
import { SEDE_A } from './sedi'

/**
 * CRM della segreteria · Compito 6.1 — il DATASET FINTO di 20 appuntamenti con i numeri calcolati a mano.
 *
 * Non c'è nessuna persona vera: «Segretaria 1/2/3» sono tre uuid inventati (`PERSONA_1/2/3`) e la riga
 * «AI» è l'assistente che prenota da solo. Periodo letto: gennaio 2026 (`dal` 2026-01-01, `al` 2026-01-31,
 * giorni civili di Roma), «adesso» = 2026-02-10 (quindi tutto il periodo è già passato).
 *
 * ── LE VENTI VISITE ─────────────────────────────────────────────────────────────────────────────
 *
 *  id   scheda  inizio (UTC)          stato           fissata da   svolta da   nel periodo?
 *  A01  s01     2026-01-05 10:00      svolto          P1           P1          sì
 *  A02  s02     2026-01-06 10:00      svolto          P1           P2          sì
 *  A03  s03     2026-01-07 10:00      svolto          P1           P2          sì
 *  A04  s04     2026-01-08 10:00      non_presentato  P1           —           sì
 *  A05  s05     2026-01-09 10:00      svolto          P2           P2          sì
 *  A06  s06     2026-01-12 10:00      svolto          P2           P3          sì
 *  A07  s07     2026-01-13 10:00      non_presentato  P2           —           sì
 *  A08  s08     2026-01-14 10:00      annullato       P2           —           NO: annullata
 *  A09  s09     2026-01-15 10:00      in_programma    P3           —           sì (solo «fissate»)
 *  A10  s10     2026-01-16 10:00      svolto          P3           P3          sì
 *  A11  s11     2026-01-19 10:00      svolto          AI           P1          sì
 *  A12  s12     2026-01-20 10:00      svolto          AI           P2          sì
 *  A13  s13     2026-01-21 10:00      non_presentato  AI           —           sì
 *  A14  s14     2026-01-22 10:00      svolto          P3           P1          sì
 *  A15  s01     2026-01-26 10:00      svolto          P1           P2          sì (seconda visita di s01)
 *  A16  s03     2026-01-27 10:00      annullato       P1           —           NO: annullata
 *  A17  s15     2025-12-30 10:00      svolto          P1           P1          NO: prima del periodo
 *  A18  s16     2026-02-02 10:00      svolto          P2           P2          NO: dopo il periodo
 *  A19  s17     2026-01-31 23:30      svolto          P3           P3          NO: a Roma è già l'1 febbraio
 *  A20  s18     2025-12-31 23:30      svolto          P1           P2          sì: a Roma è già il 1° gennaio
 *
 * ── TASSO DI PRESENTAZIONE, a chi ha FISSATO (annullate e fuori periodo escluse) ─────────────────
 *
 *  persona  svolte                 non presentate  in programma  fissate  svolte/(svolte+non pres.)
 *  P1       A01 A02 A03 A15 A20=5  A04=1           0             6        5/6
 *  P2       A05 A06=2              A07=1           0             3        2/3
 *  P3       A10 A14=2              —               A09=1         3        2/2 = 1
 *  AI       A11 A12=2              A13=1           0             3        2/3
 *  totale                          svolte 11       non pres. 3   fissate 15   11/14
 *
 * ── TASSO DI CHIUSURA, a chi ha SVOLTO (una persona sola per bambino) ────────────────────────────
 *
 *  Contano i bambini delle schede con almeno una visita SVOLTA nel periodo:
 *  s01 s02 s03 s05 s06 s10 s11 s12 s14 s18 = 14 bambini (s04 s07 s09 s13 non hanno visite svolte;
 *  s08 ha solo una visita annullata; s15 s16 s17 le hanno fuori periodo, anche se b15a e b17a sono
 *  iscritti). Ogni bambino va a chi ha svolto l'ULTIMA visita prima dell'iscrizione (se iscritto), o
 *  l'ultima fino a fine periodo (se non lo è):
 *
 *  bambino  scheda  esito                    ultima visita utile       va a
 *  b01a     s01     iscritto, domanda ok     A01 (A15 è dopo il 20/1)  P1
 *  b01b     s01     aperto                   A15                       P2   ← stessa scheda, altra persona
 *  b02a     s02     iscritto a mano          A02                       P2
 *  b03a     s03     perso                    A03 (A16 è annullata)     P2
 *  b03b     s03     perso                    A03                       P2
 *  b05a     s05     iscritto, domanda ok     A05                       P2
 *  b05b     s05     aperto                   A05                       P2
 *  b06a     s06     ci_pensa                 A06                       P3
 *  b10a     s10     iscritto, domanda ok     A10                       P3
 *  b11a     s11     iscritto, domanda respinta  A11                    P1   ← conta fra gli «a mano»
 *  b12a     s12     lista_attesa             A12                       P2
 *  b14a     s14     iscritto a mano          A14                       P1
 *  b14b     s14     ci_pensa                 A14                       P1
 *  b18a     s18     ci_pensa                 A20                       P2
 *
 *  persona  bambini visitati  iscritti verificati  iscritti a mano  tasso di chiusura
 *  P1       4 (01a 11a 14a 14b)   1 (01a)              2 (11a 14a)      3/4 = 0,75
 *  P2       8 (01b 02a 03a 03b 05a 05b 12a 18a)  1 (05a)  1 (02a)      2/8 = 0,25
 *  P3       2 (06a 10a)           1 (10a)              0                1/2 = 0,5
 *  AI       0                     0                    0                nullo (nessun bambino)
 *  totale   14                    3                    3                6/14
 *
 * ── FOLLOW-UP IN TEMPO, a chi è RESPONSABILE (scadute nel periodo, non cancellate) ───────────────
 *
 *  Z1 P1 scade 10/1, fatta lo stesso giorno 16:00 Roma     → in tempo
 *  Z2 P1 scade 12/1, fatta il 13/1                          → in ritardo
 *  Z3 P1 scade 15/1, mai fatta                              → in ritardo
 *  Z4 P2 scade 20/1, fatta lo stesso giorno alle 23:30 Roma → in tempo
 *  Z5 P2 scade 21/1, fatta il 20/1 (in anticipo)            → in tempo
 *  Z6 P2 scade 22/1, CANCELLATA                             → fuori
 *  Z7 P3 scade 27/1, fatta alle 00:30 di Roma del 28/1      → in ritardo (un'ora dopo la mezzanotte)
 *  Z8 P3 scade 20/2                                         → fuori: dopo il periodo (e dopo «adesso»)
 *  Z9 P1 scade 20/12/2025                                   → fuori: prima del periodo
 *  Z10 P3 scade 31/1 alle 23:30Z = 1/2 a Roma               → fuori: già febbraio
 *
 *  P1: 3 dovute, 1 in tempo → 1/3 · P2: 2 dovute, 2 in tempo → 1 · P3: 1 dovuta, 0 in tempo → 0 (zero,
 *  non «nullo») · AI: nessuna → nullo · totale 6 dovute, 3 in tempo → 0,5
 *
 * ── RITARDO CONTATTO → VISITA (scheda creata → prima visita svolta, in giorni civili di Roma) ─────
 *
 *  s01 3 · s02 4 · s03 11 · s05 0 · s06 10 · s10 2 · s11 0 · s12 10 · s14 2 · s18 12
 *  (s15 s16 s17: la prima visita è fuori periodo, non entrano)
 *  in ordine: 0 0 2 2 3 4 10 10 11 12 → dieci valori, mediana = (3 + 4) / 2 = 3,5
 */

export const PERSONA_1 = '10000000-0000-4000-8000-000000000001'
export const PERSONA_2 = '10000000-0000-4000-8000-000000000002'
export const PERSONA_3 = '10000000-0000-4000-8000-000000000003'

export const PERIODO_GENNAIO = { dal: '2026-01-01', al: '2026-01-31' } as const
export const ADESSO_DATASET = new Date('2026-02-10T12:00:00Z')

// ── I costruttori di righe, con tutti i campi della migrazione ────────────────────────────────────

let contatore = 0
const prossimoId = (prefisso: string) => `${prefisso}-${String(++contatore).padStart(4, '0')}`

export function scheda(id: string, creata_il: string): SchedaRow {
  return {
    id,
    scuola_id: SEDE_A,
    genitore_nome: null,
    telefono1: null,
    telefono2: null,
    email1: null,
    email2: null,
    telefoni_norm: [],
    email_norm: [],
    origine: 'telefonata',
    routine: null,
    paura: null,
    desiderio: null,
    domanda_da_associare: null,
    creato_da: null,
    creato_via: 'segreteria',
    creata_il,
    aggiornata_il: creata_il,
    anonimizzata_il: null,
  }
}

export function bambino(o: Partial<BambinoRow> & Pick<BambinoRow, 'scheda_id'>): BambinoRow {
  return {
    id: prossimoId('bambino'),
    scuola_id: SEDE_A,
    nome: null,
    data_nascita: null,
    anno_ingresso: 'non_indicato',
    esito: 'aperto',
    motivo_perdita: null,
    motivo_nota: null,
    esito_origine: null,
    esito_da: null,
    esito_il: null,
    domanda_id: null,
    domanda_figlio: null,
    domanda_collegata_il: null,
    nota_collegamento: null,
    da_verificare: false,
    quota_importo: null,
    quota_metodo: null,
    quota_anno: null,
    quota_stato: null,
    quota_blocco_motivo: null,
    quota_saldata_il: null,
    quota_segnata_da: null,
    quota_cassa_movimento_id: null,
    quota_pagamento_id: null,
    alunno_id: null,
    alunno_collegato_il: null,
    creata_il: '2025-12-01T10:00:00Z',
    aggiornata_il: '2025-12-01T10:00:00Z',
    ...o,
  }
}

export function appuntamento(
  o: Partial<AppuntamentoRow> & Pick<AppuntamentoRow, 'scheda_id' | 'inizio' | 'stato'>,
): AppuntamentoRow {
  const fine = new Date(Date.parse(o.inizio) + 45 * 60_000).toISOString()
  return {
    id: prossimoId('app'),
    scuola_id: SEDE_A,
    fine,
    durata_min: 45,
    assegnata_a: o.svolto_da ?? o.fissato_da ?? PERSONA_1,
    fissato_da: PERSONA_1,
    fissato_via: 'segreteria',
    svolto_da: null,
    segnato_da: null,
    segnato_il: null,
    creato_il: '2025-12-01T10:00:00Z',
    aggiornato_il: '2025-12-01T10:00:00Z',
    ...o,
  }
}

export function azione(
  o: Partial<AzioneRow> & Pick<AzioneRow, 'responsabile' | 'scadenza'>,
): AzioneRow {
  return {
    id: prossimoId('azione'),
    scuola_id: SEDE_A,
    scheda_id: 's01',
    tipo: 'follow_up_1',
    appuntamento_id: null,
    esito: null,
    fatta_da: null,
    fatta_il: null,
    cancellata_il: null,
    cancellata_da: null,
    creata_il: '2025-12-01T10:00:00Z',
    ...o,
  }
}

// ── Il dataset ────────────────────────────────────────────────────────────────────────────────────

const T = (giorno: string, ora = '10:00') => `${giorno}T${ora}:00Z`

export const SCHEDE_20: SchedaRow[] = [
  scheda('s01', T('2026-01-02')),
  scheda('s02', T('2026-01-02')),
  scheda('s03', T('2025-12-27')),
  scheda('s04', T('2026-01-02')),
  scheda('s05', T('2026-01-09', '08:00')),
  scheda('s06', T('2026-01-02')),
  scheda('s07', T('2026-01-02')),
  scheda('s08', T('2026-01-02')),
  scheda('s09', T('2026-01-02')),
  scheda('s10', T('2026-01-14')),
  scheda('s11', T('2026-01-19', '09:00')),
  scheda('s12', T('2026-01-10')),
  scheda('s13', T('2026-01-02')),
  scheda('s14', T('2026-01-20')),
  scheda('s15', T('2025-12-20')),
  scheda('s16', T('2026-01-20')),
  scheda('s17', T('2026-01-20')),
  scheda('s18', T('2025-12-20')),
]

/** Un domanda_id finto: serve solo a dire «c'è una domanda collegata». */
const DOMANDA = 'd0000000-0000-4000-8000-000000000001'

export const BAMBINI_20: BambinoRow[] = [
  bambino({ scheda_id: 's01', esito: 'iscritto', esito_il: T('2026-01-20', '12:00'), domanda_id: DOMANDA }), // b01a
  bambino({ scheda_id: 's01' }), // b01b
  bambino({ scheda_id: 's02', esito: 'iscritto', esito_il: T('2026-01-25', '12:00') }), // b02a (a mano)
  bambino({ scheda_id: 's03', esito: 'perso' }), // b03a
  bambino({ scheda_id: 's03', esito: 'perso' }), // b03b
  bambino({ scheda_id: 's04' }), // b04a
  bambino({ scheda_id: 's05', esito: 'iscritto', esito_il: T('2026-01-15', '12:00'), domanda_id: DOMANDA }), // b05a
  bambino({ scheda_id: 's05' }), // b05b
  bambino({ scheda_id: 's06', esito: 'ci_pensa' }), // b06a
  bambino({ scheda_id: 's07' }), // b07a
  bambino({ scheda_id: 's08' }), // b08a
  bambino({ scheda_id: 's09' }), // b09a
  bambino({ scheda_id: 's10', esito: 'iscritto', esito_il: T('2026-01-30', '12:00'), domanda_id: DOMANDA }), // b10a
  bambino({
    scheda_id: 's11',
    esito: 'iscritto',
    esito_il: T('2026-02-03', '12:00'),
    domanda_id: DOMANDA,
    da_verificare: true,
    nota_collegamento: 'domanda_respinta',
  }), // b11a (domanda respinta → a mano)
  bambino({ scheda_id: 's12', esito: 'lista_attesa' }), // b12a
  bambino({ scheda_id: 's13' }), // b13a
  bambino({ scheda_id: 's14', esito: 'iscritto', esito_il: T('2026-01-28', '12:00') }), // b14a (a mano)
  bambino({ scheda_id: 's14', esito: 'ci_pensa' }), // b14b
  bambino({ scheda_id: 's15', esito: 'iscritto', esito_il: T('2026-01-10', '12:00'), domanda_id: DOMANDA }), // b15a (fuori)
  bambino({ scheda_id: 's16' }), // b16a
  bambino({ scheda_id: 's17', esito: 'iscritto', esito_il: T('2026-02-05', '12:00'), domanda_id: DOMANDA }), // b17a (fuori)
  bambino({ scheda_id: 's18', esito: 'ci_pensa' }), // b18a
]

export const APPUNTAMENTI_20: AppuntamentoRow[] = [
  appuntamento({ scheda_id: 's01', inizio: T('2026-01-05'), stato: 'svolto', fissato_da: PERSONA_1, svolto_da: PERSONA_1 }), // A01
  appuntamento({ scheda_id: 's02', inizio: T('2026-01-06'), stato: 'svolto', fissato_da: PERSONA_1, svolto_da: PERSONA_2 }), // A02
  appuntamento({ scheda_id: 's03', inizio: T('2026-01-07'), stato: 'svolto', fissato_da: PERSONA_1, svolto_da: PERSONA_2 }), // A03
  appuntamento({ scheda_id: 's04', inizio: T('2026-01-08'), stato: 'non_presentato', fissato_da: PERSONA_1 }), // A04
  appuntamento({ scheda_id: 's05', inizio: T('2026-01-09'), stato: 'svolto', fissato_da: PERSONA_2, svolto_da: PERSONA_2 }), // A05
  appuntamento({ scheda_id: 's06', inizio: T('2026-01-12'), stato: 'svolto', fissato_da: PERSONA_2, svolto_da: PERSONA_3 }), // A06
  appuntamento({ scheda_id: 's07', inizio: T('2026-01-13'), stato: 'non_presentato', fissato_da: PERSONA_2 }), // A07
  appuntamento({ scheda_id: 's08', inizio: T('2026-01-14'), stato: 'annullato', fissato_da: PERSONA_2 }), // A08
  appuntamento({ scheda_id: 's09', inizio: T('2026-01-15'), stato: 'in_programma', fissato_da: PERSONA_3 }), // A09
  appuntamento({ scheda_id: 's10', inizio: T('2026-01-16'), stato: 'svolto', fissato_da: PERSONA_3, svolto_da: PERSONA_3 }), // A10
  appuntamento({ scheda_id: 's11', inizio: T('2026-01-19'), stato: 'svolto', fissato_da: null, fissato_via: 'ai', svolto_da: PERSONA_1 }), // A11
  appuntamento({ scheda_id: 's12', inizio: T('2026-01-20'), stato: 'svolto', fissato_da: null, fissato_via: 'ai', svolto_da: PERSONA_2 }), // A12
  appuntamento({ scheda_id: 's13', inizio: T('2026-01-21'), stato: 'non_presentato', fissato_da: null, fissato_via: 'ai' }), // A13
  appuntamento({ scheda_id: 's14', inizio: T('2026-01-22'), stato: 'svolto', fissato_da: PERSONA_3, svolto_da: PERSONA_1 }), // A14
  appuntamento({ scheda_id: 's01', inizio: T('2026-01-26'), stato: 'svolto', fissato_da: PERSONA_1, svolto_da: PERSONA_2 }), // A15
  appuntamento({ scheda_id: 's03', inizio: T('2026-01-27'), stato: 'annullato', fissato_da: PERSONA_1 }), // A16
  appuntamento({ scheda_id: 's15', inizio: T('2025-12-30'), stato: 'svolto', fissato_da: PERSONA_1, svolto_da: PERSONA_1 }), // A17
  appuntamento({ scheda_id: 's16', inizio: T('2026-02-02'), stato: 'svolto', fissato_da: PERSONA_2, svolto_da: PERSONA_2 }), // A18
  appuntamento({ scheda_id: 's17', inizio: T('2026-01-31', '23:30'), stato: 'svolto', fissato_da: PERSONA_3, svolto_da: PERSONA_3 }), // A19
  appuntamento({ scheda_id: 's18', inizio: T('2025-12-31', '23:30'), stato: 'svolto', fissato_da: PERSONA_1, svolto_da: PERSONA_2 }), // A20
]

export const AZIONI_20: AzioneRow[] = [
  azione({ responsabile: PERSONA_1, scadenza: T('2026-01-10', '09:30'), fatta_il: T('2026-01-10', '15:00') }), // Z1
  azione({ responsabile: PERSONA_1, scadenza: T('2026-01-12', '09:30'), fatta_il: T('2026-01-13', '09:00') }), // Z2
  azione({ responsabile: PERSONA_1, scadenza: T('2026-01-15', '09:30') }), // Z3
  azione({ responsabile: PERSONA_2, scadenza: T('2026-01-20', '09:30'), fatta_il: T('2026-01-20', '22:30') }), // Z4
  azione({ responsabile: PERSONA_2, scadenza: T('2026-01-21', '09:30'), fatta_il: T('2026-01-20', '10:00') }), // Z5
  azione({ responsabile: PERSONA_2, scadenza: T('2026-01-22', '09:30'), cancellata_il: T('2026-01-21', '10:00') }), // Z6
  azione({ responsabile: PERSONA_3, scadenza: T('2026-01-27', '09:30'), fatta_il: T('2026-01-27', '23:30') }), // Z7
  azione({ responsabile: PERSONA_3, scadenza: T('2026-02-20', '09:30') }), // Z8
  azione({ responsabile: PERSONA_1, scadenza: T('2025-12-20', '09:30') }), // Z9
  azione({ responsabile: PERSONA_3, scadenza: T('2026-01-31', '23:30') }), // Z10
]
