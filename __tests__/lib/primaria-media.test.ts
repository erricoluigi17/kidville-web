import { describe, it, expect } from 'vitest'
import { giudiziSintetici, mediaGiudizi, type ScalaVoce } from '@/lib/primaria/media'

// Scala giudizi sintetici D.M. 4 dicembre 2020, con valore numerico per la media.
const scala: ScalaVoce[] = [
  { etichetta: 'Avanzato', valore_numerico: 4 },
  { etichetta: 'Intermedio', valore_numerico: 3 },
  { etichetta: 'Base', valore_numerico: 2 },
  { etichetta: 'In via di prima acquisizione', valore_numerico: 1 },
]

describe('giudiziSintetici — coerenza media singola-materia ↔ panoramica', () => {
  it('caso di divergenza: esclude le modalità non sintetiche e allinea la media alla panoramica', () => {
    // Valutazioni miste sulla STESSA materia, come le restituisce il ramo
    // singola-materia (query con .not('modalita','is',null), TUTTE le modalità).
    const valutazioniMateria = [
      { id: 'v1', modalita: 'sintetico', giudizio_sintetico: 'Avanzato', giudizio_testo: null }, // 4 → conta
      { id: 'v2', modalita: 'sintetico', giudizio_sintetico: 'Base', giudizio_testo: null }, //     2 → conta
      { id: 'v3', modalita: 'descrittivo', giudizio_sintetico: null, giudizio_testo: 'Ottimo lavoro' }, // escluso
      { id: 'v4', modalita: 'voto', giudizio_sintetico: 'Avanzato', giudizio_testo: null }, // escluso: NON sintetico
      { id: 'v5', modalita: 'sintetico', giudizio_sintetico: null, giudizio_testo: null }, // escluso: giudizio nullo
    ]

    // giudiziSintetici tiene solo v1 e v2.
    expect(giudiziSintetici(valutazioniMateria)).toEqual(['Avanzato', 'Base'])

    // Media singola-materia (nuovo comportamento) = (4 + 2) / 2 = 3.
    const mediaMateria = mediaGiudizi(scala, giudiziSintetici(valutazioniMateria))
    expect(mediaMateria).toBe(3)

    // Media panoramica: la query filtra .eq('modalita','sintetico') e
    // .not('giudizio_sintetico','is',null) → resta ['Avanzato','Base'].
    const giudiziPanoramica = ['Avanzato', 'Base']
    const mediaPanoramica = mediaGiudizi(scala, giudiziPanoramica)

    // A parità di dati le due viste ora coincidono.
    expect(mediaMateria).toBe(mediaPanoramica)

    // Prova che il bug era reale: il vecchio calcolo mediava TUTTE le modalità
    // (incluso il 'voto' Avanzato) → (4 + 2 + 4) / 3 = 3.33, divergente.
    const mediaVecchiaBuggata = mediaGiudizi(
      scala,
      valutazioniMateria.map((v) => v.giudizio_sintetico),
    )
    expect(mediaVecchiaBuggata).toBe(3.33)
    expect(mediaVecchiaBuggata).not.toBe(mediaPanoramica)
  })

  it('nessuna valutazione sintetica: media assente, coerente con la panoramica', () => {
    const valutazioniMateria = [
      { id: 'v1', modalita: 'descrittivo', giudizio_sintetico: null, giudizio_testo: 'Bene' },
      { id: 'v2', modalita: 'voto', giudizio_sintetico: 'Avanzato', giudizio_testo: null }, // NON sintetico
    ]

    expect(giudiziSintetici(valutazioniMateria)).toEqual([])
    expect(mediaGiudizi(scala, giudiziSintetici(valutazioniMateria))).toBeNull()
  })

  it('array vuoto → nessun giudizio, media null', () => {
    expect(giudiziSintetici([])).toEqual([])
    expect(mediaGiudizi(scala, giudiziSintetici([]))).toBeNull()
  })

  it('scarta stringa vuota e preserva l’ordine dei giudizi sintetici', () => {
    const valutazioniMateria = [
      { modalita: 'sintetico', giudizio_sintetico: 'Intermedio' },
      { modalita: 'sintetico', giudizio_sintetico: '' }, // escluso: stringa vuota
      { modalita: 'sintetico', giudizio_sintetico: 'Avanzato' },
    ]
    expect(giudiziSintetici(valutazioniMateria)).toEqual(['Intermedio', 'Avanzato'])
  })
})
