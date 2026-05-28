import { Loader2, Sparkles } from 'lucide-react';
import { useState } from 'react';

export default function CommandComposer({
  loading,
  onGenerate,
}: {
  loading?: boolean;
  onGenerate: (prompt: string) => void;
}) {
  const [prompt, setPrompt] = useState('');

  return (
    <form
      className="px-[22px] pt-1 pb-2"
      onSubmit={(event) => {
        event.preventDefault();
        const value = prompt.trim();
        if (!value || loading) return;
        onGenerate(value);
      }}
    >
      <div className="flex items-center gap-2 border border-ul-border bg-ul-bg rounded-md px-3 py-2 shadow-sm">
        <Sparkles className="w-4 h-4 text-ul-text-muted flex-shrink-0" strokeWidth={1.5} />
        <input
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Make an interface for email approvals, study progress, or anything in your tools..."
          className="flex-1 min-w-0 bg-transparent border-none outline-none text-small text-ul-text placeholder:text-ul-text-muted"
          aria-label="Generated interface prompt"
        />
        <button
          type="submit"
          disabled={!prompt.trim() || loading}
          className="h-8 px-3 rounded-md bg-ul-text text-white text-caption font-mono disabled:opacity-40 disabled:cursor-not-allowed hover:bg-ul-accent-hover transition-colors flex items-center gap-2"
        >
          {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />}
          Generate
        </button>
      </div>
    </form>
  );
}
