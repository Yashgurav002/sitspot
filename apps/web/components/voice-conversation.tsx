"use client";
// In-browser call with the ElevenLabs Sitspot agent (spec §15 step 3). The agent's "brain" is our
// custom-LLM endpoint, so replies are grounded in the invitation's facts and "yes, let's go" accepts
// it server-side. Falls back to the browser's own speech when ElevenLabs isn't configured.
import { useEffect, useRef, useState } from "react";
import { Conversation } from "@elevenlabs/client";
import { api } from "@/lib/api";

type Line = { who: "sitspot" | "you"; text: string };
type Session = { endSession(): Promise<void> };

export function VoiceConversation({ invitationId, script }: { invitationId: string; script: string }) {
  const [status, setStatus] = useState<"idle" | "connecting" | "live" | "ended" | "error">("idle");
  const [mode, setMode] = useState<"speaking" | "listening">("listening");
  const [lines, setLines] = useState<Line[]>([]);
  const [err, setErr] = useState("");
  const conv = useRef<Session | null>(null);

  useEffect(() => () => void conv.current?.endSession().catch(() => {}), []);

  async function start() {
    setErr("");
    setStatus("connecting");
    try {
      const s = await api.voiceSession(invitationId);
      if (!s.signed_url) return speakLocally(s.script ?? script);
      // The mic prompt needs this user tap; asking first gives a clear error if it's blocked.
      await navigator.mediaDevices.getUserMedia({ audio: true });
      conv.current = await Conversation.startSession({
        signedUrl: s.signed_url,
        dynamicVariables: { script: s.script ?? script, invitation_id: invitationId },
        customLlmExtraBody: { invitation_id: invitationId },
        onConnect: () => setStatus("live"),
        onDisconnect: () => setStatus("ended"),
        onModeChange: ({ mode }) => setMode(mode),
        onMessage: (m: { message?: string; source?: string; role?: string }) => {
          if (!m.message) return;
          const who = m.source === "user" || m.role === "user" ? "you" : "sitspot";
          setLines((l) => [...l, { who, text: m.message! }]);
        },
        onError: (message) => {
          setErr(message);
          setStatus("error");
        },
      });
    } catch (e) {
      setErr((e as Error).message || "Couldn't start the voice call.");
      setStatus("error");
    }
  }

  function speakLocally(text: string) {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.95;
    u.onend = u.onerror = () => setStatus("ended");
    window.speechSynthesis.speak(u);
    setLines([{ who: "sitspot", text }]);
    setStatus("live");
  }

  async function stop() {
    window.speechSynthesis?.cancel();
    await conv.current?.endSession().catch(() => {});
    conv.current = null;
    setStatus("ended");
  }

  const live = status === "live" || status === "connecting";
  return (
    <section aria-label="Voice" data-invitation-id={invitationId} className="card space-y-3 text-center">
      {!live ? (
        <button className="btn w-full py-4 text-lg" onClick={() => void start()}>
          {status === "ended" ? "Talk to Sitspot again" : "Talk to Sitspot"}
        </button>
      ) : (
        <>
          <p className="text-sm text-muted" role="status">
            {status === "connecting" ? "Connecting…" : mode === "speaking" ? "Sitspot is speaking…" : "Listening… say “yes, let’s go” or ask a question"}
          </p>
          <button className="btn-ghost w-full" onClick={() => void stop()}>
            End
          </button>
        </>
      )}
      {err && <p className="text-sm text-red-600 dark:text-red-400">{err}</p>}
      {lines.length > 0 && (
        <ul className="space-y-2 text-left text-sm">
          {lines.map((l, i) => (
            <li key={i} className={l.who === "you" ? "text-right text-muted" : ""}>
              <span className="font-medium">{l.who === "you" ? "You" : "Sitspot"}:</span> {l.text}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
