"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function ResetStatsPanel() {
  const [confirm, setConfirm] = useState("");
  const [isResetting, setIsResetting] = useState(false);
  const [status, setStatus] = useState("");

  const onReset = async () => {
    setStatus("");
    if (confirm.trim().toUpperCase() !== "RESET") {
      setStatus("Type RESET to confirm.");
      return;
    }

    setIsResetting(true);
    try {
      const res = await fetch("/api/admin/reset-stats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(payload?.error ?? "Reset failed"));

      setStatus(
        `Done: orders ${payload?.result?.ordersDeleted ?? 0}, logs ${payload?.result?.logsDeleted ?? 0}, users reset ${payload?.result?.usersReset ?? 0}.`,
      );
      setConfirm("");
    } catch (error) {
      setStatus(`Error: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setIsResetting(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Clears orders, logs, referral links, wallet balances, category discounts and cached assets.
      </p>
      <Input
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        placeholder="Type RESET to confirm"
        disabled={isResetting}
      />
      <Button type="button" variant="destructive" onClick={onReset} disabled={isResetting}>
        {isResetting ? "Resetting..." : "Reset All Stats"}
      </Button>
      {status ? <p className="text-xs text-muted-foreground">{status}</p> : null}
    </div>
  );
}

