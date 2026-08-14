﻿import { X } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  canClose?: boolean;
}

export const Modal = ({ isOpen, onClose, title, children, size = 'md', canClose = true }: ModalProps) => {
  const [isVisible, setIsVisible] = useState(false);
  const [shouldRender, setShouldRender] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setShouldRender(true);
      requestAnimationFrame(() => {
        setIsVisible(true);
        document.body.style.overflow = 'hidden';
      });
    } else {
      setIsVisible(false);
      const timer = setTimeout(() => {
        setShouldRender(false);
        document.body.style.overflow = '';
      }, 350);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !canClose) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [canClose, isOpen, onClose]);

  const handleBackdropClick = useCallback(() => {
    if (canClose) onClose();
  }, [canClose, onClose]);

  const handleContentClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  if (!shouldRender) return null;

  const sizeClasses = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-2xl',
  };

  return (
    <div 
      className={`modal-root fixed inset-0 z-50 flex items-center justify-center p-4 transition-opacity duration-350 ease-out ${
        isVisible ? 'opacity-100' : 'opacity-0'
      }`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      onClick={handleBackdropClick}
    >
      {/* 背景遮罩 - 径向渐变更有沉浸感 */}
      <div 
        className={`modal-backdrop absolute inset-0 transition-opacity duration-500 ease-out ${
          isVisible ? 'opacity-100' : 'opacity-0'
        }`}
        style={{
          background: 'radial-gradient(ellipse at center, rgba(15,10,30,0.88) 0%, rgba(0,0,0,0.95) 100%)',
          backdropFilter: 'blur(12px)',
        }}
      />
      
      {/* 模态框主体 */}
      <div 
        className={`modal-surface relative ${sizeClasses[size]} w-full max-h-[92vh] overflow-hidden rounded-2xl transition-all duration-500 ease-out ${
          isVisible 
            ? 'opacity-100 scale-100 translate-y-0' 
            : 'opacity-0 scale-95 translate-y-6'
        }`}
        onClick={handleContentClick}
        style={{
          background: 'linear-gradient(135deg, rgba(30,27,75,0.95) 0%, rgba(15,10,30,0.98) 100%)',
          backdropFilter: 'blur(40px) saturate(180%)',
          WebkitBackdropFilter: 'blur(40px) saturate(180%)',
          boxShadow: '0 32px 120px rgba(0,0,0,0.6), 0 0 80px rgba(139,92,246,0.1), inset 0 1px 0 rgba(139,92,246,0.12)',
          border: '1px solid rgba(139,92,246,0.15)',
        }}
      >
        {/* 顶部内发光 - 使用 wolf-purple 色系 */}
        <div 
          className="absolute top-0 left-0 right-0 h-20 pointer-events-none rounded-t-2xl"
          style={{
            background: 'linear-gradient(to bottom, rgba(139,92,246,0.06), transparent)',
          }}
        />
        
        {/* 底部内发光 */}
        <div 
          className="absolute bottom-0 left-0 right-0 h-20 pointer-events-none rounded-b-2xl"
          style={{
            background: 'linear-gradient(to top, rgba(139,92,246,0.03), transparent)',
          }}
        />
        
        {/* 左侧内发光 */}
        <div 
          className="absolute top-0 bottom-0 left-0 w-12 pointer-events-none"
          style={{
            background: 'linear-gradient(to right, rgba(139,92,246,0.05), transparent)',
          }}
        />
        
        {/* 右侧内发光 */}
        <div 
          className="absolute top-0 bottom-0 right-0 w-12 pointer-events-none"
          style={{
            background: 'linear-gradient(to left, rgba(139,92,246,0.03), transparent)',
          }}
        />

        {/* 四角装饰 - 更精致的线条 */}
        <div className="absolute top-4 left-4 w-5 h-5 pointer-events-none">
          <div className="absolute top-0 left-0 w-full h-[2px] rounded-full bg-gradient-to-r from-wolf-purple/40 to-transparent" />
          <div className="absolute top-0 left-0 w-[2px] h-full rounded-full bg-gradient-to-b from-wolf-purple/40 to-transparent" />
        </div>
        
        <div className="absolute top-4 right-4 w-5 h-5 pointer-events-none">
          <div className="absolute top-0 right-0 w-full h-[2px] rounded-full bg-gradient-to-l from-wolf-purple/40 to-transparent" />
          <div className="absolute top-0 right-0 w-[2px] h-full rounded-full bg-gradient-to-b from-wolf-purple/40 to-transparent" />
        </div>
        
        <div className="absolute bottom-4 left-4 w-5 h-5 pointer-events-none">
          <div className="absolute bottom-0 left-0 w-full h-[2px] rounded-full bg-gradient-to-r from-wolf-purple/30 to-transparent" />
          <div className="absolute bottom-0 left-0 w-[2px] h-full rounded-full bg-gradient-to-t from-wolf-purple/30 to-transparent" />
        </div>
        
        <div className="absolute bottom-4 right-4 w-5 h-5 pointer-events-none">
          <div className="absolute bottom-0 right-0 w-full h-[2px] rounded-full bg-gradient-to-l from-wolf-purple/30 to-transparent" />
          <div className="absolute bottom-0 right-0 w-[2px] h-full rounded-full bg-gradient-to-t from-wolf-purple/30 to-transparent" />
        </div>

        {/* 标题栏 */}
        <div className="relative px-6 py-5 border-b border-wolf-purple/10">
          <div className="flex items-center justify-between">
            <h3 id="modal-title" className="text-xl font-bold text-wolf-text tracking-wide">
              {title}
            </h3>
            {canClose && (
              <button
                onClick={onClose}
                aria-label="关闭弹窗"
                className="group relative w-9 h-9 rounded-xl flex items-center justify-center transition-all duration-300"
                style={{
                  background: 'rgba(255,255,255,0.03)',
                }}
              >
                <div 
                  className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300" 
                  style={{
                    background: 'radial-gradient(circle at center, rgba(239,68,68,0.12), transparent 70%)',
                  }}
                />
                <X className="w-5 h-5 text-wolf-text/50 group-hover:text-red-400 transition-colors duration-300 relative z-10" />
              </button>
            )}
          </div>
        </div>
        
        {/* 内容区 */}
        <div className="relative p-6 overflow-y-auto max-h-[calc(92vh-140px)] scrollbar-thin">
          {children}
        </div>
      </div>
    </div>
  );
};
