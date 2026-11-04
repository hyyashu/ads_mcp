CREATE TABLE "tool_execution" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"tool" text NOT NULL,
	"platform" text NOT NULL,
	"account_id" text,
	"request_id" text,
	"operation" text NOT NULL,
	"outcome" text NOT NULL,
	"error_code" text,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tool_execution" ADD CONSTRAINT "tool_execution_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_exec_tenant_time_idx" ON "tool_execution" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "tool_exec_request_idx" ON "tool_execution" USING btree ("request_id");