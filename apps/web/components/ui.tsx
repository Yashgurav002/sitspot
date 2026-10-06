"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError } from "@/lib/api";

/** Load data on mount; bounces to /login on 401. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const router = useRouter();
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await run());
      setError(undefined);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return router.replace("/login");
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  }, [run, router]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p role="status" className="py-8 text-center text-muted">
      {label}
    </p>
  );
}

export function ErrorBox({ error, retry }: { error: Error; retry?: () => void }) {
  return (
    <div role="alert" className="card border-warn/40 text-warn">
      <p>{error.message}</p>
      {retry && (
        <button className="btn-ghost mt-3" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="card text-center text-muted">{children}</div>;
}

export function PageTitle({ children, sub }: { children: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <header className="mb-5">
      <h1 className="text-2xl font-semibold tracking-tight">{children}</h1>
      {sub && <p className="mt-1 text-muted">{sub}</p>}
    </header>
  );
}
