"use client";
import { useState } from "react";
import { api, type WNote } from "@/lib/api";
import { day } from "@/lib/format";
import { Empty, ErrorBox, Loading, PageTitle, useLoad } from "@/components/ui";

export default function NotesPage() {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const { data, error, loading, reload } = useLoad(() => (query ? api.searchNotes(query) : api.notes()), [query]);

  return (
    <>
      <PageTitle sub="What you saw, in your places.">Field notes</PageTitle>
      <form
        role="search"
        className="mb-5 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(q.trim());
        }}
      >
        <label htmlFor="q" className="sr-only">
          Search notes
        </label>
        <input
          id="q"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="egrets on a falling tide…"
          className="field"
        />
        <button className="btn">Search</button>
      </form>
      {query && (
        <p className="mb-3 text-sm text-muted">
          Results for “{query}”.{" "}
          <button
            className="underline"
            onClick={() => {
              setQ("");
              setQuery("");
            }}
          >
            Show all
          </button>
        </p>
      )}
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorBox error={error} retry={reload} />
      ) : !data?.length ? (
        <Empty>{query ? "Nothing matched." : "No notes yet. They're written the evening after a visit."}</Empty>
      ) : (
        <ul className="space-y-3">
          {(query ? data : [...data].sort((a, b) => b.date.localeCompare(a.date))).map((n: WNote) => (
            <li key={n.id} className="card">
              <p className="mb-1 text-xs font-medium text-muted">{day(n.date)}</p>
              <p className="whitespace-pre-line">{n.body}</p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
