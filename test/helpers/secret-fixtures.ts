/**
 * Prefixes of token formats, assembled at runtime so that secret scanners
 * (gitleaks, GitHub push protection) do not flag test fixtures.
 * CONVERSION-PLAN §10.6.
 */
export const SK_LIVE = ["sk", "live", ""].join("_");
export const XOXB = ["xo", "xb-"].join("");
export const GHP = ["gh", "p_"].join("");
export const EYJ = ["ey", "J"].join("");
