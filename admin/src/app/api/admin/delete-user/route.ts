import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

async function ensureBannedUsersTable(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS banned_users (
      userId INTEGER PRIMARY KEY,
      createdAt TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT ''
    )
  `);
}

export async function POST(req: Request) {
  try {
    await ensureBannedUsersTable();
    const payload = await req.json();
    const rawUserId = String(payload?.userId ?? "").trim();

    if (!/^\d+$/.test(rawUserId)) {
      return NextResponse.json({ error: "Invalid userId" }, { status: 400 });
    }

    const userId = BigInt(rawUserId);

    const result = await prisma.$transaction(async (tx) => {
      const userExists = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });
      if (!userExists) {
        return { notFound: true as const };
      }

      const referralsUnlinked = await tx.user.updateMany({
        where: { referrerId: userId },
        data: { referrerId: null },
      });

      const deletedOrders = await tx.order.deleteMany({
        where: { userId },
      });

      const deletedLogs = await tx.log.deleteMany({
        where: { userId },
      });

      await tx.$executeRaw`DELETE FROM banned_users WHERE userId = ${userId}`;

      await tx.user.delete({
        where: { id: userId },
      });

      return {
        notFound: false as const,
        referralsUnlinked: referralsUnlinked.count,
        deletedOrders: deletedOrders.count,
        deletedLogs: deletedLogs.count,
      };
    });

    if (result.notFound) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true, result });
  } catch (error) {
    console.error("delete-user route failed", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
