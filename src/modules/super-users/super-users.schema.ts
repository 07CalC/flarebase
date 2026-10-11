import { z } from "zod";


export type SuperUser = {
  id: string;
  email: string;
  createdAt: Date;
  updatedAt: Date;
}


export const createSuperUserSchema = z.object({
  email: z.email(),
  password: z.string().min(8).max(32),
})


