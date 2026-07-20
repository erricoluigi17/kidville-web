'use client';

// ─── Editor rich-text delle News (TipTap v3) ──────────────────────────────────
// Il client NON produce MAI HTML: emette SOLO editor.getJSON(). Il server rende e
// sanifica quel JSON dal chokepoint unico `src/lib/news/sanitizza.ts`. La toolbar
// è limitata alla allowlist della decisione 5 (p, h2, h3, grassetto, corsivo,
// sottolineato, barrato, link, liste, citazione, immagine). Non è SSR-safe
// (`immediatelyRender: false`): la pagina lo importa con `dynamic(ssr:false)`.

import { useCallback } from 'react';
import { useEditor, EditorContent, type JSONContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough, Heading2, Heading3,
  List, ListOrdered, Quote, LinkIcon, ImagePlus,
} from 'lucide-react';
import { cx } from '@/lib/ui/cx';
import { NewsMediaUploader } from './NewsMediaUploader';

interface Props {
  userId: string;
  value?: JSONContent | null;
  onChange: (json: JSONContent) => void;
  consensoFoto: boolean;
  onConsensoFoto: () => void;
  placeholder?: string;
}

// Pulsante di toolbar. Definito a livello di MODULO (non dentro il render), così
// la regola react-hooks «Cannot create components during render» resta soddisfatta.
function Btn({ onClick, attivo, etichetta, children }: { onClick: () => void; attivo?: boolean; etichetta: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={attivo}
      aria-label={etichetta}
      title={etichetta}
      className={cx(
        'inline-flex h-8 w-8 items-center justify-center rounded-lg border-[1.5px] transition-colors',
        'outline-none focus-visible:ring-2 focus-visible:ring-kidville-green',
        attivo
          ? 'border-kidville-green bg-kidville-green text-kidville-white'
          : 'border-kidville-line bg-kidville-white text-kidville-green hover:border-kidville-green',
      )}
    >
      {children}
    </button>
  );
}

// StarterKit v3 include già Link e Underline: NON li registro a parte (darebbe
// «Duplicate extension names»). Aggiungo solo Image e Placeholder.
export function NewsRichTextEditor({ userId, value, onChange, consensoFoto, onConsensoFoto, placeholder }: Props) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit,
      Image,
      Placeholder.configure({ placeholder: placeholder ?? 'Scrivi il contenuto…' }),
    ],
    content: value ?? undefined,
    editorProps: {
      attributes: {
        class:
          'kv-prose min-h-[220px] max-w-none rounded-input border-[1.5px] border-kidville-line bg-kidville-white px-3.5 py-3 font-maven text-sm text-kidville-ink outline-none focus:border-kidville-green',
      },
    },
    onUpdate: ({ editor: ed }) => onChange(ed.getJSON()),
  });

  const inserisciLink = useCallback(() => {
    if (!editor) return;
    const precedente = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('Indirizzo del link (https://…, http://… o mailto:)', precedente ?? 'https://');
    if (url === null) return; // annullato
    if (url.trim() === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run();
  }, [editor]);

  if (!editor) {
    return <div className="min-h-[260px] animate-pulse rounded-input border-[1.5px] border-kidville-line bg-kidville-cream" aria-hidden="true" />;
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <Btn etichetta="Grassetto" attivo={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}><Bold size={15} /></Btn>
        <Btn etichetta="Corsivo" attivo={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic size={15} /></Btn>
        <Btn etichetta="Sottolineato" attivo={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()}><UnderlineIcon size={15} /></Btn>
        <Btn etichetta="Barrato" attivo={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough size={15} /></Btn>
        <span className="mx-1 h-6 w-px bg-kidville-line" aria-hidden="true" />
        <Btn etichetta="Titolo" attivo={editor.isActive('heading', { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 size={15} /></Btn>
        <Btn etichetta="Sottotitolo" attivo={editor.isActive('heading', { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}><Heading3 size={15} /></Btn>
        <Btn etichetta="Elenco puntato" attivo={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}><List size={15} /></Btn>
        <Btn etichetta="Elenco numerato" attivo={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered size={15} /></Btn>
        <Btn etichetta="Citazione" attivo={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote size={15} /></Btn>
        <span className="mx-1 h-6 w-px bg-kidville-line" aria-hidden="true" />
        <Btn etichetta="Link" attivo={editor.isActive('link')} onClick={inserisciLink}><LinkIcon size={15} /></Btn>
      </div>

      <EditorContent editor={editor} />

      <div className="mt-2 flex items-center gap-2">
        <NewsMediaUploader
          userId={userId}
          consensoFoto={consensoFoto}
          onConsensoFoto={onConsensoFoto}
          onUploaded={(url) => editor.chain().focus().setImage({ src: url }).run()}
          label="Inserisci immagine nel testo"
        />
        <span className="inline-flex items-center gap-1 font-maven text-[11px] text-kidville-sub"><ImagePlus size={12} /> le immagini finiscono nel corpo dell&apos;articolo</span>
      </div>
    </div>
  );
}
