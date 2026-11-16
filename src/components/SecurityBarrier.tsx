import React, { useEffect } from 'react';
import { pauseBgmForLockdown, resumeBgmAfterLockdown } from '../services/audio';

interface SecurityBarrierProps {
  screenRef: React.RefObject<HTMLDivElement | null>;
  disabled?: boolean;
}

export const SecurityBarrier: React.FC<SecurityBarrierProps> = ({ screenRef, disabled = false }) => {
  const releaseLockdown = () => {
    const screen = screenRef.current;
    if (screen) {
      screen.classList.remove('security-popup-active');
      screen.style.pointerEvents = 'all';
    }
    resumeBgmAfterLockdown();
  };

  useEffect(() => {
    if (disabled) return;

    const activateLockdown = () => {
      const screen = screenRef.current;
      if (screen) {
        screen.classList.add('security-popup-active');
        screen.style.pointerEvents = 'auto';
      }
      pauseBgmForLockdown();
    };

    const scheduleRelease = (delay: number) => {
      setTimeout(releaseLockdown, delay);
    };

    const onVisibilityChange = () => {
      if (document.hidden) activateLockdown();
      else scheduleRelease(300);
    };

    const onBlur = () => {
      setTimeout(() => {
        if (!document.hasFocus() || document.hidden) activateLockdown();
      }, 150);
    };

    const onFocus = () => {
      scheduleRelease(300);
    };

    const onPageHide = () => activateLockdown();
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) scheduleRelease(0);
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length >= 5) {
        activateLockdown();
        scheduleRelease(2000);
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const forbiddenMatch =
        e.key === 'PrintScreen' ||
        (e.ctrlKey && (e.key === 'p' || e.key === 's' || e.key === 'u')) ||
        (e.metaKey && e.shiftKey && (e.key === '4' || e.key === '3'));
      if (forbiddenMatch) {
        activateLockdown();
        scheduleRelease(2000);
      }
    };

    const preventDefault = (e: Event) => e.preventDefault();

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('contextmenu', preventDefault);
    document.addEventListener('dragstart', preventDefault);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('contextmenu', preventDefault);
      document.removeEventListener('dragstart', preventDefault);
    };
  }, [screenRef, disabled]);

  if (disabled) return null;

  return (
    <div
      id="securityBarrierPopup"
      className="security-popup flex items-center justify-center p-6 sm:p-8 text-center"
      role="alertdialog"
      aria-modal="true"
      aria-label="Signal Lockdown"
    >
      <div className="security-content relative w-full max-w-md mx-auto">
        <span className="material-symbols-rounded text-5xl text-red-500 mb-4">lock</span>
        <h2 className="font-pixel text-red-400 text-xs sm:text-base uppercase tracking-widest mb-2">Signal Lost</h2>
        <p className="font-mono text-sm text-slate-300 mb-6">
          Security verification required to continue.
        </p>
        <div className="security-timer text-red-500 font-pixel text-xs sm:text-sm">
          03
        </div>
        <button
          type="button"
          onClick={releaseLockdown}
          className="security-btn btn-pokedex w-full sm:w-auto px-4 py-2 mt-6 font-pixel text-xs sm:text-sm uppercase tracking-wider text-red-400"
        >
          EXIT
        </button>
      </div>
    </div>
  );
};