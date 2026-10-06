"use client";
import { useParams } from "next/navigation";
import { VisitApp } from "@/components/visit/visit-app";

/** Pocket mode for one invitation (spec §14). */
export default function VisitPage() {
  const { id } = useParams<{ id: string }>();
  return <VisitApp invitationId={id} />;
}
