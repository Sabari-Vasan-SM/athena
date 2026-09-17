import type { ActivityState } from '../lib/types';

const LABELS: Record<ActivityState, string> = {
  IDLE: 'Idle',
  ANALYZING: 'Analyzing',
  PLANNING: 'Planning',
  CODING: 'Coding',
  TESTING: 'Testing',
  REVIEWING: 'Reviewing',
  SUCCESS: 'Finished',
  ERROR: 'Error',
};

/**
 * Lightweight SVG + CSS robot. Each state is a CSS class that drives transform/opacity
 * animations only (GPU-friendly). Animations stop under prefers-reduced-motion.
 */
export function Robot({ state, size = 132 }: { state: ActivityState; size?: number }) {
  const s = state.toLowerCase();
  return (
    <div className={`robot robot--${s}`} role="img" aria-label={`Athena robot: ${LABELS[state]}`} style={{ width: size, height: size }}>
      <svg viewBox="0 0 160 160" width={size} height={size} aria-hidden="true">
        <defs>
          <linearGradient id="rb-body" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--robot-shell-hi)" />
            <stop offset="1" stopColor="var(--robot-shell)" />
          </linearGradient>
          <clipPath id="rb-visor">
            <rect x="46" y="50" width="68" height="34" rx="14" />
          </clipPath>
        </defs>
        <ellipse className="robot__shadow" cx="80" cy="148" rx="34" ry="5" />
        <g className="robot__float">
          <g className="robot__antenna">
            <line x1="80" y1="30" x2="80" y2="16" stroke="var(--robot-shell-hi)" strokeWidth="3" strokeLinecap="round" />
            <circle className="robot__bulb" cx="80" cy="13" r="5" />
          </g>
          <g className="robot__head">
            <rect x="34" y="30" width="92" height="68" rx="22" fill="url(#rb-body)" stroke="var(--robot-edge)" strokeWidth="1.5" />
            <rect x="46" y="50" width="68" height="34" rx="14" fill="var(--robot-visor)" />
            <g clipPath="url(#rb-visor)">
              <rect className="robot__scan" x="46" y="50" width="14" height="34" fill="var(--robot-accent)" opacity="0.18" />
            </g>
            <g className="robot__eyes">
              <g className="robot__eye robot__eye--l">
                <rect className="robot__pupil" x="60" y="60" width="12" height="14" rx="6" />
              </g>
              <g className="robot__eye robot__eye--r">
                <rect className="robot__pupil" x="88" y="60" width="12" height="14" rx="6" />
              </g>
              <path className="robot__happy" d="M59 70 q7 -9 14 0 M87 70 q7 -9 14 0" fill="none" strokeWidth="4" strokeLinecap="round" />
              <path className="robot__cross" d="M61 61 l10 12 M71 61 l-10 12 M89 61 l10 12 M99 61 l-10 12" fill="none" strokeWidth="3.5" strokeLinecap="round" />
            </g>
            <circle cx="34" cy="64" r="5" fill="var(--robot-shell)" stroke="var(--robot-edge)" />
            <circle cx="126" cy="64" r="5" fill="var(--robot-shell)" stroke="var(--robot-edge)" />
          </g>
          <g className="robot__body">
            <rect x="50" y="102" width="60" height="36" rx="12" fill="url(#rb-body)" stroke="var(--robot-edge)" strokeWidth="1.5" />
            <rect x="60" y="111" width="40" height="18" rx="5" fill="var(--robot-visor)" />
            <g className="robot__code">
              <rect x="64" y="115" width="18" height="2.5" rx="1.25" />
              <rect x="64" y="119.5" width="26" height="2.5" rx="1.25" />
              <rect x="64" y="124" width="12" height="2.5" rx="1.25" />
            </g>
            <rect className="robot__progress" x="64" y="118" width="32" height="4" rx="2" />
            <g className="robot__dots">
              <circle cx="72" cy="120" r="2" />
              <circle cx="80" cy="120" r="2" />
              <circle cx="88" cy="120" r="2" />
            </g>
          </g>
          <g className="robot__arm robot__arm--l">
            <rect x="36" y="106" width="10" height="24" rx="5" fill="var(--robot-shell)" stroke="var(--robot-edge)" />
          </g>
          <g className="robot__arm robot__arm--r">
            <rect x="114" y="106" width="10" height="24" rx="5" fill="var(--robot-shell)" stroke="var(--robot-edge)" />
          </g>
        </g>
      </svg>
    </div>
  );
}

export function activityLabel(state: ActivityState): string {
  return LABELS[state];
}
