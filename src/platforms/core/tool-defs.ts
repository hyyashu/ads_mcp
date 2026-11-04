import type { z } from "zod";
import type { Platform } from "../../inventory";
import type { ReadTool, WriteTool } from "../../mcp/tool";

/**
 * One declaration helper for every platform's tools. A platform supplies its name and the default permission notes; each
 * tool may override them. Writes never run directly: the pipeline queues an approval first.
 */
type ReadDef<I extends z.ZodObject, O extends z.ZodType, S> = Omit<ReadTool<I, O, S>, "kind" | "platform" | "permissions"> & { permissions?: Partial<ReadTool["permissions"]> };
type WriteDef<I extends z.ZodObject, O extends z.ZodType, S> = Omit<WriteTool<I, O, S>, "kind" | "platform" | "permissions"> & { permissions?: Partial<WriteTool["permissions"]> };
interface Defaults {
  platformPermissions: string[];
  notes: string;
}

export function platformTools<S>(platform: Platform, defaults: { read: Defaults; write: Defaults }) {
  return {
    read<I extends z.ZodObject, O extends z.ZodType>(def: ReadDef<I, O, S>): ReadTool<I, O, S> {
      return { ...def, kind: "read", platform, permissions: { scope: "ads:read", ...defaults.read, ...def.permissions } };
    },
    write<I extends z.ZodObject, O extends z.ZodType>(def: WriteDef<I, O, S>): WriteTool<I, O, S> {
      return { ...def, kind: "write", platform, permissions: { scope: "ads:write", ...defaults.write, ...def.permissions } };
    },
  };
}

/** A value as text, or null when absent. Platforms differ only in how they find the value (see str / s). */
export const asText = (v: unknown): string | null => (v === undefined || v === null ? null : String(v));
