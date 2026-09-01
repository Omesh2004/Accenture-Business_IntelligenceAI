-- The counterfactual behind an estimated effect, so the claim can be audited.
-- Without these an estimate is a bare number; with them a reader can see what the segment did,
-- what it would have done, and what the placebo window said about the assumption.
ALTER TABLE gold.causal_effects ADD COLUMN IF NOT EXISTS counterfactual Float64 DEFAULT 0;
ALTER TABLE gold.causal_effects ADD COLUMN IF NOT EXISTS observed Float64 DEFAULT 0;
ALTER TABLE gold.causal_effects ADD COLUMN IF NOT EXISTS placebo_effect Float64 DEFAULT 0;
ALTER TABLE gold.causal_effects ADD COLUMN IF NOT EXISTS control_cells UInt32 DEFAULT 0;
