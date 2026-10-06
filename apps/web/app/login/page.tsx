"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function go(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      router.replace("/");
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-[70vh] flex-col justify-center">
      <h1 className="text-3xl font-semibold tracking-tight">Sitspot</h1>
      <p className="mt-1 mb-8 text-muted">Your places, calling you.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void go(() => api.login(passcode));
        }}
        className="space-y-4"
      >
        <div>
          <label htmlFor="passcode" className="label">
            Passcode
          </label>
          <input
            id="passcode"
            type="password"
            autoComplete="current-password"
            required
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            className="field"
          />
        </div>
        {error && (
          <p role="alert" className="text-warn">
            {error}
          </p>
        )}
        <button className="btn w-full" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <button className="btn-ghost mt-4 w-full" disabled={busy} onClick={() => void go(api.demo)}>
        View demo (read-only)
      </button>
    </div>
  );
}
