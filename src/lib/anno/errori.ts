import { NextResponse } from 'next/server'
import it from '../../../messages/it/shared.json'
import { CODICI_ERRORE } from '@/lib/ui/esito-fetch'
import { logErrore, logEvento } from '@/lib/logging/logger'

/**
 * `erroreAnno` — L'UNICO POSTO in cui i codici d'errore dei trigger dell'anno scolastico
 * (`ANNO_CHIUSO`, `SEZIONE_DI_ALTRO_ANNO`…) diventano risposte HTTP.
 *
 * Il database solleva l'eccezione con il codice come MESSAGGIO (`RAISE EXCEPTION 'ANNO_CHIUSO'`),
 * PostgREST la rende `{ code: 'P0001', message: 'ANNO_CHIUSO' }` (o col `code` della `ERRCODE`
 * scelta: `CALENDARIO_NON_CONTINUO` arriva come `23514`). Qui si legge il MESSAGGIO, non il
 * `code`: `P0001` è «qualunque eccezione di una funzione» e `23514` «qualunque CHECK».
 *
 * Restituisce `null` per ciò che non è dell'anno (un doppione, un permesso negato, un errore
 * sconosciuto): la route lo tratta come prima, con il suo `logErrore`. Un codice sconosciuto
 * non diventa MAI un 200.
 *
 * I codici sono LETTERALI in un `switch`, uno per uno: il lock `errori-con-codice` legge solo
 * ciò che trova scritto nel sorgente, e un `codice: variabile` lo renderebbe cieco. Ogni
 * codice è dichiarato in `CODICI_ERRORE` e tradotto nei due cataloghi.
 *
 * `error` è la prosa del catalogo ITALIANO (la stessa stringa che vede l'utente italiano,
 * come in `rifiutoSede`): rivolta alla segreteria, mai tecnica. Nessun dato della riga che
 * ha fatto scattare il trigger esce nella risposta o nel log (il `DETAIL` contiene uuid).
 *
 * Log: `ANNO_CHIUSO` e `PASSAGGIO_DA_FARE` sono un rifiuto atteso ma da vedere (una scrittura
 * su un anno protetto): `warn` con le sole chiavi `tipo`, `codice`, `operazione`.
 * `GIORNO_SENZA_ANNO` è un guasto di configurazione (nessun anno copre il giorno): `logErrore`.
 */
const CATALOGO_IT = it as Record<string, string>

function frase(codice: keyof typeof CODICI_ERRORE): string {
  return CATALOGO_IT[CODICI_ERRORE[codice]]
}

/** Il messaggio è il codice stesso, eventualmente seguito da altro testo. */
function codiceDa(error: { code?: string; message?: string } | null | undefined): string | null {
  const m = typeof error?.message === 'string' ? /^\s*([A-Z][A-Z0-9_]+)\b/.exec(error.message) : null
  return m ? m[1] : null
}

function avvisaRifiuto(codice: string, operazione: string | undefined): void {
  const campi: Record<string, string> = { tipo: 'anno-protetto', codice }
  if (operazione) campi.operazione = operazione
  logEvento('anno-scolastico', 'warn', campi)
}

