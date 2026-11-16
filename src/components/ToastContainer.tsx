import React from 'react';
import type { ToastMessage } from '../types/game';

interface ToastContainerProps {
  toasts: ToastMessage[];
}

export const ToastContainer: React.FC<ToastContainerProps> = ({ toasts }) => {
  return (
    <>
      {toasts.map((toast) => {
        const glassClass =
          toast.type === 'error'
            ? 'glass-black text-red-100'
            : toast.type === 'success'
              ? 'glass-green text-emerald-100'
              : 'glass-blue text-[#fef08a]';
        const iconName =
          toast.type === 'error' ? 'warning' : toast.type === 'success' ? 'check_circle' : 'info';

        return (
          <div
            key={toast.id}
            className={`absolute top-6 left-1/2 -translate-x-1/2 glass-toast ${glassClass} px-3 py-2 rounded-[6px] shadow-xl font-pixel text-[8px] sm:text-[9px] z-[9999] transition-all duration-300 pointer-events-none w-[86%] max-w-[260px] sm:max-w-[300px] animate-toast-in`}
          >
            <div className="flex items-center gap-2 relative z-10 w-full">
              <span className="material-symbols-rounded text-sm sm:text-base shrink-0">{iconName}</span>
              <span className="text-[8px] sm:text-[9px] leading-tight break-words text-white">
                {toast.message}
              </span>
            </div>
          </div>
        );
      })}
    </>
  );
};
