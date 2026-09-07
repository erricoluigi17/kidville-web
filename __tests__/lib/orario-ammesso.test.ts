import { describe, it, expect } from 'vitest'
import { orariAmmessi } from '@/lib/presenze/orario-ammesso'

// QUALI ORARI HA SENSO REGISTRARE, DATO LO STATO — in un posto solo.
//
// La stessa domanda se la fanno quattro punti: il 422 di coerenza del server, le due
// interfacce (0-6 e primaria) che decidono quali campi mostrare, e la regola di stato
// dell'upsert della primaria. Scritta quattro volte divergerebbe, e la divergenza qui
// si vede subito: un campo offerto a schermo e rifiutato dal server con un 422 che
// l'insegnante non può capire.
//
// LA REGOLA È CAMBIATA IL 2026-09-07, per decisione del titolare: l'uscita si registra
// anche a chi è «presente». Prima l'uscita valeva solo per `uscita_anticipata`, quindi
// un bambino uscito all'orario normale non aveva nessuna uscita da correggere.
//
// ⚠️ Registrare un'uscita su un «presente» NON cambia lo stato. Chi esce alle 15:30
// all'orario normale resta presente; `uscita_anticipata` significa «è uscito prima»,
// che è un fatto diverso e lo decide chi fa l'appello, non l'orologio.

describe('orariAmmessi', () => {
  it('un PRESENTE ha entrambi: era entrato, e a fine giornata esce', () => {
    expect(orariAmmessi('presente')).toEqual({ entrata: true, uscita: true })
  })

  it('un RITARDO ha entrambi: l\'ora d\'ingresso è il ritardo stesso, e può anche uscire', () => {
    expect(orariAmmessi('ritardo')).toEqual({ entrata: true, uscita: true })
  })

  it('chi esce prima ha entrambi: era comunque ENTRATO', () => {
    // Era il difetto della primaria: l'upsert azzerava l'entrata di chi usciva prima.
    expect(orariAmmessi('uscita_anticipata')).toEqual({ entrata: true, uscita: true })
  })

  it('un ASSENTE non ha orari: non è mai arrivato', () => {
    expect(orariAmmessi('assente')).toEqual({ entrata: false, uscita: false })
  })

  it('è fail-closed: uno stato sconosciuto o assente non ammette niente', () => {
    // Fail-closed e non fail-open: offrire un campo che il server rifiuterà è peggio
    // che non offrirlo, e uno stato che questo modulo non conosce è un dato che
    // nessuno ha ancora deciso come trattare.
    expect(orariAmmessi(null)).toEqual({ entrata: false, uscita: false })
    expect(orariAmmessi(undefined)).toEqual({ entrata: false, uscita: false })
    expect(orariAmmessi('')).toEqual({ entrata: false, uscita: false })
    expect(orariAmmessi('in_gita')).toEqual({ entrata: false, uscita: false })
  })
})
