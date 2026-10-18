
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
}

export type HonoApp = {
  Bindings: Bindings;
  Variables: Variables;
}

