import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerEnv } from "@/lib/server-env";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const BROADCAST_DELAY_MS = 35;
type Segment =
  | "all"
  | "no_paid_24h"
  | "inactive_3d"
  | "inactive_7d"
  | "one_paid_no_repeat_7d"
  | "paid_no_referrals";

async function ensureBannedUsersTable(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS banned_users (
      userId INTEGER PRIMARY KEY,
      createdAt TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT ''
    )
  `);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendMessage(token: string, chatId: string, text: string) {
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok && payload?.ok, payload };
}

async function sendPhoto(token: string, chatId: string, photoFile: File, caption: string) {
  const body = new FormData();
  body.set("chat_id", chatId);
  if (caption) {
    body.set("caption", caption.slice(0, 1024));
    body.set("parse_mode", "HTML");
  }
  body.set("photo", photoFile, photoFile.name || "broadcast.jpg");

  const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendPhoto`, {
    method: "POST",
    body,
  });
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok && payload?.ok, payload };
}

export async function POST(req: Request) {
  try {
    await ensureBannedUsersTable();
    const token = getServerEnv("BOT_TOKEN");
    if (!token) {
      return NextResponse.json({ error: "BOT_TOKEN is missing" }, { status: 500 });
    }

    const formData = await req.formData();
    const text = String(formData.get("text") ?? "").trim();
    const photo = formData.get("photo");
    const mode = String(formData.get("mode") ?? "broadcast").trim().toLowerCase();
    const previewOnly = mode === "preview";
    const segment = String(formData.get("segment") ?? "all").trim().toLowerCase() as Segment;

    const hasPhoto = photo instanceof File && photo.size > 0;
    if (!text && !hasPhoto) {
      return NextResponse.json({ error: "Text or photo is required" }, { status: 400 });
    }

    const recipients: Array<{ id: bigint }> = [];
    if (previewOnly) {
      const adminTelegramIdRaw = getServerEnv("ADMIN_TELEGRAM_ID");
      if (!adminTelegramIdRaw || !/^\d+$/.test(adminTelegramIdRaw)) {
        return NextResponse.json(
          { error: "ADMIN_TELEGRAM_ID is missing or invalid" },
          { status: 500 },
        );
      }
      recipients.push({ id: BigInt(adminTelegramIdRaw) });
    } else {
      const nowMs = Date.now();
      const dayMs = 24 * 60 * 60 * 1000;
      const inactive3dThreshold = nowMs - 3 * dayMs;
      const inactive7dThreshold = nowMs - 7 * dayMs;
      const noPaid24hThreshold = nowMs - dayMs;

      let users: Array<{ id: bigint }> = [];
      if (segment === "no_paid_24h") {
        users = await prisma.$queryRaw<Array<{ id: bigint }>>`
          SELECT u.id
          FROM users u
          LEFT JOIN banned_users bu ON bu.userId = u.id
          WHERE bu.userId IS NULL
            AND CAST(u.createdAt AS INTEGER) <= ${noPaid24hThreshold}
            AND NOT EXISTS (
              SELECT 1 FROM orders o WHERE o.userId = u.id AND o.status LIKE 'paid%'
            )
          ORDER BY u.rowid ASC
        `;
      } else if (segment === "inactive_3d") {
        users = await prisma.$queryRaw<Array<{ id: bigint }>>`
          SELECT u.id
          FROM users u
          LEFT JOIN banned_users bu ON bu.userId = u.id
          LEFT JOIN (
            SELECT userId, MAX(CAST(createdAt AS INTEGER)) AS lastActivity
            FROM logs
            GROUP BY userId
          ) l ON l.userId = u.id
          WHERE bu.userId IS NULL
            AND COALESCE(l.lastActivity, CAST(u.createdAt AS INTEGER)) <= ${inactive3dThreshold}
          ORDER BY u.rowid ASC
        `;
      } else if (segment === "inactive_7d") {
        users = await prisma.$queryRaw<Array<{ id: bigint }>>`
          SELECT u.id
          FROM users u
          LEFT JOIN banned_users bu ON bu.userId = u.id
          LEFT JOIN (
            SELECT userId, MAX(CAST(createdAt AS INTEGER)) AS lastActivity
            FROM logs
            GROUP BY userId
          ) l ON l.userId = u.id
          WHERE bu.userId IS NULL
            AND COALESCE(l.lastActivity, CAST(u.createdAt AS INTEGER)) <= ${inactive7dThreshold}
          ORDER BY u.rowid ASC
        `;
      } else if (segment === "one_paid_no_repeat_7d") {
        users = await prisma.$queryRaw<Array<{ id: bigint }>>`
          SELECT u.id
          FROM users u
          LEFT JOIN banned_users bu ON bu.userId = u.id
          JOIN (
            SELECT userId, COUNT(1) AS paidCount, MAX(CAST(createdAt AS INTEGER)) AS lastPaidAt
            FROM orders
            WHERE status LIKE 'paid%'
            GROUP BY userId
          ) p ON p.userId = u.id
          WHERE bu.userId IS NULL
            AND p.paidCount = 1
            AND p.lastPaidAt <= ${inactive7dThreshold}
          ORDER BY u.rowid ASC
        `;
      } else if (segment === "paid_no_referrals") {
        users = await prisma.$queryRaw<Array<{ id: bigint }>>`
          SELECT u.id
          FROM users u
          LEFT JOIN banned_users bu ON bu.userId = u.id
          WHERE bu.userId IS NULL
            AND EXISTS (SELECT 1 FROM orders o WHERE o.userId = u.id AND o.status LIKE 'paid%')
            AND NOT EXISTS (SELECT 1 FROM users r WHERE r.referrerId = u.id)
          ORDER BY u.rowid ASC
        `;
      } else {
        users = await prisma.$queryRaw<Array<{ id: bigint }>>`
          SELECT u.id
          FROM users u
          LEFT JOIN banned_users bu ON bu.userId = u.id
          WHERE bu.userId IS NULL
          ORDER BY u.rowid ASC
        `;
      }
      recipients.push(...users);
    }

    let success = 0;
    let failed = 0;
    const failedUsers: string[] = [];

    for (const user of recipients) {
      const chatId = user.id.toString();
      try {
        const result = hasPhoto
          ? await sendPhoto(token, chatId, photo as File, text)
          : await sendMessage(token, chatId, text.slice(0, 4096));

        if (result.ok) {
          success += 1;
        } else {
          failed += 1;
          if (failedUsers.length < 25) {
            failedUsers.push(`${chatId}: ${String(result.payload?.description ?? "send failed")}`);
          }
        }
      } catch (error) {
        failed += 1;
        if (failedUsers.length < 25) {
          failedUsers.push(`${chatId}: ${error instanceof Error ? error.message : "unknown error"}`);
        }
      }
      await sleep(BROADCAST_DELAY_MS);
    }

    return NextResponse.json({
      success: true,
      mode: previewOnly ? "preview" : "broadcast",
      segment,
      total: recipients.length,
      sent: success,
      failed,
      failedUsers,
    });
  } catch (error) {
    console.error("Broadcast failed", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
