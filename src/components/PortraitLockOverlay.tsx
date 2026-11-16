import React from 'react';
import { RotateCw, Smartphone } from 'lucide-react';

export const PortraitLockOverlay: React.FC = () => {
  return (
    <div
      id="portraitLockOverlay"
      className="portrait-lock-overlay fixed inset-0 z-[99999] bg-[#070d0a] flex-col items-center justify-center p-6 text-center select-none"
      role="alert"
      aria-live="assertive"
    >
      <div className="max-w-[320px] flex flex-col items-center">
        <div className="relative mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-xl border border-amber-500/40 bg-[#141710]">
          <Smartphone className="h-7 w-7 text-[#fef08a] portrait-rotate-icon" strokeWidth={2} />
          <RotateCw
            className="absolute -bottom-1 -right-1 h-4 w-4 rounded bg-[#141710] p-0.5 text-red-300"
            strokeWidth={2.5}
          />
        </div>

        <h2 className="font-pixel text-[#fef08a] text-xs uppercase tracking-wider mb-2">
          Rotate Phone
        </h2>

        <p className="font-mono text-xs text-slate-300 leading-relaxed">
          Landscape mode is locked. Rotate your device back to vertical portrait mode to continue.
        </p>
      </div>
    </div>
  );
};
