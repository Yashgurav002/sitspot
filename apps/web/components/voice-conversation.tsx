"use client";
// PLACEHOLDER: ElevenLabs web conversation gets wired here later (spec §15 step 3).
// For now it reads the script aloud with the browser's SpeechSynthesis.
import { useEffect, useState } from "react";

export function VoiceConversation({ invitationId, script }: { invitationId: string; script: string }) {
  const [speaking, setSpeaking] = useState(false);
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;

  useEffect(() => () => window.speechSynthesis?.cancel(), []);

  function toggle() {
    const s = window.speechSynthesis;
    if (speaking) {
      s.cancel();
      return setSpeaking(false);
    }
    const u = new SpeechSynthesisUtterance(script);
    u.rate = 0.95;
    u.onend = u.onerror = () => setSpeaking(false);
    s.speak(u);
    setSpeaking(true);
  }

  return (
    <section
      data-voice-placeholder
      data-invitation-id={invitationId}
      aria-label="Voice"
      className="card border-dashed text-center"
    >
      <p className="mb-3 text-xs uppercase tracking-wide text-muted">Voice (browser preview)</p>
      <button className="btn w-full" onClick={toggle} disabled={!supported}>
        {speaking ? "Stop" : "Listen"}
      </button>
      {!supported && <p className="mt-2 text-sm text-muted">This browser can&apos;t speak. Read it above.</p>}
    </section>
  );
}
