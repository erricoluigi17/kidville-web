/**
 * Fascicolo di primaria — i nomi dei file che arrivano SUL DISPOSITIVO quando si
 * apre un documento o si salva una pagella (spec 2026-09-24, compito F3).
 *
 * Mai il nome caricato né il nome dell'alunno: nel fascicolo di un minore il nome
 * del file può contenere nome e cognome («PEI_<cognome>.pdf»), e nell'app il file
 * resta nella Cache e passa dal foglio «Salva su File». Solo il tipo del documento
 * e frammenti di uuid.
 */

/**
 * COPIA di `ESTENSIONE_PER_MIME_FASCICOLO` (`src/lib/primaria/fascicolo-gestione.ts`):
 * quel modulo importa `next/server` e il logger del server, che in un componente
 * client non devono entrare (lo stesso motivo di `fascicolo-ui.ts`). Il test
 * `__tests__/pages/teacher-primaria-fascicolo-scarico.test.tsx` la confronta con
 * quella del server: se divergono, diventa rosso.
 */
export const ESTENSIONE_PER_MIME_FASCICOLO_CLIENT: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * Il mime dall'estensione: la mappa del server INVERTITA, più `jpeg` per i percorsi
 * storici, che prima di F1 portavano l'estensione del nome caricato. Nient'altro:
 * un tipo che il caricamento non ammette non si apre nell'anteprima.
 */
export const MIME_PER_ESTENSIONE_FASCICOLO: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    Object.entries(ESTENSIONE_PER_MIME_FASCICOLO_CLIENT).map(([mime, ext]) => [ext, mime]),
  ),
  jpeg: 'image/jpeg',
};

function mimeDaEstensione(ext: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(MIME_PER_ESTENSIONE_FASCICOLO, ext)
    ? MIME_PER_ESTENSIONE_FASCICOLO[ext]
    : undefined;
}

/** L'estensione (minuscola) dell'ultimo segmento di un percorso, o `''`. */
function estensioneDi(segmento: string): string {
  const punto = segmento.lastIndexOf('.');
  return punto >= 0 ? segmento.slice(punto + 1).toLowerCase() : '';
}

/**
 * Il mime dall'indirizzo FIRMATO: l'ultimo segmento del percorso, prima di `?`/`#`.
 * Dopo F1 il percorso nel bucket prende l'estensione dal MIME già validato
 * (`percorsoNuovoFascicolo`), mai dal nome: è la fonte affidabile.
 */
function mimeDaIndirizzo(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const percorso = url.split(/[?#]/, 1)[0];
  const segmento = percorso.slice(percorso.lastIndexOf('/') + 1);
  return mimeDaEstensione(estensioneDi(segmento));
}

const TIPO_RX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Nome (senza estensione) e mime di un documento del fascicolo da aprire.
 *
 * Il mime serve all'anteprima di sistema nell'app (senza estensione iOS non sa che
 * file sia; l'estensione la mette l'helper dal mime). Viene PRIMA dall'indirizzo
 * firmato; il nome caricato è solo il ripiego per le righe vecchie, perché è testo
 * libero («1000012345» da un provider Android, «Relazione dott.ssa …» senza
 * estensione). Nessun tipo riconosciuto → nessun mime: il file arriva comunque, al
 * più nel foglio di condivisione invece che nell'anteprima.
 */
export function fileDocumentoFascicolo(
  doc: { id: string; document_type: string },
  urlFirmato: string | null | undefined,
  nomeCaricato: string | null | undefined,
): { nomeFile: string; mime?: string } {
  const mime = mimeDaIndirizzo(urlFirmato) ?? mimeDaEstensione(estensioneDi(nomeCaricato ?? ''));
  const tipo = doc.document_type.length <= 40 && TIPO_RX.test(doc.document_type) ? doc.document_type : 'documento';
  const nomeFile = `fascicolo-${tipo}-${doc.id.slice(0, 8)}`;
  return mime ? { nomeFile, mime } : { nomeFile };
}

/**
 * Il nome della pagella: cambia con alunno E scrutinio, perché l'helper scrive in
 * Cache con quel nome e due pagelle in volo non devono sovrascriversi a vicenda.
 */
export function nomeFilePagellaFascicolo(alunnoId: string, scrutinioId: string): string {
  return `pagella-${alunnoId.slice(0, 8)}-${scrutinioId.slice(0, 8)}.pdf`;
}
