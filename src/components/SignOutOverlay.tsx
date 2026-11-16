import React, { useEffect } from 'react';
import { playSound } from '../services/audio';

interface SignOutOverlayProps {
  visible: boolean;
  teamName: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export const SignOutOverlay: React.FC<SignOutOverlayProps> = ({
  visible,
  teamName,
  onConfirm,
  onCancel,
}) => {
  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [visible, onCancel]);

  return (
    <div
      id="signoutOverlay"
      className={`${visible ? '' : 'hidden '}crt-modal-scrim z-[160] confirm-dialog-overlay`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="signoutTitle"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="crt-card crt-card--alert w-full max-w-[350px] text-center animate-fade-in">
        <span className="material-symbols-rounded text-red-400 text-3xl sm:text-4xl mb-1.5">
          power_settings_new
        </span>
        <h3 id="signoutTitle" className="font-pixel text-red-300 text-xs uppercase tracking-wider mb-2">
          SIGN OUT
        </h3>
        <p className="font-mono text-xs text-slate-200 mb-4 leading-relaxed">
          Trainer{' '}
          <span id="signOutTeam" className="text-[#fef08a] font-bold">
            {teamName || 'Trainer'}
          </span>
          <br />
          Your progress is backed up before sign-out. Continue?
        </p>
        <div className="flex gap-2.5">
          <button
            type="button"
            onClick={() => {
              playSound('click');
              onConfirm();
            }}
            className="btn-pokedex flex-1 py-3 text-xs sm:text-sm min-h-[44px]"
            style={{
              background: 'linear-gradient(145deg, #ef4444, #dc2626)',
              borderBottom: '3px solid #991b1b',
            }}
          >
            <span className="flex items-center justify-center gap-1.5">
              <span className="material-symbols-rounded text-base sm:text-lg">logout</span>
              LOGOUT
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              playSound('click');
              onCancel();
            }}
            className="crt-btn-secondary flex-1 py-3 text-[10px] sm:text-xs min-h-[44px]"
          >
            <span className="flex items-center justify-center gap-1.5">
              <span className="material-symbols-rounded text-base sm:text-lg">close</span>
              STAY
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};
