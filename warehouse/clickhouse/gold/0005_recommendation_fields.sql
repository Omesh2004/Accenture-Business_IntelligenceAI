-- The seven-field recommendation CLAUDE.md section 9 asks for. driver, confidence and the
-- monitoring plan were missing, so a recommendation could not be checked or followed up.
ALTER TABLE gold.recommendations
    ADD COLUMN IF NOT EXISTS driver     String  DEFAULT '' AFTER tenant_id,
    ADD COLUMN IF NOT EXISTS confidence Float64 DEFAULT 0  AFTER expected_impact,
    ADD COLUMN IF NOT EXISTS monitoring String  DEFAULT '' AFTER confidence;
