import { AppError, ResponseCode } from "./response";


const MAX_VIEW_QUERY_LENGTH = 8192;

const SELECT_START = /^(select|with)\b/i;

interface SqlScan {
  identifiers: string[];
  separators: number;
}

function scanSql(sql: string): SqlScan {
  const identifiers: string[] = [];
  let separators = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      // string literal; '' escapes a quote
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '"' || ch === "`") {
      let value = "";
      i += 1;
      while (i < sql.length) {
        if (sql[i] === ch) {
          if (sql[i + 1] === ch) {
            value += ch;
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        value += sql[i];
        i += 1;
      }
      identifiers.push(value);
      continue;
    }
    if (ch === "[") {
      let value = "";
      i += 1;
      while (i < sql.length && sql[i] !== "]") {
        value += sql[i];
        i += 1;
      }
      i += 1;
      identifiers.push(value);
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (ch === ";") {
      separators += 1;
      i += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let end = i + 1;
      while (end < sql.length && /[A-Za-z0-9_$]/.test(sql[end])) end += 1;
      identifiers.push(sql.slice(i, end));
      i = end;
      continue;
    }
    i += 1;
  }
  return { identifiers, separators };
}

function skipLeadingTrivia(sql: string): string {
  let i = 0;
  while (i < sql.length) {
    if (/\s/.test(sql[i])) {
      i += 1;
      continue;
    }
    if (sql[i] === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      continue;
    }
    if (sql[i] === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    break;
  }
  return sql.slice(i);
}

export function validateViewQuery(query: unknown): string {
  if (typeof query !== "string" || query.trim() === "") {
    throw new AppError(
      'View collections require a non-empty "options.query"',
      400,
      ResponseCode.VALIDATION_ERROR,
    );
  }
  if (query.length > MAX_VIEW_QUERY_LENGTH) {
    throw new AppError(
      `View query must be at most ${MAX_VIEW_QUERY_LENGTH} characters`,
      400,
      ResponseCode.VALIDATION_ERROR,
    );
  }
  if (!SELECT_START.test(skipLeadingTrivia(query))) {
    throw new AppError(
      "View query must be a single SELECT statement",
      400,
      ResponseCode.VALIDATION_ERROR,
    );
  }
  // clients usually paste queries with a trailing `;`; one is fine, a second
  // separator is not
  const body = query.replace(/;\s*$/, "");
  const { identifiers, separators } = scanSql(body);
  if (separators > 0) {
    throw new AppError(
      "View query must contain exactly one statement",
      400,
      ResponseCode.VALIDATION_ERROR,
    );
  }
  for (const identifier of identifiers) {
    const lower = identifier.toLowerCase();
    if (lower === "password") {
      throw new AppError(
        'View queries cannot reference "password" columns',
        400,
        ResponseCode.VALIDATION_ERROR,
      );
    }
    if (lower.startsWith("_") || lower.startsWith("sqlite_")) {
      throw new AppError(
        `View query cannot reference reserved identifier "${identifier}"`,
        400,
        ResponseCode.VALIDATION_ERROR,
      );
    }
  }
  return query;
}
