import React, { useCallback, useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { playSound } from '../services/audio';

interface ZoomCapability {
  min: number;
  max: number;
  step?: number;
}

interface Step2ScannerProps {
  active: boolean;
  onScanResult: (rawCode: string) => void;
  onShowToast: (msg: string, type: 'info' | 'success' | 'error') => void;
  onOpenCameraGuide: (reason: 'inapp' | 'permission') => void;
}

async function getCameraPermissionState(): Promise<string> {
  try {
    if (!navigator.permissions || typeof navigator.permissions.query !== 'function') return 'unknown';
    const status = await navigator.permissions.query({ name: 'camera' as PermissionName });
    return status.state || 'unknown';
  } catch {
    return 'unknown';
  }
}

async function requestCameraStream(): Promise<MediaStream> {
  const attempts: MediaStreamConstraints[] = [
    {
      video: {
        facingMode: 'environment',
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
    },
    { video: { facingMode: { ideal: 'environment' } } },
    { video: true },
  ];

  let lastError: unknown = null;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      lastError = error;
      const errName = (error as { name?: string })?.name || '';
      if (['NotAllowedError', 'SecurityError'].includes(errName)) throw error;
    }
  }
  throw lastError || new Error('Camera could not start');
}

function cameraErrorMessage(error: unknown): string {
  if (!window.isSecureContext) return 'Camera needs HTTPS. Use manual code entry.';
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    return 'This browser cannot access the camera. Use manual code entry.';
  }
  const errName = (error as { name?: string })?.name;
  switch (errName) {
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No camera found. Use manual code entry.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'Camera is busy in another app. Close it and retry, or use manual entry.';
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'Camera blocked. Allow camera for this site, then retry or use manual entry.';
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'Camera settings are unsupported. Retry or use manual entry.';
    case 'AbortError':
      return 'Camera stopped before it started. Retry or use manual entry.';
    default:
      return 'Camera could not start. Use manual code entry.';
  }
}

