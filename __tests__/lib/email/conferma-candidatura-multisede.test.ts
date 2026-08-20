import { describe, it, expect } from 'vitest'
import { messaggioConfermaCandidatura } from '@/lib/email/messaggi/conferma-candidatura'
import { etichettePosizioni } from '@/lib/forms/insegnanti-template'
import type { ContestoSede } from '@/lib/email/contesto'

/**
 * LA CONFERMA A CHI SI CANDIDA, quando i plessi sono più d'uno.
 *
 * Due difetti misurati dalla verifica avversariale del 2026-08-20, entrambi
 * nella stessa email e a venti righe di distanza l'uno dall'altro.
 */

const GIUGLIANO: ContestoSede = {
    nome: 'Kidville Giugliano',
    indirizzo: 'Via di Prova 1, Giugliano',
    telefono: '+39 081 0000000',
    email: 'giugliano@kidville.test',
    privacy: 'https://esempio.test/privacy',
    app: 'https://app.esempio.test',
}

describe('conferma candidatura · il PIEDE nomina le sedi scelte, non la carta intestata', () => {
    /**
     * ⚠️ IL DIFETTO: il commit che ha aggiunto la riga «Sedi» dichiarava «ora
     * dice tutte le sedi». Il corpo sì; il piede no. `motivo` era
     * `«hai inviato una candidatura a ${sede.nome}»` con `sede` risolta sul
     * PRIMO plesso richiesto: chi si era proposta a tre riceveva un'email che
     * nel corpo elencava tre plessi e in fondo ne nominava uno. Lo stesso
     * difetto appena corretto, spostato di venti righe nello stesso file.
     */
    it('🔴 con tre sedi scelte il piede le nomina tutte e tre', () => {
        const m = messaggioConfermaCandidatura(
            {
                nome: 'Ines',
                inviataIl: '20/08/2026 10:00',
                sediScelte: ['Kidville Giugliano', 'Kidville Aversa', 'Kidville Cesa'],
                giorniRisposta: 30,
            },
            GIUGLIANO,
        )
        for (const testo of [m.html, m.testo]) {
            expect(testo).toContain('Kidville Aversa')
            expect(testo).toContain('Kidville Cesa')
        }
        expect(
            m.testo,
            'il piede nominava solo il plesso della carta intestata',
        ).not.toContain('hai inviato una candidatura a Kidville Giugliano.')
    })

    it('con una sola sede il piede resta quello di prima', () => {
        const m = messaggioConfermaCandidatura(
            { nome: 'Ines', inviataIl: '20/08/2026 10:00', sediScelte: ['Kidville Giugliano'], giorniRisposta: 30 },
            GIUGLIANO,
        )
        expect(m.testo).toContain('hai inviato una candidatura a Kidville Giugliano.')
    })

    it('senza `sediScelte` ripiega sulla sede del contesto: nessuna riga vuota', () => {
        const m = messaggioConfermaCandidatura(
            { nome: 'Ines', inviataIl: '20/08/2026 10:00', giorniRisposta: 30 },
            GIUGLIANO,
        )
        expect(m.testo).toContain('hai inviato una candidatura a Kidville Giugliano.')
    })
})

describe('etichettePosizioni · «Altro» non è un mestiere, è un’istruzione al modulo', () => {
    /**
     * ⚠️ IL DIFETTO: l'etichetta di `altro` è «Altro (specifica qui sotto)», e
     * finiva testualmente nella conferma. Chi si candidava come psicomotricista
     * leggeva «Ruolo: Altro (specifica qui sotto)» — la propria professione
     * sostituita da un comando rivolto a un modulo che non stava più guardando —
     * e `posizione_altro`, quello che aveva scritto davvero, non compariva.
     */
    it('🔴 «altro» diventa ciò che la persona ha scritto', () => {
        expect(etichettePosizioni(['altro'], 'psicomotricista')).toBe('psicomotricista')
    })

    it('🔴 e non l’istruzione del modulo, in nessun caso', () => {
        for (const scritto of ['psicomotricista', '', null, '   ']) {
            expect(etichettePosizioni(['altro'], scritto)).not.toContain('specifica qui sotto')
        }
    })

    it('col campo libero vuoto ripiega su «Altro» pulito', () => {
        expect(etichettePosizioni(['altro'], '')).toBe('Altro')
        expect(etichettePosizioni(['altro'], null)).toBe('Altro')
        expect(etichettePosizioni(['altro'], '   ')).toBe('Altro')
    })

    it('le altre posizioni restano le loro etichette, e l’ordine è quello dell’invio', () => {
        expect(etichettePosizioni(['cuoca', 'altro'], 'psicomotricista')).toBe(
            'Cuoca / aiuto cucina, psicomotricista',
        )
    })

    it('un valore uscito dall’elenco dopo l’invio si mostra GREZZO, non si tace', () => {
        // Tacerlo sarebbe peggio che mostrarlo brutto: è un dato che la persona
        // ha davvero indicato.
        expect(etichettePosizioni(['una_posizione_ritirata'])).toBe('una_posizione_ritirata')
    })

    it('nessuna posizione ⇒ `null`, e la riga si omette', () => {
        expect(etichettePosizioni([])).toBeNull()
    })
})
