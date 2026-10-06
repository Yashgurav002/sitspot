"use client";
// Client-only (imported via next/dynamic with ssr:false). Plain Leaflet, OSM tiles.
import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

export type LatLon = { lat: number; lon: number };
const VASAI: LatLon = { lat: 19.3919, lon: 72.8397 };

export default function SpotMap({
  spots,
  picked,
  onPick,
}: {
  spots: (LatLon & { name: string })[];
  picked: LatLon | null;
  onPick: (p: LatLon) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map>(null);
  const layer = useRef<L.LayerGroup>(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  useEffect(() => {
    const first = spots[0] ?? VASAI;
    const m = L.map(el.current!).setView([first.lat, first.lon], 13);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(m);
    m.on("click", (e) => pickRef.current({ lat: e.latlng.lat, lon: e.latlng.lng }));
    map.current = m;
    layer.current = L.layerGroup().addTo(m);
    return () => {
      m.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const g = layer.current!;
    g.clearLayers();
    for (const s of spots)
      L.circleMarker([s.lat, s.lon], { radius: 7, color: "#2f6b4f", fillOpacity: 0.6 }).bindTooltip(s.name).addTo(g);
    if (picked) {
      L.circleMarker([picked.lat, picked.lon], { radius: 10, color: "#c2410c", fillOpacity: 0.8 }).addTo(g);
      map.current!.panTo([picked.lat, picked.lon]);
    }
  }, [spots, picked]);

  return (
    <div
      ref={el}
      role="application"
      aria-label="Map. Tap to place the spot."
      className="h-64 w-full overflow-hidden rounded-2xl border border-line"
    />
  );
}
