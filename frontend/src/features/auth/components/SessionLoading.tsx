/**
 * Full-screen auth loading state. Renders a key-into-lock animation while the
 * session is being validated. Replaces the previous skeleton-based placeholder,
 * which looked broken for a screen where the user isn't waiting on content but
 * on an auth handshake.
 */
export function SessionLoading({ message }: { message: string }) {
  return (
    <main className="authContainer">
      <section className="authPanel panel sessionLoadingPanel">
        <div className="sessionLoadingStage" aria-hidden="true">
          <KeyLockAnimation />
        </div>
        <p className="sessionLoadingMessage" role="status" aria-live="polite">
          {message}
        </p>
      </section>
    </main>
  );
}

function KeyLockAnimation() {
  return (
    <svg
      className="keyLockAnim"
      viewBox="0 0 120 80"
      width="160"
      height="106"
      role="img"
      aria-label="Validando acesso"
    >
      {/* Lock body */}
      <g className="keyLockBody">
        <rect
          x="68"
          y="20"
          width="40"
          height="44"
          rx="6"
          className="keyLockBox"
        />
        <path
          d="M76 20 v-6 a12 12 0 0 1 24 0 v6"
          className="keyLockShackle"
          fill="none"
        />
        <circle cx="88" cy="40" r="4" className="keyLockHole" />
        <rect
          x="86"
          y="40"
          width="4"
          height="10"
          rx="1.5"
          className="keyLockHole"
        />
      </g>

      {/* Key */}
      <g className="keyLockKey">
        <circle cx="14" cy="40" r="9" className="keyRing" />
        <circle cx="14" cy="40" r="3.5" className="keyRingInner" />
        <rect x="22" y="38" width="40" height="4" rx="1.5" className="keyShaft" />
        <rect x="50" y="42" width="4" height="6" rx="1" className="keyTooth" />
        <rect x="56" y="42" width="3" height="4" rx="1" className="keyTooth" />
      </g>
    </svg>
  );
}
