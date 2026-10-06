"use client";
// /visit/[id] — pocket mode (spec §14). Audio is analysed on the phone and dropped; only species JSON leaves it.
import { useCallback, useEffect, useRef, useState } from "react";
import * as Sentry from "@sentry/nextjs";
import { api, ApiError } from "@/lib/api";
import { time } from "@/lib/format";
import { dedupeDetections, type DedupeState } from "@/lib/birdnet/dedupe";
import { answerSpeciesQuestion, confidenceWord, isSpeciesQuestion, summarize, type Heard } from "@/lib/visit/answer";
import { createDropGate, startMic, type Mic } from "@/lib/visit/audio";
import { flushOutbox, idbOutbox, memoryOutbox, type Outbox } from "@/lib/visit/outbox";
import { ErrorBox, Loading, useLoad } from "@/components/ui";
import { HoldButton } from "./hold";
import { PocketOverlay } from "./pocket-overlay";
import { useBirdnet, type ModelState, type Regional } from "./use-birdnet";

const MODEL_VERSION = "birdnet-v2.4-tfjs";
const AUTO_END_MS = 90 * 60_000;

type Battery = { level: number; charging: boolean } | null;
type Session = { visit_id: string; token: string; arrived_at: number; battery: Battery };
type Listen = "off" | "starting" | "on" | "denied" | "error";
type Note = { id: string; text: string; status: "saving" | "saved" | "failed" };
type Summary = { minutes: number; species: number; battery: string };

const key = (inv: string) => `sitspot.visit.${inv}`;

let boxP: Promise<Outbox> | null = null;
const outbox = () => (boxP ??= idbOutbox().catch(() => memoryOutbox()));

async function readBattery(): Promise<Battery> {
  try {
    const b = await (navigator as Navigator & { getBattery?: () => Promise<{ level: number; charging: boolean }> }).getBattery?.();
    return b ? { level: b.level, charging: b.charging } : null;
  } catch {
    return null;
  }
}

