import { X } from 'lucide-react';
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
  if (!open) return null;

  return (
    <div className="v3-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className={`v3-modal v3-modal--${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="v3-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="v3-modal__header">
          <div>
            <h2 id="v3-modal-title">{title}</h2>
            {context ? <p>{context}</p> : null}
          </div>
          <Button variant="icon" aria-label="关闭弹窗" title="关闭" onClick={onClose}>
            <X size={18} />
          </Button>
        </header>
        <div className="v3-modal__content">{children}</div>
        {footer ? <footer className="v3-modal__footer">{footer}</footer> : null}
      </section>
    </div>
  );
}
