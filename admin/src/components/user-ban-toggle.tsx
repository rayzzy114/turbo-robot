"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

interface UserBanToggleProps {
  userId: string;
  isBanned: boolean;
}

export function UserBanToggle({ userId, isBanned }: UserBanToggleProps) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);

  const toggle = async () => {
    setIsLoading(true);
    try {
      const res = await fetch("/api/admin/ban-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          ban: !isBanned,
          reason: !isBanned ? "Banned via admin panel" : "",
        }),
      });
      if (res.ok) {
        router.refresh();
      }
    } catch (error) {
      console.error("Failed to toggle ban", error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Button
      size="sm"
      variant={isBanned ? "secondary" : "destructive"}
      className="h-8 px-2"
      disabled={isLoading}
      onClick={toggle}
      type="button"
    >
      {isBanned ? "Unban" : "Ban"}
    </Button>
  );
}
