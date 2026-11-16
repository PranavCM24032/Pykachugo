import React from 'react';

interface PenaltyOverlayProps {
  visible: boolean;
  seconds?: number;
}

export const PenaltyOverlay: React.FC<PenaltyOverlayProps> = ({
  visible,
  seconds = 15,
}) => {
  if (!visible) return null;

  const timer = Math.max(0, seconds);

  return (
    <div
      id="penaltyOverlay"
      className="absolute inset-0 z-[150] flex flex-col items-center justify-center overflow-hidden p-4 text-center backdrop-blur-3xl animate-fade-in"
      role="alertdialog"
      aria-modal="true"
      aria-label="Malpractice Lockout"
    >
      {/* Dark, patterned screen backdrop */}
      <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-br from-gray-900/90 via-gray-800/95 to-gray-900/90" />
      <div
        aria-hidden="true"
        className="absolute inset-0 opacity-[0.05]"
        style={{
          backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 10px, #100303 10px, #373737 20px)',
        }}
      />
      <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-b from-black/30 via-transparent to-black/30" />

      <div className="relative z-10 w-full max-w-64 rounded-xl border-2 border-red-500/30 bg-black/80 p-4 text-center shadow-[0_0_30px_rgba(220,38,38,0.4)] backdrop-blur-sm sm:max-w-80 sm:p-6">
        {/* Officer Jenny watermark behind the timer */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <img
            src="/assets/img/jenny.webp"
            alt=""
            width={240}
            height={280}
            loading="lazy"
            decoding="async"
            className="h-[85%] max-h-80 select-none object-contain opacity-25"
          />
        </div>

        <div className="relative z-10 mt-4 mx-auto h-32 w-32 sm:mt-6 sm:h-40 sm:w-40">
          <svg className="absolute left-0 top-0 h-full w-full -rotate-90" viewBox="0 0 100 100" aria-hidden="true">
            <circle cx="50" cy="50" r="45" stroke="rgba(120,120,120,0.3)" strokeWidth="4" fill="none" />
            <circle
              id="penaltyRing"
              cx="50"
              cy="50"
              r="45"
              stroke="#ef4444"
              strokeWidth="4"
              fill="none"
              strokeLinecap="round"
              strokeDasharray="283"
              strokeDashoffset="283"
              className="penalty-timer-ring"
            />
          </svg>

          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <div id="penaltyTimer" className="font-mono text-5xl font-bold tabular-nums text-white sm:text-6xl">
              {timer}
            </div>
            <span className="mt-1 font-pixel text-xs uppercase text-red-300 sm:text-sm">Seconds</span>
          </div>
        </div>

        <h1 className="relative z-10 mt-3 font-pixel text-sm uppercase tracking-widest text-red-300 sm:mt-4 sm:text-base">
          Malpractice Detected
        </h1>
        <div className="relative z-10 mt-1 flex items-center justify-center gap-2">
          <span className="material-symbols-rounded text-sm text-red-400">security</span>
          <p className="text-xs uppercase text-gray-300 sm:text-sm">Authority Alert</p>
          <span className="material-symbols-rounded text-sm text-red-400">policy</span>
        </div>
      </div>
    </div>
  );
};

export default PenaltyOverlay;
