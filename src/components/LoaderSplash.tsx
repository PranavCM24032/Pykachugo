import React, { useEffect, useState } from 'react';

interface LoaderSplashProps {
  booted: boolean;
}

export const LoaderSplash: React.FC<LoaderSplashProps> = ({ booted }) => {
  const [visible, setVisible] = useState(true);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    if (!booted) return;
    const minWait = setTimeout(() => {
      setExiting(true);
    }, 1200);
    return () => clearTimeout(minWait);
  }, [booted]);

  useEffect(() => {
    if (!exiting) return;
    const removeTimer = setTimeout(() => {
      setVisible(false);
    }, 450);
    return () => clearTimeout(removeTimer);
  }, [exiting]);

  if (!visible) return null;

  return (
    <div
      id="appLoader"
      className={`loader-surface${exiting ? ' is-done' : ''}`}
      role="status"
      aria-label="Loading Pykachu Go"
      style={{ background: 'radial-gradient(circle at 50% 35%, #13221c 0%, #09110e 100%)' }}
    >
      <div className="loader-stage is-ready px-4">
        <div className="partner-row">
          <span className="mark mark--csi !border-[#2e4a3d] !bg-[#0b1410]">
            <img
              id="markCsi"
              src="/assets/img/csi.webp"
              alt="CSI"
              width={225}
              height={225}
              decoding="async"
            />
          </span>

          <span className="cross !text-[#fef08a]" aria-hidden="true">
            &times;
          </span>

          <span className="mark mark--auron !border-[#2e4a3d] !bg-[#0b1410]">
            <img
              id="markAuron"
              src="/assets/img/auron.webp"
              alt="Auron"
              width={699}
              height={727}
              decoding="async"
            />
          </span>
        </div>

        <p className="presents !text-[#94a3b8]">presents</p>

        <img
          className="main-logo"
          id="mainLogo"
          src="/assets/img/logo1.webp"
          alt="Pykachu Go"
          width={558}
          height={285}
          decoding="async"
        />

        <div
          className="progress !border-[#2e4a3d] !bg-[#0b1410] rounded-full"
          role="progressbar"
          aria-label="Loading"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={exiting ? 100 : 50}
        >
          <span className="progress-fill"></span>
        </div>
      </div>
    </div>
  );
};
