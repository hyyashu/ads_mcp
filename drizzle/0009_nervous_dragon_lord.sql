CREATE TABLE "account_link" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"account_a_id" text NOT NULL,
	"account_b_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_link_ordered" CHECK ("account_link"."account_a_id" < "account_link"."account_b_id")
);
--> statement-breakpoint
ALTER TABLE "account_link" ADD CONSTRAINT "account_link_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_link" ADD CONSTRAINT "account_link_account_a_id_connected_account_id_fk" FOREIGN KEY ("account_a_id") REFERENCES "public"."connected_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_link" ADD CONSTRAINT "account_link_account_b_id_connected_account_id_fk" FOREIGN KEY ("account_b_id") REFERENCES "public"."connected_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_link_pair_uq" ON "account_link" USING btree ("account_a_id","account_b_id");--> statement-breakpoint
CREATE INDEX "account_link_tenant_idx" ON "account_link" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "account_link_b_idx" ON "account_link" USING btree ("account_b_id");