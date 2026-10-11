import { mapD1Error } from "../../utils/d1-error";
import * as superUsersSchema from "./super-users.schema"


export async function createSuperUser(db: D1Database, email: string, passwordHash: string): Promise<superUsersSchema.SuperUser> {
  try {
    const result = await db.prepare(
      `
      INSERT INTO _superusers (email, password) VALUES (?1, ?2)
      RETURNING id, email, createdAt, updatedAt
    `
    ).bind(email, passwordHash).first<superUsersSchema.SuperUser>();
    return result as superUsersSchema.SuperUser;
  } catch (error) {
    mapD1Error(error);
  }
}


export async function getSuperUserByEmail(db: D1Database, email: string): Promise<superUsersSchema.SuperUser | null> {
  try {
    const result = await db.prepare(
      `
      SELECT id, email, createdAt, updatedAt FROM _superusers WHERE email = ?1
    `
    ).bind(email).first<superUsersSchema.SuperUser>();
    return result || null;
  } catch (error) {
    mapD1Error(error);
  }
}




