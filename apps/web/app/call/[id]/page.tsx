"use client";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import { time } from "@/lib/format";
import { ErrorBox, Loading, useLoad } from "@/components/ui";
import { Respond } from "@/components/respond";
import { VoiceConversation } from "@/components/voice-conversation";

/** Opened from a push notification: the call, in the browser. */
export default function CallPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading, reload } = useLoad(() => Promise.all([api.invitation(id), api.spots()]), [id]);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  const [inv, spots] = data!;
  const spot = spots.find((s) => s.id === inv.spot_id);
  const script = inv.script ?? inv.reason;

  return (
    <div className="space-y-5">
      <header>
        <p className="text-sm font-medium text-accent">Sitspot is calling</p>
        <h1 className="text-2xl font-semibold">{spot?.name ?? "One of your spots"}</h1>
        <p className="text-muted">
          {time(inv.window_start)} – {time(inv.window_end)}
        </p>
      </header>
      <blockquote className="card text-lg leading-relaxed whitespace-pre-line">{script}</blockquote>
      <VoiceConversation invitationId={inv.id} script={script} />
      <Respond inv={inv} />
    </div>
  );
}
