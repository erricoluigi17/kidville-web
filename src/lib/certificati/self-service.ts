// Certificati self-service (genitore) — testi puri e testabili, nessun valore
// cablato: sezione dall'anagrafica alunno, anno da annoScolasticoCorrente(),
// dati sede dalla scuola del figlio (scuole + config.anagrafica) con degrado
// esplicito (righe/clausole omesse) se un dato manca. Mai valori inventati.

export interface AlunnoCertificato {
  nome: string
  cognome: string
  classe_sezione?: string | null
}

export interface SedeCertificato {
  scuola_nome?: string | null
  scuola_indirizzo?: string | null
  scuola_cap?: string | null
  scuola_citta?: string | null
  scuola_provincia?: string | null
  scuola_codice_meccanografico?: string | null
}

export function buildCertificatoBody(
  type: 'iscrizione' | 'frequenza',
  s: AlunnoCertificato,
  anno: string
): string {
  if (type === 'iscrizione') {
    return `Si certifica che l'alunno/a ${s.cognome} ${s.nome} risulta regolarmente iscritto/a presso questa istituzione scolastica per l'anno scolastico ${anno}.`
  }
  // Clausola sezione solo se disponibile; "nella sezione X" (non "dei X":
  // con nomi tipo "TEST 1A" il partitivo è sgrammaticato).
  const sezione = s.classe_sezione?.trim()
  const clausolaSezione = sezione ? ` nella sezione ${sezione}` : ''
  return `Si certifica che l'alunno/a ${s.cognome} ${s.nome} frequenta regolarmente le attività didattiche di questa scuola${clausolaSezione} per l'anno scolastico ${anno}.`
}

// Righe di intestazione sede per il PDF (multi-sede): solo dati reali dal DB,
// righe omesse se mancanti.
export function buildIntestazioneSede(sede: SedeCertificato): string[] {
  const righe: string[] = []
  const nome = sede.scuola_nome?.trim()
  if (nome) righe.push(nome)
  const capCitta = [sede.scuola_cap?.trim(), sede.scuola_citta?.trim()].filter(Boolean).join(' ')
  const provincia = sede.scuola_provincia?.trim()
  const luogo = [
    sede.scuola_indirizzo?.trim(),
    [capCitta, provincia ? `(${provincia})` : ''].filter(Boolean).join(' '),
  ].filter(Boolean).join(' — ')
  if (luogo) righe.push(luogo)
  const mecc = sede.scuola_codice_meccanografico?.trim()
  if (mecc) righe.push(`Cod. Mecc. ${mecc}`)
  return righe
}

// "<Città>, lì <data>" oppure "Lì <data>" se la città non è in DB.
export function rigaLuogoData(citta: string | null | undefined, dataIt: string): string {
  const c = citta?.trim()
  return c ? `${c}, lì ${dataIt}` : `Lì ${dataIt}`
}
