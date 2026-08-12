import { describe, it, expect } from 'vitest'
import {
  estensioneArchiviata,
  MIME_ALLEGATO_PUBBLICO,
  ESTENSIONI_ALLEGATO_PUBBLICO,
} from '@/lib/upload/allegati-pubblici'

// =============================================================================
// L'ESTENSIONE CON CUI UN ALLEGATO PUBBLICO RESTA NEL BUCKET.
//
// La decide il TIPO dichiarato — già normalizzato e verificato da
// `verificaAllegatoPubblico` — e mai il nome del file: qui il nome si chiama
// «carta-identita-<cognome>.pdf», cioè il cognome di una persona, e non deve
// sopravvivere alla richiesta.
//
// Fino al 12/08/2026 questa mappa viveva dentro `iscrizione/personale/upload/route.ts`.
// La rotta di caricamento del pannello admin (fronte e retro) ne ha bisogno identica: due
// mappe per lo stesso bucket sono due mappe che divergono, e il giorno in cui divergono
// lo stesso formato finisce archiviato in due modi.
// =============================================================================

describe('estensioneArchiviata — un tipo, un’estensione canonica', () => {
  it('OGNI tipo ammesso ha la sua estensione: nessun buco nella mappa', () => {
    // Il controllo che serve davvero il giorno in cui `MIME_ALLEGATO_PUBBLICO`
    // guadagna un sesto tipo: senza, quel tipo passerebbe il gate e poi non sarebbe
    // archiviabile — cioè un caricamento valido respinto DOPO, con un 500, su una
    // porta pubblica dove non c'è nessuno a cui chiedere.
    for (const mime of MIME_ALLEGATO_PUBBLICO) {
      expect(estensioneArchiviata(mime), `il tipo «${mime}» non ha un’estensione`).toBeTruthy()
    }
  })

  it('l’estensione prodotta è una di quelle che il gate riAMMETTE', () => {
    // Il cerchio si chiude qui: il percorso archiviato viene poi RILETTO come stringa
    // dai gate di forma (`@/lib/personale/percorso-documento`), che confrontano
    // l'estensione con `ESTENSIONI_ALLEGATO_PUBBLICO`. Se questa mappa producesse
    // un'estensione FUORI da quell'elenco, il file sarebbe caricato per davvero e POI
    // il modulo rifiuterebbe il percorso del proprio allegato.
    //
    // ⚠️ QUI C'ERA SCRITTO UN ESEMPIO CHE QUESTO TEST NON PUÒ COGLIERE, e va detto
    // invece di lasciarlo credere: «se producesse `jpeg` dove l'elenco ammette solo
    // `jpg`». Misurato cambiando `'image/jpeg': 'jpg'` in `'jpeg'` — questo test
    // resta VERDE, perché `ESTENSIONI_ALLEGATO_PUBBLICO` contiene sia `jpg` sia
    // `jpeg` (si accetta come si trova ciò che l'utente ha già sul telefono). A
    // diventare rossi sono tre test in tre file: quello sotto (`image/jpeg` diventa
    // `jpg`), `anagrafica-personale-upload` e `anagrafica-personale-scansione`.
    //
    // Cosa misura DAVVERO questa prova, allora: che nessun tipo ammesso produca
    // un'estensione fuori elenco — la chiusura dell'insieme, non la canonicalizzazione.
    // Serve il giorno in cui `MIME_ALLEGATO_PUBBLICO` guadagna un tipo e qualcuno
    // mappa `image/avif` su `avif` senza aggiungerlo alle estensioni ammesse. La
    // canonicalizzazione `jpeg` → `jpg` la tiene ferma il test qui sotto, che nomina
    // le cinque coppie una per una: sono due invarianti diverse e servono entrambe.
    for (const mime of MIME_ALLEGATO_PUBBLICO) {
      expect(
        (ESTENSIONI_ALLEGATO_PUBBLICO as readonly string[]).includes(estensioneArchiviata(mime) ?? ''),
        `«${mime}» viene archiviato come «${estensioneArchiviata(mime)}», che il gate non ammette`,
      ).toBe(true)
    }
  })

  it('`image/jpeg` diventa `jpg`, non `jpeg`: un formato, un modo di scriverlo', () => {
    expect(estensioneArchiviata('image/jpeg')).toBe('jpg')
    expect(estensioneArchiviata('application/pdf')).toBe('pdf')
    expect(estensioneArchiviata('image/png')).toBe('png')
    expect(estensioneArchiviata('image/webp')).toBe('webp')
    expect(estensioneArchiviata('image/heic')).toBe('heic')
  })

  it('un tipo SCONOSCIUTO non inventa un’estensione: torna `undefined`', () => {
    // FAIL-CLOSED, ed è il motivo per cui il valore di ritorno è opzionale invece di
    // `string`: un `?? 'bin'` silenzioso avrebbe archiviato un file valido con
    // un'estensione che nessun visualizzatore riconosce, e il difetto si sarebbe visto
    // solo aprendo la scheda di una persona. Il tipo opzionale COSTRINGE il chiamante
    // a scrivere il ramo di rifiuto.
    expect(estensioneArchiviata('application/zip')).toBeUndefined()
    expect(estensioneArchiviata('application/octet-stream')).toBeUndefined()
    expect(estensioneArchiviata('')).toBeUndefined()
    expect(estensioneArchiviata('IMAGE/JPEG'), 'il tipo arriva già normalizzato dal gate').toBeUndefined()
  })
})
