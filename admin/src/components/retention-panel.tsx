"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";

type RetentionStats = {
  usersNoPaid: number;
  usersNoPaid24h: number;
  inactive3d: number;
  inactive7d: number;
  onePaidNoRepeat7d: number;
  paidNoReferrals: number;
};

const SEGMENTS: Array<{ key: string; label: string; countKey: keyof RetentionStats; hint: string }> = [
  { key: "no_paid_24h", label: "No payment in 24h", countKey: "usersNoPaid24h", hint: "Signed up but did not make first payment within 24h" },
  { key: "inactive_3d", label: "Inactive 3 days", countKey: "inactive3d", hint: "No return activity for 3+ days" },
  { key: "inactive_7d", label: "Inactive 7 days", countKey: "inactive7d", hint: "No return activity for 7+ days" },
  { key: "one_paid_no_repeat_7d", label: "1 payment, no repeat", countKey: "onePaidNoRepeat7d", hint: "Only one paid order, no repeat for 7+ days" },
  { key: "paid_no_referrals", label: "Paid, no referrals", countKey: "paidNoReferrals", hint: "Paying users who never invited anyone" },
];

const TEMPLATES: Array<{ label: string; text: string }> = [
  {
    label: "Winback 3 days",
    text: "Hey! We noticed you have been inactive for a while.\n\nIf you want, we can prepare a playable for your offer and GEO today.\nJust reply with: <b>game + GEO + CTA</b>.\nWe will prioritize your request and send it fast.",
  },
  {
    label: "First payment nudge",
    text: "You are very close to launch.\n\nYour first playable can go live today.\nSend <b>game, GEO and CTA</b> and we will deliver a ready-to-launch singlefile quickly.\nNo extra friction, just test and scale.",
  },
  {
    label: "Referral nudge",
    text: "You already have experience with playables, so you can get more value.\n\nInvite colleagues using your referral link in profile.\nYou will receive balance bonuses for paid orders from invited users.\nIf needed, we can help you frame the invitation message.",
  },
];

export function RetentionPanel({ stats }: { stats: RetentionStats }) {
  const [segment, setSegment] = useState<string>(SEGMENTS[0].key);
  const [text, setText] = useState<string>(TEMPLATES[0].text);
  const [isSending, setIsSending] = useState(false);
  const [status, setStatus] = useState("");

  const activeSegment = useMemo(
    () => SEGMENTS.find((s) => s.key === segment) ?? SEGMENTS[0],
    [segment],
  );
  const count = stats[activeSegment.countKey];

  const send = async (mode: "preview" | "broadcast") => {
    setStatus("");
    if (!text.trim()) {
      setStatus("Message is required.");
      return;
    }
    setIsSending(true);
    try {
      const body = new FormData();
      body.set("text", text);
      body.set("mode", mode);
      body.set("segment", segment);
      const res = await fetch("/api/admin/broadcast", { method: "POST", body });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(payload?.error ?? "Broadcast failed"));
      setStatus(
        mode === "preview"
          ? `Preview sent: ${payload.sent}/${payload.total}, failed ${payload.failed}`
          : `Campaign done (${payload.segment}): ${payload.sent}/${payload.total}, failed ${payload.failed}`,
      );
    } catch (error) {
      setStatus(`Error: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap gap-1">
        {SEGMENTS.map((item) => (
          <Button
            key={item.key}
            type="button"
            size="xs"
            variant={segment === item.key ? "secondary" : "outline"}
            className="h-7 px-2 text-[11px]"
            onClick={() => setSegment(item.key)}
          >
            {item.label} ({stats[item.countKey]})
          </Button>
        ))}
      </div>

      <div className="rounded-md border bg-muted/20 p-2">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Active Segment</p>
        <p className="text-sm font-semibold">{activeSegment.label}</p>
        <p className="text-[11px] leading-snug text-muted-foreground">{activeSegment.hint}</p>
        <p className="mt-0.5 text-[11px]">Reach: {count}</p>
      </div>

      <div className="flex flex-wrap gap-1">
        {TEMPLATES.map((tpl) => (
          <Button key={tpl.label} type="button" variant="outline" size="xs" className="h-7 px-2 text-[11px]" onClick={() => setText(tpl.text)}>
            {tpl.label}
          </Button>
        ))}
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Retention message (HTML supported)"
        className="min-h-20 rounded-md border bg-background px-2 py-1.5 text-xs leading-snug"
        disabled={isSending}
      />

      <div className="flex flex-wrap gap-1">
        <Button type="button" size="sm" variant="outline" className="h-8 px-2.5 text-xs" disabled={isSending} onClick={() => void send("preview")}>
          {isSending ? "Sending..." : "Send test"}
        </Button>
        <Button type="button" size="sm" className="h-8 px-2.5 text-xs" disabled={isSending || count === 0} onClick={() => void send("broadcast")}>
          {isSending ? "Sending..." : `Run (${count})`}
        </Button>
      </div>

      {status ? <p className="text-[11px] text-muted-foreground">{status}</p> : null}
    </div>
  );
}
