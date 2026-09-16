/**
 * Bootstrap lazy del motore PDF usato nel browser.
 *
 * Non ci sono import con effetti globali al livello del modulo: importare questo
 * file durante SSR o build non valuta né `core-js` né PDF.js. I polyfill vengono
 * applicati soltanto alla prima invocazione e sono tutti completati prima che
 * `unpdf` venga valutato.
 *
 * Gli errori restano al chiamante, che conosce l'operazione (anteprima, download,
 * stampa) e può registrarli col contesto corretto. Qui si azzera soltanto la
 * promessa fallita: un guasto transitorio al caricamento del chunk non deve
 * avvelenire ogni tentativo successivo fino al refresh della pagina.
 */

export type MotorePdf = typeof import('unpdf')['getDocumentProxy']

let caricamento: Promise<MotorePdf> | null = null

async function importaMotorePdf(): Promise<MotorePdf> {
  // Sono import di soli side effect. La sequenza è esplicita perché `unpdf`
  // valuta PDF.js all'import e deve trovare tutte le primitive già disponibili.
  // `core-js` non pubblica `.d.ts` per i singoli file `modules/*`: l'assenza del
  // tipo è attesa perché non se ne legge alcun export.
  // @ts-expect-error modulo di soli side effect, privo di dichiarazione upstream
  await import('core-js/modules/web.structured-clone.js')
  // @ts-expect-error modulo di soli side effect, privo di dichiarazione upstream
  await import('core-js/modules/es.math.sum-precise.js')
  // @ts-expect-error modulo di soli side effect, privo di dichiarazione upstream
  await import('core-js/modules/web.url.parse.js')
  // @ts-expect-error modulo di soli side effect, privo di dichiarazione upstream
  await import('core-js/modules/es.object.has-own.js')
  // @ts-expect-error modulo di soli side effect, privo di dichiarazione upstream
  await import('core-js/modules/es.array.at.js')
  // @ts-expect-error modulo di soli side effect, privo di dichiarazione upstream
  await import('core-js/modules/es.typed-array.at.js')

  const { getDocumentProxy } = await import('unpdf')
  return getDocumentProxy
}

export function caricaMotorePdf(): Promise<MotorePdf> {
  if (caricamento) return caricamento

  caricamento = importaMotorePdf().catch((errore: unknown) => {
    caricamento = null
    throw errore
  })
  return caricamento
}
