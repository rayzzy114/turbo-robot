import { getAdminStats, getRecentOrders, getLatestUsers, getRecentLogs, getCategoryDiscounts } from "@/lib/data";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { BalanceForm } from "@/components/balance-form";
import { UserBanToggle } from "@/components/user-ban-toggle";
import { UserDeleteButton } from "@/components/user-delete-button";
import { AdminAutoRefresh } from "@/components/admin-auto-refresh";
import { CategoryDiscountsPanel } from "@/components/category-discounts-panel";
import { BroadcastPanel } from "@/components/broadcast-panel";
import { RetentionPanel } from "@/components/retention-panel";
import { ResetStatsPanel } from "@/components/reset-stats-panel";
import { MotionSection } from "@/components/motion-section";
import SpotlightCard from "@/components/SpotlightCard";
import { Users, DollarSign, ShoppingCart, TrendingUp, History, RefreshCw, Repeat } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

function formatMixedDate(value: unknown): string {
  if (value == null) return "n/a";
  const raw = String(value).trim();
  if (!raw) return "n/a";
  const asNumber = Number(raw);
  const date = Number.isFinite(asNumber) && /^\d{10,16}$/.test(raw)
    ? new Date(asNumber)
    : new Date(raw.replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? raw : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default async function AdminDashboard() {
  const stats = await getAdminStats();
  const orders = await getRecentOrders(15);
  const users = await getLatestUsers(10);
  const logs = await getRecentLogs(50);
  const discounts = await getCategoryDiscounts();

  return (
    <div className="relative">
      <div className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute inset-0 bg-[radial-gradient(1000px_560px_at_50%_0%,rgba(255,255,255,0.08),transparent_58%),radial-gradient(900px_540px_at_0%_100%,rgba(255,255,255,0.05),transparent_65%),linear-gradient(180deg,#050505_0%,#0a0a0a_45%,#101010_100%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(to_bottom,rgba(0,0,0,0.36),rgba(0,0,0,0.72))]" />
      </div>

      <div className="admin-ambient mx-auto flex max-w-[1200px] flex-col gap-6 px-5 py-6">
      <AdminAutoRefresh intervalMs={30000} />
      <div className="relative overflow-hidden rounded-2xl border border-white/20 bg-zinc-950/70 p-4 backdrop-blur-md admin-card-glow">
        <div className="relative flex justify-between items-center">
          <div>
          <h1 className="text-3xl font-bold tracking-tight admin-title-glow">Joystick Admin</h1>
          <p className="text-zinc-300">Manage your HTML5 Playable Ads bot</p>
          </div>
          <Link href="/">
            <Button variant="outline" size="sm" className="gap-2">
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
          </Link>
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-zinc-400">
        <span className="h-2 w-2 rounded-full bg-cyan-400/80" />
        Core Metrics
      </div>
      <MotionSection delay={0.03} className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <SpotlightCard className="!rounded-xl !p-0">
          <Card className="admin-glass-card admin-card-glow shadow-none">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Users</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="admin-numeric text-2xl font-bold">{stats.users}</div>
            <p className="text-xs text-muted-foreground">Lifetime registered users</p>
          </CardContent>
          </Card>
        </SpotlightCard>
        <SpotlightCard className="!rounded-xl !p-0">
          <Card className="admin-glass-card admin-card-glow shadow-none">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Revenue</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="admin-numeric text-2xl font-bold">${stats.revenue.toFixed(2)}</div>
            <p className="text-xs text-muted-foreground">Sum of all paid orders</p>
          </CardContent>
          </Card>
        </SpotlightCard>
        <SpotlightCard className="!rounded-xl !p-0">
          <Card className="admin-glass-card admin-card-glow shadow-none">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Paid Orders</CardTitle>
            <ShoppingCart className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="admin-numeric text-2xl font-bold">{stats.orders}</div>
            <p className="text-xs text-muted-foreground">Successfully delivered</p>
          </CardContent>
          </Card>
        </SpotlightCard>
        <SpotlightCard className="!rounded-xl !p-0">
          <Card className="admin-glass-card admin-card-glow shadow-none">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Conversion Rate</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="admin-numeric text-2xl font-bold">{stats.conversion}%</div>
            <p className="text-xs text-muted-foreground">Users to paid orders</p>
          </CardContent>
          </Card>
        </SpotlightCard>
      </MotionSection>

      <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-zinc-400">
        <span className="h-2 w-2 rounded-full bg-rose-400/80" />
        Referral Metrics
      </div>
      <MotionSection delay={0.05} className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card className="admin-glass-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Invited Users</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="admin-numeric text-2xl font-bold">{stats.referral.invitedUsers}</div>
            <p className="admin-numeric text-xs text-muted-foreground">{stats.referral.invitedUsersShare}% of total users</p>
          </CardContent>
        </Card>
        <Card className="admin-glass-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Referrers</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="admin-numeric text-2xl font-bold">{stats.referral.activeReferrers}</div>
            <p className="admin-numeric text-xs text-muted-foreground">K-factor proxy: {stats.referral.referralKFactorProxy}</p>
          </CardContent>
        </Card>
        <Card className="admin-glass-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Referral Revenue</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="admin-numeric text-2xl font-bold">${stats.referral.referralRevenue.toFixed(2)}</div>
            <p className="admin-numeric text-xs text-muted-foreground">{stats.referral.referralRevenueShare}% of total revenue</p>
          </CardContent>
        </Card>
        <Card className="admin-glass-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Invited to Paid</CardTitle>
            <ShoppingCart className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="admin-numeric text-2xl font-bold">{stats.referral.referralConversionFromInvited}%</div>
            <p className="text-xs text-muted-foreground">{stats.referral.referredPaidUsers} paid users from referrals</p>
          </CardContent>
        </Card>
      </MotionSection>

      <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-zinc-400">
        <span className="h-2 w-2 rounded-full bg-amber-400/80" />
        Operations
      </div>
      <MotionSection delay={0.07} className="grid items-start gap-3 md:grid-cols-2 lg:grid-cols-12">
        <Card className="admin-glass-card self-start gap-4 py-4 lg:col-span-3 lg:h-[340px]">
          <CardHeader className="pb-1">
            <CardTitle className="text-base">Referral Funnel Metrics (Auto)</CardTitle>
          </CardHeader>
          <CardContent className="overflow-y-auto pt-0">
            <div className="grid gap-2">
              <div className="rounded-md border p-2.5">
                <div className="text-xs text-muted-foreground">Referral Open Events</div>
                <div className="admin-numeric text-xl font-semibold">{stats.referral.events.referralOpen}</div>
              </div>
              <div className="rounded-md border p-2.5">
                <div className="text-xs text-muted-foreground">Referral Join Events</div>
                <div className="admin-numeric text-xl font-semibold">{stats.referral.events.referralJoin}</div>
              </div>
              <div className="rounded-md border p-2.5">
                <div className="text-xs text-muted-foreground">Referral Reward Events</div>
                <div className="admin-numeric text-xl font-semibold">{stats.referral.events.referralReward}</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="admin-glass-card self-start gap-4 py-4 lg:col-span-3 lg:h-[340px]">
          <CardHeader className="pb-1">
            <CardTitle className="text-base">Category Discounts</CardTitle>
          </CardHeader>
          <CardContent className="overflow-y-auto pt-0">
            <CategoryDiscountsPanel initialRows={discounts} />
          </CardContent>
        </Card>

        <SpotlightCard className="self-start !rounded-xl !border-primary/30 !bg-zinc-950 !p-4 lg:col-span-4 lg:h-[340px]">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-100">Retention Engine</h3>
            <Repeat className="h-4 w-4 text-zinc-300" />
          </div>
          <div className="max-h-[280px] overflow-y-auto pr-1">
            <RetentionPanel stats={stats.retention} />
          </div>
        </SpotlightCard>

        <Card className="admin-glass-card self-start gap-4 py-4 lg:col-span-2 lg:h-[340px]">
          <CardHeader className="pb-1">
            <CardTitle className="text-base">Danger Zone</CardTitle>
          </CardHeader>
          <CardContent className="overflow-y-auto pt-0">
            <ResetStatsPanel />
          </CardContent>
        </Card>
      </MotionSection>

      <MotionSection delay={0.09} className="grid gap-4 md:grid-cols-2">
        <Card className="admin-glass-card">
          <CardHeader>
            <CardTitle>Broadcast to Users</CardTitle>
          </CardHeader>
          <CardContent>
            <BroadcastPanel />
          </CardContent>
        </Card>
        <Card className="admin-glass-card">
          <CardHeader>
            <CardTitle>Retention Snapshot</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border p-3"><div className="text-xs text-muted-foreground">No paid ever</div><div className="admin-numeric text-lg font-semibold">{stats.retention.usersNoPaid}</div></div>
            <div className="rounded-md border p-3"><div className="text-xs text-muted-foreground">No paid in 24h+</div><div className="admin-numeric text-lg font-semibold">{stats.retention.usersNoPaid24h}</div></div>
            <div className="rounded-md border p-3"><div className="text-xs text-muted-foreground">Inactive 3d+</div><div className="admin-numeric text-lg font-semibold">{stats.retention.inactive3d}</div></div>
            <div className="rounded-md border p-3"><div className="text-xs text-muted-foreground">Inactive 7d+</div><div className="admin-numeric text-lg font-semibold">{stats.retention.inactive7d}</div></div>
            <div className="rounded-md border p-3"><div className="text-xs text-muted-foreground">One paid, no repeat</div><div className="admin-numeric text-lg font-semibold">{stats.retention.onePaidNoRepeat7d}</div></div>
            <div className="rounded-md border p-3"><div className="text-xs text-muted-foreground">Paid, no referrals</div><div className="admin-numeric text-lg font-semibold">{stats.retention.paidNoReferrals}</div></div>
          </CardContent>
        </Card>
      </MotionSection>

      <MotionSection delay={0.11} className="grid gap-8 md:grid-cols-3">
        <div className="md:col-span-2 flex flex-col gap-8">
          <Card className="admin-glass-card">
            <CardHeader>
              <CardTitle>Recent Orders</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>Game</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orders.map((order: any) => (
                    <TableRow key={order.orderId}>
                      <TableCell className="text-xs text-muted-foreground">{formatMixedDate(order.createdAt)}</TableCell>
                      <TableCell className="font-medium">@{order.username || order.userId}</TableCell>
                      <TableCell>{order.gameType}</TableCell>
                      <TableCell>
                        <Badge variant={order.status.startsWith("paid") || order.status === "delivered" ? "default" : order.status === "custom_pending" ? "outline" : "secondary"}>
                          {order.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="admin-numeric text-right">${order.amount}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card className="admin-glass-card">
            <CardHeader>
              <CardTitle>Latest Users</CardTitle>
            </CardHeader>
            <CardContent>
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[44%]">User</TableHead>
                    <TableHead className="w-[16%]">Wallet</TableHead>
                    <TableHead className="w-[10%]">Orders</TableHead>
                    <TableHead className="w-[30%] text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map((user: any) => (
                    <TableRow key={user.id}>
                      <TableCell className="whitespace-normal">
                        <div className="flex items-center gap-3">
                          <Avatar className="h-8 w-8">
                            <AvatarFallback>{user.firstName?.[0] || "U"}</AvatarFallback>
                          </Avatar>
                          <div className="flex min-w-0 flex-col">
                            <span className="truncate text-sm font-medium">{user.firstName || "Unknown"}</span>
                            <span className="truncate text-xs text-muted-foreground">
                              @{user.username || user.id}
                            </span>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="admin-numeric text-sm">${Number(user.walletBalance ?? 0).toFixed(2)}</TableCell>
                      <TableCell>{user.paid_orders}</TableCell>
                      <TableCell className="whitespace-normal text-right">
                        <div className="ml-auto flex max-w-[280px] flex-wrap justify-end gap-1">
                          <BalanceForm userId={user.id} />
                          <UserBanToggle userId={user.id} isBanned={Number(user.is_banned) === 1} />
                          <UserDeleteButton
                            userId={user.id}
                            label={user.username ? `@${user.username}` : user.firstName || undefined}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <SpotlightCard className="h-full !rounded-xl !p-0">
            <Card className="h-full border-0 bg-transparent shadow-none">
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-xl">Live Logs</CardTitle>
              <History className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent className="px-2">
              <Separator className="mb-4" />
              <div className="flex flex-col gap-4 max-h-[800px] overflow-y-auto px-4">
                {logs.map((log: any) => (
                  <div key={log.id} className="flex flex-col gap-1 border-l-2 border-muted pl-3 pb-3">
                    <div className="flex justify-between items-center">
                      <span className="text-xs font-bold text-primary uppercase">{log.action}</span>
                      <span className="text-[10px] text-muted-foreground">{formatMixedDate(log.createdAt)}</span>
                    </div>
                    <div className="text-sm">{log.details}</div>
                    <div className="text-[10px] text-muted-foreground">by {log.username ? `@${log.username}` : log.userId}</div>
                  </div>
                ))}
              </div>
            </CardContent>
            </Card>
          </SpotlightCard>
        </div>
      </MotionSection>
      </div>
    </div>
  );
}
