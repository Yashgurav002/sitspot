"use client";
// Root-layout errors. Reports to Sentry (no-op without a DSN) and offers a retry.
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
        <h2>Something went wrong.</h2>
        <button onClick={() => retry()}>Try again</button>
      </body>
    </html>
  );
}
