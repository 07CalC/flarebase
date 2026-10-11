import { AppError, ResponseCode } from "../../utils/response";
import { hashString } from "../../utils/hash";
import * as authRepo from "./auth.repo"
import * as authSchema from "./auth.schema"



export async function createSuperUser(db: D1Database, email: string, password: string): Promise<authSchema.SuperUser> {
  const existing = await authRepo.getSuperUserByEmail(db, email);
  if (existing) {
    throw new AppError(
      "A super user with this email already exists",
      409,
      ResponseCode.CONFLICT
    );
  }
  const passwordHash = await hashString(password);
  return await authRepo.createSuperUser(db, email, passwordHash);
}


export async function doesSuperUserExist(db: D1Database): Promise<boolean> {
  return await authRepo.doesSuperUserExist(db);
}
