import React, { useEffect, useRef } from 'react';
import { playSound } from '../services/audio';
import { getBadgeUrl } from '../services/gameBackend';
import type { Puzzle } from '../types/game';

interface StartCodeStepProps {
  active: boolean;
  lockedPuzzle: Puzzle | null;
  unlockCode: string;
  onUnlockCodeChange: (val: string) => void;
  feedback: { message: string; type: 'error' | 'success' | 'info' } | null;
  shakeInput: boolean;
  onSubmit: (e: React.FormEvent) => void;
  onBack: () => void;
}

export const StartCodeStep: React.FC<StartCodeStepProps> = ({
  active,
  lockedPuzzle,
  unlockCode,
  onUnlockCodeChange,
  feedback,
  shakeInput,
  onSubmit,
  onBack,
}) => {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => {
      inputRef.current?.focus();
    }, 600);
    return () => clearTimeout(t);
  }, [active]);

  const badgeId = lockedPuzzle?.badgeId;
  const badgeUrl = badgeId ? getBadgeUrl(badgeId) : '';

  const feedbackClass =
    feedback?.type === 'error'
      ? 'text-[11px] font-mono p-2.5 rounded-lg border bg-[#241416] border-red-800/70 text-red-200 mb-2'
      : 'text-[11px] font-mono p-2.5 rounded-lg border bg-[#14281d] border-emerald-800/70 text-emerald-200 mb-2';

  return (
    <div id="startcode" className={`flow-step${active ? ' active' : ''} h-full`}>
      <div className="min-h-full w-full flex flex-col justify-center items-center gap-4 p-4 sm:p-6">
        <div className="w-full max-w-[340px] flex flex-col items-center text-center">
          <div
            id="step3BadgeContainer"
            className={`gym-badge-container${badgeUrl ? '' : ' hidden'} animate-fade-in !mb-4`}
          >
            <div className="badge-sparkle"></div>
            {badgeUrl && (
              <img
                id="gymBadgeImg"
                src={badgeUrl}
                alt="Gym Badge"
                loading="lazy"
                decoding="async"
                className="gym-badge-image"
              />
            )}
          </div>

          <h2 className="font-pixel text-[#fef08a] tracking-widest uppercase text-xs sm:text-sm mb-1">
            Encryption Detected
          </h2>
          <p className="font-mono text-[11px] text-slate-300 mb-5">
            Enter the sector start key to unlock this terminal.
          </p>

          <form id="unlockForm" onSubmit={onSubmit} className="w-full text-left">
            <div className="mb-3">
              <label className="crt-label" htmlFor="unlockCode">
                Start Key
              </label>
              <div className="relative group">
                <input
                  ref={inputRef}
                  type="text"
                  id="unlockCode"
                  value={unlockCode}
                  onChange={(e) => onUnlockCodeChange(e.target.value)}
                  className={`crt-input pl-3 pr-10 py-2.5 sm:py-3 placeholder-slate-500 uppercase text-xs sm:text-sm${
                    shakeInput ? ' animate-shake' : ''
                  }`}
                  placeholder="ENCRYPTION KEY"
                  autoComplete="off"
                  required
                  maxLength={50}
                  autoCapitalize="characters"
                />
                <span className="material-symbols-rounded absolute right-3 top-1/2 -translate-y-1/2 text-[#fef08a]/60 group-focus-within:text-[#fef08a] transition-colors text-base sm:text-lg md:text-xl pointer-events-none">
                  key
                </span>
              </div>
            </div>

            {feedback && (
              <div id="unlockFeedback" className={feedbackClass}>
                {feedback.message}
              </div>
            )}

            <div className="flex gap-2.5">
              <button
                type="submit"
                onMouseDown={() => playSound('click')}
                className="btn-pokedex flex-[2] flex items-center justify-center gap-1.5 py-2.5 sm:py-3 text-xs sm:text-sm"
                style={{
                  background: 'linear-gradient(145deg, #F59E0B, #D97706)',
                  borderBottom: '3px solid #92400E',
                }}
              >
                <span className="material-symbols-rounded text-base sm:text-lg md:text-xl">lock_open</span>
                VERIFY
              </button>

              <button
                type="button"
                aria-label="Back to scanner"
                onClick={() => {
                  playSound('click');
                  onBack();
                }}
                className="crt-btn-secondary flex-1 flex items-center justify-center py-2.5 sm:py-3"
              >
                <span className="material-symbols-rounded text-base sm:text-lg md:text-xl">arrow_back</span>
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
