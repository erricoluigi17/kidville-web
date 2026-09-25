/** Una sorgente persistente legge solo l'intervallo chiesto, mai il video intero. */
export interface ByteVideoPersistenti {
  readonly size: number
  readonly type: string
  leggiIntervallo(inizio: number, fine: number): Promise<Uint8Array<ArrayBuffer>>
}

export type ByteVideo = Blob | ByteVideoPersistenti

/**
 * Il LAYOUT su disco: quanti byte per blocco salvato. Non è il blocco TUS, e non
 * deve diventarlo: il manifest di ogni deposito scrive la propria dimensione, così
 * un cambio futuro non rende illeggibili i depositi già sui telefoni.
 */
export const BLOCCO_VIDEO_LOCALE = 6 * 1024 * 1024

/**
 * Il tetto di UNA lettura. Serve solo a non allocare in memoria un intervallo
 * assurdo: TUS chiede un blocco alla volta (`DIMENSIONE_BLOCCO_TUS_BYTE`), e un lock
 * in `__tests__` verifica che questo tetto resti sopra quel valore.
 */
export const LETTURA_VIDEO_MASSIMA = 64 * 1024 * 1024

/**
 * I difetti dei byte LOCALI: definitivi, non una rete che cade. Il `name` è il
 * codice perché `nomeErrore` trasmette solo il nome: con un `Error` generico nei
 * log arriverebbe «Error» e la causa resterebbe sul telefono.
 */
export type CodiceByteVideo = 'VIDEO_BLOCCO_INCOMPLETO' | 'VIDEO_INTERVALLO_NON_VALIDO' | 'VIDEO_ARCHIVIO_NON_VALIDO'

export class ErroreByteVideo extends Error {
  constructor(readonly codice: CodiceByteVideo) {
    super(codice)
    this.name = codice
  }
}

/** FileReader copre anche le WebView che non espongono Blob.arrayBuffer. */
export async function leggiBloccoBlob(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error ?? new Error('VIDEO_BYTE_ILLEGGIBILI'))
    reader.onabort = () => reject(new Error('VIDEO_LETTURA_INTERROTTA'))
    reader.readAsArrayBuffer(blob)
  })
}
