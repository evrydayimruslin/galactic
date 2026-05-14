// Composer popover wrapper — anchors above a trigger, click-outside +
// Escape to close, fade-up entry animation.
//
// Used by ToolSelectionPopover and ModelPickerPopover; kept colocated under
// components/composer/ rather than components/ui/ until cross-surface reuse
// is confirmed (Batches 3-4 may want the same wrapper for library / market).

import { useEffect, useRef, type ReactNode } from 'react';

interface PopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  align?: 'left' | 'right';
  width?: number;
  maxHeight?: number;
  flex?: boolean;
  children: ReactNode;
}

export default function Popover({
  open,
  onClose,
  anchorRef,
  align = 'left',
  width = 320,
  maxHeight,
  flex = false,
  children,
}: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      role="dialog"
      className={`absolute z-20 ${align === 'right' ? 'right-0' : 'left-0'} rounded-lg border border-ul-border bg-ul-bg shadow-lg ring-1 ring-black/[0.02] animate-fade-up`}
      style={{
        bottom: 'calc(100% + 8px)',
        width,
        maxHeight,
        overflowY: maxHeight && !flex ? 'auto' : undefined,
        display: flex ? 'flex' : undefined,
        flexDirection: flex ? 'column' : undefined,
      }}
    >
      {children}
    </div>
  );
}
