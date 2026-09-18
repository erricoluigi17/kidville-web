import type { ArchivioCaricamentiVideo } from './archivio'
import type { CaricamentoVideoLocale } from './stato'

/**
 * L'ARCHIVIO CHE NON SOPRAVVIVE ALLA CHIUSURA DELL'APP — e che serve lo stesso.
 *
 * ⚠️ NON è un doppio di collaudo travestito da codice di produzione. È il ripiego
 * per i casi in cui IndexedDB non è disponibile: navigazione privata su Safari,
 * WebView con lo storage di sito disabilitato, quota esaurita. In quelle
 * condizioni `archivio-dexie` non può aprire il database, e senza un ripiego il
 * caricamento fallirebbe alla prima scrittura — cioè si perderebbe TUTTO invece
 * di perdere solo la durabilità.
 *
 * Con questo, chi carica in navigazione privata porta a termine il proprio video
 * finché la pagina resta aperta. Quello che non ha è la ripresa dopo la chiusura
 * dell'app, e `creaArchivioCaricamenti()` lo dice con un log di livello `warn`:
 * una capacità mancante è un incidente da registrare, non un dettaglio muto.
 *
 * Che sia ANCHE il doppio usato dai test è una conseguenza, non lo scopo: è la
 * stessa implementazione che gira su un iPhone in navigazione privata.
 */
export class ArchivioCaricamentiInMemoria implements ArchivioCaricamentiVideo {
  private readonly righe = new Map<string, CaricamentoVideoLocale>()
  private readonly byte = new Map<string, Blob>()

  async leggi(jobId: string): Promise<CaricamentoVideoLocale | undefined> {
    const riga = this.righe.get(jobId)
    // Copia: chi legge non deve poter mutare l'archivio per riferimento, che è
    // il modo in cui una riga cambia stato senza che nessuno l'abbia scritto.
    return riga ? { ...riga } : undefined
  }

  async elenca(): Promise<CaricamentoVideoLocale[]> {
    return [...this.righe.values()].map((r) => ({ ...r }))
  }

  async scrivi(riga: CaricamentoVideoLocale): Promise<void> {
    this.righe.set(riga.jobId, { ...riga })
  }

  async aggiorna(jobId: string, modifiche: Partial<CaricamentoVideoLocale>): Promise<void> {
    const riga = this.righe.get(jobId)
    if (!riga) return
    this.righe.set(jobId, { ...riga, ...modifiche })
  }

  async elimina(jobId: string): Promise<void> {
    this.righe.delete(jobId)
    this.byte.delete(jobId)
  }

  async leggiByte(jobId: string): Promise<Blob | undefined> {
    return this.byte.get(jobId)
  }

  async scriviByte(jobId: string, byte: Blob): Promise<void> {
    this.byte.set(jobId, byte)
  }

  async eliminaByte(jobId: string): Promise<void> {
    this.byte.delete(jobId)
  }
}
