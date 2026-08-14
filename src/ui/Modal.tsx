import { X } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { Button } from './Button';

interface ModalProps {
  open: boolean;
  title: string;
  context?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  size?: 'default' | 'wide';
}

export function Modal({
  open,
  title,
  context,
  children,
  footer,
  onClose,
  size = 'default',
}: ModalProps) {
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;

    previousFocus.current = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previousFocus.current?.focus();
    };
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div className="v3-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className={`v3-modal v3-modal--${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="v3-modal__header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {context ? <p>{context}</p> : null}
          </div>
          <Button
            ref={closeButtonRef}
            variant="icon"
            aria-label="关闭弹窗"
            title="关闭"
            onClick={onClose}
          >
            <X size={20} aria-hidden="true" />
          </Button>
        </header>
        <div className="v3-modal__content">{children}</div>
        {footer ? <footer className="v3-modal__footer">{footer}</footer> : null}
      </section>
    </div>
  );
}
