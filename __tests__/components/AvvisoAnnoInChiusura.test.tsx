import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AvvisoAnnoInChiusura } from '@/components/features/anno/AvvisoAnnoInChiusura'

/**
 * LA RIGA FISSA DELL'ANNO IN CHIUSURA (PR 4.9, chiusura A): il testo dice di che anno si tratta, con l'ICU vero (non il mock
 * globale che restituisce la stringa grezza), ed è una nota, non un allarme.
 */
vi.mock('next-intl', async () => {
    const { createTranslator } = await import('use-intl')
    const annoChiusura = (await import('../../messages/it/annoChiusura.json')).default as Record<string, string>
    const useTranslations = (ns?: string) => {
        const tradotto = createTranslator({
            locale: 'it',
            messages: { annoChiusura } as never,
            namespace: (ns ?? 'annoChiusura') as never,
        }) as unknown as (chiave: string, valori?: Record<string, unknown>) => string
        return (chiave: string, valori?: Record<string, unknown>) => tradotto(chiave, valori)
    }
    return { useTranslations }
})

describe('AvvisoAnnoInChiusura', () => {
    it('nomina l’anno e dice che si può ancora correggere', () => {
        render(<AvvisoAnnoInChiusura etichetta="2026/27" />)
        const nota = screen.getByRole('note')
        expect(nota.textContent).toContain('2026/27')
        expect(nota.textContent).toContain('si sta chiudendo')
        expect(nota.textContent).toContain('ancora correggerlo')
        expect(screen.queryByRole('alert')).toBeNull()
    })
    it('senza etichetta usa la frase senza anno e non lascia segnaposti', () => {
        render(<AvvisoAnnoInChiusura />)
        const testo = screen.getByRole('note').textContent ?? ''
        expect(testo).not.toContain('{')
        expect(testo).toContain('si sta chiudendo')
    })
})
