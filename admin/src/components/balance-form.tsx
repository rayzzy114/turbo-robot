"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Minus, Plus } from "lucide-react";

interface BalanceFormProps {
  userId: string;
}

export function BalanceForm({ userId }: BalanceFormProps) {
  const router = useRouter();
  const [amount, setAmount] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleAdjust = async (operation: "add" | "subtract") => {
    if (!amount || isNaN(parseFloat(amount))) return;

    setIsLoading(true);
    try {
      const res = await fetch("/api/admin/add-balance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, amount: parseFloat(amount), operation }),
      });
      if (res.ok) {
        setAmount("");
        router.refresh();
        return;
      }
      const payload = await res.json().catch(() => ({}));
      alert(payload?.error || "Failed to update balance");
    } catch (error) {
      console.error("Failed to update balance", error);
      alert("Failed to update balance");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void handleAdjust("add");
      }}
      className="flex items-center gap-1"
    >
      <Input
        type="number"
        step="0.01"
        min="0"
        placeholder="0.00"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        className="h-8 w-20 text-xs"
        disabled={isLoading}
      />
      <Button
        size="sm"
        variant="outline"
        className="h-8 px-2"
        disabled={isLoading}
        onClick={() => void handleAdjust("add")}
        type="button"
        title="Add balance"
      >
        <Plus className="h-4 w-4" />
      </Button>
      <Button
        size="sm"
        variant="secondary"
        className="h-8 px-2"
        disabled={isLoading}
        onClick={() => void handleAdjust("subtract")}
        type="button"
        title="Subtract balance"
      >
        <Minus className="h-4 w-4" />
      </Button>
    </form>
  );
}
