"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

export function BroadcastPanel() {
  const [text, setText] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isPollingJob, setIsPollingJob] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
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

  useEffect(() => {
    if (!activeJobId) return;

    let cancelled = false;
    setIsPollingJob(true);

    const pullStatus = async () => {
      try {
        const res = await fetch(`/api/admin/broadcast?jobId=${encodeURIComponent(activeJobId)}`);
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(String(payload?.error ?? "Failed to get job status"));
        }
        const job = payload?.job;
        if (!job || typeof job !== "object") return;

        const sent = Number(job.sent ?? 0);
        const total = Number(job.total ?? 0);
        const failed = Number(job.failed ?? 0);
        const jobStatus = String(job.status ?? "");

        if (jobStatus === "completed") {
          setStatus(`Broadcast completed: sent ${sent}/${total}, failed ${failed}`);
          setIsPollingJob(false);
          setActiveJobId(null);
          return;
        }

        if (jobStatus === "failed") {
          const error = String(job.error ?? "unknown error");
          setStatus(`Broadcast failed: ${error}`);
          setIsPollingJob(false);
          setActiveJobId(null);
          return;
        }

        setStatus(`Broadcast in progress: sent ${sent}/${total}, failed ${failed}`);
      } catch (error) {
        if (!cancelled) {
          setStatus(`Error: ${error instanceof Error ? error.message : "failed to fetch job status"}`);
          setIsPollingJob(false);
          setActiveJobId(null);
        }
      }
    };

    void pullStatus();
    const timer = window.setInterval(() => void pullStatus(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeJobId]);

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
        const jobId = String(payload?.jobId ?? "").trim();
        if (!jobId) {
          throw new Error("Broadcast queued without jobId");
        }
        setActiveJobId(jobId);
        setStatus(`Broadcast queued: 0/${payload.total}, failed 0`);
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
        disabled={isSending || isPollingJob}
      />
      <input
        type="file"
        accept="image/*"
        onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
        disabled={isSending || isPollingJob}
      />
      {photo ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{photo.name}</span>
          <Button type="button" variant="ghost" size="sm" disabled={isSending || isPollingJob} onClick={clearPhoto}>
            Remove file
          </Button>
        </div>
      ) : null}
      <div className="flex gap-2">
        <Button type="button" variant="outline" disabled={isSending || isPollingJob} onClick={() => void submit("preview")}>
          {isSending ? "Sending..." : "Send test to Telegram"}
        </Button>
        <Button type="submit" disabled={isSending || isPollingJob}>
          {isSending ? "Sending..." : isPollingJob ? "Broadcast in progress..." : "Send to all users"}
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
