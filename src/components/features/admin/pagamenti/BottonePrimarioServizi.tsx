import type { ButtonHTMLAttributes } from 'react';

/**
 * Il bottone pieno verde dei servizi mensili. È un componente e non una stringa di classi in un
 * `.ts` perché il lock dell'Alto Contrasto vede il riempimento scuro solo dentro un JSX, dove sa
 * che il testo (giallo) sta nella stessa dichiarazione.
 */
export function BottonePrimarioServizi({ type = 'button', ...resto }: ButtonHTMLAttributes<HTMLButtonElement>) {
    return (
        <button
            type={type}
            className="inline-flex items-center gap-2 rounded-pill bg-kidville-green px-5 py-2.5 font-maven text-sm font-bold text-kidville-yellow transition-colors hover:bg-kidville-green-dark disabled:opacity-50"
            {...resto}
        />
    );
}
