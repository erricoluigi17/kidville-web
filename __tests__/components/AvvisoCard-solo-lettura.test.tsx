import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

import itAvvisi from '../../messages/it/avvisi.json'
import { AvvisoCard, type Avviso } from '@/components/features/avvisi/AvvisoCard'

// =============================================================================
// La card della docente offre «Modifica» ed «Elimina» solo dove il server li
// accetta.
//
// Fino al 2026-10-07 i due pulsanti comparivano su OGNI avviso della bacheca,
// compresi quelli della segreteria e delle colleghe — e il server li eseguiva.
// Ora il server dice il permesso con il booleano `modificabile` (la stessa
// regola di PUT e DELETE, `@/lib/avvisi/permessi-docente`), e la card lo disegna
// e basta: dove non si può, compare «Solo lettura».
//
// Ogni negativa ha accanto la sua positiva: «non c'è Modifica» sarebbe vero
// anche con una card che non disegna mai i pulsanti.
// =============================================================================

afterEach(cleanup)

/** La card nasce chiusa: i pulsanti stanno nel pannello che si apre col tocco. */
function rendiAperta(a: Avviso) {
    render(<AvvisoCard avviso={a} index={0} isTeacher />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
}

function avviso(modificabile?: boolean): Avviso {
    return {
        id: 'avv-1',
        author_id: 'seg-1',
        titolo: 'Uscita al parco',
        contenuto: 'Portare il cappellino.',
        tipo: 'presa_visione',
        target_scope: 'classe',
        target_classes: ['Girasoli'],
        scadenza: null,
        attachment_url: null,
        created_at: '2026-10-05T08:00:00.000Z',
        author: { first_name: 'Nome', last_name: 'Cognome', role: 'segreteria' },
        stats: { letti: 3, adesioni_si: 0, adesioni_no: 0 },
        ...(modificabile === undefined ? {} : { modificabile }),
    }
}

describe('AvvisoCard — pulsanti di gestione secondo `modificabile`', () => {
    it('🔴 `modificabile: false` ⇒ niente Modifica né Elimina, e c’è «Solo lettura»', () => {
        rendiAperta(avviso(false))
        expect(screen.queryByRole('button', { name: new RegExp(itAvvisi.modifica) })).toBeNull()
        expect(screen.queryByRole('button', { name: new RegExp(itAvvisi.elimina) })).toBeNull()
        expect(screen.getByText(itAvvisi.soloLettura)).toBeInTheDocument()
        // Il dettaglio resta: leggere chi ha letto non è modificare.
        expect(screen.getByRole('button', { name: new RegExp(itAvvisi.dettaglio) })).toBeInTheDocument()
    })

    it('CONTROLLO POSITIVO: `modificabile: true` ⇒ i due pulsanti ci sono, e nessun «Solo lettura»', () => {
        rendiAperta(avviso(true))
        expect(screen.getByRole('button', { name: new RegExp(itAvvisi.modifica) })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: new RegExp(itAvvisi.elimina) })).toBeInTheDocument()
        expect(screen.queryByText(itAvvisi.soloLettura)).toBeNull()
    })

    it('campo assente (un chiamante che non lo manda) ⇒ comportamento di prima: pulsanti presenti', () => {
        rendiAperta(avviso())
        expect(screen.getByRole('button', { name: new RegExp(itAvvisi.modifica) })).toBeInTheDocument()
    })
})
