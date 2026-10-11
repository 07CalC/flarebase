import { AppError, ErrorCode } from "../../error";
import { hashString } from "../../utils/hash";
import * as superUsersRepo from "./super-users.repo"
import * as superUsersSchema from "./super-users.schema"



export async function createSuperUser(db: D1Database, email: string, password: string): Promise<superUsersSchema.SuperUser> {
  const existing = await superUsersRepo.getSuperUserByEmail(db, email);
  if (existing) {
    throw new AppError(
      "A super user with this email already exists",
      409,
      ErrorCode.CONFLICT
    );
  }
  const passwordHash = await hashString(password);
  return await superUsersRepo.createSuperUser(db, email, passwordHash);
}
