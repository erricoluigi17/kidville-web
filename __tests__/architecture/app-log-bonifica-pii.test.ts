import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// LOCK · le righe di log già scritte con PII in chiaro vanno bonificate
//
// LA MISURA (produzione, 2026-08-01). In `public.app_log` ci sono NOVE righe con
// dati personali in chiaro dentro `contesto -> payload`: sette `iscrizione warn`
// fra il 29 e il 31 luglio, e due del 13 luglio (`db error`, `route error`). Il
// contenuto è il CORPO GREZZO della domanda d'iscrizione — `parseBody` deposita
// il raw PRIMA di zod — e dentro ci sono la data di nascita del bambino, e in
// alcune righe nome, cognome e codice fiscale.
//
// LA CORREZIONE DEL CODICE È GIÀ STATA FATTA (`RADICI_NASCITA` in
// `src/lib/logging/redact.ts`, stesso giorno) e funziona: verificata sul server.
// Ma correggere il codice non tocca ciò che è già scritto. Le righe restano lì
// fino alla purge dei 30 giorni — cioè fino al 30 agosto per le più recenti —
// interrogabili in SQL da chiunque abbia accesso al database.
//
// COSA PRETENDE QUESTO LOCK. Che nel repo esista la migrazione di bonifica, e
// che faccia le tre cose giuste:
//   1. TOGLIE IL CONTENUTO, NON LA RIGA — come `audit_docente_retention_tick`:
//      quando, quale route, quali campi non erano validi restano; il corpo no.
//      Una riga cancellata è una riga che non dice più nemmeno che è successo.
//   2. NON CANCELLA NIENTE da `app_log`: nessun DELETE.
//   3. È RIESEGUIBILE senza effetti: la condizione esclude ciò che ha già
//      bonificato, altrimenti il lavoro periodico riscriverebbe ogni volta le
//      stesse righe.
//
// PERCHÉ UN LOCK TESTUALE. La migrazione NON è applicata da chi l'ha scritta —
// in produzione ci sono dati reali di minori e ogni migrazione si fa approvare —
// e il gate gira offline. Qui si verifica che il rimedio esista nel repo e abbia
// la forma giusta; l'esecuzione la controlla chi la applica, con i conteggi che
// la funzione stessa scrive in `app_log`.
// ─────────────────────────────────────────────────────────────────────────────

const RADICE = process.cwd()
const MIGRAZIONI = join(RADICE, 'supabase', 'migrations')

const file = readdirSync(MIGRAZIONI).filter((f) => /bonifica.*app_log|app_log.*bonifica/i.test(f))
const sql = file.map((f) => readFileSync(join(MIGRAZIONI, f), 'utf8')).join('\n')
/** Lo stesso testo senza i commenti: le prove non devono passare per una frase. */
const codice = sql.replace(/--[^\n]*/g, ' ')

describe('lock architettura · la bonifica delle righe di log con PII', () => {
  it('la migrazione di bonifica esiste nel repo', () => {
    expect(
      file,
      'Nessuna migrazione di bonifica di `app_log`. La correzione della redazione ' +
        'vale da qui in avanti: le 9 righe già scritte il 13, 29, 30 e 31 luglio 2026 ' +
        'restano con la data di nascita di un bambino in chiaro finché la purge dei 30 ' +
        'giorni non ci arriva.',
    ).not.toEqual([])
  })

  it('toglie il ramo `payload` dal contesto, lasciando la riga', () => {
    expect(
      /update\s+public\.app_log/i.test(codice),
      'La bonifica deve essere un UPDATE su `public.app_log`.',
    ).toBe(true)
    expect(
      /contesto\s*-\s*'payload'/i.test(codice),
      'Il ramo da togliere è `payload` (il corpo grezzo della richiesta, depositato ' +
        'da `parseBody` prima di zod). Gli altri rami del contesto — `campi`, `esito`, ' +
        '`operazione` — sono diagnostica senza dati personali e devono restare.',
    ).toBe(true)
  })

  it('NON cancella righe di app_log', () => {
    expect(
      /delete\s+from\s+public\.app_log/i.test(codice),
      'Una riga cancellata non dice più nemmeno che quel giorno una domanda è stata ' +
        'respinta. Si toglie il contenuto, non la riga (art. 5 §2 GDPR: il registro ' +
        'degli eventi serve anche a dimostrare che cosa è successo).',
    ).toBe(false)
  })

  it('è rieseguibile: la condizione esclude ciò che è già stato bonificato', () => {
    expect(
      /where[\s\S]*payload/i.test(codice),
      'Senza una condizione che escluda le righe già bonificate, ogni esecuzione ' +
        'riscriverebbe le stesse righe a vuoto.',
    ).toBe(true)
  })

  it('lascia un conteggio in app_log, come gli altri lavori di bonifica', () => {
    expect(
      /insert\s+into\s+public\.app_log/i.test(codice),
      'Un lavoro che tocca dati di famiglie deve dire anche quando non tocca niente: ' +
        '«nessuna riga» non può voler dire insieme «tutto a posto» e «non è mai partito».',
    ).toBe(true)
  })

  it('viene eseguita subito, non solo schedulata', () => {
    expect(
      /select\s+public\.app_log_bonifica_pii_tick\(\)/i.test(codice),
      'La migrazione deve ESEGUIRE la bonifica all\'applicazione: le 9 righe in ' +
        'produzione non possono aspettare il primo giro del lavoro periodico.',
    ).toBe(true)
  })

  it('la funzione non è eseguibile da `anon` e `authenticated` (SECURITY DEFINER)', () => {
    // Stessa regola delle altre funzioni SECURITY DEFINER del repo: senza la
    // REVOKE esplicita, PostgREST la esporrebbe come RPC a chiunque abbia una
    // sessione — e questa funzione riscrive il registro degli eventi.
    expect(/security\s+definer/i.test(codice)).toBe(true)
    expect(
      /revoke\s+all\s+on\s+function\s+public\.app_log_bonifica_pii_tick[\s\S]{0,120}anon/i.test(codice),
      'Manca la REVOKE su `anon, authenticated`.',
    ).toBe(true)
  })
})
