'use client';

import { useTranslations } from 'next-intl';
import { FileSignature } from 'lucide-react';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { DocumentiFirmatiPanel } from '@/components/features/documenti/DocumentiFirmatiPanel';

/**
 * Insegnante — gli stessi documenti, ma dei soli bambini delle proprie sezioni.
 *
 * Il perimetro lo impone la route, non questa pagina: `sezioniVisibili` limita
 * gli alunni, e i documenti sanitari passano solo per le sezioni di cui
 * l'insegnante è contitolare. Qui non c'è nessuna prop che allarghi o stringa
 * la vista — se ci fosse, sarebbe modificabile dal browser.
 */
export default function TeacherDocumentiFirmatiPage() {
  const t = useTranslations('documenti');

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-24 pt-4 sm:px-6">
      <PageHeaderCard
        eyebrow={t('eyebrow')}
        icon={FileSignature}
        title={t('titolo')}
        subtitle={t('sottotitolo')}
        compatta
      />
      <div className="mt-4">
        <DocumentiFirmatiPanel />
      </div>
    </div>
  );
}