function speak(text: string) {
  if (!("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-IN";
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

export function VisitApp({ invitationId }: { invitationId: string }) {
  const { data, error, loading, reload } = useLoad(
    () => Promise.all([api.invitation(invitationId), api.spots().catch(() => null)]),
    [invitationId],
  );
  const inv = data?.[0];
  const spot = data?.[1]?.find((s) => s.id === inv?.spot_id);
  const coords = !data ? undefined : spot ? { lat: spot.lat, lon: spot.lon } : null;
  const { bn, model, regional, regionalCount } = useBirdnet(coords);

  const [session, setSession] = useState<Session | null>(null);
  const [phase, setPhase] = useState<"pre" | "active" | "rating" | "thanks">("pre");
  const [pocket, setPocket] = useState(false);
  const [listen, setListen] = useState<Listen>("off");
  const [heard, setHeard] = useState<Heard[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [qa, setQa] = useState<{ q: string; a: string }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<Error | null>(null);
  const [online, setOnline] = useState(true);
  const [unsynced, setUnsynced] = useState(0);
  const [wake, setWake] = useState<"unsupported" | "on" | "off">("off");
  const [now, setNow] = useState(() => Date.now());
  const [autoPrompt, setAutoPrompt] = useState<"no" | "show" | "dismissed">("no");
  const [stats, setStats] = useState({ analysed: 0, skipped: 0, lastMs: 0, worklet: true, rate: 0 });
  const [summary, setSummary] = useState<Summary | null>(null);

  // Refs read from the audio callback (which outlives renders).
  const sessionRef = useRef(session);
  const canAnalyze = useRef(false);
  const heardRef = useRef<Heard[]>([]);
  const dedupe = useRef<DedupeState>(new Map());
  const gate = useRef(createDropGate());
  const mic = useRef<Mic | null>(null);
  const analyzeMs = useRef<number[]>([]); // per-window inference times, reported as an aggregate at visit end
  useEffect(() => {
    sessionRef.current = session;
    canAnalyze.current = model.phase === "ready" && regional !== "pending";
  });

  // Resume a visit after a reload (same tab).
  useEffect(() => {
    try {
      const s = sessionStorage.getItem(key(invitationId));
      if (s) {
        setSession(JSON.parse(s));
        setPhase("active");
      }
    } catch {}
    setOnline(navigator.onLine);
  }, [invitationId]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);

  // ---- outbox flush: every 30 s, on reconnect, and at the end ----
  const flushing = useRef(false);
  const flush = useCallback(async () => {
    if (flushing.current) return;
    flushing.current = true;
    try {
      const box = await outbox();
      // Batch size and outcome only; the rows themselves (species) never go to Sentry.
      await Sentry.startSpan({ name: "outbox flush", op: "outbox.flush" }, async (span) => {
        const r = await flushOutbox(box, api.detections);
        span.setAttributes({ sent: r.sent, dropped: r.dropped, status: r.pending ? "pending" : "drained" });
        if (r.pending) span.setStatus({ code: 2, message: "unavailable" });
      });
      setUnsynced((await box.peekBatch(200)).length);
    } finally {
      flushing.current = false;
    }
  }, []);
  useEffect(() => {
    if (!session) return;
    void flush();
    const t = setInterval(() => void flush(), 30_000);
    const on = () => (setOnline(true), void flush());
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      clearInterval(t);
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, [session, flush]);

  // ---- wake lock while the visit is running ----
  const visiting = phase === "active" || phase === "rating";
  useEffect(() => {
    if (!visiting) return;
    if (!("wakeLock" in navigator)) return setWake("unsupported");
    let lock: WakeLockSentinel | null = null;
    let live = true;
    const acquire = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        lock = await navigator.wakeLock.request("screen");
        if (!live) return void lock.release();
        setWake("on");
        lock.addEventListener("release", () => live && setWake("off"));
      } catch {
        setWake("off");
      }
    };
    void acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", acquire);
      void lock?.release().catch(() => {});
    };
  }, [visiting]);

  // ---- 90-minute auto-end prompt ----
  useEffect(() => {
    if (phase === "active" && session && autoPrompt === "no" && now - session.arrived_at >= AUTO_END_MS) {
      setAutoPrompt("show");
      navigator.vibrate?.(300);
    }
  }, [now, phase, session, autoPrompt]);

  useEffect(() => () => mic.current?.stop(), []);

  // ---- mic → BirdNET → outbox ----
  const onWindow = useCallback((w: Float32Array) => {
    const g = gate.current;
    void g
      .run(async () => {
        const b = bn.current;
        const s = sessionRef.current;
        if (!b || !s || !canAnalyze.current) return w.fill(0), void setStats((x) => ({ ...x, skipped: x.skipped + 1 }));
        const t0 = performance.now();
        const preds = await b.analyze(w);
        w.fill(0); // the worker got its own copy; drop ours
        const t = Date.now();
        const ms = Math.round(performance.now() - t0);
        setStats((x) => ({ ...x, analysed: x.analysed + 1, lastMs: ms }));
        analyzeMs.current.push(ms);
        if (preds.length === 0) return;
        const hits = preds.map((p) => ({ ...p, time: t }));
        heardRef.current = [...heardRef.current, ...hits];
        setHeard(heardRef.current);
        const { state, fresh } = dedupeDetections(dedupe.current, preds, t);
        dedupe.current = state;
        if (fresh.length === 0) return;
        const box = await outbox();
        await box.add(
          fresh.map((p) => ({
            visit_id: s.visit_id,
            token: s.token,
            row: {
              time: new Date(t).toISOString(),
              species_code: p.scientific_name, // BirdNET has no eBird codes
              common_name: p.common_name,
              confidence: Math.round(p.confidence * 1000) / 1000,
              model_version: MODEL_VERSION,
            },
          })),
        );
        setUnsynced((n) => n + fresh.length);
      })
      .then((ran) => {
        if (!ran) {
          w.fill(0);
          setStats((x) => ({ ...x, skipped: x.skipped + 1 }));
        }
      })
      .catch((e) => console.warn("[sitspot] window failed", e));
  }, [bn]);

  async function startListening() {
    if (mic.current || model.phase === "failed") return;
    setListen("starting");
    try {
      mic.current = await startMic(onWindow);
      setStats((x) => ({ ...x, worklet: mic.current!.worklet, rate: mic.current!.rate }));
      setListen("on");
    } catch (e) {
      const name = (e as DOMException).name;
      setListen(name === "NotAllowedError" || name === "SecurityError" ? "denied" : "error");
      console.warn("[sitspot] mic failed", e);
    }
  }

  async function arrive() {
    setBusy("arrive");
    setActionError(null);
    try {
      const [{ visit, visit_token }, battery] = await Promise.all([api.arrive(invitationId), readBattery()]);
      const s: Session = { visit_id: visit.id, token: visit_token, arrived_at: new Date(visit.arrived_at).getTime(), battery };
      try {
        sessionStorage.setItem(key(invitationId), JSON.stringify(s));
      } catch {}
      setSession(s);
      setPhase("active");
      setPocket(true);
      void startListening(); // still inside the tap's user activation, so the AudioContext may start
    } catch (e) {
      setActionError(e as Error);
    } finally {
      setBusy(null);
    }
  }

  async function handleUtterance(raw: string) {
    const text = raw.trim();
    if (!text || !session) return;
    if (isSpeciesQuestion(text)) {
      const a = answerSpeciesQuestion(text, heardRef.current, Date.now());
      setQa((x) => [{ q: text, a }, ...x]);
      return speak(a);
    }
    const id = crypto.randomUUID();
    setNotes((n) => [...n, { id, text, status: "saving" }]);
    await saveNote(id, text);
  }

  async function saveNote(id: string, text: string) {
    if (!session) return;
    const set = (status: Note["status"]) => setNotes((n) => n.map((x) => (x.id === id ? { ...x, status } : x)));
    set("saving");
    try {
      await api.observe(session.visit_id, text);
      set("saved");
    } catch {
      set("failed");
    }
  }

  async function finish(rating: number | null) {
    if (!session) return;
    setBusy("end");
    setActionError(null);
    mic.current?.stop();
    mic.current = null;
    setListen("off");
    try {
      await flush();
      await api.endVisit(session.visit_id, rating);
      const end = await readBattery();
      const mins = (Date.now() - session.arrived_at) / 60_000;
      const species = summarize(heardRef.current).length;
      let battery = "Battery level isn't available in this browser.";
      if (session.battery && end) {
        const drop = (session.battery.level - end.level) * 100;
        const per30 = mins > 0 ? (drop / mins) * 30 : 0;
        battery =
          `Battery ${Math.round(session.battery.level * 100)}% → ${Math.round(end.level * 100)}%: ` +
          // battery level is quantised to 1%, so short visits can't give a meaningful rate
          (mins >= 10 ? `${per30.toFixed(1)}% per 30 min` : "visit too short for a per-30-min rate") +
          (session.battery.charging || end.charging ? " (was charging — not a fair reading)." : ".");
      }
      console.info(
        `[sitspot] visit ${session.visit_id} ended: ${mins.toFixed(1)} min, ${species} species, ` +
          `${stats.analysed} windows analysed, ${stats.skipped} skipped, last ${stats.lastMs} ms/window. ${battery}`,
      );
      const ms = analyzeMs.current;
      Sentry.startSpan(
        {
          name: "birdnet analyze windows",
          op: "birdnet.analyze",
          attributes: {
            count: ms.length,
            mean_ms: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : 0,
            max_ms: ms.length ? Math.max(...ms) : 0,
            skipped: stats.skipped,
          },
        },
        () => {},
      );
      analyzeMs.current = [];
      try {
        sessionStorage.removeItem(key(invitationId));
      } catch {}
      setSummary({ minutes: Math.round(mins), species, battery });
      setPhase("thanks");
    } catch (e) {
      setActionError(e as Error);
    } finally {
      setBusy(null);
    }
  }

  // ---------------- render ----------------
  if (phase === "pre") {
    if (loading && !data) return <Loading />;
    if (error) return <ErrorBox error={error} retry={reload} />;
  }
  const spotName = inv?.spot_name ?? spot?.name ?? "your spot";
  const species = summarize(heard);

  if (phase === "thanks" && summary)
    return (
      <div className="space-y-5 pt-10 text-center">
        <h1 className="text-2xl font-semibold">Thanks for going outside</h1>
        <p className="text-lg">
          {summary.minutes} min at {spotName} · {summary.species} species heard
        </p>
        <p className="text-sm text-muted">{summary.battery}</p>
        <a className="btn" href="/">
          Home
        </a>
      </div>
    );

  if (phase === "pre")
    return (
      <div className="space-y-6 pt-6">
        <header>
          <p className="text-sm font-medium text-accent">Visit</p>
          <h1 className="text-3xl font-semibold">{spotName}</h1>
          {inv && (
            <p className="text-muted">
              {time(inv.window_start)} – {time(inv.window_end)}
            </p>
          )}
        </header>
        <button className="btn min-h-24 w-full text-2xl" onClick={arrive} disabled={busy === "arrive"}>
          {busy === "arrive" ? "Starting…" : "I'm here"}
        </button>
        {actionError && <ErrorBox error={actionError} />}
        <p className="text-sm text-muted">
          Audio never leaves your phone. The bird model runs here, each 3-second clip is thrown away after it&apos;s
          checked, and only species names are sent.
        </p>
        <ModelStatus model={model} regional={regional} regionalCount={regionalCount} />
      </div>
    );

  const elapsed = session ? Math.max(0, Math.floor((now - session.arrived_at) / 60_000)) : 0;
  return (
    <div className="space-y-5">
      {pocket && (
        <PocketOverlay
          species={species.length}
          now={now}
          note={autoPrompt === "show" ? "90 minutes. Hold to exit, then finish." : undefined}
          onExit={() => setPocket(false)}
        />
      )}
      <header>
        <p className="text-sm font-medium text-accent">At {spotName}</p>
        <h1 className="text-2xl font-semibold">{elapsed} min outside</h1>
        <p className="mt-1 text-sm text-muted">
          {listenText(listen, model)} · {wake === "on" ? "screen kept on" : wake === "unsupported" ? "this browser can't keep the screen on — keep it awake manually" : "screen may sleep"} ·{" "}
          {!online ? `offline — ${unsynced} queued` : unsynced ? `${unsynced} to sync` : "synced"}
        </p>
      </header>

      {autoPrompt === "show" && (
        <div role="alert" className="card">
          <p>You&apos;ve been out 90 minutes. Finish the visit?</p>
          <div className="mt-3 flex gap-3">
            <button className="btn flex-1" onClick={() => (setAutoPrompt("dismissed"), setPhase("rating"))}>
              Finish
            </button>
            <button className="btn-ghost flex-1" onClick={() => setAutoPrompt("dismissed")}>
              Keep going
            </button>
          </div>
        </div>
      )}

      {model.phase === "failed" && (
        <p role="alert" className="card border-warn/40 text-warn">
          Bird ID couldn&apos;t load on this phone ({model.message}). The visit still counts: add spoken or typed notes
          below. No birds will be identified automatically.
        </p>
      )}
      {listen === "denied" && (
        <p role="alert" className="card border-warn/40 text-warn">
          Microphone blocked. Allow it in the site settings to identify birds. Notes still work.
        </p>
      )}
      {(listen === "off" || listen === "error") && model.phase !== "failed" && phase === "active" && (
        <button className="btn-ghost w-full" onClick={startListening}>
          {listen === "error" ? "Microphone failed — try again" : "Start listening"}
        </button>
      )}

      {phase === "active" && (
        <button className="btn min-h-16 w-full text-lg" onClick={() => setPocket(true)}>
          Pocket mode
        </button>
      )}

      {phase === "active" && <Voice onText={handleUtterance} />}

      <section aria-label="Species heard">
        <h2 className="mb-2 font-semibold">Heard ({species.length})</h2>
        {species.length === 0 ? (
          <p className="text-sm text-muted">Nothing identified yet.</p>
        ) : (
          <ul className="space-y-2">
            {species.map((s) => (
              <li key={s.scientific_name} className="card flex items-baseline justify-between gap-3 py-3">
                <span>
                  {s.common_name} <span className="text-sm italic text-muted">{s.scientific_name}</span>
                </span>
                <span className="shrink-0 text-sm text-muted">
                  {s.times}× · {confidenceWord(s.best)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {(qa.length > 0 || notes.length > 0) && (
        <section aria-label="Notes and answers" className="space-y-2">
          <h2 className="font-semibold">Notes</h2>
          {qa.map((x, i) => (
            <div key={"qa" + i} className="card py-3 text-sm">
              <p className="text-muted">“{x.q}”</p>
              <p className="mt-1">{x.a}</p>
            </div>
          ))}
          {notes.map((n) => (
            <div key={n.id} className="card flex items-baseline justify-between gap-3 py-3 text-sm">
              <span>{n.text}</span>
              {n.status === "failed" ? (
                <button className="shrink-0 text-warn underline" onClick={() => saveNote(n.id, n.text)}>
                  not saved — retry
                </button>
              ) : (
                <span className="shrink-0 text-muted">{n.status === "saving" ? "saving…" : "saved"}</span>
              )}
            </div>
          ))}
        </section>
      )}

      {phase === "rating" ? (
        <section aria-label="Rate this visit" className="card space-y-3">
          <h2 className="font-semibold">How was it?</h2>
          <div className="flex gap-2">
            {[1, 2, 3, 4, 5].map((r) => (
              <button key={r} className="btn-ghost flex-1" disabled={!!busy} onClick={() => finish(r)} aria-label={`${r} of 5`}>
                {r}
              </button>
            ))}
          </div>
          <div className="flex gap-3">
            <button className="btn-ghost flex-1" disabled={!!busy} onClick={() => finish(null)}>
              Skip rating
            </button>
            <button className="btn-ghost flex-1" disabled={!!busy} onClick={() => setPhase("active")}>
              Back
            </button>
          </div>
          {busy === "end" && <p role="status" className="text-sm text-muted">Syncing and finishing…</p>}
          {actionError && <ErrorBox error={actionError} />}
        </section>
      ) : (
        <HoldButton ms={1000} onDone={() => setPhase("rating")} label="Hold for 1 second to finish the visit" className="btn-ghost w-full">
          Done (hold)
        </HoldButton>
      )}

      <p className="text-xs text-muted">
        <ModelStatus model={model} regional={regional} regionalCount={regionalCount} inline /> · {stats.analysed} windows checked,{" "}
        {stats.skipped} skipped{stats.lastMs ? `, ${stats.lastMs} ms each` : ""}
        {stats.rate ? ` · ${stats.rate / 1000} kHz ${stats.worklet ? "worklet" : "script processor"}` : ""}. Audio never
        leaves this phone.
      </p>
    </div>
  );
}

function listenText(l: Listen, m: ModelState) {
  if (m.phase === "failed") return "notes only";
  return { off: "not listening", starting: "starting mic…", on: m.phase === "ready" ? "listening" : "listening (model loading)", denied: "mic blocked", error: "mic error" }[l];
}

function ModelStatus({ model, regional, regionalCount, inline }: { model: ModelState; regional: Regional; regionalCount: number; inline?: boolean }) {
  const text =
    model.phase === "downloading"
      ? `Bird ID: downloading model ${Math.round(model.progress * 100)}%`
      : model.phase === "starting"
        ? "Bird ID: starting…"
        : model.phase === "failed"
          ? "Bird ID unavailable — notes only"
          : `Bird ID ready (${model.backend})` +
            (regional === "ok" ? ` · ${regionalCount} local species` : regional === "pending" ? " · loading local species…" : " · no local filter");
  if (inline) return <span>{text}</span>;
  return (
    <p role="status" data-testid="model-status" className="text-sm text-muted">
      {text}
    </p>
  );
}

// ---- push-to-talk (Web Speech API) + typed fallback ----
type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};

function Voice({ onText }: { onText: (t: string) => void }) {
  const [rec, setRec] = useState<"unsupported" | "idle" | "listening">("unsupported");
  const [err, setErr] = useState("");
  const [typed, setTyped] = useState("");
  const r = useRef<Recognition | null>(null);
  const said = useRef("");

  useEffect(() => {
    const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return;
    const x = new Ctor();
    x.lang = "en-IN";
    x.interimResults = false;
    x.continuous = true;
    x.onresult = (e) => {
      said.current = Array.from(e.results, (res) => res[0]?.transcript ?? "").join(" ");
    };
    x.onerror = (e) => setErr(e.error === "not-allowed" ? "Microphone blocked for speech." : `Didn't catch that (${e.error}).`);
    x.onend = () => {
      setRec("idle");
      if (said.current.trim()) onText(said.current);
      said.current = "";
    };
    r.current = x;
    setRec("idle");
    return () => x.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section aria-label="Voice" className="card space-y-3">
      {rec !== "unsupported" ? (
        <button
          type="button"
          className="btn w-full select-none touch-none"
          onPointerDown={() => {
            setErr("");
            said.current = "";
            try {
              r.current?.start();
              setRec("listening");
            } catch {}
          }}
          onPointerUp={() => r.current?.stop()}
          onPointerCancel={() => r.current?.stop()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {rec === "listening" ? "Listening… release to send" : "Hold to talk"}
        </button>
      ) : (
        <p className="text-sm text-muted">Speech input isn&apos;t supported in this browser — type instead.</p>
      )}
      {err && <p className="text-sm text-warn">{err}</p>}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onText(typed);
          setTyped("");
        }}
      >
        <input
          className="field"
          aria-label="Note or question"
          placeholder="A note, or “what was that?”"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
        <button className="btn-ghost" type="submit">
          Send
        </button>
      </form>
      <p className="text-xs text-muted">Ask “what was that?” or “what birds so far?” — answers come only from what was heard.</p>
    </section>
  );
}
