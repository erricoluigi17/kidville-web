import { ErroreByteVideo, leggiBloccoBlob, type ByteVideo } from './byte-video'

// XHR WebKit può rifiutare Blob ricostruiti da IndexedDB. Il corpo è un buffer
// limitato al blocco corrente. TUS 4 controlla anche `size` sull'ultimo blocco.
interface FettaVideo {
  value: Uint8Array<ArrayBuffer> & { size: number }
  done: boolean
}

export class SorgenteBlob {
  readonly size: number

  constructor(
    private readonly byte: ByteVideo,
    private readonly alFallimento?: (err: unknown) => void,
  ) {
    this.size = byte.size
  }

  async slice(inizio: number, fine: number): Promise<FettaVideo> {
    try {
      const limite = Math.min(fine, this.size)
      const value = 'leggiIntervallo' in this.byte
        ? await this.byte.leggiIntervallo(inizio, limite)
        : new Uint8Array(await leggiBloccoBlob(this.byte.slice(inizio, limite)))
      if (value.byteLength !== Math.max(0, limite - inizio)) throw new ErroreByteVideo('VIDEO_BLOCCO_INCOMPLETO')
      return { value: Object.assign(value, { size: value.byteLength }), done: fine >= this.size }
    } catch (err) {
      // Chi carica deve saperlo PRIMA che tus ritenti: rileggere la stessa
      // sorgente rotta quattro volte non la ripara.
      this.alFallimento?.(err)
      throw err
    }
  }

  close(): void {
    // Le singole letture IndexedDB non lasciano transazioni aperte.
  }
}

export class LettoreBlob {
  constructor(private readonly alFallimento?: (err: unknown) => void) {}

  async openFile(ingresso: ByteVideo): Promise<SorgenteBlob> {
    return new SorgenteBlob(ingresso, this.alFallimento)
  }
}
