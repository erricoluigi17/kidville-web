/** Una sorgente persistente legge al massimo un blocco TUS, mai il video intero. */
export interface ByteVideoPersistenti {
  readonly size: number
  readonly type: string
  leggiIntervallo(inizio: number, fine: number): Promise<Uint8Array<ArrayBuffer>>
}

export type ByteVideo = Blob | ByteVideoPersistenti
export const BLOCCO_VIDEO_LOCALE = 6 * 1024 * 1024

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
