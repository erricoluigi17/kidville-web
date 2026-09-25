'use client'

import { fileConsegnato, scaricaDocumento } from '@/lib/native/scarica'

/**
 * GLI EXPORT DELLE COMPILAZIONI — PDF di una, XLSX di una o di molte.
 *
 * Prima erano quattro copie di `<a download href="/api/forms/export/…">` cliccata a mano
 * (tre in `SubmissionsTable`, due in `SubmissionDetailSidebar`). Nell'app nativa quel gesto
 * non fa NIENTE e non lancia: la WebView non ha un gestore di download, e il bottone della
 * Segreteria sembrava rotto senza lasciare traccia.
 *
 * Ora passano tutti da `scaricaDocumento` (`src/lib/native/scarica.ts`):
 *  - nell'app 1.1 il file va in Cache e si apre il foglio «Salva su File»;
 *  - sul web la route si legge con `fetch` (stessa origine, coi cookie) e si scarica con
 *    l'ancora su un `blob:` — lo stesso file di prima, ma un 401/500 non diventa più un
 *    «compilazione.pdf» che contiene un errore JSON;
 *  - sul binario 1.0 l'helper NON condivide il link (è relativo): l'esito è «non riuscito»
 *    e chi chiama lo dice a schermo.
 *
 * Il log dell'esito, successo compreso, lo scrive l'helper: qui non si rilogga. Nel log non
 * entra né l'indirizzo né il nome del file, solo l'etichetta.
 *
 * Ritorna `true` solo se il file è arrivato davvero (`fileConsegnato`).
 */

const MIME_PDF = 'application/pdf'
const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export async function scaricaCompilazionePdf(id: string): Promise<boolean> {
  const esito = await scaricaDocumento({
    sorgente: `/api/forms/export/pdf?id=${encodeURIComponent(id)}`,
    nomeFile: `compilazione-${id.slice(0, 8)}.pdf`,
    mime: MIME_PDF,
    etichetta: 'modulo-compilazione-pdf',
  })
  return fileConsegnato(esito)
}

/**
 * Un XLSX con le compilazioni indicate. Con un id solo il nome dice quale; con più id è
 * l'export massivo della tabella filtrata.
 */
export async function scaricaCompilazioniXlsx(ids: readonly string[]): Promise<boolean> {
  const nomeFile = ids.length === 1 ? `compilazione-${ids[0].slice(0, 8)}.xlsx` : 'compilazioni.xlsx'
  const esito = await scaricaDocumento({
    // Le virgole restano tali: la route divide `ids` su `,` (vedi `/api/forms/export/xlsx`).
    sorgente: `/api/forms/export/xlsx?ids=${ids.map(encodeURIComponent).join(',')}`,
    nomeFile,
    mime: MIME_XLSX,
    etichetta: ids.length === 1 ? 'modulo-compilazione-xlsx' : 'modulo-compilazioni-xlsx',
  })
  return fileConsegnato(esito)
}
