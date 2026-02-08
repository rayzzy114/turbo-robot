import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

async function safeExecute(sql: string): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(sql);
  } catch {
    // Ignore optional/missing runtime tables.
  }
}

export async function POST(req: Request) {
  try {
    const payload = await req.json().catch(() => ({}));
    const confirm = String(payload?.confirm ?? "").trim().toUpperCase();
    if (confirm !== "RESET") {
      return NextResponse.json({ error: "Confirmation text must be RESET" }, { status: 400 });
    }

    const [ordersDeleted, logsDeleted, usersReset] = await prisma.$transaction([
      prisma.$executeRawUnsafe("DELETE FROM orders"),
      prisma.$executeRawUnsafe("DELETE FROM logs"),
      prisma.$executeRawUnsafe("UPDATE users SET walletBalance = 0, referrerId = NULL"),
    ]);

    await safeExecute("DELETE FROM category_discounts");
    await safeExecute("DELETE FROM asset_cache");

    return NextResponse.json({
      success: true,
      result: {
        ordersDeleted: Number(ordersDeleted ?? 0),
        logsDeleted: Number(logsDeleted ?? 0),
        usersReset: Number(usersReset ?? 0),
      },
    });
  } catch (error) {
    console.error("reset-stats route failed", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

