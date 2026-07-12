/**
 * Documenti su richiesta (decisione #22 dello spec): testi puri per
 * certificato di frequenza/iscrizione (riuso dei builder self-service),
 * nulla osta e testo libero su carta intestata. Il PDF viene composto dalla
 * route genera-documento e protocollato in uscita. Testato in
 * __tests__/lib/protocolli-documenti.test.ts.
 */

import { buildCertificatoBody, type AlunnoCertificato } from '@/lib/certificati/self-service'

export type TipoDocumentoRichiesta = 'frequenza' | 'iscrizione' | 'nulla_osta' | 'libero'

const TITOLI: Record<Exclude<TipoDocumentoRichiesta, 'libero'>, string> = {
  frequenza: 'CERTIFICATO DI FREQUENZA',
  iscrizione: 'CERTIFICATO DI ISCRIZIONE',
  nulla_osta: 'NULLA OSTA AL TRASFERIMENTO',
}

const OGGETTI: Record<Exclude<TipoDocumentoRichiesta, 'libero'>, string> = {
  frequenza: 'Certificato di frequenza',
  iscrizione: 'Certificato di iscrizione',
  nulla_osta: 'Nulla osta al trasferimento',
}

export function buildDocumentoRichiesta(
  tipo: TipoDocumentoRichiesta,
  alunno: AlunnoCertificato,
  anno: string,
  extra?: { titolo?: string; corpo?: string }
): { titolo: string; corpo: string } {
  if (tipo === 'libero') {
    const titolo = extra?.titolo?.trim()
    const corpo = extra?.corpo?.trim()
    if (!titolo || !corpo) {
      throw new Error('Documento libero: titolo e corpo sono obbligatori')
    }
    return { titolo, corpo }
  }

  if (tipo === 'frequenza' || tipo === 'iscrizione') {
    return { titolo: TITOLI[tipo], corpo: buildCertificatoBody(tipo, alunno, anno) }
  }

  // Nulla osta: stessa disciplina di degrado dei certificati (clausola sezione
  // solo se reale, mai inventata).
  const sezione = alunno.classe_sezione?.trim()
  const clausolaSezione = sezione ? ` nella sezione ${sezione}` : ''
  const corpo =
    `Vista la richiesta presentata dalla famiglia, si concede il nulla osta al trasferimento ` +
    `dell'alunno/a ${alunno.cognome} ${alunno.nome}, iscritto/a presso questa istituzione scolastica` +
    `${clausolaSezione} per l'anno scolastico ${anno}, presso altro istituto.\n\n` +
    `Si rilascia il presente documento per gli usi consentiti dalla legge.`
  return { titolo: TITOLI.nulla_osta, corpo }
}

/** Oggetto della registrazione di protocollo in uscita. */
export function oggettoDocumento(
  tipo: TipoDocumentoRichiesta,
  alunno: AlunnoCertificato,
  extra?: { titolo?: string; corpo?: string }
): string {
  const prefisso = tipo === 'libero' ? (extra?.titolo?.trim() ?? 'Documento') : OGGETTI[tipo]
  return `${prefisso} — ${alunno.cognome} ${alunno.nome}`
}
