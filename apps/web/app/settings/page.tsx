"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { urlBase64ToUint8Array } from "@/lib/format";
import { ErrorBox, Loading, PageTitle, useLoad } from "@/components/ui";

export default function SettingsPage() {
  const { data, error, loading, reload } = useLoad(() => Promise.all([api.me(), api.preferences().catch(() => [])]));
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  const [me, prefs] = data!;
  const loves = prefs.filter((p) => p.key === "loves").sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at))[0];

  return (
    <>
      <PageTitle>Settings</PageTitle>
      {me.demo && <p className="card mb-4 text-sm text-muted">You&apos;re viewing the read-only demo. Changes won&apos;t save.</p>}
      <div className="space-y-6">
        <QuietHours start={me.user.quiet_start.slice(0, 5)} end={me.user.quiet_end.slice(0, 5)} />
        <Loves initial={typeof loves?.value === "string" ? loves.value : (loves?.source_utterance ?? "")} />
        <Push />
        <SignOut />
      </div>
    </>
  );
}

function useSave() {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMsg("");
    try {
      await fn();
      setMsg(ok);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const status = msg && (
    <p role="status" className="text-sm text-muted">
      {msg}
    </p>
  );
  return { busy, run, status };
}

function QuietHours({ start: s0, end: e0 }: { start: string; end: string }) {
  const [start, setStart] = useState(s0);
  const [end, setEnd] = useState(e0);
  const { busy, run, status } = useSave();
  return (
    <form
      className="card space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void run(() => api.updateMe({ quiet_start: start, quiet_end: end }), "Quiet hours saved.");
      }}
    >
      <h2 className="font-semibold">Quiet hours</h2>
      <p className="text-sm text-muted">No calls, ever, between these times.</p>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="qs" className="label">
            From
          </label>
          <input id="qs" type="time" required value={start} onChange={(e) => setStart(e.target.value)} className="field" />
        </div>
        <div>
          <label htmlFor="qe" className="label">
            Until
          </label>
          <input id="qe" type="time" required value={end} onChange={(e) => setEnd(e.target.value)} className="field" />
        </div>
      </div>
      <button className="btn w-full" disabled={busy}>
        Save quiet hours
      </button>
      {status}
    </form>
  );
}

function Loves({ initial }: { initial: string }) {
  const [text, setText] = useState(initial);
  const { busy, run, status } = useSave();
  return (
    <form
      className="card space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const said = text.trim();
        if (said) void run(() => api.savePreference("loves", said, said), "Noted, in your words.");
      }}
    >
      <label htmlFor="loves" className="font-semibold">
        What do you love outside?
      </label>
      <textarea
        id="loves"
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="field py-2"
        placeholder="sunsets, kingfishers, anything near water"
      />
      <button className="btn w-full" disabled={busy || !text.trim()}>
        Save
      </button>
      {status}
    </form>
  );
}

function Push() {
  const { busy, run, status } = useSave();
  async function enable() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window))
      throw new Error("This browser can't receive push. On iPhone, add Sitspot to your home screen first.");
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
    if ((await Notification.requestPermission()) !== "granted") throw new Error("Notifications are blocked.");
    await navigator.serviceWorker.ready;
    const { key } = await api.vapidKey();
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) }));
    await api.subscribePush(sub.toJSON());
  }
  return (
    <section className="card space-y-3">
      <h2 className="font-semibold">Notifications</h2>
      <p className="text-sm text-muted">If a call can&apos;t reach you, Sitspot sends a push instead.</p>
      <button className="btn-ghost w-full" disabled={busy} onClick={() => void run(enable, "Notifications on.")}>
        Enable notifications
      </button>
      <button className="btn-ghost w-full" disabled={busy} onClick={() => void run(() => api.testPush(), "Test sent. It should arrive in a few seconds.")}>
        Send test notification
      </button>
      {status}
    </section>
  );
}

function SignOut() {
  const router = useRouter();
  return (
    <button
      className="btn-ghost w-full"
      onClick={async () => {
        await api.logout().catch(() => {});
        router.replace("/login");
      }}
    >
      Sign out
    </button>
  );
}
