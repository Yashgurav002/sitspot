"use client";
import { useState } from "react";
import dynamic from "next/dynamic";
import { SpotKind, type SpotInput } from "@sitspot/shared";
import { api, type WSpot } from "@/lib/api";
import { Empty, ErrorBox, Loading, PageTitle, useLoad } from "@/components/ui";
import type { LatLon } from "@/components/spot-map";

const SpotMap = dynamic(() => import("@/components/spot-map"), {
  ssr: false,
  loading: () => <div className="h-64 rounded-2xl border border-line bg-surface" aria-hidden />,
});

const MAX_SPOTS = 5;

export default function SpotsPage() {
  const { data: spots, error, loading, reload } = useLoad(api.spots);
  const [editing, setEditing] = useState<WSpot | "new" | null>(null);

  if (loading && !spots) return <Loading />;
  if (error && !spots) return <ErrorBox error={error} retry={reload} />;
  const list = spots ?? [];

  async function remove(s: WSpot) {
    if (!confirm(`Remove ${s.name}?`)) return;
    try {
      await api.deleteSpot(s.id);
      await reload();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  return (
    <>
      <PageTitle sub="3–5 places you could actually go.">Spots</PageTitle>

      {editing ? (
        <SpotForm
          key={editing === "new" ? "new" : editing.id}
          spot={editing === "new" ? undefined : editing}
          others={list}
          onCancel={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      ) : list.length >= MAX_SPOTS ? (
        <p className="mb-4 text-sm text-muted">Five spots is plenty. Remove one to add another.</p>
      ) : (
        <button className="btn mb-5 w-full" onClick={() => setEditing("new")}>
          Add a spot
        </button>
      )}

      {list.length === 0 && !editing ? (
        <Empty>No spots yet. Your terrace counts.</Empty>
      ) : (
        <ul className="mt-4 space-y-2" aria-label="Your spots">
          {list.map((s) => (
            <li key={s.id} className="card flex items-center justify-between gap-2">
              <div>
                <p className="font-medium">{s.name}</p>
                <p className="text-xs text-muted capitalize">
                  {s.kind} · {s.travel_min} min away
                </p>
              </div>
              <div className="flex gap-2">
                <button className="btn-ghost px-3" onClick={() => setEditing(s)} aria-label={`Edit ${s.name}`}>
                  Edit
                </button>
                <button className="btn-ghost px-3" onClick={() => void remove(s)} aria-label={`Remove ${s.name}`}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function SpotForm({
  spot,
  others,
  onCancel,
  onSaved,
}: {
  spot?: WSpot;
  others: WSpot[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(spot?.name ?? "");
  const [kind, setKind] = useState<SpotKind>(spot?.kind ?? "park");
  const [travel, setTravel] = useState(String(spot?.travel_min ?? 10));
  const [pos, setPos] = useState<LatLon | null>(spot ? { lat: spot.lat, lon: spot.lon } : null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function locate() {
    if (!navigator.geolocation) return setError("Location isn't available in this browser.");
    navigator.geolocation.getCurrentPosition(
      (p) => setPos({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => setError("Couldn't get your location. Tap the map instead."),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!pos) return setError("Tap the map or use your location to place the spot.");
    const body: SpotInput = { name: name.trim(), kind, lat: pos.lat, lon: pos.lon, travel_min: Number(travel) };
    setBusy(true);
    setError("");
    try {
      if (spot) await api.updateSpot(spot.id, body);
      else await api.createSpot(body);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="card mb-4 space-y-4" aria-label={spot ? "Edit spot" : "New spot"}>
      <SpotMap spots={others.filter((o) => o.id !== spot?.id)} picked={pos} onPick={setPos} />
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="text-muted">
          {pos ? `${pos.lat.toFixed(4)}, ${pos.lon.toFixed(4)}` : "Tap the map to place it"}
        </span>
        <button type="button" className="btn-ghost px-3" onClick={locate}>
          Use my location
        </button>
      </div>
      <div>
        <label htmlFor="spot-name" className="label">
          Name
        </label>
        <input
          id="spot-name"
          required
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="field"
          placeholder="Terrace, creek edge, the fort…"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="spot-kind" className="label">
            Kind
          </label>
          <select id="spot-kind" value={kind} onChange={(e) => setKind(e.target.value as SpotKind)} className="field capitalize">
            {SpotKind.options.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="spot-travel" className="label">
            Travel (min)
          </label>
          <input
            id="spot-travel"
            type="number"
            inputMode="numeric"
            min={0}
            max={180}
            required
            value={travel}
            onChange={(e) => setTravel(e.target.value)}
            className="field"
          />
        </div>
      </div>
      {kind === "coastal" && (
        <p className="text-sm text-muted">Coastal spots follow tide and daylight safety rules. Firm ground only.</p>
      )}
      {error && (
        <p role="alert" className="text-warn">
          {error}
        </p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <button type="button" className="btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn" disabled={busy}>
          {busy ? "Saving…" : "Save spot"}
        </button>
      </div>
    </form>
  );
}
