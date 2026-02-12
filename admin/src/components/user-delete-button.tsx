"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface UserDeleteButtonProps {
  userId: string;
  label?: string;
}

export function UserDeleteButton({ userId, label }: UserDeleteButtonProps) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);

  const onDelete = async () => {
    const identity = label ? `${label} (${userId})` : userId;
    const confirmed = window.confirm(
      `Delete user ${identity} from DB?\nThis will also remove their orders and logs.`,
    );
    if (!confirmed) return;

    setIsLoading(true);
    try {
      const res = await fetch("/api/admin/delete-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (res.ok) {
        router.refresh();
        return;
      }
      const payload = await res.json().catch(() => ({}));
      alert(payload?.error || "Failed to delete user");
    } catch (error) {
      console.error("Failed to delete user", error);
      alert("Failed to delete user");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Button
      size="sm"
      variant="destructive"
      className="h-8 px-2"
      disabled={isLoading}
      onClick={onDelete}
      type="button"
      title="Delete user"
    >
      <Trash2 className="h-4 w-4" />
      <span className="sr-only">Delete user</span>
    </Button>
  );
}
