"use client";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import { FACTOR_MAX, barPct, day, leaveBy, time } from "@/lib/format";
import { ErrorBox, Loading, PageTitle, useLoad } from "@/components/ui";
import { Respond } from "@/components/respond";

const LABELS: Record<keyof typeof FACTOR_MAX, string> = {
  p_rich: "Bird activity (p_rich)",
  comfort: "Comfort",
  tide_fit: "Tide fit",
  light_bonus: "Light",
  novelty: "Novelty",
  availability: "Availability",
};

export default function InvitationDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading, reload } = useLoad(() => Promise.all([api.invitation(id), api.spots()]), [id]);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  const [inv, spots] = data!;
  const spot = spots.find((s) => s.id === inv.spot_id);
  const f = inv.factors;
  const prior = f.p_rich_model === "prior";

  return (
    <>
      <PageTitle sub={`${day(inv.window_start)} · ${time(inv.window_start)} – ${time(inv.window_end)}`}>
        {spot?.name ?? "Invitation"}
      </PageTitle>

      <section className="card mb-4 space-y-2">
        <p>{inv.reason}</p>
        <p className="text-sm text-muted">
          Leave by {time(leaveBy(inv.window_start, spot?.travel_min ?? 0))} · via {inv.channel} ·{" "}
          <span className="capitalize">{inv.status.replace("_", " ")}</span>
        </p>
        <Respond inv={inv} />
      </section>

      <section className="card mb-4" aria-labelledby="score">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 id="score" className="font-semibold">
            Score
          </h2>
          <span className="text-2xl font-semibold tabular-nums">{inv.score.toFixed(2)}</span>
        </div>
        <p className="mb-3 text-xs text-muted">Score = product of every factor below.</p>
        <ul className="space-y-3">
          {(Object.keys(LABELS) as (keyof typeof FACTOR_MAX)[]).map((k) => (
            <li key={k}>
              <div className="flex justify-between text-sm">
                <span>{LABELS[k]}</span>
                <span className="tabular-nums">{f[k].toFixed(2)}</span>
              </div>
              <div
                className="mt-1 h-2 rounded-full bg-line"
                role="meter"
                aria-label={LABELS[k]}
                aria-valuemin={0}
                aria-valuemax={FACTOR_MAX[k]}
                aria-valuenow={f[k]}
              >
                <div className="h-2 rounded-full bg-accent" style={{ width: `${barPct(k, f[k])}%` }} />
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted">
          {prior
            ? "Bird activity model: prior — no forecast yet, so this uses a flat 0.5."
            : `Bird activity model: ${f.p_rich_model}`}
        </p>
      </section>

      {inv.script && (
        <section className="card">
          <h2 className="mb-2 font-semibold">What it said</h2>
          <p className="whitespace-pre-line">{inv.script}</p>
        </section>
      )}
    </>
  );
}
