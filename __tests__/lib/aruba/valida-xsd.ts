/**
 * Validazione di un XML FatturaPA contro lo SCHEMA UFFICIALE — solo per i test.
 *
 * ─── PERCHÉ ESISTE ─────────────────────────────────────────────────────────────
 * Fino a oggi `__tests__/lib/aruba/fatturapa-xml.test.ts` confrontava STRINGHE:
 * verificava che nell'XML ci fosse `<TipoDocumento>TD01</TipoDocumento>` e che
 * `ImportoTotaleDocumento` valesse `150.00`. Sono asserzioni utili, ma non dicono
 * niente su ciò che lo SdI controlla per primo: che gli elementi stiano nell'ORDINE
 * imposto da `xs:sequence`, che quelli obbligatori ci siano tutti, che i valori
 * rispettino i `pattern` e le enumerazioni. Un tracciato può contenere tutte le
 * stringhe giuste ed essere scartato lo stesso — con il codice `00102` e una PEC
 * di notifica, giorni dopo l'invio.
 *
 * Qui l'XML viene passato a `xmllint` (libxml2) compilato in WebAssembly, con lo
 * XSD scaricato da `fatturapa.gov.it`. Nessun binario di sistema, nessun `node-gyp`,
 * nessuna JVM: gira identico in locale e in CI.
 *
 * ─── PERCHÉ STA IN `__tests__/` E NON IN `src/` ────────────────────────────────
 * `xmllint-wasm` è una **devDependency** e si porta dietro 780 KB di `.wasm`. Se
 * questo modulo vivesse sotto `src/`, basterebbe un `import` distratto da una route
 * per infilare quel peso in una funzione serverless — e per far fallire il build
 * di produzione il giorno in cui qualcuno installasse senza devDependencies. Lo
 * schema, invece, sta in `src/lib/aruba/xsd/` accanto al generatore che vincola:
 * è un dato del dominio, non del collaudo.
 *
 * ─── LA RETE, CHE NON SI USA ───────────────────────────────────────────────────
 * Lo XSD ufficiale importa `xmldsig-core-schema.xsd` da un URL `http://www.w3.org/…`.
 * Lasciato com'è, xmllint proverebbe a risolverlo: nel WASM non c'è stack di rete,
 * quindi l'import fallirebbe, `ds:Signature` resterebbe irrisolto e lo schema non
 * compilerebbe affatto — cioè la validazione fallirebbe per un motivo che non ha
 * niente a che vedere con la fattura. La copia locale c'è, e la `schemaLocation`
 * viene riscritta IN MEMORIA: i due file su disco restano byte per byte quelli
 * pubblicati dall'Agenzia delle Entrate, e la loro impronta è verificata da un lock
 * in `fatturapa-xsd.test.ts`. Modificare il file scaricato sarebbe stato più comodo
 * e avrebbe tolto l'unica cosa che rende credibile il verdetto: la provenienza.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { validateXML } from 'xmllint-wasm'

/** Cartella degli XSD ufficiali committati (vedi il suo README.md per la provenienza). */
export const CARTELLA_XSD = fileURLToPath(new URL('../../../src/lib/aruba/xsd/', import.meta.url))

/** Schema «Fattura Ordinaria» v1.2.3 — vale sia per FPA12 sia per FPR12. */
export const NOME_SCHEMA_FATTURAPA = 'Schema_VFPR12_v1.2.3.xsd'

/** Schema della firma XML, importato dal precedente. */
export const NOME_XMLDSIG = 'xmldsig-core-schema.xsd'

/** L'URL remoto che lo XSD ufficiale usa come `schemaLocation` dell'import. */
const URL_XMLDSIG_REMOTA =
  'http://www.w3.org/TR/2002/REC-xmldsig-core-20020212/xmldsig-core-schema.xsd'

export interface EsitoValidazioneXsd {
  /** `true` solo se lo XSD non ha sollevato nemmeno un errore. */
  valido: boolean
  /** Un messaggio per errore, già ripulito da nome file e numero di riga. */
  errori: string[]
  /** L'output grezzo di xmllint: serve quando il messaggio pulito non basta. */
  grezzo: string
}

/** I due XSD si leggono dal disco una volta sola: sono 79 KB e la suite li usa più volte. */
let schemiInMemoria: { schema: string; xmldsig: string } | null = null

function leggiSchemi(): { schema: string; xmldsig: string } {
  if (schemiInMemoria) return schemiInMemoria
  const schemaUfficiale = readFileSync(CARTELLA_XSD + NOME_SCHEMA_FATTURAPA, 'utf8')
  if (!schemaUfficiale.includes(URL_XMLDSIG_REMOTA)) {
    // Non è un dettaglio: se l'URL cambiasse (nuova revisione dello schema) la riscrittura
    // qui sotto diventerebbe una no-op silenziosa, xmllint tenterebbe la rete e ogni test
    // fallirebbe con un messaggio incomprensibile. Meglio dirlo subito e per nome.
    throw new Error(
      `${NOME_SCHEMA_FATTURAPA} non contiene più la schemaLocation remota attesa ` +
        `(${URL_XMLDSIG_REMOTA}): aggiorna URL_XMLDSIG_REMOTA in __tests__/lib/aruba/valida-xsd.ts.`,
    )
  }
  schemiInMemoria = {
    schema: schemaUfficiale.replaceAll(URL_XMLDSIG_REMOTA, NOME_XMLDSIG),
    xmldsig: readFileSync(CARTELLA_XSD + NOME_XMLDSIG, 'utf8'),
  }
  return schemiInMemoria
}

/**
 * Valida una stringa XML contro lo schema FatturaPA 1.2.3.
 *
 * Non lancia quando l'XML è invalido: l'esito è un valore, così il test può
 * asserire tanto il caso valido quanto quello NON valido (che è la metà del
 * collaudo — un validatore che approva tutto non sta validando niente).
 */
export async function validaFatturaPA(xml: string): Promise<EsitoValidazioneXsd> {
  const { schema, xmldsig } = leggiSchemi()
  const esito = await validateXML({
    xml: [{ fileName: 'fattura.xml', contents: xml }],
    schema: [{ fileName: NOME_SCHEMA_FATTURAPA, contents: schema }],
    preload: [{ fileName: NOME_XMLDSIG, contents: xmldsig }],
  })
  return {
    valido: esito.valid,
    errori: esito.errors.map((e) => e.message),
    grezzo: esito.rawOutput,
  }
}
