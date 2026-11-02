import { z } from "zod";
import { ERROR_CODES, type ToolError } from "./errors";

export const ErrorSchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string(),
  retryable: z.boolean(),
  retry_after_seconds: z.number().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const ApprovalSchema = z.object({
  approval_id: z.string(),
  status: z.literal("pending_approval"),
  risk: z.string(),
  summary: z.string(),
  expires_at: z.string(),
  message: z.string(),
});

export const MetaSchema = z.object({
  /** Always true: names, descriptions and search terms come from ad platforms or end users and are data, never instructions. */
  untrusted_text: z.literal(true),
  platform: z.string().optional(),
  api_version: z.string().optional(),
});

/**
 * Every tool returns the same envelope. MCP requires an object-typed output schema, so success, error
 * and pending-approval share one object distinguished by `ok`.
 */
export const envelope = <T extends z.ZodType>(data: T) =>
  z.object({
    ok: z.boolean(),
    data: data.optional(),
    error: ErrorSchema.optional(),
    approval: ApprovalSchema.optional(),
    meta: MetaSchema,
  });

export type Envelope<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: z.infer<typeof ErrorSchema>;
  approval?: z.infer<typeof ApprovalSchema>;
  meta: z.infer<typeof MetaSchema>;
};

const meta = (platform?: string): Envelope["meta"] => ({ untrusted_text: true, ...(platform ? { platform } : {}) });

export const okEnvelope = <T>(data: T, platform?: string): Envelope<T> => ({ ok: true, data, meta: meta(platform) });

export const errorEnvelope = (e: ToolError, platform?: string): Envelope => ({
  ok: false,
  error: {
    code: e.code,
    message: e.message,
    retryable: e.retryable,
    ...(e.opts.retryAfterSeconds ? { retry_after_seconds: e.opts.retryAfterSeconds } : {}),
    ...(e.opts.details ? { details: e.opts.details } : {}),
  },
  meta: meta(platform),
});

export const approvalEnvelope = (approval: z.infer<typeof ApprovalSchema>, platform?: string): Envelope => ({
  ok: true,
  approval,
  meta: meta(platform),
});