export function erroreAnno(
  error: { code?: string; message?: string } | null | undefined,
  operazione?: string,
): NextResponse | null {
  switch (codiceDa(error)) {
    case 'ANNO_CHIUSO':
      avvisaRifiuto('ANNO_CHIUSO', operazione)
      return NextResponse.json({ error: frase('ANNO_CHIUSO'), codice: 'ANNO_CHIUSO' }, { status: 409 })
    case 'PASSAGGIO_DA_FARE':
      avvisaRifiuto('PASSAGGIO_DA_FARE', operazione)
      return NextResponse.json(
        { error: frase('PASSAGGIO_DA_FARE'), codice: 'PASSAGGIO_DA_FARE' },
        { status: 409 },
      )
    case 'CONFINE_CON_RIGHE':
      return NextResponse.json(
        { error: frase('CONFINE_CON_RIGHE'), codice: 'CONFINE_CON_RIGHE' },
        { status: 409 },
      )
    case 'SEZIONE_DI_ALTRO_ANNO':
      return NextResponse.json(
        { error: frase('SEZIONE_DI_ALTRO_ANNO'), codice: 'SEZIONE_DI_ALTRO_ANNO' },
        { status: 422 },
      )
    case 'SEZIONE_DI_ALTRA_SEDE':
      return NextResponse.json(
        { error: frase('SEZIONE_DI_ALTRA_SEDE'), codice: 'SEZIONE_DI_ALTRA_SEDE' },
        { status: 422 },
      )
    case 'ANNO_NON_COERENTE':
      return NextResponse.json(
        { error: frase('ANNO_NON_COERENTE'), codice: 'ANNO_NON_COERENTE' },
        { status: 422 },
      )
    case 'MODULO_NON_RICHIESTO':
      return NextResponse.json(
        { error: frase('MODULO_NON_RICHIESTO'), codice: 'MODULO_NON_RICHIESTO' },
        { status: 422 },
      )
    case 'CONFINE_NON_VALIDO':
      return NextResponse.json(
        { error: frase('CONFINE_NON_VALIDO'), codice: 'CONFINE_NON_VALIDO' },
        { status: 422 },
      )
    case 'CALENDARIO_NON_CONTINUO':
      return NextResponse.json(
        { error: frase('CALENDARIO_NON_CONTINUO'), codice: 'CALENDARIO_NON_CONTINUO' },
        { status: 422 },
      )
    case 'ANNO_DA_SPECIFICARE':
      return NextResponse.json(
        { error: frase('ANNO_DA_SPECIFICARE'), codice: 'ANNO_DA_SPECIFICARE' },
        { status: 400 },
      )
    case 'ANNO_NON_DELLA_SEDE':
      return NextResponse.json(
        { error: frase('ANNO_NON_DELLA_SEDE'), codice: 'ANNO_NON_DELLA_SEDE' },
        { status: 400 },
      )
    case 'GIORNO_SENZA_ANNO':
      // Nessun anno copre il giorno: non è un errore di chi scrive, è la configurazione della
      // sede. Il messaggio dell'eccezione è solo il codice: niente da redigere nel log.
      logErrore(
        { operazione: operazione ?? 'anno-scolastico', stato: 500 },
        new Error('GIORNO_SENZA_ANNO'),
      )
      return NextResponse.json(
        { error: frase('GIORNO_SENZA_ANNO'), codice: 'GIORNO_SENZA_ANNO' },
        { status: 500 },
      )
    default:
      return null
  }
}

/**
 * Codici che SOLO una migrazione o il riempimento sollevano: non arrivano mai a una route,
 * quindi `erroreAnno` non li traduce. Un codice nuovo nelle migrazioni dell'anno deve stare
 * in `erroreAnno` o qui: lo pretende `__tests__/lib/anno-errori.test.ts`.
 * A destra la migrazione da cui viene.
 */
export const CODICI_INTERNI = [
  'COPIA_ANNO_NON_VALIDA', // 20261107012110_anno_strumenti.sql
  'FASE_NON_VALIDA', // 20261107012110_anno_strumenti.sql
  'RIEMPIMENTO_A_CONTROLLI_RIGIDI', // 20261107012110_anno_strumenti.sql
  'RIEMPIMENTO_A_GUARDIA_ATTIVA', // 20261107012110_anno_strumenti.sql
  'RIEMPIMENTO_GALLERIA_SOPPRIMI', // 20261107012110_anno_strumenti.sql
  'RIEMPIMENTO_SENZA_SCHEMA_ANNO', // 20261107012110_anno_strumenti.sql
  'TABELLA_NON_NEL_RIEMPIMENTO', // 20261107012110_anno_strumenti.sql
  'ANNO_RIEMPIMENTO_INCOMPLETO', // 20261107023257_anno_vincoli_2.sql
] as const
