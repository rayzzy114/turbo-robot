import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { requireAdminAuth } from "@/lib/admin-auth";
import type { Prisma } from "@prisma/client";

function hasPrismaCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}

export async function POST(req: Request) {
  const authError = requireAdminAuth(req);
  if (authError) return authError;

  try {
    const { userId, amount, operation } = await req.json();
    const rawUserId = String(userId ?? "").trim();
    if (!/^\d+$/.test(rawUserId)) {
      return NextResponse.json({ error: "Invalid userId" }, { status: 400 });
    }

    const adjustAmount = Number(amount);
    if (!Number.isFinite(adjustAmount) || adjustAmount <= 0 || adjustAmount > 1_000_000) {
      return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
    }

    const normalizedOperation: "add" | "subtract" =
      operation === "subtract" ? "subtract" : "add";

    const targetId = BigInt(rawUserId);
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const user = await tx.user.findUnique({
        where: { id: targetId },
        select: { walletBalance: true },
      });
      if (!user) {
        throw Object.assign(new Error("User not found"), { code: "P2025" });
      }

      if (normalizedOperation === "subtract" && user.walletBalance < adjustAmount) {
        return { insufficientBalance: true as const };
      }

      await tx.user.update({
        where: { id: targetId },
        data:
          normalizedOperation === "subtract"
            ? { walletBalance: { decrement: adjustAmount } }
            : { walletBalance: { increment: adjustAmount } },
      });

      await tx.log.create({
        data: {
          userId: targetId,
          action:
            normalizedOperation === "subtract"
              ? "admin_panel_subtract_balance"
              : "admin_panel_add_balance",
          details:
            normalizedOperation === "subtract"
              ? `Subtracted $${adjustAmount} via Next.js Admin`
              : `Added $${adjustAmount} via Next.js Admin`,
        },
      });

      return { insufficientBalance: false as const };
    });

    if (result.insufficientBalance) {
      return NextResponse.json({ error: "Insufficient wallet balance" }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    if (hasPrismaCode(error, "P2025")) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    console.error("Error adding balance", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
