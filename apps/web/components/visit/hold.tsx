"use client";
import { useEffect, useRef, useState } from "react";

/**
 * Press-and-hold progress driver: start() begins a hold, cancel() aborts it; onDone fires after `ms`.
 * Returns progress 0..1 for the ring.
 */
export function useHold(ms: number, onDone: () => void) {
  const [progress, setProgress] = useState(0);
  const raf = useRef(0);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });
  const cancel = () => {
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    setProgress(0);
  };
  const start = () => {
    if (raf.current) return;
    const t0 = performance.now();
    const tick = () => {
      const p = Math.min(1, (performance.now() - t0) / ms);
      setProgress(p);
      if (p < 1) raf.current = requestAnimationFrame(tick);
      else {
        raf.current = 0;
        setProgress(0);
        done.current();
      }
    };
    raf.current = requestAnimationFrame(tick);
  };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  return { progress, start, cancel };
}

export function Ring({ progress, size = 56, className = "" }: { progress: number; size?: number; className?: string }) {
  const r = size / 2 - 3;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className={className}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity={0.25} strokeWidth={3} />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={3}
        strokeDasharray={c} strokeDashoffset={c * (1 - progress)} transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

/** A button that only acts after being held (pointer, or Space/Enter held) for `ms`. */
export function HoldButton({
  ms, onDone, label, children, className = "",
}: { ms: number; onDone: () => void; label: string; children: React.ReactNode; className?: string }) {
  const { progress, start, cancel } = useHold(ms, onDone);
  return (
    <button
      type="button"
      aria-label={label}
      className={`relative select-none touch-none ${className}`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        start();
      }}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onKeyDown={(e) => {
        if ((e.key === " " || e.key === "Enter") && !e.repeat) {
          e.preventDefault();
          start();
        }
      }}
      onKeyUp={cancel}
      onBlur={cancel}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span className="flex items-center justify-center gap-3">
        <Ring progress={progress} size={28} />
        {children}
      </span>
    </button>
  );
}
