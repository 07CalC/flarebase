import { mapD1Error } from "../../utils/d1-error";
import * as authSchema from "./auth.schema"


export async function createSuperUser(db: D1Database, email: string, passwordHash: string): Promise<authSchema.SuperUser> {
  try {
    const result = await db.prepare(
      `
      INSERT INTO _superusers (email, password) VALUES (?1, ?2)
      RETURNING id, email, createdAt, updatedAt
    `
    ).bind(email, passwordHash).first<authSchema.SuperUser>();
    return result as authSchema.SuperUser;
  } catch (error) {
    mapD1Error(error);
  }
}


export async function getSuperUserByEmail(db: D1Database, email: string): Promise<authSchema.SuperUser | null> {
  try {
    const result = await db.prepare(
      `
      SELECT id, email, createdAt, updatedAt FROM _superusers WHERE email = ?1
    `
    ).bind(email).first<authSchema.SuperUser>();
    return result || null;
  } catch (error) {
    mapD1Error(error);
  }
}

export async function doesSuperUserExist(db: D1Database): Promise<boolean> {
  try {
    const result = await db.prepare(
      `
      SELECT COUNT(*) as count FROM _superusers
    `
    ).first<{ count: number }>();
    return (result?.count || 0) > 0;
  } catch (error) {
    mapD1Error(error);
  }
}




