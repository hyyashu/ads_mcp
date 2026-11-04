import { z } from "zod";
import type { ReadTool, WriteTool } from "../../../mcp/tool";
import type { MetaServices } from "../services";

export const ADS_READ = "ads_read";
export const ADS_MANAGEMENT = "ads_management";

export const accountId = z.string().min(1).describe("Connected Meta ad account id, as listed in your connections.");
export const metaId = z.string().regex(/^\d{1,25}$/, "numeric Meta object id");

type ReadDef<I extends z.ZodObject, O extends z.ZodType> = Omit<ReadTool<I, O, MetaServices>, "kind" | "platform" | "permissions"> & { permissions?: Partial<ReadTool["permissions"]> };
type WriteDef<I extends z.ZodObject, O extends z.ZodType> = Omit<WriteTool<I, O, MetaServices>, "kind" | "platform" | "permissions"> & { permissions?: Partial<WriteTool["permissions"]> };

/** Declares a Meta read tool. */
export function metaRead<I extends z.ZodObject, O extends z.ZodType>(def: ReadDef<I, O>): ReadTool<I, O, MetaServices> {
  return {
    ...def,
    kind: "read",
    platform: "meta_ads",
    permissions: { scope: "ads:read", platformPermissions: [ADS_READ], notes: "The Meta app needs the ads_read permission (Marketing API).", ...def.permissions },
  };
}

/** Declares a Meta write tool. Writes never run directly: the pipeline queues an approval first. */
export function metaWrite<I extends z.ZodObject, O extends z.ZodType>(def: WriteDef<I, O>): WriteTool<I, O, MetaServices> {
  return {
    ...def,
    kind: "write",
    platform: "meta_ads",
    permissions: { scope: "ads:write", platformPermissions: [ADS_MANAGEMENT], notes: "The Meta app needs ads_management, and the connected user needs an advertiser role on the ad account.", ...def.permissions },
  };
}

/** A string field, or null when absent. */
export const s = (row: Record<string, unknown>, k: string): string | null => (row[k] === undefined || row[k] === null ? null : String(row[k]));