export const Step2Scanner: React.FC<Step2ScannerProps> = ({
  active,
  onScanResult,
  onShowToast,
  onOpenCameraGuide,
}) => {
  const [scannerOpen, setScannerOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualSignal, setManualSignal] = useState('');
  const [zoomCap, setZoomCap] = useState<ZoomCapability | null>(null);
  const [zoomValue, setZoomValue] = useState(1);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const manualInputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startingRef = useRef(false);
  const scanGenRef = useRef(0);
  const pinchRef = useRef<{ dist: number; zoom: number } | null>(null);

  const stopScanner = useCallback(() => {
    scanGenRef.current += 1;
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    trackRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    pinchRef.current = null;
    setZoomCap(null);
    setScannerOpen(false);
  }, []);

  useEffect(() => {
    if (!active) {
      stopScanner();
      setManualOpen(false);
    }
  }, [active, stopScanner]);

  useEffect(() => {
    return () => stopScanner();
  }, [stopScanner]);

  const applyZoom = useCallback(async (val: number) => {
    const track = trackRef.current;
    if (!track || !zoomCap) return;
    const clamped = Math.min(Math.max(val, zoomCap.min), zoomCap.max);
    try {
      await track.applyConstraints({
        advanced: [{ zoom: clamped } as unknown as MediaTrackConstraintSet],
      });
      setZoomValue(clamped);
    } catch {
      // ignore unsupported zoom constraints
    }
  }, [zoomCap]);

  const startScanner = async () => {
    if (streamRef.current || startingRef.current) return;
    startingRef.current = true;
    const gen = scanGenRef.current;
    let stream: MediaStream | null = null;

    try {
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        const err = new Error('Camera API unavailable');
        err.name = window.isSecureContext ? 'NotSupportedError' : 'SecurityError';
        throw err;
      }

      const permState = await getCameraPermissionState();
      if (permState === 'denied') {
        const err = new Error('Camera permission denied');
        err.name = 'NotAllowedError';
        throw err;
      }

      stream = await requestCameraStream();
      if (gen !== scanGenRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      streamRef.current = stream;
      playSound('scanStart');
      setScannerOpen(true);

      await new Promise((r) => requestAnimationFrame(r));
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) {
        stopScanner();
        return;
      }

      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        // mobile browsers may warm up first
      }

      if (gen !== scanGenRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      if (video.readyState < video.HAVE_CURRENT_DATA) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('Camera stream did not produce video frames'));
          }, 10000);
          const onLoaded = () => {
            cleanup();
            resolve();
          };
          const onErr = () => {
            cleanup();
            reject(video.error || new Error('Camera video could not be played'));
          };
          const cleanup = () => {
            clearTimeout(timeout);
            video.removeEventListener('loadeddata', onLoaded);
            video.removeEventListener('error', onErr);
          };
          video.addEventListener('loadeddata', onLoaded, { once: true });
          video.addEventListener('error', onErr, { once: true });
        });
      }

      if (gen !== scanGenRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      const track = stream.getVideoTracks()[0];
      if (track && typeof track.getCapabilities === 'function') {
        try {
          const caps = track.getCapabilities() as MediaTrackCapabilities & { zoom?: ZoomCapability };
          if (caps && caps.zoom) {
            trackRef.current = track;
            setZoomCap(caps.zoom);
            const settings =
              typeof track.getSettings === 'function'
                ? (track.getSettings() as MediaTrackSettings & { zoom?: number })
                : {};
            setZoomValue(settings.zoom || caps.zoom.min);
          }
        } catch {
          // iOS Safari fallback
        }
      }

      const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
      const SCAN_WIDTH = 640;
      const SCAN_HEIGHT = 480;
      canvas.width = SCAN_WIDTH;
      canvas.height = SCAN_HEIGHT;

      intervalRef.current = setInterval(() => {
        if (!videoRef.current || !ctx || videoRef.current.readyState !== videoRef.current.HAVE_ENOUGH_DATA) {
          return;
        }
        try {
          ctx.drawImage(videoRef.current, 0, 0, SCAN_WIDTH, SCAN_HEIGHT);
          const imageData = ctx.getImageData(0, 0, SCAN_WIDTH, SCAN_HEIGHT);
          const code = jsQR(imageData.data, SCAN_WIDTH, SCAN_HEIGHT);
          if (code && code.data) {
            onScanResult(code.data);
          }
        } catch {
          // ignore single frame error
        }
      }, 300);
    } catch (error) {
      if (gen !== scanGenRef.current) {
        stream?.getTracks().forEach((t) => t.stop());
        return;
      }
      stopScanner();
      const errName = (error as { name?: string })?.name || '';
      if (['NotAllowedError', 'PermissionDeniedError', 'SecurityError', 'NotSupportedError'].includes(errName)) {
        onOpenCameraGuide(errName === 'NotSupportedError' ? 'inapp' : 'permission');
      } else {
        onShowToast(cameraErrorMessage(error), 'error');
        setManualOpen(true);
      }
    } finally {
      startingRef.current = false;
    }
  };

  const handleOpenManual = () => {
    playSound('click');
    setManualOpen(true);
    setTimeout(() => manualInputRef.current?.focus(), 50);
  };

  const handleSubmitManual = () => {
    const trimmed = manualSignal.trim().toUpperCase();
    if (!trimmed) {
      onShowToast('Enter a valid Signal ID', 'error');
      return;
    }
    if (trimmed.length > 50) {
      onShowToast('Max 50 characters', 'error');
      return;
    }
    onScanResult(trimmed);
    setManualSignal('');
    setManualOpen(false);
  };

  return (
    <div id="step2" className={`flow-step${active ? ' active' : ''} h-full`}>
      <div className="min-h-full w-full flex flex-col justify-center items-center gap-5 p-4 sm:p-6 text-center">
        <div className="space-y-1">
          <h2 className="font-pixel text-[#fef08a] tracking-widest uppercase text-xs sm:text-sm">
            Signal Tracking
          </h2>
          <p className="font-mono text-[11px] sm:text-xs text-slate-300">
            Scan field QR tag to decrypt next station
          </p>
        </div>

        <div className="qr-radar mx-auto shrink-0 my-1">
          <div className="qr-radar-scan"></div>
          <div className="qr-radar-scan" style={{ animationDelay: '0.6s' }}></div>
          <div className="qr-radar-scan" style={{ animationDelay: '1.2s' }}></div>
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-[46%] h-[46%] border-2 border-[#fef08a]/50 rounded-xl flex items-center justify-center bg-[#0b1410] shadow-lg">
              <span className="material-symbols-rounded text-[#fef08a] text-[clamp(28px,7vmin,48px)]">
                qr_code_scanner
              </span>
            </div>
          </div>
        </div>

        <div className="w-full max-w-[320px] space-y-2.5 shrink-0">
          <button
            type="button"
            onClick={() => {
              playSound('click');
              void startScanner();
            }}
            className="btn-pokedex w-full flex items-center justify-center gap-2 py-3 text-xs sm:text-sm min-h-[48px]"
          >
            <span className="material-symbols-rounded text-base sm:text-lg md:text-xl">radar</span>
            ACTIVATE SENSORS
          </button>
          <button
            type="button"
            onClick={handleOpenManual}
            className="crt-btn-secondary w-full flex items-center justify-center gap-2 py-3 text-[10px] sm:text-xs uppercase tracking-wider"
          >
            <span className="material-symbols-rounded text-base text-[#fef08a] font-variation-settings 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24">key</span>
            Manual Override
          </button>
        </div>
      </div>

      {/* QR Scanner Overlay */}
      <div
        id="qrScannerContainer"
        className={`${scannerOpen ? '' : 'hidden '}absolute inset-0 z-[130] bg-black`}
        onTouchStart={(e) => {
          if (e.touches.length === 2 && zoomCap) {
            const d = Math.hypot(
              e.touches[0].pageX - e.touches[1].pageX,
              e.touches[0].pageY - e.touches[1].pageY
            );
            pinchRef.current = { dist: d, zoom: zoomValue };
          }
        }}
        onTouchMove={(e) => {
          if (e.touches.length === 2 && pinchRef.current && zoomCap) {
            const d = Math.hypot(
              e.touches[0].pageX - e.touches[1].pageX,
              e.touches[0].pageY - e.touches[1].pageY
            );
            const delta = (d - pinchRef.current.dist) / 100;
            void applyZoom(pinchRef.current.zoom + delta);
          }
        }}
        onTouchEnd={() => {
          pinchRef.current = null;
        }}
      >
        <div className="relative h-full w-full overflow-hidden flex flex-col">
          <video ref={videoRef} id="qrVideo" className="w-full h-full object-cover" />
          <canvas ref={canvasRef} id="qrCanvas" className="hidden" />
          <div className="absolute inset-0 flex flex-col">
            <div className="flex justify-between items-start p-3 sm:p-4">
              <div className="bg-[#0e1915]/95 px-3 py-2 rounded-lg border border-[#2e4a3d] shadow-lg">
                <p className="font-pixel text-[#fef08a] text-[10px] sm:text-xs uppercase">Scanner Active</p>
              </div>
              <button
                type="button"
                aria-label="Close scanner"
                onClick={() => {
                  playSound('click');
                  stopScanner();
                }}
                className="bg-red-700/90 text-white p-2 sm:p-2.5 rounded-lg border border-red-400/30 min-h-[44px] min-w-[44px] flex items-center justify-center"
              >
                <span className="material-symbols-rounded text-lg sm:text-xl md:text-2xl">close</span>
              </button>
            </div>
            <div className="flex-1 flex items-center justify-center p-4">
              <div className="relative w-full aspect-square max-w-48 sm:max-w-64">
                <div className="absolute inset-0 border-2 border-[#fef08a]/40 rounded-lg"></div>
                <div className="absolute top-0 left-0 w-6 h-6 sm:w-8 sm:h-8 border-t-3 border-l-3 border-[#fef08a]"></div>
                <div className="absolute bottom-0 right-0 w-6 h-6 sm:w-8 sm:h-8 border-b-3 border-r-3 border-[#fef08a]"></div>
                <div className="absolute top-0 left-0 w-full h-0.5 bg-[#fef08a]/85 animate-scanline"></div>
              </div>
            </div>
            <div id="zoomControlContainer" className={`${zoomCap ? '' : 'hidden '}px-5 pb-2`}>
              <div className="flex items-center gap-2 bg-[#0e1915]/95 rounded-lg px-3 py-2 border border-[#2e4a3d] shadow-lg">
                <span className="material-symbols-rounded text-[#fef08a]/70 text-base sm:text-lg select-none">remove</span>
                <div className="flex-1 relative flex items-center">
                  <input
                    type="range"
                    id="qrZoomSlider"
                    min={zoomCap?.min ?? 1}
                    max={zoomCap?.max ?? 5}
                    step={zoomCap?.step ?? 0.1}
                    value={zoomValue}
                    onChange={(e) => void applyZoom(parseFloat(e.target.value))}
                    className="w-full h-2 rounded cursor-pointer"
                  />
                </div>
                <span className="material-symbols-rounded text-[#fef08a]/70 text-base sm:text-lg select-none">add</span>
              </div>
            </div>
            <div className="p-3 sm:p-4 text-center bg-[#09110e]/85 border-t border-[#2e4a3d]">
              <p className="font-mono text-white text-xs sm:text-sm font-medium">Point camera at QR code</p>
              <p className="text-slate-400 text-[10px] sm:text-xs font-mono mt-0.5">Make sure code is inside the frame</p>
            </div>
          </div>
        </div>
      </div>

      {/* Manual Entry Overlay */}
      <div
        id="manualEntryContainer"
        className={`${manualOpen ? '' : 'hidden '}crt-modal-scrim z-[120]`}
      >
        <div className="crt-card w-full max-w-[350px] animate-fade-in">
          <h3 className="font-pixel text-[#fef08a] text-xs uppercase tracking-wider text-center mb-1.5">
            Manual Override
          </h3>
          <p className="font-mono text-[11px] text-slate-300 mb-4 text-center">
            Enter Signal ID printed beside the sector QR station.
          </p>
          <div className="mb-4">
            <label className="crt-label" htmlFor="manualSignalId">
              Signal ID
            </label>
            <input
              ref={manualInputRef}
              type="text"
              id="manualSignalId"
              value={manualSignal}
              onChange={(e) => setManualSignal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleSubmitManual();
                }
              }}
              className="crt-input p-3 text-sm sm:text-base uppercase min-h-[44px]"
              placeholder="ENTER SIGNAL ID"
              autoComplete="off"
              maxLength={50}
              autoCapitalize="characters"
            />
          </div>
          <div className="flex gap-2.5">
            <button
              type="button"
              onClick={handleSubmitManual}
              className="btn-pokedex flex-1 py-3 text-xs sm:text-sm"
            >
              DECODE
            </button>
            <button
              type="button"
              onClick={() => {
                playSound('click');
                setManualOpen(false);
              }}
              className="crt-btn-secondary flex-1 py-3 text-[10px] sm:text-xs"
            >
              CANCEL
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
