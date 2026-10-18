export interface SessionRow {
  id: string;
  collectionId: string;
  userId: string;
  jti: string;
  expiresAt: number;
  revoked: number;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

export async function createSession(
  db: D1Database,
  input: { collectionId: string; userId: string; jti: string; expiresAt: number; ip?: string | null; userAgent?: string | null },
): Promise<SessionRow> {
  const result = await db.prepare(
    `INSERT INTO _sessions (collectionId, userId, jti, expiresAt, ip, userAgent)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     RETURNING id, collectionId, userId, jti, expiresAt, revoked, ip, userAgent, createdAt`
  ).bind(
    input.collectionId,
    input.userId,
    input.jti,
    input.expiresAt,
    input.ip ?? null,
    input.userAgent ?? null,
  ).first<SessionRow>();
  if (!result) {
    throw new Error("Failed to create session");
  }
  return result;
}

export async function getSessionByJti(db: D1Database, jti: string): Promise<SessionRow | null> {
  const result = await db.prepare(
    `SELECT id, collectionId, userId, jti, expiresAt, revoked, ip, userAgent, createdAt
     FROM _sessions WHERE jti = ?1`
  ).bind(jti).first<SessionRow>();
  return result || null;
}

export async function revokeSession(db: D1Database, jti: string): Promise<void> {
  await db.prepare(`UPDATE _sessions SET revoked = 1 WHERE jti = ?1`).bind(jti).run();
}

export function isSessionActive(session: SessionRow, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  return session.revoked === 0 && session.expiresAt > nowSeconds;
}
