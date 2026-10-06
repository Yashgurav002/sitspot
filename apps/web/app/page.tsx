"use client";
import Link from "next/link";
import { api, type WSpot } from "@/lib/api";
import { currentHour, leaveBy, openInvitation, summarise, time } from "@/lib/format";
import { Empty, ErrorBox, Loading, PageTitle, useLoad } from "@/components/ui";
import { Respond } from "@/components/respond";

export default function Home() {
  const { data, error, loading, reload } = useLoad(() => Promise.all([api.spots(), api.invitations()]));

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  const [spots, invitations] = data!;
  const inv = openInvitation(invitations);
  const spot = inv && spots.find((s) => s.id === inv.spot_id);

  return (
    <>
      <PageTitle sub="Your places, calling you.">Sitspot</PageTitle>

      <section aria-labelledby="next" className="mb-8">
        <h2 id="next" className="sr-only">
          Next invitation
        </h2>
        {inv ? (
          <article className="card space-y-3">
            <p className="text-sm font-medium text-accent">An invitation</p>
            <h3 className="text-xl font-semibold">{spot?.name ?? "One of your spots"}</h3>
            <p>{inv.reason}</p>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <dt className="text-muted">Window</dt>
                <dd>
                  {time(inv.window_start)} – {time(inv.window_end)}
                </dd>
              </div>
              <div>
                <dt className="text-muted">Leave by</dt>
                <dd>{time(leaveBy(inv.window_start, spot?.travel_min ?? 0))}</dd>
              </div>
            </dl>
            <Respond inv={inv} />
            <Link href={`/invitations/${inv.id}`} className="block text-sm text-muted underline">
              Why this?
            </Link>
          </article>
        ) : (
          <Empty>Nothing calling right now. We&apos;ll ring when one of your places is worth it.</Empty>
        )}
      </section>

      <section aria-labelledby="today" className="mb-8">
        <h2 id="today" className="mb-3 text-lg font-semibold">
          Your spots today
        </h2>
        {spots.length === 0 ? (
          <Empty>
            No spots yet.{" "}
            <Link href="/spots" className="text-accent underline">
              Add 3–5 places
            </Link>{" "}
            you could actually go.
          </Empty>
        ) : (
          <ul className="space-y-2">
            {spots.map((s) => (
              <SpotRow key={s.id} spot={s} />
            ))}
          </ul>
        )}
      </section>

      <nav className="flex gap-4 text-sm">
        <Link href="/invitations" className="text-accent underline">
          Invitation history
        </Link>
        <Link href="/notes" className="text-accent underline">
          Field notes
        </Link>
      </nav>
    </>
  );
}

function SpotRow({ spot }: { spot: WSpot }) {
  const { data, error, loading } = useLoad(() => api.conditions(spot.id, 12), [spot.id]);
  return (
    <li className="card flex items-baseline justify-between gap-3">
      <div>
        <p className="font-medium">{spot.name}</p>
        <p className="text-xs text-muted capitalize">
          {spot.kind} · {spot.travel_min} min away
        </p>
      </div>
      <p className="text-right text-sm text-muted">
        {loading ? "…" : error ? "Conditions unavailable" : summarise(currentHour(data?.conditions ?? []))}
      </p>
    </li>
  );
}
