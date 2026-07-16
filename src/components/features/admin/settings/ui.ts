// Costanti di stile condivise tra i pannelli delle Impostazioni admin.
// Restyle 0C (/ship-cycle): allineate ai token e allo stile dell'app — niente colori bianchi nudi
// di Tailwind (che `@theme inline` non remappa in Alto Contrasto), raggi/pill/focus come le primitive app.
export const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });
export const card = 'bg-kidville-white rounded-card shadow-sm p-5 mb-5';
export const h3 = 'font-barlow font-black text-base text-kidville-green uppercase tracking-wide mb-4 flex items-center gap-2';
export const input = 'border-2 border-kidville-line rounded-input px-3 py-2 font-maven text-sm text-kidville-green transition-all focus:outline-none focus:border-kidville-green focus:ring-2 focus:ring-kidville-green';
export const label = 'font-maven text-xs text-kidville-sub mb-1 block';
export const btnPrimary = 'inline-flex items-center gap-2 rounded-pill bg-kidville-green px-4 py-2 font-barlow text-sm font-extrabold uppercase tracking-[0.05em] text-kidville-yellow transition-transform hover:bg-kidville-green-dark active:scale-95 disabled:pointer-events-none disabled:opacity-45';
export const hint = 'font-maven text-[11px] text-kidville-muted mt-1';
export const checkboxRow = 'flex items-center gap-2 cursor-pointer';
export const checkbox = 'w-4 h-4 rounded accent-kidville-green';
export const checkboxLabel = 'font-maven text-sm text-kidville-green';
