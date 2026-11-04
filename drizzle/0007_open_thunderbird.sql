CREATE TABLE "tenant_policy" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"rules" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approval_request" ADD COLUMN "approved_by_rule" text;--> statement-breakpoint
ALTER TABLE "tenant_policy" ADD CONSTRAINT "tenant_policy_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_policy" ADD CONSTRAINT "tenant_policy_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;