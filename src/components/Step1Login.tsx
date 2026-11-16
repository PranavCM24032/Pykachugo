import React, { useState } from 'react';
import { playSound } from '../services/audio';
import { CustomSelect } from './CustomSelect';
import type { GameConfig, LanguageCode } from '../types/game';

interface Step1LoginProps {
  active: boolean;
  teamName: string;
  onTeamNameChange: (val: string) => void;
  securityKey: string;
  onSecurityKeyChange: (val: string) => void;
  language: LanguageCode;
  onLanguageChange: (val: LanguageCode) => void;
  missionLevel: string;
  onMissionLevelChange: (val: string) => void;
  config: GameConfig | null;
  feedback: { message: string; type: 'error' | 'success' | 'info' } | null;
  shakeField: 'teamName' | 'teamSecurityKey' | null;
  isSubmitting: boolean;
  onSubmit: (e: React.FormEvent) => void;
}

export const Step1Login: React.FC<Step1LoginProps> = ({
  active,
  teamName,
  onTeamNameChange,
  securityKey,
  onSecurityKeyChange,
  language,
  onLanguageChange,
  missionLevel,
  onMissionLevelChange,
  config,
  feedback,
  shakeField,
  isSubmitting,
  onSubmit,
}) => {
  const [showKey, setShowKey] = useState(false);

  const feedbackClass =
    feedback?.type === 'error'
      ? 'text-[11px] font-mono p-2.5 rounded-lg border bg-[#241416] border-red-800/70 text-red-200'
      : feedback?.type === 'success'
        ? 'text-[11px] font-mono p-2.5 rounded-lg border bg-[#14281d] border-emerald-800/70 text-emerald-200'
        : 'text-[11px] font-mono p-2.5 rounded-lg border bg-[#1e1b11] border-amber-700/60 text-[#fef08a]';

  return (
    <div id="step1" className={`flow-step${active ? ' active' : ''} h-full`}>
      <div className="min-h-full w-full flex flex-col justify-center items-center p-3 sm:p-5">
        <div className="w-full max-w-[360px] flex flex-col items-center gap-2">
          {/* Ash Photo Circle in centre of row */}
          <div className="flex flex-col items-center gap-2">
            <div className="w-20 h-20 sm:w-[120px] sm:h-[120px] rounded-full bg-[#09110e] border-2 border-[#fef08a]/40 flex items-center justify-center overflow-hidden p-1 shadow-inner">
              <img
                src="/assets/img/ash-3.webp"
                alt="Ash Ketchum"
                className="w-full h-full object-contain rounded-full"
                loading="lazy"
                decoding="async"
              />
            </div>
            <span className="font-pixel text-[#fef08a] tracking-wider uppercase text-xs sm:text-sm">Trainer Check-In</span>
          </div>

          <form id="registrationForm" onSubmit={onSubmit} className="w-full flex flex-col gap-2.5 max-w-[360px]">
            <div>
              <label className="crt-label" htmlFor="teamName">
                Team Name
              </label>
              <div className="relative">
                <input
                  type="text"
                  id="teamName"
                  value={teamName}
                  onChange={(e) => onTeamNameChange(e.target.value)}
                  className={`crt-input pl-3 pr-9 py-2 placeholder-slate-500 uppercase text-xs${
                    shakeField === 'teamName' ? ' animate-shake' : ''
                  }`}
                  placeholder="TRAINER NAME"
                  autoComplete="off"
                  required
                  maxLength={50}
                  autoCapitalize="characters"
                />
                <span className="material-symbols-rounded absolute right-2.5 top-1/2 -translate-y-1/2 text-[#fef08a]/60 text-base sm:text-lg pointer-events-none">
                  badge
                </span>
              </div>
            </div>

            <div>
              <label className="crt-label" htmlFor="teamSecurityKey">
                Security Key
              </label>
              <div className="relative">
                <input
                  type={showKey ? 'text' : 'password'}
                  id="teamSecurityKey"
                  value={securityKey}
                  onChange={(e) => onSecurityKeyChange(e.target.value)}
                  className={`crt-input pl-3 pr-9 py-2 placeholder-slate-500 text-xs${
                    shakeField === 'teamSecurityKey' ? ' animate-shake' : ''
                  }`}
                  placeholder="••••"
                  autoComplete="off"
                  required
                  maxLength={50}
                />
                <button
                  type="button"
                  onClick={() => {
                    playSound('click');
                    setShowKey((prev) => !prev);
                  }}
                  aria-label={showKey ? 'Hide security key' : 'Show security key'}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-[#fef08a] transition-colors focus:outline-none"
                >
                  <span id="securityKeyToggleIcon" className="material-symbols-rounded text-base sm:text-lg">
                    {showKey ? 'visibility' : 'visibility_off'}
                  </span>
                </button>
              </div>
            </div>

            <div>
              <label className="crt-label" htmlFor="codeLanguage">
                Language
              </label>
              <div className="relative group">
                <CustomSelect
                  id="codeLanguage"
                  value={language}
                  onChange={(v) => onLanguageChange(v as LanguageCode)}
                  options={config?.languages || []}
                  placeholder="Select Language"
                />
              </div>
            </div>

            <div>
              <label className="crt-label" htmlFor="missionLevel">
                Mission Discovery
              </label>
              <div className="relative group">
                <CustomSelect
                  id="missionLevel"
                  value={missionLevel}
                  onChange={onMissionLevelChange}
                  groups={config?.missionGroups || []}
                  placeholder="Select Mission"
                />
              </div>
            </div>

            {feedback && (
              <div id="registrationFeedback" className={feedbackClass}>
                <div>{feedback.message}</div>
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              onMouseDown={() => playSound('powerUp')}
              className="btn-pokedex w-full flex items-center justify-center gap-2 py-2.5 text-xs mt-1"
            >
              <span className="material-symbols-rounded text-base sm:text-lg">play_arrow</span>
              {isSubmitting ? 'SYNCING...' : 'START GO'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};