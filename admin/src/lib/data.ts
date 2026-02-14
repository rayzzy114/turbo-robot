import { prisma, serialize } from "./prisma";
import { PLAYABLE_CATEGORIES, normalizeDiscountPercent } from "./playable-categories";

type CategoryDiscountRow = {
  category: string;
  label: string;
  percent: number;
};

async function ensureBannedUsersTable(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS banned_users (
      userId INTEGER PRIMARY KEY,
      createdAt TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT ''
    )
  `);
}

function toEpochMsExpr(columnRef: string): string {
  return `
    CASE
      WHEN typeof(${columnRef}) = 'integer' THEN CAST(${columnRef} AS INTEGER)
      WHEN trim(CAST(${columnRef} AS TEXT)) GLOB '[0-9]*' THEN CAST(${columnRef} AS INTEGER)
      ELSE CAST(strftime('%s', ${columnRef}) AS INTEGER) * 1000
    END
  `;
}

export async function getAdminStats() {
  const usersCount = await prisma.user.count();
  const revenueAgg = await prisma.order.aggregate({
    _sum: { amount: true },
    where: { status: { startsWith: "paid" } },
  });
  const paidOrdersCount = await prisma.order.count({
    where: { status: { startsWith: "paid" } },
  });

  const conversion =
    usersCount > 0
      ? ((paidOrdersCount / usersCount) * 100).toFixed(2)
      : "0.00";

  const invitedUsersCount = await prisma.user.count({
    where: { referrerId: { not: null } },
  });
  const activeReferrersRows = await prisma.user.findMany({
    where: { referrerId: { not: null } },
    distinct: ["referrerId"],
    select: { referrerId: true },
  });
  const activeReferrersCount = activeReferrersRows.length;

  const referralPaidOrdersCount = await prisma.order.count({
    where: {
      status: { startsWith: "paid" },
      user: { referrerId: { not: null } },
    },
  });
  const referralRevenueAgg = await prisma.order.aggregate({
    _sum: { amount: true },
    where: {
      status: { startsWith: "paid" },
      user: { referrerId: { not: null } },
    },
  });
  const referredPaidUsersCount = await prisma.order.findMany({
    where: {
      status: { startsWith: "paid" },
      user: { referrerId: { not: null } },
    },
    distinct: ["userId"],
    select: { userId: true },
  });

  const referralRevenue = referralRevenueAgg._sum.amount || 0;
  const referralRevenueShare =
    (revenueAgg._sum.amount || 0) > 0
      ? ((referralRevenue / (revenueAgg._sum.amount || 0)) * 100).toFixed(2)
      : "0.00";
  const referralConversionFromInvited =
    invitedUsersCount > 0
      ? ((referredPaidUsersCount.length / invitedUsersCount) * 100).toFixed(2)
      : "0.00";
  const invitedUsersShare =
    usersCount > 0
      ? ((invitedUsersCount / usersCount) * 100).toFixed(2)
      : "0.00";
  const referralKFactorProxy =
    activeReferrersCount > 0
      ? (invitedUsersCount / activeReferrersCount).toFixed(2)
      : "0.00";
  const referralOpenEvents = await prisma.log.count({
    where: { action: "referral_open" },
  });
  const referralJoinEvents = await prisma.log.count({
    where: { action: "referral_join" },
  });
  const referralRewardEvents = await prisma.log.count({
    where: { action: "referral_reward" },
  });

  const nowMs = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const inactive3dThreshold = nowMs - 3 * dayMs;
  const inactive7dThreshold = nowMs - 7 * dayMs;
  const noPaid24hThreshold = nowMs - dayMs;
  const userCreatedAtMs = toEpochMsExpr("u.createdAt");
  const logCreatedAtMs = toEpochMsExpr("createdAt");
  const orderCreatedAtMs = toEpochMsExpr("createdAt");

  const usersNoPaid = await prisma.$queryRaw<Array<{ count: number }>>`
    SELECT COUNT(1) as count
    FROM users u
    WHERE NOT EXISTS (
      SELECT 1 FROM orders o
      WHERE o.userId = u.id AND o.status LIKE 'paid%'
    )
  `;

  const usersNoPaid24h = await prisma.$queryRawUnsafe<Array<{ count: number }>>(`
    SELECT COUNT(1) as count
    FROM users u
    WHERE ${userCreatedAtMs} <= ${noPaid24hThreshold}
      AND NOT EXISTS (
        SELECT 1 FROM orders o
        WHERE o.userId = u.id AND o.status LIKE 'paid%'
      )
  `);

  const inactive3d = await prisma.$queryRawUnsafe<Array<{ count: number }>>(`
    SELECT COUNT(1) as count
    FROM users u
    LEFT JOIN (
      SELECT userId, MAX(${logCreatedAtMs}) AS lastActivity
      FROM logs
      GROUP BY userId
    ) l ON l.userId = u.id
    WHERE COALESCE(l.lastActivity, ${userCreatedAtMs}) <= ${inactive3dThreshold}
  `);

  const inactive7d = await prisma.$queryRawUnsafe<Array<{ count: number }>>(`
    SELECT COUNT(1) as count
    FROM users u
    LEFT JOIN (
      SELECT userId, MAX(${logCreatedAtMs}) AS lastActivity
      FROM logs
      GROUP BY userId
    ) l ON l.userId = u.id
    WHERE COALESCE(l.lastActivity, ${userCreatedAtMs}) <= ${inactive7dThreshold}
  `);

  const onePaidNoRepeat7d = await prisma.$queryRawUnsafe<Array<{ count: number }>>(`
    SELECT COUNT(1) as count
    FROM users u
    JOIN (
      SELECT userId, COUNT(1) AS paidCount, MAX(${orderCreatedAtMs}) AS lastPaidAt
      FROM orders
      WHERE status LIKE 'paid%'
      GROUP BY userId
    ) p ON p.userId = u.id
    WHERE p.paidCount = 1
      AND p.lastPaidAt <= ${inactive7dThreshold}
  `);

  const paidNoReferrals = await prisma.$queryRaw<Array<{ count: number }>>`
    SELECT COUNT(1) as count
    FROM users u
    WHERE EXISTS (
      SELECT 1 FROM orders o WHERE o.userId = u.id AND o.status LIKE 'paid%'
    )
    AND NOT EXISTS (
      SELECT 1 FROM users r WHERE r.referrerId = u.id
    )
  `;

  return {
    users: usersCount,
    revenue: revenueAgg._sum.amount || 0,
    orders: paidOrdersCount,
    conversion,
    referral: {
      invitedUsers: invitedUsersCount,
      activeReferrers: activeReferrersCount,
      referredPaidUsers: referredPaidUsersCount.length,
      referralPaidOrders: referralPaidOrdersCount,
      referralRevenue,
      referralRevenueShare,
      referralConversionFromInvited,
      invitedUsersShare,
      referralKFactorProxy,
      estimatedPayout22: Number((referralRevenue * 0.22).toFixed(2)),
      events: {
        referralOpen: referralOpenEvents,
        referralJoin: referralJoinEvents,
        referralReward: referralRewardEvents,
      },
    },
    retention: {
      usersNoPaid: Number(usersNoPaid[0]?.count ?? 0),
      usersNoPaid24h: Number(usersNoPaid24h[0]?.count ?? 0),
      inactive3d: Number(inactive3d[0]?.count ?? 0),
      inactive7d: Number(inactive7d[0]?.count ?? 0),
      onePaidNoRepeat7d: Number(onePaidNoRepeat7d[0]?.count ?? 0),
      paidNoReferrals: Number(paidNoReferrals[0]?.count ?? 0),
    },
  };
}

export async function getRecentOrders(limit = 20) {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.trunc(limit))) : 20;
  const orders = await prisma.$queryRaw<
    Array<{
      orderId: string;
      userId: unknown;
      gameType: string;
      themeId: string;
      status: string;
      amount: number;
      discountApplied: number;
      createdAt: string;
      username: string | null;
      firstName: string | null;
    }>
  >`
    SELECT
      o.orderId,
      o.userId,
      o.gameType,
      o.themeId,
      o.status,
      o.amount,
      o.discountApplied,
      CAST(o.createdAt AS TEXT) AS createdAt,
      u.username,
      u.firstName
    FROM orders o
    LEFT JOIN users u ON u.id = o.userId
    ORDER BY o.rowid DESC
    LIMIT ${safeLimit}
  `;
  return serialize(orders);
}

export async function getLatestUsers(limit = 10) {
  await ensureBannedUsersTable();
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.trunc(limit))) : 10;
  const users = await prisma.$queryRaw<
    Array<{
      id: unknown;
      username: string | null;
      firstName: string | null;
      walletBalance: number;
      subscriptionEnd: string | null;
      createdAt: string;
      referrerId: unknown;
      paid_orders: number;
      is_banned: number;
    }>
  >`
    SELECT
      u.id,
      u.username,
      u.firstName,
      u.walletBalance,
      CAST(u.subscriptionEnd AS TEXT) AS subscriptionEnd,
      CAST(u.createdAt AS TEXT) AS createdAt,
      u.referrerId,
      CASE WHEN bu.userId IS NULL THEN 0 ELSE 1 END AS is_banned,
      (
        SELECT COUNT(1)
        FROM orders o
        WHERE o.userId = u.id AND o.status LIKE 'paid%'
      ) AS paid_orders
    FROM users u
    LEFT JOIN banned_users bu ON bu.userId = u.id
    ORDER BY u.rowid DESC
    LIMIT ${safeLimit}
  `;

  return serialize(users);
}

export async function getRecentLogs(limit = 50) {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.trunc(limit))) : 50;
  const logs = await prisma.$queryRaw<
    Array<{
      id: number;
      userId: unknown;
      action: string;
      details: string | null;
      createdAt: string;
      username: string | null;
      firstName: string | null;
    }>
  >`
    SELECT
      l.id,
      l.userId,
      l.action,
      l.details,
      CAST(l.createdAt AS TEXT) AS createdAt,
      u.username,
      u.firstName
    FROM logs l
    LEFT JOIN users u ON u.id = l.userId
    ORDER BY l.id DESC
    LIMIT ${safeLimit}
  `;
  return serialize(logs);
}

export async function getCategoryDiscounts(): Promise<CategoryDiscountRow[]> {
  const rawRows = (await prisma.$queryRaw`
    SELECT category, percent FROM category_discounts
  `) as Array<{ category: unknown; percent: unknown }>;

  const map = new Map<string, number>(
    rawRows.map((row) => [
      String(row.category),
      normalizeDiscountPercent(row.percent),
    ]),
  );

  return PLAYABLE_CATEGORIES.map((category) => ({
    category: category.key,
    label: category.label,
    percent: map.get(category.key) ?? 0,
  }));
}
