import { describe, it, expect } from 'vitest'
import { puoRigenerareCredenzialiStaff } from '@/lib/auth/credenziali-staff'

/**
 * LA TABELLA DI VERITÀ DEL PERMESSO SULLE CREDENZIALI DELLO STAFF.
 *
 * Il predicato è puro e sta in un modulo suo proprio perché lo consultano QUATTRO
 * chiamanti — le due route (`regenerate-credentials`, `credentials-pdf`) e i due
 * pannelli. Qui si prova la regola; che le route la applichino davvero, e nel
 * punto giusto, lo provano i loro file.
 */
describe('puoRigenerareCredenzialiStaff — chi rigenera le credenziali di chi', () => {
  it('la Direzione può su chiunque, Direzione compresa', () => {
    for (const attore of ['admin', 'coordinator'] as const) {
      for (const bersaglio of ['admin', 'coordinator', 'segreteria', 'educator', 'cuoca']) {
        expect(puoRigenerareCredenzialiStaff(attore, bersaglio)).toBe(true)
      }
    }
  })

  it('la Segreteria può sullo staff che non è Direzione', () => {
    for (const bersaglio of ['segreteria', 'educator', 'cuoca']) {
      expect(puoRigenerareCredenzialiStaff('segreteria', bersaglio)).toBe(true)
    }
  })

  /**
   * L'ECCEZIONE, e non è prudenza astratta: dopo il reset il PDF con la password
   * IN CHIARO viene notificato a CHI HA PREMUTO IL PULSANTE. Senza questa riga
   * una segreteria di Aversa resetterebbe l'admin di Aversa — che sta nel suo
   * stesso plesso — ne leggerebbe la password e vi accederebbe.
   */
  it('la Segreteria NON può su admin e coordinator', () => {
    expect(puoRigenerareCredenzialiStaff('segreteria', 'admin')).toBe(false)
    expect(puoRigenerareCredenzialiStaff('segreteria', 'coordinator')).toBe(false)
  })

  it('chi non è staff di gestione non può mai', () => {
    for (const attore of ['educator', 'cuoca', 'genitore'] as const) {
      expect(puoRigenerareCredenzialiStaff(attore, 'educator')).toBe(false)
    }
  })

  /**
   * LA RIGA CHE CONTA. `null` arriva quando la lettura di `utenti` non ha
   * prodotto una riga — per assenza o per guasto. Se qui rispondesse `true`, un
   * guasto di lettura diventerebbe un permesso, ed è esattamente il modo in cui
   * un controllo di sicurezza smette di controllare senza che nessuno lo veda.
   */
  it('un bersaglio senza ruolo leggibile si nega, anche alla Direzione', () => {
    expect(puoRigenerareCredenzialiStaff('segreteria', null)).toBe(false)
    expect(puoRigenerareCredenzialiStaff('admin', null)).toBe(false)
    expect(puoRigenerareCredenzialiStaff('admin', '')).toBe(false)
    expect(puoRigenerareCredenzialiStaff('admin', 'ruolo_inventato')).toBe(false)
    expect(puoRigenerareCredenzialiStaff('admin', undefined)).toBe(false)
  })
})
