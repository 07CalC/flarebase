import { z } from "zod";
import { AUTH_REQUIRED_FIELDS } from "./auth";
import { isValidCollectionName, quoteIdent } from "./collection-name";

export const COLLECTION_TYPES = ["base", "auth"] as const;
export type CollectionType = (typeof COLLECTION_TYPES)[number];

export const FIELD_TYPES = [
  "text",
  "number",
  "bool",
  "email",
  "url",
  "date",
  "json",
  "file",
  "select",
  "relation",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

const nameSchema = z
  .string()
  .min(1, "Name is required")
  .max(64, "Name must be at most 64 characters")
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Invalid name");

export const collectionFieldSchema = z
  .object({
    name: nameSchema,
    type: z.enum(FIELD_TYPES),
    required: z.boolean().optional(),
    unique: z.boolean().optional(),
    hidden: z.boolean().optional(),
    default: z.unknown().optional(),
  })
  .catchall(z.unknown());

export type CollectionFieldInput = z.infer<typeof collectionFieldSchema>;

export const collectionIndexSchema = z.object({
  name: nameSchema,
  on: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  unique: z.boolean().optional(),
});

export type CollectionIndexInput = z.infer<typeof collectionIndexSchema>;

const ruleSchema = z.string().max(2048).nullable().optional();
const optionsSchema = z.record(z.string(), z.unknown()).optional();

function refineNoReservedPrefix(
  name: string,
  ctx: z.RefinementCtx,
  path: (string | number)[],
) {
  if (name.startsWith("_") || name.toLowerCase().startsWith("sqlite_")) {
    ctx.addIssue({
      code: "custom",
      message: `Name "${name}" is reserved`,
      path,
    });
  }
}

function refineUniqueFieldNames(
  fields: { name: string }[],
  ctx: z.RefinementCtx,
) {
  const seen = new Set<string>();
  for (const field of fields) {
    if (seen.has(field.name)) {
      ctx.addIssue({
        code: "custom",
        message: `Duplicate field name "${field.name}"`,
        path: ["fields"],
      });
      return;
    }
    seen.add(field.name);
  }
}

function refineAuthFields(
  type: string,
  fields: { name: string }[],
  ctx: z.RefinementCtx,
) {
  if (type !== "auth") return;
  const names = new Set(fields.map((f) => f.name));
  for (const required of AUTH_REQUIRED_FIELDS) {
    if (!names.has(required)) {
      ctx.addIssue({
        code: "custom",
        message: `Auth collections require a "${required}" field`,
        path: ["fields"],
      });
    }
  }
}

export const createCollectionSchema = z
  .object({
    name: nameSchema,
    type: z.enum(COLLECTION_TYPES).optional().default("base"),
    fields: z.array(collectionFieldSchema).min(1).max(100),
    indexes: z.array(collectionIndexSchema).max(50).optional().default([]),
    listRule: ruleSchema,
    viewRule: ruleSchema,
    createRule: ruleSchema,
    updateRule: ruleSchema,
    deleteRule: ruleSchema,
    options: optionsSchema,
  })
  .superRefine((val, ctx) => {
    refineNoReservedPrefix(val.name, ctx, ["name"]);
    refineUniqueFieldNames(val.fields, ctx);
    refineAuthFields(val.type, val.fields, ctx);
  });

export type CreateCollectionInput = z.infer<typeof createCollectionSchema>;

export const updateCollectionSchema = z
  .object({
    name: nameSchema.optional(),
    type: z.enum(COLLECTION_TYPES).optional(),
    fields: z.array(collectionFieldSchema).min(1).max(100).optional(),
    indexes: z.array(collectionIndexSchema).max(50).optional(),
    listRule: ruleSchema,
    viewRule: ruleSchema,
    createRule: ruleSchema,
    updateRule: ruleSchema,
    deleteRule: ruleSchema,
    options: optionsSchema,
  })
  .superRefine((val, ctx) => {
    if (val.name !== undefined) {
      refineNoReservedPrefix(val.name, ctx, ["name"]);
    }
    if (val.fields !== undefined) {
      refineUniqueFieldNames(val.fields, ctx);
    }
  });

export type UpdateCollectionInput = z.infer<typeof updateCollectionSchema>;

export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path =
        issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

const SQL_TYPE_MAP: Record<FieldType, "TEXT" | "REAL" | "INTEGER"> = {
  text: "TEXT",
  email: "TEXT",
  url: "TEXT",
  date: "TEXT",
  json: "TEXT",
  file: "TEXT",
  select: "TEXT",
  relation: "TEXT",
  number: "REAL",
  bool: "INTEGER",
};

function zeroDefaultForType(type: FieldType): string | number {
  switch (SQL_TYPE_MAP[type]) {
    case "REAL":
    case "INTEGER":
      return 0;
    default:
      return "";
  }
}

export function formatDefaultLiteral(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Non-finite number defaults are not supported");
    }
    return String(value);
  }
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "string") {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
}

export function buildColumnDef(
  field: CollectionFieldInput,
  forAlterTable: boolean,
): string {
  const sqlType = SQL_TYPE_MAP[field.type];
  const parts: string[] = [quoteIdent(field.name), sqlType];
  if (field.required) {
    parts.push("NOT NULL");
  }
  let defaultValue = field.default;
  if (
    forAlterTable &&
    field.required &&
    defaultValue === undefined
  ) {
    defaultValue = zeroDefaultForType(field.type);
  }
  if (defaultValue !== undefined) {
    parts.push(`DEFAULT ${formatDefaultLiteral(defaultValue)}`);
  }
  // SQLite forbids UNIQUE constraints in ADD COLUMN; those are created
  // as unique indexes by the service instead.
  if (!forAlterTable && field.unique) {
    parts.push("UNIQUE");
  }
  return parts.join(" ");
}

export function buildCreateIndexStatement(
  tableName: string,
  index: CollectionIndexInput,
): string {
  const columns = (Array.isArray(index.on) ? index.on : [index.on])
    .map((col) => quoteIdent(col))
    .join(", ");
  return `CREATE ${index.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${quoteIdent(index.name)} ON ${quoteIdent(tableName)} (${columns})`;
}

export function assertIndexColumnsExist(
  index: CollectionIndexInput,
  fieldNames: Set<string>,
): void {
  const columns = Array.isArray(index.on) ? index.on : [index.on];
  for (const column of columns) {
    if (!isValidCollectionName(column)) {
      throw new Error(`Index "${index.name}" has invalid column "${column}"`);
    }
    if (
      !fieldNames.has(column) &&
      column !== "id" &&
      column !== "createdAt" &&
      column !== "updatedAt"
    ) {
      throw new Error(
        `Index "${index.name}" references unknown field "${column}"`,
      );
    }
  }
}
