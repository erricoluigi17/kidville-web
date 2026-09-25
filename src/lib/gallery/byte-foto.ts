import { TETTO_GALLERIA_BYTE } from './limiti'

export class FotoTroppoGrandeError extends Error {
    constructor() { super('foto_supera_limite_byte'); this.name = 'FotoTroppoGrandeError' }
}

/** Byte portabili fra IndexedDB e fetch: WebKit può rifiutare Blob persistiti. */
export async function leggiByteFoto(file: Blob | ArrayBuffer): Promise<ArrayBuffer> {
    const size = file instanceof ArrayBuffer ? file.byteLength : file.size
    if (size > TETTO_GALLERIA_BYTE) throw new FotoTroppoGrandeError()
    if (file instanceof ArrayBuffer) return file
    if (typeof file.arrayBuffer === 'function') return file.arrayBuffer()
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => reader.result instanceof ArrayBuffer
            ? resolve(reader.result) : reject(new Error('foto_byte_illeggibili'))
        reader.onerror = () => reject(reader.error ?? new Error('foto_byte_illeggibili'))
        reader.onabort = () => reject(new Error('foto_lettura_interrotta'))
        reader.readAsArrayBuffer(file)
    })
}
