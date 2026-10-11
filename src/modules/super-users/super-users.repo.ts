import { hashString } from "../../utils/hash";
import * as superUsersSchema from "./super-users.schema"


export async function createSuperUser(db: D1Database, email: string, password: string): Promise<superUsersSchema.SuperUser> {
  const passwordHash = await hashString(password);
  const result = await db.prepare(
    `
      INSERT INTO _superusers (email, password) VALUES (?1, ?2)
      RETURNING id, email, createdAt, updatedAt
    `
  ).bind(email, passwordHash).first<superUsersSchema.SuperUser>();

  return result as superUsersSchema.SuperUser;
}




