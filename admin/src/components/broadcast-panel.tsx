"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

export function BroadcastPanel() {
  const [text, setText] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [status, setStatus] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const clearPhoto = () => {
    setPhoto(null);
  };

  useEffect(() => {
    if (!photo) {
      setPreviewUrl(null);
      return;
    }
    const nextUrl = URL.createObjectURL(photo);
    setPreviewUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [photo]);

  const submit = async (mode: "preview" | "broadcast") => {
    setStatus("");
    if (!text.trim() && !photo) {
      setStatus("You need to provide message text or attach an image.");
      return;
    }

    setIsSending(true);
    try {
      const body = new FormData();
      body.set("text", text);
      if (photo) body.set("photo", photo);
      body.set("mode", mode);

      const res = await fetch("/api/admin/broadcast", {
        method: "POST",
        body,
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(payload?.error ?? "Broadcast failed"));
      if (mode === "preview") {
        setStatus(`Test sent: ${payload.sent}/${payload.total}, failed ${payload.failed}`);
      } else {
        setStatus(`Broadcast completed: sent ${payload.sent}/${payload.total}, failed ${payload.failed}`);
      }
    } catch (error) {
      setStatus(`Error: ${error instanceof Error ? error.message : "failed to send"}`);
    } finally {
      setIsSending(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit("broadcast");
      }}
      className="flex flex-col gap-3"
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Broadcast message text (HTML supported)"
        className="min-h-24 rounded-md border bg-background px-3 py-2 text-sm"
        disabled={isSending}
      />
      <input
        type="file"
        accept="image/*"
        onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
        disabled={isSending}
      />
      {photo ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{photo.name}</span>
          <Button type="button" variant="ghost" size="sm" disabled={isSending} onClick={clearPhoto}>
            Remove file
          </Button>
        </div>
      ) : null}
      <div className="flex gap-2">
        <Button type="button" variant="outline" disabled={isSending} onClick={() => void submit("preview")}>
          {isSending ? "Sending..." : "Send test to Telegram"}
        </Button>
        <Button type="submit" disabled={isSending}>
          {isSending ? "Sending..." : "Send to all users"}
        </Button>
      </div>
      <div className="rounded-md border bg-muted/30 p-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Local Preview</p>
        {previewUrl ? (
          <img src={previewUrl} alt="Preview" className="mb-2 max-h-52 rounded-md border object-contain" />
        ) : null}
        <div className="whitespace-pre-wrap rounded bg-background p-2 text-sm">{text || "Broadcast message text..."}</div>
      </div>
      {status ? <p className="text-xs text-muted-foreground">{status}</p> : null}
    </form>
  );
}
