"use client";
import { useState } from "react";
import Link from "next/link";
import { api, type WInvitation } from "@/lib/api";

/** Accept / Decline for an invitation; shows the outcome once answered. */
export function Respond({ inv, onDone }: { inv: WInvitation; onDone?: () => void }) {
  const [status, setStatus] = useState(inv.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function answer(accepted: boolean) {
    setBusy(true);
    setError("");
    try {
      await api.respond(inv.id, accepted);
      setStatus(accepted ? "accepted" : "declined");
      onDone?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (status === "accepted" || status === "arrived")
    return (
      <Link href={`/visit/${inv.id}`} className="btn w-full">
        I&apos;m on my way — open visit
      </Link>
    );
  if (status !== "pending" && status !== "sent") return <p className="text-muted">Status: {status.replace("_", " ")}</p>;
  return (
    <div>
      <div className="grid grid-cols-2 gap-3">
        <button className="btn" disabled={busy} onClick={() => void answer(true)}>
          Accept
        </button>
        <button className="btn-ghost" disabled={busy} onClick={() => void answer(false)}>
          Not today
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-warn">
          {error}
        </p>
      )}
    </div>
  );
}
