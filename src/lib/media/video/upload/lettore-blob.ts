/**
 * IL LETTORE DEL FILE PER TUS — quindici righe che tolgono di mezzo una divergenza
 * fra il codice che gira nel collaudo e quello che gira sul telefono.
 *
 * ─── LA MISURA CHE L'HA RESO NECESSARIO ────────────────────────────────────
 *
 * `tus-js-client` spedisce due build: una `browser` (affetta un `Blob`) e una
 * `node` (vuole un `Buffer` o uno `Stream`). Quale delle due si carica lo decide
 * chi risolve i moduli, e le due risposte NON coincidono:
 *
 *  · nel bundle client di Next vince il campo `browser` del `package.json`;
 *  · sotto vitest, misurato il 2026-09-18, vince la build **node**: passandole un
 *    `Blob` risponde «source object may only be an instance of Buffer or Readable
 *    in this environment» (`lib.es5/node/fileReader.js:78`).
 *
 * Il modo comodo di aggirarlo è iniettare un lettore finto nei test. Sarebbe la
 * cosa sbagliata: il pezzo che affetta l'originale è esattamente quello che deve
 * essere identico fra collaudo e produzione, perché è lui a decidere quali byte
 * partono in una `PATCH` e quindi se la ripresa ricuce il file o lo corrompe.
 * Perciò il lettore è NOSTRO, uno solo, e si passa sempre.
 *
 * ─── PERCHÉ È IDENTICO A QUELLO DELLA BUILD BROWSER, RAMO CORDOVA A PARTE ───
 *
 * È la stessa logica di `lib/browser/sources/FileSource.js`: `slice` restituisce
 * il `Blob` affettato e `done` è vero quando si è arrivati in fondo. L'unico ramo
 * non riprodotto è quello di Apache Cordova, che rilegge ogni fetta in un
 * `Uint8Array` perché l'XHR di Cordova non sa spedire un `Blob`. Questa app gira
 * su **Capacitor**, che non definisce `window.cordova` né `window.PhoneGap` (nel
 * repo non c'è un solo riferimento a quei globali), e il suo XHR è quello di
 * WebKit/Chromium: riprodurre quel ramo significherebbe portare in memoria sei
 * megabyte a blocco senza nessun motivo.
 */

/** La fetta che tus consegna allo strato HTTP: nel browser è un `Blob`. */
interface FettaVideo {
  value: Blob
  done: boolean
}

/** La sorgente che `tus.Upload` interroga per ottenere i blocchi da spedire. */
export class SorgenteBlob {
  readonly size: number

  constructor(private readonly blob: Blob) {
    this.size = blob.size
  }

  async slice(inizio: number, fine: number): Promise<FettaVideo> {
    return { value: this.blob.slice(inizio, fine), done: fine >= this.size }
  }

  close(): void {
    /* Niente da rilasciare: un `Blob` non tiene aperto nessun descrittore. */
  }
}

export class LettoreBlob {
  async openFile(ingresso: Blob): Promise<SorgenteBlob> {
    return new SorgenteBlob(ingresso)
  }
}
