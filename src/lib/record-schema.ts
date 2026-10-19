import { z } from "zod";
import type { Field } from "../services/collection.service";


const REQUIRED_ERROR = "This field is required";

type SchemaCheck = z.core.$ZodCheck<unknown>;

function lengthConstraints(base: z.ZodType, field: Field): z.ZodType {
  if (typeof field.min !== "number" && typeof field.max !== "number") {
    return base;
  }
  const checks: SchemaCheck[] = [];
  if (typeof field.min === "number") {
    checks.push(z.minLength(field.min, `Must be at least ${field.min} characters`) as unknown as SchemaCheck);
  }
  if (typeof field.max === "number") {
    checks.push(z.maxLength(field.max, `Must be at most ${field.max} characters`) as unknown as SchemaCheck);
  }
  return base.check(...checks);
}

export function buildFieldZodType(field: Field): z.ZodType {
  switch (field.type) {
    case "text":
    case "date": {
      let base: z.ZodType = z.string();
      base = lengthConstraints(base, field);
      return base;
    }
    case "email": {
      let base: z.ZodType = z.email();
      base = lengthConstraints(base, field);
      return base;
    }
    case "url": {
      let base: z.ZodType = z.url();
      base = lengthConstraints(base, field);
      return base;
    }
    case "number": {
      let base = z.number({ error: "Must be a number" });
      if (typeof field.min === "number") {
        base = base.min(field.min, `Must be at least ${field.min}`);
      }
      if (typeof field.max === "number") {
        base = base.max(field.max, `Must be at most ${field.max}`);
      }
      return base;
    }
    case "bool":
      return z.boolean();
    case "json":
      return z.any();
    case "select": {
      // collection metadata validates `values` exists at save time; a missing
      // list here means corrupt metadata and yells loudly instead of
      // accepting any string
      if (!field.values || field.values.length === 0) {
        throw new Error(`Select field "${field.name}" has no values configured`);
      }
      return z.enum(field.values as [string, ...string[]]);
    }
    case "relation":
      return z
        .string()
        .min(1, "Must be a record id")
        .max(64, "Must be a record id");
    case "file":
      //WARN: we don't have file uploads yet, this is just a placeholder for now
      return z.string().min(1).max(1024);
  }
  // unreachable for known FIELD_TYPES; corrupt metadata must reject the
  // request rather than silently validating a strange type
  throw new Error(`Field "${field.name}" has unknown type "${field.type}"`);
}

function createSchemaShape(fields: Field[]): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields) {
    if (field.hidden) continue;

    const base = buildFieldZodType(field);
    if (field.required && field.default === undefined) {
      shape[field.name] = field.type === "json" ? base.refine((v) => v !== undefined, { error: REQUIRED_ERROR }) : base;
      continue;
    }
    shape[field.name] = base.optional();
  }
  return shape;
}

export function buildRecordCreateSchema(fields: Field[]) {
  return z.object(createSchemaShape(fields));
}

export function buildRecordUpdateSchema(fields: Field[]) {
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields) {
    if (field.hidden) continue;
    shape[field.name] = buildFieldZodType(field).optional();
  }
  return z
    .object(shape)
    .superRefine((val, ctx) => {
      if (Object.keys(val).length === 0) {
        ctx.addIssue({ code: "custom", message: "At least one field is required" });
      }
    });
}
