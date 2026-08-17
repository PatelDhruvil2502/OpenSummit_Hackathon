CREATE TABLE "private_objects" (
	"object_key" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"body" "bytea" NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	CONSTRAINT "private_objects_byte_size_check" CHECK ("private_objects"."byte_size" >= 0 AND "private_objects"."byte_size" <= 12582912),
	CONSTRAINT "private_objects_body_size_check" CHECK (octet_length("private_objects"."body") = "private_objects"."byte_size"),
	CONSTRAINT "private_objects_sha256_check" CHECK (char_length("private_objects"."sha256") = 64)
);
--> statement-breakpoint
ALTER TABLE "private_objects" ADD CONSTRAINT "private_objects_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_private_objects_case" ON "private_objects" USING btree ("case_id");--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;
