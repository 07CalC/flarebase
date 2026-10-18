
export type Bindings = {

} & CloudflareBindings;

export type AuthUser = Record<string, any> & { id: string };

export type AuthContext = {
  id: string;
  isSuperUser: boolean;
  collectionId: string;
  collectionName: string;
  sessionId: string;
  user: AuthUser;
};

export type Variables = {
  auth: AuthContext | null;
}

export type HonoApp = {
  Bindings: Bindings;
  Variables: Variables;
}

