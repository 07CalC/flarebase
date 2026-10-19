import { Collection, CompiledCollection } from "./services/collection.service";

export type Bindings = {

} & CloudflareBindings;

export type AuthUser = Record<string, any> & { id: string };

export type AuthContext = {
  id: string;
  isSuperUser: boolean;
  collectionId: string;
  collectionName: string;
  sessionId: string;
  // this contains the sanitized user record, with hidden and sensitive fields removed
  // this also contains id, so we can directly do auth.user['key'] to get the value of a field in the user record
  user: AuthUser;
};

export type Variables = {
  auth: AuthContext | null;
  collectionContext: Collection | null;
  // records routes need the raw rule text plus the compiled artifacts, which
  // the public collection getters deliberately never select
  // (getCompiledCollectionByIdOrName); set by the records router middleware
  compiledCollectionContext: CompiledCollection | null;
}

export type HonoApp = {
  Bindings: Bindings;
  Variables: Variables;
}
