-- A funnel stage needs a distinct count over the WHOLE window, not a sum of daily distincts.
-- Summing per-day uniques counts a returning user once per day they appear, which inflates every
-- stage by a different factor and can leave a later stage larger than an earlier one.
-- The aggregate state merges across days into one true distinct count.
ALTER TABLE gold.funnel_daily
    ADD COLUMN IF NOT EXISTS entered_users AggregateFunction(uniqExact, String);
