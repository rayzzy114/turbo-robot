# Referral Program Analysis for Telegram Playable Bot

## Skill Used
- `referral-program` (applied to infer program design from existing bot logic and DB state)

## What I analyzed
- `src/bot.ts`
- `src/db.ts`
- `src/config.ts`
- `prisma/schema.prisma`
- `bot_py/main.py`
- `bot_py/db.py`
- `data/bot.db`

## Current factual state (from code + DB)
- Referral flow already exists in product:
  - Deep link: `t.me/<bot>?start=<referrerId>`
  - Referrer is set once on first `/start` (self-referral blocked).
  - Reward trigger: when referred user completes a paid order.
  - Reward amount: `22%` of paid order amount, credited to referrer wallet balance.
- Built-in referral UI is minimal: shows link, invited count, wallet balance.
- No anti-fraud constraints for referrals are present (no cooldown, no cap, no KYC-like checks, no per-period limits).
- Product economics in code:
  - Single order price: `$349`
  - Subscription price: `$659`
- Database snapshot shows pre-revenue stage right now:
  - Users: `1`
  - Paid orders: `0`
  - Revenue: `0`
  - Referred users: `0`

## Answers to key strategy questions (self-inferred)

### 1) Program type
- **Primary:** Customer referral program (not affiliate, for now).
- Why: Bot already has native referral tracking and wallet rewards. Fastest path is to formalize and optimize what is implemented.

### 2) B2B or B2C
- **Likely B2B / prosumer B2B**.
- Why: Product sells playable ad generation assets at relatively high ticket (`$349/$659`) and has admin/manual payment operations typical for agency/media-buyer workflows.

### 3) LTV and CAC
- **Observed LTV:** not measurable yet (no paid orders in DB).
- **Working baseline LTV (planning assumption):** `$349-698` in first 30-60 days (1-2 orders per paying user), until real data appears.
- **Current CAC from other channels:** unknown / not instrumented yet.
- **Operational planning CAC target:** keep referral CAC (reward payouts only) under `15-20%` of paid revenue.

### 4) Existing program status
- **Yes, technically exists** but not fully productized:
  - attribution exists,
  - payout exists,
  - simple referral screen exists,
  - no lifecycle prompts, no terms, no fraud layer, no optimization experiments.

### 5) Incentives tried
- **Currently active incentive:** one-sided `22%` rev-share to referrer wallet.
- No evidence of tested alternatives (double-sided, tiered, capped, time-limited bonuses).

### 6) Is product naturally shareable?
- **Moderately shareable** in niche communities (media buyers, Telegram chats, small teams), but **not viral by default**.
- It likely needs intentional trigger moments and stronger in-flow prompts to generate consistent referrals.

### 7) Budget for rewards/commissions
- Given zero paid baseline, use a conservative staged budget:
  - Stage 1 (validation): up to `$300-500/month` in referral payouts.
  - Stage 2 (after first 10 paid orders): scale to `10-15%` of monthly paid revenue.
- Keep current 22% only as temporary beta if gross margin tolerates it; otherwise move to tiered payouts.

### 8) Tools/platforms
- **Now:** keep native in-bot + SQLite/Prisma tracking.
- **Near-term:** add analytics tables/events for referral funnel steps.
- **Later (optional):** external affiliate tooling only after stable PMF and recurring paid volume.

## Recommended referral model (v1)

### Structure
- Start with **customer referral only**.
- Move from flat 22% to **tiered one-sided** model:
  - 1-2 successful referrals/month: `15%`
  - 3-5 referrals/month: `18%`
  - 6+ referrals/month: `22%`
- Payout as internal wallet credit (already implemented).

### Trigger moments to ask for referral
- After successful payment confirmation.
- After successful final playable delivery.
- After second paid order (stronger social proof moment).

### Core funnel targets (first 30 days)
- `Referral link share rate` >= 20% of active users.
- `Referral join rate` >= 10% of invited clicks/starts.
- `Referral-to-first-paid conversion` >= 5%.

### Anti-fraud minimum layer
- Ignore referrals when inviter and invitee share same payment fingerprint / repeated suspicious pattern.
- Delay referral reward credit until order is final and non-refunded for N days.
- Add per-user monthly referral payout cap in beta.
- Log suspicious referral clusters for admin review.

## 30-day execution plan
- Week 1:
  - Define referral terms in bot copy.
  - Add event tracking for funnel stages (`share`, `join`, `first_paid`, `reward_paid`).
- Week 2:
  - Add post-payment/post-delivery referral CTA blocks.
  - Add personal progress text in profile (e.g., "1 more paid referral to unlock X% tier").
- Week 3:
  - Launch A/B test: flat 22% vs tiered model.
  - Launch A/B test: simple copy vs urgency copy.
- Week 4:
  - Evaluate payout-to-revenue ratio, paid referral quality, and fraud flags.
  - Freeze winning variant and publish v1 policy.

## Risks and assumptions
- Main risk: overpaying referrals before true margin is validated.
- Main data gap: no paid cohort yet, so LTV/CAC are temporary assumptions.
- Recommendation: treat current setup as beta and re-baseline after first 10-20 paid orders.

## Decision summary
- Use **referral program now**, postpone affiliate program.
- Keep native implementation, add instrumentation and anti-fraud.
- Shift to tiered economics as soon as first paid data appears.
