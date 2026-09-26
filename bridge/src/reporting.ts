// Jev Estimate formatting: English compact block with absolute token counts.
//
// Sourcing rule (2026-09-26 correction): values displayed under the
// "Jev Estimate" title must come from a genuine Jev estimate source. The
// existing Jev integration (jev-gate-core.mjs -> omoRoute() in
// jev-client.mjs, SystemOne backend via jevDecide) only answers
// routing-classification questions (complexity / need_ultrawork / skill /
// is_visual); it exposes no estimate endpoint. This module therefore
// provides formatting only, plus an explicit unavailable report. It must
// never compute local transcript arithmetic and present it as a Jev
// estimate. Without a genuine source the report stays unavailable.
//
// Format contract:
//   Jev Estimate
//   Codex tokens saved: ~<amount> tokens
//   Context avoided: ~<amount> tokens
// or, when no grounded genuine estimate exists:
//   Jev Estimate
//   Codex tokens saved: unavailable
//   Context avoided: unavailable
// No percentages, no allowance conversions, no context-window capacity
// substituted for savings.

export interface JevEstimate {
  codex_tokens_saved: number;
  context_avoided: number;
  available: boolean;
}

export interface JevEstimateReport extends JevEstimate {
  display: string;
}

/** Compact readable count: 999 -> "999", 1240 -> "1.2k", 1_000_000 -> "1m". */
export function formatTokenCount(value: number): string {
  const rounded = Math.max(0, Math.round(value));
  if (rounded < 1000) return `${rounded}`;
  if (rounded < 1_000_000) {
    const k = rounded / 1000;
    const text = k >= 100 ? `${Math.round(k)}` : `${(Math.round(k * 10) / 10)}`;
    return `${text.replace(/\.0$/, '')}k`;
  }
  const m = rounded / 1_000_000;
  const text = m >= 100 ? `${Math.round(m)}` : `${(Math.round(m * 10) / 10)}`;
  return `${text.replace(/\.0$/, '')}m`;
}

export function formatJevEstimate(report: JevEstimate): string {
  if (!report.available) {
    return 'Jev Estimate\nCodex tokens saved: unavailable\nContext avoided: unavailable';
  }
  return [
    'Jev Estimate',
    `Codex tokens saved: ~${formatTokenCount(report.codex_tokens_saved)} tokens`,
    `Context avoided: ~${formatTokenCount(report.context_avoided)} tokens`
  ].join('\n');
}

export function jevEstimateUnavailable(): JevEstimateReport {
  const estimate: JevEstimate = { codex_tokens_saved: 0, context_avoided: 0, available: false };
  return { ...estimate, display: formatJevEstimate(estimate) };
}
