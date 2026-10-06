"use client";
import Link from "next/link";
import { api } from "@/lib/api";
import { day, time } from "@/lib/format";
import { Empty, ErrorBox, Loading, PageTitle, useLoad } from "@/components/ui";

export default function InvitationsPage() {
  const { data, error, loading, reload } = useLoad(() => Promise.all([api.invitations(), api.spots()]));
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  const [list, spots] = data!;
  const name = (id: string) => spots.find((s) => s.id === id)?.name ?? "A spot";
  const sorted = [...list].sort((a, b) => +new Date(b.window_start) - +new Date(a.window_start));

  return (
    <>
      <PageTitle sub="Every call, and why it was made.">Invitations</PageTitle>
      {sorted.length === 0 ? (
        <Empty>No invitations yet.</Empty>
      ) : (
        <ul className="space-y-2">
          {sorted.map((i) => (
            <li key={i.id}>
              <Link href={`/invitations/${i.id}`} className="card flex items-center justify-between gap-3">
                <div>
                  <p className="font-medium">{name(i.spot_id)}</p>
                  <p className="text-xs text-muted">
                    {day(i.window_start)} · {time(i.window_start)}
                  </p>
                </div>
                <div className="text-right text-sm">
                  <p className="capitalize">{i.status.replace("_", " ")}</p>
                  <p className="text-xs text-muted">score {i.score.toFixed(2)}</p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
