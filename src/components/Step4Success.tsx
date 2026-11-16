import React, { useCallback, useEffect, useRef } from 'react';
import confetti from 'canvas-confetti';
import {
  getAudioContextTime,
  getCelebrationDuration,
  playFinalCelebration,
  playSound,
  speakCatch,
  stopCatchVoice,
} from '../services/audio';
import { Pokemon3DPokeballReveal } from './Pokemon3DPokeballReveal';
import type { Puzzle } from '../types/game';

interface Step4SuccessProps {
  active: boolean;
  puzzle: Puzzle | null;
  nextPuzzles: Puzzle[];
  missionLevel: string;
  revealKey: number;
  isLoggedIn: boolean;
  celebrationCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  screenRef: React.RefObject<HTMLDivElement | null>;
  onContinueToQRScan: () => void;
}

const CELEBRATION_BLASTS = [
  0, 3.45, 3.94, 4.44, 4.93, 5.43, 5.93, 6.42, 7.41, 7.91, 8.41, 9.4, 10.39,
  10.89, 11.38, 11.88, 12.62, 13.37, 14.01, 14.85, 15.75,
];
const CELEBRATION_SPARKS = [
  0.48, 0.97, 1.48, 1.97, 2.95, 4.68, 6.91, 8.9, 9.89, 11.63, 12.15, 13.86,
  14.38, 16.21, 17.42,
];
const CELEBRATION_BLAST_X = [0.5, 0.2, 0.8];

