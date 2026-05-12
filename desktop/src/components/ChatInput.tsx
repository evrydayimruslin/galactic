// Chat input — textarea with Cmd/Ctrl+Enter to send.
// Supports queue mode: input stays enabled while agent runs, shows "Queue" instead of "Send".
// Supports file attachments via + icon.

import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react';
import ProjectDropdown from './ProjectDropdown';

/** File attachment ready to send — base64-encoded with metadata */
export interface ChatFile {
  name: string;
  size: number;
  mimeType: string;
  content: string; // base64 data URL
}

interface ChatInputProps {
  onSend: (content: string, files?: ChatFile[]) => void;
  isLoading: boolean;
  onStop?: () => void;
  /** When true, input stays enabled during loading — sends go to queue */
  queueMode?: boolean;
  /** Current conversation's project directory */
  projectDir?: string | null;
  /** Called when user picks a new project directory */
  onProjectDirChange?: (dir: string) => void;
  /** Optional extra action rendered beside the composer */
  extraAction?: ReactNode;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ACCEPTED_TYPES = '.pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.md,.csv,.json,.xml,.yaml,.yml,.html,.css,.js,.ts,.py,.rb,.go,.rs,.java,.c,.cpp,.h,.sh,.sql,.toml,.doc,.docx';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export default function ChatInput({
  onSend,
  isLoading,
  onStop,
  queueMode = false,
  projectDir,
  onProjectDirChange,
  extraAction,
}: ChatInputProps) {
  const [value, setValue] = useState('');
  const [files, setFiles] = useState<ChatFile[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [value]);

  // Focus on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // In queue mode, input is never disabled — messages go to queue
  const inputDisabled = isLoading && !queueMode;
  const isQueueing = isLoading && queueMode;

  const hasContent = value.trim().length > 0 || files.length > 0;

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed && files.length === 0) return;
    if (isLoading && !queueMode) return;
    onSend(trimmed || '(attached files)', files.length > 0 ? files : undefined);
    setValue('');
    setFiles([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [value, files, isLoading, queueMode, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files;
    if (!selected) return;

    Array.from(selected).forEach(file => {
      if (file.size > MAX_FILE_SIZE) {
        alert(`${file.name} is too large (max ${formatSize(MAX_FILE_SIZE)})`);
        return;
      }
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target?.result as string;
        if (!dataUrl) return;
        setFiles(prev => [...prev, {
          name: file.name,
          size: file.size,
          mimeType: file.type || 'application/octet-stream',
          content: dataUrl,
        }]);
      };
      reader.readAsDataURL(file);
    });

    // Reset input so the same file can be re-selected
    e.target.value = '';
  }, []);

  const removeFile = useCallback((idx: number) => {
    setFiles(prev => prev.filter((_, i) => i !== idx));
  }, []);

  return (
    <div className="bg-white px-4 pt-3 pb-4">
      <div className="max-w-narrow mx-auto">
        {/* File chips — aligned with textarea */}
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2 pl-10">
            {files.map((f, i) => (
              <div
                key={`${f.name}-${i}`}
                className="flex items-center gap-1.5 px-2 py-1 bg-gray-100 rounded-md text-xs text-gray-600 max-w-[200px]"
              >
                <span className="truncate">{f.name}</span>
                <span className="text-gray-400 flex-shrink-0">{formatSize(f.size)}</span>
                <button
                  onClick={() => removeFile(i)}
                  className="text-gray-400 hover:text-gray-600 flex-shrink-0 ml-0.5"
                  title="Remove"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2">
          {/* Attachment icon */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={inputDisabled}
            className="flex items-center justify-center w-8 h-8 rounded-full text-gray-400 hover:text-gray-600 hover:bg-gray-100 disabled:opacity-30 transition-colors flex-shrink-0 mb-[3px]"
            title="Attach file"
          >
            <svg className="w-5 h-5 rotate-45 -scale-x-100" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
            </svg>
          </button>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPTED_TYPES}
            onChange={handleFileSelect}
            className="hidden"
          />

          {extraAction ? (
            <div className="mb-[3px] flex flex-shrink-0 items-center justify-center">
              {extraAction}
            </div>
          ) : null}

          <textarea
            ref={textareaRef}
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isQueueing ? 'Queue a follow-up...' : 'Message...'}
            rows={1}
            // TODO(token): border-gray-200, placeholder:text-gray-500 — no exact ul-* equivalents; kept raw.
            className="flex-1 resize-none border border-gray-200 px-3 text-small text-ul-text bg-ul-bg outline-none transition-colors placeholder:text-gray-500 selectable"
            style={{ paddingTop: '9px', paddingBottom: '11px', lineHeight: '20px' }}
            disabled={inputDisabled}
          />

          {/* Stop button */}
          {isLoading && (
            <button
              onClick={onStop}
              className="flex items-center justify-center w-8 h-8 rounded-full bg-gray-200 text-gray-500 hover:bg-gray-200 transition-colors flex-shrink-0 mb-0.5"
              title="Stop"
            >
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          )}

          {/* Send / Queue button */}
          {isQueueing ? (
            <button
              onClick={handleSend}
              disabled={!hasContent}
              className="flex items-center justify-center w-8 h-8 rounded-full bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-30 transition-colors flex-shrink-0 mb-0.5"
              title="Queue"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </button>
          ) : !isLoading ? (
            <button
              onClick={handleSend}
              disabled={!hasContent}
              className="flex items-center justify-center w-8 h-8 rounded-full bg-gray-800 text-white hover:bg-gray-700 disabled:opacity-20 transition-colors flex-shrink-0 mb-0.5"
              title="Send"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18" />
              </svg>
            </button>
          ) : null}
        </div>

        {onProjectDirChange && (
          <div className="mt-2 pl-10">
            <ProjectDropdown
              selectedDir={projectDir ?? null}
              onSelect={(dir) => dir && onProjectDirChange(dir)}
              dropUp
              compact
            />
          </div>
        )}
      </div>
    </div>
  );
}
