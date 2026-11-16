import React, { useEffect } from 'react';
import { playSound } from '../services/audio';
import { prefetchPokemonSprite } from '../services/gameBackend';
import { HINT_SETTINGS, type LanguageCode, type Puzzle } from '../types/game';

interface Step3PuzzleProps {
  active: boolean;
  puzzle: Puzzle | null;
  language: LanguageCode;
  questionText: string;
  elapsedSeconds: number;
  tabSwitchCount: number;
  answerValue: string;
  onAnswerChange: (val: string) => void;
  onSubmitAnswer: (e: React.FormEvent) => void;
  shakeAnswer: boolean;
  answerInputRef: React.RefObject<HTMLInputElement | null>;
  hasHint: boolean;
  hintRequestOpen: boolean;
  hintPenaltyOpen: boolean;
  hintPenaltySeconds: number;
  hintPenaltyRingIteration: number;
  hintFocusLost: boolean;
  hintDisplayOpen: boolean;
  hintText: string;
  terminalLocked: boolean;
  onRequestHint: () => void;
  onConfirmHintRequest: () => void;
  onCancelHintRequest: () => void;
  onCloseHintPopup: () => void;
}

function formatMMSS(totalSec: number): string {
  const safe = Math.max(0, Math.floor(totalSec));
  const mins = Math.floor(safe / 60)
    .toString()
    .padStart(2, '0');
  const secs = (safe % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}

export const Step3Puzzle: React.FC<Step3PuzzleProps> = ({
  active,
  puzzle,
  language,
  questionText,
  elapsedSeconds,
  tabSwitchCount,
  answerValue,
  onAnswerChange,
  onSubmitAnswer,
  shakeAnswer,
  answerInputRef,
  hasHint,
  hintRequestOpen,
  hintPenaltyOpen,
  hintPenaltySeconds,
  hintPenaltyRingIteration,
  hintFocusLost,
  hintDisplayOpen,
  hintText,
  terminalLocked,
  onRequestHint,
  onConfirmHintRequest,
  onCancelHintRequest,
  onCloseHintPopup,
}) => {
  const penaltyTotal =
    puzzle?.hintPenalty && puzzle.hintPenalty > 0
      ? puzzle.hintPenalty
      : HINT_SETTINGS.defaultPenalty;

  const anyHintOverlayVisible = hintRequestOpen || hintPenaltyOpen || hintDisplayOpen;

  useEffect(() => {
    if (active && puzzle?.pokemonLink) {
      prefetchPokemonSprite(puzzle.pokemonLink);
    }
  }, [active, puzzle?.pokemonLink]);

  return (
    <>
      <div id="step3" className={`flow-step${active ? ' active' : ''} h-full relative overflow-hidden`}>
        <div className="flex flex-col h-full relative z-10 p-2 sm:p-3 overflow-hidden">
          <div className="flex justify-between items-center mb-2 px-2 shrink-0 border-b border-green-500/30 pb-1.5 font-mono">
            <span className="text-green-500 text-xs sm:text-sm truncate pr-2">
              &gt;_ TERMINAL
            </span>
            <span
              id="langBadge"
              className="text-[8px] sm:text-[9px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-400 border border-green-500/20 font-bold"
            >
              {language === 'CPP' ? 'C++' : 'PYTHON'}
            </span>
            <div className="flex items-center gap-2">
              <div id="tabWarning" className={tabSwitchCount > 0 ? 'flex items-center animate-pulse' : 'hidden'}>
                <span className="material-symbols-rounded text-red-500 text-sm sm:text-base">warning</span>
              </div>
              <span id="puzzleTimer" className="text-green-500 text-xs sm:text-sm font-mono tabular-nums">
                {formatMMSS(elapsedSeconds)}
              </span>
            </div>
          </div>

          <div
            className={`code-terminal${active ? ' glow-active' : ''} flex-1 p-2.5 sm:p-3.5 mb-2.5 transition-all duration-200${
              terminalLocked ? ' blur-md opacity-25 pointer-events-none select-none' : ''
            }`}
          >
            {/* Subtle Dull Pokémon Battle Ground Arena Backdrop */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-0 opacity-40">
              <div className="cyber-pokeball">
                <div className="cyber-orbit"></div>
                <div id="step4Pokeball" className={`pixel-pokeball${puzzle ? '' : ' hidden'}`}>
                  <div className="pokeball-btn"></div>
                </div>
              </div>
            </div>

            <pre
              id="puzzleQuestion"
              className="flex-1 overflow-y-auto scrollable text-green-300 text-xs sm:text-sm leading-relaxed font-mono whitespace-pre-wrap break-words unselectable relative z-10 p-1"
            >
              {questionText || 'Loading puzzle data...'}
            </pre>
          </div>

          <form
            id="answerForm"
            onSubmit={onSubmitAnswer}
            className={`shrink-0 w-full mt-auto transition-all duration-200${
              terminalLocked ? ' opacity-25 pointer-events-none select-none' : ''
            }`}
          >
            <div className="flex flex-row gap-2 sm:gap-2.5 items-stretch">
              <button
                type="button"
                id="hintRequestBtn"
                disabled={terminalLocked}
                onClick={onRequestHint}
                aria-label="Request Hint"
                className={`${
                  hasHint ? '' : 'hidden '
                }crt-btn-secondary !bg-[#0b1410] !border-[#facc15] !border-b-[#facc15] !text-[#fef08a] hover:!bg-[#13231b] flex items-center justify-center relative z-20 min-h-[44px] min-w-[46px] order-1 px-2.5 shadow-[0_0_10px_rgba(250,204,21,0.16)]`}
              >
                <span className="material-symbols-rounded text-lg sm:text-xl">lightbulb</span>
              </button>

              <div className="flex-1 min-w-0 order-2">
                <input
                  ref={answerInputRef}
                  type="text"
                  id="puzzleAnswer"
                  disabled={terminalLocked}
                  value={answerValue}
                  onChange={(e) => onAnswerChange(e.target.value)}
                  className={`crt-input h-full px-3 sm:px-4 py-2.5 text-sm sm:text-base uppercase min-h-[44px]${
                    shakeAnswer ? ' animate-shake' : ''
                  }`}
                  placeholder="ENTER SOLUTION"
                  autoComplete="off"
                  required
                  maxLength={50}
                  autoCapitalize="characters"
                />
              </div>

              <button
                type="submit"
                disabled={terminalLocked}
                aria-label="Submit Answer"
                onMouseDown={() => playSound('click')}
                className="btn-pokedex flex items-center justify-center min-h-[44px] min-w-[48px] order-3 px-3.5"
              >
                <span className="material-symbols-rounded text-lg sm:text-xl">send</span>
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* Hint System Overlays */}
      <div id="hintContainer" className={anyHintOverlayVisible ? '' : 'hidden'}>
        {/* Hint Request Overlay */}
        <div
          id="hintRequestOverlay"
          className={`${hintRequestOpen ? '' : 'hidden '}absolute inset-0 z-[90] glass-panel flex flex-col items-center justify-center p-4`}
        >
          <div className="w-full max-w-xs sm:max-w-sm rounded-xl border-2 border-yellow-600/50 bg-gray-900/90 p-4 sm:p-5 text-center animate-fade-in">
            <span className="material-symbols-rounded text-yellow-500 text-3xl sm:text-4xl">
              lightbulb
            </span>
            <h3 className="font-pixel text-yellow-500 text-sm sm:text-base my-3">
              Hint Request
            </h3>
            <p className="text-gray-400 text-xs sm:text-sm mb-4">
              Requires <span id="hintPenaltyTime" className="font-bold">{penaltyTotal}</span>s processing time. Stay on screen.
            </p>
            <div className="flex gap-2 sm:gap-3">
              <button
                type="button"
                onClick={onConfirmHintRequest}
                onMouseDown={() => playSound('click')}
                className="min-h-[44px] flex-1 rounded-lg bg-yellow-600 py-3 sm:py-4 text-sm sm:text-base font-bold text-black transition-colors hover:bg-yellow-700"
              >
                PROCEED
              </button>
              <button
                type="button"
                onClick={onCancelHintRequest}
                onMouseDown={() => playSound('click')}
                className="min-h-[44px] flex-1 rounded-lg bg-gray-800 py-3 sm:py-4 text-sm sm:text-base text-white transition-colors hover:bg-gray-700"
              >
                CANCEL
              </button>
            </div>
          </div>
        </div>

        {/* Hint Penalty Overlay (Brock's Training Focus Stage) */}
        <div
          id="hintPenaltyOverlay"
          className={`${hintPenaltyOpen ? '' : 'hidden '}absolute inset-0 z-[95] flex flex-col items-center justify-center p-4 backdrop-blur-3xl`}
        >
          <div className="relative w-full max-w-xs sm:max-w-sm overflow-hidden rounded-xl border border-amber-500/30 bg-[#090807]/95 p-6 sm:p-8 text-center backdrop-blur-sm animate-fade-in">
            <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-br from-stone-900/80 via-amber-900/20 to-stone-900/80" />
            <img
              src="/assets/img/brock.webp"
              alt=""
              width={240}
              height={280}
              loading="lazy"
              decoding="async"
              className="pointer-events-none absolute inset-0 m-auto h-[70%] max-h-64 object-contain opacity-[0.10]"
            />

            <div className="relative z-10">
              <div className="mb-8">
                <h2 className="font-pixel text-amber-400 text-lg sm:text-xl uppercase tracking-widest mb-2">
                  Gym Training
                </h2>
                <p className="text-xs sm:text-sm text-gray-400 uppercase">Brock&apos;s Discipline</p>
              </div>

              <div className="relative mx-auto mb-8 h-40 w-40 sm:h-48 sm:w-48">
                <svg className="h-full w-full -rotate-90" viewBox="0 0 100 100" aria-hidden="true">
                  <circle cx="50" cy="50" r="45" stroke="rgba(245,158,11,0.2)" strokeWidth="4" fill="none" />
                  <circle
                    key={hintPenaltyRingIteration}
                    cx="50"
                    cy="50"
                    r="45"
                    stroke="#f59e0b"
                    strokeWidth="4"
                    fill="none"
                    strokeLinecap="round"
                    strokeDasharray="283"
                    strokeDashoffset="283"
                    className="hint-penalty-timer-ring"
                    style={hintPenaltyOpen ? { animation: `hint-countdown ${penaltyTotal}s linear forwards` } : undefined}
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <div id="hintTimerDisplay" className="mb-2 font-pixel text-amber-300 text-4xl sm:text-5xl tabular-nums">
                    {Math.max(0, hintPenaltySeconds)}
                  </div>
                  <span className="text-xs sm:text-sm uppercase text-amber-500/70">Seconds</span>
                </div>
              </div>

              <div className="mb-6">
                <p className="mb-2 text-sm sm:text-base uppercase text-amber-400">Decrypting Hint...</p>
                <p className="text-xs text-gray-500">Stay focused on your training!</p>
              </div>

              <div
                id="hintWarningMessage"
                className={`${hintFocusLost ? '' : 'hidden '}mb-6 rounded-lg border border-red-500/50 bg-red-900/40 p-4 animate-shake`}
              >
                <div className="flex items-center justify-center gap-2">
                  <span className="material-symbols-rounded text-sm text-red-400">warning</span>
                  <p className="font-pixel text-xs sm:text-sm uppercase text-red-400">Focus Lost!</p>
                </div>
                <p className="mt-1 text-xs text-red-300" id="tabSwitchWarning">
                  Tab switch detected. Timer reset.
                </p>
              </div>

              <div className="border-t border-amber-500/20 pt-4">
                <p className="text-xs text-amber-500/60">&quot;Rock-solid focus wins battles.&quot;</p>
              </div>
            </div>
          </div>
        </div>

        <div
          id="hintDisplay"
          className={`${hintDisplayOpen ? '' : 'hidden '}absolute inset-0 z-[110] glass-panel flex items-center justify-center p-4`}
        >
          <div className="glass-blue relative w-full max-w-xs sm:max-w-sm rounded-xl border-2 border-blue-500/50 p-4 sm:p-5">
            <button
              type="button"
              aria-label="Close hint"
              onClick={onCloseHintPopup}
              onMouseDown={() => playSound('click')}
              className="absolute top-2 right-2 flex items-center justify-center rounded-lg p-1 text-gray-400 hover:text-white transition-colors"
            >
              <span className="material-symbols-rounded text-base">close</span>
            </button>
            <h3 className="font-pixel text-blue-400 text-sm sm:text-base mb-3 pr-10">
              Hint Unlocked
            </h3>
            <div className="max-h-40 sm:max-h-48 overflow-y-auto scrollable">
              <p id="hintText" className="text-white text-sm sm:text-base font-mono leading-relaxed">
                {hintText}
              </p>
            </div>
            <button
              type="button"
              onClick={onCloseHintPopup}
              onMouseDown={() => playSound('click')}
              className="btn-pokedex w-full mt-4 py-3 text-sm sm:text-base"
            >
              CLOSE
            </button>
          </div>
        </div>
      </div>


    </>
  );
};