export const Step4Success: React.FC<Step4SuccessProps> = ({
  active,
  puzzle,
  nextPuzzles,
  missionLevel,
  revealKey,
  isLoggedIn,
  celebrationCanvasRef,
  screenRef,
  onContinueToQRScan,
}) => {
  const washRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const confettiFnRef = useRef<ReturnType<typeof confetti.create> | null>(null);
  const aliveRef = useRef<boolean>(false);

  const isEnd =
    !puzzle ||
    !Array.isArray(puzzle.nextPuzzleId) ||
    puzzle.nextPuzzleId.length === 0;

  const levelNum =
    puzzle && typeof puzzle.level === 'number'
      ? puzzle.level
      : (missionLevel || 'L1').split('_')[0].replace('L', '') || '1';

  const triggerCelebration = useCallback(() => {
    if (!aliveRef.current) return;
    const audioStart = playFinalCelebration(1);
    const prefersReducedMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) return;

    const canvas = celebrationCanvasRef.current;
    const screenEl = screenRef.current;
    if (!canvas || !screenEl) return;

    canvas.width = screenEl.clientWidth;
    canvas.height = screenEl.clientHeight;

    if (!confettiFnRef.current) {
      confettiFnRef.current = confetti.create(canvas, {
        resize: true,
        useWorker: false,
      });
    }
    const myConfetti = confettiFnRef.current;

    const wash = washRef.current;
    if (wash) {
      wash.style.transition = 'none';
      wash.style.opacity = '0.2';
      window.requestAnimationFrame(() => {
        if (!washRef.current) return;
        washRef.current.style.transition = 'opacity 1.4s ease';
        washRef.current.style.opacity = '0';
      });
    }

    const colors = [
      '#ff0000',
      '#3b82f6',
      '#ffd700',
      '#22c55e',
      '#a855f7',
      '#ffffff',
      '#f97316',
    ];

    const hasAudioClock = audioStart != null && getAudioContextTime() != null;
    const clock = hasAudioClock
      ? () => getAudioContextTime() as number
      : () => Date.now() / 1000;
    const base = audioStart != null ? audioStart : Date.now() / 1000;

    const schedule: Array<[number, 'blast' | 'star']> = [];
    CELEBRATION_BLASTS.forEach((t) => schedule.push([t, 'blast']));
    CELEBRATION_SPARKS.forEach((t) => schedule.push([t, 'star']));
    schedule.sort((a, b) => a[0] - b[0]);

    const lastHit = schedule.length ? schedule[schedule.length - 1][0] : 0;
    const trackDur = getCelebrationDuration();
    let displayEnd = lastHit + 1.0;
    if (trackDur) displayEnd = Math.min(displayEnd, trackDur);

    const blastAt = (x: number) =>
      myConfetti({
        particleCount: 140,
        startVelocity: 45,
        spread: 90,
        origin: { x, y: 0.7 },
        colors,
        gravity: 1.2,
      });

    const starAt = (x: number, y: number) =>
      myConfetti({
        particleCount: 40,
        spread: 100,
        origin: { x, y },
        shapes: ['star'],
        colors: ['#FFEAB0', '#FFF9E3', '#FACC15'],
      });

    let si = 0;
    let blastCount = 0;
    let nextFountainAt = 0;

    const frame = () => {
      if (!aliveRef.current) return;
      const elapsed = clock() - base;

      while (si < schedule.length && elapsed >= schedule[si][0]) {
        if (elapsed - schedule[si][0] <= 0.12) {
          if (schedule[si][1] === 'blast') {
            blastAt(CELEBRATION_BLAST_X[blastCount++ % CELEBRATION_BLAST_X.length]);
          } else {
            starAt(Math.random(), Math.random() - 0.2);
          }
        }
        si++;
      }

      if (elapsed < displayEnd) {
        if (elapsed >= nextFountainAt) {
          myConfetti({
            particleCount: 5,
            angle: 60,
            spread: 55,
            origin: { x: 0, y: 1 },
            colors,
          });
          myConfetti({
            particleCount: 5,
            angle: 120,
            spread: 55,
            origin: { x: 1, y: 1 },
            colors,
          });
          nextFountainAt = elapsed + 0.1;
        }
        rafRef.current = window.requestAnimationFrame(frame);
      }
    };

    rafRef.current = window.requestAnimationFrame(frame);
  }, [celebrationCanvasRef, screenRef]);

  useEffect(() => {
    const clearEffects = () => {
      aliveRef.current = false;
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      stopCatchVoice();
      try {
        confettiFnRef.current?.reset();
      } catch {
        // ignore confetti reset error
      }
    };

    if (!active || !isLoggedIn || !puzzle) {
      clearEffects();
      return;
    }

    clearEffects();
    aliveRef.current = true;

    return () => {
      clearEffects();
    };
  }, [active, isLoggedIn, puzzle, revealKey]);

  const handleDropImpact = useCallback((volume: number) => {
    playSound('pokeballDrop', volume);
  }, []);

  const handleBallOpen = useCallback(() => {
    playSound('pokeballOpen');
    if (isEnd) {
      triggerCelebration();
    }
  }, [isEnd, triggerCelebration]);

  const handlePokemonEmerge = useCallback(() => {
    speakCatch(puzzle?.pokemonName || '', !isEnd);
  }, [puzzle?.pokemonName, isEnd]);

  const stageActive = active && isLoggedIn && Boolean(puzzle);

  return (
    <>
      <div ref={washRef} className="celebration-wash" style={{ opacity: 0 }}></div>
      <div
        id="step4"
        className={`flow-step${active ? ' active' : ''} relative flex-1 min-h-0 h-full overflow-y-auto overflow-x-hidden`}
      >
        <div className="step4-success-layout relative flex min-h-full flex-col items-center justify-center gap-3 px-3 py-3 text-center sm:px-6 sm:py-4">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
            <div className="absolute left-[10%] top-[10%] size-2 rounded-full bg-yellow-300 animate-ping" />
            <div className="absolute right-[10%] top-[20%] size-3 rounded-full bg-white opacity-60 animate-pulse [animation-delay:500ms]" />
            <div className="absolute bottom-[25%] left-[15%] size-2 rounded-full bg-blue-300 animate-ping [animation-delay:1200ms]" />
            <div className="absolute bottom-[10%] right-[20%] size-2 rounded-full bg-purple-300 opacity-60 animate-pulse [animation-delay:800ms]" />
            <div className="absolute left-[5%] top-[40%] size-1.5 rounded-full bg-yellow-400 animate-ping [animation-delay:2000ms]" />
            <div className="absolute bottom-[40%] right-[5%] size-2 rounded-full bg-blue-400 animate-pulse [animation-delay:1500ms]" />
            <div className="perfect-sparkle sparkle-gold absolute left-[15%] top-[20%] size-3 sm:size-4 animate-twinkle [animation-duration:2s]" />
            <div className="perfect-sparkle sparkle-white absolute right-[10%] top-[40%] size-2 sm:size-3 animate-twinkle [animation-delay:300ms] [animation-duration:1.8s]" />
            <div className="perfect-sparkle sparkle-blue absolute bottom-[30%] left-[10%] size-1.5 sm:size-2 animate-twinkle [animation-delay:700ms] [animation-duration:2.5s]" />
            <div className="perfect-sparkle sparkle-gold absolute bottom-[40%] right-[15%] size-2 sm:size-3 animate-twinkle [animation-delay:1100ms] [animation-duration:2.2s]" />
            <div className="perfect-sparkle sparkle-purple absolute right-[25%] top-[15%] size-2 animate-twinkle [animation-delay:500ms] [animation-duration:3s]" />
            <div className="perfect-sparkle sparkle-blue absolute bottom-[15%] left-[30%] size-1.5 animate-twinkle [animation-delay:1800ms] [animation-duration:2.8s]" />
            <div className="perfect-sparkle sparkle-white absolute size-2 animate-twinkle" style={{ left: '7%', top: '28%', animationDelay: '900ms', animationDuration: '2.4s' }} />
            <div className="perfect-sparkle sparkle-gold absolute size-1.5 animate-twinkle" style={{ left: '26%', top: '8%', animationDelay: '1400ms', animationDuration: '1.9s' }} />
            <div className="perfect-sparkle sparkle-blue absolute size-2 animate-twinkle" style={{ left: '42%', top: '18%', animationDelay: '250ms', animationDuration: '2.7s' }} />
            <div className="perfect-sparkle sparkle-purple absolute size-1.5 animate-twinkle" style={{ left: '64%', top: '9%', animationDelay: '1700ms', animationDuration: '2.1s' }} />
            <div className="perfect-sparkle sparkle-gold absolute size-2 animate-twinkle" style={{ left: '83%', top: '29%', animationDelay: '650ms', animationDuration: '2.6s' }} />
            <div className="perfect-sparkle sparkle-white absolute size-1.5 animate-twinkle" style={{ left: '92%', top: '58%', animationDelay: '1250ms', animationDuration: '2.3s' }} />
            <div className="perfect-sparkle sparkle-purple absolute size-2 animate-twinkle" style={{ left: '73%', top: '72%', animationDelay: '350ms', animationDuration: '2.9s' }} />
            <div className="perfect-sparkle sparkle-blue absolute size-1.5 animate-twinkle" style={{ left: '48%', top: '84%', animationDelay: '1550ms', animationDuration: '2.2s' }} />
            <div className="perfect-sparkle sparkle-gold absolute size-2 animate-twinkle" style={{ left: '19%', top: '71%', animationDelay: '1050ms', animationDuration: '2.5s' }} />
            <div className="perfect-sparkle sparkle-white absolute size-1.5 animate-twinkle" style={{ left: '4%', top: '57%', animationDelay: '1950ms', animationDuration: '2s' }} />
            <div className="absolute left-1/2 top-1/2 size-48 sm:size-64 -translate-x-1/2 -translate-y-1/2 rounded-full border border-yellow-400/10 animate-spin-slow" />
            <div className="absolute left-1/2 top-1/2 size-56 sm:size-72 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-full border border-blue-400/10 animate-spin-slow [animation-direction:reverse] [animation-duration:15s]" />
          </div>
          {/* 3D Holographic Platform + 3D Pokéball + Scarlet-Violet WebP Stage */}
          <div className="step4-pokemon-stage relative z-10 flex w-full shrink-0 flex-col items-center justify-center">
            <Pokemon3DPokeballReveal
              active={stageActive}
              pokemonId={puzzle?.pokemonId}
              pokemonLink={puzzle?.pokemonLink}
              pokemonName={puzzle?.pokemonName ? `${puzzle.pokemonName} sprite` : 'Terapagos'}
              revealKey={revealKey}
              onDropImpact={handleDropImpact}
              onBallOpen={handleBallOpen}
              onPokemonEmerge={handlePokemonEmerge}
            />
          </div>

          {/* Main Content Section */}
          <div className="step4-success-content z-10 flex w-full shrink-0 flex-col items-center gap-3 px-1">
            <div>
              <h2 className="font-pixel text-xs sm:text-sm tracking-wider text-[#fef08a] uppercase">
                Decryption Successful
              </h2>
              {puzzle?.pokemonName && (
                <p className="font-mono text-xs text-emerald-300 mt-1">
                  Captured <span className="font-bold text-white">{puzzle.pokemonName}</span>!
                </p>
              )}
            </div>

            {/* Single Destination Signal Card */}
            <div
              id="locationCard"
              className={`${
                nextPuzzles.length === 1 ? '' : 'hidden '
              }location-card-glow w-full max-w-[380px] rounded-xl border px-3.5 py-3 text-left`}
            >
              <div className="flex items-center gap-3">
                <div className="flex w-9 h-9 shrink-0 items-center justify-center rounded-lg border border-amber-500/40 bg-amber-500/10">
                  <span className="material-symbols-rounded text-lg sm:text-xl text-[#fef08a]">
                    location_on
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <span className="block font-mono text-[10px] font-bold uppercase tracking-widest text-amber-300/80 mb-0.5">
                    Signal Source
                  </span>
                  <p
                    id="locationClueText"
                    className={`${
                      nextPuzzles.length === 1 ? '' : 'hidden '
                    }font-pixel text-xs sm:text-sm text-white leading-snug break-words`}
                  >
                    {nextPuzzles[0]?.locationClue || 'NO SIGNAL SOURCE'}
                  </p>
                </div>
              </div>
            </div>

            {/* Branching Multiple Destinations */}
            <div
              id="nextLocationList"
              className={`${
                nextPuzzles.length > 1 ? '' : 'hidden '
              }flex w-full flex-col items-center gap-2.5`}
            >
              {nextPuzzles.map((np) => (
                <div
                  key={np.id}
                  className="location-card-glow mx-auto w-full max-w-[380px] rounded-xl border px-3.5 py-2.5 text-left"
                >
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 bg-amber-500/10 rounded-lg flex items-center justify-center border border-amber-500/40 shrink-0">
                      <span className="material-symbols-rounded text-[#fef08a] text-lg">
                        location_on
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="block font-mono text-[10px] font-bold uppercase tracking-widest text-amber-300/80 mb-0.5">
                        Next Location
                      </span>
                      <p className="font-pixel text-white leading-snug break-words text-xs sm:text-sm">
                        {(np.locationClue || 'NO SIGNAL SOURCE').toUpperCase()}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Completion Trophy Celebration */}
          <div
            id="completionMessage"
            className={`${isEnd ? '' : 'hidden '}relative w-full max-w-[380px] z-20 animate-fade-in overflow-hidden rounded-xl border border-yellow-500/50 bg-black/70 p-4 shadow-[0_0_25px_rgba(234,179,8,0.35)] backdrop-blur-xl`}
          >
            <div className="flex flex-col items-center text-center">
              <div className="relative mb-2 flex w-16 h-16 sm:w-20 sm:h-20 items-center justify-center">
                <div className="absolute inset-0 rounded-full bg-yellow-400/20 blur-xl animate-pulse" />
                <img
                  id="completionTrophyImg"
                  src="/assets/img/poketropy.webp"
                  alt="Level Trophy"
                  width={80}
                  height={80}
                  loading="eager"
                  decoding="async"
                  className="relative z-10 w-full h-full object-contain drop-shadow-[0_0_15px_rgba(234,179,8,0.8)]"
                />
                <div className="gemini-shine shine-1" />
                <div className="gemini-shine shine-2" />
                <div className="gemini-shine shine-3" />
                <div className="gemini-shine shine-4" />
                <div className="gemini-shine shine-5" />
                <div className="gemini-shine shine-6" />
              </div>

              <h3
                id="completionLevelTitle"
                className="font-pixel text-xs sm:text-sm tracking-tight text-yellow-300 uppercase"
              >
                Level {levelNum} Champion
              </h3>
              <p
                id="completionLevelSub"
                className="mt-0.5 text-[9px] sm:text-[10px] font-black tracking-widest text-blue-200 uppercase"
              >
                You have completed Level {levelNum}!
              </p>

              <div className="mt-3 flex gap-1.5" aria-hidden="true">
                <div className="size-1.5 rounded-full bg-yellow-400 animate-ping" />
                <div className="size-1.5 rounded-full bg-blue-400 animate-ping [animation-delay:500ms]" />
                <div className="size-1.5 rounded-full bg-yellow-400 animate-ping [animation-delay:1000ms]" />
              </div>
            </div>
          </div>

          {/* Primary Call To Action */}
          <button
            type="button"
            id="nextSignalBtn"
            onClick={onContinueToQRScan}
            onMouseDown={() => playSound('click')}
            className={`${
              isEnd ? 'hidden ' : ''
            }btn-pokedex relative z-10 w-full max-w-[380px] shrink-0 py-3 font-pixel text-xs sm:text-sm tracking-wider uppercase transition-transform active:scale-95`}
          >
            Scan Next Signal
          </button>
        </div>
      </div>
    </>
  );
};
