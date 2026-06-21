/**
 * Structured, user-actionable error for the estimate pipeline.
 *
 * Product rule: /api/estimate ALWAYS returns real API data, never a placeholder
 * or heuristic fallback. When a real result can't be produced, we throw one of
 * these instead of substituting fake data — so the response can tell the caller
 * exactly WHAT is wrong and HOW to fix it.
 */
export interface EstimateErrorInit {
  /** Stable machine code, e.g. 'duffel_token_missing'. */
  code: string;
  /** What went wrong, in plain language. */
  message: string;
  /** How to fix it — concrete and actionable. */
  fix: string;
  /** Which part of the pipeline failed. */
  source: 'config' | 'input' | 'flights' | 'ai' | 'fx' | 'server';
  /** HTTP status to return to the client. */
  status: number;
  /** Optional raw upstream detail for debugging. */
  detail?: string;
}

export class EstimateError extends Error {
  readonly code: string;
  readonly fix: string;
  readonly source: EstimateErrorInit['source'];
  readonly status: number;
  readonly detail?: string;

  constructor(init: EstimateErrorInit) {
    super(init.message);
    this.name = 'EstimateError';
    this.code = init.code;
    this.fix = init.fix;
    this.source = init.source;
    this.status = init.status;
    this.detail = init.detail;
  }

  /** The JSON body returned to the client. */
  toResponse(): Record<string, unknown> {
    return {
      error: this.code,
      source: this.source,
      message: this.message,
      fix: this.fix,
      ...(this.detail ? { detail: this.detail } : {}),
    };
  }
}

export function isEstimateError(e: unknown): e is EstimateError {
  return e instanceof EstimateError;
}
