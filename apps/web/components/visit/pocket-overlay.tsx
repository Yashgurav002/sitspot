"use client";
import { useEffect } from "react";
import { Ring, useHold } from "./hold";

/** Full-screen black screen for the pocket. Exits only after a 2-s hold (touch, mouse, or Escape held). */
export function PocketOverlay({ species, now, note, onExit }: { species: number; now: number; note?: string; onExit: () => void }) {
  const { progress, start, cancel } = useHold(2000, onExit);

  useEffect(() => {
    const down = (e: KeyboardEvent) => e.key === "Escape" && !e.repeat && start();
    const up = (e: KeyboardEvent) => e.key === "Escape" && cancel();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  });

  const clock = new Date(now).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Pocket mode"
      data-testid="pocket-overlay"
      className="fixed inset-0 z-[2000] flex touch-none select-none flex-col items-center justify-center bg-black text-neutral-700"
      onContextMenu={(e) => e.preventDefault()}
    >
      <p className="text-4xl tabular-nums">{clock}</p>
      <p className="mt-2 text-sm">
        {species} species heard
      </p>
      {note && <p className="mt-2 max-w-xs text-center text-xs">{note}</p>}
      <button
        type="button"
        aria-label="Hold for 2 seconds to exit pocket mode (or hold Escape)"
        className="absolute bottom-16 flex flex-col items-center gap-2 rounded-full p-4 text-neutral-600"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          start();
        }}
        onPointerUp={cancel}
        onPointerCancel={cancel}
        onKeyDown={(e) => (e.key === " " || e.key === "Enter") && !e.repeat && (e.preventDefault(), start())}
        onKeyUp={cancel}
      >
        <Ring progress={progress} size={64} />
        <span className="text-xs">Hold to exit</span>
      </button>
    </div>
  );
}
