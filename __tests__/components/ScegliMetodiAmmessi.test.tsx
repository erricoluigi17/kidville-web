import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ScegliMetodiAmmessi } from '@/components/features/admin/pagamenti/ScegliMetodiAmmessi';

/**
 * Le due caselle «Contanti / Bonifico» (2026-10-05). Controllate: lo stato lo tiene il
 * chiamante, qui una spia su `onChange`. I testi sono quelli VERI del catalogo italiano
 * (`adminContabilita`), dal mock globale di next-intl in `test/setup.ts`.
 */
describe('ScegliMetodiAmmessi', () => {
  it('con entrambi i metodi partono spuntate tutte e due, dentro un gruppo con la sua legenda', () => {
    render(<ScegliMetodiAmmessi valore={['contanti', 'bonifico']} onChange={() => {}} />);
    const gruppo = screen.getByRole('group', { name: 'Metodi di pagamento ammessi' });
    expect(gruppo).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Contanti' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Bonifico' })).toBeChecked();
    // L'aiuto è collegato al gruppo; l'errore no, perché non c'è.
    expect(gruppo).toHaveAccessibleDescription('Con il solo contanti il genitore non vede IBAN e causale.');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('togliendo «Bonifico» si chiama onChange([\'contanti\'])', () => {
    const onChange = vi.fn();
    render(<ScegliMetodiAmmessi valore={['contanti', 'bonifico']} onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Bonifico' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(['contanti']);
  });

  it('rispuntando «Contanti» l\'ordine resta quello canonico (contanti, bonifico)', () => {
    const onChange = vi.fn();
    render(<ScegliMetodiAmmessi valore={['bonifico']} onChange={onChange} />);
    expect(screen.getByRole('checkbox', { name: 'Contanti' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Contanti' }));
    expect(onChange).toHaveBeenCalledWith(['contanti', 'bonifico']);
  });

  it('con zero metodi lo DICE: un alert collegato al gruppo, non un blocco muto', () => {
    render(<ScegliMetodiAmmessi valore={[]} onChange={() => {}} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Scegli almeno un metodo di pagamento.');
    const gruppo = screen.getByRole('group', { name: 'Metodi di pagamento ammessi' });
    expect(gruppo).toHaveAccessibleDescription(
      'Con il solo contanti il genitore non vede IBAN e causale. Scegli almeno un metodo di pagamento.',
    );
    expect(screen.getByRole('checkbox', { name: 'Contanti' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Bonifico' })).not.toBeChecked();
  });

  it('disabled spegne le due caselle', () => {
    render(<ScegliMetodiAmmessi valore={['contanti', 'bonifico']} onChange={() => {}} disabled />);
    expect(screen.getByRole('checkbox', { name: 'Contanti' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Bonifico' })).toBeDisabled();
  });
});
