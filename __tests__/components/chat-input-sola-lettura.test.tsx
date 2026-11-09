/**
 * PR 4.4 · Una conversazione in sola lettura dice perché non si può scrivere, con il campo spento: mai un bottone che fallisce al
 * clic. Ciò che era già nella bozza non si perde e non parte.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('next-intl', () => {
    const t = (k: string) => k;
    return {
        useTranslations: () => Object.assign(t, { rich: t, markup: t, raw: t, has: () => true }),
        useLocale: () => 'it',
    };
});
vi.mock('@/components/features/native/ScattaFotoButton', () => ({ ScattaFotoButton: () => null }));

import { ChatInput } from '@/components/features/chat/ChatInput';

afterEach(cleanup);

describe('ChatInput in sola lettura', () => {
    it('dice il motivo e spegne campo, allegato e invio', () => {
        render(<ChatInput onSend={vi.fn()} solaLettura />);

        expect(screen.getByRole('status').textContent).toBe('chatSolaLettura');
        expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true);
        expect((screen.getByLabelText('chatInputAriaInvia') as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByLabelText('chatInputAriaAllega') as HTMLButtonElement).disabled).toBe(true);
    });

    it('il tasto Invio non manda niente, anche con il testo già nel campo', () => {
        const onSend = vi.fn();
        const { rerender } = render(<ChatInput onSend={onSend} />);
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ciao' } });

        rerender(<ChatInput onSend={onSend} solaLettura />);
        fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

        expect(onSend).not.toHaveBeenCalled();
        expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('ciao');
    });

    it('fuori dalla sola lettura non dice niente e il campo è acceso', () => {
        render(<ChatInput onSend={vi.fn()} />);

        expect(screen.queryByRole('status')).toBeNull();
        expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(false);
    });
});
